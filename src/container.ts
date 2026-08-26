/**
 * Composition root: monta cada service uma unica vez, injetando suas
 * dependencias de infraestrutura. As rotas importam as instancias daqui em
 * vez de instanciar (ou de chamar funcoes soltas) - troca de implementacao
 * (ex: outro provedor de email) muda so este arquivo.
 */
import { EmailService } from "./application/EmailService";
import { NotificationService } from "./application/NotificationService";
import { SlaAutomationService } from "./application/SlaAutomationService";
import { UserDirectoryService } from "./application/UserDirectoryService";
import { AutomationRuleRepository } from "./infrastructure/base44/AutomationRuleRepository";
import { ClientRepository } from "./infrastructure/base44/ClientRepository";
import { KanbanConfigRepository } from "./infrastructure/base44/KanbanConfigRepository";
import { NotificationConfigRepository } from "./infrastructure/base44/NotificationConfigRepository";
import { NotificationRepository } from "./infrastructure/base44/NotificationRepository";
import { SyncStateRepository } from "./infrastructure/base44/SyncStateRepository";
import { TicketEmailRepository } from "./infrastructure/base44/TicketEmailRepository";
import { TicketEventRepository } from "./infrastructure/base44/TicketEventRepository";
import { TicketRepository } from "./infrastructure/base44/TicketRepository";
import { UserRepository } from "./infrastructure/base44/UserRepository";
import { InboxReader } from "./infrastructure/email/InboxReader";
import { Mailer } from "./infrastructure/email/Mailer";

const ticketRepository = new TicketRepository();
const ticketEmailRepository = new TicketEmailRepository();
const ticketEventRepository = new TicketEventRepository();
const clientRepository = new ClientRepository();
const syncStateRepository = new SyncStateRepository();
const userRepository = new UserRepository();
const kanbanConfigRepository = new KanbanConfigRepository();
const automationRuleRepository = new AutomationRuleRepository();
const notificationRepository = new NotificationRepository();
const notificationConfigRepository = new NotificationConfigRepository();

export const emailService = new EmailService(
  new Mailer(),
  new InboxReader(),
  ticketRepository,
  ticketEmailRepository,
  clientRepository,
  syncStateRepository
);

export const userDirectoryService = new UserDirectoryService(userRepository);

export const notificationService = new NotificationService(notificationRepository, notificationConfigRepository);

export const slaAutomationService = new SlaAutomationService(
  ticketRepository,
  kanbanConfigRepository,
  automationRuleRepository,
  ticketEventRepository,
  notificationService,
  userRepository,
  emailService
);
