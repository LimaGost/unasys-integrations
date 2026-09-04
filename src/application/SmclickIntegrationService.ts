import { ClientRepository } from "../infrastructure/base44/ClientRepository";
import { KanbanConfigRepository } from "../infrastructure/base44/KanbanConfigRepository";
import { TicketEventRepository } from "../infrastructure/base44/TicketEventRepository";
import { TicketRepository } from "../infrastructure/base44/TicketRepository";
import { TimeEntryRepository } from "../infrastructure/base44/TimeEntryRepository";
import type { SmclickApiClient } from "../infrastructure/smclick/SmclickApiClient";
import type { ClientRecord, KanbanColumn, TicketRecord } from "../types/entities";
import { buildTranscript, formatDateSaoPaulo, formatTimeSaoPaulo } from "./smclickTranscript";
import type { TicketActionsService } from "./TicketActionsService";
import type { TicketCreationHooks } from "./TicketCreationHooks";

export interface SmclickAttendant {
  id?: string;
  name?: string;
  email?: string;
  principal?: boolean;
}

export interface SmclickChat {
  id?: string;
  protocol?: number;
  department?: { id?: string; name?: string };
  contact?: { name?: string; telephone?: string };
  attendant?: SmclickAttendant[];
  /** Segundos de atendimento ATIVO (nao conta fila de espera) - vem no payload do evento chat-finished. */
  attending_time?: number;
}

/** O atendente marcado `principal` (responsavel), ou o primeiro da lista se nenhum estiver marcado. */
function resolvePrincipalAttendant(chat: SmclickChat): SmclickAttendant | undefined {
  const attendants = chat.attendant ?? [];
  return attendants.find((a) => a.principal) ?? attendants[0];
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
 * Porta as integracoes com a SM Click (atendimento via WhatsApp): o Ticket
 * nasce sozinho quando um atendente de fato assume a conversa (evento
 * `chat-started`) e, quando o atendimento termina la (evento
 * `chat-finished`), o ticket e fechado E o historico completo da conversa e
 * anexado como um Registro (TimeEntry) no campo "Relato da Atividade" -
 * pedido do usuario em 2026-09-04 pra nao precisar abrir o WhatsApp pra ver
 * o que foi falado com o cliente. Chamado por routes/smclickWebhook.ts.
 *
 * O gatilho de criacao e `chat-started` (estagio "ATIVO" na SM Click), NAO
 * `new-chat` (estagio "LEADS"/triagem) nem a espera na fila (estagio
 * "AGUARDANDO") - decisao confirmada com o usuario em 2026-09-04: um
 * atendimento so "comeca de verdade" quando alguem inicia ele, senao toda
 * mensagem recebida (inclusive de leads que nunca viram atendimento de
 * verdade) geraria um ticket.
 *
 * Unica chamada de SAIDA pra API da SM Click ate agora: buscar mensagens
 * (`SmclickApiClient.getChatMessages`), pra montar o transcript. Enviar
 * mensagem de volta pro cliente (fechar o ciclo) ainda e trabalho futuro.
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

  /** Mesma logica da trava acima, mas pro `chat-finished` - evita fechar/anexar transcript em dobro numa reentrega. */
  private readonly chatsBeingFinished = new Set<string>();

  constructor(
    private readonly tickets: TicketRepository,
    private readonly ticketEvents: TicketEventRepository,
    private readonly clients: ClientRepository,
    private readonly kanbanConfigs: KanbanConfigRepository,
    private readonly timeEntries: TimeEntryRepository,
    private readonly smclickApi: SmclickApiClient,
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
      const attendant = resolvePrincipalAttendant(chat);

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
        // Email do atendente da SM Click bate com o email do analista no Unasys
        // Tickets (mesmo dominio @franqueadolinx.com.br, confirmado em 2026-09-04) -
        // sem precisar de nenhum mapeamento manual entre os dois sistemas.
        assigned_to: attendant?.email,
        assigned_to_name: attendant?.name,
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

    if (this.chatsBeingFinished.has(chat.id)) {
      return { status: "skipped", reason: "fechamento_em_andamento" };
    }
    this.chatsBeingFinished.add(chat.id);

    try {
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

      // Best-effort: o fechamento do ticket ja aconteceu (acima) e e o que
      // importa pra SM Click - se o transcript falhar (API fora do ar, etc),
      // so loga e reporta "closed" do mesmo jeito, sem fazer a SM Click
      // reenviar o webhook achando que o fechamento falhou.
      try {
        await this.attachConversationTranscript(ticket, chat);
      } catch (error) {
        console.error(`[smclick] falha ao anexar transcript da conversa (ticket ${ticket.id}):`, error);
      }

      return { status: "closed", ticketId: ticket.id };
    } finally {
      this.chatsBeingFinished.delete(chat.id);
    }
  }

  /**
   * Busca o historico de mensagens do atendimento na API da SM Click e cria
   * um Registro (TimeEntry) no Ticket com a conversa no campo "Relato da
   * Atividade" - pedido do usuario em 2026-09-04 pra dar visibilidade
   * completa do que foi falado com o cliente, sem precisar abrir o WhatsApp.
   *
   * As horas do Registro vem de `chat.attending_time` (segundos de
   * atendimento ATIVO que a propria SM Click calcula e manda no payload do
   * chat-finished - NAO conta tempo de fila/espera do cliente) - e o
   * Registro fica atribuido ao email do atendente principal da SM Click, que
   * bate com o email do analista no Unasys Tickets (mesmo dominio
   * @franqueadolinx.com.br). Pedido explicito do usuario em 2026-09-04: essas
   * horas TEM que contar nos relatorios do analista, por isso hour_type e
   * "normal" (nao "interna") e normal_hours reflete o attending_time real.
   */
  private async attachConversationTranscript(ticket: TicketRecord, chat: SmclickChat): Promise<void> {
    if (!chat.protocol) return;

    const messages = await this.smclickApi.getChatMessages(chat.protocol);
    const transcript = buildTranscript(messages, ticket.client_name || chat.contact?.name || "Cliente");
    if (!transcript.firstMessageAt || !transcript.lastMessageAt) return;

    const attendant = resolvePrincipalAttendant(chat);
    const attendingHours = this.sanitizeAttendingHours(chat.attending_time, ticket.id);

    await this.timeEntries.create({
      ticket_id: ticket.id,
      ticket_title: ticket.title,
      date: formatDateSaoPaulo(transcript.firstMessageAt),
      start_time: formatTimeSaoPaulo(transcript.firstMessageAt),
      end_time: formatTimeSaoPaulo(transcript.lastMessageAt),
      description: transcript.html,
      hour_type: "normal",
      normal_hours: attendingHours,
      extra_hours: 0,
      notify_client: false,
      technician_email: attendant?.email || this.serviceEmail,
      technician_name: attendant?.name || "SM Click (automático)",
    });

    await this.ticketEvents.create({
      ticket_id: ticket.id,
      type: "field_change",
      description: "Histórico da conversa do WhatsApp (SM Click) anexado automaticamente ao ticket.",
      user_email: this.serviceEmail,
      visible_to_client: false,
    });

    // Sem isto, total_normal_hours do ticket nao reflete o Registro recem-criado
    // (create de TimeEntry nao recalcula sozinho - ver TicketActionsService.recomputeHours).
    await this.ticketActions.recomputeHours(ticket.id);
  }

  /**
   * Converte attending_time (segundos) em horas, descartando valores
   * implausiveis (>24h de atendimento ATIVO num unico chat e sinal de
   * unidade errada ou bug do lado da SM Click, nao de trabalho de verdade) -
   * mesmo espirito do guard de sla_hours em TicketActionsService.updateStatus:
   * nao grava as horas do analista as cegas, se o numero nao faz sentido.
   */
  private sanitizeAttendingHours(attendingTimeSeconds: number | undefined, ticketId: string): number {
    const hours = (attendingTimeSeconds ?? 0) / 3600;
    if (hours <= 0) return 0;
    if (hours > 24) {
      console.error(`[smclick] attending_time implausivel (${attendingTimeSeconds}s = ${hours}h) pro ticket ${ticketId} - gravando 0h em vez disso.`);
      return 0;
    }
    return Math.round(hours * 100) / 100;
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
