import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Problem } from '@datasentinel/contracts';
import type { Request, Response } from 'express';
import { scrubSecrets } from './logging/logging.js';

/** An error the client may see: stable code plus safe, actionable text. */
export class ProblemException extends HttpException {
  constructor(
    status: number,
    readonly code: string,
    title: string,
    readonly detail?: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(title, status);
  }
}

/** The 4xx status of a framework error, or undefined for anything else. */
function clientErrorStatus(error: unknown): number | undefined {
  const status =
    error instanceof HttpException
      ? error.getStatus()
      : typeof error === 'object' && error !== null
        ? (error as { status?: unknown }).status
        : undefined;
  return typeof status === 'number' && status >= 400 && status < 500 ? status : undefined;
}

/** Every error leaves as application/problem+json (docs/04). Unexpected
 * errors become a generic 500: their messages can contain internals. */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger('Problem');

  catch(error: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const req = http.getRequest<Request & { id?: string }>();
    const res = http.getResponse<Response>();

    let problem: Omit<Problem, 'instance'>;
    if (error instanceof ProblemException) {
      problem = {
        type: 'about:blank',
        title: error.message,
        status: error.getStatus(),
        code: error.code,
      };
      if (error.detail !== undefined) problem.detail = error.detail;
      for (const [name, value] of Object.entries(error.headers)) res.setHeader(name, value);
    } else if (clientErrorStatus(error) !== undefined) {
      // Framework errors: 404 for an unknown route (Nest), or a malformed
      // or oversized body (Express body-parser, not an HttpException).
      // The title is generic: the raw message may echo the input.
      const status = clientErrorStatus(error) ?? HttpStatus.BAD_REQUEST;
      problem = {
        type: 'about:blank',
        title: status === 404 ? 'Not found.' : 'The request could not be processed.',
        status,
        code: `http_${status}`,
      };
    } else {
      const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
      this.logger.error(scrubSecrets(text));
      problem = {
        type: 'about:blank',
        title: 'Something went wrong on our side.',
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        code: 'internal_error',
      };
    }
    res
      .status(problem.status)
      .type('application/problem+json')
      .json({ ...problem, instance: String(req.id ?? '') });
  }
}
