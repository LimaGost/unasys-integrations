import { timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler";
import { findCustomIntegration } from "../services/configStore";

const router = Router();

function tokensMatch(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

/**
 * Endpoint generico para integracoes cadastradas pelo painel sem codigo
 * dedicado ainda. So autentica pelo token e registra o payload recebido no
 * log de atividade (GET /dashboard) - nao grava nada no Base44. Serve para
 * capturar o formato real de um payload novo antes de implementar a logica
 * de negocio de verdade para ele.
 */
router.post(
  "/:slug",
  asyncHandler(async (req: Request, res: Response) => {
    const integration = req.params.slug ? findCustomIntegration(req.params.slug) : undefined;
    if (!integration) {
      res.status(404).json({ error: "NotFound", message: "Integracao desconhecida." });
      return;
    }

    const provided = req.header("x-webhook-token");
    if (!provided || !tokensMatch(provided, integration.token)) {
      res.status(401).json({ error: "Unauthorized", message: "Token de webhook invalido." });
      return;
    }

    const preview = JSON.stringify(req.body ?? {}).slice(0, 300);
    res.status(200).json({
      message: `Payload recebido em "${integration.name}" e registrado no log. Peca para o desenvolvedor implementar o processamento: ${preview}`,
      received: true,
    });
  })
);

export default router;
