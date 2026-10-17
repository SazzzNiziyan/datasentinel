import type { PrismaClient } from '@datasentinel/db';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { recordAudit, type RequestMeta } from '../audit/audit.js';
import { PRISMA } from '../db.js';
import { ProblemException } from '../problem.js';
import { hashPassword, verifyPassword } from './password.js';
import { RATE_LIMITER, type RateLimiter } from './rate-limit.js';
import { hashSessionToken, newSessionToken, SESSION_DAYS } from './session-token.js';

// Per IP: generous enough for an office behind one address. Per email and
// IP: the brake on guessing one account's password; keyed with the IP so
// a stranger cannot lock the real user out. Per email alone: a high
// ceiling against guessing spread over many addresses.
const PER_IP = { limit: 20, windowSeconds: 60 };
const PER_EMAIL_AND_IP = { limit: 5, windowSeconds: 15 * 60 };
const PER_EMAIL = { limit: 100, windowSeconds: 60 * 60 };

const tooManyAttempts = (waitSeconds: number) =>
  new ProblemException(
    HttpStatus.TOO_MANY_REQUESTS,
    'rate_limited',
    'Too many sign-in attempts.',
    `Wait ${Math.ceil(waitSeconds / 60)} minutes, then try again.`,
    { 'retry-after': String(waitSeconds) },
  );

const invalidCredentials = () =>
  new ProblemException(
    HttpStatus.UNAUTHORIZED,
    'invalid_credentials',
    'Email or password is incorrect.',
    'Check both and try again, or reset your password.',
  );

@Injectable()
export class AuthService {
  /** Checked when the email is unknown, so timing does not reveal which
   * accounts exist. Made once, lazily. */
  private dummyHash?: Promise<string>;

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
  ) {}

  async signIn(email: string, password: string, request: RequestMeta) {
    const { ip } = request;
    const normalized = email.trim().toLowerCase();
    // The IP is checked first, so a blocked address stops spending the
    // account's attempts.
    if (!(await this.limiter.consume(`signin:ip:${ip}`, PER_IP.limit, PER_IP.windowSeconds))) {
      throw tooManyAttempts(PER_IP.windowSeconds);
    }
    const [pairOk, emailOk] = await Promise.all([
      this.limiter.consume(
        `signin:email-ip:${normalized}:${ip}`,
        PER_EMAIL_AND_IP.limit,
        PER_EMAIL_AND_IP.windowSeconds,
      ),
      this.limiter.consume(`signin:email:${normalized}`, PER_EMAIL.limit, PER_EMAIL.windowSeconds),
    ]);
    if (!pairOk) throw tooManyAttempts(PER_EMAIL_AND_IP.windowSeconds);
    if (!emailOk) throw tooManyAttempts(PER_EMAIL.windowSeconds);

    const user = await this.prisma.user.findUnique({ where: { email: normalized } });
    this.dummyHash ??= hashPassword('dummy password for timing');
    const matches = await verifyPassword(password, user?.passwordHash ?? (await this.dummyHash));
    // One answer for unknown email, wrong password, and disabled account.
    if (user === null || user.passwordHash === null || !matches || user.status !== 'active') {
      // Rate-limited attempts are not audited: under attack they would
      // flood the table; the request log has them.
      await recordAudit(this.prisma, {
        action: 'auth.sign_in.failed',
        actor: user === null ? { type: 'anonymous' } : { type: 'user', id: user.id },
        request,
        summary: user === null ? { email: normalized } : {},
      });
      throw invalidCredentials();
    }

    const token = newSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
    const session = await this.prisma.session.create({
      data: { userId: user.id, tokenHash: hashSessionToken(token), expiresAt },
    });
    await recordAudit(this.prisma, {
      action: 'auth.sign_in.succeeded',
      actor: { type: 'user', id: user.id },
      request,
      target: { type: 'session', id: session.id },
    });
    return { token, expiresAt };
  }

  /** Revokes the session if it exists; signing out twice is not an error. */
  async signOut(token: string | undefined, request: RequestMeta) {
    if (token === undefined) return;
    const session = await this.prisma.session.findFirst({
      where: { tokenHash: hashSessionToken(token), revokedAt: null },
      select: { id: true, userId: true },
    });
    if (session === null) return;
    await this.prisma.session.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });
    await recordAudit(this.prisma, {
      action: 'auth.sign_out',
      actor: { type: 'user', id: session.userId },
      request,
      target: { type: 'session', id: session.id },
    });
  }
}
