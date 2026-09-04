import { ClientRepository } from "../infrastructure/base44/ClientRepository";
import { KanbanConfigRepository } from "../infrastructure/base44/KanbanConfigRepository";
import { TicketEventRepository } from "../infrastructure/base44/TicketEventRepository";
import { TicketRepository } from "../infrastructure/base44/TicketRepository";
import type { ClientRecord, KanbanColumn, TicketRecord } from "../types/entities";
import type { TicketActionsService } from "./TicketActionsService";
import type { TicketCreationHooks } from "./TicketCreationHooks";

export interface SmclickChat {
  id?: string;
  protocol?: number;
  department?: { id?: string; name?: string };
  contact?: { name?: string; telephone?: string };
}

export type SmclickEventResult =
  | { status: "created"; ticketId: string }
  | { status: "closed"; ticketId: string }
  | { status: "skipped"; reason: string };

/**
 * Departamento SM Click -> (vertical, ticket_type) do Unasys Tickets. O
 * ticket_type PRECISA bater exatamente com um KanbanConfig
 * (main_type=suporte) real no Base44, senao o Ticket criado fica orfao -
 * existe no banco mas nao aparece em nenhuma coluna do quadro (foi exatamente
 * o que aconteceu no primeiro teste real, em 2026-09-04: ticket_type
 * "Suporte" generico nao batia com nenhum KanbanConfig configurado).
 * Confirmado direto no Base44 (entity KanbanConfig) nesta mesma data:
 *   - retail -> "SUPORTE RETAIL" (unico tipo generico de atendimento la)
 *   - food   -> "Suporte - Food" (idem)
 *   - farma  -> NAO tem tipo generico ainda, so "Consultoria" - usado aqui a
 *               pedido do usuario ate existir um tipo dedicado
 * "Degust" nao tem codigo de vertical proprio no Base44 (ver
 * VALID_VERTICAL_CODES em services/base44Entities.ts); mapeado para "food".
 * Se um novo departamento for criado na SM Click, ou um KanbanConfig for
 * renomeado no Base44, atualize aqui - senao os atendimentos caem em
 * "departamento_nao_mapeado" ou "coluna_inicial_nao_configurada" e NENHUM
 * ticket e criado (ver handleChatStarted).
 */
const DEPARTMENT_TICKET_TYPE: Record<string, { vertical: string; ticketType: string }> = {
  "3f3e80af-691b-4808-9863-fabb4cf8074b": { vertical: "retail", ticketType: "SUPORTE RETAIL" }, // Retail
  "2692b4df-7ff7-4749-9388-b21bdf2849a0": { vertical: "food", ticketType: "Suporte - Food" }, // Degust
  "943fdfc9-5377-4422-8880-58c3f849f96d": { vertical: "farma", ticketType: "Consultoria" }, // Farma
};

/**
 * Porta as duas primeiras integracoes com a SM Click (atendimento via
 * WhatsApp): o Ticket nasce sozinho quando um atendente de fato assume a
 * conversa (evento `chat-started`) e fecha sozinho quando o atendimento
 * termina la (evento `chat-finished`). Chamado por routes/smclickWebhook.ts.
 *
 * O gatilho de criacao e `chat-started` (estagio "ATIVO" na SM Click), NAO
 * `new-chat` (estagio "LEADS"/triagem) nem a espera na fila (estagio
 * "AGUARDANDO") - decisao confirmada com o usuario em 2026-09-04: um
 * atendimento so "comeca de verdade" quando alguem inicia ele, senao toda
 * mensagem recebida (inclusive de leads que nunca viram atendimento de
 * verdade) geraria um ticket.
 *
 * NAO faz nenhuma chamada de volta pra API da SM Click (enviar mensagem,
 * etc.) - so recebe os dois eventos. Isso e trabalho futuro (ver conversa
 * sobre "fechar o ciclo" avisando o cliente pelo WhatsApp).
 */
export class SmclickIntegrationService {
  /**
   * Trava em memoria contra duas entregas do mesmo evento `chat-started`
   * chegando quase juntas (retry da SM Click, ou o mesmo evento reenviado):
   * sem isto, as duas passariam pelo `findOne` antes de qualquer uma ter
   * criado o Ticket, e as duas criariam um Ticket (e possivelmente um
   * Client) duplicado. So protege dentro deste processo - suficiente aqui
   * porque este servico roda como uma unica instancia (ver index.ts).
   */
  private readonly chatsBeingCreated = new Set<string>();

  constructor(
    private readonly tickets: TicketRepository,
    private readonly ticketEvents: TicketEventRepository,
    private readonly clients: ClientRepository,
    private readonly kanbanConfigs: KanbanConfigRepository,
    private readonly ticketActions: TicketActionsService,
    private readonly ticketCreationHooks: TicketCreationHooks,
    private readonly serviceEmail: string
  ) {}

  async handleChatStarted(chat: SmclickChat): Promise<SmclickEventResult> {
    if (!chat.id || !chat.contact?.telephone) {
      return { status: "skipped", reason: "payload_incompleto" };
    }

    if (this.chatsBeingCreated.has(chat.id)) {
      return { status: "skipped", reason: "criacao_em_andamento" };
    }
    this.chatsBeingCreated.add(chat.id);

    try {
      // Protecao contra reentrega do webhook (comum em integracoes desse tipo):
      // sem isto, um retry da SM Click criaria um segundo Ticket pro mesmo chat.
      const existing = await this.tickets.findOne({ external_reference: chat.id });
      if (existing) {
        return { status: "skipped", reason: "ticket_ja_existe" };
      }

      const mapping = chat.department?.id ? DEPARTMENT_TICKET_TYPE[chat.department.id] : undefined;
      if (!mapping) {
        return { status: "skipped", reason: `departamento_nao_mapeado:${chat.department?.id ?? chat.department?.name ?? "?"}` };
      }
      const { vertical, ticketType } = mapping;

      const initialColumn = await this.findInitialColumn(vertical, ticketType);
      if (!initialColumn) {
        // Nao adivinha um titulo de coluna (ver findFinalColumn) - sem uma
        // coluna configurada pra essa combinacao de vertical/tipo no Base44,
        // nao cria o ticket (ele ficaria orfao, sem aparecer no quadro).
        return { status: "skipped", reason: `coluna_inicial_nao_configurada:${vertical}/${ticketType}` };
      }

      const contactName = chat.contact.name || chat.contact.telephone;
      const client = await this.findOrCreateClientByPhone(chat.contact.telephone, contactName, vertical);

      const ticket = await this.tickets.create({
        title: `Atendimento WhatsApp - ${contactName}`,
        main_type: "suporte",
        client_id: client.id,
        client_name: client.nome_fantasia,
        client_email: client.email,
        vertical,
        urgency: "media",
        ticket_type: ticketType,
        requester: contactName,
        description: `Ticket criado automaticamente a partir de um novo atendimento no WhatsApp (SM Click), protocolo #${chat.protocol ?? "?"}.`,
        external_system: "smclick",
        external_reference: chat.id,
        external_customer_code: chat.protocol ? String(chat.protocol) : undefined,
        // Coluna real do KanbanConfig (nao um valor fixo) - ver findInitialColumn.
        status_column_id: initialColumn.title,
        status_column_title: initialColumn.title,
      });

      await this.ticketEvents.create({
        ticket_id: ticket.id,
        type: "creation",
        description: `Ticket criado automaticamente via SM Click (novo atendimento no WhatsApp, protocolo #${chat.protocol ?? "?"}).`,
        user_email: this.serviceEmail,
        visible_to_client: false,
      });

      await this.ticketCreationHooks.afterTicketCreated(ticket);

      return { status: "created", ticketId: ticket.id };
    } finally {
      this.chatsBeingCreated.delete(chat.id);
    }
  }

  async handleChatFinished(chat: SmclickChat): Promise<SmclickEventResult> {
    if (!chat.id) {
      return { status: "skipped", reason: "payload_incompleto" };
    }

    const ticket = await this.tickets.findOne({ external_reference: chat.id });
    if (!ticket) {
      return { status: "skipped", reason: "ticket_nao_encontrado" };
    }
    if (ticket.closed_at) {
      return { status: "skipped", reason: "ticket_ja_fechado" };
    }

    const finalColumn = await this.findFinalColumn(ticket);
    if (!finalColumn) {
      // Nao adivinha um titulo de coluna: sem uma coluna is_final configurada
      // pra essa combinacao de vertical/tipo, o ticket fica aberto mesmo (mais
      // seguro do que fechar numa coluna que nao existe pra esse quadro).
      return { status: "skipped", reason: "coluna_final_nao_configurada" };
    }

    const result = await this.ticketActions.updateStatus(
      {
        ticketId: ticket.id,
        newStatus: finalColumn.title,
        columnData: {
          id: finalColumn.title,
          is_final: true,
          pauses_sla: finalColumn.pauses_sla,
          sla_hours: finalColumn.sla_hours,
        },
      },
      { email: this.serviceEmail, name: "SM Click (automatico)" }
    );

    // updateStatus pula silenciosamente (sem tocar closed_at) quando o titulo
    // atual ja bate com o da coluna final - nao reportar "closed" nesse caso,
    // senao a SM Click acha que fechou e o ticket continua aberto de verdade.
    if (result.skipped) {
      return { status: "skipped", reason: `update_status_pulou:${result.reason}` };
    }

    return { status: "closed", ticketId: ticket.id };
  }

  private async findOrCreateClientByPhone(telefone: string, name: string, vertical: string): Promise<ClientRecord> {
    const existing = await this.clients.findOne({ telefone });
    if (existing) return existing;

    return this.clients.create({
      nome_fantasia: name,
      razao_social: name,
      telefone,
      vertical,
      status: "novo_cliente",
      active: true,
    });
  }

  private async findFinalColumn(ticket: TicketRecord): Promise<KanbanColumn | null> {
    const columns = await this.findColumns(ticket.vertical, ticket.ticket_type ?? "", ticket.main_type);
    return columns.find((col) => col.is_final) ?? null;
  }

  /** Coluna de menor `order` que nao seja final - onde um Ticket novo deve entrar. */
  private async findInitialColumn(vertical: string, ticketType: string): Promise<KanbanColumn | null> {
    const columns = await this.findColumns(vertical, ticketType, "suporte");
    const nonFinal = columns.filter((col) => !col.is_final);
    if (nonFinal.length === 0) return null;
    return nonFinal.reduce((lowest, col) => ((col.order ?? 0) < (lowest.order ?? 0) ? col : lowest));
  }

  private async findColumns(vertical: string, ticketType: string, mainType: string): Promise<KanbanColumn[]> {
    const config = await this.kanbanConfigs.findOne({ main_type: mainType, vertical, ticket_type: ticketType });
    return config?.columns ?? [];
  }
}
