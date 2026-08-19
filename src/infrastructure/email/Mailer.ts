import nodemailer, { type Transporter } from "nodemailer";
import { requireEmailAccount } from "./EmailAccount";

export interface OutgoingMessage {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  html?: string;
  text?: string;
  attachments?: Array<{ filename: string; content: Buffer }>;
  /** Message-ID do email que este esta respondendo, se houver (ver TicketEmailThread). */
  inReplyTo?: string;
  senderName?: string;
}

export interface SentMessage {
  messageId: string;
}

/**
 * Responsavel unico: falar SMTP. Nao sabe nada sobre Ticket, Base44 ou
 * threading de negocio - so envia o que mandarem enviar. O client SMTP e
 * reaproveitado entre chamadas, mas recriado se as credenciais/servidor
 * mudarem (ex: senha trocada pelo painel em tempo real).
 */
export class Mailer {
  private transporter: Transporter | null = null;
  private transporterKey: string | null = null;

  private getTransporter(): Transporter {
    const { user, appPassword, smtpHost, smtpPort } = requireEmailAccount();
    const key = `${user}@${smtpHost}:${smtpPort}`;

    if (!this.transporter || this.transporterKey !== key) {
      this.transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: true,
        auth: { user, pass: appPassword },
      });
      this.transporterKey = key;
    }

    return this.transporter;
  }

  async send(message: OutgoingMessage): Promise<SentMessage> {
    const { user } = requireEmailAccount();
    const from = message.senderName ? `"${message.senderName.replace(/"/g, "")}" <${user}>` : user;

    const info = await this.getTransporter().sendMail({
      from,
      to: message.to.join(", "),
      cc: message.cc?.length ? message.cc.join(", ") : undefined,
      bcc: message.bcc?.length ? message.bcc.join(", ") : undefined,
      subject: message.subject,
      html: message.html,
      text: message.text,
      attachments: message.attachments,
      inReplyTo: message.inReplyTo,
      references: message.inReplyTo,
    });

    return { messageId: info.messageId };
  }

  /**
   * Envia uma mensagem MIME ja pronta (formato "raw" da Gmail API, base64url) -
   * usada para repassar mensagens montadas em outro lugar (ex: pela function
   * `sendEmailGmail` do Base44, hoje sem uso mas mantida por compatibilidade).
   * O nodemailer nao le destinatarios de dentro do `raw`, entao o envelope
   * SMTP precisa ser informado a parte.
   */
  async sendRaw(rawBase64Url: string, to: string[], cc: string[] = [], bcc: string[] = []): Promise<SentMessage> {
    const { user } = requireEmailAccount();
    const normalized = rawBase64Url.replace(/-/g, "+").replace(/_/g, "/");
    const raw = Buffer.from(normalized, "base64").toString("utf-8");

    const info = await this.getTransporter().sendMail({
      raw,
      envelope: { from: user, to: [...to, ...cc, ...bcc] },
    });

    return { messageId: info.messageId };
  }

  async downloadAttachment(url: string, filename: string): Promise<{ filename: string; content: Buffer }> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Falha ao baixar anexo "${filename}": HTTP ${response.status}`);
    }
    return { filename, content: Buffer.from(await response.arrayBuffer()) };
  }
}
