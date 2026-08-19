/**
 * Corpo esperado em POST /webhooks/gmail/send.
 */
export interface SendGmailRequestBody {
  ticket_id: string;
  to: string[];
  subject: string;
  body: string;
  cc?: string[];
  bcc?: string[];
}
