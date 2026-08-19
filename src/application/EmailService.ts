import { env } from "../config/env";
import { TicketEmailThread } from "../domain/TicketEmailThread";
import { ClientRepository } from "../infrastructure/base44/ClientRepository";
import { SyncStateRepository } from "../infrastructure/base44/SyncStateRepository";
import { TicketEmailRepository } from "../infrastructure/base44/TicketEmailRepository";
import { TicketRepository } from "../infrastructure/base44/TicketRepository";
import { currentEmailUser, isEmailConfigured } from "../infrastructure/email/EmailAccount";
import { InboxReader, type IncomingMessage } from "../infrastructure/email/InboxReader";
import { Mailer } from "../infrastructure/email/Mailer";
import { DEFAULT_STATUS_COLUMN, normalizeVertical } from "../services/base44Entities";
import { recordGmailPollError, recordGmailPollSuccess } from "../services/gmailStatus";

export class TicketNotFoundError extends Error {
  constructor(ticketId: string) {
    super(`Ticket ${ticketId} nao encontrado.`);
    this.name = "TicketNotFoundError";
  }
}

export interface SendPlainEmailCommand {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
}

export interface TicketEmailAttachmentInput {
  url: string;
  name: string;
}

export interface SendTicketEmailCommand {
  ticketId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  html: string;
  attachments: TicketEmailAttachmentInput[];
  /** Registro TicketEmail ja criado pelo frontend, a atualizar com o resultado do envio. */
  existingEmailId?: string | null;
  /** Usado so quando o frontend NAO conseguiu criar o registro antes (ex: RLS) - cria aqui. */
  fallbackSender?: { fromEmail: string; fromName?: string } | null;
}

export interface SendTicketEmailResult {
  ticketEmailId: string | null;
  messageId: string;
}

export interface PollSummary {
  processed: number;
  results: Array<{ ticketId: string; ticketEmailId: string }>;
}

export interface SendAndLogCommand {
  ticketId: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
}

export interface SendAndLogResult {
  ticketEmailId: string;
  rfcMessageId: string;
}

/**
 * Orquestra tudo relacionado a email de Ticket: enviar (com ou sem anexos e
 * encadeamento de thread), repassar mensagens ja prontas, e ler a caixa de
 * entrada criando/atualizando Tickets. As pecas de infraestrutura (SMTP,
 * IMAP, Base44) sao injetadas no construtor - este service so sabe as
 * REGRAS, nao os detalhes de "como falar SMTP" ou "como falar com o Base44".
 */
export class EmailService {
  constructor(
    private readonly mailer: Mailer,
    private readonly inbox: InboxReader,
    private readonly tickets: TicketRepository,
    private readonly ticketEmails: TicketEmailRepository,
    private readonly clients: ClientRepository,
    private readonly syncState: SyncStateRepository
  ) {}

  isConfigured(): boolean {
    return isEmailConfigured();
  }

  /** Envio simples, sem vinculo com Ticket - usado por integracoes externas genericas. */
  async sendPlain(command: SendPlainEmailCommand): Promise<{ rfcMessageId: string }> {
    const { messageId } = await this.mailer.send({
      to: command.to,
      cc: command.cc,
      bcc: command.bcc,
      subject: command.subject,
      text: command.body,
    });
    return { rfcMessageId: messageId };
  }

  /** Repassa uma mensagem MIME ja pronta (formato Gmail API "raw"), sem envolver Ticket algum. */
  async relayRaw(rawBase64Url: string, to: string[], cc?: string[], bcc?: string[]): Promise<{ messageId: string }> {
    return this.mailer.sendRaw(rawBase64Url, to, cc, bcc);
  }

  /**
   * Envio simples de texto puro vinculado a um Ticket, sem threading/anexos
   * (usado por integracoes externas genericas via webhook). Nao valida que o
   * ticket existe - mesmo comportamento de sempre, pra nao quebrar quem ja
   * chama isso hoje.
   */
  async sendAndLog(command: SendAndLogCommand): Promise<SendAndLogResult> {
    const { rfcMessageId } = await this.sendPlain(command);
    const record = await this.ticketEmails.create({
      ticket_id: command.ticketId,
      subject: command.subject,
      body: command.body,
      from_email: currentEmailUser() as string,
      to: command.to,
      cc: command.cc,
      bcc: command.bcc,
      direction: "sent",
      rfc_message_id: rfcMessageId,
      visible_to_client: true,
    });
    return { ticketEmailId: record.id, rfcMessageId };
  }

  async sendTicketEmail(command: SendTicketEmailCommand): Promise<SendTicketEmailResult> {
    const ticket = await this.tickets.findById(command.ticketId);
    if (!ticket) throw new TicketNotFoundError(command.ticketId);

    const lastSent = await this.ticketEmails.findLastSent(command.ticketId);
    const thread = TicketEmailThread.fromLastSent(lastSent);

    const attachments = command.attachments.length
      ? await Promise.all(command.attachments.map((a) => this.mailer.downloadAttachment(a.url, a.name)))
      : undefined;

    const { messageId } = await this.mailer.send({
      to: command.to,
      cc: command.cc,
      bcc: command.bcc,
      subject: command.subject,
      html: command.html,
      attachments,
      inReplyTo: thread.inReplyTo,
    });

    const attachmentRecords = command.attachments.map((a) => ({ filename: a.name, url: a.url }));

    if (command.existingEmailId) {
      await this.ticketEmails.update(command.existingEmailId, {
        gmail_message_id: messageId,
        rfc_message_id: messageId,
        attachments: attachmentRecords,
      });
      return { ticketEmailId: command.existingEmailId, messageId };
    }

    if (command.fallbackSender) {
      const record = await this.ticketEmails.create({
        ticket_id: command.ticketId,
        direction: "sent",
        from_email: command.fallbackSender.fromEmail,
        from_name: command.fallbackSender.fromName,
        to: command.to,
        cc: command.cc,
        bcc: command.bcc,
        subject: command.subject,
        body: command.html,
        attachments: attachmentRecords,
        gmail_message_id: messageId,
        rfc_message_id: messageId,
        visible_to_client: true,
      });
      return { ticketEmailId: record.id, messageId };
    }

    return { ticketEmailId: null, messageId };
  }

  /** Verifica a caixa de entrada e cria/atualiza Tickets a partir de mensagens novas. Publico: usado pelo poller (index.ts) e pela rota manual. */
  async pollInbox(): Promise<PollSummary> {
    try {
      const summary = await this.pollInboxUnsafe();
      recordGmailPollSuccess(summary.processed);
      return summary;
    } catch (error) {
      recordGmailPollError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private async pollInboxUnsafe(): Promise<PollSummary> {
    const cursor = await this.syncState.getCursor("gmail_last_uid");
    const sinceUid = cursor?.history_id ? Number(cursor.history_id) : undefined;

    const { messages, lastUid } = await this.inbox.pollSince(sinceUid);
    const results: Array<{ ticketId: string; ticketEmailId: string }> = [];

    for (const message of messages) {
      const ticketId = await this.resolveTicketForIncoming(message);
      const ticketEmail = await this.ticketEmails.create({
        ticket_id: ticketId,
        subject: message.subject,
        body: message.bodyText,
        from_email: message.fromEmail,
        from_name: message.fromName,
        to: message.to,
        direction: "received",
        gmail_thread_id: message.threadId,
        rfc_message_id: message.rfcMessageId,
        reply_to_email_id: message.inReplyTo,
        is_reply: Boolean(message.inReplyTo),
        visible_to_client: true,
      });
      results.push({ ticketId, ticketEmailId: ticketEmail.id });
    }

    await this.syncState.saveCursor("gmail_last_uid", String(lastUid));
    return { processed: results.length, results };
  }

  /** Tenta achar o ticket certo (mesma thread, resposta a um email conhecido, ou remetente ja com ticket) antes de criar um novo. */
  private async resolveTicketForIncoming(message: IncomingMessage): Promise<string> {
    if (message.threadId) {
      const byThread = await this.ticketEmails.findByThreadId(message.threadId);
      if (byThread) return byThread.ticket_id;
    }

    if (message.inReplyTo) {
      const byReply = await this.ticketEmails.findByReplyTo(message.inReplyTo);
      if (byReply) return byReply.ticket_id;
    }

    if (message.fromEmail) {
      const existing = await this.tickets.findOne({ client_email: message.fromEmail }, "-created_date");
      if (existing) return existing.id;
    }

    const client = await this.clients.findOrCreate(
      { email: message.fromEmail },
      { nome_fantasia: message.fromName ?? message.fromEmail, email: message.fromEmail }
    );

    const ticket = await this.tickets.create({
      title: message.subject,
      main_type: "suporte",
      client_id: client.id,
      client_name: message.fromName ?? message.fromEmail,
      client_email: message.fromEmail,
      // TODO: decisao pendente - nao ha como inferir o vertical correto so
      // pelo remetente do email. Usando o padrao configuravel
      // GMAIL_DEFAULT_SUPPORT_VERTICAL ate definirmos uma regra.
      vertical: normalizeVertical(env.gmail.defaultSupportVertical),
      urgency: "media",
      description: message.bodyText,
      external_system: "gmail",
      status_column_id: DEFAULT_STATUS_COLUMN,
      status_column_title: DEFAULT_STATUS_COLUMN,
    });

    return ticket.id;
  }
}
