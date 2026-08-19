export type ActivityOutcome = "success" | "error";

export interface ActivityEvent {
  id: number;
  timestamp: string;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  outcome: ActivityOutcome;
  summary: string;
}

/**
 * Log de atividade em memoria (nao persiste entre reinicios do processo).
 * Serve para o painel em GET /dashboard mostrar as requisicoes mais recentes
 * sem precisar de um banco de dados a parte.
 */
const MAX_EVENTS = 300;
const events: ActivityEvent[] = [];
let nextId = 1;

export function recordActivity(event: Omit<ActivityEvent, "id">): void {
  events.unshift({ id: nextId++, ...event });
  if (events.length > MAX_EVENTS) {
    events.length = MAX_EVENTS;
  }
}

export function getRecentActivity(limit = 100): ActivityEvent[] {
  return events.slice(0, Math.max(0, Math.min(limit, MAX_EVENTS)));
}
