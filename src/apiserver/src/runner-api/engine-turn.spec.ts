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

/**
 * The reducer does double duty: `undefined` is also how the ingest decides whether the engine has
 * spoken at all for this run, which is what stamps Session.engineStartedAt.
 *
 * The distinction that matters is the runner's own opening `user` event. It is durable, it is
 * seq 1, and on this deployment it lands roughly two seconds before the runtime is up — so a
 * cruder "any durable event" rule would end the starting state while the CLI was still booting,
 * which is the whole gap the state exists to show.
 */
test('the runner echoing the prompt is not the engine speaking', () => {
  assert.equal(
    engineTurnActiveAfter([
      { seq: 1, type: RunEventType.USER, payload: { text: 'ship it' } },
    ]),
    undefined,
  );
});

test('a spawn handshake is the engine speaking, even though it decides "idle"', () => {
  // Both a cold spawn (init) and a resume (resumed) count: each is the runtime announcing
  // itself, and neither leaves the engine mid-turn — so the value is false, not undefined.
  for (const subtype of ['init', 'resumed']) {
    assert.equal(
      engineTurnActiveAfter([
        { seq: 1, type: RunEventType.USER, payload: { text: 'ship it' } },
        { seq: 2, type: RunEventType.SYSTEM, payload: { subtype } },
      ]),
      false,
    );
  }
});

test('a reused warm process is the engine speaking without any handshake', () => {
  // A claim that lands on a resident engine never re-emits init; its first generation event is
  // the only signal that it has the turn, and it must end the starting state just the same.
  assert.equal(
    engineTurnActiveAfter([
      { seq: 1, type: RunEventType.USER, payload: { text: 'again' } },
      { seq: 2, type: RunEventType.TOOL_USE, payload: { name: 'Read' } },
    ]),
    true,
  );
});

/**
 * The runner runs a `!cmd` and an EXECUTABLE acceptance itself, bypassing claude, but emits the
 * engine's own Bash tool shape so the transcript renders them identically (runner-go shell.go,
 * executable_acceptance.go). Counting those as generating latched the flag on: a shell turn ends
 * via /turn-complete and never emits a `turn_end` event, so nothing was left to clear it and the
 * session drew a working spinner while parked and idle — for 90 minutes, in the case that found
 * this. The `shell-` id the runner tags them with is the same marker the Web already reads.
 */
test('a shell command the runner ran itself is not the engine generating', () => {
  // The batch that latched it: a turn ending, then the acceptance command's tool_use.
  assert.equal(
    engineTurnActiveAfter([
      { seq: 1908, type: RunEventType.TURN_END },
      {
        seq: 1909,
        type: RunEventType.TOOL_USE,
        payload: { id: 'shell-01a05756-f00e-713b-afdc-b4c607336a5a', name: 'Bash' },
      },
    ]),
    false,
  );
  // Its result lands in a later batch — 31 minutes later here — and must not re-arm the flag.
  assert.equal(
    engineTurnActiveAfter([
      {
        seq: 3820,
        type: RunEventType.TOOL_RESULT,
        payload: { toolUseId: 'shell-01a05756-f00e-713b-afdc-b4c607336a5a' },
      },
    ]),
    undefined,
  );
});

/** Only the runner's own `shell-` tag is exempt; the engine's Bash tool still decides. */
test('the engine calling Bash still reads as generating', () => {
  assert.equal(
    engineTurnActiveAfter([
      { seq: 1, type: RunEventType.TURN_END },
      { seq: 2, type: RunEventType.TOOL_USE, payload: { id: 'toolu_01abc', name: 'Bash' } },
    ]),
    true,
  );
  // A tool event with no id at all is the engine's until something says otherwise.
  assert.equal(
    engineTurnActiveAfter([{ seq: 2, type: RunEventType.TOOL_USE, payload: { name: 'Bash' } }]),
    true,
  );
});
