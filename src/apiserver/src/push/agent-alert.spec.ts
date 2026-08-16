import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentAlert } from './agent-alert';

test('an empty or whitespace-only message is nothing to announce', () => {
  assert.equal(agentAlert(''), null);
  assert.equal(agentAlert('   \n\t '), null);
});

test('whitespace is collapsed so the line reads as one on a lock screen', () => {
  assert.deepEqual(agentAlert('  Migration failed.\n\n  Rolled back.  '), {
    body: 'Migration failed. Rolled back.',
    truncated: false,
  });
});

test('a long message is cut rather than refused, and says it was cut', () => {
  const alert = agentAlert('x'.repeat(500));
  assert.ok(alert);
  // Truncation is only worth reporting because the agent can then say the rest another way;
  // silently sending a fragment would let it believe the whole thing was read.
  assert.equal(alert.truncated, true);
  assert.equal(alert.body.length, 200);
  assert.ok(alert.body.endsWith('…'));
});

test('a message at exactly the limit is left alone', () => {
  const alert = agentAlert('x'.repeat(200));
  assert.deepEqual(alert, { body: 'x'.repeat(200), truncated: false });
});
