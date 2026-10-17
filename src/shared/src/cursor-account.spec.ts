import { describe, expect, it } from 'vitest';
import type { PlanUsage, RunnerEngineAccount } from './dto';
import {
  ACCOUNT_DIR_VAR,
  ACCOUNT_ENGINES,
  accountOfEnv,
  accountToStartOn,
  isAccountEngine,
} from './planUsage';

// Cursor CLI keeps accounts like Codex, Claude Code, Antigravity and Kimi Code
// (docs/cursor-runtime-contract.md §16; project P4a). The acceptance script
// (scripts/test-cursor-accounts-server.mjs) runs every case below by name.

const NOW = new Date('2026-10-17T08:00:00Z');
const DEFAULT_DIR = '/root/.orbit/cursor/default';
const WORK = 'c41e0b7a';
const WORK_DIR = `/root/.orbit/cursor-accounts/${WORK}`;
const TEAM = '0b5e77d1';
const TEAM_DIR = `/root/.orbit/cursor-accounts/${TEAM}`;

const accounts = (defaultAuth: RunnerEngineAccount['auth'] = 'yes'): RunnerEngineAccount[] => [
  { id: 'default', home: DEFAULT_DIR, auth: defaultAuth },
  { id: WORK, name: 'Work', home: WORK_DIR, auth: 'yes' },
  { id: TEAM, name: 'Team', home: TEAM_DIR, auth: 'yes' },
];

describe('Cursor CLI accounts', () => {
  it('P4a cursor keeps accounts, and an account is handed to the runner as ORBIT_CURSOR_ACCOUNT_DIR', () => {
    expect(ACCOUNT_ENGINES).toEqual(['claude', 'codex', 'antigravity', 'kimi', 'cursor']);
    expect(isAccountEngine('cursor')).toBe(true);
    expect(ACCOUNT_DIR_VAR.cursor).toBe('ORBIT_CURSOR_ACCOUNT_DIR');
    // The variable the runner reads is the account's directory, as the runner reported it.
    expect(accountOfEnv('cursor', { ORBIT_CURSOR_ACCOUNT_DIR: WORK_DIR }, accounts())).toBe(WORK);
    expect(accountOfEnv('cursor', { ORBIT_CURSOR_ACCOUNT_DIR: `${TEAM_DIR}/` }, accounts())).toBe(TEAM);
    // No variable is Default: the runner keeps Default's directory under its own home, which no
    // variable of the session's moves — HOME included.
    expect(accountOfEnv('cursor', {}, accounts())).toBe('default');
    expect(accountOfEnv('cursor', { HOME: '/home/elsewhere' }, accounts())).toBe('default');
    // A directory none of the runner's accounts lives in is spent by no account it reports.
    expect(accountOfEnv('cursor', { ORBIT_CURSOR_ACCOUNT_DIR: '/srv/typed-by-hand' }, accounts())).toBeNull();
  });

  it('P4a a Cursor CLI run with a key or token of its own spends no account', () => {
    // CURSOR_API_KEY or CURSOR_AUTH_TOKEN signs the CLI in by itself (contract §2.3), each alone.
    for (const env of [{ CURSOR_API_KEY: 'key_x' }, { CURSOR_AUTH_TOKEN: 'token_x' }]) {
      expect(accountOfEnv('cursor', env, accounts())).toBeNull();
      // Not beside an added account the run names: the runner hands the CLI that account's login in
      // their place (contract §16.3), so the run spends it (P6a, cursor-plan-usage.spec.ts).
      expect(accountOfEnv('cursor', { ...env, ORBIT_CURSOR_ACCOUNT_DIR: WORK_DIR }, accounts())).toBe(WORK);
    }
    // A blank one is no credential.
    expect(accountOfEnv('cursor', { CURSOR_API_KEY: '  ' }, accounts())).toBe('default');
  });

  it('P4a Automatic starts a Cursor CLI session on Default while no Cursor CLI quota is reported', () => {
    // Nothing reports Cursor CLI's quota yet, whatever the other engines report: every account is
    // as good as another, and the tie goes to Default.
    const usage: PlanUsage = {
      claude: { provider: 'claude', fiveHour: { utilization: 99, resetsAt: '2026-10-17T09:00:00Z' } },
    } as PlanUsage;
    expect(accountToStartOn('cursor', accounts(), null, NOW)).toBe('default');
    expect(accountToStartOn('cursor', accounts(), usage, NOW)).toBe('default');
    // Unless Default is signed out: then the first account that is not.
    expect(accountToStartOn('cursor', accounts('no'), null, NOW)).toBe(TEAM);
    // One account is nothing to choose between: the session runs where it always did.
    expect(accountToStartOn('cursor', accounts().slice(0, 1), null, NOW)).toBeNull();
  });
});
