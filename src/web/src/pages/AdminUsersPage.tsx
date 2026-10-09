import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, listUserAccessTokens, revokeUserAccessToken, type AccessToken } from '../api';
import { AccessTokenTable } from '../components/AccessTokenTable';
import { AdminNav } from '../components/AdminNav';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Checkbox } from '../components/ui/Checkbox';
import { useConfirm } from '../components/ui/ConfirmDialog';
import { Dialog } from '../components/ui/Dialog';
import { Input } from '../components/ui/Input';
import { Popconfirm } from '../components/ui/Popconfirm';
import { Spinner } from '../components/ui/Spinner';
import { TableEmptyRow, TableFrame } from '../components/ui/Table';
import { fullDate } from '../lib/accessTokens';
import { authMethodsQuery } from '../lib/googleLink';
import { meQuery, type SignInMethods } from '../lib/queries';
import { useToast } from '../lib/toast';

interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: 'MEMBER' | 'ADMIN';
  createdAt: string;
  /** Absent from a server that predates Google sign-in. */
  signInMethods?: SignInMethods;
  /** When an administrator disabled the account; null while it is not, absent from a server that predates disabling. */
  disabledAt?: string | null;
}
interface CreateResult {
  email: string;
  reset: boolean;
  generatedPassword?: string;
}

export const GOOGLE_SIGN_IN_ONLY = 'Google sign-in only';
export const UNLINK_GOOGLE = 'Unlink Google';
export const DISABLE_USER = 'Disable';
export const ENABLE_USER = 'Enable';
/**
 * What the Add-user dialog says under **Google sign-in only** (design §5.2): only a Gmail or Google
 * Workspace address is one Google vouches for, so only that address can be linked by it. Any other
 * address leaves the account without a password and without a way in.
 */
export const GOOGLE_SIGN_IN_ONLY_HINT =
  'No password is set: they sign in with the Google account of this email address. That address must be a '
  + 'Gmail or Google Workspace address — Google has to vouch for it. Any other address leaves this account '
  + 'with no way to sign in: give them a password instead.';

/**
 * How an account signs in (docs/google-sign-in-design.md §5.6: the list shows it, so an unusual
 * sign-up stands out): a password, a Google account linked — named on hover — or, for an account
 * without either yet, Google only, waiting for its first Google sign-in to link one.
 */
function SignInBadges({ methods }: { methods?: SignInMethods }) {
  const { password, google } = methods ?? { password: true, google: null };
  return (
    <span className="admin-signin-badges">
      {password && <Badge>Password</Badge>}
      {google && (
        <Badge tone="blue" title={google.email}>
          Google
        </Badge>
      )}
      {!password && !google && (
        <Badge tone="warning" title="No password: the Google account of this email address is linked at its first Google sign-in">
          Google · pending
        </Badge>
      )}
    </span>
  );
}

// Admin-only account management (gated by role on both the account-menu entry and every
// endpoint). Create/reset return a one-time password shown once in a dialog.
export function AdminUsersPage() {
  const message = useToast();
  const qc = useQueryClient();
  const users = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: () => api<AdminUser[]>('/admin/users'),
  });
  // A Google-only account is offered only while Google sign-in is on: otherwise it could not sign in.
  const googleOn = useQuery(authMethodsQuery()).data?.google === true;
  // An administrator cannot disable their own account, so their row does not offer it.
  const meId = useQuery(meQuery()).data?.id;

  const [createOpen, setCreateOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [googleOnly, setGoogleOnly] = useState(false);
  const [tokensOf, setTokensOf] = useState<AdminUser | null>(null);
  const [confirm, confirmation] = useConfirm();

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['admin', 'users'] });
  const announce = (label: string, pwd?: string) => {
    if (pwd) {
      void confirm({
        kind: 'success',
        title: label,
        description: (
          <div>
            Share this one-time password:
            <br />
            <code style={{ fontSize: 14 }}>{pwd}</code>
          </div>
        ),
        onConfirm: () => undefined,
      });
    } else {
      message.success(label);
    }
  };

  const createMut = useMutation({
    mutationFn: (body: { email: string; name?: string; force?: boolean; passwordless?: boolean }) =>
      api<CreateResult>('/admin/users', { method: 'POST', body }),
    onSuccess: (r) => {
      invalidate();
      setCreateOpen(false);
      setEmail('');
      setName('');
      setGoogleOnly(false);
      announce(r.reset ? `Password reset for ${r.email}` : `Created ${r.email}`, r.generatedPassword);
    },
    onError: (e: Error, { force }) =>
      message.error(force ? "Couldn't reset the password" : "Couldn't create the user", e.message),
  });

  const roleMut = useMutation({
    mutationFn: ({ id, role }: { id: string; role: 'MEMBER' | 'ADMIN' }) =>
      api(`/admin/users/${id}/role`, { method: 'PATCH', body: { role } }),
    onSuccess: () => {
      invalidate();
      message.success('Role updated');
    },
    onError: (e: Error) => message.error("Couldn't change the role", e.message),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api(`/admin/users/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      invalidate();
      message.success('User deleted');
    },
    onError: (e: Error) => message.error("Couldn't delete the user", e.message),
  });

  const unlinkMut = useMutation({
    mutationFn: (u: AdminUser) => api(`/admin/users/${u.id}/identities/google`, { method: 'DELETE' }),
    onSuccess: (_, u) => {
      invalidate();
      message.success('Google unlinked', u.email);
    },
  });
  /** Unlink, once confirmed: an account without a password is told it is left with no way in. */
  const askUnlink = (u: AdminUser) =>
    void confirm({
      title: `Unlink Google from ${u.email}?`,
      description: u.signInMethods?.password
        ? `Signing in with ${u.signInMethods.google?.email} stops working for this account. They can still sign in with their password, and connect Google again from their profile.`
        : `This account has no password: once ${u.signInMethods?.google?.email} is unlinked, nobody can sign in to it until you reset its password.`,
      confirmText: 'Unlink',
      danger: true,
      onConfirm: () => unlinkMut.mutateAsync(u),
    });

  const disabledMut = useMutation({
    mutationFn: ({ user, disabled }: { user: AdminUser; disabled: boolean }) =>
      api<AdminUser>(`/admin/users/${user.id}/disabled`, { method: 'PATCH', body: { disabled } }),
    onSuccess: (_, { user, disabled }) => {
      invalidate();
      message.success(disabled ? 'Account disabled' : 'Account enabled', user.email);
    },
  });
  /**
   * Disable, once confirmed (docs/google-sign-in-design.md §5.5): the administrator is told what stops
   * working, and that nothing is deleted. A refusal — the last administrator — is shown in the dialog.
   */
  const askDisable = (u: AdminUser) =>
    void confirm({
      title: `Disable ${u.email}?`,
      description:
        'They are signed out everywhere and cannot sign in. Their access tokens, runners and service tokens stop working until you enable the account again. Nothing they own is deleted.',
      confirmText: DISABLE_USER,
      danger: true,
      onConfirm: () => disabledMut.mutateAsync({ user: u, disabled: true }),
    });
  const enable = (u: AdminUser) =>
    disabledMut.mutate(
      { user: u, disabled: false },
      { onError: (e: Error) => message.error("Couldn't enable the account", e.message) },
    );

  const columns: { key: string; title: string; end?: boolean; cell: (u: AdminUser) => ReactNode }[] = [
    { key: 'email', title: 'Email', cell: (u) => u.email },
    { key: 'name', title: 'Name', cell: (u) => u.name },
    { key: 'role', title: 'Role', cell: (u) => <Badge tone={u.role === 'ADMIN' ? 'gold' : 'default'}>{u.role}</Badge> },
    {
      key: 'status',
      title: 'Status',
      cell: (u) =>
        u.disabledAt ? (
          <Badge tone="error" title={`Disabled on ${fullDate(u.disabledAt)}`}>
            Disabled
          </Badge>
        ) : (
          <Badge>Active</Badge>
        ),
    },
    { key: 'signIn', title: 'Sign-in', cell: (u) => <SignInBadges methods={u.signInMethods} /> },
    { key: 'createdAt', title: 'Created', cell: (u) => <span className="admin-users-created">{fullDate(u.createdAt)}</span> },
    {
      key: 'actions',
      title: '',
      end: true,
      // A row of actions that wraps rather than widening the table past the page.
      cell: (u) => (
        <div className="admin-user-actions">
          <Popconfirm
            title={`Reset ${u.email}'s password?`}
            onConfirm={() => createMut.mutate({ email: u.email, force: true })}
            trigger={<Button size="small">Reset password</Button>}
          />
          <Button size="small" onClick={() => setTokensOf(u)}>
            Access tokens
          </Button>
          {u.signInMethods?.google && (
            <Button size="small" onClick={() => askUnlink(u)}>
              {UNLINK_GOOGLE}
            </Button>
          )}
          <Button
            size="small"
            loading={roleMut.isPending}
            onClick={() => roleMut.mutate({ id: u.id, role: u.role === 'ADMIN' ? 'MEMBER' : 'ADMIN' })}
          >
            {u.role === 'ADMIN' ? 'Make member' : 'Make admin'}
          </Button>
          {u.disabledAt ? (
            <Button
              size="small"
              loading={disabledMut.isPending && disabledMut.variables?.user.id === u.id}
              onClick={() => enable(u)}
            >
              {ENABLE_USER}
            </Button>
          ) : (
            u.id !== meId && (
              <Button size="small" danger onClick={() => askDisable(u)}>
                {DISABLE_USER}
              </Button>
            )
          )}
          <Popconfirm
            title={`Delete ${u.email}?`}
            onConfirm={() => deleteMut.mutate(u.id)}
            trigger={
              <Button size="small" danger>
                Delete
              </Button>
            }
          />
        </div>
      ),
    },
  ];
  const end = { textAlign: 'right' } as const;
  const rows = users.data ?? [];
  const create = () =>
    email.trim() &&
    createMut.mutate({
      email: email.trim(),
      name: name.trim() || undefined,
      ...(googleOn && googleOnly ? { passwordless: true } : {}),
    });

  return (
    <div className="admin-page">
      <AdminNav />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 className="page-title">Users</h1>
        <Button variant="primary" onClick={() => setCreateOpen(true)}>
          Add user
        </Button>
      </div>

      <TableFrame loading={users.isLoading}>
        <table className="orbit-table">
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column.key} scope="col" style={column.end ? end : undefined}>
                  {column.title}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <TableEmptyRow colSpan={columns.length} />
            ) : (
              rows.map((user) => (
                <tr key={user.id}>
                  {columns.map((column) => (
                    <td key={column.key} style={column.end ? end : undefined}>
                      {column.cell(user)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </TableFrame>

      <Dialog
        className="admin-user-dialog"
        title="Add user"
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        footer={
          <>
            <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={createMut.isPending} onClick={create}>
              Create
            </Button>
          </>
        }
      >
        <div className="admin-user-form">
          <Input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Input placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
          {googleOn && (
            <Checkbox checked={googleOnly} onCheckedChange={setGoogleOnly}>
              {GOOGLE_SIGN_IN_ONLY}
            </Checkbox>
          )}
          <div style={{ color: 'var(--text-3)', fontSize: 12 }}>
            {googleOn && googleOnly
              ? GOOGLE_SIGN_IN_ONLY_HINT
              : 'A one-time password is generated and shown once after creating.'}
          </div>
        </div>
      </Dialog>
      {confirmation}

      <Dialog
        className="admin-user-dialog"
        title={tokensOf ? `Access tokens — ${tokensOf.email}` : 'Access tokens'}
        open={tokensOf !== null}
        onClose={() => setTokensOf(null)}
        width={1120}
      >
        {tokensOf && <UserAccessTokens user={tokensOf} />}
      </Dialog>
    </div>
  );
}

/**
 * One user's personal access tokens, for an administrator (docs/personal-access-token-design.md
 * §11.4): the list that user sees, and a way to revoke a token — recorded as revoked by an
 * administrator. Never a token itself: Orbit keeps only its hash.
 */
function UserAccessTokens({ user }: { user: AdminUser }) {
  const message = useToast();
  const qc = useQueryClient();
  const key = ['admin', 'users', user.id, 'access-tokens'] as const;
  const tokensQ = useQuery({ queryKey: key, queryFn: () => listUserAccessTokens(user.id) });
  const revoke = useMutation({
    mutationFn: (token: AccessToken) => revokeUserAccessToken(user.id, token.id),
    onSuccess: (_, token) => {
      void qc.invalidateQueries({ queryKey: key });
      message.success('Token revoked', `${user.email}’s “${token.name}” stopped working.`);
    },
    onError: (e: Error) => message.error("Couldn't revoke the token", e.message),
  });
  if (tokensQ.isPending) return <Spinner />;
  if (tokensQ.isError) return <div>Couldn’t load the tokens: {tokensQ.error.message}</div>;
  return (
    <>
      <p style={{ color: 'var(--text-3)', marginTop: 0 }}>
        Revoking a token stops it at once and is recorded as revoked by an administrator. The tokens themselves are
        never shown — Orbit keeps only a hash of each.
      </p>
      <AccessTokenTable
        tokens={tokensQ.data.tokens}
        now={Date.now()}
        onRevoke={(token) => revoke.mutate(token)}
        revokingId={revoke.isPending ? revoke.variables?.id : null}
        emptyText="This user has no access tokens."
      />
    </>
  );
}
