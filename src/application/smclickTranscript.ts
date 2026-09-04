import type { RenderableMessage } from "../infrastructure/rendering/ChatImageRenderer";
import type { SmclickMessage } from "../infrastructure/smclick/SmclickApiClient";

export interface ResolvedTranscript {
  items: RenderableMessage[];
  /** null se nao houver nenhuma mensagem com sent_at valido (nao da pra montar um Registro sem hora de inicio/fim). */
  firstMessageAt: Date | null;
  lastMessageAt: Date | null;
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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A SM Click as vezes embute "*Nome*:" no INICIO do texto de mensagens
 * enviadas por um atendente (confirmado em dados reais, ex: "*IURY LIMA*:\n\nola")
 * - como o nome ja aparece separado (cabecalho da bolha na imagem), remove
 * esse prefixo repetido do corpo da mensagem pra nao duplicar.
 */
function stripSelfNamePrefix(text: string, who: string): string {
  const pattern = new RegExp(`^\\*${escapeRegExp(who)}\\*:\\s*`, "i");
  return text.replace(pattern, "").trim();
}

/**
 * Extensoes/subtipos confirmados em fotos reais trocadas por WhatsApp via SM
 * Click em 2026-09-04 (campo `content.type` da mensagem, ex: "jpeg") - a SM
 * Click usa o MESMO `msg.type` ("file") pra foto E pra audio-como-arquivo,
 * entao so da pra distinguir pelo subtipo aqui dentro do content.
 */
const IMAGE_CONTENT_TYPES = new Set(["jpeg", "jpg", "png", "gif", "webp", "bmp"]);

function isImageContentType(contentType: unknown): contentType is string {
  return typeof contentType === "string" && IMAGE_CONTENT_TYPES.has(contentType.toLowerCase());
}

function formatAudioLabel(content: Record<string, unknown> | undefined): string {
  const duration = typeof content?.duration === "number" ? Math.round(content.duration) : undefined;
  return duration !== undefined ? `[Áudio - ${duration}s]` : "[Áudio]";
}

/** Uniao discriminada de verdade (nao dois opcionais soltos) - garante em tempo de compilacao que "media" sempre tem mediaUrl e "text" sempre tem text, sem revalidacao manual em quem consome. */
type ResolvedMessageContent = { who: string; kind: "text"; text: string } | { who: string; kind: "media"; mediaUrl: string };

/**
 * Resolve nome + conteudo (texto OU foto) de uma mensagem, ou null se ela
 * nao entra no transcript. Mapeia texto, menu de lista do bot, foto real
 * (baixada e embutida na imagem final - ver ChatImageRenderer) e
 * audio/arquivo (legenda descritiva, sem foto pra mostrar) - confirmado
 * contra dados reais de conversa em 2026-09-04 (ver comentario de
 * IMAGE_CONTENT_TYPES). So reconhece `msg.type === "file"` com
 * `content.type` de imagem pra foto (nunca visto `msg.type === "image"` na
 * API real - se um dia aparecer, confirmar o formato do content antes de
 * tratar como foto, em vez de assumir). Tipos ainda nao vistos na API real
 * caem no fallback generico, sem inventar campo de conteudo.
 */
function resolveMessageContent(msg: SmclickMessage, contactName: string): ResolvedMessageContent | null {
  // Eventos internos (chat-started, chat-waiting, etc) - nao e conversa "falada".
  if (msg.type === "system") return null;

  const sentByMe = msg.from_me;
  const who = sentByMe ? msg.sent_by?.name || "Bot/Automação" : contactName;

  if (msg.type === "text") {
    const rawText = typeof msg.content?.text === "string" ? msg.content.text.trim() : "";
    if (!rawText) return null;
    const text = sentByMe ? stripSelfNamePrefix(rawText, who) : rawText;
    if (!text) return null;
    return { who, kind: "text", text };
  }

  if (msg.type === "list") {
    const description = typeof msg.content?.description === "string" ? msg.content.description.trim() : "";
    return { who, kind: "text", text: description || "[menu de opções]" };
  }

  if (msg.type === "file") {
    const url = typeof msg.content?.url === "string" ? msg.content.url : undefined;
    const contentType = msg.content?.type;
    if (url && isImageContentType(contentType)) {
      return { who, kind: "media", mediaUrl: url };
    }
    if (typeof contentType === "string" && contentType.startsWith("audio")) {
      return { who, kind: "text", text: formatAudioLabel(msg.content) };
    }
    return { who, kind: "text", text: "[Arquivo enviado]" };
  }

  if (msg.type === "audio") {
    return { who, kind: "text", text: formatAudioLabel(msg.content) };
  }

  return { who, kind: "text", text: `[mensagem tipo "${msg.type}"]` };
}

/**
 * Prefixo fixo do HTML gerado pra este Registro (nao muda entre a versao
 * "em andamento" e a versao final) - usado por SmclickIntegrationService pra
 * reconhecer, entre os Registros de um Ticket, qual e o Registro automatico
 * do transcript (pra atualizar em vez de duplicar a cada sincronizacao).
 */
export const TRANSCRIPT_HEADER_PREFIX = "<p><strong>Histórico da conversa (WhatsApp via SM Click)";

/**
 * Ordena as mensagens, filtra o que nao e "conversa falada" (eventos de
 * sistema) e resolve nome/texto de cada una - pronto pra virar imagem via
 * ChatImageRenderer.renderChatImage. Separado de la porque tambem precisa
 * do timestamp da primeira/ultima mensagem (date/start_time/end_time do
 * Registro).
 *
 * `includeMedia=false` troca toda foto por uma legenda "[Imagem]" (SEM
 * baixar nada da SM Click) - usado pela sincronizacao AO VIVO
 * (handleNewChatMessage, a cada mensagem nova, debounced em 45s): sem isto,
 * cada sincronizacao de uma conversa com varias fotos baixava/recomprimia
 * TODAS elas de novo, mesmo as que ja tinham sido buscadas minutos antes -
 * achado real de code-review em 2026-09-04. A versao definitiva
 * (chat-finished) e o botao sob demanda continuam com includeMedia=true,
 * ja que rodam bem menos vezes por atendimento.
 */
export function resolveTranscriptMessages(messages: SmclickMessage[], contactName: string, includeMedia: boolean): ResolvedTranscript {
  const withDates = messages
    .map((msg) => ({ msg, date: new Date(msg.sent_at) }))
    .filter(({ date }) => !Number.isNaN(date.getTime()))
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  const items: RenderableMessage[] = [];
  for (const { msg, date } of withDates) {
    const resolved = resolveMessageContent(msg, contactName);
    if (!resolved) continue;
    const time = formatTime(date);
    if (resolved.kind === "media") {
      items.push(
        includeMedia
          ? { who: resolved.who, time, sentByMe: msg.from_me, kind: "media", mediaUrl: resolved.mediaUrl }
          : { who: resolved.who, time, sentByMe: msg.from_me, kind: "text", text: "[Imagem]" }
      );
    } else {
      items.push({ who: resolved.who, time, sentByMe: msg.from_me, kind: "text", text: resolved.text });
    }
  }

  return {
    items,
    firstMessageAt: withDates[0]?.date ?? null,
    lastMessageAt: withDates[withDates.length - 1]?.date ?? null,
  };
}

/**
 * Monta o HTML final do campo "Relato da Atividade" (TimeEntry.description):
 * um cabecalho de texto (reconhecivel por TRANSCRIPT_HEADER_PREFIX) + a
 * imagem da conversa (ou um aviso, se nao tiver nenhuma mensagem "falada").
 * `finished` deixa claro no proprio texto se e um retrato ao vivo
 * (atendimento ainda em andamento) ou a versao definitiva.
 *
 * `imageUrl` nulo so acontece quando o atendimento tem timestamp (chamador
 * ja confirmou isso antes de chegar aqui - ver
 * SmclickIntegrationService.renderTranscriptContent) mas NENHUMA mensagem de
 * texto/lista - ou seja, so eventos internos (chat-started, chat-waiting,
 * etc) - por isso o aviso e especifico, nao um generico "nenhuma mensagem".
 */
export function buildTranscriptDescriptionHtml(finished: boolean, imageUrl: string | null): string {
  const suffix = finished ? "" : " — atualizado automaticamente, atendimento ainda em andamento";
  const header = `${TRANSCRIPT_HEADER_PREFIX}${suffix}:</strong></p>`;
  if (!imageUrl) {
    return `${header}<p><em>Atendimento sem mensagens de texto (so eventos internos).</em></p>`;
  }
  return `${header}<p><img src="${imageUrl}" alt="Histórico da conversa (print)" /></p>`;
}
