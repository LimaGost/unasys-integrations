import dotenv from "dotenv";

dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Variavel de ambiente obrigatoria ausente: ${name}. Verifique seu arquivo .env (veja .env.example).`
    );
  }
  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== "" ? value : undefined;
}

function parsePort(raw: string | undefined): number {
  const port = Number(raw ?? 3000);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Valor invalido para PORT: "${raw}". Use um numero de porta valido.`);
  }
  return port;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Valor invalido: "${raw}". Use um numero inteiro positivo.`);
  }
  return value;
}

export interface EnvConfig {
  nodeEnv: "development" | "production" | "test";
  port: number;
  base44: {
    appId: string;
    serviceEmail: string;
    servicePassword: string;
  };
  /**
   * Valores iniciais (usados so na primeira execucao, para semear
   * services/configStore.ts). Depois de configurado uma vez pelo painel
   * (GET /dashboard), o arquivo de config passa a ser a fonte da verdade e
   * estas variaveis de ambiente deixam de ser lidas.
   */
  webhookTokens: {
    gmail: string | undefined;
    salesData: string | undefined;
  };
  gmail: {
    /**
     * Credenciais de conta Gmail (SMTP/IMAP via "senha de app") usadas para
     * enviar e ler emails. Ainda nao configuradas em producao - ate la, as
     * rotas de Gmail retornam 503 informando a pendencia (ver README).
     *
     * Usamos SMTP/IMAP com senha de app em vez da Gmail API/OAuth2 porque
     * esta e uma conta pessoal (@gmail.com, nao Google Workspace): em modo
     * OAuth "Testing" o refresh token expiraria a cada 7 dias sem passar
     * pela verificacao do Google. Senha de app nao expira e nao exige
     * verificacao, sendo mais simples para este caso de uso.
     */
    user: string | undefined;
    appPassword: string | undefined;
    /**
     * Vertical padrao usada ao criar um Ticket de suporte a partir de um
     * email recebido sem vinculo previo com um ticket/cliente existente.
     * TODO: substituir por uma regra de negocio real (ex: mapear por
     * dominio do remetente) quando estiver definida.
     */
    defaultSupportVertical: string;
    /** Intervalo (em minutos) entre verificacoes da caixa de entrada. */
    pollIntervalMinutes: number;
  };
  dashboard: {
    /**
     * Credenciais de HTTP Basic Auth para o painel em GET /dashboard.
     * Enquanto nao configuradas, o painel responde 503 (mesmo padrao do Gmail).
     */
    user: string | undefined;
    password: string | undefined;
  };
}

function loadEnv(): EnvConfig {
  const nodeEnv = (process.env.NODE_ENV ?? "development") as EnvConfig["nodeEnv"];

  return {
    nodeEnv,
    port: parsePort(process.env.PORT),
    base44: {
      appId: requireEnv("BASE44_APP_ID"),
      serviceEmail: requireEnv("BASE44_SERVICE_ACCOUNT_EMAIL"),
      servicePassword: requireEnv("BASE44_SERVICE_ACCOUNT_PASSWORD"),
    },
    webhookTokens: {
      gmail: optionalEnv("WEBHOOK_TOKEN_GMAIL"),
      salesData: optionalEnv("WEBHOOK_TOKEN_SALES_DATA"),
    },
    gmail: {
      user: optionalEnv("GMAIL_USER"),
      appPassword: optionalEnv("GMAIL_APP_PASSWORD"),
      defaultSupportVertical: optionalEnv("GMAIL_DEFAULT_SUPPORT_VERTICAL") ?? "geral",
      pollIntervalMinutes: parsePositiveInt(process.env.GMAIL_POLL_INTERVAL_MINUTES, 2),
    },
    dashboard: {
      user: optionalEnv("DASHBOARD_USER"),
      password: optionalEnv("DASHBOARD_PASSWORD"),
    },
  };
}

export const env: EnvConfig = loadEnv();
