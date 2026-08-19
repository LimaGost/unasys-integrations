import { timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler";
import { emailService } from "../container";
import { TicketNotFoundError, type TicketEmailAttachmentInput } from "../application/EmailService";
import { getConfig } from "../services/configStore";

const router = Router();

/**
 * Chamada DIRETO do navegador pelo frontend do Ticket (Base44) - sem passar
 * por nenhuma function do Base44 - para nao gerar "credito de integracao" la
 * a cada envio de email (confirmado com o usuario em 2026-08-17: o Base44
 * cobra 1 credito por invocacao de function que dispare uma acao "ao vivo",
 * mesmo que a function so sirva de intermediaria).
 *
 * Como isso expoe um token no codigo-fonte do frontend (visivel a qualquer
 * usuario logado no Base44 via DevTools), as defesas aqui sao em camadas:
 * token exclusivo (nao reaproveita webhookTokens.gmail), restricao de
 * origem (CORS), limite de taxa, e verificacao de que o ticket_id informado
 * existe de fato no Base44 antes de enviar.
 */
/**
 * Dominio real de uso diario confirmado em 2026-08-17 (capturado direto da
 * barra de enderecos durante um teste real): https://unasystickets.base44.app
 * (sem o prefixo "preview--"). Mantemos tambem o dominio de preview do editor
 * do Base44 na lista, caso seja usado para testes.
 */
const ALLOWED_ORIGINS = ["https://unasystickets.base44.app", "https://preview--unasystickets.base44.app"];
const TOKEN_HEADER = "x-app-token";

function applyCors(req: Request, res: Response): boolean {
  const origin = req.header("origin");
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
    return false;
  }
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", `Content-Type, ${TOKEN_HEADER}`);
  return true;
}

router.options("/send", (req: Request, res: Response) => {
  if (!applyCors(req, res)) {
    res.status(403).end();
    return;
  }
  res.status(204).end();
});

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 20;
const recentRequests = new Map<string, number[]>();

/** Limitador de taxa simples em memoria (1 processo/PM2, sem cluster) - reduz o dano de um token vazado sem depender de infra extra. */
function isRateLimited(key: string): boolean {
  const now = Date.now();
  const timestamps = (recentRequests.get(key) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  timestamps.push(now);
  recentRequests.set(key, timestamps);
  return timestamps.length > RATE_LIMIT_MAX;
}

function tokensMatch(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string" && value.trim()) {
    return value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return [];
}

interface RawAttachment {
  url?: unknown;
  name?: unknown;
}

function toAttachments(value: unknown): TicketEmailAttachmentInput[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): TicketEmailAttachmentInput | null => {
      if (typeof item === "string") {
        return { url: item, name: item.split("/").pop() || "anexo" };
      }
      const raw = item as RawAttachment;
      if (raw && typeof raw.url === "string") {
        return { url: raw.url, name: typeof raw.name === "string" && raw.name ? raw.name : "anexo" };
      }
      return null;
    })
    .filter((a): a is TicketEmailAttachmentInput => a !== null);
}

router.post(
  "/send",
  asyncHandler(async (req: Request, res: Response) => {
    if (!applyCors(req, res)) {
      res.status(403).json({ error: "Forbidden", message: "Origem nao autorizada." });
      return;
    }

    if (!emailService.isConfigured()) {
      res.status(503).json({
        error: "ServiceUnavailable",
        message: "Integracao de email ainda nao configurada (ver painel /dashboard).",
      });
      return;
    }

    const expectedToken = getConfig().webhookTokens.emailButton.token;
    if (!expectedToken) {
      res.status(503).json({
        error: "ServiceUnavailable",
        message: "Token do botao de email ainda nao foi gerado (ver painel /dashboard).",
      });
      return;
    }

    const provided = req.header(TOKEN_HEADER);
    if (!provided || !tokensMatch(provided, expectedToken)) {
      res.status(401).json({ error: "Unauthorized", message: "Token invalido." });
      return;
    }

    if (isRateLimited(expectedToken)) {
      res.status(429).json({ error: "TooManyRequests", message: "Muitos envios em pouco tempo. Aguarde um instante." });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const ticketId = typeof body.ticket_id === "string" ? body.ticket_id : "";
    const to = toStringArray(body.to);
    const cc = toStringArray(body.cc);
    const bcc = toStringArray(body.bcc);
    const subject = typeof body.subject === "string" ? body.subject : "";
    const html = typeof body.body === "string" ? body.body : "";
    const emailRecordId = typeof body.email_record_id === "string" ? body.email_record_id : null;
    const saveRecord =
      body.save_record && typeof body.save_record === "object"
        ? (body.save_record as { from_email?: string; from_name?: string })
        : null;
    const attachments = toAttachments(body.attachments);

    if (!ticketId || to.length === 0 || !subject || !html) {
      res.status(400).json({
        error: "BadRequest",
        message: "Campos obrigatorios ausentes ou invalidos: ticket_id, to, subject, body.",
      });
      return;
    }

    try {
      const result = await emailService.sendTicketEmail({
        ticketId,
        to,
        cc,
        bcc,
        subject,
        html,
        attachments,
        existingEmailId: emailRecordId,
        fallbackSender: saveRecord?.from_email ? { fromEmail: saveRecord.from_email, fromName: saveRecord.from_name } : null,
      });
      res.status(200).json({ success: true, messageId: result.messageId, threadId: null });
    } catch (error) {
      if (error instanceof TicketNotFoundError) {
        res.status(404).json({ error: "NotFound", message: "Ticket nao encontrado." });
        return;
      }
      throw error;
    }
  })
);

export default router;
