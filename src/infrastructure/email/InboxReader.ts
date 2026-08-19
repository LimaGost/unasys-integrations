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
  bodyText: string;
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

          messages.push({
            uid: message.uid,
            threadId: message.threadId,
            rfcMessageId: envelope?.messageId,
            inReplyTo: envelope?.inReplyTo,
            fromEmail: from?.address ?? "",
            fromName: from?.name || undefined,
            to: (envelope?.to ?? []).map((address) => address.address).filter((address): address is string => Boolean(address)),
            subject: envelope?.subject ?? "(sem assunto)",
            bodyText: (parsed?.text ?? "").slice(0, 5000),
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
