/**
 * Composition root: monta cada service uma unica vez, injetando suas
 * dependencias de infraestrutura. As rotas importam as instancias daqui em
 * vez de instanciar (ou de chamar funcoes soltas) - troca de implementacao
 * (ex: outro provedor de email) muda so este arquivo.
 */
import { EmailService } from "./application/EmailService";
import { UserDirectoryService } from "./application/UserDirectoryService";
import { ClientRepository } from "./infrastructure/base44/ClientRepository";
import { SyncStateRepository } from "./infrastructure/base44/SyncStateRepository";
import { TicketEmailRepository } from "./infrastructure/base44/TicketEmailRepository";
import { TicketRepository } from "./infrastructure/base44/TicketRepository";
import { UserRepository } from "./infrastructure/base44/UserRepository";
import { InboxReader } from "./infrastructure/email/InboxReader";
import { Mailer } from "./infrastructure/email/Mailer";

const ticketRepository = new TicketRepository();
const ticketEmailRepository = new TicketEmailRepository();
const clientRepository = new ClientRepository();
const syncStateRepository = new SyncStateRepository();
const userRepository = new UserRepository();

export const emailService = new EmailService(
  new Mailer(),
  new InboxReader(),
  ticketRepository,
  ticketEmailRepository,
  clientRepository,
  syncStateRepository
);

export const userDirectoryService = new UserDirectoryService(userRepository);
