import type { SlaAutomationSummary, SlaBreachSummary } from "../application/SlaAutomationService";

export interface SlaCheckStatus {
  lastRunAt?: string;
  lastResult?: SlaAutomationSummary;
  lastError?: string;
}

export interface SlaBreachStatus {
  lastRunAt?: string;
  lastResult?: SlaBreachSummary;
  lastError?: string;
}

let checkStatus: SlaCheckStatus = {};
let breachStatus: SlaBreachStatus = {};

export function recordSlaCheckSuccess(result: SlaAutomationSummary): void {
  checkStatus = { lastRunAt: new Date().toISOString(), lastResult: result, lastError: undefined };
}

export function recordSlaCheckError(message: string): void {
  checkStatus = { ...checkStatus, lastRunAt: new Date().toISOString(), lastError: message };
}

export function recordSlaBreachSuccess(result: SlaBreachSummary): void {
  breachStatus = { lastRunAt: new Date().toISOString(), lastResult: result, lastError: undefined };
}

export function recordSlaBreachError(message: string): void {
  breachStatus = { ...breachStatus, lastRunAt: new Date().toISOString(), lastError: message };
}

export function getSlaStatus(): { check: SlaCheckStatus; breach: SlaBreachStatus } {
  return { check: checkStatus, breach: breachStatus };
}
