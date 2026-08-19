/**
 * Campos que o Base44 adiciona automaticamente a todo registro de entity.
 */
export interface Base44ServerFields {
  id: string;
  created_date: string;
  updated_date: string;
  created_by?: string | null;
  created_by_id?: string | null;
}

export type TicketMainType = "implantacao" | "suporte";
export type TicketUrgency = "baixa" | "media" | "alta" | "critica";

export interface Ticket {
  title: string;
  main_type: TicketMainType;
  client_id: string;
  client_name?: string;
  client_email?: string;
  vertical: string;
  ticket_type?: string;
  urgency: TicketUrgency;
  status_column_id?: string;
  status_column_title?: string;
  description?: string;
  external_order_number?: string;
  external_customer_code?: string;
  external_reference?: string;
  external_system?: string;
  /** Modulos contratados na venda (Unasys Flow). */
  modulos?: string[];
  /** Observacoes gerais associadas ao ticket (Unasys Flow). */
  observacoes_gerais?: string;
}

export type TicketRecord = Ticket & Base44ServerFields;

/**
 * Entity Client (CRM) do Base44 - cadastro real de clientes. `Ticket.client_id`
 * deve apontar para o `id` de um registro aqui, nao para um CNPJ/codigo cru
 * (confirmado comparando com a integracao "Sistema Comercial", ja em producao
 * no mesmo app, que resolve o cliente antes de criar o Ticket).
 */
export interface Client {
  nome_fantasia: string;
  cnpj?: string;
  email?: string;
  empresa?: string;
  telefone?: string;
  vertical?: string;
  status?: "novo_cliente" | "cliente_da_base" | "parceiro";
  active?: boolean;
}

export type ClientRecord = Client & Base44ServerFields;

export type TicketEmailDirection = "sent" | "received";

export interface TicketEmailAttachment {
  filename: string;
  url?: string;
  content_type?: string;
  size?: number;
}

export interface TicketEmail {
  ticket_id: string;
  subject: string;
  body: string;
  from_email: string;
  from_name?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  direction: TicketEmailDirection;
  gmail_message_id?: string;
  gmail_thread_id?: string;
  rfc_message_id?: string;
  reply_to_email_id?: string;
  is_reply?: boolean;
  attachments?: TicketEmailAttachment[];
  visible_to_client?: boolean;
}

export type TicketEmailRecord = TicketEmail & Base44ServerFields;

export interface SyncState {
  key: string;
  history_id?: string;
}

export type SyncStateRecord = SyncState & Base44ServerFields;

export type TicketEventType =
  | "creation"
  | "status_change"
  | "time_entry"
  | "comment_internal"
  | "comment_client"
  | "assignment"
  | "field_change";

export interface TicketEvent {
  ticket_id: string;
  type: TicketEventType;
  description?: string;
  old_value?: string;
  new_value?: string;
  user_email?: string;
  user_name?: string;
  visible_to_client?: boolean;
  email_sent?: boolean;
}

export type TicketEventRecord = TicketEvent & Base44ServerFields;
