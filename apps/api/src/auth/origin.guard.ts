import {
  HttpStatus,
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import { APP_OPTIONS, type AppOptions } from '../options.js';
import { ProblemException } from '../problem.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** CSRF defence for cookie sessions (docs/05): a browser always sends
 * Origin on state-changing requests, so any other origin is refused. Also
 * stops login CSRF. Requests without Origin are not from a browser page. */
@Injectable()
export class OriginGuard implements CanActivate {
  constructor(@Inject(APP_OPTIONS) private readonly options: AppOptions) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const origin = req.headers.origin;
    if (SAFE_METHODS.has(req.method) || origin === undefined || origin === this.options.webOrigin) {
      return true;
    }
    throw new ProblemException(
      HttpStatus.FORBIDDEN,
      'origin_not_allowed',
      'This request came from a site that may not change data here.',
    );
  }
}
