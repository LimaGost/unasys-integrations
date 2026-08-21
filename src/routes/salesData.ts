import { Router, type Request, type Response } from "express";
import { env } from "../config/env";
import { asyncHandler } from "../middleware/asyncHandler";
import { requireWebhookToken } from "../middleware/auth";
import { DEFAULT_STATUS_COLUMN, findOrCreateClient, getEntities, normalizeVertical } from "../services/base44Entities";
import { callBase44 } from "../services/base44Client";
import { getConfig } from "../services/configStore";
import type { UnasysFlowSalesPayload } from "../types/salesData";

const router = Router();

router.use(requireWebhookToken(() => getConfig().webhookTokens.salesData.token));

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Valida CNPJ com o algoritmo oficial (digitos verificadores) - portado de
 * `receiveSalesData` (function equivalente hospedada no Base44), que tem
 * essa validacao porque o Unasys Flow real manda CNPJ nesse campo.
 */
function validarCNPJ(cnpj: string): { ok: boolean; nums: string } {
  const n = (cnpj || "").replace(/\D/g, "");
  if (n.length !== 14 || /^(\d)\1{13}$/.test(n)) return { ok: false, nums: n };
  const calc = (len: number): number => {
    let sum = 0;
    let pos = len - 7;
    for (let i = len; i >= 1; i--) {
      sum += parseInt(n[len - i] as string, 10) * pos--;
      if (pos < 2) pos = 9;
    }
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const ok = calc(12) === parseInt(n[12] as string, 10) && calc(13) === parseInt(n[13] as string, 10);
  return { ok, nums: n };
}

function formatCNPJ(nums: string): string {
  return `${nums.slice(0, 2)}.${nums.slice(2, 5)}.${nums.slice(5, 8)}/${nums.slice(8, 12)}-${nums.slice(12)}`;
}

/**
 * Aceita o payload no formato real confirmado do Unasys Flow (nomes em
 * portugues: numero_op, cnpj_cliente, nome_cliente...) E no formato em
 * ingles assumido antes de confirmar (order_number, customer_code como
 * CNPJ...), para o caso de algum lado ainda estar configurado com o nome
 * antigo. Retorna `null` se faltar campo obrigatorio ou o CNPJ for invalido -
 * o motivo exato vai no `error` para aparecer na resposta 400.
 */
export function normalizeSalesPayload(body: unknown): { payload: UnasysFlowSalesPayload } | { error: string } {
  const raw = (body ?? {}) as Record<string, unknown>;

  const order_number = readString(raw.numero_op) ?? readString(raw.order_number);
  // Formato antigo (ingles) usava "customer_code" para o CNPJ - mantido aqui
  // so para nao quebrar se alguem ainda estiver mandando nesse formato.
  const cnpjRaw = readString(raw.cnpj_cliente) ?? readString(raw.customer_code);
  const client_name = readString(raw.nome_cliente) ?? readString(raw.client_name);
  const client_email = readString(raw.email_cliente) ?? readString(raw.client_email);
  const customer_code = readString(raw.numero_cliente);
  const vertical = readString(raw.vertical);
  const observacoes =
    readString(raw.observacoes) ??
    readString(raw.observacao) ??
    readString(raw.obs) ??
    readString(raw.observacoes_gerais) ??
    readString(raw.observacoes_proposta);
  const nome_fantasia = readString(raw.nome_fantasia);
  const razao_social = readString(raw.razao_social);
  const cnae = readString(raw.cnae);
  const telefone = readString(raw.telefone);
  const modulos = Array.isArray(raw.modulos)
    ? raw.modulos.filter((m): m is string => typeof m === "string")
    : undefined;

  const missing: string[] = [];
  if (!order_number) missing.push("numero_op");
  if (!cnpjRaw) missing.push("cnpj_cliente");
  if (!client_name) missing.push("nome_cliente");
  if (!vertical) missing.push("vertical");
  if (missing.length > 0) {
    return { error: `Campos obrigatorios ausentes: ${missing.join(", ")}.` };
  }

  const { ok, nums } = validarCNPJ(cnpjRaw as string);
  if (!ok) {
    return { error: `CNPJ invalido: "${cnpjRaw}". Verifique os digitos verificadores.` };
  }

  return {
    payload: {
      order_number: order_number as string,
      cnpj: formatCNPJ(nums),
      client_name: client_name as string,
      client_email,
      customer_code,
      vertical: vertical as string,
      nome_fantasia,
      razao_social,
      cnae,
      telefone,
      modulos,
      observacoes,
    },
  };
}

export interface ProcessSalesResult {
  status: 200 | 201;
  ticketId: string;
}

/**
 * Cria ou atualiza um Ticket a partir de um payload de venda. Usada pela
 * rota publica POST /receive e pelo botao "Criar ticket de teste" do painel
 * (POST /dashboard/api/actions/test-sales-data).
 */
export async function processSalesPayload(payload: UnasysFlowSalesPayload): Promise<ProcessSalesResult> {
  const vertical = normalizeVertical(payload.vertical);

  return callBase44(async (client) => {
    const entities = getEntities(client);
    const { Ticket, TicketEvent } = entities;

    // Duplicata = mesma OP E mesmo CNPJ (nao so a OP): uma franquia pode ter
    // varias filiais na mesma OP, cada uma com um Ticket proprio.
    const existingByOrder = await Ticket.filter({ external_order_number: payload.order_number });
    const existingTicket = existingByOrder.find((t) => (t.external_reference || "") === payload.cnpj);

    if (existingTicket) {
      const updated = await Ticket.update(existingTicket.id, {
        client_name: payload.client_name,
        client_email: payload.client_email,
        vertical,
        modulos: payload.modulos,
        observacoes_gerais: payload.observacoes,
      });

      await TicketEvent.create({
        ticket_id: updated.id,
        type: "field_change",
        description: `Dados de venda atualizados via Unasys Flow (pedido ${payload.order_number}).`,
        user_email: env.base44.serviceEmail,
        visible_to_client: false,
      });

      return { status: 200, ticketId: updated.id };
    }

    const clientRecord = await findOrCreateClient(
      entities,
      { cnpj: payload.cnpj, email: payload.client_email },
      {
        nome_fantasia: payload.nome_fantasia || payload.client_name,
        razao_social: payload.razao_social || payload.client_name,
        cnpj: payload.cnpj,
        cnae: payload.cnae,
        email: payload.client_email,
        telefone: payload.telefone,
        vertical,
      }
    );

    const created = await Ticket.create({
      // TODO: decisao pendente - urgency nao vem no payload do Unasys Flow;
      // usando "media" como padrao ate a regra de negocio ser confirmada.
      title: `Nova Implantação - ${payload.client_name}`,
      main_type: "implantacao",
      client_id: clientRecord.id,
      client_name: payload.client_name,
      client_email: payload.client_email,
      vertical,
      urgency: "media",
      description: payload.observacoes,
      modulos: payload.modulos,
      observacoes_gerais: payload.observacoes,
      external_order_number: payload.order_number,
      external_customer_code: payload.customer_code || payload.cnpj,
      external_reference: payload.cnpj,
      external_system: "unasys_flow",
      // Sem isto, o ticket existe no banco mas nao aparece em nenhuma
      // coluna do quadro Kanban do Unasys Tickets.
      status_column_id: DEFAULT_STATUS_COLUMN,
      status_column_title: DEFAULT_STATUS_COLUMN,
    });

    await TicketEvent.create({
      ticket_id: created.id,
      type: "creation",
      description: `Ticket criado automaticamente via Unasys Flow (pedido ${payload.order_number}).`,
      user_email: env.base44.serviceEmail,
      visible_to_client: false,
    });

    return { status: 201, ticketId: created.id };
  });
}

router.post(
  "/receive",
  asyncHandler(async (req: Request, res: Response) => {
    const normalized = normalizeSalesPayload(req.body);
    if ("error" in normalized) {
      res.status(400).json({ error: "BadRequest", message: normalized.error });
      return;
    }

    const result = await processSalesPayload(normalized.payload);
    res.status(result.status).json({ ticket_id: result.ticketId });
  })
);

export default router;
