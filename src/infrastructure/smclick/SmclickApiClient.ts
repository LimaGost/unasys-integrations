import { getConfig } from "../../services/configStore";

export interface SmclickMessage {
  id: string;
  type: string;
  from_me: boolean;
  sent_at: string;
  sent_by?: { name?: string } | null;
  content?: Record<string, unknown>;
}

interface SmclickMessagePage {
  results: SmclickMessage[];
  next: string | null;
}

export interface SmclickAttendant {
  id?: string;
  name?: string;
  email?: string;
  principal?: boolean;
}

/** Retrato atual de um atendimento (nao o payload de um webhook) - usado pela sincronizacao sob demanda (botao no ticket). */
export interface SmclickChatDetails {
  id: string;
  protocol: number;
  status: string;
  attending_time?: number;
  waiting_time?: number;
  department?: { id?: string; name?: string };
  contact?: { name?: string; telephone?: string };
  attendant?: SmclickAttendant[];
}

interface SmclickChatPage {
  results: SmclickChatDetails[];
}

/** Protecao contra loop infinito se a API devolver `next` de forma inesperada (ciclo, etc). */
const MAX_PAGES = 20;

/**
 * Cliente HTTP para a API REST da SM Click (chamadas de SAIDA - diferente do
 * webhook de ENTRADA em routes/smclickWebhook.ts). So implementa o que e
 * usado ate agora: buscar o historico de mensagens de um atendimento (pra
 * montar o transcript) e o retrato atual de um atendimento por protocolo
 * (status/atendente/attending_time - usado pela sincronizacao sob demanda,
 * ver SmclickIntegrationService.syncTranscriptOnDemand).
 */
export class SmclickApiClient {
  /** Retrato atual do atendimento (status, atendente, attending_time) - null se o protocolo nao existir la. */
  async getChatByProtocol(protocol: number): Promise<SmclickChatDetails | null> {
    const { apiKey, baseUrl } = getConfig().smclickApi;
    if (!apiKey || !baseUrl) {
      throw new Error("Credenciais da API da SM Click ainda nao foram configuradas (ver painel /dashboard).");
    }

    const response = await fetch(`${baseUrl}/attendances/chats?protocol=${protocol}`, { headers: { "X-API-KEY": apiKey } });
    if (!response.ok) {
      throw new Error(`SM Click respondeu ${response.status} ao buscar o atendimento protocolo ${protocol}.`);
    }

    const page = (await response.json()) as SmclickChatPage;
    return page.results[0] ?? null;
  }

  async getChatMessages(protocol: number): Promise<SmclickMessage[]> {
    const { apiKey, baseUrl } = getConfig().smclickApi;
    if (!apiKey || !baseUrl) {
      throw new Error("Credenciais da API da SM Click ainda nao foram configuradas (ver painel /dashboard).");
    }

    const messages: SmclickMessage[] = [];
    let url: string | null = `${baseUrl}/attendances/chats/message?protocol=${protocol}`;
    let pages = 0;

    while (url && pages < MAX_PAGES) {
      const response = await fetch(url, { headers: { "X-API-KEY": apiKey } });
      if (!response.ok) {
        throw new Error(`SM Click respondeu ${response.status} ao buscar mensagens do protocolo ${protocol}.`);
      }

      const page = (await response.json()) as SmclickMessagePage;
      messages.push(...page.results);
      // Nos testes reais o `next` sempre veio como URL absoluta, mas nao
      // custa nada resolver contra baseUrl caso um dia venha so o caminho.
      url = page.next ? new URL(page.next, baseUrl).toString() : null;
      pages += 1;
    }

    return messages;
  }
}
