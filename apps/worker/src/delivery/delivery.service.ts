import type { KeyRing, NetworkPolicy } from '@datasentinel/connectors';
import type { PrismaClient } from '@datasentinel/db';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { deliverDisabled } from './deliver.js';
import { deliverEmails, type EmailTransport } from './deliver-email.js';
import { deliverGitHub } from './deliver-github.js';
import { deliverSlack, type PostJson } from './deliver-slack.js';
import { deliverWebhooks, type PostSigned } from './deliver-webhook.js';
import { fanOutOutbox } from './fan-out.js';

export const DELIVERY_DEPS = Symbol('DELIVERY_DEPS');

export interface DeliveryDeps {
  prisma: PrismaClient;
  email: EmailTransport;
  ring: KeyRing;
  post: PostJson;
  policy: NetworkPolicy;
  postWebhook: PostSigned;
  /** Optional destination types enabled here (D-96). */
  features: { github: boolean; n8n: boolean };
  webOrigin: string;
  /** Tests shorten it. */
  tickMs?: number;
}

/** Every 10 seconds: fan new outbox rows out to destinations, then send due
 * deliveries (D-89). Safe to run in several processes. */
@Injectable()
export class DeliveryService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(DeliveryService.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(@Inject(DELIVERY_DEPS) private readonly deps: DeliveryDeps) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), this.deps.tickMs ?? 10_000);
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  /** One pass; a pass still running when the next is due is not doubled. */
  async tick(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await fanOutOutbox(this.deps.prisma, now);
      await deliverEmails(this.deps, now);
      await deliverSlack(this.deps, now);
      const hooks = { ...this.deps, post: this.deps.postWebhook };
      await deliverWebhooks(hooks, now);
      // A disabled type fails visibly instead of waiting forever; turning the
      // flag back on lets an admin retry those deliveries (D-96).
      if (this.deps.features.n8n) await deliverWebhooks(hooks, now, 20, 'n8n');
      else await deliverDisabled(this.deps.prisma, 'n8n', now);
      if (this.deps.features.github) await deliverGitHub(this.deps, now);
      else await deliverDisabled(this.deps.prisma, 'github', now);
    } catch (error) {
      this.logger.error(`delivery pass failed: ${error instanceof Error ? error.name : 'error'}`);
    } finally {
      this.running = false;
    }
  }
}
