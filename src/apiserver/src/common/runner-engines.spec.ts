import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sanitizeRunnerEngines } from './runner-engines';

test('engine health is normalized to the login engines, in display order', () => {
  assert.deepEqual(
    sanitizeRunnerEngines([
      { engine: 'kimi', installed: false, auth: 'no' },
      { engine: 'claude', installed: true, version: '  2.1.4 ', auth: 'yes' },
    ]),
    [
      { engine: 'claude', installed: true, version: '2.1.4', auth: 'yes' },
      { engine: 'kimi', installed: false, auth: 'no' },
    ],
  );
});

test('anything that is not a recognizable entry is dropped, not repaired', () => {
  assert.deepEqual(
    sanitizeRunnerEngines([
      null,
      'claude',
      { engine: 'opencode', installed: true, auth: 'yes' },
      { installed: true, auth: 'yes' },
      { engine: 'codex', installed: true, auth: 'yes' },
      // A second report for the same engine loses to the first.
      { engine: 'codex', installed: false, auth: 'no' },
    ]),
    [{ engine: 'codex', installed: true, auth: 'yes' }],
  );
});

test('only the CLI\'s own yes/no counts — everything else is unknown', () => {
  assert.deepEqual(
    sanitizeRunnerEngines([
      { engine: 'claude', installed: true, auth: 'probably' },
      { engine: 'codex', installed: true },
      { engine: 'kimi', installed: 'yes', auth: 'yes' },
    ]),
    [
      { engine: 'claude', installed: true, auth: 'unknown' },
      { engine: 'codex', installed: true, auth: 'unknown' },
      // A non-boolean `installed` is not installed: this drives an Install button, so the
      // permissive reading is the safe one.
      { engine: 'kimi', installed: false, auth: 'yes' },
    ],
  );
});

test('nothing usable reads as "not reported", which is not the same as "nothing installed"', () => {
  assert.equal(sanitizeRunnerEngines(null), null);
  assert.equal(sanitizeRunnerEngines([]), null);
  assert.equal(sanitizeRunnerEngines([{ engine: 'nope' }]), null);
  assert.equal(sanitizeRunnerEngines({ claude: true }), null);
});

test('an update record is carried through, with its times normalized to ISO', () => {
  const [claude] = sanitizeRunnerEngines([
    {
      engine: 'claude',
      installed: true,
      auth: 'yes',
      update: {
        status: 'failed',
        at: '2026-08-04T09:00:00Z',
        okAt: '2026-07-30T09:00:00Z',
        message: '  npm error code EACCES  ',
      },
    },
  ])!;
  assert.deepEqual(claude.update, {
    status: 'failed',
    at: '2026-08-04T09:00:00.000Z',
    // The one field that must survive a failure: it separates "erroring today" from "never worked".
    okAt: '2026-07-30T09:00:00.000Z',
    message: 'npm error code EACCES',
  });
});

test('a malformed update is dropped whole, leaving the engine itself intact', () => {
  const bad = (update: unknown) =>
    sanitizeRunnerEngines([{ engine: 'codex', installed: true, auth: 'yes', update }])![0];

  // Each of these would otherwise render as a confident claim about someone's machine.
  assert.equal(bad({ status: 'maybe', at: '2026-08-04T09:00:00Z' }).update, undefined);
  assert.equal(bad({ status: 'ok' }).update, undefined, 'a time-less record cannot be aged');
  assert.equal(bad({ status: 'ok', at: 'last tuesday' }).update, undefined);
  assert.equal(bad('ok').update, undefined);
  assert.equal(bad(null).update, undefined);
  // The engine's own health still stands — a bad update record is not a bad engine report.
  assert.equal(bad(null).auth, 'yes');
});

test('an unparseable okAt is dropped without taking the record with it', () => {
  const [kimi] = sanitizeRunnerEngines([
    {
      engine: 'kimi',
      installed: true,
      auth: 'yes',
      update: { status: 'ok', at: '2026-08-04T09:00:00Z', okAt: 'never' },
    },
  ])!;
  assert.deepEqual(kimi.update, { status: 'ok', at: '2026-08-04T09:00:00.000Z' });
});

test('a runaway message is truncated rather than stored whole', () => {
  const [claude] = sanitizeRunnerEngines([
    {
      engine: 'claude',
      installed: true,
      auth: 'yes',
      update: { status: 'failed', at: '2026-08-04T09:00:00Z', message: 'x'.repeat(5000) },
    },
  ])!;
  assert.equal(claude.update?.message?.length, 400);
});
