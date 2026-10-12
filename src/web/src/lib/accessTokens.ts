import type { AccessToken, AccessTokenLifetime } from '../api';

/**
 * What a personal access token can be granted, resource by resource, in the order the new-token
 * dialog lists them: the server's PAT_SCOPES (docs/personal-access-token-design.md §4). A scope the
 * server does not know is refused when the token is issued, so a stale list here shows as an error,
 * never as a token holding more than it says.
 */
export const SCOPE_GROUPS: readonly { resource: string; read: string; write?: string }[] = [
  { resource: 'Tasks', read: 'tasks:read', write: 'tasks:write' },
  { resource: 'Projects', read: 'projects:read', write: 'projects:write' },
  { resource: 'Sessions', read: 'sessions:read', write: 'sessions:write' },
  { resource: 'Workspaces', read: 'workspaces:read', write: 'workspaces:write' },
  { resource: 'Runners', read: 'runners:read' },
  { resource: 'Wiki', read: 'wiki:read', write: 'wiki:write' },
  { resource: 'Events', read: 'events:read' },
];

export const READ_SCOPES: readonly string[] = SCOPE_GROUPS.map((group) => group.read);
export const ALL_SCOPES: readonly string[] = SCOPE_GROUPS.flatMap((group) =>
  group.write ? [group.read, group.write] : [group.read],
);

export type ScopePreset = 'read' | 'readWrite' | 'custom';

/** The dialog's three presets (§4): every read scope, every scope, or a pick. */
export const SCOPE_PRESETS: readonly { value: ScopePreset; label: string }[] = [
  { value: 'read', label: 'Read-only' },
  { value: 'readWrite', label: 'Read & write' },
  { value: 'custom', label: 'Custom' },
];

export const scopesOfPreset = (preset: Exclude<ScopePreset, 'custom'>): string[] =>
  [...(preset === 'read' ? READ_SCOPES : ALL_SCOPES)];

const sameSet = (scopes: readonly string[], of: readonly string[]) =>
  scopes.length === of.length && of.every((scope) => scopes.includes(scope));

/** A token's scopes in a few words: a preset's name, or what it can do resource by resource. */
export function scopeSummary(scopes: readonly string[]): string {
  if (sameSet(scopes, ALL_SCOPES)) return 'Read & write · everything';
  if (sameSet(scopes, READ_SCOPES)) return 'Read-only · everything';
  return SCOPE_GROUPS.flatMap((group) => {
    const read = scopes.includes(group.read);
    const write = !!group.write && scopes.includes(group.write);
    if (read && write) return [`${group.resource}: read & write`];
    if (read) return [`${group.resource}: read`];
    if (write) return [`${group.resource}: write`];
    return [];
  }).join(' · ');
}

/** The lifetimes a token is issued with (§11.1); 90 days unless another is chosen. */
export const EXPIRY_OPTIONS: readonly { value: string; label: string; days: AccessTokenLifetime }[] = [
  { value: '30', label: '30 days', days: 30 },
  { value: '90', label: '90 days', days: 90 },
  { value: '365', label: '1 year', days: 365 },
  { value: 'never', label: 'Never', days: null },
];
export const DEFAULT_EXPIRY = '90';

/** What choosing Never means, said where it is chosen (§9). */
export const NEVER_EXPIRES_WARNING =
  'This token never expires. If it leaks, it keeps working until you revoke it.';

/** The mark a token that never expires carries in the list (§9). */
export const NEVER_EXPIRES = 'Never expires';

export const fullDate = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/** How far off an expiry still ahead is: "in 89 days", "in 5 hours". */
export function untilLine(iso: string, now: number): string {
  const left = Date.parse(iso) - now;
  const hours = Math.round(left / 3_600_000);
  if (hours < 1) return 'in less than an hour';
  if (hours < 24) return hours === 1 ? 'in 1 hour' : `in ${hours} hours`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'in 1 day' : `in ${days} days`;
}

/** Where a token was issued: in Settings, or by `orbit login` (§7.3). */
export const CREATED_VIA: Record<AccessToken['createdVia'], string> = {
  WEB: 'in Settings',
  CLI_DEVICE: 'by orbit login',
};

/** Why a token that no longer works stopped, in the list's words. */
export function endedLine(token: Pick<AccessToken, 'state' | 'revokedAt' | 'revokedReason' | 'expiresAt'>): string {
  if (token.state === 'EXPIRED') {
    const at = token.expiresAt ?? token.revokedAt;
    return at ? `Expired ${fullDate(at)}` : 'Expired';
  }
  const at = token.revokedAt ? ` ${fullDate(token.revokedAt)}` : '';
  if (token.revokedReason === 'ADMIN') return `Revoked by an administrator${at}`;
  if (token.revokedReason === 'PASSWORD_CHANGED') return `Revoked with a password change${at}`;
  return `Revoked${at}`;
}
