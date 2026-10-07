import { describe, expect, it } from 'vitest';
import {
  ALL_SCOPES,
  DEFAULT_EXPIRY,
  EXPIRY_OPTIONS,
  READ_SCOPES,
  endedLine,
  scopeSummary,
  untilLine,
} from './accessTokens';

// What the access tokens page says about a token (docs/personal-access-token-design.md §4, §9, §11).

describe('the scopes a token can be granted', () => {
  it('are the server’s twelve (PAT_SCOPES), read-only being every :read one', () => {
    expect([...ALL_SCOPES].sort()).toEqual([
      'events:read',
      'projects:read',
      'projects:write',
      'runners:read',
      'sessions:read',
      'sessions:write',
      'tasks:read',
      'tasks:write',
      'wiki:read',
      'wiki:write',
      'workspaces:read',
      'workspaces:write',
    ]);
    expect(READ_SCOPES.every((scope) => scope.endsWith(':read'))).toBe(true);
    expect(ALL_SCOPES.filter((scope) => scope.endsWith(':read'))).toEqual(READ_SCOPES);
  });

  it('read as a preset’s name, or resource by resource', () => {
    expect(scopeSummary([...ALL_SCOPES].reverse())).toBe('Read & write · everything');
    expect(scopeSummary(READ_SCOPES)).toBe('Read-only · everything');
    expect(scopeSummary(['tasks:read', 'wiki:write', 'tasks:write', 'events:read'])).toBe(
      'Tasks: read & write · Wiki: write · Events: read',
    );
  });
});

describe('a token’s lifetime', () => {
  it('is 30, 90 or 365 days, or never, 90 unless another is chosen', () => {
    expect(EXPIRY_OPTIONS.map((option) => option.days)).toEqual([30, 90, 365, null]);
    expect(EXPIRY_OPTIONS.find((option) => option.value === DEFAULT_EXPIRY)?.days).toBe(90);
  });

  it('counts down in days, then hours', () => {
    const now = Date.parse('2026-10-06T00:00:00Z');
    expect(untilLine('2027-01-04T00:00:00Z', now)).toBe('in 90 days');
    expect(untilLine('2026-10-07T00:00:00Z', now)).toBe('in 1 day');
    expect(untilLine('2026-10-06T05:00:00Z', now)).toBe('in 5 hours');
    expect(untilLine('2026-10-06T00:20:00Z', now)).toBe('in less than an hour');
  });

  it('ends for a reason the list names', () => {
    const at = '2026-10-01T12:00:00Z';
    expect(endedLine({ state: 'EXPIRED', expiresAt: at, revokedAt: null, revokedReason: null })).toBe('Expired Oct 1, 2026');
    expect(endedLine({ state: 'EXPIRED', expiresAt: at, revokedAt: at, revokedReason: 'EXPIRED' })).toBe('Expired Oct 1, 2026');
    expect(endedLine({ state: 'REVOKED', expiresAt: null, revokedAt: at, revokedReason: 'USER' })).toBe('Revoked Oct 1, 2026');
    expect(endedLine({ state: 'REVOKED', expiresAt: null, revokedAt: at, revokedReason: 'ADMIN' })).toBe(
      'Revoked by an administrator Oct 1, 2026',
    );
    expect(endedLine({ state: 'REVOKED', expiresAt: null, revokedAt: at, revokedReason: 'PASSWORD_CHANGED' })).toBe(
      'Revoked with a password change Oct 1, 2026',
    );
  });
});
