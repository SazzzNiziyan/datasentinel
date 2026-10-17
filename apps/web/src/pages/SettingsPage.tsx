import { roleLabel, useSignedIn } from '../app/session.ts';
import { DataTable, type Column } from '../components/DataTable.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { PageFrame } from '../components/PageFrame.tsx';
import { PermissionDenied } from '../components/PermissionDenied.tsx';
import { members, type Member } from '../sample/sampleData.ts';

const columns: Column<Member>[] = [
  { key: 'name', header: 'Name', cell: (m) => m.name, sortValue: (m) => m.name },
  { key: 'email', header: 'Email', cell: (m) => m.email },
  { key: 'role', header: 'Role', cell: (m) => m.role, sortValue: (m) => m.role },
];

export function SettingsPage() {
  const { workspace } = useSignedIn();
  const canManageMembers = workspace?.role === 'owner' || workspace?.role === 'admin';
  return (
    <PageFrame
      title="Workspace settings"
      summary="Members, roles, security, and retention for this workspace."
      sample
    >
      <DataTable
        caption="Members"
        columns={columns}
        rows={members}
        rowKey={(m) => m.id}
        empty={<EmptyState title="No members" description="Invite a teammate to start." />}
      />
      {/* The server enforces this too (D-32); the screen only explains it. */}
      {workspace !== undefined && !canManageMembers && (
        <PermissionDenied
          title="You can't change member roles"
          currentRole={roleLabel[workspace.role]}
          requiredRole="Administrator or Owner"
          contact="Ask a workspace administrator or the owner to change roles or invite members."
        />
      )}
    </PageFrame>
  );
}
