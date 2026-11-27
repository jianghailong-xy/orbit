import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveSessionRunState, SessionRunState } from '@orbit/shared';

import { combinations } from '../sessions/session-state-legacy-fields.fixture';
import { leafHolds, type WatchTargetFact } from './watch-predicate';
import { turnStateOfWord } from '../sessions/session-turn-state';

/**
 * Plan step 4.8: the SESSION_RUN_TERMINAL leaf reads "the run is over" from the release column (and an interrupted
 * session with an end recorded), never from which terminal value the session holds. A stored watch keeps its meaning:
 * for every stored combination of status, end reason and filing facts, with `finished_at` as session_release_fact_chk
 * holds it, the leaf answers what the base commit's rule answered, "the derived run state is SUCCEEDED, FAILED or
 * ENDED".
 */

const BASE_RULE: readonly SessionRunState[] = [SessionRunState.SUCCEEDED, SessionRunState.FAILED, SessionRunState.ENDED];

function fact(row: ReturnType<typeof combinations>[number]['row']): WatchTargetFact {
  const at = (value: string | null) => (value === null ? null : new Date(value));
  return {
    kind: 'SESSION',
    sessionKind: 'CONVERSATION',
    status: row.status,
    turnState: turnStateOfWord(row.status),
    finishedAt: at(row.finishedAt),
    endReason: row.endReason,
    completedAt: at(row.completedAt),
    archivedAt: at(row.archivedAt),
    deletedAt: at(row.deletedAt),
    pendingApproval: false,
    jobs: [],
    engineTurnActive: false,
    runningSubagents: [],
    retryAt: null,
    hasResumeWatch: false,
    hasPendingWakeup: false,
  };
}

test('SESSION_RUN_TERMINAL answers as the base commit did for every stored combination', () => {
  const differences: string[] = [];
  let over = 0;
  for (const { key, row } of combinations()) {
    const before = BASE_RULE.includes(deriveSessionRunState(row));
    const now = leafHolds({ leaf: 'SESSION_RUN_TERMINAL' }, fact(row), Date.now());
    if (now) over += 1;
    if (now !== before) differences.push(`${key}: base ${before}, now ${now}`);
  }
  assert.deepEqual(differences, [], `\n${differences.join('\n')}\n`);
  // The three released statuses (150 rows) and INTERRUPTED with an end recorded (8 reasons x 5 filing facts).
  assert.equal(over, 150 + 40);
});
