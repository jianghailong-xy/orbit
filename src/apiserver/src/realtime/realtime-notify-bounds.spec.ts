import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { RunEventType, RunStatus, SessionEndReason, SessionLifecycleState, type NormalizedRunEvent } from '@orbit/shared';

import { TASK_CHANGED_MAX_ROWS } from '../tasks/tasks.service';
import { approvalRequestEvent, RealtimeService } from './realtime.service';

/**
 * What RealtimeService.publish announces to the other replicas of the events run_event never holds: seq 0, and a
 * settlement's STATUS at Number.MAX_SAFE_INTEGER. None of them can be read back by its seq, so each has to ride its
 * notification whole (`e`), and does, at its largest; the size of each is reported. The one with no bound, the approval
 * card, whose tool input is whatever the asker sent, is announced by its approval's id instead and built again from its
 * row (approval-relay.pg.spec.ts, realtime-read-back.spec.ts). A tool_output snapshot is seq 0 too, and is held to it by
 * tool-output-notify.spec.ts.
 */

const SESSION = randomUUID();
const OWNER = randomUUID();
const id = (): string => randomUUID();

function replica() {
  const notices: string[] = [];
  const prisma = {
    $executeRawUnsafe: async (_sql: string, _channel: string, payload: string) => {
      notices.push(payload);
      return 0;
    },
    session: { findUnique: async () => null }, // the badge sync's owner lookup, for the events that lower a badge
  };
  return { realtime: new RealtimeService(prisma as never, {} as never), notices };
}

test('every event run_event never holds but the approval card rides its notification whole, at its largest', (t) => {
  const { realtime, notices } = replica();
  const ts = (): string => new Date().toISOString();
  const lifecycle: Array<() => void> = [];
  for (const status of Object.values(RunStatus)) {
    for (const endReason of [...Object.values(SessionEndReason), null]) {
      for (const state of Object.values(SessionLifecycleState)) {
        lifecycle.push(() => realtime.publishSessionLifecycleChanged(SESSION, status, endReason, state));
      }
    }
  }
  const userScoped = [
    RunEventType.TASK_LIST_CHANGED, RunEventType.TAG_CHANGED, RunEventType.FOLDER_CHANGED, RunEventType.PROVIDER_CHANGED,
    RunEventType.PROJECT_CRITERIA_DECISIONS_CHANGED, RunEventType.PROJECT_CHANGED, RunEventType.WATCH_CHANGED,
    RunEventType.WIKI_CHANGED,
  ];
  const publishers: Array<[string, Array<() => void>]> = [
    ['session_created', [() => realtime.publishSessionCreated(SESSION)]],
    ['session_updated', [() => realtime.publishSessionUpdated(SESSION)]],
    ['queued_turns_changed', [() => realtime.publishQueuedTurnsChanged(SESSION)]],
    ['session_ended, every status, end reason and lifecycle', lifecycle],
    ['task_changed of a session', [() => realtime.publishTaskChanged(SESSION, id())]],
    [`task_changed of an owner, ${TASK_CHANGED_MAX_ROWS} rows`, [() => realtime.publishForUser(OWNER, RunEventType.TASK_CHANGED, {
      taskIds: Array.from({ length: TASK_CHANGED_MAX_ROWS }, id), resync: false,
    })]],
    ['agent_changed', [() => realtime.publishWorkspaceChanged(SESSION, id(), true)]],
    ['an owner\'s library event', userScoped.map((type) => () => realtime.publishForUser(OWNER, type, id()))],
    ['everyone\'s provider_changed', [() => realtime.publishForAllUsers(RunEventType.PROVIDER_CHANGED, id())]],
    // SessionsService.decideApproval's, and a card collected as ABANDONED (RunnerApiController).
    ['approval_resolved', [
      () => realtime.publish(SESSION, { seq: 0, type: RunEventType.APPROVAL_RESOLVED, payload: { id: id(), behavior: 'allow' }, ts: ts() }),
      () => realtime.publish(SESSION, { seq: 0, type: RunEventType.APPROVAL_RESOLVED, payload: { id: id(), status: 'ABANDONED' }, ts: ts() }),
    ]],
    // A settlement's, at its largest: the reaper's, whose reasons are fixed phrases of at most about 40 characters
    // (reaper.service.ts forceFinalize), here 200 of them, and a retry armed.
    ['a settlement\'s status', Object.values(RunStatus).map((status) => () => realtime.publish(SESSION, {
      seq: Number.MAX_SAFE_INTEGER, type: RunEventType.STATUS, ts: ts(),
      payload: { status, final: true, reason: 'r'.repeat(200), retryAt: ts() },
    }))],
  ];

  const sizes: string[] = [];
  for (const [what, sends] of publishers) {
    let largest = 0;
    for (const send of sends) {
      const before = notices.length;
      send();
      assert.equal(notices.length, before + 1, `${what}: one notification`);
      const notice = JSON.parse(notices[before]) as { e?: NormalizedRunEvent };
      assert.ok(notice.e, `${what} rides its notification whole: ${notices[before].slice(0, 300)}`);
      largest = Math.max(largest, Buffer.byteLength(notices[before], 'utf8'));
    }
    sizes.push(`${what}: at most ${largest} bytes`);
  }
  t.diagnostic(sizes.join('\n'));

  // The card, past the limit with its input, is announced by its approval and the moment it was published.
  const approvalId = id();
  const at = ts();
  realtime.publish(SESSION, approvalRequestEvent({
    id: approvalId, toolName: 'Bash', input: { command: 'x'.repeat(20_000) }, toolUseId: 'toolu_01', backgroundJobId: 'bgj_01',
  }, at));
  assert.deepEqual(JSON.parse(notices.at(-1)!), { i: realtime.instance, r: SESSION, a: approvalId, ts: at });
});
