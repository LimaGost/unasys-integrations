import { AutomationRuleRepository } from "../infrastructure/base44/AutomationRuleRepository";
import { TicketEventRepository } from "../infrastructure/base44/TicketEventRepository";
import { TicketRepository } from "../infrastructure/base44/TicketRepository";
import { UserRepository } from "../infrastructure/base44/UserRepository";
import type { AutomationAction, AutomationRuleRecord, AutomationTriggerType, TicketRecord, TicketUrgency } from "../types/entities";
import type { EmailService } from "./EmailService";
import type { NotificationService } from "./NotificationService";

export interface TicketChangeEvent {
  triggerType: Extract<AutomationTriggerType, "ticket_created" | "status_changed" | "assignment_changed" | "urgency_changed">;
  oldData?: Record<string, unknown>;
  newData?: Record<string, unknown>;
}

const SYSTEM_ACTOR = { email: "sistema@automacao", name: "Sistema de Automação" };

function replaceTokens(text: string, ticket: TicketRecord): string {
  return text
    .replace(/{ticket_title}/g, ticket.title || "")
    .replace(/{ticket_number}/g, String(ticket.ticket_number ?? ""))
    .replace(/{client_name}/g, ticket.client_name || "")
    .replace(/{urgency}/g, ticket.urgency || "")
    .replace(/{status}/g, ticket.status_column_title || "")
    .replace(/{assigned_to}/g, ticket.assigned_to_name || "Não atribuído")
    .replace(/{vertical}/g, ticket.vertical || "");
}

function conditionsMatch(rule: AutomationRuleRecord, ticket: TicketRecord, event: TicketChangeEvent): boolean {
  const conditions = rule.trigger_conditions || {};

  if (conditions.main_type && ticket.main_type !== conditions.main_type) return false;
  if (conditions.ticket_type && ticket.ticket_type !== conditions.ticket_type) return false;
  if (conditions.urgency && ticket.urgency !== conditions.urgency) return false;

  if (event.triggerType === "status_changed") {
    if (conditions.from_status_id && event.oldData?.status_column_id !== conditions.from_status_id) return false;
    if (conditions.from_status && event.oldData?.status_column_title !== conditions.from_status) return false;
    if (conditions.to_status_id && event.newData?.status_column_id !== conditions.to_status_id) return false;
    if (conditions.to_status && event.newData?.status_column_title !== conditions.to_status) return false;
  }

  return true;
}

/**
 * Porta a logica da antiga function `executeAutomationRules` do Base44 para os
 * gatilhos de ciclo de vida do ticket (criacao, mudanca de status, de
 * responsavel, de urgencia) - disparada por TicketActionsService. Gatilhos de
 * SLA (sla_warning/no_response_timeout) continuam em SlaAutomationService, que
 * ja roda em producao e usa uma logica de correspondencia diferente (por
 * percentual/horas, nao por igualdade de campo).
 */
export class TicketAutomationEngine {
  constructor(
    private readonly tickets: TicketRepository,
    private readonly ticketEvents: TicketEventRepository,
    private readonly automationRules: AutomationRuleRepository,
    private readonly notifications: NotificationService,
    private readonly mailer: EmailService,
    private readonly users: UserRepository
  ) {}

  async runForTrigger(ticket: TicketRecord, event: TicketChangeEvent): Promise<string[]> {
    const rules = await this.automationRules.findActiveByTrigger(event.triggerType, ticket.vertical);
    const executedRuleNames: string[] = [];

    for (const rule of rules) {
      if (!conditionsMatch(rule, ticket, event)) continue;

      for (const action of rule.actions || []) {
        try {
          await this.executeAction(ticket, action);
        } catch (error) {
          console.error(`[automation] erro executando acao "${action.action_type}" da regra "${rule.name}":`, error);
        }
      }

      await this.automationRules.update(rule.id, {
        execution_count: (rule.execution_count || 0) + 1,
        last_executed_at: new Date().toISOString(),
      });

      executedRuleNames.push(rule.name);
    }

    return executedRuleNames;
  }

  private async executeAction(ticket: TicketRecord, action: AutomationAction): Promise<void> {
    const params = (action.parameters || {}) as Record<string, string | undefined>;

    switch (action.action_type) {
      case "assign_to_user": {
        if (!params.user_email) break;
        const users = await this.users.listAll();
        const user = users.find((u) => u.email === params.user_email);
        await this.tickets.update(ticket.id, {
          assigned_to: params.user_email,
          assigned_to_name: user?.full_name || params.user_email,
        });
        await this.ticketEvents.create({
          ticket_id: ticket.id,
          type: "assignment",
          description: `Ticket atribuído automaticamente para ${user?.full_name || params.user_email}`,
          new_value: params.user_email,
          user_email: SYSTEM_ACTOR.email,
          user_name: SYSTEM_ACTOR.name,
          visible_to_client: false,
        });
        break;
      }

      case "change_status": {
        if (!params.status_column_id) break;
        await this.tickets.update(ticket.id, {
          status_column_id: params.status_column_id,
          status_column_title: params.status_column_title,
        });
        await this.ticketEvents.create({
          ticket_id: ticket.id,
          type: "status_change",
          description: `Status alterado automaticamente para ${params.status_column_title}`,
          old_value: ticket.status_column_title,
          new_value: params.status_column_title,
          user_email: SYSTEM_ACTOR.email,
          user_name: SYSTEM_ACTOR.name,
          visible_to_client: true,
        });
        break;
      }

      case "send_email": {
        if (!params.to_emails || !params.subject || !params.message) break;
        const subject = replaceTokens(params.subject, ticket);
        const body = replaceTokens(params.message, ticket);
        for (const email of params.to_emails.split(",").map((e) => e.trim()).filter(Boolean)) {
          await this.mailer.sendPlain({ to: [email], subject, body });
        }
        break;
      }

      case "send_notification": {
        if (!params.to_emails || !params.message) break;
        const message = replaceTokens(params.message, ticket);
        for (const email of params.to_emails.split(",").map((e) => e.trim()).filter(Boolean)) {
          await this.notifications.create({
            userEmail: email,
            ticketId: ticket.id,
            ticketTitle: ticket.title,
            type: "ticket_created",
            title: "Regra de Automação",
            message,
            priority: "normal",
            actorName: SYSTEM_ACTOR.name,
            actorEmail: SYSTEM_ACTOR.email,
          });
        }
        break;
      }

      case "change_urgency": {
        if (!params.urgency) break;
        await this.tickets.update(ticket.id, { urgency: params.urgency as TicketUrgency });
        await this.ticketEvents.create({
          ticket_id: ticket.id,
          type: "field_change",
          description: `Urgência alterada automaticamente para ${params.urgency}`,
          old_value: ticket.urgency,
          new_value: params.urgency,
          user_email: SYSTEM_ACTOR.email,
          user_name: SYSTEM_ACTOR.name,
          visible_to_client: false,
        });
        break;
      }

      case "add_comment": {
        if (!params.comment) break;
        const comment = replaceTokens(params.comment, ticket);
        await this.ticketEvents.create({
          ticket_id: ticket.id,
          type: "comment_internal",
          description: comment,
          user_email: SYSTEM_ACTOR.email,
          user_name: SYSTEM_ACTOR.name,
          visible_to_client: false,
        });
        break;
      }
    }
  }
}
