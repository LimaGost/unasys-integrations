import { Base44Error } from "@base44/sdk";
import express, { type NextFunction, type Request, type Response } from "express";
import morgan from "morgan";
import { env } from "./config/env";
import { activityLogger } from "./middleware/activityLogger";
import customIntegrationsRouter from "./routes/customIntegrations";
import dashboardRouter from "./routes/dashboard";
import gmailRouter, { runGmailPoll } from "./routes/gmail";
import publicEmailAdminRouter from "./routes/publicEmailAdmin";
import publicEmailSendRouter from "./routes/publicEmailSend";
import publicUploadsRouter, { UPLOADS_DIR } from "./routes/publicUploads";
import publicUsersRouter from "./routes/publicUsers";
import salesDataRouter from "./routes/salesData";
import { runSlaBreachCheck, runSlaCheck } from "./routes/slaChecks";
import { authenticateBase44Client } from "./services/base44Client";
import { loadConfigStore } from "./services/configStore";
import { emailService } from "./container";
import type { HealthCheckResponse } from "./types";

const app = express();

/**
 * Roda atras do proxy reverso (Nginx/CloudPanel) - sem isso, req.protocol
 * sempre reporta "http" (o proxy fala HTTP com o processo Node por dentro),
 * mesmo quando o cliente usou HTTPS. Isso gerava file_url http:// em
 * routes/publicUploads.ts, bloqueado como "mixed content" pelo navegador
 * numa pagina https (o app do Base44).
 */
app.set("trust proxy", 1);

app.use(express.json());
app.use(morgan(env.nodeEnv === "production" ? "combined" : "dev"));
app.use(activityLogger);

app.get("/", (_req, res) => {
  res.redirect("/dashboard");
});

app.get("/health", (_req, res) => {
  const body: HealthCheckResponse = {
    status: "ok",
    timestamp: new Date().toISOString(),
  };
  res.status(200).json(body);
});

app.use("/webhooks/gmail", gmailRouter);
app.use("/webhooks/sales-data", salesDataRouter);
app.use("/webhooks/custom", customIntegrationsRouter);
app.use("/public/email", publicEmailSendRouter);
app.use("/public/email-admin", publicEmailAdminRouter);
app.use("/public/users", publicUsersRouter);
app.use("/public/uploads", publicUploadsRouter);
app.use("/uploads", express.static(UPLOADS_DIR, { maxAge: "365d", index: false }));
app.use("/dashboard", dashboardRouter);

app.use((_req, res) => {
  res.status(404).json({ error: "Not Found", message: "Rota inexistente." });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[unasys-integrations] erro nao tratado:", err);

  if (err instanceof Base44Error) {
    res.status(err.status || 500).json({ error: "Base44Error", message: err.message });
    return;
  }

  res.status(500).json({
    error: "InternalServerError",
    message: err instanceof Error ? err.message : "Erro desconhecido.",
  });
});

/**
 * O intervalo e sempre agendado (independente de o Gmail ja estar
 * configurado no boot), porque as credenciais podem ser adicionadas depois,
 * em tempo real, pelo painel (secao Configuracoes) - cada execucao confere
 * de novo se ja da pra rodar.
 */
function startGmailPoller(): void {
  const intervalMs = env.gmail.pollIntervalMinutes * 60 * 1000;
  console.log(
    `[gmail] poller agendado a cada ${env.gmail.pollIntervalMinutes} min (so roda quando o Gmail estiver configurado).`
  );

  setInterval(() => {
    if (!emailService.isConfigured()) return;

    runGmailPoll()
      .then((summary) => {
        if (summary.processed > 0) {
          console.log(`[gmail] poller processou ${summary.processed} mensagem(ns) nova(s).`);
        }
      })
      .catch((error: unknown) => {
        console.error("[gmail] falha ao verificar a caixa de entrada:", error instanceof Error ? error.message : error);
      });
  }, intervalMs);
}

/**
 * Substitui as automacoes agendadas "Verificar SLA e Executar Regras" e
 * "Verificar SLA Estourado e Notificar" (30 em 30 min) que existiam no
 * Base44 - roda sempre (nao depende de nenhuma config externa, so dos dados
 * do proprio Base44 via SDK).
 */
function startSlaChecker(): void {
  const intervalMs = env.sla.checkIntervalMinutes * 60 * 1000;
  console.log(`[sla] verificacao de SLA agendada a cada ${env.sla.checkIntervalMinutes} min.`);

  setInterval(() => {
    runSlaCheck()
      .then((summary) => {
        if (summary.slaWarnings > 0 || summary.timeoutWarnings > 0) {
          console.log(
            `[sla] regras executadas: ${summary.slaWarnings} aviso(s) de SLA, ${summary.timeoutWarnings} timeout(s) de resposta (${summary.ticketsChecked} tickets verificados).`
          );
        }
      })
      .catch((error: unknown) => {
        console.error("[sla] falha ao executar regras de automacao:", error instanceof Error ? error.message : error);
      });

    runSlaBreachCheck()
      .then((summary) => {
        if (summary.notified > 0) {
          console.log(`[sla] SLA estourado: ${summary.notified} notificacao(oes) enviada(s) (${summary.ticketsChecked} tickets verificados).`);
        }
      })
      .catch((error: unknown) => {
        console.error("[sla] falha ao verificar SLA estourado:", error instanceof Error ? error.message : error);
      });
  }, intervalMs);
}

Promise.all([loadConfigStore(), authenticateBase44Client()])
  .then(() => {
    app.listen(env.port, () => {
      console.log(`unasys-integrations rodando na porta ${env.port} (${env.nodeEnv})`);
    });
    startGmailPoller();
    startSlaChecker();
  })
  .catch((error: unknown) => {
    console.error("Falha ao inicializar o servidor:", error);
    process.exit(1);
  });
