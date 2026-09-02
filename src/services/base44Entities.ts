import type { Base44Client, EntityHandler } from "@base44/sdk";
import type {
  AutomationRuleRecord,
  Client,
  ClientRecord,
  KanbanConfigRecord,
  NotificationConfigRecord,
  NotificationRecord,
  SyncStateRecord,
  TicketEmailRecord,
  TicketEventRecord,
  TicketRecord,
  TimeEntryRecord,
} from "../types/entities";

/**
 * Coluna Kanban onde novos tickets entram. Confirmada comparando com a
 * integracao "Sistema Comercial" (ja em producao no mesmo app Base44), que
 * usa esse mesmo valor para status_column_id/status_column_title. Sem isto,
 * o ticket existe no banco mas nao aparece em nenhuma coluna do quadro.
 */
export const DEFAULT_STATUS_COLUMN = "NOVO";

/**
 * Codigos de vertical validos neste app Base44 (entity `Vertical`, campo
 * `code`). O quadro do Unasys Tickets so reconhece estes 3 valores - um
 * Ticket com um valor de vertical fora dessa lista fica sem aparecer para
 * a maioria dos usuarios, mesmo com status_column_id correto.
 */
const VALID_VERTICAL_CODES = ["food", "farma", "retail"] as const;

/**
 * Tenta encaixar um valor de vertical vindo de um sistema externo (formato
 * livre, ex: "Retail - BSB", "Food", "varejo") num dos 3 codigos validos.
 * TODO: decisao pendente - esse mapeamento e um palpite razoavel por
 * palavra-chave; confirmar com o time quais valores o Unasys Flow e outros
 * sistemas externos realmente enviam, e ajustar aqui se necessario.
 */
export function normalizeVertical(raw: string | undefined): string {
  const value = (raw ?? "").toLowerCase();

  if (value.includes("food")) return "food";
  if (value.includes("farma")) return "farma";
  if (value.includes("retail") || value.includes("varejo")) return "retail";

  return (VALID_VERTICAL_CODES as readonly string[]).includes(value) ? value : "retail";
}

export interface Base44Entities {
  Ticket: EntityHandler<TicketRecord>;
  TicketEmail: EntityHandler<TicketEmailRecord>;
  TicketEvent: EntityHandler<TicketEventRecord>;
  SyncState: EntityHandler<SyncStateRecord>;
  Client: EntityHandler<ClientRecord>;
  AutomationRule: EntityHandler<AutomationRuleRecord>;
  Notification: EntityHandler<NotificationRecord>;
  NotificationConfig: EntityHandler<NotificationConfigRecord>;
  KanbanConfig: EntityHandler<KanbanConfigRecord>;
  TimeEntry: EntityHandler<TimeEntryRecord>;
}

/**
 * Acesso tipado as entities do Base44 usadas por esta integracao.
 * O SDK expoe `base44.entities.<Nome>` dinamicamente (sem tipos gerados para
 * este app), entao tipamos aqui manualmente com base nos schemas reais.
 */
export function getEntities(client: Base44Client): Base44Entities {
  return {
    Ticket: client.entities.Ticket as unknown as EntityHandler<TicketRecord>,
    TicketEmail: client.entities.TicketEmail as unknown as EntityHandler<TicketEmailRecord>,
    TicketEvent: client.entities.TicketEvent as unknown as EntityHandler<TicketEventRecord>,
    SyncState: client.entities.SyncState as unknown as EntityHandler<SyncStateRecord>,
    Client: client.entities.Client as unknown as EntityHandler<ClientRecord>,
    AutomationRule: client.entities.AutomationRule as unknown as EntityHandler<AutomationRuleRecord>,
    Notification: client.entities.Notification as unknown as EntityHandler<NotificationRecord>,
    NotificationConfig: client.entities.NotificationConfig as unknown as EntityHandler<NotificationConfigRecord>,
    KanbanConfig: client.entities.KanbanConfig as unknown as EntityHandler<KanbanConfigRecord>,
    TimeEntry: client.entities.TimeEntry as unknown as EntityHandler<TimeEntryRecord>,
  };
}

/**
 * Busca um Client existente por CNPJ e/ou email; cria um novo se nao achar
 * nenhum. `Ticket.client_id` deve usar o `id` retornado aqui - nao o
 * CNPJ/email cru (ver comentario em types/entities.ts).
 */
export async function findOrCreateClient(
  entities: Base44Entities,
  lookup: { cnpj?: string; email?: string },
  createData: Client
): Promise<ClientRecord> {
  if (lookup.cnpj) {
    const existing = await entities.Client.filter({ cnpj: lookup.cnpj }, undefined, 1);
    if (existing[0]) return existing[0];
  }
  if (lookup.email) {
    const existing = await entities.Client.filter({ email: lookup.email }, undefined, 1);
    if (existing[0]) return existing[0];
  }
  return entities.Client.create(createData);
}
