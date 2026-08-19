import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env";

/**
 * Exige que o corpo da requisicao inclua `confirmPassword` igual a senha do
 * painel, como uma segunda confirmacao antes de aplicar mudancas sensiveis
 * (credenciais do Gmail, tokens de webhook, integracoes). O login do painel
 * (HTTP Basic, ja exigido em todas as rotas de /dashboard) prova quem esta
 * fazendo a chamada; isto prova que a pessoa quer mesmo aplicar esta mudanca
 * especifica agora.
 */
export function requireDashboardPasswordConfirmation(req: Request, res: Response, next: NextFunction): void {
  const provided = typeof req.body?.confirmPassword === "string" ? req.body.confirmPassword : undefined;

  if (!env.dashboard.password || !provided || provided !== env.dashboard.password) {
    res.status(403).json({
      error: "Forbidden",
      message: "Confirmacao invalida: digite a senha do painel para aplicar esta mudanca.",
    });
    return;
  }

  next();
}
