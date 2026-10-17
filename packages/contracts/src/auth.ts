import { z } from 'zod';

/** POST /auth/sessions body. Limits stop oversized input before hashing. */
export const SignInRequest = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(1024),
});
export type SignInRequest = z.infer<typeof SignInRequest>;

/** Error body for every API failure (docs/04 §1, RFC 9457 shape). */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  /** The request ID, so users can quote it to support. */
  instance: string;
  /** Stable application code, e.g. "invalid_credentials". */
  code: string;
}

/** D-02 workspace roles, highest first. */
export type Role = 'owner' | 'admin' | 'engineer' | 'analyst' | 'viewer';

/** GET /auth/me */
export interface MeResponse {
  user: { id: string; email: string; displayName: string };
  memberships: { workspaceId: string; workspaceName: string; slug: string; role: Role }[];
}

/** One entry of GET /workspaces. */
export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  role: Role;
}

/** POST /workspaces body. The time zone is checked against IANA names on
 * the server. */
export const CreateWorkspaceRequest = z.object({
  name: z.string().trim().min(1).max(80),
  timezone: z.string().max(64).default('UTC'),
});
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequest>;

/** GET /workspaces/{workspaceId} */
export interface WorkspaceDetail extends WorkspaceSummary {
  createdAt: string;
}

/** One entry of GET /workspaces/{workspaceId}/members (admin and owner). */
export interface MemberSummary {
  membershipId: string;
  userId: string;
  displayName: string;
  email: string;
  role: Role;
  status: 'active' | 'removed';
}

const roles = ['owner', 'admin', 'engineer', 'analyst', 'viewer'] as const;

/** PATCH /workspaces/{workspaceId}/members/{membershipId} body. */
export const UpdateMemberRequest = z
  .object({ role: z.enum(roles).optional(), status: z.literal('removed').optional() })
  .refine((v) => v.role !== undefined || v.status !== undefined, 'Change the role or remove.');
export type UpdateMemberRequest = z.infer<typeof UpdateMemberRequest>;

/** PATCH /workspaces/{workspaceId} body (admin and owner). */
export const UpdateWorkspaceRequest = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    timezone: z.string().max(64).optional(),
  })
  .refine((v) => v.name !== undefined || v.timezone !== undefined, 'Change the name or time zone.');
export type UpdateWorkspaceRequest = z.infer<typeof UpdateWorkspaceRequest>;
