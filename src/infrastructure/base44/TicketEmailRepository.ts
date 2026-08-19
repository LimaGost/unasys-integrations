import type { Base44Client } from "@base44/sdk";
import { getEntities } from "../../services/base44Entities";
import type { TicketEmailRecord } from "../../types/entities";
import { BaseRepository } from "./BaseRepository";

export class TicketEmailRepository extends BaseRepository<TicketEmailRecord> {
  protected handler(client: Base44Client) {
    return getEntities(client).TicketEmail;
  }

  /** Ultimo email ENVIADO desse ticket - usado para encadear thread (ver TicketEmailThread). */
  async findLastSent(ticketId: string): Promise<TicketEmailRecord | null> {
    return this.findOne({ ticket_id: ticketId, direction: "sent" }, "-created_date");
  }

  async findByThreadId(threadId: string): Promise<TicketEmailRecord | null> {
    return this.findOne({ gmail_thread_id: threadId }, "-created_date");
  }

  async findByReplyTo(rfcMessageId: string): Promise<TicketEmailRecord | null> {
    return this.findOne({ rfc_message_id: rfcMessageId }, "-created_date");
  }
}
