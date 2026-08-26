import type { Base44Client } from "@base44/sdk";
import { getEntities } from "../../services/base44Entities";
import type { NotificationConfigRecord } from "../../types/entities";
import { BaseRepository } from "./BaseRepository";

export class NotificationConfigRepository extends BaseRepository<NotificationConfigRecord> {
  protected handler(client: Base44Client) {
    return getEntities(client).NotificationConfig;
  }

  async findByUser(userEmail: string): Promise<NotificationConfigRecord | null> {
    return this.findOne({ user_email: userEmail });
  }
}
