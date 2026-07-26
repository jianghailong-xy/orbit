import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunEventType } from '@orbit/shared';
import { isNoiseSystemEvent } from './system-noise';

test('drops the progress-ping system subtypes nothing renders', () => {
  for (const subtype of ['thinking_tokens', 'status', 'task_progress', 'task_started', 'api_retry']) {
    assert.equal(
      isNoiseSystemEvent({ type: RunEventType.SYSTEM, payload: { subtype, model: null, sessionId: 's' } }),
      true,
      subtype,
    );
  }
});

test('keeps init and resumed — runtimeInitSessionId and the bg-reset rule read them', () => {
  assert.equal(isNoiseSystemEvent({ type: RunEventType.SYSTEM, payload: { subtype: 'init' } }), false);
  assert.equal(isNoiseSystemEvent({ type: RunEventType.SYSTEM, payload: { subtype: 'resumed' } }), false);
});

test('a system event holding only the ping keys is noise, subtype or not', () => {
  assert.equal(isNoiseSystemEvent({ type: RunEventType.SYSTEM, payload: {} }), true);
  assert.equal(isNoiseSystemEvent({ type: RunEventType.SYSTEM, payload: { subtype: 7 } }), true);
  assert.equal(isNoiseSystemEvent({ type: RunEventType.SYSTEM }), true);
  assert.equal(
    isNoiseSystemEvent({ type: RunEventType.SYSTEM, payload: { model: null, sessionId: 's' } }),
    true,
  );
});

test('keeps a subtype-less system event that carries codex stderr', () => {
  // codex.go / codex_appserver.go stream the runtime's stderr as `system` events with no subtype
  // — the only record of "Session ID … is already in use" / "No conversation found with session
  // ID …". No client renders them; they still must survive to the transcript log.
  assert.equal(
    isNoiseSystemEvent({
      type: RunEventType.SYSTEM,
      payload: { stderr: 'Error: Session ID 7a536824 is already in use.\n' },
    }),
    false,
  );
  assert.equal(
    isNoiseSystemEvent({
      type: RunEventType.SYSTEM,
      payload: { model: null, subtype: 'status', sessionId: 's', stderr: 'boom' },
    }),
    false,
  );
});

test('keeps any future system event that carries a field of its own', () => {
  assert.equal(
    isNoiseSystemEvent({ type: RunEventType.SYSTEM, payload: { subtype: 'something_new', detail: 42 } }),
    false,
  );
});

test('never touches a non-system event', () => {
  for (const type of [
    RunEventType.ASSISTANT,
    RunEventType.THINKING,
    RunEventType.TOOL_USE,
    RunEventType.TOOL_RESULT,
    RunEventType.USER,
    RunEventType.TURN_END,
    RunEventType.BACKGROUND_TASK,
    RunEventType.ERROR,
  ]) {
    assert.equal(isNoiseSystemEvent({ type, payload: { subtype: 'thinking_tokens' } }), false, type);
  }
});
