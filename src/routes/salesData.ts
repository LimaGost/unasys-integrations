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

export function isValidSalesPayload(body: unknown): body is UnasysFlowSalesPayload {
  const payload = body as Partial<UnasysFlowSalesPayload> | null;
  return Boolean(
    payload &&
      typeof payload.order_number === "string" &&
      payload.order_number.length > 0 &&
      typeof payload.customer_code === "string" &&
      payload.customer_code.length > 0 &&
      typeof payload.client_name === "string" &&
      payload.client_name.length > 0 &&
      typeof payload.vertical === "string" &&
      payload.vertical.length > 0
  );
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

    const existing = await Ticket.filter({ external_order_number: payload.order_number }, undefined, 1);
    const existingTicket = existing[0];

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
      { cnpj: payload.customer_code, email: payload.client_email },
      {
        nome_fantasia: payload.client_name,
        cnpj: payload.customer_code,
        email: payload.client_email,
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
      external_customer_code: payload.customer_code,
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
    if (!isValidSalesPayload(req.body)) {
      res.status(400).json({
        error: "BadRequest",
        message: "Campos obrigatorios ausentes ou invalidos: order_number, customer_code, client_name, vertical.",
      });
      return;
    }

    const result = await processSalesPayload(req.body);
    res.status(result.status).json({ ticket_id: result.ticketId });
  })
);

export default router;
