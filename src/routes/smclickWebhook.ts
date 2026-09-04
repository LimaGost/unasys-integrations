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
 * em Webhooks, para os eventos `chat-started`, `chat-finished` e
 * `new-chat-message` (esse ultimo sincroniza o transcript ao vivo, ANTES do
 * atendimento finalizar - ver SmclickIntegrationService.handleNewChatMessage).
 * O gatilho de criacao do Ticket e `chat-started` (nao `new-chat`) de
 * proposito - ver o comentario no topo de application/SmclickIntegrationService.ts.
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

/** Mascara o telefone nos logs (so os ultimos 4 digitos) - o resto do payload de log nao tem PII. */
function maskPhone(phone: string | undefined): string {
  if (!phone) return "?";
  return phone.length > 4 ? `***${phone.slice(-4)}` : phone;
}

/**
 * Log de cada evento recebido - essencial pra depurar esta integracao nova
 * (o log padrao de acesso so grava tamanho da resposta, nao da pra saber
 * pelo painel/log comum se um chat-started foi ignorado e por que).
 */
function logEvent(body: { event?: string; infos?: { chat?: SmclickChat } }, result: unknown): void {
  const chat = body.infos?.chat;
  const attendant = chat?.attendant?.map((a) => `${a.name ?? "?"}<${a.email ?? "?"}>${a.principal ? "*" : ""}`).join(",") ?? "?";
  console.log(
    `[smclick] evento=${body.event ?? "?"} chat_id=${chat?.id ?? "?"} protocolo=${chat?.protocol ?? "?"} ` +
      `departamento=${chat?.department?.id ?? "?"}(${chat?.department?.name ?? "?"}) telefone=${maskPhone(chat?.contact?.telephone)} ` +
      `atendente=[${attendant}] attending_time=${chat?.attending_time ?? "?"} ` +
      `resultado=${JSON.stringify(result)}`
  );
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
      const result = { status: "ignored", reason: "sem_chat_no_payload", event: body.event };
      logEvent(body, result);
      res.status(200).json(result);
      return;
    }

    if (body.event === "chat-started") {
      const result = await smclickIntegrationService.handleChatStarted(chat);
      logEvent(body, result);
      res.status(200).json(result);
      return;
    }

    if (body.event === "chat-finished") {
      const result = await smclickIntegrationService.handleChatFinished(chat);
      logEvent(body, result);
      res.status(200).json(result);
      return;
    }

    if (body.event === "new-chat-message") {
      const result = await smclickIntegrationService.handleNewChatMessage(chat);
      // Esse evento dispara a CADA mensagem - logar toda vez (mesmo os
      // "sincronizado_recentemente" do debounce) inundaria o log. So loga
      // quando de fato sincronizou ou algo deu errado.
      if (result.status !== "skipped" || result.reason !== "sincronizado_recentemente") {
        logEvent(body, result);
      }
      res.status(200).json(result);
      return;
    }

    const result = { status: "ignored", event: body.event };
    logEvent(body, result);
    res.status(200).json(result);
  })
);

export default router;
