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

/** Cores no estilo WhatsApp: recebida (cliente) = cinza claro, enviada (atendente/bot) = verde claro. */
const BUBBLE_BG_RECEIVED = "#f0f0f0";
const BUBBLE_BG_SENT = "#d9fdd3";

/**
 * Uma "bolha" por mensagem - alinhada a esquerda (cliente, cinza) ou a
 * direita (atendente/bot, verde), pra parecer o mais possivel com um print
 * do WhatsApp. So mapeia os tipos ja confirmados numa conversa real (texto e
 * menu de lista do bot - ver SmclickIntegrationService); tipos de midia
 * (imagem/audio/arquivo/template) ainda nao foram confirmados na API real,
 * entao NAO inventa o nome do campo de conteudo deles - so marca que uma
 * mensagem daquele tipo existiu, pra nao quebrar nem mostrar informacao
 * errada.
 *
 * IMPORTANTE: este HTML e colado no editor de texto rico (Quill) da tela do
 * Ticket, que SO entende um conjunto limitado de formatacao (paragrafo,
 * negrito/italico, alinhamento, cor de fundo do texto) - qualquer coisa fora
 * disso (div, flexbox, padding, border-radius, cantos arredondados) e
 * descartada quando o Quill reprocessa o HTML. Por isso a "bolha" aqui e
 * simulada com <p align> + <span style="background-color">, os unicos dois
 * recursos que sobrevivem ao editor - nao da pra ter bolha com canto
 * arredondado/avatar de verdade dentro dele.
 */
function messageLine(msg: SmclickMessage, contactName: string, time: string): string | null {
  // Eventos internos (chat-started, chat-waiting, etc) - nao e conversa "falada".
  if (msg.type === "system") return null;

  const sentByMe = msg.from_me;
  const who = sentByMe ? msg.sent_by?.name || "Bot/Automação" : contactName;
  const align = sentByMe ? "right" : "left";
  const bg = sentByMe ? BUBBLE_BG_SENT : BUBBLE_BG_RECEIVED;

  let body: string | null = null;
  if (msg.type === "text") {
    const text = typeof msg.content?.text === "string" ? msg.content.text.trim() : "";
    if (!text) return null;
    body = escapeHtml(text);
  } else if (msg.type === "list") {
    const description = typeof msg.content?.description === "string" ? msg.content.description.trim() : "";
    body = description ? escapeHtml(description) : "[menu de opções]";
  } else {
    body = `[mensagem tipo "${escapeHtml(msg.type)}"]`;
  }

  return (
    `<p align="${align}" style="margin:6px 0;">` +
    `<span style="background-color:${bg};">` +
    `<strong>${escapeHtml(who)}</strong> <span style="color:#667781;">[${time}]</span><br>${body}` +
    `</span></p>`
  );
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
