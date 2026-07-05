import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ControlEventType, RunEventType } from '@orbit/shared';
import {
  approvalIdOf,
  backgroundPayloadOf,
  controlTypeFor,
  errorPayloadOf,
} from './control-events';

test('controlTypeFor maps the forwarded subset', () => {
  assert.equal(controlTypeFor(RunEventType.STATUS), ControlEventType.SESSION_UPDATED);
  assert.equal(controlTypeFor(RunEventType.TURN_END), ControlEventType.SESSION_UPDATED);
  assert.equal(controlTypeFor(RunEventType.ERROR), ControlEventType.SESSION_ERROR);
  assert.equal(controlTypeFor(RunEventType.APPROVAL_REQUEST), ControlEventType.APPROVAL_REQUESTED);
  assert.equal(controlTypeFor(RunEventType.APPROVAL_RESOLVED), ControlEventType.APPROVAL_RESOLVED);
  assert.equal(controlTypeFor(RunEventType.BACKGROUND_TASK), ControlEventType.BACKGROUND_TASK);
});

test('controlTypeFor maps the synthesized lifecycle signals', () => {
  assert.equal(controlTypeFor(RunEventType.SESSION_CREATED), ControlEventType.SESSION_CREATED);
  assert.equal(controlTypeFor(RunEventType.SESSION_ENDED), ControlEventType.SESSION_ENDED);
});

test('controlTypeFor drops transcript/data-plane events', () => {
  for (const t of [
    RunEventType.TEXT_DELTA,
    RunEventType.THINKING_DELTA,
    RunEventType.ASSISTANT,
    RunEventType.TOOL_USE,
    RunEventType.TOOL_RESULT,
    RunEventType.SYSTEM,
    RunEventType.USER,
    RunEventType.RESULT,
    RunEventType.BACKGROUND_OUTPUT,
  ]) {
    assert.equal(controlTypeFor(t), null, `${t} should be dropped`);
  }
});

test('errorPayloadOf extracts message and defaults recoverable to false', () => {
  assert.deepEqual(errorPayloadOf({ message: 'boom' }), { message: 'boom', recoverable: false });
  assert.deepEqual(errorPayloadOf({ error: 'API Error: x', recoverable: true }), {
    message: 'API Error: x',
    recoverable: true,
  });
  assert.equal(errorPayloadOf({}).message, 'run error');
});

test('backgroundPayloadOf names the process from command and includes a numeric exit code', () => {
  assert.deepEqual(backgroundPayloadOf({ command: 'npm test', status: 'completed', exitCode: 0 }), {
    name: 'npm test',
    status: 'completed',
    exitCode: 0,
  });
  // No exit code → key omitted (not undefined).
  const noExit = backgroundPayloadOf({ command: 'sleep 1', status: 'killed' });
  assert.deepEqual(noExit, { name: 'sleep 1', status: 'killed' });
  assert.equal('exitCode' in noExit, false);
});

test('approvalIdOf reads payload.id', () => {
  assert.equal(approvalIdOf({ id: 'ap1', toolName: 'Bash' }), 'ap1');
  assert.equal(approvalIdOf({ approvalId: 'ap2' }), 'ap2');
  assert.equal(approvalIdOf({}), '');
});
