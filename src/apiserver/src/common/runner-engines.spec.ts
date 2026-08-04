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
