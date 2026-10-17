import type { PrismaClient } from '@datasentinel/db';
import {
  createParamDecorator,
  HttpStatus,
  Inject,
  Injectable,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { PRISMA } from '../db.js';
import { ProblemException } from '../problem.js';
import { hashSessionToken, readCookie, SESSION_COOKIE } from './session-token.js';

/** Who is calling, set by SessionGuard on every non-public request. */
export interface Principal {
  userId: string;
  sessionId: string;
}

type AuthedRequest = Request & { principal?: Principal };

const PUBLIC = 'datasentinel:public';

/** Marks a route (or controller) as reachable without signing in. Every
 * other route requires a session: new routes are protected by default. */
export const Public = () => SetMetadata(PUBLIC, true);

/** The signed-in caller, inside a protected route. */
export const CurrentPrincipal = createParamDecorator(
  (_: unknown, context: ExecutionContext): Principal => {
    const principal = context.switchToHttp().getRequest<AuthedRequest>().principal;
    if (principal === undefined) throw new Error('CurrentPrincipal used on a public route');
    return principal;
  },
);

/** The valid session named by the request's cookie header, or null:
 * not revoked, not expired, and its user is active. */
export async function findActiveSession(prisma: PrismaClient, cookieHeader: string | undefined) {
  const token = readCookie(cookieHeader, SESSION_COOKIE);
  if (token === undefined) return null;
  return prisma.session.findFirst({
    where: {
      tokenHash: hashSessionToken(token),
      revokedAt: null,
      expiresAt: { gt: new Date() },
      user: { status: 'active' },
    },
  });
}

/** lastUsedAt is refreshed at most this often, to spare a write per request. */
const TOUCH_AFTER_MS = 5 * 60 * 1000;

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const now = new Date();
    const session = await findActiveSession(this.prisma, req.headers.cookie);
    if (session === null) {
      throw new ProblemException(
        HttpStatus.UNAUTHORIZED,
        'not_signed_in',
        'Sign in to continue.',
        'Your session has ended or was signed out.',
      );
    }
    if (now.getTime() - session.lastUsedAt.getTime() > TOUCH_AFTER_MS) {
      await this.prisma.session.update({ where: { id: session.id }, data: { lastUsedAt: now } });
    }
    req.principal = { userId: session.userId, sessionId: session.id };
    return true;
  }
}
