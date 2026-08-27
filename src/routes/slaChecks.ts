import { slaAutomationService } from "../container";
import {
  recordSlaBreachError,
  recordSlaBreachSuccess,
  recordSlaCheckError,
  recordSlaCheckSuccess,
} from "../services/slaStatus";
import type { SlaAutomationSummary, SlaBreachSummary } from "../application/SlaAutomationService";

/** Roda a checagem de regras de automacao (aviso de SLA + timeout de resposta), gravando o resultado para o painel. Usada tanto pelo scheduler (index.ts) quanto pela rota manual do painel. */
export async function runSlaCheck(): Promise<SlaAutomationSummary> {
  try {
    const summary = await slaAutomationService.checkSlaAndAutomation();
    recordSlaCheckSuccess(summary);
    return summary;
  } catch (error) {
    recordSlaCheckError(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/** Roda a checagem de SLA estourado, gravando o resultado para o painel. */
export async function runSlaBreachCheck(): Promise<SlaBreachSummary> {
  try {
    const summary = await slaAutomationService.checkSlaBreached();
    recordSlaBreachSuccess(summary);
    return summary;
  } catch (error) {
    recordSlaBreachError(error instanceof Error ? error.message : String(error));
    throw error;
  }
}
