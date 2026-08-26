import { timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler";
import { emailService } from "../container";
import { currentEmailUser } from "../infrastructure/email/EmailAccount";
import { getConfig } from "../services/configStore";

/**
 * Chamado DIRETO do navegador pelas telas de status de email do Base44
 * (EmailConfigStatus.jsx / EmailAutomationConfig.jsx) - mesmo motivo das
 * outras rotas /public/*: evitar credito de integracao no Base44 a cada
 * clique. Essas telas so leem status e disparam acoes ja existentes no
 * painel /dashboard (verificar agora, enviar teste) - configurar Gmail
 * (OAuth, credenciais, frequencia) nao existe mais aqui: isso e feito uma
 * vez no painel /dashboard (secao Configuracoes) ou no .env.
 */
const ALLOWED_ORIGINS = ["https://unasystickets.base44.app", "https://preview--unasystickets.base44.app"];
const TOKEN_HEADER = "x-app-token";

function applyCors(req: Request, res: Response): boolean {
  const origin = req.header("origin");
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
    return false;
  }
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", `Content-Type, ${TOKEN_HEADER}`);
  return true;
}

function tokensMatch(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;
const recentRequests = new Map<string, number[]>();

/** Mais restrito que o botao de email (10/min): estas acoes disparam uma varredura completa da caixa de entrada, nao um envio unico. */
function isRateLimited(key: string): boolean {
  const now = Date.now();
  const timestamps = (recentRequests.get(key) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  timestamps.push(now);
  recentRequests.set(key, timestamps);
  return timestamps.length > RATE_LIMIT_MAX;
}

const router = Router();

router.options(/.*/, (req: Request, res: Response) => {
  if (!applyCors(req, res)) {
    res.status(403).end();
    return;
  }
  res.status(204).end();
});

function requireToken(req: Request, res: Response): boolean {
  if (!applyCors(req, res)) {
    res.status(403).json({ error: "Forbidden", message: "Origem nao autorizada." });
    return false;
  }

  const expectedToken = getConfig().webhookTokens.emailAdmin.token;
  if (!expectedToken) {
    res.status(503).json({
      error: "ServiceUnavailable",
      message: "Token de administracao de email ainda nao foi gerado (ver painel /dashboard).",
    });
    return false;
  }

  const provided = req.header(TOKEN_HEADER);
  if (!provided || !tokensMatch(provided, expectedToken)) {
    res.status(401).json({ error: "Unauthorized", message: "Token invalido." });
    return false;
  }

  if (isRateLimited(expectedToken)) {
    res.status(429).json({ error: "TooManyRequests", message: "Muitas acoes em pouco tempo. Aguarde um instante." });
    return false;
  }

  return true;
}

router.get(
  "/status",
  asyncHandler(async (req: Request, res: Response) => {
    if (!requireToken(req, res)) return;
    res.status(200).json({ configured: emailService.isConfigured() });
  })
);

router.post(
  "/check-now",
  asyncHandler(async (req: Request, res: Response) => {
    if (!requireToken(req, res)) return;
    if (!emailService.isConfigured()) {
      res.status(503).json({ error: "ServiceUnavailable", message: "Email ainda nao configurado (ver painel /dashboard)." });
      return;
    }
    const summary = await emailService.pollInbox();
    res.status(200).json({ processed: summary.processed });
  })
);

router.post(
  "/check-ticket",
  asyncHandler(async (req: Request, res: Response) => {
    if (!requireToken(req, res)) return;
    if (!emailService.isConfigured()) {
      res.status(503).json({ error: "ServiceUnavailable", message: "Email ainda nao configurado (ver painel /dashboard)." });
      return;
    }

    const ticketId = typeof req.body?.ticket_id === "string" ? req.body.ticket_id : "";
    if (!ticketId) {
      res.status(400).json({ error: "BadRequest", message: "Campo obrigatorio: ticket_id." });
      return;
    }

    const summary = await emailService.pollInbox();
    const forThisTicket = summary.results.filter((r) => r.ticketId === ticketId).length;
    res.status(200).json({ processed: summary.processed, new_for_ticket: forThisTicket });
  })
);

router.post(
  "/test-send",
  asyncHandler(async (req: Request, res: Response) => {
    if (!requireToken(req, res)) return;
    if (!emailService.isConfigured()) {
      res.status(503).json({ error: "ServiceUnavailable", message: "Email ainda nao configurado (ver painel /dashboard)." });
      return;
    }

    const selfEmail = currentEmailUser() as string;
    await emailService.sendPlain({
      to: [selfEmail],
      subject: "Teste unasys-integrations",
      body: `Email de teste disparado pela tela de status do Base44 em ${new Date().toLocaleString("pt-BR")}.`,
    });
    res.status(200).json({ message: `Email de teste enviado para ${selfEmail}.`, sent_to: selfEmail });
  })
);

export default router;
