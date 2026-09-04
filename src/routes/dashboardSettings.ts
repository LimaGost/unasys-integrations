import { Router, type Request, type Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler";
import { requireDashboardPasswordConfirmation } from "../middleware/dashboardConfirm";
import {
  addCustomIntegration,
  getConfig,
  regenerateWebhookToken,
  removeCustomIntegration,
  setGmailCredentials,
  setWebhookTokenNote,
  type WebhookIntegration,
} from "../services/configStore";

function isWebhookIntegration(value: string): value is WebhookIntegration {
  return (
    value === "salesData" ||
    value === "gmail" ||
    value === "emailButton" ||
    value === "userDirectory" ||
    value === "attachments" ||
    value === "emailAdmin" ||
    value === "ticketActions" ||
    value === "externalTickets" ||
    value === "smclick"
  );
}

const router = Router();

function maskSecret(value: string | undefined): string | null {
  if (!value) return null;
  if (value.length <= 4) return "••••";
  return `••••${value.slice(-4)}`;
}

/** Estado atual da config editavel. Segredos vem mascarados (exceto tokens de webhook, feitos para serem copiados). */
router.get("/", (_req: Request, res: Response) => {
  const config = getConfig();
  res.json({
    gmail: {
      user: config.gmail.user ?? null,
      appPasswordMasked: maskSecret(config.gmail.appPassword),
      configured: Boolean(config.gmail.user && config.gmail.appPassword),
      smtpHost: config.gmail.smtpHost ?? null,
      smtpPort: config.gmail.smtpPort ?? null,
      imapHost: config.gmail.imapHost ?? null,
      imapPort: config.gmail.imapPort ?? null,
    },
    webhookTokens: {
      salesData: { token: config.webhookTokens.salesData.token ?? null, note: config.webhookTokens.salesData.note ?? "" },
      gmail: { token: config.webhookTokens.gmail.token ?? null, note: config.webhookTokens.gmail.note ?? "" },
      emailButton: { token: config.webhookTokens.emailButton.token ?? null, note: config.webhookTokens.emailButton.note ?? "" },
      userDirectory: { token: config.webhookTokens.userDirectory.token ?? null, note: config.webhookTokens.userDirectory.note ?? "" },
      attachments: { token: config.webhookTokens.attachments.token ?? null, note: config.webhookTokens.attachments.note ?? "" },
      emailAdmin: { token: config.webhookTokens.emailAdmin.token ?? null, note: config.webhookTokens.emailAdmin.note ?? "" },
      ticketActions: { token: config.webhookTokens.ticketActions.token ?? null, note: config.webhookTokens.ticketActions.note ?? "" },
      externalTickets: { token: config.webhookTokens.externalTickets.token ?? null, note: config.webhookTokens.externalTickets.note ?? "" },
      smclick: { token: config.webhookTokens.smclick.token ?? null, note: config.webhookTokens.smclick.note ?? "" },
    },
    customIntegrations: config.customIntegrations.map((integration) => ({
      slug: integration.slug,
      name: integration.name,
      token: integration.token,
      createdAt: integration.createdAt,
      url: `/webhooks/custom/${integration.slug}`,
    })),
  });
});

function parsePort(raw: unknown): number | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}

router.post(
  "/gmail",
  requireDashboardPasswordConfirmation,
  asyncHandler(async (req: Request, res: Response) => {
    const user = typeof req.body?.user === "string" ? req.body.user.trim() : "";
    const appPassword = typeof req.body?.appPassword === "string" ? req.body.appPassword.replace(/\s+/g, "") : "";
    const smtpHost = typeof req.body?.smtpHost === "string" ? req.body.smtpHost.trim() : "";
    const imapHost = typeof req.body?.imapHost === "string" ? req.body.imapHost.trim() : "";
    const smtpPort = parsePort(req.body?.smtpPort);
    const imapPort = parsePort(req.body?.imapPort);

    if (!user.includes("@") || appPassword.length < 6) {
      res.status(400).json({
        error: "BadRequest",
        message: "Informe um email valido e a senha da caixa (senha de app do Google, ou a senha normal se for outro provedor).",
      });
      return;
    }

    await setGmailCredentials(user, appPassword, { smtpHost, smtpPort, imapHost, imapPort });
    res.json({ message: `Credenciais de email atualizadas para ${user}.` });
  })
);

router.post(
  "/webhook-tokens/:integration/regenerate",
  requireDashboardPasswordConfirmation,
  asyncHandler(async (req: Request, res: Response) => {
    const integration = req.params.integration ?? "";
    if (!isWebhookIntegration(integration)) {
      res.status(400).json({
        error: "BadRequest",
        message: "Integracao invalida. Use 'salesData', 'gmail', 'emailButton', 'userDirectory', 'attachments', 'emailAdmin', 'ticketActions', 'externalTickets' ou 'smclick'.",
      });
      return;
    }

    const token = await regenerateWebhookToken(integration);
    res.json({ message: "Token regenerado. Atualize o sistema externo com o novo valor.", token });
  })
);

router.post(
  "/webhook-tokens/:integration/note",
  requireDashboardPasswordConfirmation,
  asyncHandler(async (req: Request, res: Response) => {
    const integration = req.params.integration ?? "";
    if (!isWebhookIntegration(integration)) {
      res.status(400).json({
        error: "BadRequest",
        message: "Integracao invalida. Use 'salesData', 'gmail', 'emailButton', 'userDirectory', 'attachments', 'emailAdmin', 'ticketActions', 'externalTickets' ou 'smclick'.",
      });
      return;
    }

    const note = typeof req.body?.note === "string" ? req.body.note.slice(0, 300) : "";
    await setWebhookTokenNote(integration, note);
    res.json({ message: "Anotacao salva." });
  })
);

router.post(
  "/integrations",
  requireDashboardPasswordConfirmation,
  asyncHandler(async (req: Request, res: Response) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name) {
      res.status(400).json({ error: "BadRequest", message: "Informe um nome para a integracao." });
      return;
    }

    const integration = await addCustomIntegration(name);
    res.status(201).json({
      message: `Integracao "${integration.name}" criada.`,
      slug: integration.slug,
      name: integration.name,
      token: integration.token,
      url: `/webhooks/custom/${integration.slug}`,
    });
  })
);

router.delete(
  "/integrations/:slug",
  requireDashboardPasswordConfirmation,
  asyncHandler(async (req: Request, res: Response) => {
    const removed = req.params.slug ? await removeCustomIntegration(req.params.slug) : false;
    if (!removed) {
      res.status(404).json({ error: "NotFound", message: "Integracao nao encontrada." });
      return;
    }
    res.json({ message: "Integracao removida." });
  })
);

export default router;
