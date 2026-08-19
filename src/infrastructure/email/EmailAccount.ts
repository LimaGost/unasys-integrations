import { getConfig } from "../../services/configStore";

export interface EmailAccount {
  user: string;
  appPassword: string;
  smtpHost: string;
  smtpPort: number;
  imapHost: string;
  imapPort: number;
}

export class EmailAccountNotConfiguredError extends Error {
  constructor() {
    super("Integracao com email nao configurada: preencha usuario e senha no painel (/dashboard).");
    this.name = "EmailAccountNotConfiguredError";
  }
}

export function isEmailConfigured(): boolean {
  const { user, appPassword } = getConfig().gmail;
  return Boolean(user && appPassword);
}

export function currentEmailUser(): string | undefined {
  return getConfig().gmail.user;
}

/**
 * Historicamente so suportava Gmail - hoje aceita qualquer provedor
 * SMTP/IMAP (ex: email hospedado na Hostinger). Sem host customizado no
 * painel, assume os servidores do Gmail.
 */
export function requireEmailAccount(): EmailAccount {
  const { user, appPassword, smtpHost, smtpPort, imapHost, imapPort } = getConfig().gmail;
  if (!user || !appPassword) throw new EmailAccountNotConfiguredError();
  return {
    user,
    appPassword,
    smtpHost: smtpHost || "smtp.gmail.com",
    smtpPort: smtpPort || 465,
    imapHost: imapHost || "imap.gmail.com",
    imapPort: imapPort || 993,
  };
}
