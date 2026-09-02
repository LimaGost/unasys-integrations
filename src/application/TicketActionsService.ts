import { TicketEventRepository } from "../infrastructure/base44/TicketEventRepository";
import { TicketRepository } from "../infrastructure/base44/TicketRepository";
import type { TicketRecord } from "../types/entities";
import type { EmailService } from "./EmailService";
import type { NotificationService } from "./NotificationService";
import type { TicketAutomationEngine } from "./TicketAutomationEngine";

export interface TicketActor {
  email: string;
  name: string;
}

export interface UpdateTicketStatusCommand {
  ticketId: string;
  newStatus: string;
  columnData?: {
    id?: string;
    is_final?: boolean;
    pauses_sla?: boolean;
    sla_hours?: number;
  };
  subStatus?: string | null;
}

export type UpdateTicketStatusResult =
  | { skipped: true; reason: string }
  | { skipped: false; oldStatus?: string; newStatus: string; executedRules: string[] };

const MS_PER_HOUR = 3_600_000;

/**
 * Porta a antiga function `updateTicketStatus` do Base44 - chamada a cada
 * movimentacao de card no Kanban (a acao mais frequente do sistema, e por
 * isso a que mais gastava credito de integracao la). Recalcula o SLA da
 * coluna de destino, registra o evento, notifica o responsavel, dispara as
 * regras de automacao do gatilho "status_changed" e, se o novo status
 * indicar espera do cliente, avisa por email.
 *
 * Nao portado ainda (TODO, ver ESTRUTURA-DO-PROJETO.md/README.md):
 * - Envio de pesquisa de satisfacao (CSAT) ao entrar em coluna final -
 *   depende de uma pagina publica de captura de nota (`/csat?ticket=...`)
 *   que ainda nao existe neste servico; enviar o email sem essa pagina
 *   deixaria o link quebrado para o cliente.
 * - Sincronizacao de status de volta para o Unasys Flow - depende de uma URL
 *   de webhook do Flow que ainda nao foi configurada/confirmada aqui.
 */
export class TicketActionsService {
  constructor(
    private readonly tickets: TicketRepository,
    private readonly ticketEvents: TicketEventRepository,
    private readonly notifications: NotificationService,
    private readonly mailer: EmailService,
    private readonly automation: TicketAutomationEngine
  ) {}

  async updateStatus(command: UpdateTicketStatusCommand, actor: TicketActor): Promise<UpdateTicketStatusResult> {
    const { ticketId, newStatus, columnData, subStatus } = command;
    if (!ticketId || !newStatus) {
      throw Object.assign(new Error("Campos obrigatorios: ticketId, newStatus."), { status: 400 });
    }

    const ticket = await this.tickets.findById(ticketId);
    if (!ticket) {
      throw Object.assign(new Error("Ticket nao encontrado."), { status: 404 });
    }

    const oldStatus = ticket.status_column_title;
    if (oldStatus === newStatus) {
      return { skipped: true, reason: "same_status" };
    }

    const isFinal = !!columnData?.is_final;
    const pausesSla = !!columnData?.pauses_sla;
    const rawSlaHours = typeof columnData?.sla_hours === "number" ? columnData.sla_hours : null;
    // SLA "real" (<= 1 ano). Valores absurdos (ex: 100000000) = SLA desativado na coluna.
    const colSlaHours = rawSlaHours && rawSlaHours > 0 && rawSlaHours <= 8760 ? rawSlaHours : null;
    const slaDisabledOnColumn = !!(rawSlaHours && rawSlaHours > 8760);

    const updateData: Partial<TicketRecord> = {
      status_column_title: newStatus,
      sub_status: subStatus ?? null,
      ...(columnData?.id ? { status_column_id: columnData.id } : {}),
      ...(isFinal
        ? { closed_at: new Date().toISOString(), sla_paused_at: null, sla_breached: false }
        : { closed_at: null }),
    };

    if (isFinal) {
      // Coluna final: SLA encerrado (ja tratado acima).
    } else if (pausesSla) {
      if (!ticket.sla_paused_at) updateData.sla_paused_at = new Date().toISOString();
    } else {
      const wasPaused = !!ticket.sla_paused_at;
      if (wasPaused) updateData.sla_paused_at = null;
      const pausedMs = wasPaused ? Date.now() - new Date(ticket.sla_paused_at as string).getTime() : 0;

      if (slaDisabledOnColumn) {
        updateData.expected_resolution = null;
      } else if (colSlaHours) {
        updateData.expected_resolution = new Date(Date.now() + colSlaHours * MS_PER_HOUR).toISOString();
        updateData.sla_hours = colSlaHours;
        updateData.sla_breached = false;
      } else if (wasPaused && ticket.expected_resolution && pausedMs > 0) {
        updateData.expected_resolution = new Date(new Date(ticket.expected_resolution).getTime() + pausedMs).toISOString();
      } else if (!ticket.expected_resolution) {
        const fallback = typeof ticket.sla_hours === "number" && ticket.sla_hours > 0 && ticket.sla_hours <= 8760 ? ticket.sla_hours : 24;
        updateData.expected_resolution = new Date(Date.now() + fallback * MS_PER_HOUR).toISOString();
        updateData.sla_hours = fallback;
        updateData.sla_breached = false;
      }
    }

    await this.tickets.update(ticketId, updateData);

    await this.ticketEvents.create({
      ticket_id: ticketId,
      type: "status_change",
      description: `Status alterado de "${oldStatus}" para "${newStatus}"${subStatus ? ` (${subStatus})` : ""}`,
      old_value: oldStatus,
      new_value: newStatus,
      user_email: actor.email,
      user_name: actor.name,
      visible_to_client: true,
      email_sent: false,
    });

    if (ticket.assigned_to && ticket.assigned_to !== actor.email) {
      await this.notifications.create({
        userEmail: ticket.assigned_to,
        type: "status_changed",
        title: `Status alterado: ${ticket.title}`,
        message: `Status mudou de "${oldStatus}" para "${newStatus}"`,
        ticketId,
        ticketTitle: ticket.title,
        actorName: actor.name,
        actorEmail: actor.email,
        priority: "normal",
      });
    }

    const lowerStatus = newStatus.toLowerCase();
    if ((lowerStatus.includes("aguardando") || lowerStatus.includes("pausado")) && ticket.client_email) {
      try {
        await this.mailer.sendPlain({
          to: [ticket.client_email],
          subject: `Ticket #${ticketId.slice(0, 8)} - Aguardando Retorno`,
          body: `Olá ${ticket.client_name || ""},\n\nO ticket #${ticketId.slice(0, 8)} - "${ticket.title}" está aguardando seu retorno.\n\nStatus: ${newStatus}`,
        });
      } catch (error) {
        console.error("[ticket-actions] falha ao enviar email de aguardando retorno:", error);
      }
    }

    let executedRules: string[] = [];
    try {
      executedRules = await this.automation.runForTrigger(
        { ...ticket, ...updateData } as TicketRecord,
        {
          triggerType: "status_changed",
          oldData: { status_column_title: oldStatus },
          newData: { status_column_title: newStatus, status_column_id: columnData?.id },
        }
      );
    } catch (error) {
      console.error("[ticket-actions] falha ao executar regras de automacao:", error);
    }

    return { skipped: false, oldStatus, newStatus, executedRules };
  }
}
