/**
 * Payload recebido do Unasys Flow em POST /webhooks/sales-data/receive, ja
 * normalizado para os nomes de campo internos usados por processSalesPayload.
 *
 * O formato real confirmado (20/08/2026, comparando com `receiveSalesData`,
 * a function equivalente hospedada dentro do proprio Base44) usa nomes em
 * portugues: numero_op, cnpj_cliente, nome_cliente, email_cliente,
 * numero_cliente. A normalizacao de entrada (ver `normalizeSalesPayload` em
 * routes/salesData.ts) aceita esse formato E o formato em ingles usado
 * antes de confirmar (order_number/customer_code/client_name/client_email),
 * para nao quebrar se algum lado ainda estiver configurado com o nome antigo.
 */
export interface UnasysFlowSalesPayload {
  /** Numero do pedido/OP - chave usada para detectar duplicata. */
  order_number: string;
  /** CNPJ do cliente, ja validado (digitos verificadores) e normalizado (XX.XXX.XXX/XXXX-XX). */
  cnpj: string;
  client_name: string;
  client_email?: string;
  /** Codigo do cliente/loja no sistema comercial - NAO e o CNPJ (ver `cnpj` acima). */
  customer_code?: string;
  vertical: string;
  nome_fantasia?: string;
  razao_social?: string;
  cnae?: string;
  telefone?: string;
  modulos?: string[];
  observacoes?: string;
}
