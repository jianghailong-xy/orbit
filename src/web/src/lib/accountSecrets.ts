import { queryOptions } from '@tanstack/react-query';
import { api } from '../api';
import { streamPoll } from './listBudget';

/**
 * Settings → Secrets (project "Secrets management page"): every copy of a secret on a machine, and the saved
 * secrets "Use saved" offers. Labels, places, states and dates only: no route returns a value, and nothing here
 * asks for one back.
 */

export type GrantState = 'PENDING_DELIVERY' | 'ACTIVE' | 'REMOVING' | 'REMOVED';
export type GrantEndReason =
  | 'TASK_ENDED' | 'SESSION_ENDED' | 'EXPIRED' | 'WITHDRAWN' | 'REVOKED' | 'MOVED' | 'RUNNER_DELETED'
  | 'KEY_UNREADABLE' | 'DELIVERY_FAILED';

/** One copy of a secret on a machine (GET /account-secrets/grants). */
export interface SecretGrant {
  id: string;
  requestId: string;
  label: string;
  exposure: 'ENV' | 'FILE';
  envName: string | null;
  filePath: string | null;
  /** `id` is null once the runner is deleted; `name` is then the one recorded on the copy. */
  runner: { id: string | null; name: string | null; online: boolean; lastHeartbeatAt: string | null };
  sessionId: string;
  sessionTitle: string | null;
  taskId: string | null;
  taskTitle: string | null;
  taskScoped: boolean;
  state: GrantState;
  endReason: GrantEndReason | null;
  removalNote: string | null;
  createdAt: string;
  fetchedAt: string | null;
  deliveredAt: string | null;
  expiresAt: string;
  removedAt: string | null;
  savedSecretId: string | null;
  deliveryHint: { reason: 'RUNNER_OFFLINE' | 'FETCHED_NOT_ACKED' | 'NOT_FETCHED'; since: string } | null;
}

/** One saved secret as the Secrets page lists it (GET /account-secrets). */
export interface SavedSecret {
  id: string;
  label: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  liveCopies: { count: number; runnerNames: string[] };
}

/** Refreshed on the same realtime events, and at the same floor, as the owner-request card (ownerRequestsQuery). */
const LIKE_OWNER_REQUESTS = { meta: { entities: ['session'] }, refetchInterval: streamPoll(20_000) } as const;

/** The saved secrets, with their dates and live copies. Shares accountSecretsQuery's key, so a write refreshes both. */
export const savedSecretsQuery = () =>
  queryOptions({
    queryKey: ['account-secrets'] as const,
    queryFn: () => api<{ secrets: SavedSecret[] }>('/account-secrets'),
    ...LIKE_OWNER_REQUESTS,
  });

/** Every copy on a machine: live, and removed in the last 30 days (the page hides those until asked). */
export const secretGrantsQuery = () =>
  queryOptions({
    queryKey: ['account-secrets', 'grants'] as const,
    queryFn: () => api<{ grants: SecretGrant[] }>('/account-secrets/grants?removed=30d'),
    ...LIKE_OWNER_REQUESTS,
  });

export const revokeGrant = (id: string) =>
  api<void>(`/account-secrets/grants/${encodeURIComponent(id)}/revoke`, { method: 'POST' });
export const createSavedSecret = (label: string, value: string) =>
  api<SavedSecret>('/account-secrets', { method: 'POST', body: { label, value } });
export const replaceSavedSecret = (id: string, value: string) =>
  api<void>(`/account-secrets/${encodeURIComponent(id)}`, { method: 'PUT', body: { value } });
export const deleteSavedSecret = (id: string, revokeCopies: boolean) =>
  api<void>(`/account-secrets/${encodeURIComponent(id)}${revokeCopies ? '?revokeCopies=true' : ''}`, { method: 'DELETE' });

// ─── Words ────────────────────────────────────────────────────────────────────────────────────

/** How a row reads: the state chip, its tone, and whether it needs the owner's attention. */
export type GrantView = 'ACTIVE' | 'WAITING' | 'REMOVING' | 'UNCONFIRMED' | 'REMOVED';

export const GRANT_CHIP: Record<GrantView, { text: string; tone: 'green' | 'orange' | 'blue' | 'red' | 'default' }> = {
  ACTIVE: { text: 'Active', tone: 'green' },
  WAITING: { text: 'Waiting for delivery', tone: 'orange' },
  REMOVING: { text: 'Removing', tone: 'blue' },
  UNCONFIRMED: { text: 'Removal unconfirmed', tone: 'red' },
  REMOVED: { text: 'Removed', tone: 'default' },
};

/**
 * "Removal unconfirmed" is not a state of its own: it is REMOVED with endReason RUNNER_DELETED, the one case where a
 * copy may still be on a machine. A live copy whose scope has ended reads as Removing: the sweep is about to end it.
 */
export function grantView(grant: SecretGrant): GrantView {
  if (grant.state === 'REMOVED') return grant.endReason === 'RUNNER_DELETED' ? 'UNCONFIRMED' : 'REMOVED';
  if (grant.state === 'REMOVING' || grant.endReason) return 'REMOVING';
  return grant.state === 'PENDING_DELIVERY' ? 'WAITING' : 'ACTIVE';
}

/** Still (possibly) on a machine: counted as live, and Revoke/Cancel apply. */
export const isLive = (grant: SecretGrant) => grant.state !== 'REMOVED';

export const END_REASON: Record<GrantEndReason, string> = {
  TASK_ENDED: 'Task ended',
  SESSION_ENDED: 'Session ended',
  EXPIRED: 'Expired',
  WITHDRAWN: 'Withdrawn',
  REVOKED: 'Revoked',
  MOVED: 'Session moved to another machine',
  RUNNER_DELETED: 'Runner deleted',
  KEY_UNREADABLE: 'Machine could not read its key',
  DELIVERY_FAILED: 'Delivery failed',
};

export const machineName = (grant: SecretGrant) => grant.runner.name ?? 'Unknown machine';

/** How long since `iso`, as the mockup words it: "20 s", "6 min", "3 h", "2 d". */
export function span(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86_400)} d`;
}

const ago = (iso: string, now: number) => `${span(iso, now)} ago`;

/** Why a copy waiting for delivery has not arrived, and since when: one line, or two with the last heartbeat. */
export function deliveryLines(grant: SecretGrant, now: number): string[] {
  const hint = grant.deliveryHint;
  const machine = machineName(grant);
  if (!hint) return [];
  if (hint.reason === 'RUNNER_OFFLINE') return [`${machine} is offline`, `Last heartbeat ${ago(hint.since, now)}`];
  const beat = grant.runner.lastHeartbeatAt ? [`Last heartbeat ${ago(grant.runner.lastHeartbeatAt, now)}`] : [];
  if (hint.reason === 'FETCHED_NOT_ACKED') return [`${machine} fetched it ${ago(hint.since, now)} but hasn't confirmed it`, ...beat];
  return [`${machine} hasn't fetched it for ${span(hint.since, now)}`, ...beat];
}

const TIME = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

/** "01:28" today, "Nov 12" before. */
export function shortWhen(iso: string, now: number): string {
  const at = new Date(iso);
  return sameDay(at, new Date(now)) ? TIME.format(at) : DAY.format(at);
}

/** "Today, 01:28" today, "Nov 2" before. */
export function lastUsedWhen(iso: string | null, now: number): string {
  if (!iso) return 'Never';
  const at = new Date(iso);
  return sameDay(at, new Date(now)) ? `Today, ${TIME.format(at)}` : DAY.format(at);
}

/** "Nov 9". */
export const dayOf = (iso: string) => DAY.format(new Date(iso));

/** "Nov 17, 01:28". */
export const dayAndTime = (iso: string) => `${dayOf(iso)}, ${TIME.format(new Date(iso))}`;

/** What the copy is called on the machine: the env name or the file path. */
export const exposedName = (grant: SecretGrant) => grant.envName ?? grant.filePath ?? '';

export const copies = (n: number) => (n === 1 ? '1 live copy' : `${n} live copies`);
