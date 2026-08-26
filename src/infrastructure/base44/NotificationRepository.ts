import type { Base44Client } from "@base44/sdk";
import { getEntities } from "../../services/base44Entities";
import type { NotificationRecord } from "../../types/entities";
import { BaseRepository } from "./BaseRepository";

export class NotificationRepository extends BaseRepository<NotificationRecord> {
  protected handler(client: Base44Client) {
    return getEntities(client).Notification;
  }
}
