import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { requireEmailAccount } from "./EmailAccount";

export interface IncomingMessage {
  uid: number;
  /** ID de thread do Gmail (extensao X-GM-EXT-1, disponivel via IMAP mesmo sem a Gmail API). */
  threadId: string | undefined;
  rfcMessageId: string | undefined;
  inReplyTo: string | undefined;
  fromEmail: string;
  fromName: string | undefined;
  to: string[];
  subject: string;
  /** Texto puro (sem tags) - usado so para `Ticket.description`, que e exibido como texto simples no Base44. */
  bodyText: string;
  /**
   * HTML de verdade do email - usado para `TicketEmail.body`, que o Base44
   * renderiza dentro de um iframe (`EmailIframe.jsx`) como HTML cru. Guardar
   * texto puro ali (sem tags) faz o navegador colapsar todas as quebras de
   * linha numa unica linha - era exatamente o bug visto num email respondido
   * com assinatura/tabela: tudo virava um paragrafo so.
   */
  bodyHtml: string;
}

const MAX_BODY_TEXT_LENGTH = 5000;
const MAX_BODY_HTML_LENGTH = 50000;

// Toda letra acentuada em UTF-8 (2 bytes: 0xC3 + continuacao 0x80-0xBF) vira,
// se lida como Latin-1/Windows-1252, dois caracteres - sempre comecando por
// U+00C3 ("A" com til sozinho). Construido por codigo de caractere (nao
// literal) para nao depender de nenhuma ferramenta no meio do caminho
// preservar corretamente um acento dentro deste proprio arquivo-fonte.
const MOJIBAKE_LEAD_CHAR = String.fromCharCode(0xc3);
const MOJIBAKE_PATTERN = new RegExp(`${MOJIBAKE_LEAD_CHAR}[\\u0080-\\u00bf]`);

/**
 * Corrige mojibake: acontece quando o sistema que originou o email declara
 * um charset errado (ex: Windows-1252) no Content-Type, mas o conteudo real
 * e UTF-8 - visto em emails automaticos antigos ("ImplantaÃ§Ã£o" em vez de
 * "Implantação"). O mailparser segue fielmente o charset declarado, entao
 * nao ha como evitar isso no parsing; aqui so detectamos o padrao resultante
 * e revertemos. So aplica se a correcao NAO gerar caractere de substituicao
 * (U+FFFD) - sinal de que a entrada nao era esse tipo de mojibake e a
 * "correcao" so pioraria o texto.
 */
function fixMojibake(text: string): string {
  if (!text || !MOJIBAKE_PATTERN.test(text)) return text;
  const fixed = Buffer.from(text, "latin1").toString("utf8");
  return fixed.includes("�") ? text : fixed;
}

export interface InboxPollResult {
  messages: IncomingMessage[];
  lastUid: number;
}

/**
 * Responsavel unico: falar IMAP. Nao decide o que fazer com as mensagens
 * (isso e responsabilidade do EmailService) - so busca e devolve.
 */
export class InboxReader {
  private client(): ImapFlow {
    const { user, appPassword, imapHost, imapPort } = requireEmailAccount();
    return new ImapFlow({ host: imapHost, port: imapPort, secure: true, auth: { user, pass: appPassword }, logger: false });
  }

  /**
   * Busca mensagens novas com UID maior que `sinceUid`. Se `sinceUid` for
   * `undefined` (primeira execucao, sem cursor previo), so estabelece o
   * cursor atual sem processar o historico existente da caixa.
   */
  async pollSince(sinceUid: number | undefined): Promise<InboxPollResult> {
    const client = this.client();
    await client.connect();

    try {
      const lock = await client.getMailboxLock("INBOX");
      try {
        const mailbox = client.mailbox;
        const currentLastUid = mailbox ? Math.max((mailbox.uidNext ?? 1) - 1, 0) : 0;

        if (sinceUid === undefined || currentLastUid <= sinceUid) {
          return { messages: [], lastUid: sinceUid === undefined ? currentLastUid : sinceUid };
        }

        const messages: IncomingMessage[] = [];

        for await (const message of client.fetch(
          { uid: `${sinceUid + 1}:*` },
          { uid: true, envelope: true, source: true, threadId: true }
        )) {
          const envelope = message.envelope;
          const from = envelope?.from?.[0];
          const parsed = message.source ? await simpleParser(message.source) : undefined;

          // Prioridade: HTML de verdade do email > HTML gerado pelo mailparser
          // a partir do texto puro (ja escapado/com quebras de linha) > vazio.
          // Nunca usar `parsed.text` cru aqui - ele nao tem tags nenhuma, e o
          // Base44 renderiza este campo como HTML (ver EmailIframe.jsx).
          const bodyHtml = fixMojibake((parsed?.html || parsed?.textAsHtml || "").slice(0, MAX_BODY_HTML_LENGTH));

          messages.push({
            uid: message.uid,
            threadId: message.threadId,
            rfcMessageId: envelope?.messageId,
            inReplyTo: envelope?.inReplyTo,
            fromEmail: from?.address ?? "",
            fromName: fixMojibake(from?.name || "") || undefined,
            to: (envelope?.to ?? []).map((address) => address.address).filter((address): address is string => Boolean(address)),
            subject: fixMojibake(envelope?.subject ?? "(sem assunto)"),
            bodyText: fixMojibake((parsed?.text ?? "").slice(0, MAX_BODY_TEXT_LENGTH)),
            bodyHtml,
          });
        }

        return { messages, lastUid: currentLastUid };
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  }
}
