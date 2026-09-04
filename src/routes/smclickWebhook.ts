import { timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler";
import { smclickIntegrationService } from "../container";
import { getConfig } from "../services/configStore";
import type { SmclickChat } from "../application/SmclickIntegrationService";

/**
 * Recebe eventos de webhook da SM Click (atendimento via WhatsApp - ver
 * https://documenter.getpostman.com/view/27810792/2sAYBYgqT9). A doc nao
 * menciona suporte a header customizado no cadastro do webhook (diferente
 * das outras integracoes deste servico, que usam o header x-webhook-token -
 * ver middleware/auth.ts), entao o token vai na propria URL: cadastre a URL
 * completa (com o token, gerada no painel /dashboard) no painel da SM Click,
 * em Webhooks, para os eventos `chat-started` e `chat-finished`. O gatilho de
 * criacao e `chat-started` (nao `new-chat`) de proposito - ver o comentario
 * no topo de application/SmclickIntegrationService.ts.
 *
 * Qualquer outro evento cadastrado nessa mesma URL e apenas ignorado (200),
 * para nao gerar "erro" no painel da SM Click - a logica de negocio fica em
 * application/SmclickIntegrationService.ts.
 */
const router = Router();

function tokenMatches(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

router.post(
  "/:token",
  asyncHandler(async (req: Request, res: Response) => {
    const expectedToken = getConfig().webhookTokens.smclick.token;
    if (!expectedToken) {
      res.status(503).json({
        error: "ServiceUnavailable",
        message: "Token da integracao SM Click ainda nao foi gerado (ver painel /dashboard).",
      });
      return;
    }

    if (!tokenMatches(req.params.token ?? "", expectedToken)) {
      res.status(401).json({ error: "Unauthorized", message: "Token invalido." });
      return;
    }

    const body = (req.body ?? {}) as { event?: string; infos?: { chat?: SmclickChat } };
    const chat = body.infos?.chat;

    if (!chat) {
      res.status(200).json({ status: "ignored", reason: "sem_chat_no_payload", event: body.event });
      return;
    }

    if (body.event === "chat-started") {
      const result = await smclickIntegrationService.handleChatStarted(chat);
      res.status(200).json(result);
      return;
    }

    if (body.event === "chat-finished") {
      const result = await smclickIntegrationService.handleChatFinished(chat);
      res.status(200).json(result);
      return;
    }

    res.status(200).json({ status: "ignored", event: body.event });
  })
);

export default router;
