import { Base44Error } from "@base44/sdk";
import { Router, type Request, type Response } from "express";
import { env } from "../config/env";
import { asyncHandler } from "../middleware/asyncHandler";
import { requireWebhookToken } from "../middleware/auth";
import { callBase44 } from "../services/base44Client";
import { DEFAULT_STATUS_COLUMN, findOrCreateClient, getEntities, normalizeVertical } from "../services/base44Entities";
import { getConfig } from "../services/configStore";
import type { ClientRecord, TicketMainType, TicketRecord, TicketUrgency } from "../types/entities";

/**
 * Porta a antiga function `createTicketFromExternal` do Base44 - endpoint
 * generico para SISTEMAS EXTERNOS (nao o navegador) criarem um Ticket a
 * partir de um identificador de cliente (email ou ID de Client ja
 * cadastrado). Diferente de routes/salesData.ts (especifico do payload do
 * Unasys Flow, com validacao de CNPJ), este aceita qualquer sistema externo
 * documentado - uso real ainda nao confirmado em producao (ver WebhookDocs no
 * Base44), portado preventivamente para ja nascer fora do Base44.
 *
 * TODO: anexos (`attachments` no payload original) nao portados - este
 * servico ainda nao tem suporte a entity TicketAttachment (ver
 * ESTRUTURA-DO-PROJETO.md); adicionar quando/se for confirmado que algum
 * sistema externo realmente envia anexos nesta chamada.
 */
const router = Router();

router.use(requireWebhookToken(() => getConfig().webhookTokens.externalTickets.token));

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

const VALID_URGENCIES: readonly TicketUrgency[] = ["baixa", "media", "alta", "critica"];
function readUrgency(value: unknown): TicketUrgency {
  return typeof value === "string" && (VALID_URGENCIES as readonly string[]).includes(value) ? (value as TicketUrgency) : "media";
}

function readMainType(value: unknown): TicketMainType {
  return value === "implantacao" ? "implantacao" : "suporte";
}

type CreateResult = { error: string } | { ticket: TicketRecord };

router.post(
  "/create-from-external",
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;

    const clientIdentifier = readString(body.client_identifier);
    const title = readString(body.title);
    if (!clientIdentifier || !title) {
      res.status(400).json({ error: "BadRequest", message: "Campos obrigatorios: client_identifier (email ou ID), title." });
      return;
    }

    const clientName = readString(body.client_name);
    const clientVertical = readString(body.client_vertical);
    const modulos = Array.isArray(body.modulos) ? body.modulos.filter((m): m is string => typeof m === "string") : undefined;
    const externalSystem = readString(body.external_system) || "external";

    const result: CreateResult = await callBase44(async (client) => {
      const entities = getEntities(client);
      const { Ticket, TicketEvent, Client } = entities;

      const isEmail = clientIdentifier.includes("@");
      let clientRecord: ClientRecord | null = null;

      if (isEmail) {
        clientRecord = (await Client.filter({ email: clientIdentifier }, undefined, 1))[0] ?? null;
      } else {
        try {
          clientRecord = await Client.get(clientIdentifier);
        } catch (error) {
          if (!(error instanceof Base44Error && error.status === 404)) throw error;
        }
      }

      if (!clientRecord) {
        if (!clientName || !clientVertical) {
          return { error: "Cliente nao encontrado. Para auto-criar, informe tambem client_name e client_vertical." };
        }
        clientRecord = await findOrCreateClient(
          entities,
          { email: isEmail ? clientIdentifier : readString(body.client_email) },
          {
            nome_fantasia: readString(body.nome_fantasia) || clientName,
            razao_social: readString(body.razao_social) || clientName,
            cnpj: readString(body.cnpj),
            cnae: readString(body.cnae),
            email: isEmail ? clientIdentifier : readString(body.client_email),
            telefone: readString(body.phone),
            vertical: normalizeVertical(clientVertical),
          }
        );
      }

      const vertical = normalizeVertical(clientRecord.vertical || clientVertical);

      const created = await Ticket.create({
        title,
        main_type: readMainType(body.main_type),
        client_id: clientRecord.id,
        client_name: clientRecord.nome_fantasia || clientName,
        client_email: clientRecord.email,
        vertical,
        urgency: readUrgency(body.urgency),
        ticket_type: readString(body.ticket_type) || "Suporte",
        service_type: readString(body.service_type),
        category: readString(body.category),
        requester: readString(body.requester),
        description: readString(body.description),
        modulos,
        observacoes_gerais: readString(body.observacoes_gerais),
        external_order_number: readString(body.external_order_number),
        external_customer_code: readString(body.external_customer_code),
        external_reference: readString(body.external_reference),
        external_system: externalSystem,
        // Sem isto, o ticket existe no banco mas nao aparece em nenhuma
        // coluna do quadro Kanban do Unasys Tickets.
        status_column_id: DEFAULT_STATUS_COLUMN,
        status_column_title: DEFAULT_STATUS_COLUMN,
      });

      await TicketEvent.create({
        ticket_id: created.id,
        type: "creation",
        description: `Ticket criado automaticamente via sistema externo (${externalSystem}).`,
        user_email: env.base44.serviceEmail,
        visible_to_client: false,
      });

      return { ticket: created };
    });

    if ("error" in result) {
      res.status(404).json({ error: "NotFound", message: result.error });
      return;
    }

    res.status(201).json({ status: "success", ticket_id: result.ticket.id, ticket_number: result.ticket.ticket_number });
  })
);

export default router;
