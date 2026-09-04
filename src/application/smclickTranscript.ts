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
 * Cores no estilo WhatsApp modo escuro (o editor do ticket usa tema escuro -
 * fundo claro com texto escuro herdado ficava ilegivel, reportado pelo
 * usuario em 2026-09-04): recebida (cliente) = cinza escuro, enviada
 * (atendente/bot) = verde escuro, texto claro nos dois - a cor do texto e
 * setada explicitamente (nao herda do editor), senao fica ilegivel de novo
 * se algum dia o tema mudar.
 */
const BUBBLE_BG_RECEIVED = "#1f2c34";
const BUBBLE_BG_SENT = "#025c4b";
const BUBBLE_TEXT_COLOR = "#e9edef";
const BUBBLE_META_COLOR = "#a3adb3";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A SM Click as vezes embute "*Nome*:" no INICIO do texto de mensagens
 * enviadas por um atendente (confirmado em dados reais, ex: "*IURY LIMA*:\n\nola")
 * - como o nome ja aparece no cabecalho da bolha (`who`), remove esse
 * prefixo repetido do corpo da mensagem pra nao duplicar (reportado pelo
 * usuario em 2026-09-04: "ficou muito ruim" com o nome duas vezes).
 */
function stripSelfNamePrefix(text: string, who: string): string {
  const pattern = new RegExp(`^\\*${escapeRegExp(who)}\\*:\\s*`, "i");
  return text.replace(pattern, "").trim();
}

/**
 * Uma "bolha" por mensagem - alinhada a esquerda (cliente, cinza escuro) ou
 * a direita (atendente/bot, verde escuro), pra parecer o mais possivel com
 * um print do WhatsApp (modo escuro, pra combinar com o tema do editor). So
 * mapeia os tipos ja confirmados numa conversa real (texto e menu de lista
 * do bot - ver SmclickIntegrationService); tipos de midia (imagem/audio/
 * arquivo/template) ainda nao foram confirmados na API real, entao NAO
 * inventa o nome do campo de conteudo deles - so marca que uma mensagem
 * daquele tipo existiu, pra nao quebrar nem mostrar informacao errada.
 *
 * IMPORTANTE: este HTML e colado no editor de texto rico (Quill) da tela do
 * Ticket, que SO entende um conjunto limitado de formatacao (paragrafo,
 * negrito/italico, alinhamento via `text-align`, cor/cor de fundo do texto
 * via <span style>) - qualquer coisa fora disso (div, flexbox, padding,
 * border-radius, cantos arredondados, o atributo HTML `align=`) e descartada
 * quando o Quill reprocessa o HTML. Por isso a "bolha" aqui e simulada com
 * `<p style="text-align">` + `<span style="color;background-color">`, os
 * unicos recursos que realmente sobrevivem ao editor - nao da pra ter bolha
 * com canto arredondado/avatar de verdade dentro dele.
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
    const rawText = typeof msg.content?.text === "string" ? msg.content.text.trim() : "";
    if (!rawText) return null;
    const text = sentByMe ? stripSelfNamePrefix(rawText, who) : rawText;
    if (!text) return null;
    body = escapeHtml(text);
  } else if (msg.type === "list") {
    const description = typeof msg.content?.description === "string" ? msg.content.description.trim() : "";
    body = description ? escapeHtml(description) : "[menu de opções]";
  } else {
    body = `[mensagem tipo "${escapeHtml(msg.type)}"]`;
  }

  return (
    `<p style="text-align:${align};margin:6px 0;">` +
    `<span style="background-color:${bg};color:${BUBBLE_TEXT_COLOR};">` +
    `<strong>${escapeHtml(who)}</strong> <span style="color:${BUBBLE_META_COLOR};">[${time}]</span><br>${body}` +
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
