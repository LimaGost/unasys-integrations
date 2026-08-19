import { Router, type Request, type Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler";
import { requireWebhookToken } from "../middleware/auth";
import { emailService } from "../container";
import { getConfig } from "../services/configStore";
import type { SendGmailRequestBody } from "../types/gmail";

const router = Router();

router.use(requireWebhookToken(() => getConfig().webhookTokens.gmail.token));

function gmailNotConfiguredResponse(res: Response): void {
  res.status(503).json({
    error: "ServiceUnavailable",
    message: "Integracao com Gmail ainda nao configurada. Preencha usuario e senha de app no painel (secao Configuracoes em /dashboard).",
  });
}

function isValidSendPayload(body: unknown): body is SendGmailRequestBody {
  const payload = body as Partial<SendGmailRequestBody> | null;
  return Boolean(
    payload &&
      typeof payload.ticket_id === "string" &&
      payload.ticket_id.length > 0 &&
      Array.isArray(payload.to) &&
      payload.to.length > 0 &&
      typeof payload.subject === "string" &&
      payload.subject.length > 0 &&
      typeof payload.body === "string" &&
      payload.body.length > 0
  );
}

router.post(
  "/send",
  asyncHandler(async (req: Request, res: Response) => {
    if (!emailService.isConfigured()) {
      gmailNotConfiguredResponse(res);
      return;
    }

    if (!isValidSendPayload(req.body)) {
      res.status(400).json({
        error: "BadRequest",
        message: "Campos obrigatorios ausentes ou invalidos: ticket_id, to (array), subject, body.",
      });
      return;
    }

    const payload = req.body as SendGmailRequestBody;
    const result = await emailService.sendAndLog({
      ticketId: payload.ticket_id,
      to: payload.to,
      subject: payload.subject,
      body: payload.body,
      cc: payload.cc,
      bcc: payload.bcc,
    });

    res.status(201).json({
      ticket_email_id: result.ticketEmailId,
      rfc_message_id: result.rfcMessageId,
    });
  })
);

/**
 * Envia uma mensagem MIME ja pronta (mesmo formato "raw" da Gmail API:
 * texto RFC822 completo em base64url), sem criar nenhum registro no Base44.
 * Mantida por compatibilidade com a function `sendEmailGmail` do Base44 -
 * hoje sem uso, ja que o botao "Enviar E-mail" do Ticket chama o servidor
 * direto do navegador (ver routes/publicEmailSend.ts).
 */
router.post(
  "/send-raw",
  asyncHandler(async (req: Request, res: Response) => {
    if (!emailService.isConfigured()) {
      gmailNotConfiguredResponse(res);
      return;
    }

    const raw = typeof req.body?.raw === "string" ? req.body.raw : "";
    const to = Array.isArray(req.body?.to) ? req.body.to : [];
    if (!raw || to.length === 0) {
      res.status(400).json({ error: "BadRequest", message: "Campos obrigatorios ausentes: raw, to (array)." });
      return;
    }
    const cc = Array.isArray(req.body?.cc) ? req.body.cc : undefined;
    const bcc = Array.isArray(req.body?.bcc) ? req.body.bcc : undefined;

    const result = await emailService.relayRaw(raw, to, cc, bcc);
    res.status(200).json({ id: result.messageId, threadId: null });
  })
);

/**
 * Verifica a caixa de entrada por mensagens novas e cria Ticket + TicketEmail
 * para cada uma. Usada tanto pelo poller interno (ver src/index.ts) quanto
 * pela rota manual POST /webhooks/gmail/poll.
 */
export async function runGmailPoll() {
  return emailService.pollInbox();
}

router.post(
  "/poll",
  asyncHandler(async (_req: Request, res: Response) => {
    if (!emailService.isConfigured()) {
      gmailNotConfiguredResponse(res);
      return;
    }

    const summary = await runGmailPoll();
    res.status(200).json(summary);
  })
);

export default router;
