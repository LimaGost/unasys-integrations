import sharp from "sharp";

export type RenderableMessage =
  | { who: string; time: string; sentByMe: boolean; kind: "text"; text: string }
  | { who: string; time: string; sentByMe: boolean; kind: "media"; mediaUrl: string };

/**
 * Gera um PNG parecido com um print de conversa do WhatsApp (bolhas
 * alinhadas por remetente, cores estilo modo escuro) a partir das
 * mensagens ja resolvidas (nome, hora, texto/imagem) - usado pelo botao
 * "Buscar conversa do WhatsApp" e pelo fechamento definitivo do atendimento
 * (ver SmclickIntegrationService). Desenha o SVG na mao e rasteriza com
 * `sharp` (sem depender de navegador/Puppeteer - a VPS onde isto roda nao
 * tem as bibliotecas de sistema que o Chromium do Puppeteer precisa, e
 * instalar ~30 pacotes so pra isso seria desproporcional).
 *
 * Mensagens com foto real (`kind: "media"`) tem a foto baixada da SM Click e
 * embutida na bolha (pedido do usuario em 2026-09-04: "preciso que traga as
 * imagens da conversa"). Audio/arquivo (sem foto pra mostrar) viram uma
 * legenda de texto ("[Áudio - 19s]" etc, `kind: "text"`) - sem campo de
 * legenda separado pra foto: a SM Click nunca mandou uma foto com legenda
 * nos dados reais testados, entao nao adiciona esse campo especulativamente
 * (ver services/smclickTranscript.ts).
 *
 * Emoji do TEXTO nao aparecem na imagem de proposito: a fonte de emoji
 * colorido instalada na VPS (fonts-noto-color-emoji) so cobre parte dos
 * emoji nas mensagens reais testadas em 2026-09-04, e mostrar emoji pela
 * metade (alguns coloridos, alguns em preto-e-branco, alguns ausentes)
 * ficava pior do que simplesmente omiti-los.
 */
const FONT_FAMILY = "DejaVu Sans, sans-serif";
const FONT_SIZE = 14;
const LINE_HEIGHT = 19;
const CHARS_PER_LINE = 42;
const AVG_CHAR_WIDTH = 7.3;
const BUBBLE_MAX_WIDTH = 340;
const BUBBLE_MIN_WIDTH = 130;
const BUBBLE_PADDING_X = 12;
const BUBBLE_PADDING_TOP = 8;
const BUBBLE_PADDING_BOTTOM = 8;
const NAME_ROW_HEIGHT = 18;
const TIME_ROW_HEIGHT = 14;
const BUBBLE_GAP = 8;
const CANVAS_WIDTH = 460;
const CANVAS_PADDING = 16;

const MEDIA_MAX_WIDTH = 300;
const MEDIA_MAX_HEIGHT = 320;
const MEDIA_FETCH_TIMEOUT_MS = 8_000;
const MEDIA_MAX_DOWNLOAD_BYTES = 15 * 1024 * 1024;
/** Fotos DISTINTAS baixadas por imagem gerada - alem disso, vira legenda "[Imagem]" em vez de baixar. Protege contra uma conversa com dezenas de fotos gerar uma imagem gigante/lenta. */
const MAX_DISTINCT_MEDIA_PER_RENDER = 12;

const BG_COLOR = "#0b141a";
const SENT_BG = "#005c4b";
const RECEIVED_BG = "#202c33";
const TEXT_COLOR = "#e9edef";
const TIME_COLOR = "#8696a0";
const META_COLOR_SENT = "#8fd9c4";
const META_COLOR_RECEIVED = "#8696a0";

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Remove emoji e simbolos pictograficos - ver nota no topo do arquivo sobre por que a imagem nao tenta mostra-los. */
function stripEmoji(text: string): string {
  return text
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}️\u{1F1E6}-\u{1F1FF}]/gu, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Quebra de linha por contagem de caracteres (aproximacao - SVG nao quebra linha sozinho como HTML/CSS). */
function wrapLine(text: string, maxChars: number): string[] {
  if (text.length === 0) return [""];
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (word.length > maxChars) {
      if (current) {
        lines.push(current);
        current = "";
      }
      for (let i = 0; i < word.length; i += maxChars) {
        lines.push(word.slice(i, i + maxChars));
      }
      continue;
    }
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxChars) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

function wrapMessage(text: string): string[] {
  return text
    .split("\n")
    .flatMap((paragraph) => wrapLine(paragraph, CHARS_PER_LINE))
    .slice(0, 60); // protecao contra mensagem absurdamente longa gerando uma imagem gigante
}

/** Largura da bolha - sempre grande o bastante pro cabecalho (nome + hora), nunca so pro conteudo (imagem/texto). */
function computeBubbleWidth(contentWidthPx: number, who: string, time: string): number {
  const headerWidthPx = (who.length + time.length + 4) * AVG_CHAR_WIDTH;
  const innerWidth = Math.max(contentWidthPx, headerWidthPx);
  return Math.min(BUBBLE_MAX_WIDTH, Math.max(BUBBLE_MIN_WIDTH, innerWidth + BUBBLE_PADDING_X * 2));
}

/** Fundo + nome + horario - comum aos dois tipos de bolha (texto e midia), o conteudo do meio e responsabilidade de quem chama. */
function pushBubbleFrame(
  parts: string[],
  opts: { x: number; y: number; width: number; height: number; bg: string; metaColor: string; who: string; time: string }
): void {
  parts.push(`<rect x="${opts.x}" y="${opts.y}" width="${opts.width}" height="${opts.height}" rx="10" fill="${opts.bg}" />`);
  parts.push(
    `<text x="${opts.x + BUBBLE_PADDING_X}" y="${opts.y + BUBBLE_PADDING_TOP + 13}" font-family="${FONT_FAMILY}" font-size="13" font-weight="bold" fill="${opts.metaColor}">${escapeXml(opts.who)}</text>`
  );
  parts.push(
    `<text x="${opts.x + opts.width - BUBBLE_PADDING_X}" y="${opts.y + opts.height - 6}" font-family="${FONT_FAMILY}" font-size="11" fill="${TIME_COLOR}" text-anchor="end">${escapeXml(opts.time)}</text>`
  );
}

interface FetchedMedia {
  base64: string;
  mimeType: string;
  width: number;
  height: number;
}

/** Baixa a foto da SM Click e recomprime pra um tamanho previsivel (JPEG) - nunca confia no formato/tamanho originais. */
async function fetchAndResizeImage(url: string): Promise<FetchedMedia | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MEDIA_FETCH_TIMEOUT_MS);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) return null;

    // Guard barato contra uma foto absurdamente grande (Content-Length
    // mentiroso/ausente ainda passa, mas cobre o caso comum sem precisar de
    // leitura em stream com corte no meio).
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (contentLength > MEDIA_MAX_DOWNLOAD_BYTES) {
      console.error(`[chat-image-renderer] imagem maior que o limite (${contentLength} bytes) - ignorada: ${url}`);
      return null;
    }

    const original = Buffer.from(await response.arrayBuffer());
    if (original.byteLength > MEDIA_MAX_DOWNLOAD_BYTES) {
      console.error(`[chat-image-renderer] imagem maior que o limite (${original.byteLength} bytes, sem Content-Length previo) - ignorada: ${url}`);
      return null;
    }
    // resolveWithObject devolve as dimensoes finais junto com o buffer -
    // evita decodificar o JPEG recem-gerado uma segunda vez so pra ler width/height.
    const { data, info } = await sharp(original)
      .resize({ width: MEDIA_MAX_WIDTH, height: MEDIA_MAX_HEIGHT, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 78 })
      .toBuffer({ resolveWithObject: true });

    return { base64: data.toString("base64"), mimeType: "image/jpeg", width: info.width, height: info.height };
  } catch (error) {
    console.error(`[chat-image-renderer] falha ao baixar/converter imagem (${url}):`, error);
    return null;
  }
}

export async function renderChatImage(messages: RenderableMessage[]): Promise<Buffer> {
  // Baixa TODAS as fotos em paralelo antes de montar o layout (que precisa
  // ser sequencial - a posicao Y de cada bolha depende da altura das
  // anteriores). Sem isto, cada foto esperava a anterior terminar (ate
  // MEDIA_FETCH_TIMEOUT_MS cada) - uma conversa com 5 fotos podia levar 5x
  // mais tempo numa chamada que serve um clique de botao em tempo real.
  const mediaByUrl = new Map<string, FetchedMedia | null>();
  const distinctUrls = [...new Set(messages.filter((msg) => msg.kind === "media").map((msg) => msg.mediaUrl))];
  await Promise.all(
    distinctUrls.slice(0, MAX_DISTINCT_MEDIA_PER_RENDER).map(async (url) => {
      mediaByUrl.set(url, await fetchAndResizeImage(url));
    })
  );
  // Fotos alem do limite ficam de fora do Map -> tratadas como "nao
  // disponivel" mais abaixo, sem tentar baixar (ver MAX_DISTINCT_MEDIA_PER_RENDER).

  const parts: string[] = [];
  let y = CANVAS_PADDING;
  let mediaCounter = 0;

  for (const msg of messages) {
    const bg = msg.sentByMe ? SENT_BG : RECEIVED_BG;
    const metaColor = msg.sentByMe ? META_COLOR_SENT : META_COLOR_RECEIVED;
    const media = msg.kind === "media" ? mediaByUrl.get(msg.mediaUrl) ?? null : null;

    if (media) {
      const bubbleWidth = computeBubbleWidth(media.width, msg.who, msg.time);
      const imageY = y + BUBBLE_PADDING_TOP + NAME_ROW_HEIGHT;
      const bubbleHeight = NAME_ROW_HEIGHT + media.height + BUBBLE_PADDING_TOP + BUBBLE_PADDING_BOTTOM + TIME_ROW_HEIGHT;
      const x = msg.sentByMe ? CANVAS_WIDTH - CANVAS_PADDING - bubbleWidth : CANVAS_PADDING;
      // Contador simples, nao a posicao Y - duas bolhas nunca podem colidir
      // no mesmo id mesmo se algum dia o layout deixar de ser estritamente
      // sequencial (ao contrario de usar `y` como id).
      const clipId = `clip-${mediaCounter++}`;

      pushBubbleFrame(parts, { x, y, width: bubbleWidth, height: bubbleHeight, bg, metaColor, who: msg.who, time: msg.time });
      parts.push(
        `<clipPath id="${clipId}"><rect x="${x + BUBBLE_PADDING_X}" y="${imageY}" width="${media.width}" height="${media.height}" rx="6" /></clipPath>` +
          `<image x="${x + BUBBLE_PADDING_X}" y="${imageY}" width="${media.width}" height="${media.height}" ` +
          `clip-path="url(#${clipId})" href="data:${media.mimeType};base64,${media.base64}" />`
      );

      y += bubbleHeight + BUBBLE_GAP;
      continue;
    }

    // Texto normal, ou foto que nao pode ser baixada (indisponivel/erro de rede) - vira legenda.
    const fallbackText = msg.kind === "media" ? "[Imagem indisponível]" : msg.text;
    const cleanText = stripEmoji(fallbackText) || "…";
    const lines = wrapMessage(cleanText);
    const bubbleHeight = NAME_ROW_HEIGHT + lines.length * LINE_HEIGHT + BUBBLE_PADDING_TOP + BUBBLE_PADDING_BOTTOM;
    const longestLinePx = Math.max(...lines.map((l) => l.length)) * AVG_CHAR_WIDTH;
    const bubbleWidth = computeBubbleWidth(longestLinePx, msg.who, msg.time);
    const x = msg.sentByMe ? CANVAS_WIDTH - CANVAS_PADDING - bubbleWidth : CANVAS_PADDING;

    pushBubbleFrame(parts, { x, y, width: bubbleWidth, height: bubbleHeight, bg, metaColor, who: msg.who, time: msg.time });

    let textY = y + BUBBLE_PADDING_TOP + 13 + NAME_ROW_HEIGHT;
    for (const line of lines) {
      parts.push(
        `<text x="${x + BUBBLE_PADDING_X}" y="${textY}" font-family="${FONT_FAMILY}" font-size="${FONT_SIZE}" fill="${TEXT_COLOR}">${escapeXml(line)}</text>`
      );
      textY += LINE_HEIGHT;
    }

    y += bubbleHeight + BUBBLE_GAP;
  }

  const totalHeight = y + CANVAS_PADDING;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_WIDTH}" height="${totalHeight}">` +
    `<rect width="${CANVAS_WIDTH}" height="${totalHeight}" fill="${BG_COLOR}" />` +
    parts.join("") +
    `</svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}
