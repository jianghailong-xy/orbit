/**
 * The rows the projector of the legacy status words is pinned over (session-legacy-words.spec.ts and .pg.spec.ts):
 * every release shape of common/session-release-shapes.fixture.ts as migration 1441 left the stored row, the held
 * words, and the shapes the projector's own rules turn on. Each carries the facts a database row of that shape has.
 */
import type { RunStatus as RunStatusEnum } from '@orbit/shared';

import { backfilled, RELEASE_SHAPES, releaseShape, type ReleaseShape } from '../common/session-release-shapes.fixture';
import type { LandingSettlement, LegacyStatusFacts } from './session-legacy-words';

type RunStatus = `${RunStatusEnum}`;

export interface WordShape {
  name: string;
  /** The word the writer stored. */
  stored: RunStatus;
  facts: LegacyStatusFacts;
  landing: LandingSettlement | null;
}

const AT = new Date('2026-11-21T00:00:00.000Z');

const TURN_STATE_OF_WORD: Partial<Record<RunStatus, string>> = {
  PENDING: 'QUEUED', RUNNING: 'IN_FLIGHT', INTERRUPTED: 'ABANDONED',
};

/** What a LANDING container's `project_landing` row says, by shape name. */
const SETTLED_AS: Record<string, string> = { N5: 'LANDED', 'N5 not landed': 'CANCELLED', B7: 'LANDED' };

function wordShape(shape: ReleaseShape, name: string = shape.name, over: Partial<LegacyStatusFacts> = {}): WordShape {
  return {
    name,
    stored: shape.status,
    facts: {
      finishedAt: shape.released ? AT : null,
      turnState: shape.released ? null : TURN_STATE_OF_WORD[shape.status] ?? null,
      endReason: shape.endReason,
      lastTurnOutcome: shape.lastTurnOutcome,
      // A session ended while still queued had never started (N1 queued).
      startedAt: shape.name === 'N1 queued' ? null : AT,
      // A failed import keeps its pending marker (W5).
      importSourceCwd: shape.name === 'W5' ? '/home/someone/project' : null,
      sessionKind: shape.sessionKind,
      ...over,
    },
    landing: shape.sessionKind === 'LANDING' && SETTLED_AS[shape.name]
      ? { settledAt: AT, settledAs: SETTLED_AS[shape.name] }
      : null,
  };
}

const held = (status: RunStatus, over: Partial<LegacyStatusFacts> = {}, name = `held ${status}`): WordShape =>
  wordShape({
    name, what: name, writer: 'this fixture', status, released: false, endReason: null, lastTurnOutcome: null,
    sessionKind: 'CONVERSATION', carriesTurnOutcome: true,
  }, name, over);

/**
 * The facts of a session that ran and stands at `status`, for specs that build a row by its word: the turn state of a
 * held word, the release of a released one, `FAILED` on a failed turn, and a task that ended DONE for SUCCEEDED.
 */
export function factsOfWord(status: RunStatus | string, over: Partial<LegacyStatusFacts> = {}): LegacyStatusFacts {
  const released = status === 'SUCCEEDED' || status === 'FAILED' || status === 'CANCELLED';
  return {
    finishedAt: released ? AT : null,
    turnState: TURN_STATE_OF_WORD[status as RunStatus] ?? null,
    endReason: status === 'SUCCEEDED' ? 'task_done' : null,
    lastTurnOutcome: status === 'FAILED' ? 'FAILED' : null,
    startedAt: AT,
    importSourceCwd: null,
    sessionKind: 'CONVERSATION',
    ...over,
  };
}

export const WORD_SHAPES: readonly WordShape[] = [
  ...RELEASE_SHAPES.map((shape) => wordShape(backfilled(shape))),
  // W7 no reason as its writer would leave it today: 1441 wrote FAILED on every stored one, and none is written now.
  wordShape(releaseShape('W7 no reason'), 'W7 no reason, as written'),
  // A session that had started, ended while queued with reason task_done: stored CANCELLED (transitionEnd).
  wordShape(releaseShape('N1 queued'), 'ended queued after a start, task_done', { endReason: 'task_done', startedAt: AT }),
  // The same ended before it ever started, which keeps its word.
  wordShape(releaseShape('N1 queued'), 'ended before it started, task_done', { endReason: 'task_done' }),
  held('PENDING'),
  held('RUNNING'),
  held('AWAITING_INPUT'),
  held('INTERRUPTED', { lastTurnOutcome: 'INTERRUPTED' }),
  held('PENDING', { importSourceCwd: '/home/someone/project' }, 'a transcript import waiting'),
];
