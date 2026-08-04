import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunEventType } from '@orbit/shared';
import { engineTurnActiveAfter } from './engine-turn';

test('a turn ending leaves the engine idle', () => {
  assert.equal(
    engineTurnActiveAfter([
      { seq: 1, type: RunEventType.ASSISTANT },
      { seq: 2, type: RunEventType.TURN_END },
    ]),
    false,
  );
});

/**
 * The case the flag exists for: a background task reports in and the runtime restarts the model
 * without the control plane dispatching anything, so `status` is still AWAITING_INPUT while this
 * batch streams.
 */
test('a wake-up turn after a parked turn reads as generating', () => {
  assert.equal(
    engineTurnActiveAfter([
      { seq: 1, type: RunEventType.TURN_END },
      { seq: 2, type: RunEventType.SYSTEM, payload: { subtype: 'init' } },
      { seq: 3, type: RunEventType.BACKGROUND_TASK, payload: { status: 'completed' } },
      { seq: 4, type: RunEventType.TOOL_USE, payload: { name: 'Bash' } },
    ]),
    true,
  );
});

/** Batch order is not guaranteed, so the answer follows the highest seq, not arrival. */
test('the highest-seq signal decides', () => {
  assert.equal(
    engineTurnActiveAfter([
      { seq: 9, type: RunEventType.TURN_END },
      { seq: 4, type: RunEventType.TOOL_USE },
    ]),
    false,
  );
});

/** A runner killed mid-turn emits no turn end; its replacement's handshake is what clears. */
test('a runtime handshake clears a turn left hanging', () => {
  assert.equal(
    engineTurnActiveAfter([{ seq: 7, type: RunEventType.SYSTEM, payload: { subtype: 'resumed' } }]),
    false,
  );
});

/** Neither a handshake-less system event nor a background notification proves the engine woke. */
test('undecided batches leave the stored value alone', () => {
  assert.equal(engineTurnActiveAfter([]), undefined);
  assert.equal(
    engineTurnActiveAfter([
      { seq: 1, type: RunEventType.SYSTEM, payload: { subtype: 'status' } },
      { seq: 2, type: RunEventType.BACKGROUND_TASK, payload: { status: 'completed' } },
    ]),
    undefined,
  );
});
