import type { Base44Client } from "@base44/sdk";
import { getEntities } from "../../services/base44Entities";
import type { TicketRecord } from "../../types/entities";
import { BaseRepository } from "./BaseRepository";

export class TicketRepository extends BaseRepository<TicketRecord> {
  protected handler(client: Base44Client) {
    return getEntities(client).Ticket;
  }
}
