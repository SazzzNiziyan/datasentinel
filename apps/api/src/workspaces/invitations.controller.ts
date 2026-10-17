import {
  AcceptInvitationRequest,
  CreateInvitationRequest,
  InvitationTokenRequest,
  type InvitationCreated,
  type InvitationPreview,
  type PendingInvitation,
  type WorkspaceSummary,
} from '@datasentinel/contracts';
import type { PrismaClient } from '@datasentinel/db';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { CurrentRequest, recordAudit, type RequestMeta } from '../audit/audit.js';
import { AuthService } from '../auth/auth.service.js';
import { hashPassword } from '../auth/password.js';
import {
  CurrentPrincipal,
  findActiveSession,
  Public,
  type Principal,
} from '../auth/session.guard.js';
import {
  hashSessionToken,
  newSessionToken,
  SESSION_COOKIE,
  sessionCookieOptions,
} from '../auth/session-token.js';
import { PRISMA } from '../db.js';
import { APP_OPTIONS, type AppOptions } from '../options.js';
import { ProblemException } from '../problem.js';
import {
  CurrentWorkspace,
  hasRole,
  isUuid,
  RequireRole,
  type WorkspaceAccess,
} from './workspace.guard.js';

const INVITATION_DAYS = 7;

const problem = (status: HttpStatus, code: string, title: string, detail?: string) =>
  new ProblemException(status, code, title, detail);

/** One answer for unknown, expired, revoked, and used links. */
const invalidLink = () =>
  problem(
    HttpStatus.NOT_FOUND,
    'invitation_invalid',
    'This invitation link is not valid.',
    'It may have expired, been replaced, or already been used. Ask for a new link.',
  );

/** Admin side: invite, list pending, revoke (D-40). */
@RequireRole('admin')
@Controller('workspaces/:workspaceId/invitations')
export class InvitationsController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(APP_OPTIONS) private readonly options: AppOptions,
  ) {}

  @Post()
  async create(
    @CurrentWorkspace() access: WorkspaceAccess,
    @CurrentPrincipal() principal: Principal,
    @CurrentRequest() request: RequestMeta,
    @Body() body: unknown,
  ): Promise<InvitationCreated> {
    const input = CreateInvitationRequest.safeParse(body);
    if (!input.success) {
      throw problem(
        HttpStatus.BAD_REQUEST,
        'invalid_request',
        'Enter an email address and a role.',
      );
    }
    const email = input.data.email.trim().toLowerCase();
    const { role } = input.data;
    if (!hasRole(access.role, role)) {
      throw problem(HttpStatus.FORBIDDEN, 'role_ceiling', 'You cannot give a role above your own.');
    }
    if (role === 'owner' && access.role !== 'owner') {
      throw problem(HttpStatus.FORBIDDEN, 'owner_only', 'Only an owner can invite owners.');
    }
    const member = await this.prisma.membership.findFirst({
      where: { workspaceId: access.workspaceId, status: 'active', user: { email } },
      select: { id: true },
    });
    if (member !== null) {
      throw problem(HttpStatus.CONFLICT, 'already_member', 'This person is already a member.');
    }

    const token = newSessionToken();
    const expiresAt = new Date(Date.now() + INVITATION_DAYS * 24 * 60 * 60 * 1000);
    const invitation = await this.prisma.$transaction(async (tx) => {
      // A new link replaces any earlier pending one for the same email.
      await tx.invitation.updateMany({
        where: { workspaceId: access.workspaceId, email, acceptedAt: null, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      const created = await tx.invitation.create({
        data: {
          workspaceId: access.workspaceId,
          email,
          role,
          tokenHash: hashSessionToken(token),
          invitedByMembershipId: access.membershipId,
          expiresAt,
        },
      });
      await recordAudit(tx, {
        action: 'member.invited',
        actor: { type: 'user', id: principal.userId },
        request,
        workspaceId: access.workspaceId,
        target: { type: 'invitation', id: created.id },
        summary: { after: { email, role } },
      });
      return created;
    });
    return {
      id: invitation.id,
      email,
      role,
      expiresAt: expiresAt.toISOString(),
      acceptUrl: `${this.options.webOrigin}/invite#token=${token}`,
    };
  }

  @Get()
  async pending(@CurrentWorkspace() access: WorkspaceAccess): Promise<PendingInvitation[]> {
    const rows = await this.prisma.invitation.findMany({
      where: {
        workspaceId: access.workspaceId,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        email: true,
        role: true,
        expiresAt: true,
        invitedBy: { select: { user: { select: { displayName: true } } } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      role: r.role,
      expiresAt: r.expiresAt.toISOString(),
      invitedByName: r.invitedBy.user.displayName,
    }));
  }

  @Delete(':invitationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(
    @CurrentWorkspace() access: WorkspaceAccess,
    @CurrentPrincipal() principal: Principal,
    @CurrentRequest() request: RequestMeta,
    @Param('invitationId') invitationId: string,
  ) {
    if (!isUuid(invitationId)) throw invalidLink();
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.invitation.updateMany({
        where: {
          id: invitationId,
          workspaceId: access.workspaceId,
          acceptedAt: null,
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      });
      if (count === 0) throw invalidLink();
      await recordAudit(tx, {
        action: 'invitation.revoked',
        actor: { type: 'user', id: principal.userId },
        request,
        workspaceId: access.workspaceId,
        target: { type: 'invitation', id: invitationId },
      });
    });
  }
}

/** Invitee side: preview and accept. Public, because the invitee may not
 * have an account yet; the 256-bit token is the credential. */
@Public()
@Controller('invitations')
export class AcceptInvitationController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(APP_OPTIONS) private readonly options: AppOptions,
    private readonly auth: AuthService,
  ) {}

  private async open(token: string) {
    const invitation = await this.prisma.invitation.findUnique({
      where: { tokenHash: hashSessionToken(token) },
      include: { workspace: { select: { name: true } } },
    });
    if (
      invitation === null ||
      invitation.acceptedAt !== null ||
      invitation.revokedAt !== null ||
      invitation.expiresAt <= new Date()
    ) {
      throw invalidLink();
    }
    return invitation;
  }

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  async preview(@Body() body: unknown): Promise<InvitationPreview> {
    const input = InvitationTokenRequest.safeParse(body);
    if (!input.success) throw invalidLink();
    const invitation = await this.open(input.data.token);
    const account = await this.prisma.user.findUnique({
      where: { email: invitation.email },
      select: { id: true },
    });
    return {
      workspaceName: invitation.workspace.name,
      email: invitation.email,
      role: invitation.role,
      hasAccount: account !== null,
    };
  }

  /** Signed in with the invited email: joins. No account yet: creates one
   * from the name and password, joins, and signs in. */
  @Post('accept')
  @HttpCode(HttpStatus.OK)
  async accept(
    @Body() body: unknown,
    @Req() req: Request,
    @CurrentRequest() request: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WorkspaceSummary> {
    const input = AcceptInvitationRequest.safeParse(body);
    if (!input.success) {
      throw problem(
        HttpStatus.BAD_REQUEST,
        'invalid_request',
        'Enter your name and a password of at least 12 characters.',
      );
    }
    const invitation = await this.open(input.data.token);
    const session = await findActiveSession(this.prisma, req.headers.cookie);
    const account = await this.prisma.user.findUnique({ where: { email: invitation.email } });

    let userId: string;
    let created = false;
    if (session !== null) {
      // The link is for one email; a forwarded link cannot add someone else.
      if (account?.id !== session.userId) {
        throw problem(
          HttpStatus.FORBIDDEN,
          'invitation_wrong_account',
          'This invitation is for a different email address.',
          'Sign out, then open the link again and sign in with the invited email.',
        );
      }
      userId = session.userId;
    } else if (account !== null) {
      throw problem(
        HttpStatus.UNAUTHORIZED,
        'sign_in_required',
        'Sign in to accept this invitation.',
        'An account with this email already exists.',
      );
    } else {
      const { displayName, password } = input.data;
      if (displayName === undefined || password === undefined) {
        throw problem(
          HttpStatus.BAD_REQUEST,
          'invalid_request',
          'Enter your name and a password of at least 12 characters.',
        );
      }
      const user = await this.prisma.user.create({
        data: { email: invitation.email, displayName, passwordHash: await hashPassword(password) },
      });
      userId = user.id;
      created = true;
    }

    const workspace = await this.prisma.$transaction(async (tx) => {
      // Marking it accepted first means two parallel accepts cannot both win.
      const { count } = await tx.invitation.updateMany({
        where: { id: invitation.id, acceptedAt: null, revokedAt: null },
        data: { acceptedAt: new Date() },
      });
      if (count === 0) throw invalidLink();
      await tx.membership.upsert({
        where: { workspaceId_userId: { workspaceId: invitation.workspaceId, userId } },
        create: {
          workspaceId: invitation.workspaceId,
          userId,
          role: invitation.role,
          invitedAt: invitation.createdAt,
          acceptedAt: new Date(),
        },
        // A removed member who is invited again comes back with the new role.
        update: { role: invitation.role, status: 'active', acceptedAt: new Date() },
      });
      await recordAudit(tx, {
        action: 'member.joined',
        actor: { type: 'user', id: userId },
        request,
        workspaceId: invitation.workspaceId,
        target: { type: 'invitation', id: invitation.id },
        summary: { after: { role: invitation.role, newAccount: created } },
      });
      return tx.workspace.findUniqueOrThrow({ where: { id: invitation.workspaceId } });
    });

    if (created) {
      const { token, expiresAt } = await this.auth.createSession(userId, request);
      res.cookie(SESSION_COOKIE, token, {
        ...sessionCookieOptions(this.options.secureCookies),
        expires: expiresAt,
      });
    }
    return {
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      timezone: workspace.timezone,
      role: invitation.role,
    };
  }
}
