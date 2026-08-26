import type { Base44Client } from "@base44/sdk";
import { getEntities } from "../../services/base44Entities";
import type { KanbanConfigRecord } from "../../types/entities";
import { BaseRepository } from "./BaseRepository";

export class KanbanConfigRepository extends BaseRepository<KanbanConfigRecord> {
  protected handler(client: Base44Client) {
    return getEntities(client).KanbanConfig;
  }
}
