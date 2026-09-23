import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunnerEngineAccount, RunnerEngineHealth } from '@orbit/shared';
import { ENGINE_ACCOUNTS_MAX, sanitizeRunnerEngines } from './runner-engines';

// The heartbeat's `engines` are rebuilt field by field on the way into the runner row and again on
// the way out to the page (runner-api.controller, runners.service): whatever this drops never
// reaches the Providers page, however faithfully the runner reported it.

const DEFAULT: RunnerEngineAccount = {
  id: 'default',
  codexHome: '/home/ada/.codex',
  auth: 'yes',
  fingerprintPrefix: 'cxa1_9f3a41c7',
};
const WORK: RunnerEngineAccount = {
  id: '3fa91c2e',
  name: 'Work',
  codexHome: '/home/ada/.orbit/codex-accounts/3fa91c2e',
  auth: 'no',
};

const codex = (accounts: unknown, over: Record<string, unknown> = {}) => ({
  engine: 'codex',
  installed: true,
  version: 'codex-cli 0.156.0',
  auth: 'yes',
  accounts,
  ...over,
});

/** The accounts that come out the other side for one Codex report. */
const accountsOf = (accounts: unknown): RunnerEngineAccount[] | undefined =>
  sanitizeRunnerEngines([codex(accounts)])?.[0]?.accounts;

test('a legal account list comes through exactly as the runner sent it', () => {
  const unknown: RunnerEngineAccount = {
    id: '0b05070e',
    name: 'Personal',
    codexHome: '/home/ada/.orbit/codex-accounts/0b05070e',
    auth: 'unknown',
  };
  const sent = codex([DEFAULT, WORK, unknown]);

  assert.deepEqual(sanitizeRunnerEngines([sent]), [sent]);
});

test('what comes out is stored, and reads back unchanged on the way to the page', () => {
  const once = sanitizeRunnerEngines([codex([DEFAULT, WORK])]);
  // The row stores the sanitized list and the page reads it through the same function again.
  assert.deepEqual(sanitizeRunnerEngines(JSON.parse(JSON.stringify(once))), once);
});

test('an account it cannot read is dropped whole, and its readable siblings stay', () => {
  const kept = accountsOf([
    null,
    'default',
    42,
    // Ids are the runner's slot names, exactly: `default` or 8 lowercase hex digits.
    { ...WORK, id: '3FA91C2E' },
    { ...WORK, id: '3fa91c2' },
    { ...WORK, id: 'Default' },
    { ...WORK, id: '../../etc' },
    { ...WORK, id: 7 },
    { ...WORK, id: undefined },
    // No CODEX_HOME is not an account on a machine.
    { ...WORK, codexHome: undefined },
    { ...WORK, codexHome: '   ' },
    { ...WORK, codexHome: ['/home/ada/.codex'] },
    DEFAULT,
    WORK,
  ]);

  assert.deepEqual(kept, [DEFAULT, WORK]);
});

test('an account whose sign-in state is not one of the three is dropped, not rounded to unknown', () => {
  // The engine's own `auth` is repaired to `unknown`; an account's is not — an entry that doesn't
  // say which state it is in is not a report about an account.
  for (const auth of ['probably', 'YES', true, 1, null, undefined]) {
    assert.deepEqual(accountsOf([DEFAULT, { ...WORK, auth }]), [DEFAULT], `auth ${String(auth)}`);
  }
  assert.deepEqual(accountsOf([{ ...DEFAULT, auth: 'unknown' }]), [{ ...DEFAULT, auth: 'unknown' }]);
});

test('a second report for the same account loses to the first', () => {
  assert.deepEqual(accountsOf([WORK, { ...WORK, auth: 'yes', name: 'Imposter' }, DEFAULT]), [WORK, DEFAULT]);
});

test('no more accounts than the cap are kept, in the order the runner listed them', () => {
  const many = Array.from({ length: ENGINE_ACCOUNTS_MAX + 24 }, (_, i) => ({
    id: i.toString(16).padStart(8, '0'),
    codexHome: `/home/ada/.orbit/codex-accounts/${i.toString(16).padStart(8, '0')}`,
    auth: 'no',
  }));

  const kept = accountsOf(many)!;
  assert.equal(kept.length, ENGINE_ACCOUNTS_MAX);
  assert.deepEqual(kept, many.slice(0, ENGINE_ACCOUNTS_MAX));
});

test('names and paths are trimmed and truncated, never stored runaway', () => {
  const [account] = accountsOf([
    { ...WORK, name: `  ${'n'.repeat(500)}  `, codexHome: `  /${'p'.repeat(5000)}  ` },
  ])!;
  assert.equal(account.name, 'n'.repeat(60));
  assert.equal(account.codexHome, `/${'p'.repeat(399)}`);
  // A blank or non-string name is no name: the page falls back to its own label, not to "   ".
  assert.deepEqual(accountsOf([{ ...WORK, name: '   ' }]), [{ id: WORK.id, codexHome: WORK.codexHome, auth: 'no' }]);
  assert.deepEqual(accountsOf([{ ...WORK, name: 17 }]), [{ id: WORK.id, codexHome: WORK.codexHome, auth: 'no' }]);
});

test('only a fingerprint prefix passes as one — anything else is dropped, the account kept', () => {
  const withPrefix = (fingerprintPrefix: unknown) => accountsOf([{ ...DEFAULT, fingerprintPrefix }])!;
  const { fingerprintPrefix: _, ...bare } = DEFAULT;

  assert.deepEqual(withPrefix('cxa1_9f3a41c7'), [DEFAULT]);
  for (const bad of [
    // The whole fingerprint: the page gets a prefix, never what reset operations bind to.
    'cxa1_9f3a41c7e2d5b8a60123456789abcdef',
    // What a runner must never send, and this must never store: the account's own identity.
    'ada@example.com',
    'acct_6b8e2f0c9d1a',
    'CXA1_9F3A41C7',
    'cxa1_9f3a',
    42,
  ]) {
    const [account] = withPrefix(bad);
    assert.deepEqual(account, bare, `fingerprintPrefix ${String(bad)}`);
    assert.ok(!JSON.stringify(account).includes(String(bad)), `${String(bad)} was stored`);
  }
});

test('an older runner, or a list with nothing readable, reads as the one account there always was', () => {
  for (const accounts of [undefined, null, 'default', { default: 'yes' }, [], [null, { id: 'default' }]]) {
    const [engine] = sanitizeRunnerEngines([codex(accounts)])!;
    assert.equal('accounts' in engine, false, `accounts ${JSON.stringify(accounts)}`);
    // The engine's own report still stands — a bad account list is not a bad engine report.
    assert.deepEqual(engine, { engine: 'codex', installed: true, version: 'codex-cli 0.156.0', auth: 'yes' });
  }
});

test('only Codex carries accounts', () => {
  const engines = sanitizeRunnerEngines([
    { engine: 'claude', installed: true, auth: 'yes', accounts: [DEFAULT] },
    { engine: 'kimi', installed: true, auth: 'no', accounts: [WORK] },
    codex([DEFAULT, WORK]),
  ])!;
  const byEngine = new Map<string, RunnerEngineHealth>(engines.map((e) => [e.engine, e]));

  assert.equal('accounts' in byEngine.get('claude')!, false);
  assert.equal('accounts' in byEngine.get('kimi')!, false);
  assert.deepEqual(byEngine.get('codex')!.accounts, [DEFAULT, WORK]);
});
