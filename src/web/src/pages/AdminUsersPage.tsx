import { useMemo, useState, type ReactNode } from 'react';
import { MoreOutlined, SearchOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WikiPlanSupportBuildResult, WikiSupportSpace, WikiSupportSpaces } from '@orbit/shared';
import { api, fetchUserAvatarDataUrl, listUserAccessTokens, revokeUserAccessToken, startImpersonation, type AccessToken } from '../api';
import { AccessTokenTable } from '../components/AccessTokenTable';
import { AdminNav } from '../components/AdminNav';
import { Avatar } from '../components/ui/Avatar';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Checkbox } from '../components/ui/Checkbox';
import { useConfirm } from '../components/ui/ConfirmDialog';
import { Dialog } from '../components/ui/Dialog';
import { Input } from '../components/ui/Input';
import { Menu, type MenuItem } from '../components/ui/Menu';
import { Radio, RadioGroup } from '../components/ui/Radio';
import { Spinner } from '../components/ui/Spinner';
import { TableEmptyRow, TableFrame } from '../components/ui/Table';
import { Textarea } from '../components/ui/Textarea';
import { fullDate } from '../lib/accessTokens';
import { authMethodsQuery } from '../lib/googleLink';
import { meQuery, type SignInMethods } from '../lib/queries';
import { useToast } from '../lib/toast';
import { PHONE_QUERY, useMediaQuery } from '../lib/useMediaQuery';
import { ago } from '../lib/watches';

/** What an account last used Orbit through: one of its apps, or an access token. */
type ActiveVia = 'web' | 'ios' | 'macos' | 'android' | 'token';

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
  /** When the account last used Orbit, and through what; null when it never has, absent from a server that predates it. */
  lastActive?: { at: string; via: ActiveVia } | null;
  /** When the account's profile photo was set — the version it is fetched by; null without one, absent from a
   *  server that predates the list naming it. */
  avatarUpdatedAt?: string | null;
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
export const DELETE_USER = 'Delete';
export const RESET_PASSWORD = 'Reset password';
export const VIEW_AS = 'View as';
export const START_VIEWING = 'Start viewing';
/** A row's menu of every other action, named for the account it acts on. */
export const MORE_ACTIONS = 'More actions';
/**
 * An account's wiki documents asked for again, for support (contracts/wiki.contract.json `plan.jobs.rebuild.support`):
 * the menu's entry, and the dialog's button.
 */
export const UPDATE_WIKI_DOCS = 'Update wiki documents…';
export const UPDATE_DOCUMENTS = 'Update documents';
/**
 * What the Add-user dialog says under **Google sign-in only** (design §5.2): only a Gmail or Google
 * Workspace address is one Google vouches for, so only that address can be linked by it. Any other
 * address leaves the account without a password and without a way in.
 */
export const GOOGLE_SIGN_IN_ONLY_HINT =
  'No password is set: they sign in with the Google account of this email address. That address must be a '
  + 'Gmail or Google Workspace address — Google has to vouch for it. Any other address leaves this account '
  + 'with no way to sign in: give them a password instead.';

const ACTIVE_VIA: Record<ActiveVia, string> = {
  web: 'Web',
  ios: 'iOS app',
  macos: 'Mac app',
  android: 'Android app',
  token: 'Access token',
};
const MONTH = 30 * 24 * 60 * 60 * 1000;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The account as the list names it: its name, or the part of its email before the @ while it has none. */
const nameOf = (u: AdminUser) => u.name.trim() || u.email.split('@')[0];

/** The account: its photo (its initial while it has none), its name, a mark for you and for an administrator, and its email. */
function UserCell({ user, you }: { user: AdminUser; you: boolean }) {
  // By the version the row names, so a new photo is a new key; nothing is fetched while there is none. Under a
  // key of its own rather than the list's, so refreshing the list does not fetch every photo again.
  const photo = useQuery({
    queryKey: ['admin', 'avatar', user.id, user.avatarUpdatedAt ?? null],
    queryFn: () => fetchUserAvatarDataUrl(user.id),
    enabled: !!user.avatarUpdatedAt,
    staleTime: Infinity,
  });
  return (
    <div className="admin-users-who">
      <Avatar size={32} src={photo.data}>{nameOf(user).charAt(0).toUpperCase()}</Avatar>
      <div className="admin-users-who-text">
        <div className="admin-users-name">
          <span className="admin-users-name-text">{nameOf(user)}</span>
          {you && <Badge tone="blue">You</Badge>}
          {user.role === 'ADMIN' && <Badge tone="gold">Admin</Badge>}
        </div>
        <div className="admin-users-email" title={user.email}>
          {user.email}
        </div>
      </div>
    </div>
  );
}

/**
 * How an account signs in (docs/google-sign-in-design.md §5.6: the list shows it, so an unusual
 * sign-up stands out): a password, a Google account linked — named on hover — or, for an account
 * without either yet, Google only, waiting for its first Google sign-in to link one.
 */
function SignInCell({ methods }: { methods?: SignInMethods }) {
  const { password, google } = methods ?? { password: true, google: null };
  if (!password && !google) {
    return (
      <span className="admin-users-pending" title="No password: the Google account of this email address is linked at its first Google sign-in">
        Google · pending
      </span>
    );
  }
  return (
    <span className="admin-users-signin">
      {password && 'Password'}
      {password && google && ' · '}
      {google && <span title={google.email}>Google</span>}
    </span>
  );
}

function StatusCell({ disabledAt }: { disabledAt?: string | null }) {
  return disabledAt ? (
    <span className="admin-users-status admin-users-status-off" title={`Disabled on ${fullDate(disabledAt)}`}>
      Disabled
    </span>
  ) : (
    <span className="admin-users-status">Active</span>
  );
}

/**
 * When the account last used Orbit (an app or an access token), as "3h ago", a date once it is over a month,
 * or Never; the exact time and what it was through on hover. An app's use is recorded at most hourly, so a
 * person using Orbit right now can read as up to an hour ago.
 */
function LastActiveCell({ last, now }: { last?: AdminUser['lastActive']; now: number }) {
  if (last === undefined) return <span className="admin-users-quiet">—</span>;
  if (last === null) return <span className="admin-users-quiet">Never</span>;
  const exact = new Date(last.at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <span className="admin-users-active" title={`${exact} · ${ACTIVE_VIA[last.via] ?? last.via}`}>
      {now - Date.parse(last.at) > MONTH ? fullDate(last.at) : ago(last.at, now)}
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
  // An administrator cannot disable or delete their own account, so their row does not offer it.
  const meId = useQuery(meQuery()).data?.id;
  // On a phone a row keeps only its menu, which then starts with the row's own action.
  const phone = useMediaQuery(PHONE_QUERY);

  const [query, setQuery] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [googleOnly, setGoogleOnly] = useState(false);
  const [tokensOf, setTokensOf] = useState<AdminUser | null>(null);
  const [wikiOf, setWikiOf] = useState<AdminUser | null>(null);
  const [viewAs, setViewAs] = useState<AdminUser | null>(null);
  const [reason, setReason] = useState('');
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
    mutationFn: (body: { email: string; name?: string; passwordless?: boolean }) =>
      api<CreateResult>('/admin/users', { method: 'POST', body }),
    onSuccess: (r) => {
      invalidate();
      setCreateOpen(false);
      setEmail('');
      setName('');
      setGoogleOnly(false);
      announce(`Created ${r.email}`, r.generatedPassword);
    },
    onError: (e: Error) => message.error("Couldn't create the user", e.message),
  });
  /**
   * Reset a password, once confirmed: the new one-time password is shown after the question closes (one
   * dialog at a time), and a refusal is said in the question.
   */
  const askReset = async (u: AdminUser) => {
    let reset: CreateResult | undefined;
    const confirmed = await confirm({
      title: `Reset ${u.email}'s password?`,
      description: 'A new one-time password is generated and shown once. Their current password stops working.',
      confirmText: RESET_PASSWORD,
      onConfirm: async () => {
        reset = await api<CreateResult>('/admin/users', { method: 'POST', body: { email: u.email, force: true } });
      },
    });
    if (!confirmed || !reset) return;
    invalidate();
    announce(`Password reset for ${reset.email}`, reset.generatedPassword);
  };

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
  });
  /** Delete, once confirmed; a refusal (an account that still owns things) is said in the question. */
  const askDelete = (u: AdminUser) =>
    void confirm({
      title: `Delete ${u.email}?`,
      description:
        'This cannot be undone. It fails while the account owns runners, workspaces or tasks; disable it instead to keep them out.',
      confirmText: DELETE_USER,
      danger: true,
      onConfirm: () => deleteMut.mutateAsync(u.id),
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

  /**
   * View Orbit as the user, read-only, to debug what they see: the server answers a token for 30
   * minutes and records the reason. The app loads again as them, so nothing read as the administrator
   * stays on screen; the banner over every page brings the administrator back.
   */
  const viewAsMut = useMutation({
    mutationFn: ({ user, why }: { user: AdminUser; why: string }) =>
      api<{ accessToken: string }>(`/admin/users/${user.id}/impersonate`, { method: 'POST', body: { reason: why } }),
    onSuccess: ({ accessToken }) => {
      startImpersonation(accessToken);
      location.href = '/';
    },
    onError: (e: Error, { user }) => message.error(`Couldn't view Orbit as ${user.email}`, e.message),
  });
  const openViewAs = (u: AdminUser) => {
    setReason('');
    setViewAs(u);
  };

  /**
   * A row's actions: the one it is most often opened for, in sight — View as, or Enable on a disabled account;
   * none on your own account or another administrator's, which cannot be viewed — and every other in its menu,
   * the ones that lock an account out or remove it last and apart.
   */
  const actions = (u: AdminUser) => {
    const you = u.id === meId;
    const own = you || u.role === 'ADMIN'
      ? null
      : u.disabledAt
        ? { label: ENABLE_USER, run: () => enable(u), busy: disabledMut.isPending && disabledMut.variables?.user.id === u.id }
        : { label: VIEW_AS, run: () => openViewAs(u), busy: false };
    const items: MenuItem[] = [
      ...(phone && own ? [{ key: 'own', label: own.label, onSelect: own.run }, { type: 'separator', key: 'own-end' }] as MenuItem[] : []),
      { key: 'reset', label: RESET_PASSWORD, onSelect: () => void askReset(u) },
      { key: 'tokens', label: 'Access tokens', onSelect: () => setTokensOf(u) },
      { key: 'wiki', label: UPDATE_WIKI_DOCS, onSelect: () => setWikiOf(u) },
      ...(u.signInMethods?.google ? [{ key: 'unlink', label: UNLINK_GOOGLE, onSelect: () => askUnlink(u) }] : []),
      {
        key: 'role',
        label: u.role === 'ADMIN' ? 'Make member' : 'Make admin',
        onSelect: () => roleMut.mutate({ id: u.id, role: u.role === 'ADMIN' ? 'MEMBER' : 'ADMIN' }),
      },
      ...(you
        ? []
        : ([
            { type: 'separator', key: 'lock-out' },
            ...(u.disabledAt ? [] : [{ key: 'disable', label: DISABLE_USER, danger: true, onSelect: () => askDisable(u) }]),
            { key: 'delete', label: DELETE_USER, danger: true, onSelect: () => askDelete(u) },
          ] as MenuItem[])),
    ];
    return (
      <div className="admin-user-actions">
        {own && !phone && (
          <Button size="small" loading={own.busy} onClick={own.run}>
            {own.label}
          </Button>
        )}
        <Menu
          align="end"
          items={items}
          trigger={
            <Button size="small" variant="text" icon={<MoreOutlined />} title={MORE_ACTIONS} aria-label={`${MORE_ACTIONS} for ${u.email}`} />
          }
        />
      </div>
    );
  };

  const now = Date.now();
  const columns: { key: string; title: string; className?: string; cell: (u: AdminUser) => ReactNode }[] = [
    { key: 'user', title: 'User', cell: (u) => <UserCell user={u} you={u.id === meId} /> },
    { key: 'signIn', title: 'Sign-in', className: 'admin-users-col-signin', cell: (u) => <SignInCell methods={u.signInMethods} /> },
    { key: 'status', title: 'Status', className: 'admin-users-col-status', cell: (u) => <StatusCell disabledAt={u.disabledAt} /> },
    { key: 'lastActive', title: 'Last active', className: 'admin-users-col-active', cell: (u) => <LastActiveCell last={u.lastActive} now={now} /> },
    { key: 'createdAt', title: 'Created', className: 'admin-users-col-created', cell: (u) => fullDate(u.createdAt) },
    { key: 'actions', title: '', className: 'admin-users-col-actions', cell: actions },
  ];
  const all = users.data ?? [];
  const wanted = query.trim().toLowerCase();
  const rows = useMemo(
    () => (wanted ? all.filter((u) => `${u.name}\n${u.email}`.toLowerCase().includes(wanted)) : all),
    [all, wanted],
  );
  const admins = all.filter((u) => u.role === 'ADMIN').length;
  const disabled = all.filter((u) => u.disabledAt).length;
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
      <div className="admin-users-head">
        <div className="admin-users-heading">
          <h1 className="page-title">Users</h1>
          {users.data && (
            <div className="admin-users-sub">
              {[
                plural(all.length, 'account', 'accounts'),
                plural(admins, 'administrator', 'administrators'),
                ...(disabled ? [`${disabled} disabled`] : []),
              ].join(' · ')}
            </div>
          )}
        </div>
        <div className="admin-users-tools">
          <Input
            className="admin-users-search"
            prefix={<SearchOutlined />}
            placeholder="Search name or email"
            aria-label="Search users"
            value={query}
            allowClear
            onClear={() => setQuery('')}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            Add user
          </Button>
        </div>
      </div>

      <TableFrame className="admin-users-frame" loading={users.isLoading}>
        <table className="orbit-table admin-users-table">
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column.key} scope="col" className={column.className}>
                  {column.title}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              wanted && all.length > 0 ? (
                <tr className="orbit-table-placeholder">
                  <td colSpan={columns.length} className="admin-users-none">
                    No users match “{query.trim()}”
                  </td>
                </tr>
              ) : (
                <TableEmptyRow colSpan={columns.length} />
              )
            ) : (
              rows.map((user) => (
                <tr key={user.id} className={user.disabledAt ? 'admin-users-off' : undefined}>
                  {columns.map((column) => (
                    <td key={column.key} className={column.className}>
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
        title={viewAs ? `View Orbit as ${viewAs.email}?` : VIEW_AS}
        open={viewAs !== null}
        onClose={() => setViewAs(null)}
        footer={
          <>
            <Button onClick={() => setViewAs(null)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!reason.trim()}
              loading={viewAsMut.isPending}
              onClick={() => viewAs && viewAsMut.mutate({ user: viewAs, why: reason.trim() })}
            >
              {START_VIEWING}
            </Button>
          </>
        }
      >
        <div className="admin-user-form">
          <div>
            You see Orbit as they see it, read-only, for 30 minutes: nothing can be changed. Starting is recorded
            with your reason.
          </div>
          <Textarea
            aria-label="Reason"
            placeholder="Reason, e.g. the support request you are looking into"
            value={reason}
            maxLength={500}
            autoSize={{ minRows: 2, maxRows: 6 }}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
      </Dialog>

      <Dialog
        className="admin-user-dialog"
        title={tokensOf ? `Access tokens — ${tokensOf.email}` : 'Access tokens'}
        open={tokensOf !== null}
        onClose={() => setTokensOf(null)}
        width={1120}
      >
        {tokensOf && <UserAccessTokens user={tokensOf} />}
      </Dialog>
      {wikiOf && <UserWikiDocs key={wikiOf.id} user={wikiOf} onClose={() => setWikiOf(null)} />}
    </div>
  );
}

/** What a space's choice says under its title: its version in force and how far its documents are written. */
function wikiSpaceState(space: WikiSupportSpace): string {
  if (space.confirmedVersion === null || !space.docs) return 'No plan in force: nothing to write yet';
  const written = `v${space.confirmedVersion} in force · ${space.docs.written} of ${plural(space.docs.total, 'document', 'documents')} written`;
  return space.building ? `${written} · being written now` : written;
}

/**
 * An account's wiki documents asked for again, for support (contracts/wiki.contract.json `plan.jobs.rebuild.support`):
 * its spaces, each with its version in force and how far its documents are written, one of them picked, and why —
 * recorded with the request as this administrator's. The server writes the version in force just as the owner's
 * Update documents on the plan page does; a space with no plan in force, or a build already on its way, cannot be
 * picked, and nothing can while the read does not say the server executes the account's wiki.
 */
function UserWikiDocs({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const message = useToast();
  const qc = useQueryClient();
  const [spaceId, setSpaceId] = useState('');
  const [why, setWhy] = useState('');
  const key = ['admin', 'users', user.id, 'wiki-spaces'] as const;
  const spacesQ = useQuery({ queryKey: key, queryFn: () => api<WikiSupportSpaces>(`/admin/wiki/users/${user.id}/spaces`) });
  const build = useMutation({
    mutationFn: ({ space, reason }: { space: WikiSupportSpace; reason: string }) =>
      api<WikiPlanSupportBuildResult>(`/admin/wiki/spaces/${space.id}/plan/build`, { method: 'POST', body: { reason } }),
    onSuccess: (answer, { space }) => {
      void qc.invalidateQueries({ queryKey: key });
      message.success(answer.created ? `Updating the documents of ${space.title}` : `The documents of ${space.title} are already being written`);
      onClose();
    },
    onError: (e: Error) => message.error("Couldn't update the documents", e.message),
  });
  const read = spacesQ.data;
  const ready = (space: WikiSupportSpace) => space.confirmedVersion !== null && !space.building;
  const picked = read?.serverExecutes ? read.spaces.find((space) => space.id === spaceId && ready(space)) : undefined;
  return (
    <Dialog
      className="admin-user-dialog"
      title={`Update wiki documents — ${user.email}`}
      open
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!picked || !why.trim()}
            loading={build.isPending}
            onClick={() => picked && build.mutate({ space: picked, reason: why.trim() })}
          >
            {UPDATE_DOCUMENTS}
          </Button>
        </>
      }
    >
      <div className="admin-user-form">
        <div>
          Writes what the space’s plan in force has not written yet, and what went out of date, as its owner’s Update
          documents does. Asking is recorded with your reason.
        </div>
        {spacesQ.isPending ? (
          <Spinner />
        ) : spacesQ.isError ? (
          <div>Couldn’t load the spaces: {spacesQ.error.message}</div>
        ) : !read || read.spaces.length === 0 ? (
          <div>This account has no wiki spaces.</div>
        ) : (
          <>
            {/* The sign-in policy's choices, one under another with their hint (Administration's own look). */}
            <RadioGroup<string> aria-label="Space" className="admin-signin-policy" value={spaceId} onValueChange={setSpaceId}>
              {read.spaces.map((space) => (
                <Radio key={space.id} value={space.id} disabled={!read.serverExecutes || !ready(space)}>
                  <span className="admin-signin-choice">{space.title}</span>
                  <span className="admin-signin-hint">{wikiSpaceState(space)}</span>
                </Radio>
              ))}
            </RadioGroup>
          </>
        )}
        <Textarea
          aria-label="Reason"
          placeholder="Reason, e.g. the support request you are answering"
          value={why}
          maxLength={500}
          autoSize={{ minRows: 2, maxRows: 6 }}
          onChange={(e) => setWhy(e.target.value)}
        />
      </div>
    </Dialog>
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
