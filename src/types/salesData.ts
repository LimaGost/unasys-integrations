/**
 * Payload recebido do Unasys Flow em POST /webhooks/sales-data/receive.
 *
 * Formato assumido enquanto o payload real do Unasys Flow nao e confirmado -
 * ajustar os nomes de campo aqui quando soubermos o formato definitivo.
 */
export interface UnasysFlowSalesPayload {
  order_number: string;
  customer_code: string;
  client_name: string;
  client_email?: string;
  vertical: string;
  modulos?: string[];
  observacoes?: string;
}
