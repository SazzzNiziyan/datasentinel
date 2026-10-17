import { SignInRequest } from '@datasentinel/contracts';
import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { CookieOptions, Request, Response } from 'express';
import { CurrentRequest, type RequestMeta } from '../audit/audit.js';
import { APP_OPTIONS, type AppOptions } from '../options.js';
import { ProblemException } from '../problem.js';
import { AuthService } from './auth.service.js';
import { Public } from './session.guard.js';
import { readCookie, SESSION_COOKIE, sessionCookieOptions } from './session-token.js';

/** POST /auth/sessions signs in; DELETE /auth/sessions/current signs out. */
// Public: signing in needs no session, and signing out must always work.
@Public()
@Controller('auth/sessions')
export class AuthController {
  private readonly cookie: CookieOptions;

  constructor(
    private readonly auth: AuthService,
    @Inject(APP_OPTIONS) options: AppOptions,
  ) {
    this.cookie = sessionCookieOptions(options.secureCookies);
  }

  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  async create(
    @Body() body: unknown,
    @CurrentRequest() request: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    const input = SignInRequest.safeParse(body);
    if (!input.success) {
      throw new ProblemException(
        HttpStatus.BAD_REQUEST,
        'invalid_request',
        'Enter an email address and a password.',
      );
    }
    const { token, expiresAt } = await this.auth.signIn(
      input.data.email,
      input.data.password,
      request,
    );
    res.cookie(SESSION_COOKIE, token, { ...this.cookie, expires: expiresAt });
  }

  @Delete('current')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Req() req: Request,
    @CurrentRequest() request: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.signOut(readCookie(req.headers.cookie, SESSION_COOKIE), request);
    res.clearCookie(SESSION_COOKIE, this.cookie);
  }
}
