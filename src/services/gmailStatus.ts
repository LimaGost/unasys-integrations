export interface GmailPollStatus {
  lastRunAt?: string;
  lastProcessed?: number;
  lastError?: string;
}

let status: GmailPollStatus = {};

export function recordGmailPollSuccess(processed: number): void {
  status = { lastRunAt: new Date().toISOString(), lastProcessed: processed, lastError: undefined };
}

export function recordGmailPollError(message: string): void {
  status = { ...status, lastRunAt: new Date().toISOString(), lastError: message };
}

export function getGmailPollStatus(): GmailPollStatus {
  return status;
}
