import type { Base44Client } from "@base44/sdk";
import { getEntities } from "../../services/base44Entities";
import type { TimeEntryRecord } from "../../types/entities";
import { BaseRepository } from "./BaseRepository";

export class TimeEntryRepository extends BaseRepository<TimeEntryRecord> {
  protected handler(client: Base44Client) {
    return getEntities(client).TimeEntry;
  }

  async findByTicket(ticketId: string): Promise<TimeEntryRecord[]> {
    return this.findMany({ ticket_id: ticketId });
  }
}
