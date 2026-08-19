import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler";
import { emailService } from "../container";
import { currentEmailUser } from "../infrastructure/email/EmailAccount";
import { processSalesPayload } from "./salesData";
import { runGmailPoll } from "./gmail";

const router = Router();

function gmailNotConfiguredResponse(res: Response): void {
  res.status(503).json({
    error: "ServiceUnavailable",
    message: "Gmail nao configurado. Preencha usuario e senha de app no painel (secao Configuracoes).",
  });
}

/**
 * Cria um Ticket de teste (mesma logica de POST /webhooks/sales-data/receive)
 * para validar a integracao com o Base44 sem precisar de curl/Postman.
 */
router.post(
  "/test-sales-data",
  asyncHandler(async (_req: Request, res: Response) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const result = await processSalesPayload({
      order_number: `TESTE-PAINEL-${stamp}`,
      customer_code: "00.000.000/0001-00",
      client_name: "Teste via Painel",
      client_email: undefined,
      vertical: "retail",
      modulos: [],
      observacoes: "Ticket de teste criado pelo botao 'Criar ticket de teste' do painel.",
    });

    res.status(200).json({
      message: `Ticket ${result.status === 201 ? "criado" : "atualizado"} com sucesso.`,
      ticket_id: result.ticketId,
    });
  })
);

/** Forca uma verificacao imediata da caixa de entrada do Gmail. */
router.post(
  "/gmail-poll",
  asyncHandler(async (_req: Request, res: Response) => {
    if (!emailService.isConfigured()) {
      gmailNotConfiguredResponse(res);
      return;
    }

    const summary = await runGmailPoll();
    res.status(200).json({
      message: summary.processed > 0 ? `${summary.processed} mensagem(ns) nova(s) processada(s).` : "Nenhuma mensagem nova.",
      processed: summary.processed,
    });
  })
);

/** Envia um email de teste para a propria conta configurada, so pra validar o SMTP. */
router.post(
  "/test-gmail-send",
  asyncHandler(async (_req: Request, res: Response) => {
    if (!emailService.isConfigured()) {
      gmailNotConfiguredResponse(res);
      return;
    }

    const testId = randomUUID().slice(0, 8);
    const gmailUser = currentEmailUser() as string;
    await emailService.sendPlain({
      to: [gmailUser],
      subject: `Teste unasys-integrations #${testId}`,
      body: `Este e um email de teste disparado pelo painel em ${new Date().toLocaleString("pt-BR")}. Se voce recebeu isto, o envio via SMTP esta funcionando.`,
    });

    res.status(200).json({ message: `Email de teste enviado para ${gmailUser}.` });
  })
);

export default router;
