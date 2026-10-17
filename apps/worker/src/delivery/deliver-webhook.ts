import {
  checkAddress,
  destinationContext,
  openSecret,
  type KeyRing,
  type NetworkPolicy,
} from '@datasentinel/connectors';
import type { PrismaClient } from '@datasentinel/db';
import { createHmac } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns';
import { request } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { deliverDue } from './deliver.js';
import { notificationLink, type DeliveryKind } from './email-template.js';

/** Thrown when a webhook host resolves to an address the network policy
 * forbids (D-91). */
export class BlockedAddress extends Error {
  constructor() {
    super('The webhook address is not allowed.');
    this.name = 'BlockedAddress';
  }
}

type Resolve = (hostname: string) => Promise<{ address: string; family: number }[]>;

const systemResolve: Resolve = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) =>
      error === null ? resolve(addresses) : reject(error),
    );
  });

/** Resolves a host and refuses it if ANY answer is a forbidden address, so
 * a name with one public and one private record cannot be used (D-91). */
export async function resolveAllowed(
  hostname: string,
  policy: NetworkPolicy,
  resolve: Resolve = systemResolve,
): Promise<{ address: string; family: number }[]> {
  const host = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
  const addresses = await resolve(host);
  if (
    addresses.length === 0 ||
    addresses.some((a) => checkAddress(a.address, policy) !== undefined)
  ) {
    throw new BlockedAddress();
  }
  return addresses;
}

/** A `lookup` for https.request that connects only to addresses that passed
 * the check, so the address checked is the address used: DNS cannot change
 * its answer between the check and the connection (D-91). */
export const guardedLookup =
  (policy: NetworkPolicy, resolve?: Resolve): LookupFunction =>
  (hostname, options, callback) => {
    resolveAllowed(hostname, policy, resolve).then(
      (addresses) => {
        if ('all' in options && options.all === true) {
          (callback as unknown as (e: null, a: typeof addresses) => void)(null, addresses);
        } else {
          callback(null, addresses[0]!.address, addresses[0]!.family);
        }
      },
      (error: unknown) => callback(error as NodeJS.ErrnoException, '', 0),
    );
  };

export type PostSigned = (
  url: string,
  headers: Record<string, string>,
  body: string,
  options: { timeoutMs: number; policy: NetworkPolicy },
) => Promise<{ status: number }>;

/** Real POST over https only: address guard, hard timeout, no redirects
 * followed, response body discarded (D-91). */
export const postSigned: PostSigned = (url, headers, body, { timeoutMs, policy }) =>
  new Promise((resolve, reject) => {
    // Node skips `lookup` for an IP literal, so check literals here.
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) !== 0 && checkAddress(host, policy) !== undefined) {
      reject(new BlockedAddress());
      return;
    }
    const req = request(
      url,
      {
        method: 'POST',
        headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) },
        lookup: guardedLookup(policy),
        signal: AbortSignal.timeout(timeoutMs),
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(body);
  });

/** HMAC-SHA256 over `${timestamp}.${body}`, hex, prefixed v1= (D-91). The
 * timestamp is inside the signed text, so a captured request cannot be
 * replayed later than the receiver's tolerance. */
export const signWebhook = (secret: string, timestamp: number, body: string): string =>
  `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;

/** The JSON a receiver gets: stable ids and the safe payload only (D-91). */
export function renderWebhookBody(input: {
  deliveryId: string;
  kind: DeliveryKind;
  createdAt: Date;
  payload: unknown;
  incidentId: string;
  webOrigin: string;
}): string {
  const p =
    typeof input.payload === 'object' && input.payload !== null
      ? (input.payload as Record<string, unknown>)
      : {};
  const str = (v: unknown) => (typeof v === 'string' ? v.slice(0, 200) : null);
  return JSON.stringify({
    id: input.deliveryId,
    type: input.kind,
    createdAt: input.createdAt.toISOString(),
    incident: {
      id: input.incidentId,
      title: str(p.title),
      severity: str(p.severity),
      datasetName: str(p.datasetName),
      url: notificationLink(input.webOrigin, input.kind, input.incidentId),
    },
  });
}

export interface WebhookDeliveryDeps {
  prisma: PrismaClient;
  ring: KeyRing;
  policy: NetworkPolicy;
  post: PostSigned;
  webOrigin: string;
  timeoutMs?: number;
  /** Tests only: limit to these workspaces. */
  workspaceIds?: string[];
}

/** Sends due webhook deliveries, signed (D-91). The signing secret is opened
 * from the sealed value only here; the stored address is re-checked against
 * the network policy at connection time. */
export function deliverWebhooks(
  deps: WebhookDeliveryDeps,
  now: Date,
  limit = 20,
  type: 'webhook' | 'n8n' = 'webhook',
) {
  return deliverDue(
    deps.prisma,
    type,
    now,
    limit,
    async ({ delivery, destination }, kind) => {
      const url = (destination.settings as { url?: string }).url;
      if (typeof url !== 'string' || !url.startsWith('https://')) {
        return { ok: false, retryable: false, reason: 'invalid_destination' };
      }
      let signingSecret: string | undefined;
      try {
        signingSecret = openSecret(
          deps.ring,
          {
            ciphertext: Buffer.from(destination.ciphertext ?? []),
            keyVersion: destination.keyVersion ?? 0,
          },
          destinationContext(destination.workspaceId, destination.id),
        ).signingSecret;
      } catch {
        return { ok: false, retryable: false, reason: 'secret_unavailable' };
      }
      if (signingSecret === undefined) {
        return { ok: false, retryable: false, reason: 'secret_unavailable' };
      }
      const body = renderWebhookBody({
        deliveryId: delivery.id,
        kind,
        createdAt: delivery.createdAt,
        payload: delivery.payload,
        incidentId: delivery.incidentId,
        webOrigin: deps.webOrigin,
      });
      const timestamp = Math.floor(now.getTime() / 1000);
      let response;
      try {
        response = await deps.post(
          url,
          {
            'content-type': 'application/json',
            'user-agent': 'DataSentinel-Webhook/1',
            'x-datasentinel-delivery': delivery.id,
            'x-datasentinel-timestamp': String(timestamp),
            'x-datasentinel-signature': signWebhook(signingSecret, timestamp, body),
          },
          body,
          { timeoutMs: deps.timeoutMs ?? 5000, policy: deps.policy },
        );
      } catch (error) {
        const name = error instanceof Error ? error.name : '';
        if (name === 'BlockedAddress') {
          return { ok: false, retryable: false, reason: 'address_blocked' };
        }
        const timedOut = name === 'TimeoutError' || name === 'AbortError';
        return {
          ok: false,
          retryable: true,
          reason: timedOut ? 'webhook_timeout' : 'webhook_unreachable',
        };
      }
      if (response.status >= 200 && response.status < 300) return { ok: true };
      return {
        ok: false,
        retryable: response.status === 429 || response.status >= 500,
        reason: `webhook_http_${response.status}`,
      };
    },
    deps.workspaceIds,
  );
}
