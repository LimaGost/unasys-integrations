import type { NextFunction, Request, Response } from "express";
import { recordActivity } from "../services/activityLog";

/** Campos da resposta que valem a pena mostrar num resumo curto no painel. */
const SUMMARY_FIELDS = ["ticket_id", "ticket_email_id", "processed", "id", "error", "message"];

function summarizeBody(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const record = body as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of SUMMARY_FIELDS) {
    if (record[key] !== undefined && record[key] !== null) {
      parts.push(`${key}=${String(record[key]).slice(0, 140)}`);
    }
  }
  return parts.join(" · ");
}

/**
 * Leituras do proprio painel (pagina, auto-refresh de status/eventos, carregar
 * a tela de configuracoes) - ignoradas para nao poluir o log com elas mesmas.
 * So GET exato nestas rotas e ignorado: qualquer POST/DELETE (acoes, salvar
 * configuracao, regenerar token, etc.) e sempre registrado normalmente.
 */
const DASHBOARD_READ_PATHS = new Set(["/dashboard", "/dashboard/api/status", "/dashboard/api/events", "/dashboard/api/settings"]);

function isDashboardReadRoute(req: Request): boolean {
  return req.method === "GET" && DASHBOARD_READ_PATHS.has(req.path);
}

/**
 * Registra toda requisicao (metodo, rota, status, duracao e um resumo da
 * resposta) no log de atividade em memoria, para o painel em GET /dashboard.
 */
export function activityLogger(req: Request, res: Response, next: NextFunction): void {
  // Captura o caminho JA no inicio: sub-roteadores (ex: /dashboard/api/actions)
  // reescrevem req.url/req.path enquanto despacham, entao le-lo depois (no
  // finish do response) pode devolver so um pedaco do caminho original.
  const path = req.path;

  if (path === "/health" || isDashboardReadRoute(req)) {
    next();
    return;
  }

  const start = Date.now();
  const originalJson = res.json.bind(res);
  let responseBody: unknown;

  res.json = ((body: unknown) => {
    responseBody = body;
    return originalJson(body);
  }) as typeof res.json;

  res.on("finish", () => {
    let summary = summarizeBody(responseBody);
    if (!summary && res.statusCode >= 300 && res.statusCode < 400) {
      const location = res.getHeader("location");
      if (location) {
        summary = `redirect→${String(location)}`;
      }
    }

    recordActivity({
      timestamp: new Date().toISOString(),
      method: req.method,
      path,
      statusCode: res.statusCode,
      durationMs: Date.now() - start,
      outcome: res.statusCode >= 400 ? "error" : "success",
      summary,
    });
  });

  next();
}
