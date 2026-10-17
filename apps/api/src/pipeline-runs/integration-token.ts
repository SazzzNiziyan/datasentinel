import { parseIntegrationToken, PIPELINE_EVENTS_PER_MINUTE } from '@datasentinel/contracts';
import type { PrismaClient } from '@datasentinel/db';
import {
  createParamDecorator,
  HttpStatus,
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { RATE_LIMITER, type RateLimiter } from '../auth/rate-limit.js';
import { PRISMA } from '../db.js';
import { ProblemException } from '../problem.js';

/** Who is calling an integration route: fixed by the token alone (D-73). */
export interface Integration {
  tokenId: string;
  workspaceId: string;
  sourceId: string;
}

type IntegrationRequest = Request & { integration?: Integration };

export const hashTokenSecret = (secret: string) => createHash('sha256').update(secret).digest();

/** A new token: the row ID, the hash to store, and the text shown once. */
export function newIntegrationToken() {
  const id = randomUUID();
  const secret = randomBytes(32).toString('base64url');
  return { id, hash: hashTokenSecret(secret), token: `dsp_${id.replaceAll('-', '')}_${secret}` };
}

export const CurrentIntegration = createParamDecorator(
  (_: unknown, context: ExecutionContext): Integration => {
    const integration = context.switchToHttp().getRequest<IntegrationRequest>().integration;
    if (integration === undefined) throw new Error('CurrentIntegration used without its guard');
    return integration;
  },
);

/** lastUsedAt is refreshed at most this often. */
const TOUCH_AFTER_MS = 5 * 60 * 1000;

const invalid = () =>
  new ProblemException(
    HttpStatus.UNAUTHORIZED,
    'invalid_token',
    'The integration token is missing, wrong, or revoked.',
  );

/** Authenticates `Authorization: Bearer dsp_…` and rate-limits per token
 * (D-73). Every failure looks the same, so tokens cannot be probed. */
@Injectable()
export class IntegrationTokenGuard implements CanActivate {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<IntegrationRequest>();
    const parsed = parseIntegrationToken(req.headers.authorization);
    if (parsed === null) throw invalid();
    const row = await this.prisma.integrationToken.findUnique({
      where: { id: parsed.tokenId },
      select: {
        workspaceId: true,
        sourceId: true,
        secretHash: true,
        revokedAt: true,
        expiresAt: true,
        lastUsedAt: true,
      },
    });
    const given = hashTokenSecret(parsed.secret);
    if (
      row === null ||
      row.revokedAt !== null ||
      (row.expiresAt !== null && row.expiresAt.getTime() <= Date.now()) ||
      !timingSafeEqual(Buffer.from(row.secretHash), given)
    ) {
      throw invalid();
    }
    if (
      !(await this.limiter.consume(`pipeline:${parsed.tokenId}`, PIPELINE_EVENTS_PER_MINUTE, 60))
    ) {
      throw new ProblemException(
        HttpStatus.TOO_MANY_REQUESTS,
        'rate_limited',
        'Too many pipeline events.',
        `Each token may send ${PIPELINE_EVENTS_PER_MINUTE} requests a minute. Try again shortly.`,
      );
    }
    const now = new Date();
    if (row.lastUsedAt === null || now.getTime() - row.lastUsedAt.getTime() > TOUCH_AFTER_MS) {
      await this.prisma.integrationToken.update({
        where: { id: parsed.tokenId },
        data: { lastUsedAt: now },
      });
    }
    req.integration = {
      tokenId: parsed.tokenId,
      workspaceId: row.workspaceId,
      sourceId: row.sourceId,
    };
    return true;
  }
}
