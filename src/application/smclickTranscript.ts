import type { SmclickMessage } from "../infrastructure/smclick/SmclickApiClient";

export interface TranscriptResult {
  html: string;
  /** null se nao houver nenhuma mensagem com sent_at valido (nao da pra montar um Registro sem hora de inicio/fim). */
  firstMessageAt: Date | null;
  lastMessageAt: Date | null;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\n/g, "<br>");
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
}

/** Data (YYYY-MM-DD) no fuso de Sao Paulo - usado pro campo `date` do TimeEntry. */
export function formatDateSaoPaulo(date: Date): string {
  return date.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

export function formatTimeSaoPaulo(date: Date): string {
  return formatTime(date);
}

/**
 * Uma linha por mensagem, no formato "[HH:mm] Quem: texto". So mapeia os
 * tipos ja confirmados numa conversa real (texto e menu de lista do bot -
 * ver SmclickIntegrationService); tipos de midia (imagem/audio/arquivo/
 * template) ainda nao foram confirmados na API real, entao NAO inventa o
 * nome do campo de conteudo deles - so marca que uma mensagem daquele tipo
 * existiu, pra nao quebrar nem mostrar informacao errada.
 */
function messageLine(msg: SmclickMessage, contactName: string, time: string): string | null {
  // Eventos internos (chat-started, chat-waiting, etc) - nao e conversa "falada".
  if (msg.type === "system") return null;

  const who = msg.from_me ? msg.sent_by?.name || "Bot/Automação" : contactName;

  if (msg.type === "text") {
    const text = typeof msg.content?.text === "string" ? msg.content.text.trim() : "";
    if (!text) return null;
    return `<p><strong>${escapeHtml(who)}</strong> <span style="color:#888888">[${time}]</span>: ${escapeHtml(text)}</p>`;
  }

  if (msg.type === "list") {
    const description = typeof msg.content?.description === "string" ? msg.content.description.trim() : "";
    return `<p><em>${escapeHtml(who)}</em> <span style="color:#888888">[${time}]</span>: ${
      description ? escapeHtml(description) : "[menu de opções]"
    }</p>`;
  }

  return `<p><strong>${escapeHtml(who)}</strong> <span style="color:#888888">[${time}]</span>: [mensagem tipo "${escapeHtml(msg.type)}"]</p>`;
}

/**
 * Prefixo fixo do HTML gerado aqui (nao muda entre a versao "em andamento" e
 * a versao final) - usado por SmclickIntegrationService pra reconhecer, entre
 * os Registros de um Ticket, qual e o Registro automatico do transcript
 * (pra atualizar em vez de duplicar a cada sincronizacao).
 */
export const TRANSCRIPT_HEADER_PREFIX = "<p><strong>Histórico da conversa (WhatsApp via SM Click)";

/**
 * Monta o HTML do campo "Relato da Atividade" (TimeEntry.description) a
 * partir das mensagens de um atendimento SM Click - ver
 * SmclickIntegrationService.handleChatFinished e .handleNewChatMessage (essa
 * ultima sincroniza em tempo real, ANTES do atendimento finalizar - por isso
 * o parametro `finished` deixa claro no proprio texto se e um retrato ao
 * vivo ou a versao definitiva).
 */
export function buildTranscript(messages: SmclickMessage[], contactName: string, finished: boolean): TranscriptResult {
  const withDates = messages
    .map((msg) => ({ msg, date: new Date(msg.sent_at) }))
    .filter(({ date }) => !Number.isNaN(date.getTime()))
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  if (withDates.length === 0) {
    return {
      html: "<p><em>Nenhuma mensagem encontrada neste atendimento.</em></p>",
      firstMessageAt: null,
      lastMessageAt: null,
    };
  }

  const lines = withDates
    .map(({ msg, date }) => messageLine(msg, contactName, formatTime(date)))
    .filter((line): line is string => line !== null);

  const suffix = finished ? "" : " — atualizado automaticamente, atendimento ainda em andamento";
  const html =
    `${TRANSCRIPT_HEADER_PREFIX}${suffix}:</strong></p>` +
    (lines.length > 0 ? lines.join("") : "<p><em>Atendimento sem mensagens de texto (so eventos internos).</em></p>");

  return {
    html,
    firstMessageAt: withDates[0]!.date,
    lastMessageAt: withDates[withDates.length - 1]!.date,
  };
}
