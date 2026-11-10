import type { IntegrationJobKind, IntegrationTimelineEntry } from '@orbit/shared';
import { landingCheckLabel } from './landingSession';

/**
 * A landing's timeline, read as the session chat reads a turn (owner 2026-11-11,
 * docs/mocks/landings-chat-tools): the server's lines of one attempt gathered into a few steps — the
 * queue, the claim, the sync onto the line, each check, and the push (or the merge into main) — each
 * drawn as one of the chat's tool rows. Every line stays the server's own sentence; a step only
 * groups them, and its summary is one of its own lines.
 */
export const LANDING_STEP_COPY = {
  QUEUE: 'Queue',
  CLAIM: 'Claim',
  SYNC: 'Sync',
  PUSH: 'Push',
  MERGE: 'Merge',
  RESULT: 'Result',
} as const;

export type LandingStepKey = 'queue' | 'claim' | 'sync' | 'check:TASK_ACCEPTANCE' | 'check:MERGE_CHECK' | 'push';

export interface LandingStep {
  key: LandingStepKey;
  /** `Queue`, `Claim`, `Sync`, `Merge check`, `Task acceptance`, `Push`, `Merge`, `Result`. */
  name: string;
  /** The step's lines, in the timeline's order, with their index in the section. */
  entries: Array<{ entry: IntegrationTimelineEntry; index: number }>;
  /** The line the folded row says: the step's verdict when it has one, else its first or last line. */
  summary: IntegrationTimelineEntry;
  /** When the step last moved: its newest line. */
  at: string;
}

const ORDER: readonly LandingStepKey[] = ['queue', 'claim', 'sync', 'check:TASK_ACCEPTANCE', 'check:MERGE_CHECK', 'push'];

/** The kinds a step's folded row prefers to say: how it ended. */
const VERDICTS = new Set<string>([
  'CHECK_FINISHED', 'SKIPPED_CHECK', 'RESULT', 'RESULT_FALLBACK', 'PUSH_REFUSED',
  'CANCELLED', 'TIMED_OUT', 'ABANDONED', 'STOP_REQUESTED', 'HANDED_TO',
]);

/** Results that mean the push (or the merge into main) happened, or that nothing needed one. */
const PUSHED_STATES = new Set<string>(['LANDED', 'ALREADY_LANDED', 'NOTHING_TO_LAND', 'READY', 'OBSERVED']);

function checkKey(entry: IntegrationTimelineEntry): LandingStepKey {
  return entry.check?.name === 'TASK_ACCEPTANCE' ? 'check:TASK_ACCEPTANCE' : 'check:MERGE_CHECK';
}

/** Which step a line belongs to; `current` is the step the attempt was last in. */
function stepOf(entry: IntegrationTimelineEntry, current: LandingStepKey | null): LandingStepKey {
  switch (entry.kind) {
    case 'ENQUEUED':
    case 'REQUEUED':
    case 'NEXT_GENERATION':
    case 'FIX_TASK':
    case 'RETRY':
    case 'AUTOMATIC_ATTEMPT':
    case 'CONFIRMATION':
    case 'HANDLING':
      return current ?? 'queue';
    case 'CLAIMED':
    case 'TAKEN_OVER':
    case 'RELEASED':
      return 'claim';
    case 'ROUND':
    case 'RECHECK_ON_MOVED_MAIN':
      return 'sync';
    case 'CHECK_STARTED':
    case 'CHECK_FINISHED':
      return checkKey(entry);
    case 'SKIPPED_CHECK':
      return 'check:MERGE_CHECK';
    case 'PUSH_REFUSED':
      return 'push';
    case 'RESULT':
    case 'RESULT_FALLBACK':
      // A result that landed or merged belongs to the push; one that stopped (a failed check, a
      // conflict, an error) to the step it stopped in, so no Push row says it failed to push.
      return PUSHED_STATES.has(String(entry.data?.state)) ? 'push' : current ?? 'push';
    case 'STEP':
      switch (entry.phase) {
        case 'FETCH':
        case 'MAIN_SYNC':
        case 'REBASE':
        case 'MERGE':
          return 'sync';
        case 'CHECK':
          return current?.startsWith('check:') ? current : 'check:MERGE_CHECK';
        case 'VERIFY':
        case 'PUSH':
        case 'OBSERVE':
          return 'push';
        default:
          return current ?? 'claim';
      }
    default:
      // A stop, a cancel, a timeout, a hand-off: where the attempt was when it happened.
      return current ?? 'queue';
  }
}

function stepName(key: LandingStepKey, kind: IntegrationJobKind): string {
  switch (key) {
    case 'queue': return LANDING_STEP_COPY.QUEUE;
    case 'claim': return LANDING_STEP_COPY.CLAIM;
    case 'sync': return LANDING_STEP_COPY.SYNC;
    case 'check:TASK_ACCEPTANCE': return landingCheckLabel('TASK_ACCEPTANCE');
    case 'check:MERGE_CHECK': return landingCheckLabel('MERGE_CHECK');
    case 'push':
      return kind === 'LAND_TASK' ? LANDING_STEP_COPY.PUSH
        : kind === 'LAND_PROMOTION' ? LANDING_STEP_COPY.MERGE : LANDING_STEP_COPY.RESULT;
  }
}

/** One attempt's lines as its steps, in the order a landing goes through them. */
export function landingSteps(entries: readonly IntegrationTimelineEntry[], kind: IntegrationJobKind): LandingStep[] {
  const groups = new Map<LandingStepKey, LandingStep['entries']>();
  let current: LandingStepKey | null = null;
  entries.forEach((entry, index) => {
    const key = stepOf(entry, current);
    current = key;
    const group = groups.get(key) ?? [];
    group.push({ entry, index });
    groups.set(key, group);
  });
  return ORDER.filter((key) => groups.has(key)).map((key) => {
    const group = groups.get(key)!;
    const lines = group.map((item) => item.entry);
    const verdict = [...lines].reverse().find((line) => VERDICTS.has(line.kind));
    const summary = verdict ?? (key === 'queue' || key === 'claim' ? lines[0] : lines[lines.length - 1]);
    return { key, name: stepName(key, kind), entries: group, summary, at: lines[lines.length - 1].at };
  });
}
