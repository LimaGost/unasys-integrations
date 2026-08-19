import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env";

/**
 * Protege as rotas do painel (GET /dashboard) com HTTP Basic Auth simples.
 * Enquanto DASHBOARD_USER/DASHBOARD_PASSWORD nao estiverem configurados,
 * responde 503 em vez de deixar o painel acessivel sem senha.
 */
export function requireDashboardAuth(req: Request, res: Response, next: NextFunction): void {
  if (!env.dashboard.user || !env.dashboard.password) {
    res.status(503).json({
      error: "ServiceUnavailable",
      message: "Painel nao configurado. Preencha DASHBOARD_USER e DASHBOARD_PASSWORD no .env.",
    });
    return;
  }

  const header = req.header("authorization");
  if (header?.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf-8");
    const separatorIndex = decoded.indexOf(":");
    const user = decoded.slice(0, separatorIndex);
    const password = decoded.slice(separatorIndex + 1);
    if (user === env.dashboard.user && password === env.dashboard.password) {
      next();
      return;
    }
  }

  res.setHeader("WWW-Authenticate", 'Basic realm="unasys-integrations"');
  res.status(401).json({ error: "Unauthorized", message: "Credenciais do painel invalidas." });
}
