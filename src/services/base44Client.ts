import { Base44Error, createClient, type Base44Client } from "@base44/sdk";
import { env } from "../config/env";

/**
 * Client do SDK oficial do Base44 (pacote `@base44/sdk`) usado para acessar
 * entities/functions do app Unasys Tickets a partir deste backend externo.
 *
 * O SDK so oferece "service role" (permissoes elevadas, sem regras de acesso)
 * dentro de backend functions hospedadas no proprio Base44
 * (`createClientFromRequest`). Como este servico roda fora do Base44, a
 * autenticacao e feita como um usuario comum dedicado a integracao, via
 * `base44.auth.loginViaEmailPassword`.
 */
export const base44: Base44Client = createClient({
  appId: env.base44.appId,
});

let authPromise: Promise<void> | null = null;
let authenticated = false;
let lastAuthAt: string | undefined;

async function login(): Promise<void> {
  await base44.auth.loginViaEmailPassword(env.base44.serviceEmail, env.base44.servicePassword);
  authenticated = true;
  lastAuthAt = new Date().toISOString();
  console.log(`[base44] autenticado com sucesso como "${env.base44.serviceEmail}"`);
}

/** Status atual da autenticacao com o Base44, para o painel em GET /dashboard. */
export function getBase44Status(): { authenticated: boolean; lastAuthAt?: string; serviceEmail: string } {
  return { authenticated, lastAuthAt, serviceEmail: env.base44.serviceEmail };
}

/**
 * Autentica o client Base44 com a conta de servico desta integracao.
 * Chamadas concorrentes compartilham a mesma tentativa de login em vez de
 * disparar logins duplicados. Deve ser aguardada uma vez na inicializacao
 * do servidor (ver src/index.ts) antes de qualquer requisicao usar `base44.*`.
 */
export function authenticateBase44Client(): Promise<void> {
  if (!authPromise) {
    authPromise = login().catch((error: unknown) => {
      authPromise = null;
      authenticated = false;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[base44] falha ao autenticar como "${env.base44.serviceEmail}": ${message}`);
      throw error;
    });
  }
  return authPromise;
}

/**
 * Retorna o client Base44 ja autenticado, aguardando o login em andamento
 * (ou disparando um novo, se o anterior falhou ou ainda nao ocorreu).
 */
export async function getBase44Client(): Promise<Base44Client> {
  await authenticateBase44Client();
  return base44;
}

function isAuthError(error: unknown): boolean {
  return error instanceof Base44Error && (error.status === 401 || error.status === 403);
}

const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 300;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Executa uma operacao contra o client Base44 autenticado. Se a chamada
 * falhar por token expirado/invalido (401/403), reautentica e tenta
 * novamente, com um pequeno backoff, ate `MAX_ATTEMPTS` tentativas no total.
 * Use esta funcao (em vez de `base44` diretamente) em toda a logica de
 * negocio das rotas, para que a reautenticacao seja automatica.
 */
export async function callBase44<T>(operation: (client: Base44Client) => Promise<T>): Promise<T> {
  const client = await getBase44Client();

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await operation(client);
    } catch (error) {
      const isLastAttempt = attempt === MAX_ATTEMPTS;
      if (!isAuthError(error) || isLastAttempt) {
        throw error;
      }
      console.warn(
        `[base44] token expirado/invalido (tentativa ${attempt}/${MAX_ATTEMPTS}), reautenticando...`
      );
      authPromise = null;
      authenticated = false;
      await delay(RETRY_BASE_DELAY_MS * attempt);
      await authenticateBase44Client();
    }
  }

  throw new Error("callBase44: numero maximo de tentativas excedido.");
}
