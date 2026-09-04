import { env } from "../config/env";
import { ClientRepository } from "../infrastructure/base44/ClientRepository";
import { KanbanConfigRepository } from "../infrastructure/base44/KanbanConfigRepository";
import { TicketEventRepository } from "../infrastructure/base44/TicketEventRepository";
import { TicketRepository } from "../infrastructure/base44/TicketRepository";
import { TimeEntryRepository } from "../infrastructure/base44/TimeEntryRepository";
import { renderChatImage } from "../infrastructure/rendering/ChatImageRenderer";
import type { SmclickApiClient, SmclickAttendant } from "../infrastructure/smclick/SmclickApiClient";
import { saveNamedFile } from "../services/uploadStorage";
import type { ClientRecord, KanbanColumn, TicketRecord } from "../types/entities";
import {
  buildTranscriptDescriptionHtml,
  formatDateSaoPaulo,
  formatTimeSaoPaulo,
  resolveTranscriptMessages,
  TRANSCRIPT_HEADER_PREFIX,
  type ResolvedTranscript,
} from "./smclickTranscript";
import type { TicketActionsService } from "./TicketActionsService";
import type { TicketCreationHooks } from "./TicketCreationHooks";

interface TranscriptContent {
  html: string;
  firstMessageAt: Date;
  lastMessageAt: Date;
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

/**
 * O atendente marcado `principal` (responsavel), ou o primeiro da lista se
 * nenhum estiver marcado. Aceita tanto o payload de um webhook (SmclickChat)
 * quanto o retrato ao vivo vindo de SmclickApiClient.getChatByProtocol
 * (SmclickChatDetails) - so precisa do campo `attendant`.
 */
function resolvePrincipalAttendant(chat: { attendant?: SmclickAttendant[] }): SmclickAttendant | undefined {
  const attendants = chat.attendant ?? [];
  return attendants.find((a) => a.principal) ?? attendants[0];
}

export type SmclickEventResult =
  | { status: "created"; ticketId: string }
  | { status: "closed"; ticketId: string }
  | { status: "synced"; ticketId: string }
  | { status: "skipped"; reason: string };

/** Intervalo minimo entre sincronizacoes ao vivo do transcript pro mesmo chat - evita bater na API da SM Click e no Base44 a cada mensagem isolada. */
const MIN_LIVE_SYNC_INTERVAL_MS = 45_000;

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

  /** Timestamp (Date.now()) da ultima sincronizacao ao vivo do transcript, por chat.id - ver handleNewChatMessage. */
  private readonly lastLiveSyncAt = new Map<string, number>();

  /**
   * Fila de execucao por Ticket, pra serializar as 3 formas de escrever o
   * Registro de transcript (webhook ao vivo, chat-finished definitivo, botao
   * sob demanda) - sem isto, duas dessas rodando quase juntas pro mesmo
   * ticket podiam ou duplicar o Registro (as duas veem "nao existe ainda" ao
   * mesmo tempo) ou, pior, uma sincronizacao "ao vivo" (0h) sobrescrever a
   * versao definitiva (hora real) que acabou de ser gravada - achado real de
   * code-review em 2026-09-04. Ver withTranscriptLock/upsertTranscriptEntry.
   */
  private readonly transcriptLocks = new Map<string, Promise<void>>();

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

      // Chat encerrado - nao ha mais o que sincronizar ao vivo pra ele
      // (handleNewChatMessage so age em tickets ainda abertos, ver acima),
      // entao esse chat.id nunca mais vai ser reescrito aqui. Sem isto,
      // lastLiveSyncAt cresceria sem limite (uma entrada por conversa da
      // SM Click, pra sempre, ja que este servico roda como processo unico
      // e nunca reinicia sozinho).
      this.lastLiveSyncAt.delete(chat.id);

      return { status: "closed", ticketId: ticket.id };
    } finally {
      this.chatsBeingFinished.delete(chat.id);
    }
  }

  /**
   * Sincroniza o transcript da conversa ANTES do atendimento finalizar -
   * pedido do usuario em 2026-09-04 ("trazer o historico sem finalizar").
   * Atualiza o mesmo Registro "ao vivo" a cada mensagem nova (identificado
   * pelo TRANSCRIPT_HEADER_PREFIX - ver upsertTranscriptEntry), sem lancar
   * hora nenhuma ainda (attending_time so fica definitivo no chat-finished -
   * ver attachConversationTranscript). Debounced por chat (
   * MIN_LIVE_SYNC_INTERVAL_MS) pra nao bater na API da SM Click e no Base44
   * a cada mensagem isolada de uma conversa movimentada.
   */
  async handleNewChatMessage(chat: SmclickChat): Promise<SmclickEventResult> {
    if (!chat.id) {
      return { status: "skipped", reason: "payload_incompleto" };
    }

    const lastSync = this.lastLiveSyncAt.get(chat.id);
    if (lastSync !== undefined && Date.now() - lastSync < MIN_LIVE_SYNC_INTERVAL_MS) {
      return { status: "skipped", reason: "sincronizado_recentemente" };
    }
    // Marca ANTES de qualquer consulta - inclusive mensagens trocadas durante
    // a triagem do bot (antes do Ticket existir) ficam rate-limited, nao so
    // as que acham um ticket.
    this.recordLiveSync(chat.id);

    if (!chat.protocol) {
      return { status: "skipped", reason: "payload_incompleto" };
    }

    const ticket = await this.tickets.findOne({ external_reference: chat.id });
    if (!ticket) {
      return { status: "skipped", reason: "ticket_nao_encontrado" };
    }
    if (ticket.closed_at) {
      // Ja finalizado - a versao definitiva (com hora real) ja foi anexada
      // por handleChatFinished, nao ha nada pra sincronizar aqui.
      return { status: "skipped", reason: "ticket_ja_fechado" };
    }

    try {
      const messages = await this.smclickApi.getChatMessages(chat.protocol);
      const resolved = resolveTranscriptMessages(messages, ticket.client_name || chat.contact?.name || "Cliente");
      if (!resolved.firstMessageAt || !resolved.lastMessageAt) {
        return { status: "skipped", reason: "sem_mensagens" };
      }
      const content = await this.renderTranscriptContent(ticket.id, resolved, false);

      // upsertTranscriptEntry serializa por ticket e releem o estado mais
      // recente antes de gravar - protege contra um chat-finished (ou o
      // botao sob demanda) rodando quase junto pro mesmo chat. Se retornar
      // false, a versao definitiva ja chegou primeiro - nao reportar
      // "synced" quando na verdade nada foi escrito.
      const attendant = resolvePrincipalAttendant(chat);
      const wrote = await this.upsertTranscriptEntry(ticket, content, {
        technicianEmail: attendant?.email || this.serviceEmail,
        technicianName: attendant?.name || "SM Click (automático)",
        normalHours: 0,
        hourType: "interna",
      });

      if (!wrote) {
        return { status: "skipped", reason: "versao_definitiva_ja_existe" };
      }
      return { status: "synced", ticketId: ticket.id };
    } catch (error) {
      console.error(`[smclick] falha ao sincronizar transcript ao vivo (ticket ${ticket.id}):`, error);
      return { status: "skipped", reason: "falha_sincronizacao" };
    }
  }

  /**
   * Busca SOB DEMANDA (SO LEITURA - nao grava nada no Base44) o historico da
   * conversa, pro botao "Buscar conversa do WhatsApp" no Ticket (Base44)
   * colar direto no editor "Relato da Atividade" da aba Novo Registro -
   * pedido do usuario em 2026-09-04: o analista revisa/ajusta e salva o
   * Registro ele mesmo, em vez do backend gravar por conta propria (esse
   * ultimo continua acontecendo, sozinho, pelos webhooks - ver
   * handleNewChatMessage/attachConversationTranscript - isto aqui e so uma
   * forma alternativa e sob demanda de ANTECIPAR o conteudo no editor).
   *
   * Busca o retrato atual do atendimento direto na API da SM Click (status,
   * atendente, attending_time) pelo protocolo salvo em
   * Ticket.external_customer_code - nao depende de nenhum webhook ter
   * chegado.
   */
  async getTranscriptPreview(ticketId: string): Promise<
    | { status: "skipped"; reason: string }
    | {
        status: "ok";
        html: string;
        date: string;
        startTime: string;
        endTime: string;
        finished: boolean;
        normalHours: number;
        technicianEmail: string;
        technicianName: string;
      }
  > {
    const ticket = await this.tickets.findById(ticketId);
    if (!ticket) {
      return { status: "skipped", reason: "ticket_nao_encontrado" };
    }
    if (ticket.external_system !== "smclick" || !ticket.external_customer_code) {
      return { status: "skipped", reason: "ticket_nao_e_do_smclick" };
    }

    const protocol = Number(ticket.external_customer_code);
    if (!Number.isFinite(protocol)) {
      return { status: "skipped", reason: "protocolo_invalido" };
    }

    const chatDetails = await this.smclickApi.getChatByProtocol(protocol);
    if (!chatDetails) {
      return { status: "skipped", reason: "atendimento_nao_encontrado_na_smclick" };
    }

    const messages = await this.smclickApi.getChatMessages(protocol);
    const finished = chatDetails.status === "finished";
    const resolved = resolveTranscriptMessages(messages, ticket.client_name || chatDetails.contact?.name || "Cliente");
    if (!resolved.firstMessageAt || !resolved.lastMessageAt) {
      return { status: "skipped", reason: "sem_mensagens" };
    }
    const content = await this.renderTranscriptContent(ticket.id, resolved, finished);

    const attendant = resolvePrincipalAttendant(chatDetails);
    return {
      status: "ok",
      html: content.html,
      date: formatDateSaoPaulo(content.firstMessageAt),
      startTime: formatTimeSaoPaulo(content.firstMessageAt),
      endTime: formatTimeSaoPaulo(content.lastMessageAt),
      finished,
      normalHours: finished ? this.sanitizeAttendingHours(chatDetails.attending_time, ticket.id) : 0,
      technicianEmail: attendant?.email || "",
      technicianName: attendant?.name || "",
    };
  }

  /**
   * Busca o historico de mensagens do atendimento na API da SM Click e
   * grava a versao DEFINITIVA do Registro (TimeEntry) com a conversa no
   * campo "Relato da Atividade" - pedido do usuario em 2026-09-04 pra dar
   * visibilidade completa do que foi falado com o cliente, sem precisar
   * abrir o WhatsApp. Atualiza o mesmo Registro que handleNewChatMessage ja
   * vinha sincronizando ao vivo (se existir), em vez de duplicar.
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
    const resolved = resolveTranscriptMessages(messages, ticket.client_name || chat.contact?.name || "Cliente");
    if (!resolved.firstMessageAt || !resolved.lastMessageAt) return;
    const content = await this.renderTranscriptContent(ticket.id, resolved, true);

    const attendant = resolvePrincipalAttendant(chat);
    const attendingHours = this.sanitizeAttendingHours(chat.attending_time, ticket.id);

    await this.upsertTranscriptEntry(ticket, content, {
      technicianEmail: attendant?.email || this.serviceEmail,
      technicianName: attendant?.name || "SM Click (automático)",
      normalHours: attendingHours,
      hourType: "normal",
    });

    await this.ticketEvents.create({
      ticket_id: ticket.id,
      type: "field_change",
      description: "Histórico da conversa do WhatsApp (SM Click) anexado automaticamente ao ticket.",
      user_email: this.serviceEmail,
      visible_to_client: false,
    });
  }

  /**
   * Renderiza a imagem da conversa (estilo print do WhatsApp - ver
   * ChatImageRenderer) e salva com um nome ESTAVEL por ticket
   * (`smclick-transcript-<ticketId>.png`), sobrescrevendo a cada
   * sincronizacao em vez de acumular um arquivo novo por vez. O `?v=`
   * (timestamp) na URL e so pra evitar que o navegador do analista mostre
   * uma versao antiga em cache depois de uma resincronizacao pro mesmo
   * ticket (o nome do arquivo em si nao muda).
   */
  private async renderTranscriptContent(ticketId: string, resolved: ResolvedTranscript, finished: boolean): Promise<TranscriptContent> {
    let imageUrl: string | null = null;
    if (resolved.items.length > 0) {
      const png = await renderChatImage(resolved.items);
      const filename = `smclick-transcript-${ticketId}.png`;
      await saveNamedFile(png, filename);
      imageUrl = `${env.publicBaseUrl}/uploads/${filename}?v=${Date.now()}`;
    }

    return {
      html: buildTranscriptDescriptionHtml(finished, imageUrl),
      firstMessageAt: resolved.firstMessageAt!,
      lastMessageAt: resolved.lastMessageAt!,
    };
  }

  /**
   * Cria ou atualiza o Registro (TimeEntry) automatico de transcript do
   * Ticket - reconhecido pelo prefixo fixo do HTML (TRANSCRIPT_HEADER_PREFIX),
   * pra nunca duplicar entre as tres formas de chegar aqui (webhook ao vivo,
   * chat-finished definitivo, botao sob demanda). Serializado por ticket.id
   * (ver withTranscriptLock) e protegido contra regressao: uma vez gravada
   * a versao DEFINITIVA (hour_type "normal", hora real), nenhuma
   * sincronizacao "ao vivo" (hour_type "interna", 0h) pode mais sobrescreve-la
   * - sem essas duas protecoes juntas, duas chamadas concorrentes podiam
   * duplicar o Registro, ou uma sincronizacao ao vivo atrasada podia zerar
   * as horas reais do analista que acabaram de ser gravadas (achado real de
   * code-review em 2026-09-04).
   */
  private async upsertTranscriptEntry(
    ticket: TicketRecord,
    content: TranscriptContent,
    opts: { technicianEmail: string; technicianName: string; normalHours: number; hourType: "normal" | "interna" }
  ): Promise<boolean> {
    return this.withTranscriptLock(ticket.id, async () => {
      const existing = (await this.timeEntries.findByTicket(ticket.id)).find((entry) =>
        entry.description?.startsWith(TRANSCRIPT_HEADER_PREFIX)
      );

      if (existing?.hour_type === "normal" && opts.hourType === "interna") {
        // Ja existe a versao definitiva (hora real) - uma sincronizacao "ao
        // vivo" chegando atrasada (ou com um retrato defasado da SM Click)
        // NAO pode regredi-la pra 0h/"interna". Retorna false pro chamador
        // saber que nada foi gravado (nao reportar "synced" as cegas).
        return false;
      }

      const data = {
        ticket_id: ticket.id,
        ticket_title: ticket.title,
        date: formatDateSaoPaulo(content.firstMessageAt),
        start_time: formatTimeSaoPaulo(content.firstMessageAt),
        end_time: formatTimeSaoPaulo(content.lastMessageAt),
        description: content.html,
        hour_type: opts.hourType,
        normal_hours: opts.normalHours,
        extra_hours: 0,
        notify_client: false,
        technician_email: opts.technicianEmail,
        technician_name: opts.technicianName,
      };

      if (existing) {
        await this.timeEntries.update(existing.id, data);
      } else {
        await this.timeEntries.create(data);
      }

      // Sem isto, total_normal_hours do ticket nao reflete o Registro
      // recem-criado/atualizado (ver TicketActionsService.recomputeHours).
      await this.ticketActions.recomputeHours(ticket.id);
      return true;
    });
  }

  /**
   * Executa `fn` em fila, uma de cada vez, por `key` (aqui, sempre
   * ticket.id) - as chamadas concorrentes esperam a anterior terminar em vez
   * de rodar em paralelo. Erros de uma execucao nao travam a fila (a proxima
   * roda normalmente); erros SAO propagados pra quem chamou (o `await`
   * retorna a promise de `fn`, nao a da fila).
   */
  private withTranscriptLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.transcriptLocks.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const marker: Promise<void> = run.then(
      () => undefined,
      () => undefined
    );
    this.transcriptLocks.set(key, marker);
    // Autolimpeza: se ninguem mais entrou na fila deste `key` enquanto `run`
    // executava, remove a entrada do Map - sem isto ele cresceria sem limite
    // (um ticket.id por transcript sincronizado, pra sempre), mesmo problema
    // que lastLiveSyncAt tem (ver recordLiveSync). Se alguem ja enfileirou
    // outra chamada nesse meio tempo, o valor no Map nao e mais `marker` e a
    // entrada fica (ainda em uso).
    void marker.finally(() => {
      if (this.transcriptLocks.get(key) === marker) {
        this.transcriptLocks.delete(key);
      }
    });
    return run;
  }

  /** TTL de limpeza pro Map de debounce ao vivo - ver recordLiveSync. */
  private static readonly LIVE_SYNC_ENTRY_TTL_MS = 2 * 60 * 60 * 1000; // 2h

  /**
   * Marca a sincronizacao ao vivo mais recente pro chat e poda entradas
   * velhas do Map - sem isto ele cresceria sem limite (uma entrada por
   * conversa da SM Click, pra sempre, ja que este servico roda como
   * processo unico de longa duracao). 2h sem mensagem nova e sinal seguro de
   * que o chat nao vai mais ser sincronizado aqui (finalizado, abandonado em
   * triagem, etc) - cobre os casos que a limpeza pontual em handleChatFinished
   * (so no caminho de sucesso) nao cobre.
   */
  private recordLiveSync(chatId: string): void {
    const now = Date.now();
    this.lastLiveSyncAt.set(chatId, now);
    for (const [key, timestamp] of this.lastLiveSyncAt) {
      if (now - timestamp > SmclickIntegrationService.LIVE_SYNC_ENTRY_TTL_MS) {
        this.lastLiveSyncAt.delete(key);
      }
    }
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
