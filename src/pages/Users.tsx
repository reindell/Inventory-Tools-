import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail, UserPlus } from 'lucide-react';
import { roles, type Role, type User, type Page as PageData } from '../../shared/contracts';
import { api, jsonBody } from '../api';
import { AddAccountDialog } from '../components/AddAccountDialog';
import { Page } from '../components/Page';
import {
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorBanner,
  Field,
  Pagination,
  Select,
  Skeleton,
  useToast,
} from '../components/ui';

export function UsersPage() {
  const [params, setParams] = useSearchParams();
  const page = Number(params.get('page') || 1);
  const client = useQueryClient();
  const toast = useToast();
  const [invite, setInvite] = useState(false);
  const [adding, setAdding] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('Staff');
  const [selected, setSelected] = useState<User | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const query = useQuery({
    queryKey: ['users', page],
    queryFn: ({ signal }) => api<PageData<User>>(`/users?page=${page}&pageSize=12`, { signal }),
  });
  const inviteUser = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError('Enter a valid email address.');
      return;
    }
    setBusy(true);
    try {
      await api('/users/invitations', { method: 'POST', body: jsonBody({ email, role }) });
      setInvite(false);
      setEmail('');
      toast('Invitation queued for delivery.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const saveAccess = async () => {
    if (!selected) return;
    setError('');
    setBusy(true);
    try {
      await api(`/users/${selected.id}`, { method: 'PATCH', body: jsonBody({ role, enabled }) });
      await client.invalidateQueries({ queryKey: ['users'] });
      setConfirm(false);
      setSelected(null);
      toast('User access updated. Existing sessions have been revoked.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Page
      title="Users & roles"
      eyebrow="ADMINISTRATION"
      description="Give each person the access their production role needs."
      actions={
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button
            onClick={() => {
              setInvite(true);
              setRole('Staff');
              setError('');
            }}
          >
            <Mail size={17} />
            Invite user
          </Button>
          <Button intent="primary" onClick={() => setAdding(true)}>
            <UserPlus size={17} />
            Add account
          </Button>
        </div>
      }
    >
      <div className="role-guide">
        {[
          { name: 'Admin', desc: 'Requests, issues, returns & full administration' },
          { name: 'Manager', desc: 'Catalog, photos, stock & own requests' },
          { name: 'Staff', desc: 'Browse tools, request quantities & cancel own requests' },
          { name: 'Viewer', desc: 'Read inventory & export' },
        ].map((role) => (
          <div key={role.name}>
            <strong>{role.name}</strong>
            <small>{role.desc}</small>
          </div>
        ))}
      </div>
      <section className="panel">
        {query.isPending ? (
          <Skeleton rows={5} />
        ) : query.isError ? (
          <ErrorBanner message={query.error.message} retry={() => void query.refetch()} />
        ) : !query.data.data.length ? (
          <EmptyState
            title="No users found"
            description="Invite your production team to get started."
          />
        ) : (
          <>
            <div className="table-scroll">
              <table className="data-table">
                <caption className="sr-only">User accounts</caption>
                <thead>
                  <tr>
                    <th scope="col">Team member</th>
                    <th scope="col">Email</th>
                    <th scope="col">Role</th>
                    <th scope="col">Access</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {query.data.data.map((user) => (
                    <tr key={user.id}>
                      <td data-label="Team member">
                        <strong>{user.name}</strong>
                      </td>
                      <td data-label="Email">{user.email}</td>
                      <td data-label="Role">
                        <span className="category-chip">{user.role}</span>
                      </td>
                      <td data-label="Access">
                        <span className={`badge ${user.enabled ? 'in' : 'out'}`}>
                          {user.enabled ? 'Enabled' : 'Disabled'}
                        </span>
                      </td>
                      <td data-label="Actions">
                        <Button
                          emphasis="ghost"
                          onClick={() => {
                            setSelected(user);
                            setRole(user.role);
                            setEnabled(user.enabled);
                            setError('');
                          }}
                        >
                          Manage access
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              total={query.data.total}
              page={page}
              pageSize={12}
              onChange={(value) => setParams({ page: String(value) })}
            />
          </>
        )}
      </section>
      <Dialog
        open={invite}
        title="Invite a team member"
        description="An activation link will be sent to this email address. It expires in 48 hours."
        onClose={() => setInvite(false)}
        busy={busy}
      >
        <form noValidate onSubmit={inviteUser} className="form-stack">
          {error && <ErrorBanner message={error} />}
          <Field
            label="Email address"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            error={error.startsWith('Enter a valid') ? error : undefined}
          />
          <Select
            label="Role"
            value={role}
            onChange={(event) => setRole(event.target.value as Role)}
          >
            {roles.map((role) => (
              <option key={role}>{role}</option>
            ))}
          </Select>
          <div className="dialog-actions">
            <Button disabled={busy} onClick={() => setInvite(false)}>
              Cancel
            </Button>
            <Button type="submit" intent="primary" busy={busy}>
              Send invitation
            </Button>
          </div>
        </form>
      </Dialog>
      <Dialog
        open={!!selected && !confirm}
        title="Manage user access"
        description={selected?.email}
        onClose={() => setSelected(null)}
      >
        <form
          noValidate
          className="form-stack"
          onSubmit={(event) => {
            event.preventDefault();
            setConfirm(true);
          }}
        >
          <Select
            label="Role"
            value={role}
            onChange={(event) => setRole(event.target.value as Role)}
          >
            {roles.map((role) => (
              <option key={role}>{role}</option>
            ))}
          </Select>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            Account enabled
          </label>
          <p className="muted">
            Saving revokes this user’s existing sessions. At least one Admin must remain active.
          </p>
          <div className="dialog-actions">
            <Button onClick={() => setSelected(null)}>Cancel</Button>
            <Button intent="primary" type="submit">
              Review access change
            </Button>
          </div>
        </form>
      </Dialog>
      <ConfirmDialog
        open={confirm}
        title={`Change access for ${selected?.name}?`}
        description={`Set role to ${role} and ${enabled ? 'enable' : 'disable'} this account. Their existing sessions will be revoked immediately.`}
        confirmLabel="Save access change"
        danger={!enabled || role === 'Admin'}
        onClose={() => setConfirm(false)}
        onConfirm={() => void saveAccess()}
        busy={busy}
        error={error}
      />
      <AddAccountDialog
        open={adding}
        onClose={() => setAdding(false)}
        onCreated={() => void client.invalidateQueries({ queryKey: ['users'] })}
      />
    </Page>
  );
}