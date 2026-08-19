import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

const WEBHOOK_TOKEN_HEADER = "x-webhook-token";

function tokensMatch(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) {
    return false;
  }
  return timingSafeEqual(providedBuf, expectedBuf);
}

/**
 * Cria um middleware que exige um token secreto no header `x-webhook-token`,
 * validando-o contra `getExpectedToken()` (comparacao com tempo constante).
 * Deve ser aplicado antes de qualquer logica de negocio de rotas de webhook.
 *
 * Recebe uma funcao (nao o valor direto) porque o token pode ser trocado em
 * tempo real pelo painel (ver services/configStore.ts) - lendo-o so no
 * momento da requisicao, o middleware sempre usa o valor mais recente.
 */
export function requireWebhookToken(getExpectedToken: () => string | undefined) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const expectedToken = getExpectedToken();

    if (!expectedToken) {
      res.status(503).json({
        error: "ServiceUnavailable",
        message: "Token desta integracao ainda nao foi configurado (ver painel em /dashboard).",
      });
      return;
    }

    const provided = req.header(WEBHOOK_TOKEN_HEADER);

    if (!provided) {
      res.status(401).json({
        error: "Unauthorized",
        message: `Header "${WEBHOOK_TOKEN_HEADER}" ausente.`,
      });
      return;
    }

    if (!tokensMatch(provided, expectedToken)) {
      res.status(401).json({
        error: "Unauthorized",
        message: "Token de webhook invalido.",
      });
      return;
    }

    next();
  };
}
