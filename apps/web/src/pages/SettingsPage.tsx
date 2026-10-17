import type {
  InvitationCreated,
  MemberSummary,
  PendingInvitation,
  Role,
} from '@datasentinel/contracts';
import { useState, type FormEvent } from 'react';
import { ApiError, apiFetch } from '../api/client.ts';
import { useApiData } from '../api/useApiData.ts';
import { roleLabel, useSignedIn } from '../app/session.ts';
import { DataTable, type Column } from '../components/DataTable.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { ErrorState } from '../components/ErrorState.tsx';
import { PageFrame } from '../components/PageFrame.tsx';
import { PermissionDenied } from '../components/PermissionDenied.tsx';
import './SettingsPage.css';

const ROLES: Role[] = ['owner', 'admin', 'engineer', 'analyst', 'viewer'];
const RANK: Record<Role, number> = { viewer: 0, analyst: 1, engineer: 2, admin: 3, owner: 4 };

const date = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' });

const memberColumns: Column<MemberSummary>[] = [
  { key: 'name', header: 'Name', cell: (m) => m.displayName, sortValue: (m) => m.displayName },
  { key: 'email', header: 'Email', cell: (m) => m.email },
  { key: 'role', header: 'Role', cell: (m) => roleLabel[m.role], sortValue: (m) => RANK[m.role] },
];

/** Members, invitations (D-40), and the permission notice for other roles. */
export function SettingsPage() {
  const { workspace } = useSignedIn();
  if (workspace === undefined) return null;
  const canManageMembers = workspace.role === 'owner' || workspace.role === 'admin';

  return (
    <PageFrame
      title="Workspace settings"
      summary="Members, roles, security, and retention for this workspace."
    >
      {canManageMembers ? (
        <MemberAdmin workspaceId={workspace.workspaceId} ownRole={workspace.role} />
      ) : (
        // The server enforces this too (D-32); the screen only explains it.
        <PermissionDenied
          title="You can't manage members"
          currentRole={roleLabel[workspace.role]}
          requiredRole="Administrator or Owner"
          contact="Ask a workspace administrator or the owner to change roles or invite members."
        />
      )}
    </PageFrame>
  );
}

function MemberAdmin({ workspaceId, ownRole }: { workspaceId: string; ownRole: Role }) {
  const base = `/workspaces/${workspaceId}`;
  const members = useApiData<MemberSummary[]>(`${base}/members`);
  const pending = useApiData<PendingInvitation[]>(`${base}/invitations`);

  const pendingColumns: Column<PendingInvitation>[] = [
    { key: 'email', header: 'Email', cell: (i) => i.email },
    { key: 'role', header: 'Role', cell: (i) => roleLabel[i.role] },
    { key: 'by', header: 'Invited by', cell: (i) => i.invitedByName },
    { key: 'expires', header: 'Expires', cell: (i) => date.format(new Date(i.expiresAt)) },
    {
      key: 'revoke',
      header: 'Action',
      cell: (i) => (
        <button
          type="button"
          className="button"
          aria-label={`Revoke invitation for ${i.email}`}
          onClick={() =>
            void apiFetch(`${base}/invitations/${i.id}`, { method: 'DELETE' }).then(
              pending.retry,
              pending.retry,
            )
          }
        >
          Revoke
        </button>
      ),
    },
  ];

  return (
    <>
      {members.status === 'error' ? (
        <ErrorState
          title="Could not load members"
          description={members.error.detail ?? members.error.message}
          onRetry={members.retry}
          retrying={members.retrying}
        />
      ) : (
        <DataTable
          caption="Members"
          columns={memberColumns}
          rows={members.status === 'ready' ? members.data : []}
          rowKey={(m) => m.membershipId}
          status={members.status === 'loading' ? 'loading' : 'ready'}
          empty={<EmptyState title="No members" description="Invite a teammate to start." />}
        />
      )}
      <InviteForm base={base} ownRole={ownRole} onInvited={pending.retry} />
      {pending.status !== 'error' && (
        <DataTable
          caption="Pending invitations"
          columns={pendingColumns}
          rows={pending.status === 'ready' ? pending.data : []}
          rowKey={(i) => i.id}
          status={pending.status === 'loading' ? 'loading' : 'ready'}
          empty="No pending invitations."
        />
      )}
    </>
  );
}

function InviteForm({
  base,
  ownRole,
  onInvited,
}: {
  base: string;
  ownRole: Role;
  onInvited: () => void;
}) {
  // Nobody may invite above their own role; only owners invite owners.
  const roles = ROLES.filter(
    (r) => RANK[r] <= RANK[ownRole] && (r !== 'owner' || ownRole === 'owner'),
  );
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const [created, setCreated] = useState<InvitationCreated | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [copied, setCopied] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    setCopied(false);
    try {
      const result = await apiFetch<InvitationCreated>(`${base}/invitations`, {
        method: 'POST',
        body: JSON.stringify({ email, role }),
      });
      setCreated(result);
      setEmail('');
      onInvited();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The invitation was not created.');
    }
  }

  return (
    <section className="invite" aria-labelledby="invite-title">
      <h2 id="invite-title" className="invite__title">
        Invite a member
      </h2>
      <form className="invite__form" onSubmit={(e) => void submit(e)}>
        <label className="invite__field">
          Email
          <input
            className="text-input"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="invite__field">
          Role
          <select
            className="text-input"
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
          >
            {roles.map((r) => (
              <option key={r} value={r}>
                {roleLabel[r]}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="button button--primary">
          Create invite link
        </button>
      </form>
      {error !== undefined && (
        <p role="alert" className="invite__error">
          {error}
        </p>
      )}
      {created !== undefined && (
        <div className="invite__link" role="status">
          <p>
            Send this link to <strong>{created.email}</strong>. It works once, expires on{' '}
            {date.format(new Date(created.expiresAt))}, and is not shown again.
          </p>
          <div className="invite__copy">
            <input
              className="text-input mono"
              readOnly
              value={created.acceptUrl}
              aria-label="Invite link"
              onFocus={(e) => e.target.select()}
            />
            <button
              type="button"
              className="button"
              onClick={() =>
                void navigator.clipboard.writeText(created.acceptUrl).then(() => setCopied(true))
              }
            >
              {copied ? 'Copied' : 'Copy link'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
