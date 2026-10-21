import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validate } from 'class-validator';
import { PauseAccountDto, accountPauseUntil, runnerAccountPausedUntil } from '../common/account-pause';
import { namedRunnerEngines } from '../common/runner-engines';
import { accountBeforeDispatch, automaticAccount, sessionAccountPausedUntil } from '../providers/plan-usage-accounts';

const now = new Date('2026-10-04T08:50:00Z');
const until = '2026-10-04T10:50:00.000Z';
const work = '1fda3f43';
const engines = ['codex', 'claude'].map(engine => ({ engine, installed: true, auth: 'yes', accounts: [
  { id: 'default', home: `/home/test/.${engine}`, auth: 'yes' },
  { id: work, home: `/home/test/${engine}-work`, auth: 'yes' },
]}));
const pauses = { codex: { default: until } };
/** The runner as the account helpers read it: these engines and pauses, nothing reported of its quota, no
 *  Default removed from Orbit. */
const runner = { engines, accountPauses: pauses, defaultRemoved: [], planUsage: null };

test('pause request requires an integer duration or explicit null', async () => {
  for (const invalid of [undefined, -1, 0, 10081, 1.5, '120', NaN]) {
    const dto = Object.assign(new PauseAccountDto(), { durationMinutes: invalid });
    assert.ok((await validate(dto)).length, String(invalid));
    assert.throws(() => accountPauseUntil(invalid as number, now));
  }
  for (const valid of [null, 1, 120, 10080]) {
    assert.equal((await validate(Object.assign(new PauseAccountDto(), { durationMinutes: valid }))).length, 0);
  }
  assert.equal(accountPauseUntil(120, now)?.toISOString(), until);
  assert.equal(accountPauseUntil(null, now), null);
});

test('server pause expires at its boundary and cannot be supplied by a heartbeat', () => {
  assert.equal(runnerAccountPausedUntil(pauses, 'codex', 'default', now)?.toISOString(), until);
  assert.equal(runnerAccountPausedUntil(pauses, 'codex', 'default', new Date(until)), null);
  assert.equal(runnerAccountPausedUntil(pauses, 'claude', 'default', now), null);
  const forged = [{ ...engines[0], accounts: engines[0].accounts.map(a => ({ ...a, pausedUntil: until })) }];
  assert.equal(namedRunnerEngines({ engines: forged, accountNames: null })?.[0].accounts?.[0].pausedUntil, undefined);
});

test('automatic personal accounts skip pauses; pinned and own-key sessions retain their meaning', () => {
  assert.equal(automaticAccount('codex', {}, runner, now), work);
  assert.deepEqual(accountBeforeDispatch('codex', { account: 'default' }, {}, runner, now),
    { from: 'default', to: work, paused: true });
  assert.equal(accountBeforeDispatch('codex', { account: 'default', pinned: true }, {}, runner, now), null);
  const session = { provider: 'codex', providerBuiltin: true, codexAccount: 'default' };
  assert.equal(sessionAccountPausedUntil(session, {}, runner, now)?.toISOString(), until);
  assert.equal(sessionAccountPausedUntil(session, { env: { OPENAI_API_KEY: 'own-key' } }, runner, now), null);
  assert.equal(sessionAccountPausedUntil({ ...session, providerBuiltin: false }, {}, runner, now), null);
  assert.equal(automaticAccount('codex', {}, runner, new Date(until)), 'default');
});
