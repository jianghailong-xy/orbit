import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  deriveSessionLifecycleState,
  deriveSessionRunState,
  SessionLifecycleState,
  SessionRunState,
} from '@orbit/shared';
import { RunStatus } from '@prisma/client';

import { FAILURE_RELEASE_CAUSES, isHeld, SESSION_RELEASE_CAUSES } from '../common/session-release';
import { OPEN_SESSION_STATUSES } from '../common/session-scheduling';
import { conversationIsDown, sessionHasEnded as projectSessionHasEnded } from '../projects/project-open-item';
import { RETRY_CLAIM_WINDOW_MS } from '../sessions/session-request';
import { observerRefusal } from '../watches/watch-delivery.service';
import { sessionHasEnded } from './background-job-wake';
import { tickStanding } from './scheduled-wakeup';

/**
 * Plan step 4.7, decision D4 (keep today's rule): the wake rules and the credential gates read the release fact
 * (`finished_at`) and its cause (`release_cause`) and answer EXACTLY what they answered from the status value.
 *
 * The OLD_* functions below are the gates as they stood before this step, copied from the code, and read the
 * status the way it did. Every combination of (status, end reason, cancel requested, filing, retry armed, and
 * every release cause a writer can pair with the status) is run through both, and the verdicts must be equal.
 * Rows are the ones the writers and backfills produce (session_release_fact_chk, session_release_failure_chk):
 * released exactly when the status is terminal, a failure cause exactly when the status is FAILED.
 *
 * Set ORBIT_WAKE_GATES_TABLE to a file path to write the table (before and after, per gate) as markdown.
 */

const NOW = new Date('2026-11-21T12:00:00.000Z');
const STATUSES = ['PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED', 'SUCCEEDED', 'FAILED', 'CANCELLED'] as const;
const END_REASONS = [null, 'ended', 'task_done', 'task_cancelled', 'completed', 'cancelled', 'idle'] as const;
const FILINGS = ['open', 'completed', 'archived', 'trash'] as const;
const RETRIES = ['none', 'armed', 'claimed', 'claim lapsed'] as const;
const FAILED_CAUSES: readonly string[] = FAILURE_RELEASE_CAUSES;
const OTHER_CAUSES = SESSION_RELEASE_CAUSES.filter((cause) => !FAILED_CAUSES.includes(cause));

interface Row {
  status: RunStatus;
  finishedAt: Date | null;
  releaseCause: string | null;
  endReason: string | null;
  completedAt: Date | null;
  archivedAt: Date | null;
  deletedAt: Date | null;
  cancelRequestedAt: Date | null;
  retryAt: Date | null;
  retryClaimedAt: Date | null;
  ownerId: string;
}

function causesOf(status: string): readonly (string | null)[] {
  if (status === 'FAILED') return FAILED_CAUSES;
  if (status === 'SUCCEEDED' || status === 'CANCELLED') return OTHER_CAUSES;
  return [null];
}

function rowOf(status: string, releaseCause: string | null, endReason: string | null, cancelled: boolean, filing: string, retry: string): Row {
  return {
    status: status as RunStatus,
    finishedAt: releaseCause === null ? null : new Date(NOW.getTime() - 60_000),
    releaseCause,
    endReason,
    completedAt: filing === 'completed' ? NOW : null,
    archivedAt: filing === 'archived' ? NOW : null,
    deletedAt: filing === 'trash' ? NOW : null,
    cancelRequestedAt: cancelled ? NOW : null,
    retryAt: retry === 'armed' ? NOW : null,
    retryClaimedAt: retry === 'claimed' ? new Date(NOW.getTime() - 1000)
      : retry === 'claim lapsed' ? new Date(NOW.getTime() - RETRY_CLAIM_WINDOW_MS - 1000) : null,
    ownerId: 'owner',
  };
}

// ---- The gates as they stood before step 4.7 (read the status) ----

function oldSessionHasEnded(session: Row): boolean {
  if (deriveSessionLifecycleState(session) !== SessionLifecycleState.OPEN) return true;
  const run = deriveSessionRunState(session);
  return run === SessionRunState.ENDED || run === SessionRunState.SUCCEEDED || run === SessionRunState.FAILED;
}

function oldProjectSessionHasEnded(session: Row): boolean {
  if (session.cancelRequestedAt) return true;
  return oldSessionHasEnded(session);
}

function oldTickStanding(session: Row, now: Date): string {
  if (deriveSessionLifecycleState(session) !== SessionLifecycleState.OPEN) return 'ENDED';
  const run = deriveSessionRunState(session);
  if (run === SessionRunState.SUCCEEDED || run === SessionRunState.ENDED) return 'ENDED';
  if (run === SessionRunState.FAILED) {
    const claimed = session.retryClaimedAt != null && now.getTime() - session.retryClaimedAt.getTime() < RETRY_CLAIM_WINDOW_MS;
    return session.retryAt != null || claimed ? 'FAILED_RECOVERING' : 'FAILED';
  }
  return session.cancelRequestedAt != null ? 'ENDED' : 'LIVE';
}

function oldObserverRefusal(session: Row): string | null {
  const lifecycle = deriveSessionLifecycleState(session);
  if (lifecycle === SessionLifecycleState.TRASH) return 'OBSERVER_SESSION_IN_TRASH';
  if (lifecycle === SessionLifecycleState.COMPLETED) return 'OBSERVER_SESSION_COMPLETED';
  const run = deriveSessionRunState(session);
  if (session.cancelRequestedAt || run === SessionRunState.SUCCEEDED || run === SessionRunState.FAILED || run === SessionRunState.ENDED) {
    return `OBSERVER_SESSION_ENDED (${run})`;
  }
  return null;
}

function oldConversationIsDown(session: Row): boolean {
  return deriveSessionRunState(session) === SessionRunState.FAILED
    && !session.endReason
    && deriveSessionLifecycleState(session) === SessionLifecycleState.OPEN;
}

/** The gateways' "open" test of a session row, before: the status in the open set. After: the release column unset. */
const oldGatewayOpen = (session: Row): boolean => OPEN_SESSION_STATUSES.includes(session.status);
const newGatewayOpen = (session: Row): boolean => isHeld(session);

function newObserverRefusal(session: Row): string | null {
  const refusal = observerRefusal(session);
  if (!refusal) return null;
  const code = (refusal as unknown as { code?: string }).code ?? refusal.message.split(':')[0];
  return code === 'OBSERVER_SESSION_ENDED' ? `OBSERVER_SESSION_ENDED (${deriveSessionRunState(session)})` : code;
}

const GATES: Array<{ name: string; before: (row: Row) => string; after: (row: Row) => string }> = [
  { name: 'sessionHasEnded (machine wakes, background-job-wake.ts)', before: (r) => String(oldSessionHasEnded(r)), after: (r) => String(sessionHasEnded(r)) },
  { name: 'sessionHasEnded (coordinator deliveries, project-open-item.ts)', before: (r) => String(oldProjectSessionHasEnded(r)), after: (r) => String(projectSessionHasEnded(r)) },
  { name: 'tickStanding (scheduled wake-up)', before: (r) => oldTickStanding(r, NOW), after: (r) => tickStanding(r, NOW) },
  { name: 'observerRefusal (watch delivery)', before: (r) => String(oldObserverRefusal(r)), after: (r) => String(newObserverRefusal(r)) },
  { name: 'conversationIsDown (coordinator paused)', before: (r) => String(oldConversationIsDown(r)), after: (r) => String(conversationIsDown(r)) },
  { name: 'engine credentials open (anthropic, pool and pool-login gateways)', before: (r) => String(oldGatewayOpen(r)), after: (r) => String(newGatewayOpen(r)) },
];

test('every gate answers from the release column what it answered from the status, for every row the writers produce', () => {
  const lines: string[] = [
    '| gate | status | end reason | cancel requested | filing | retry | before | after |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  let combinations = 0;
  for (const gate of GATES) {
    for (const status of STATUSES) {
      for (const endReason of END_REASONS) {
        for (const cancelled of [false, true]) {
          for (const filing of FILINGS) {
            for (const retry of RETRIES) {
              const verdicts = new Set<string>();
              let before = '';
              for (const cause of causesOf(status)) {
                const row = rowOf(status, cause, endReason, cancelled, filing, retry);
                before = gate.before(row);
                const after = gate.after(row);
                combinations += 1;
                assert.equal(after, before, `${gate.name}: ${status}/${cause}/end ${endReason}/cancel ${cancelled}/${filing}/retry ${retry}`);
                verdicts.add(after);
              }
              // Whatever the release cause, one verdict: the cause only separates a failure from the rest, and that is the status.
              assert.equal(verdicts.size, 1, `${gate.name}: ${status} ${endReason} ${filing} ${retry} differs by cause`);
              lines.push(`| ${gate.name} | ${status} | ${endReason ?? '-'} | ${cancelled} | ${filing} | ${retry} | ${before} | ${[...verdicts][0]} |`);
            }
          }
        }
      }
    }
  }
  assert.ok(combinations > 10_000);
  const out = process.env.ORBIT_WAKE_GATES_TABLE;
  if (out) {
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, `${lines.join('\n')}\n`);
  }
});
