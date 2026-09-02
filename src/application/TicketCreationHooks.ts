import { ClientRepository } from "../infrastructure/base44/ClientRepository";
import { UserRepository } from "../infrastructure/base44/UserRepository";
import type { TicketRecord } from "../types/entities";
import type { NotificationService } from "./NotificationService";

const URGENCY_LABEL: Record<string, string> = { baixa: "Baixa", media: "Média", alta: "Alta", critica: "🚨 CRÍTICA" };

/**
 * Porta a logica das antigas automacoes de plataforma do Base44
 * `onTicketCreated` (parte de notificacao) e `criarClienteAoNovoTicket` -
 * diferente das outras functions ja migradas, essas duas NAO eram chamadas
 * pelo frontend: eram gatilhos configurados nas "Automacoes" do proprio
 * Base44, disparados sozinhos sempre que um Ticket era criado (confirmado
 * pelo usuario no editor do Base44 em 2026-09-02). Por isso este servico
 * PRECISA chamar `afterTicketCreated` explicitamente logo apos criar um
 * Ticket (ja feito em routes/salesData.ts e routes/externalTickets.ts) - e o
 * Base44 precisa ter essas 2 automacoes DESATIVADAS la, senao roda em
 * dobro (notificacao duplicada para os analistas).
 *
 * NAO portado ainda: `criarClienteImplantacaoAposClient` e
 * `atualizarProgressoImplantacao` - dependem da familia de entities de
 * Implantacao (ClienteImplantacao, EtapaImplantacao, ItemChecklist,
 * ProgressoItem) que ainda nao existe neste servico. NAO desative essas
 * duas automacoes no Base44 ate que sejam migradas de verdade.
 */
export class TicketCreationHooks {
  constructor(
    private readonly clients: ClientRepository,
    private readonly notifications: NotificationService,
    private readonly users: UserRepository
  ) {}

  async afterTicketCreated(ticket: TicketRecord): Promise<void> {
    try {
      await this.ensureClientExists(ticket);
    } catch (error) {
      console.error("[ticket-creation-hooks] falha ao garantir Client do ticket:", error);
    }

    try {
      await this.notifyVerticalAnalysts(ticket);
    } catch (error) {
      console.error("[ticket-creation-hooks] falha ao notificar analistas da vertical:", error);
    }
  }

  /** Porta `criarClienteAoNovoTicket`: garante que existe um Client correspondente ao email do solicitante. */
  private async ensureClientExists(ticket: TicketRecord): Promise<void> {
    if (!ticket.client_email || !ticket.client_name || !ticket.vertical) return;

    await this.clients.findOrCreate(
      { email: ticket.client_email },
      {
        nome_fantasia: ticket.client_name,
        razao_social: ticket.client_name,
        email: ticket.client_email,
        telefone: undefined,
        vertical: ticket.vertical,
        active: true,
      }
    );
  }

  /** Porta a parte de notificacao de `onTicketCreated`: avisa os analistas internos da vertical do ticket. */
  private async notifyVerticalAnalysts(ticket: TicketRecord): Promise<void> {
    if (!ticket.vertical) return;

    const analysts = await this.users.listInternalByVertical(ticket.vertical);
    const tipoLabel = ticket.main_type === "implantacao" ? "Implantação" : "Suporte";
    const urgLabel = URGENCY_LABEL[ticket.urgency] ?? ticket.urgency;

    for (const analyst of analysts) {
      if (!analyst.email) continue;
      await this.notifications.create({
        userEmail: analyst.email,
        type: "ticket_created",
        title: `Novo ticket de ${tipoLabel}`,
        message: `"${ticket.title}" | Cliente: ${ticket.client_name || "—"} | Urgência: ${urgLabel}`,
        ticketId: ticket.id,
        ticketTitle: ticket.title,
        priority: ticket.urgency === "critica" || ticket.urgency === "alta" ? "high" : "normal",
        actorName: ticket.client_name || "Cliente",
      });
    }
  }
}
