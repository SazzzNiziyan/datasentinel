import type { CookieOptions } from 'express';
import { createHash, randomBytes } from 'node:crypto';

export const SESSION_COOKIE = 'ds_session';
export const SESSION_DAYS = 7;

/** 256 random bits: unguessable, so a fast hash is enough to store it. */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Reads one cookie from the raw header (no cookie-parser dependency). */
export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=') || undefined;
  }
  return undefined;
}

/** The session cookie: not readable by scripts; sent on same-site requests. */
export function sessionCookieOptions(secure: boolean): CookieOptions {
  return { httpOnly: true, sameSite: 'lax', secure, path: '/' };
}
