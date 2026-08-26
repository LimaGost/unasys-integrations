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
  ticket_number?: number;
  title: string;
  main_type: TicketMainType;
  client_id: string;
  client_name?: string;
  client_email?: string;
  vertical: string;
  ticket_type?: string;
  requester?: string;
  service_type?: string;
  category?: string;
  urgency: TicketUrgency;
  status_column_id?: string;
  status_column_title?: string;
  sub_status?: string | null;
  assigned_to?: string;
  assigned_to_name?: string;
  expected_resolution?: string | null;
  sla_hours?: number;
  sla_breached?: boolean;
  sla_paused_at?: string | null;
  description?: string;
  modulos?: string[];
  observacoes_gerais?: string;
  contracted_hours?: number;
  total_normal_hours?: number;
  total_extra_hours?: number;
  notified?: boolean;
  closed_at?: string | null;
  external_order_number?: string;
  external_customer_code?: string;
  external_reference?: string;
  external_system?: string;
  parent_ticket_id?: string;
  parent_ticket_number?: number;
  parent_ticket_title?: string;
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
  razao_social?: string;
  cnpj?: string;
  cnae?: string;
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

export type AutomationTriggerType =
  | "ticket_created"
  | "status_changed"
  | "sla_warning"
  | "no_response_timeout"
  | "assignment_changed"
  | "urgency_changed";

export type AutomationActionType =
  | "assign_to_user"
  | "change_status"
  | "send_email"
  | "send_notification"
  | "change_urgency"
  | "add_comment";

export interface AutomationAction {
  action_type: AutomationActionType;
  parameters?: Record<string, unknown>;
}

export interface AutomationRule {
  name: string;
  description?: string;
  vertical: string;
  active?: boolean;
  trigger_type: AutomationTriggerType;
  trigger_conditions?: {
    main_type?: string;
    ticket_type?: string;
    urgency?: string;
    from_status_id?: string;
    from_status?: string;
    to_status_id?: string;
    to_status?: string;
    hours_threshold?: number;
    sla_percentage?: number;
  };
  actions: AutomationAction[];
  execution_count?: number;
  last_executed_at?: string;
}

export type AutomationRuleRecord = AutomationRule & Base44ServerFields;

export type NotificationType =
  | "ticket_assigned"
  | "status_changed"
  | "new_comment"
  | "new_time_entry"
  | "mentioned"
  | "sla_warning"
  | "ticket_created";

export interface Notification {
  user_email: string;
  ticket_id?: string | null;
  ticket_title?: string | null;
  type: NotificationType;
  title: string;
  message: string;
  read?: boolean;
  priority?: "low" | "normal" | "high";
  actor_name?: string | null;
  actor_email?: string | null;
}

export type NotificationRecord = Notification & Base44ServerFields;

export interface NotificationConfig {
  user_email: string;
  notify_on_assignment?: boolean;
  notify_on_status_change?: boolean;
  notify_on_comments?: boolean;
  notify_on_mention?: boolean;
  notify_on_sla_warning?: boolean;
  quiet_hours_enabled?: boolean;
  quiet_hours_start?: string;
  quiet_hours_end?: string;
}

export type NotificationConfigRecord = NotificationConfig & Base44ServerFields;

export interface KanbanColumn {
  title: string;
  color?: string;
  order?: number;
  is_final?: boolean;
  pauses_sla?: boolean;
  sla_hours?: number;
  required_fields?: string[];
  sub_statuses?: string[];
}

export interface KanbanConfig {
  main_type: TicketMainType;
  vertical: string;
  ticket_type: string;
  columns: KanbanColumn[];
  active?: boolean;
}

export type KanbanConfigRecord = KanbanConfig & Base44ServerFields;
