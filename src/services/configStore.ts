import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env";

export interface CustomIntegration {
  slug: string;
  name: string;
  token: string;
  createdAt: string;
}

export interface WebhookTokenEntry {
  token?: string;
  /** Anotacao livre pra lembrar onde esse token foi cadastrado do lado externo (ex: "Base44 > Unasys Flow > Secrets > UNASYS_INTEGRATIONS_SALES_TOKEN"). */
  note?: string;
}

export interface EmailAccountConfig {
  user?: string;
  appPassword?: string;
  /** Host/porta SMTP (envio). Default: servidores do Gmail, se nao informado. */
  smtpHost?: string;
  smtpPort?: number;
  /** Host/porta IMAP (recebimento). Default: servidores do Gmail, se nao informado. */
  imapHost?: string;
  imapPort?: number;
}

export interface StoredConfig {
  /**
   * Historicamente so suportava Gmail (daí o nome) - hoje aceita qualquer
   * provedor SMTP/IMAP (ex: email hospedado na Hostinger), via
   * smtpHost/imapHost. Sem esses campos, cai nos servidores do Gmail.
   */
  gmail: EmailAccountConfig;
  webhookTokens: {
    salesData: WebhookTokenEntry;
    gmail: WebhookTokenEntry;
    /**
     * Token exclusivo do botao "Enviar E-mail" do Ticket (Base44), chamado
     * DIRETO do navegador do usuario (sem passar por nenhuma function do
     * Base44 - por isso nao gera custo de "credito de integracao" la).
     * Fica visivel no codigo-fonte do frontend do Base44 - por isso e um
     * token separado dos outros (nao reaproveita webhookTokens.gmail), so
     * serve pra essa rota especifica e e protegido tambem por CORS/rate
     * limit/validacao de ticket (ver routes/publicEmailSend.ts).
     */
    emailButton: WebhookTokenEntry;
    /**
     * NOVO, ainda sem uso real (Etapa 2 - ver routes/publicUsers.ts). Mesmo
     * motivo do emailButton: vai ficar visivel no frontend do Base44, entao
     * token proprio, nao reaproveita os outros.
     */
    userDirectory: WebhookTokenEntry;
    /**
     * Token exclusivo do upload de anexos (Novo Registro / Anexos do Ticket /
     * composer de email, no Base44), chamado DIRETO do navegador do usuario
     * contra POST /public/uploads/upload - mesma logica do emailButton, para
     * nao gastar credito de integracao no Base44.Core.UploadFile.
     */
    attachments: WebhookTokenEntry;
    /**
     * Token exclusivo das telas de status de email do Base44
     * (EmailConfigStatus.jsx / EmailAutomationConfig.jsx), chamado DIRETO do
     * navegador do usuario contra /public/email-admin/* (status, verificar
     * agora, enviar teste) - mesmo motivo do emailButton/attachments: fica
     * visivel no frontend, entao token proprio.
     */
    emailAdmin: WebhookTokenEntry;
    /**
     * Token exclusivo das acoes de ticket migradas do Base44 (ex:
     * updateTicketStatus, chamada a cada movimentacao de card no Kanban),
     * chamado DIRETO do navegador do usuario contra /public/ticket-actions/*
     * - mesmo motivo dos outros: fica visivel no frontend, entao token proprio.
     */
    ticketActions: WebhookTokenEntry;
    /**
     * Token exclusivo de POST /webhooks/tickets/create-from-external (porta a
     * antiga function `createTicketFromExternal` do Base44) - chamado por
     * sistemas externos (nao pelo navegador), por isso token proprio nesta
     * familia (nao reaproveita salesData, mesma logica de "revogar um nao
     * afeta os outros").
     */
    externalTickets: WebhookTokenEntry;
  };
  customIntegrations: CustomIntegration[];
}

/** Formato antigo (antes do campo `note`), usado so para migrar arquivos ja existentes. */
interface LegacyStoredConfig {
  gmail: { user?: string; appPassword?: string };
  webhookTokens: { salesData?: string; gmail?: string };
  customIntegrations: CustomIntegration[];
}

function isLegacyFormat(parsed: unknown): parsed is LegacyStoredConfig {
  const tokens = (parsed as LegacyStoredConfig)?.webhookTokens;
  return typeof tokens?.salesData === "string" || typeof tokens?.gmail === "string";
}

function migrateLegacyConfig(legacy: LegacyStoredConfig): StoredConfig {
  return {
    gmail: legacy.gmail,
    webhookTokens: {
      salesData: { token: legacy.webhookTokens.salesData },
      gmail: { token: legacy.webhookTokens.gmail },
      emailButton: {},
      userDirectory: {},
      attachments: {},
      emailAdmin: {},
      ticketActions: {},
      externalTickets: {},
    },
    customIntegrations: legacy.customIntegrations ?? [],
  };
}

/** Preenche tokens novos (emailButton, userDirectory) em arquivos gravados antes desses campos existirem. */
function backfillNewWebhookTokens(config: StoredConfig): boolean {
  let changed = false;
  if (!config.webhookTokens.emailButton) {
    config.webhookTokens.emailButton = {};
    changed = true;
  }
  if (!config.webhookTokens.userDirectory) {
    config.webhookTokens.userDirectory = {};
    changed = true;
  }
  if (!config.webhookTokens.attachments) {
    config.webhookTokens.attachments = {};
    changed = true;
  }
  if (!config.webhookTokens.emailAdmin) {
    config.webhookTokens.emailAdmin = {};
    changed = true;
  }
  if (!config.webhookTokens.ticketActions) {
    config.webhookTokens.ticketActions = {};
    changed = true;
  }
  if (!config.webhookTokens.externalTickets) {
    config.webhookTokens.externalTickets = {};
    changed = true;
  }
  return changed;
}

/**
 * Config operacional editavel pelo painel (GET /dashboard), persistida em
 * disco separada do .env. O .env guarda so os segredos de boot (conta de
 * servico do Base44, login do painel) - tudo aqui pode ser trocado em tempo
 * real, sem reiniciar o processo.
 *
 * Na primeira execucao (arquivo ainda nao existe), semeia os valores a
 * partir das variaveis de ambiente antigas (GMAIL_USER, WEBHOOK_TOKEN_*)
 * para nao quebrar quem ja tinha essas variaveis no .env. Depois da primeira
 * gravacao, o arquivo passa a ser a fonte da verdade - essas variaveis de
 * ambiente deixam de ser lidas.
 */
const CONFIG_PATH = process.env.CONFIG_FILE_PATH ?? path.join(process.cwd(), "data", "integrations-config.json");

let cache: StoredConfig | null = null;

function seedFromEnv(): StoredConfig {
  return {
    gmail: {
      user: env.gmail.user,
      appPassword: env.gmail.appPassword,
    },
    webhookTokens: {
      salesData: { token: env.webhookTokens.salesData },
      gmail: { token: env.webhookTokens.gmail },
      emailButton: {},
      userDirectory: {},
      attachments: {},
      emailAdmin: {},
      ticketActions: {},
      externalTickets: {},
    },
    customIntegrations: [],
  };
}

async function persist(config: StoredConfig): Promise<void> {
  await mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

/**
 * Carrega a config do disco (ou semeia a partir do .env na primeira vez) e
 * mantem em memoria. Deve ser chamada uma vez na inicializacao do servidor.
 */
export async function loadConfigStore(): Promise<StoredConfig> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf-8");
    const parsed: unknown = JSON.parse(raw);

    if (isLegacyFormat(parsed)) {
      cache = migrateLegacyConfig(parsed);
      await persist(cache);
      console.log(`[config] arquivo de configuracao em ${CONFIG_PATH} migrado para o novo formato (com anotacoes por token).`);
    } else {
      cache = parsed as StoredConfig;
      if (backfillNewWebhookTokens(cache)) {
        await persist(cache);
        console.log(`[config] novos tokens de webhook adicionados ao arquivo de configuracao em ${CONFIG_PATH}.`);
      }
    }
  } catch {
    cache = seedFromEnv();
    await persist(cache);
    console.log(`[config] arquivo de configuracao criado em ${CONFIG_PATH} (semeado a partir do .env).`);
  }
  return cache;
}

/** Retorna a config atual em memoria. Chame `loadConfigStore()` antes, no boot. */
export function getConfig(): StoredConfig {
  if (!cache) {
    throw new Error("configStore nao foi inicializado - chame loadConfigStore() no boot.");
  }
  return cache;
}

async function updateConfig(mutate: (config: StoredConfig) => void): Promise<StoredConfig> {
  const config = getConfig();
  mutate(config);
  await persist(config);
  return config;
}

export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

export async function setGmailCredentials(
  user: string,
  appPassword: string,
  server?: { smtpHost?: string; smtpPort?: number; imapHost?: string; imapPort?: number }
): Promise<void> {
  await updateConfig((config) => {
    config.gmail.user = user;
    config.gmail.appPassword = appPassword;
    config.gmail.smtpHost = server?.smtpHost || undefined;
    config.gmail.smtpPort = server?.smtpPort || undefined;
    config.gmail.imapHost = server?.imapHost || undefined;
    config.gmail.imapPort = server?.imapPort || undefined;
  });
}

export type WebhookIntegration =
  | "salesData"
  | "gmail"
  | "emailButton"
  | "userDirectory"
  | "attachments"
  | "emailAdmin"
  | "ticketActions"
  | "externalTickets";

export async function regenerateWebhookToken(integration: WebhookIntegration): Promise<string> {
  const token = generateToken();
  await updateConfig((config) => {
    config.webhookTokens[integration].token = token;
  });
  return token;
}

export async function setWebhookTokenNote(integration: WebhookIntegration, note: string): Promise<void> {
  await updateConfig((config) => {
    config.webhookTokens[integration].note = note;
  });
}

/** Remove acentos (ex: "ã" -> "a") sem depender de um regex com caracteres Unicode literais no codigo-fonte. */
function stripDiacritics(input: string): string {
  return Array.from(input.normalize("NFD"))
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      const isCombiningMark = code >= 0x0300 && code <= 0x036f;
      return !isCombiningMark;
    })
    .join("");
}

function slugify(name: string): string {
  return stripDiacritics(name.toLowerCase())
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export async function addCustomIntegration(name: string): Promise<CustomIntegration> {
  const config = getConfig();
  const baseSlug = slugify(name) || "integracao";
  let slug = baseSlug;
  let suffix = 2;
  while (config.customIntegrations.some((integration) => integration.slug === slug)) {
    slug = `${baseSlug}-${suffix}`;
    suffix += 1;
  }

  const integration: CustomIntegration = {
    slug,
    name,
    token: generateToken(),
    createdAt: new Date().toISOString(),
  };

  await updateConfig((cfg) => {
    cfg.customIntegrations.push(integration);
  });

  return integration;
}

export async function removeCustomIntegration(slug: string): Promise<boolean> {
  const config = getConfig();
  const existsBefore = config.customIntegrations.length;
  await updateConfig((cfg) => {
    cfg.customIntegrations = cfg.customIntegrations.filter((integration) => integration.slug !== slug);
  });
  return config.customIntegrations.length < existsBefore;
}

export function findCustomIntegration(slug: string): CustomIntegration | undefined {
  return getConfig().customIntegrations.find((integration) => integration.slug === slug);
}
