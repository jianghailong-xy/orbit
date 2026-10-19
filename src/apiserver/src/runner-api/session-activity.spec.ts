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

test('session-level workspace and background events count as activity', () => {
  assert.equal(hasSessionActivity([{ type: RunEventType.ASSISTANT }]), true);
  assert.equal(hasSessionActivity([{ type: RunEventType.BACKGROUND_TASK }]), true);
});

test('a prompt suggestion after a turn is not activity of its own', () => {
  assert.equal(
    hasSessionActivity([{ type: RunEventType.PROMPT_SUGGESTION, turnId: 'turn-1', payload: { text: 'run the tests' } }]),
    false,
  );
  assert.equal(
    hasSessionActivity([
      { type: RunEventType.PROMPT_SUGGESTION, turnId: 'turn-1' },
      { type: RunEventType.ASSISTANT, turnId: 'turn-2' },
    ]),
    true,
  );
});

test('an empty batch has no session activity', () => {
  assert.equal(hasSessionActivity([]), false);
});
