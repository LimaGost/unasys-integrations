import type { Base44Client } from "@base44/sdk";
import { getEntities } from "../../services/base44Entities";
import type { TicketEventRecord } from "../../types/entities";
import { BaseRepository } from "./BaseRepository";

export class TicketEventRepository extends BaseRepository<TicketEventRecord> {
  protected handler(client: Base44Client) {
    return getEntities(client).TicketEvent;
  }

  async findByTicket(ticketId: string): Promise<TicketEventRecord[]> {
    return this.findMany({ ticket_id: ticketId });
  }
}
