import sharp from "sharp";

export interface RenderableMessage {
  who: string;
  time: string;
  text: string;
  sentByMe: boolean;
}

/**
 * Gera um PNG parecido com um print de conversa do WhatsApp (bolhas
 * alinhadas por remetente, cores estilo modo escuro) a partir das
 * mensagens ja resolvidas (nome, hora, texto) - usado pelo botao "Buscar
 * conversa do WhatsApp" e pelo fechamento definitivo do atendimento (ver
 * SmclickIntegrationService). Desenha o SVG na mao e rasteriza com `sharp`
 * (sem depender de navegador/Puppeteer - a VPS onde isto roda nao tem as
 * bibliotecas de sistema que o Chromium do Puppeteer precisa, e instalar
 * ~30 pacotes so pra isso seria desproporcional).
 *
 * Emoji NAO aparecem na imagem de proposito: a fonte de emoji colorido
 * instalada na VPS (fonts-noto-color-emoji) so cobre parte dos emoji nas
 * mensagens reais testadas em 2026-09-04, e mostrar emoji pela metade
 * (alguns coloridos, alguns em preto-e-branco, alguns ausentes) ficava pior
 * do que simplesmente omiti-los.
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
const BUBBLE_GAP = 8;
const CANVAS_WIDTH = 460;
const CANVAS_PADDING = 16;

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

export async function renderChatImage(messages: RenderableMessage[]): Promise<Buffer> {
  const parts: string[] = [];
  let y = CANVAS_PADDING;

  for (const msg of messages) {
    const cleanText = stripEmoji(msg.text) || "…";
    const lines = wrapMessage(cleanText);
    const bubbleHeight = NAME_ROW_HEIGHT + lines.length * LINE_HEIGHT + BUBBLE_PADDING_TOP + BUBBLE_PADDING_BOTTOM;

    const longestLine = Math.max(...lines.map((l) => l.length), msg.who.length + msg.time.length + 4);
    const bubbleWidth = Math.min(BUBBLE_MAX_WIDTH, Math.max(BUBBLE_MIN_WIDTH, longestLine * AVG_CHAR_WIDTH + BUBBLE_PADDING_X * 2));

    const x = msg.sentByMe ? CANVAS_WIDTH - CANVAS_PADDING - bubbleWidth : CANVAS_PADDING;
    const bg = msg.sentByMe ? SENT_BG : RECEIVED_BG;
    const metaColor = msg.sentByMe ? META_COLOR_SENT : META_COLOR_RECEIVED;

    parts.push(`<rect x="${x}" y="${y}" width="${bubbleWidth}" height="${bubbleHeight}" rx="10" fill="${bg}" />`);

    let textY = y + BUBBLE_PADDING_TOP + 13;
    parts.push(
      `<text x="${x + BUBBLE_PADDING_X}" y="${textY}" font-family="${FONT_FAMILY}" font-size="13" font-weight="bold" fill="${metaColor}">${escapeXml(msg.who)}</text>`
    );
    textY += NAME_ROW_HEIGHT;

    for (const line of lines) {
      parts.push(
        `<text x="${x + BUBBLE_PADDING_X}" y="${textY}" font-family="${FONT_FAMILY}" font-size="${FONT_SIZE}" fill="${TEXT_COLOR}">${escapeXml(line)}</text>`
      );
      textY += LINE_HEIGHT;
    }

    parts.push(
      `<text x="${x + bubbleWidth - BUBBLE_PADDING_X}" y="${textY - LINE_HEIGHT + FONT_SIZE + 4}" font-family="${FONT_FAMILY}" font-size="11" fill="${TIME_COLOR}" text-anchor="end">${escapeXml(msg.time)}</text>`
    );

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
