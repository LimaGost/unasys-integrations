import { NotificationConfigRepository } from "../infrastructure/base44/NotificationConfigRepository";
import { NotificationRepository } from "../infrastructure/base44/NotificationRepository";
import type { NotificationConfigRecord, NotificationRecord, NotificationType } from "../types/entities";

export interface CreateNotificationCommand {
  userEmail: string;
  type: NotificationType;
  title: string;
  message: string;
  ticketId?: string | null;
  ticketTitle?: string | null;
  actorName?: string | null;
  actorEmail?: string | null;
  priority?: "low" | "normal" | "high";
}

export type CreateNotificationResult =
  | { status: "created"; notification: NotificationRecord }
  | { status: "skipped_preference" }
  | { status: "suppressed_quiet_hours" };

/** Mapeia o tipo de notificacao para o campo de preferencia correspondente em NotificationConfig. Tipos sem preferencia dedicada (ex: ticket_created) sao sempre permitidos. */
function isTypeEnabled(type: NotificationType, config: NotificationConfigRecord | null): boolean {
  switch (type) {
    case "ticket_assigned":
      return config?.notify_on_assignment ?? true;
    case "status_changed":
      return config?.notify_on_status_change ?? true;
    case "new_comment":
    case "new_time_entry":
      return config?.notify_on_comments ?? true;
    case "mentioned":
      return config?.notify_on_mention ?? true;
    case "sla_warning":
      return config?.notify_on_sla_warning ?? true;
    case "ticket_created":
      return true;
  }
}

function isInQuietHours(config: NotificationConfigRecord | null): boolean {
  if (!config?.quiet_hours_enabled) return false;
  const now = new Date();
  const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const start = config.quiet_hours_start || "22:00";
  const end = config.quiet_hours_end || "08:00";
  return start < end ? currentTime >= start && currentTime < end : currentTime >= start || currentTime < end;
}

/** Porta a logica da antiga function `createNotification` do Base44 - respeita preferencias de notificacao e horario silencioso do usuario antes de criar o registro. */
export class NotificationService {
  constructor(
    private readonly notifications: NotificationRepository,
    private readonly configs: NotificationConfigRepository
  ) {}

  async create(command: CreateNotificationCommand): Promise<CreateNotificationResult> {
    const config = await this.configs.findByUser(command.userEmail).catch(() => null);

    if (!isTypeEnabled(command.type, config)) {
      return { status: "skipped_preference" };
    }

    if (isInQuietHours(config)) {
      return { status: "suppressed_quiet_hours" };
    }

    const notification = await this.notifications.create({
      user_email: command.userEmail,
      ticket_id: command.ticketId ?? null,
      ticket_title: command.ticketTitle ?? null,
      type: command.type,
      title: command.title,
      message: command.message,
      priority: command.priority ?? "normal",
      actor_name: command.actorName ?? null,
      actor_email: command.actorEmail ?? null,
      read: false,
    });

    return { status: "created", notification };
  }
}
