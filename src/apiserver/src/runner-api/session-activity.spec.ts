import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunEventType } from '@orbit/shared';
import { hasSessionActivity } from './session-activity';

test('runner restart lifecycle events do not advance session activity', () => {
  assert.equal(
    hasSessionActivity([
      { type: RunEventType.SYSTEM, payload: { subtype: 'init' } },
      { type: RunEventType.SYSTEM, payload: { subtype: 'resumed' } },
    ]),
    false,
  );
});

test('system events emitted during a turn still count as activity', () => {
  assert.equal(hasSessionActivity([{ type: RunEventType.SYSTEM, turnId: 'turn-1' }]), true);
});

test('session-level agent and background events count as activity', () => {
  assert.equal(hasSessionActivity([{ type: RunEventType.ASSISTANT }]), true);
  assert.equal(hasSessionActivity([{ type: RunEventType.BACKGROUND_TASK }]), true);
});

test('an empty batch has no session activity', () => {
  assert.equal(hasSessionActivity([]), false);
});
