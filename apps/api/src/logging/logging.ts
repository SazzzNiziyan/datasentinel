import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Params } from 'nestjs-pino';
import type { DestinationStream, Level } from 'pino';

export const REQUEST_ID_HEADER = 'x-request-id';

/** A caller's ID is reused only if it cannot inject anything into logs. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Reuses a safe incoming x-request-id or makes a new one, and returns it
 * on the response so clients can quote it to support. */
export function requestId(req: IncomingMessage, res: ServerResponse): string {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const id =
    typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader(REQUEST_ID_HEADER, id);
  return id;
}

/** Credentials inside URLs, e.g. postgresql://user:password@host. */
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^/\s@]*@/gi;

/** Removes credentials from free text such as driver error messages. */
export function scrubSecrets(text: string): string {
  return text.replace(URL_CREDENTIALS, '$1[redacted]@');
}

/** Field names censored anywhere in a log entry, as a second line of
 * defense: code should not log secrets in the first place. */
const REDACT_PATHS = [
  'password',
  'secret',
  'token',
  'accessToken',
  'refreshToken',
  'apiKey',
  'authorization',
  'cookie',
  'connectionString',
].flatMap((name) => [name, `*.${name}`, `*.*.${name}`]);

interface SerializedRequest {
  id: string;
  method: string;
  url: string;
}

interface SerializedError {
  type?: string;
  message?: string;
  stack?: string;
}

export interface LoggingOptions {
  logLevel: Level | 'silent';
  /** Where log lines go; stdout when omitted. Tests pass a collector. */
  logStream?: DestinationStream;
}

/** Structured JSON logs: one line per request with its ID, never headers
 * or query strings (they carry cookies, tokens, and OAuth codes). */
export function loggerParams({ logLevel, logStream }: LoggingOptions): Params {
  const options = {
    level: logLevel,
    genReqId: requestId,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    serializers: {
      req: (req: SerializedRequest) => ({
        id: req.id,
        method: req.method,
        path: req.url.split('?')[0],
      }),
      res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      err: (err: SerializedError) => ({
        type: err.type,
        message: err.message === undefined ? undefined : scrubSecrets(err.message),
        stack: err.stack === undefined ? undefined : scrubSecrets(err.stack),
      }),
    },
  };
  return { pinoHttp: logStream === undefined ? options : [options, logStream] };
}
