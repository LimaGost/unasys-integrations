import { timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler";
import { userDirectoryService } from "../container";
import { getConfig } from "../services/configStore";

/**
 * NOVO, AINDA NAO LIGADO AO FRONTEND - Etapa 2 do plano de reducao de
 * credito (ver documento "Creditos de Integracao"). Mesma arquitetura do
 * /public/email/send: navegador chamaria isto DIRETO, sem passar pela
 * function `listInternalUsers` do Base44.
 *
 * Falta antes de expor isso de verdade:
 * 1. Validar que a conta de servico do Base44 realmente lista TODOS os
 *    usuarios (ver aviso em infrastructure/base44/UserRepository.ts) - sem
 *    isso, cada agente so veria a si mesmo.
 * 2. Gerar um token dedicado (webhookTokens) e um bloco no painel, como foi
 *    feito para emailButton.
 * 3. Editar os 8 pontos do frontend do Base44 que hoje chamam a function -
 *    bloqueado ate a conexao com o Base44 voltar.
 */
const ALLOWED_ORIGINS = ["https://unasystickets.base44.app", "https://preview--unasystickets.base44.app"];
const TOKEN_HEADER = "x-app-token";

const router = Router();

function applyCors(req: Request, res: Response): boolean {
  const origin = req.header("origin");
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return false;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", `Content-Type, ${TOKEN_HEADER}`);
  return true;
}

router.options("/list", (req: Request, res: Response) => {
  if (!applyCors(req, res)) {
    res.status(403).end();
    return;
  }
  res.status(204).end();
});

function tokensMatch(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

router.get(
  "/list",
  asyncHandler(async (req: Request, res: Response) => {
    if (!applyCors(req, res)) {
      res.status(403).json({ error: "Forbidden", message: "Origem nao autorizada." });
      return;
    }

    const expectedToken = getConfig().webhookTokens.userDirectory.token;
    if (!expectedToken) {
      res.status(503).json({ error: "ServiceUnavailable", message: "Token ainda nao configurado." });
      return;
    }

    const provided = req.header(TOKEN_HEADER);
    if (!provided || !tokensMatch(provided, expectedToken)) {
      res.status(401).json({ error: "Unauthorized", message: "Token invalido." });
      return;
    }

    const vertical = typeof req.query.vertical === "string" ? req.query.vertical : undefined;
    const users = vertical ? await userDirectoryService.listActiveByVertical(vertical) : await userDirectoryService.listAll();

    res.status(200).json({ users: users.map((u) => u.toJSON()) });
  })
);

export default router;
