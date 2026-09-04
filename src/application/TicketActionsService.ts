import { KanbanConfigRepository } from "../infrastructure/base44/KanbanConfigRepository";
import { TicketEventRepository } from "../infrastructure/base44/TicketEventRepository";
import { TicketRepository } from "../infrastructure/base44/TicketRepository";
import { TimeEntryRepository } from "../infrastructure/base44/TimeEntryRepository";
import type { TicketRecord } from "../types/entities";
import type { EmailService } from "./EmailService";
import type { NotificationService } from "./NotificationService";
import { TRANSCRIPT_HEADER_PREFIX } from "./smclickTranscript";
import type { TicketAutomationEngine } from "./TicketAutomationEngine";

export interface TicketActor {
  email: string;
  name: string;
}

export type DesignateImplantacaoResult =
  | { status: "linked"; ticketId: string; parentTicketId: string; parentTicketTitle: string }
  | { status: "skipped"; reason: string };

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
    private readonly automation: TicketAutomationEngine,
    private readonly timeEntries: TimeEntryRepository,
    private readonly kanbanConfigs: KanbanConfigRepository
  ) {}

  /**
   * Porta a antiga function `recomputeTicketHours` do Base44 - chamada apos
   * criar/editar/apagar um TimeEntry. Regra unica: TODAS as horas registradas
   * contam (inclusive as do tipo "interna") - mesma regra usada na tela do
   * ticket e nos relatorios, para nunca haver divergencia.
   */
  async recomputeHours(ticketId: string): Promise<{ ticketId: string; totalNormalHours: number; totalExtraHours: number }> {
    if (!ticketId) {
      throw Object.assign(new Error("Campo obrigatorio: ticketId."), { status: 400 });
    }

    const entries = await this.timeEntries.findByTicket(ticketId);
    const totalNormalHours = Math.round(entries.reduce((sum, e) => sum + (e.normal_hours || 0), 0) * 100) / 100;
    const totalExtraHours = Math.round(entries.reduce((sum, e) => sum + (e.extra_hours || 0), 0) * 100) / 100;

    await this.tickets.update(ticketId, { total_normal_hours: totalNormalHours, total_extra_hours: totalExtraHours });

    return { ticketId, totalNormalHours, totalExtraHours };
  }

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

    /**
     * Regra obrigatoria de finalizacao (pedido do usuario em 2026-09-04):
     * ticket vindo do SM Click (WhatsApp) so pode ser fechado depois que o
     * historico da conversa ja foi trazido pro Registro pelo menos uma vez -
     * seja pela sincronizacao automatica (SmclickIntegrationService,
     * TRANSCRIPT_HEADER_PREFIX) ou pelo botao "Buscar conversa do WhatsApp"
     * (ActivityPanel.jsx). Sem isso, um fechamento manual do card no Kanban
     * antes do atendimento terminar no SM Click perderia a conversa pra
     * sempre - ela so fica disponivel via API enquanto o atendimento existe.
     */
    if (isFinal && ticket.external_system === "smclick") {
      const entries = await this.timeEntries.findByTicket(ticketId);
      const hasTranscript = entries.some((e) => typeof e.description === "string" && e.description.startsWith(TRANSCRIPT_HEADER_PREFIX));
      if (!hasTranscript) {
        throw Object.assign(
          new Error('Traga o histórico da conversa do WhatsApp antes de finalizar este ticket (botão "Buscar conversa do WhatsApp" na aba Novo Registro).'),
          { status: 400 }
        );
      }
    }

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

  /**
   * Designa um ticket de Suporte como Implantação e vincula a um ticket de
   * Implantação JA EXISTENTE, escolhido manualmente pelo analista numa busca
   * na tela do Ticket (via parent_ticket_id - o mesmo campo que
   * RelatedTicketsPanel.jsx, no Base44, ja usa de verdade pra "Ticket
   * Pai/Filhos") - pedido do usuario em 2026-09-04. Antes este metodo
   * escolhia sozinho "o ticket de Implantação aberto mais recente do
   * cliente"; o usuario corrigiu no mesmo dia: precisa ser o analista
   * buscando e identificando o ticket certo, nao um auto-pick (podia linkar
   * no projeto errado quando o cliente tem mais de uma Implantação aberta).
   * A busca em si (listar tickets de Implantação do cliente) roda direto no
   * frontend via base44.entities.Ticket.filter - e leitura, mesmo padrao ja
   * usado em todo o app (Tickets.jsx, SearchableSelect etc), so a GRAVACAO
   * passa por aqui. Chamado direto do navegador (botao na tela do Ticket),
   * migrado pra ca em vez de chamadas diretas `base44.entities.*` no
   * frontend, mesmo motivo das outras rotas /public/ticket-actions/*: nao
   * gerar custo de credito de integracao no Base44.
   *
   * A coluna inicial e a de menor `order` (nao-final) do KanbanConfig de
   * Implantação da vertical do ticket - o quadro de Implantação (Tickets.jsx,
   * Base44) escolhe as colunas SO por main_type+vertical, sem depender do
   * ticket_type bater com nada (confirmado direto no codigo em 2026-09-04),
   * entao nao ha risco do ticket ficar orfao so por causa do ticket_type -
   * mesma logica ja usada em SmclickIntegrationService pro lado de Suporte.
   */
  async designateAsImplantacao(ticketId: string, parentTicketId: string, actor: TicketActor): Promise<DesignateImplantacaoResult> {
    const [ticket, parent] = await Promise.all([this.tickets.findById(ticketId), this.tickets.findById(parentTicketId)]);
    if (!ticket) {
      return { status: "skipped", reason: "ticket_nao_encontrado" };
    }
    if (ticket.main_type === "implantacao") {
      return { status: "skipped", reason: "ja_e_implantacao" };
    }
    if (!ticket.client_id) {
      return { status: "skipped", reason: "ticket_sem_cliente" };
    }

    if (!parent || parent.main_type !== "implantacao") {
      return { status: "skipped", reason: "ticket_pai_invalido" };
    }
    if (parent.client_id !== ticket.client_id) {
      return { status: "skipped", reason: "ticket_pai_de_outro_cliente" };
    }

    const configs = await this.kanbanConfigs.findMany({ main_type: "implantacao", vertical: ticket.vertical });
    const config = configs.find((c) => c.active !== false) ?? configs[0];
    const initialColumn = (config?.columns ?? [])
      .filter((c) => !c.is_final)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0];
    if (!initialColumn) {
      return { status: "skipped", reason: "pipeline_implantacao_nao_configurado" };
    }

    await this.tickets.update(ticket.id, {
      main_type: "implantacao",
      ticket_type: parent.ticket_type || ticket.ticket_type,
      status_column_id: initialColumn.title,
      status_column_title: initialColumn.title,
      parent_ticket_id: parent.id,
      parent_ticket_number: parent.ticket_number,
      parent_ticket_title: parent.title,
    });

    await this.ticketEvents.create({
      ticket_id: ticket.id,
      type: "field_change",
      description: `Ticket designado como Implantação e vinculado ao ticket "${parent.title}".`,
      user_email: actor.email,
      user_name: actor.name,
      visible_to_client: false,
    });

    return { status: "linked", ticketId: ticket.id, parentTicketId: parent.id, parentTicketTitle: parent.title };
  }
}
