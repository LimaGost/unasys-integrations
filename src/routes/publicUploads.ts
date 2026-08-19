import { timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import multer from "multer";
import { asyncHandler } from "../middleware/asyncHandler";
import { getConfig } from "../services/configStore";
import { UPLOADS_DIR, saveUploadedFile, safeExtension } from "../services/uploadStorage";

export { UPLOADS_DIR };

const router = Router();

/**
 * Upload de anexos chamado DIRETO do navegador pelo frontend do Ticket
 * (Base44) - sem passar por nenhuma function/integration do Base44 (mesmo
 * motivo e mesma arquitetura de routes/publicEmailSend.ts: evitar "credito
 * de integracao" la a cada anexo/imagem colada).
 *
 * O contrato de resposta ({ file_url }) espelha
 * `base44.integrations.Core.UploadFile`, para o codigo do Base44 so precisar
 * trocar a chamada, sem mudar o resto da logica.
 */
const ALLOWED_ORIGINS = ["https://unasystickets.base44.app", "https://preview--unasystickets.base44.app"];
const TOKEN_HEADER = "x-app-token";
const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;

function applyCors(req: Request, res: Response): boolean {
  const origin = req.header("origin");
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
    return false;
  }
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", `Content-Type, ${TOKEN_HEADER}`);
  return true;
}

router.options("/upload", (req: Request, res: Response) => {
  if (!applyCors(req, res)) {
    res.status(403).end();
    return;
  }
  res.status(204).end();
});

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;
const recentRequests = new Map<string, number[]>();

/** Mesmo limitador simples em memoria usado em publicEmailSend.ts. */
function isRateLimited(key: string): boolean {
  const now = Date.now();
  const timestamps = (recentRequests.get(key) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  timestamps.push(now);
  recentRequests.set(key, timestamps);
  return timestamps.length > RATE_LIMIT_MAX;
}

function tokensMatch(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES, files: 1 },
});

router.post(
  "/upload",
  asyncHandler(async (req: Request, res: Response) => {
    if (!applyCors(req, res)) {
      res.status(403).json({ error: "Forbidden", message: "Origem nao autorizada." });
      return;
    }

    const expectedToken = getConfig().webhookTokens.attachments.token;
    if (!expectedToken) {
      res.status(503).json({
        error: "ServiceUnavailable",
        message: "Token de anexos ainda nao foi gerado (ver painel /dashboard).",
      });
      return;
    }

    const provided = req.header(TOKEN_HEADER);
    if (!provided || !tokensMatch(provided, expectedToken)) {
      res.status(401).json({ error: "Unauthorized", message: "Token invalido." });
      return;
    }

    if (isRateLimited(expectedToken)) {
      res.status(429).json({ error: "TooManyRequests", message: "Muitos uploads em pouco tempo. Aguarde um instante." });
      return;
    }

    upload.single("file")(req, res, async (err: unknown) => {
      if (err) {
        const message =
          err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE"
            ? `Arquivo maior que o limite de ${MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB.`
            : "Falha ao processar o upload.";
        res.status(400).json({ error: "BadRequest", message });
        return;
      }

      const file = req.file;
      if (!file) {
        res.status(400).json({ error: "BadRequest", message: "Nenhum arquivo enviado (campo 'file' ausente)." });
        return;
      }

      const filename = await saveUploadedFile(file.buffer, safeExtension(file.originalname));

      const origin = `${req.protocol}://${req.get("host")}`;
      res.status(200).json({ file_url: `${origin}/uploads/${filename}` });
    });
  })
);

export default router;
