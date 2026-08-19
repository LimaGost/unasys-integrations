import type { TicketEmailRecord } from "../types/entities";

/**
 * Encapsula a regra de encadeamento de thread: um novo email de um ticket
 * responde ao ultimo email ENVIADO (nao recebido) desse ticket, referenciando
 * o Message-ID real (RFC822) dele nos cabecalhos In-Reply-To/References.
 */
export class TicketEmailThread {
  private constructor(private readonly lastSent: TicketEmailRecord | null) {}

  static fromLastSent(lastSent: TicketEmailRecord | null): TicketEmailThread {
    return new TicketEmailThread(lastSent);
  }

  get isReply(): boolean {
    return Boolean(this.lastSent?.rfc_message_id);
  }

  get inReplyTo(): string | undefined {
    return this.lastSent?.rfc_message_id;
  }
}
