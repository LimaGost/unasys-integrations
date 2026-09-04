import { timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler";
import { notificationService, smclickIntegrationService, ticketActionsService, ticketCreationHooks, ticketRepository } from "../container";
import { getConfig } from "../services/configStore";
import type { NotificationType } from "../types/entities";

/**
 * Chamado DIRETO do navegador pelas telas de Ticket/Kanban do Base44 - mesmo
 * motivo das outras rotas /public/*: evitar credito de integracao no Base44 a
 * cada movimentacao de card, a acao mais frequente do sistema. Funcoes
 * migradas ate agora: updateTicketStatus, createNotification,
 * recomputeTicketHours, on-ticket-created (onTicketCreated +
 * criarClienteAoNovoTicket - ver TicketCreationHooks.ts), e
 * smclick-sync-transcript (botao "Buscar conversa do WhatsApp" - ver
 * SmclickIntegrationService.syncTranscriptOnDemand). Ainda falta
 * executeAutomationRules isolado.
 */
const NOTIFICATION_TYPES: readonly NotificationType[] = [
  "ticket_assigned",
  "status_changed",
  "new_comment",
  "new_time_entry",
  "mentioned",
  "sla_warning",
  "ticket_created",
];

function isNotificationType(value: unknown): value is NotificationType {
  return typeof value === "string" && (NOTIFICATION_TYPES as readonly string[]).includes(value);
}
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

function tokensMatch(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 60;
const recentRequests = new Map<string, number[]>();

/** Mais generoso que os outros /public/*: isso dispara a cada card arrastado no Kanban, uso normal pode ser frequente. */
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

  const expectedToken = getConfig().webhookTokens.ticketActions.token;
  if (!expectedToken) {
    res.status(503).json({
      error: "ServiceUnavailable",
      message: "Token de acoes de ticket ainda nao foi gerado (ver painel /dashboard).",
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

router.post(
  "/update-status",
  asyncHandler(async (req: Request, res: Response) => {
    if (!requireToken(req, res)) return;

    const body = req.body ?? {};
    const ticketId = typeof body.ticket_id === "string" ? body.ticket_id : "";
    const newStatus = typeof body.new_status === "string" ? body.new_status : "";
    const actorEmail = typeof body.actor_email === "string" ? body.actor_email : "";
    const actorName = typeof body.actor_name === "string" && body.actor_name ? body.actor_name : actorEmail;

    if (!ticketId || !newStatus || !actorEmail) {
      res.status(400).json({ error: "BadRequest", message: "Campos obrigatorios: ticket_id, new_status, actor_email." });
      return;
    }

    try {
      const result = await ticketActionsService.updateStatus(
        {
          ticketId,
          newStatus,
          subStatus: typeof body.sub_status === "string" ? body.sub_status : null,
          columnData: body.column_data
            ? {
                id: typeof body.column_data.id === "string" ? body.column_data.id : undefined,
                is_final: !!body.column_data.is_final,
                pauses_sla: !!body.column_data.pauses_sla,
                sla_hours: typeof body.column_data.sla_hours === "number" ? body.column_data.sla_hours : undefined,
              }
            : undefined,
        },
        { email: actorEmail, name: actorName }
      );

      res.status(200).json(result);
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status) {
        res.status(status).json({ error: "BadRequest", message: (error as Error).message });
        return;
      }
      throw error;
    }
  })
);

router.post(
  "/create-notification",
  asyncHandler(async (req: Request, res: Response) => {
    if (!requireToken(req, res)) return;

    const body = req.body ?? {};
    const userEmail = typeof body.user_email === "string" ? body.user_email : "";
    const title = typeof body.title === "string" ? body.title : "";
    const message = typeof body.message === "string" ? body.message : "";

    if (!userEmail || !title || !message || !isNotificationType(body.type)) {
      res.status(400).json({
        error: "BadRequest",
        message: `Campos obrigatorios: user_email, title, message, type (um de: ${NOTIFICATION_TYPES.join(", ")}).`,
      });
      return;
    }

    const result = await notificationService.create({
      userEmail,
      type: body.type,
      title,
      message,
      ticketId: typeof body.ticket_id === "string" ? body.ticket_id : null,
      ticketTitle: typeof body.ticket_title === "string" ? body.ticket_title : null,
      actorName: typeof body.actor_name === "string" ? body.actor_name : null,
      actorEmail: typeof body.actor_email === "string" ? body.actor_email : null,
      priority: body.priority === "low" || body.priority === "high" ? body.priority : "normal",
    });

    res.status(200).json(result);
  })
);

router.post(
  "/recompute-hours",
  asyncHandler(async (req: Request, res: Response) => {
    if (!requireToken(req, res)) return;

    const ticketId = typeof req.body?.ticket_id === "string" ? req.body.ticket_id : "";
    if (!ticketId) {
      res.status(400).json({ error: "BadRequest", message: "Campo obrigatorio: ticket_id." });
      return;
    }

    const result = await ticketActionsService.recomputeHours(ticketId);
    res.status(200).json({
      ticket_id: result.ticketId,
      total_normal_hours: result.totalNormalHours,
      total_extra_hours: result.totalExtraHours,
    });
  })
);

router.post(
  "/on-ticket-created",
  asyncHandler(async (req: Request, res: Response) => {
    if (!requireToken(req, res)) return;

    const ticketId = typeof req.body?.ticket_id === "string" ? req.body.ticket_id : "";
    if (!ticketId) {
      res.status(400).json({ error: "BadRequest", message: "Campo obrigatorio: ticket_id." });
      return;
    }

    const ticket = await ticketRepository.findById(ticketId);
    if (!ticket) {
      res.status(404).json({ error: "NotFound", message: "Ticket nao encontrado." });
      return;
    }

    await ticketCreationHooks.afterTicketCreated(ticket);
    res.status(200).json({ status: "success" });
  })
);

/**
 * Botao "Buscar conversa do WhatsApp" na tela do Ticket (so aparece quando
 * external_system === "smclick") - pedido do usuario em 2026-09-04, pra
 * puxar o historico sob demanda em vez de so esperar a sincronizacao
 * automatica (webhook new-chat-message, a cada 45s) ou o fechamento do
 * atendimento. Ver SmclickIntegrationService.syncTranscriptOnDemand.
 */
router.post(
  "/smclick-sync-transcript",
  asyncHandler(async (req: Request, res: Response) => {
    if (!requireToken(req, res)) return;

    const ticketId = typeof req.body?.ticket_id === "string" ? req.body.ticket_id : "";
    if (!ticketId) {
      res.status(400).json({ error: "BadRequest", message: "Campo obrigatorio: ticket_id." });
      return;
    }

    const result = await smclickIntegrationService.syncTranscriptOnDemand(ticketId);
    res.status(200).json(result);
  })
);

export default router;
