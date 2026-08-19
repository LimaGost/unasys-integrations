import { Router, type Request, type Response } from "express";
import { env } from "../config/env";
import { requireDashboardAuth } from "../middleware/dashboardAuth";
import { getRecentActivity } from "../services/activityLog";
import { emailService } from "../container";
import { getBase44Status } from "../services/base44Client";
import { DASHBOARD_HTML } from "../services/dashboardHtml";
import { getGmailPollStatus } from "../services/gmailStatus";
import dashboardActionsRouter from "./dashboardActions";
import dashboardSettingsRouter from "./dashboardSettings";

const router = Router();

router.use(requireDashboardAuth);
router.use("/api/actions", dashboardActionsRouter);
router.use("/api/settings", dashboardSettingsRouter);

router.get("/api/status", (_req: Request, res: Response) => {
  const base44 = getBase44Status();
  const gmailPoll = getGmailPollStatus();

  res.json({
    service: "unasys-integrations",
    env: env.nodeEnv,
    uptimeSeconds: Math.round(process.uptime()),
    nodeVersion: process.version,
    memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    base44: {
      authenticated: base44.authenticated,
      lastAuthAt: base44.lastAuthAt,
      serviceEmail: base44.serviceEmail,
    },
    gmail: {
      configured: emailService.isConfigured(),
      pollIntervalMinutes: env.gmail.pollIntervalMinutes,
      lastRunAt: gmailPoll.lastRunAt,
      lastProcessed: gmailPoll.lastProcessed,
      lastError: gmailPoll.lastError,
    },
  });
});

router.get("/api/events", (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit) || 100, 300);
  res.json({ events: getRecentActivity(limit) });
});

router.get("/", (_req: Request, res: Response) => {
  res.type("html").send(DASHBOARD_HTML);
});

export default router;
