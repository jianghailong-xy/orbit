import { describe, expect, it } from 'vitest';
import { LOGIN_WARNING_LEAD_MS, loginExpiresLine, signedOutNote } from './accountLogin';

const NOW = Date.parse('2026-10-07T12:00:00.000Z');
const inHours = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();

describe('a login about to lapse', () => {
  it('warns from three days out, as Claude Code does', () => {
    expect(LOGIN_WARNING_LEAD_MS).toBe(3 * 24 * 3_600_000);
    expect(loginExpiresLine({ auth: 'yes', loginExpiresAt: inHours(72) }, NOW)).toBe('Login expires in 3 days');
    expect(loginExpiresLine({ auth: 'yes', loginExpiresAt: inHours(73) }, NOW)).toBeNull();
  });

  it('counts whole days rounded up, the way the CLI counts them', () => {
    expect(loginExpiresLine({ auth: 'yes', loginExpiresAt: inHours(49) }, NOW)).toBe('Login expires in 3 days');
    expect(loginExpiresLine({ auth: 'yes', loginExpiresAt: inHours(30) }, NOW)).toBe('Login expires in 2 days');
    expect(loginExpiresLine({ auth: 'yes', loginExpiresAt: inHours(5) }, NOW)).toBe('Login expires in 1 day');
  });

  it('says nothing for a login past it, one not signed in, or one with no time read', () => {
    // Past it, the runner reports the account signed out, and that row says so instead.
    expect(loginExpiresLine({ auth: 'yes', loginExpiresAt: inHours(-1) }, NOW)).toBeNull();
    expect(loginExpiresLine({ auth: 'no', loginExpiresAt: inHours(5) }, NOW)).toBeNull();
    expect(loginExpiresLine({ auth: 'unknown', loginExpiresAt: inHours(5) }, NOW)).toBeNull();
    expect(loginExpiresLine({ auth: 'yes' }, NOW)).toBeNull();
    expect(loginExpiresLine({ auth: 'yes', loginExpiresAt: 'soon' }, NOW)).toBeNull();
    expect(loginExpiresLine(undefined, NOW)).toBeNull();
  });
});

describe('what a signed-out account costs', () => {
  it('is the account, or the engine on that machine when it is the only one there', () => {
    expect(signedOutNote('Claude Code', false)).toBe('Sessions can’t use this account until you sign in again.');
    expect(signedOutNote('Claude Code', true)).toBe('Sessions on this runner can’t use Claude Code until you sign in again.');
  });
});
