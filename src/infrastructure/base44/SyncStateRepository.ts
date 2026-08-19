import type { Base44Client } from "@base44/sdk";
import { getEntities } from "../../services/base44Entities";
import type { SyncStateRecord } from "../../types/entities";
import { BaseRepository } from "./BaseRepository";

/** Guarda cursores de sincronizacao (ex: ultimo UID de email ja processado) entre execucoes. */
export class SyncStateRepository extends BaseRepository<SyncStateRecord> {
  protected handler(client: Base44Client) {
    return getEntities(client).SyncState;
  }

  async getCursor(key: string): Promise<SyncStateRecord | null> {
    return this.findOne({ key });
  }

  async saveCursor(key: string, value: string): Promise<void> {
    const existing = await this.getCursor(key);
    if (existing) {
      await this.update(existing.id, { history_id: value } as Partial<SyncStateRecord>);
    } else {
      await this.create({ key, history_id: value });
    }
  }
}
