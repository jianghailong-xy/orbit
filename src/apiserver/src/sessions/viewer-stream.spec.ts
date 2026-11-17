/**
 * viewerFrame (docs/session-viewer-stream-design.md §4), event type by event type, for the three audiences the viewer
 * streams serve: a guest, a link with Tool output and a link without. The pg specs hold the routes to their reads
 * (session-guests-projection.pg.spec.ts (5), public-surface.pg.spec.ts (h)); this one holds the table itself, including
 * that a live type nobody listed is shown to nobody.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunEventType } from '@orbit/shared';
import { isReplayableEvent, NON_REPLAYABLE_EVENT_TYPES, TOMBSTONE_EVENT_TYPE } from '../common/system-noise';
import { type ViewerAudience, viewerFrame } from './viewer-stream';

const GUEST: ViewerAudience = { kind: 'GUEST' };
const WITH: ViewerAudience = { kind: 'PUBLIC', toolOutput: true };
const WITHOUT: ViewerAudience = { kind: 'PUBLIC', toolOutput: false };
const shown = (audience: ViewerAudience, type: string, seq = 0, payload: unknown = { text: 'x' }) =>
  viewerFrame(audience, { seq, type, payload }) !== null;

test('live-only events: deltas, resync and ping always; tool output only with it; the rest never', () => {
  for (const type of [RunEventType.TEXT_DELTA, RunEventType.THINKING_DELTA, RunEventType.RESYNC, 'ping']) {
    assert.deepEqual([shown(GUEST, type), shown(WITH, type), shown(WITHOUT, type)], [true, true, true], type);
  }
  for (const type of [RunEventType.TOOL_OUTPUT, RunEventType.BACKGROUND_OUTPUT]) {
    assert.deepEqual([shown(GUEST, type), shown(WITH, type), shown(WITHOUT, type)], [true, true, false], type);
  }
  const never = [
    RunEventType.APPROVAL_REQUEST, RunEventType.APPROVAL_RESOLVED, RunEventType.QUEUED_TURNS_CHANGED,
    RunEventType.TRANSLATION, RunEventType.TASK_PROGRESS, TOMBSTONE_EVENT_TYPE, RunEventType.STATUS,
  ];
  for (const type of never) {
    for (const seq of [0, 7, Number.MAX_SAFE_INTEGER]) {
      assert.deepEqual([shown(GUEST, type, seq), shown(WITH, type, seq), shown(WITHOUT, type, seq)], [false, false, false], `${type} @${seq}`);
    }
  }
  // A live event no list names — a lifecycle signal, a type added later — is shown to nobody: live events ride seq 0
  // (or a settlement's sentinel), and only a stored seq reaches the durable predicate.
  for (const type of [RunEventType.SESSION_UPDATED, 'a_live_type_nobody_listed']) {
    for (const seq of [0, Number.MAX_SAFE_INTEGER]) {
      assert.deepEqual([shown(GUEST, type, seq), shown(WITH, type, seq), shown(WITHOUT, type, seq)], [false, false, false], `${type} @${seq}`);
    }
  }
});

test('durable events: stored, past the paged reads\' predicate, and without tool output where the link has none', () => {
  // Every type the reads would return, at a stored seq, reaches every audience — and nothing at seq 0.
  const durable = Object.values(RunEventType).filter(
    (type) => type !== RunEventType.STATUS && isReplayableEvent({ type, payload: { text: 'x' } }) && !type.endsWith('_changed')
      && ![RunEventType.SESSION_CREATED, RunEventType.SESSION_ENDED, RunEventType.SESSION_UPDATED].includes(type),
  );
  assert.ok(durable.includes(RunEventType.ASSISTANT) && durable.includes(RunEventType.TOOL_RESULT));
  for (const type of durable) {
    assert.deepEqual([shown(GUEST, type, 5), shown(WITH, type, 5), shown(WITHOUT, type, 5)], [true, true, true], type);
    assert.equal(shown(GUEST, type, 0), false, `${type} at seq 0`);
  }
  // A progress ping is no event of the reads, whatever its seq.
  assert.equal(shown(GUEST, RunEventType.SYSTEM, 5, { model: null, subtype: 'status', sessionId: 'rt' }), false);
  assert.equal(shown(GUEST, RunEventType.SYSTEM, 5, { subtype: 'init', sessionId: 'rt' }), true);

  const use = { seq: 5, type: RunEventType.TOOL_USE as string, payload: { id: 't', name: 'Bash', input: { command: 'ls' } }, truncated: true as const };
  assert.deepEqual(viewerFrame(GUEST, use), use);
  assert.deepEqual(viewerFrame(WITH, use), use);
  assert.deepEqual(viewerFrame(WITHOUT, use), { seq: 5, type: RunEventType.TOOL_USE, payload: { id: 't', name: 'Bash' } });
});

test('isReplayableEvent is replayableEventSql\'s list and noise test, in JS', () => {
  for (const type of NON_REPLAYABLE_EVENT_TYPES) assert.equal(isReplayableEvent({ type, payload: { text: 'x' } }), false, type);
  assert.equal(isReplayableEvent({ type: RunEventType.SYSTEM, payload: { model: null, subtype: 'thinking_tokens', sessionId: 's' } }), false);
  assert.equal(isReplayableEvent({ type: RunEventType.SYSTEM, payload: { message: 'No conversation found' } }), true);
  assert.equal(isReplayableEvent({ type: RunEventType.ASSISTANT, payload: { text: 'hi' } }), true);
});
