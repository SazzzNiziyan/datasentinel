import { z } from 'zod';

const roles = ['owner', 'admin', 'engineer', 'analyst', 'viewer'] as const;

/** POST /workspaces/{workspaceId}/invitations (admin and owner). */
export const CreateInvitationRequest = z.object({
  email: z.email().max(254),
  role: z.enum(roles),
});
export type CreateInvitationRequest = z.infer<typeof CreateInvitationRequest>;

/** The only response that contains the link; it is never shown again. */
export interface InvitationCreated {
  id: string;
  email: string;
  role: (typeof roles)[number];
  expiresAt: string;
  /** Web link with the token after "#", so it never reaches server logs. */
  acceptUrl: string;
}

/** One entry of GET /workspaces/{workspaceId}/invitations (no token). */
export interface PendingInvitation {
  id: string;
  email: string;
  role: (typeof roles)[number];
  expiresAt: string;
  invitedByName: string;
}

/** POST /invitations/preview body; POST /invitations/accept adds the rest. */
export const InvitationTokenRequest = z.object({ token: z.string().min(20).max(200) });

/** What the invite page shows before joining. */
export interface InvitationPreview {
  workspaceName: string;
  email: string;
  role: (typeof roles)[number];
  /** False: the page asks for a name and password to create the account. */
  hasAccount: boolean;
}

/** New accounts set a name and password while accepting (D-40). */
export const AcceptInvitationRequest = InvitationTokenRequest.extend({
  displayName: z.string().trim().min(1).max(80).optional(),
  password: z.string().min(12).max(1024).optional(),
});
export type AcceptInvitationRequest = z.infer<typeof AcceptInvitationRequest>;
