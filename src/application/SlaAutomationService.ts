import { AutomationRuleRepository } from "../infrastructure/base44/AutomationRuleRepository";
import { KanbanConfigRepository } from "../infrastructure/base44/KanbanConfigRepository";
import { TicketEventRepository } from "../infrastructure/base44/TicketEventRepository";
import { TicketRepository } from "../infrastructure/base44/TicketRepository";
import { UserRepository } from "../infrastructure/base44/UserRepository";
import type { AutomationRuleRecord, TicketRecord, TicketUrgency } from "../types/entities";
import type { EmailService } from "./EmailService";
import type { NotificationService } from "./NotificationService";

export interface SlaAutomationSummary {
  ticketsChecked: number;
  slaWarnings: number;
  timeoutWarnings: number;
}

export interface SlaBreachSummary {
  ticketsChecked: number;
  notified: number;
}

function replaceTokens(text: string, ticket: TicketRecord): string {
  return text
    .replace(/{ticket_title}/g, ticket.title || "")
    .replace(/{client_name}/g, ticket.client_name || "")
    .replace(/{urgency}/g, ticket.urgency || "")
    .replace(/{status}/g, ticket.status_column_title || "")
    .replace(/{assigned_to}/g, ticket.assigned_to_name || "Não atribuído");
}

const URGENCY_LABEL: Record<string, string> = { baixa: "Baixa", media: "Média", alta: "Alta", critica: "CRÍTICA" };

/**
 * Porta as antigas functions `checkSLAAndAutomation` e `checkSLABreached` do
 * Base44 (automacoes agendadas "a cada 30 minutos") - roda aqui via
 * setInterval (ver index.ts, startSlaChecker), sem precisar de nenhuma
 * function no Base44.
 */
export class SlaAutomationService {
  constructor(
    private readonly tickets: TicketRepository,
    private readonly kanbanConfigs: KanbanConfigRepository,
    private readonly automationRules: AutomationRuleRepository,
    private readonly ticketEvents: TicketEventRepository,
    private readonly notifications: NotificationService,
    private readonly users: UserRepository,
    private readonly mailer: EmailService
  ) {}

  /** Colunas que pausam o SLA (pauses_sla ou is_final), chaveadas por vertical|ticket_type|titulo_da_coluna. */
  private async pausingColumnKeys(): Promise<Set<string>> {
    const configs = await this.kanbanConfigs.list();
    const keys = new Set<string>();
    for (const config of configs) {
      for (const col of config.columns || []) {
        if (col.pauses_sla || col.is_final) {
          keys.add(`${config.vertical}|${config.ticket_type}|${col.title}`);
        }
      }
    }
    return keys;
  }

  /** Dispara AutomationRule de sla_warning/no_response_timeout para tickets ativos. */
  async checkSlaAndAutomation(): Promise<SlaAutomationSummary> {
    const tickets = await this.tickets.list();
    const activeTickets = tickets.filter((t) => !t.closed_at);
    const pausingKeys = await this.pausingColumnKeys();

    const slaRules = await this.automationRules.findActiveByTrigger("sla_warning");
    const noResponseRules = await this.automationRules.findActiveByTrigger("no_response_timeout");

    let slaTriggered = 0;
    let timeoutTriggered = 0;

    for (const ticket of activeTickets) {
      const colKey = `${ticket.vertical}|${ticket.ticket_type}|${ticket.status_column_title}`;
      if (pausingKeys.has(colKey)) continue;

      if (ticket.expected_resolution && ticket.sla_hours) {
        const totalSlaMs = ticket.sla_hours * 60 * 60 * 1000;
        const elapsedMs = Date.now() - new Date(ticket.created_date).getTime();
        const percentage = (elapsedMs / totalSlaMs) * 100;

        for (const rule of slaRules) {
          const threshold = rule.trigger_conditions?.sla_percentage ?? 80;
          if (percentage >= threshold && percentage < threshold + 5) {
            await this.executeRuleActions(ticket, rule);
            slaTriggered++;
          }
        }
      }

      const events = await this.ticketEvents.findByTicket(ticket.id);
      const lastEvent = events.reduce<(typeof events)[number] | null>(
        (latest, e) => (!latest || new Date(e.created_date) > new Date(latest.created_date) ? e : latest),
        null
      );
      if (lastEvent) {
        const hoursSinceLastEvent = (Date.now() - new Date(lastEvent.created_date).getTime()) / (1000 * 60 * 60);

        for (const rule of noResponseRules) {
          const threshold = rule.trigger_conditions?.hours_threshold ?? 4;
          if (hoursSinceLastEvent >= threshold && hoursSinceLastEvent < threshold + 0.5) {
            await this.executeRuleActions(ticket, rule);
            timeoutTriggered++;
          }
        }
      }
    }

    return { ticketsChecked: activeTickets.length, slaWarnings: slaTriggered, timeoutWarnings: timeoutTriggered };
  }

  /** Marca tickets com SLA estourado e notifica o responsavel + demais analistas da vertical. */
  async checkSlaBreached(): Promise<SlaBreachSummary> {
    const tickets = await this.tickets.list();
    const activeTickets = tickets.filter((t) => !t.closed_at && t.expected_resolution);
    const pausingKeys = await this.pausingColumnKeys();

    let notified = 0;

    for (const ticket of activeTickets) {
      const expected = new Date(ticket.expected_resolution as string).getTime();
      if (Date.now() <= expected) continue;
      if (ticket.sla_breached) continue;

      const colKey = `${ticket.vertical}|${ticket.ticket_type}|${ticket.status_column_title}`;
      if (pausingKeys.has(colKey)) continue;

      await this.tickets.update(ticket.id, { sla_breached: true });

      const urgLabel = URGENCY_LABEL[ticket.urgency] ?? ticket.urgency;
      const message = `SLA estourado! Ticket "${ticket.title}" | Cliente: ${ticket.client_name || "—"} | Urgência: ${urgLabel} | Previsto para: ${new Date(expected).toLocaleString("pt-BR")}`;

      if (ticket.assigned_to) {
        await this.notifications.create({
          userEmail: ticket.assigned_to,
          type: "sla_warning",
          title: "⏰ SLA Estourado!",
          message,
          ticketId: ticket.id,
          ticketTitle: ticket.title,
          priority: "high",
          actorName: "Sistema",
        });
        notified++;
      }

      if (ticket.vertical) {
        const analysts = await this.users.listInternalByVertical(ticket.vertical, ticket.assigned_to);
        for (const analyst of analysts) {
          await this.notifications.create({
            userEmail: analyst.email,
            type: "sla_warning",
            title: "⏰ SLA Estourado!",
            message,
            ticketId: ticket.id,
            ticketTitle: ticket.title,
            priority: "high",
            actorName: "Sistema",
          });
          notified++;
        }
      }
    }

    return { ticketsChecked: activeTickets.length, notified };
  }

  private async executeRuleActions(ticket: TicketRecord, rule: AutomationRuleRecord): Promise<void> {
    for (const action of rule.actions || []) {
      const params = (action.parameters || {}) as Record<string, string | undefined>;

      switch (action.action_type) {
        case "assign_to_user": {
          if (params.user_email) {
            const users = await this.users.listAll();
            const user = users.find((u) => u.email === params.user_email);
            await this.tickets.update(ticket.id, {
              assigned_to: params.user_email,
              assigned_to_name: user?.full_name || params.user_email,
            });
          }
          break;
        }
        case "send_email": {
          if (params.to_emails && params.subject && params.message) {
            const subject = replaceTokens(params.subject, ticket);
            const body = replaceTokens(params.message, ticket);
            for (const email of params.to_emails.split(",").map((e) => e.trim()).filter(Boolean)) {
              await this.mailer.sendPlain({ to: [email], subject, body });
            }
          }
          break;
        }
        case "send_notification": {
          if (params.to_emails && params.message) {
            const message = replaceTokens(params.message, ticket);
            for (const email of params.to_emails.split(",").map((e) => e.trim()).filter(Boolean)) {
              await this.notifications.create({
                userEmail: email,
                type: "sla_warning",
                title: "Alerta de SLA",
                message,
                ticketId: ticket.id,
                ticketTitle: ticket.title,
                priority: "high",
                actorName: "Sistema de Automação",
                actorEmail: "system@automation",
              });
            }
          }
          break;
        }
        case "change_urgency": {
          if (params.urgency) {
            await this.tickets.update(ticket.id, { urgency: params.urgency as TicketUrgency });
          }
          break;
        }
      }
    }

    await this.automationRules.update(rule.id, {
      execution_count: (rule.execution_count || 0) + 1,
      last_executed_at: new Date().toISOString(),
    });
  }
}
