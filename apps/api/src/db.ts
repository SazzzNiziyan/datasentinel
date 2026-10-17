import type { PrismaClient } from '@datasentinel/db';
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';

/** Injection token for the process-wide Prisma client. */
export const PRISMA = Symbol('PRISMA');

/** Closes the database pool when the app stops. */
@Injectable()
export class PrismaLifecycle implements OnApplicationShutdown {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async onApplicationShutdown() {
    await this.prisma.$disconnect();
  }
}
