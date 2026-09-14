/**
 * The Watch predicate grammar (docs/watch-contract.md §2, §12) and what each leaf means against the rows
 * it names.
 *
 * Pure: nothing here reads a database or a clock. `WatchEvaluatorService` reads the leaves'
 * `sourceColumns` inside its evaluating transaction and hands the rows in, together with that
 * transaction's `now()`; this only decides. The leaves call the derivations the rest of the server
 * already answers the same questions with — `UNSETTLED_SESSION_STATUSES`, `deriveSessionRunState`,
 * `deriveSessionLifecycleState` — so a watch cannot disagree with `session_create(wait)` or the session
 * list about whether a turn settled or a session ended.
 *
 * The progress leaves read `task_progress`: the numbers and the phase a reporter stated, and when the
 * position last changed. A report's message is not among the rows a leaf is handed, so no wording in it
 * can make a threshold hold or a stall end.
 */
import {
  deriveSessionLifecycleState,
  deriveSessionRunState,
  SessionLifecycleState,
  SessionRunState,
  TASK_PROGRESS_LIMITS,
  TaskStatus,
  WATCH_LIMITS,
  type WatchTargetObservation,
} from '@orbit/shared';

import { UNSETTLED_SESSION_STATUSES } from '../common/session-scheduling';

/** The newest grammar this build evaluates. */
export const WATCH_PREDICATE_VERSION = 2;
/** Every grammar this build evaluates. A watch stored under another version is left to a build that serves it. */
export const WATCH_PREDICATE_VERSIONS: readonly number[] = [1, 2];

export type WatchTargetKind = 'SESSION' | 'TASK';

/** Every leaf, and the one kind of target it can be asked about (contract `leaves[].targetKind`). */
export const WATCH_LEAF_TARGET_KIND = {
  SESSION_TURN_SETTLED: 'SESSION',
  SESSION_RUN_TERMINAL: 'SESSION',
  SESSION_LIFECYCLE_TERMINAL: 'SESSION',
  SESSION_NEEDS_ATTENTION: 'SESSION',
  TASK_TERMINAL: 'TASK',
  TASK_FAILED: 'TASK',
  TASK_DONE: 'TASK',
  TASK_PROGRESS_AT_LEAST: 'TASK',
  TASK_NO_PROGRESS_FOR: 'TASK',
} as const satisfies Record<string, WatchTargetKind>;

export type WatchLeaf = keyof typeof WATCH_LEAF_TARGET_KIND;

/** The grammar version each leaf first appears in (contract `leaves[].sinceVersion`). */
export const WATCH_LEAF_SINCE_VERSION: Readonly<Record<WatchLeaf, number>> = {
  SESSION_TURN_SETTLED: 1,
  SESSION_RUN_TERMINAL: 1,
  SESSION_LIFECYCLE_TERMINAL: 1,
  SESSION_NEEDS_ATTENTION: 1,
  TASK_TERMINAL: 1,
  TASK_FAILED: 1,
  TASK_DONE: 1,
  TASK_PROGRESS_AT_LEAST: 2,
  TASK_NO_PROGRESS_FOR: 2,
};

const PROGRESS_LEAVES: ReadonlySet<WatchLeaf> = new Set(['TASK_PROGRESS_AT_LEAST', 'TASK_NO_PROGRESS_FOR']);

export type WatchLeafParams = { current: number } | { percent: number } | { seconds: number };

/** One leaf as a term asks it: the leaf, and its parameters when it takes any. */
export interface WatchLeafTest {
  leaf: WatchLeaf;
  params?: WatchLeafParams;
}

export type WatchPredicate =
  | { kind: 'ALL' | 'ANY'; over: 'ALL_TARGETS'; leaf: WatchLeaf; params?: WatchLeafParams }
  | { kind: 'AT_LEAST'; count: number; over: 'ALL_TARGETS'; leaf: WatchLeaf; params?: WatchLeafParams }
  | { kind: 'ALL_OF' | 'ANY_OF'; operands: WatchPredicate[] };

/** A Task's reported position in its current lifecycle epoch. Nothing reported yet: every field null. */
export interface WatchTaskProgress {
  phase: string | null;
  current: number | null;
  total: number | null;
  lastProgressAt: Date | null;
}

/** One target's source columns, as the evaluating transaction read them. */
export type WatchTargetFact =
  | {
      kind: 'TASK';
      status: string;
      /** `task_progress.lifecycle_epoch`, 0 for a Task never reopened. */
      epoch: number;
      /** When that epoch began: the Task's creation for epoch 0. */
      epochStartedAt: Date;
      progress: WatchTaskProgress;
    }
  | {
      kind: 'SESSION';
      status: string;
      endReason: string | null;
      completedAt: Date | null;
      archivedAt: Date | null;
      deletedAt: Date | null;
      /** An `approval` row for the session is PENDING. */
      pendingApproval: boolean;
    };

const TERMINAL_TASK_STATUSES: readonly string[] = [TaskStatus.DONE, TaskStatus.CANCELLED, TaskStatus.FAILED];
const TERMINAL_RUN_STATES: readonly SessionRunState[] = [
  SessionRunState.SUCCEEDED,
  SessionRunState.FAILED,
  SessionRunState.ENDED,
];
const TERMINAL_LIFECYCLE_STATES: readonly SessionLifecycleState[] = [
  SessionLifecycleState.COMPLETED,
  SessionLifecycleState.TRASH,
];

/**
 * The stored predicate as a term of the grammar `version` names, or null when it is not one. Creation
 * refuses such a predicate; this is the evaluator declining to guess at one that got past it anyway.
 */
export function parseWatchPredicate(value: unknown, version: number): WatchPredicate | null {
  return WATCH_PREDICATE_VERSIONS.includes(version) ? parseTerm(value, version) : null;
}

function parseTerm(value: unknown, version: number): WatchPredicate | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const term = value as Record<string, unknown>;
  const quorum = term.kind === 'AT_LEAST' && version >= 2;
  if (term.kind === 'ALL' || term.kind === 'ANY' || quorum) {
    if (term.over !== 'ALL_TARGETS' || typeof term.leaf !== 'string') return null;
    if (!Object.hasOwn(WATCH_LEAF_TARGET_KIND, term.leaf)) return null;
    const leaf = term.leaf as WatchLeaf;
    if (WATCH_LEAF_SINCE_VERSION[leaf] > version || leafParamsProblem(leaf, term.params) !== null) return null;
    const params = term.params === undefined ? {} : { params: term.params as WatchLeafParams };
    if (!quorum) return { kind: term.kind as 'ALL' | 'ANY', over: 'ALL_TARGETS', leaf, ...params };
    return Number.isInteger(term.count) && (term.count as number) >= 1
      ? { kind: 'AT_LEAST', count: term.count as number, over: 'ALL_TARGETS', leaf, ...params }
      : null;
  }
  if (term.kind === 'ALL_OF' || term.kind === 'ANY_OF') {
    if (!Array.isArray(term.operands) || term.operands.length === 0) return null;
    const operands = term.operands.map((operand) => parseTerm(operand, version));
    return operands.every((operand): operand is WatchPredicate => operand !== null)
      ? { kind: term.kind, operands }
      : null;
  }
  return null;
}

/**
 * Why `raw` is not the `params` this leaf takes, or null when it is. The one reading of a leaf's
 * parameters: the API refuses a request with this sentence, and the evaluator declines a stored term
 * that fails it.
 */
export function leafParamsProblem(leaf: WatchLeaf, raw: unknown): string | null {
  const entry = soleEntry(raw);
  switch (leaf) {
    case 'TASK_PROGRESS_AT_LEAST':
      if (entry?.[0] === 'current' && isCount(entry[1], 1, TASK_PROGRESS_LIMITS.maxCount)) return null;
      if (entry?.[0] === 'percent' && isCount(entry[1], 1, 100)) return null;
      return 'TASK_PROGRESS_AT_LEAST takes `params` with exactly one of `current`, an integer from 1, '
        + 'or `percent`, an integer from 1 to 100';
    case 'TASK_NO_PROGRESS_FOR':
      if (entry?.[0] === 'seconds' && isCount(entry[1], WATCH_LIMITS.minNoProgressSeconds, WATCH_LIMITS.maxTtlSeconds)) {
        return null;
      }
      return `TASK_NO_PROGRESS_FOR takes \`params\` with exactly \`seconds\`, an integer from ${
        WATCH_LIMITS.minNoProgressSeconds} to ${WATCH_LIMITS.maxTtlSeconds}`;
    default:
      return raw === undefined ? null : `${leaf} takes no \`params\``;
  }
}

function soleEntry(raw: unknown): [string, unknown] | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const entries = Object.entries(raw);
  return entries.length === 1 ? entries[0] : null;
}

function isCount(value: unknown, min: number, max: number): boolean {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
}

/** Whether one leaf, as a term asks it, holds for one target at `now`. A leaf asked about the wrong kind of target does not hold. */
export function leafHolds(test: WatchLeafTest, fact: WatchTargetFact, now: number): boolean {
  switch (test.leaf) {
    case 'TASK_TERMINAL':
      return fact.kind === 'TASK' && TERMINAL_TASK_STATUSES.includes(fact.status);
    case 'TASK_FAILED':
      return fact.kind === 'TASK' && fact.status === TaskStatus.FAILED;
    case 'TASK_DONE':
      return fact.kind === 'TASK' && fact.status === TaskStatus.DONE;
    case 'TASK_PROGRESS_AT_LEAST':
      return fact.kind === 'TASK' && progressReached(fact.progress, test.params);
    case 'TASK_NO_PROGRESS_FOR': {
      const deadline = stallDeadline(test, fact);
      return deadline !== null && deadline <= now;
    }
    case 'SESSION_TURN_SETTLED':
      return fact.kind === 'SESSION' && !(UNSETTLED_SESSION_STATUSES as readonly string[]).includes(fact.status);
    case 'SESSION_RUN_TERMINAL':
      return fact.kind === 'SESSION' && TERMINAL_RUN_STATES.includes(deriveSessionRunState(fact));
    case 'SESSION_LIFECYCLE_TERMINAL':
      return fact.kind === 'SESSION' && TERMINAL_LIFECYCLE_STATES.includes(deriveSessionLifecycleState(fact));
    case 'SESSION_NEEDS_ATTENTION':
      return fact.kind === 'SESSION' && fact.pendingApproval;
  }
}

/** A threshold is reached by the reported count, never by a count nobody reported and never by a total alone. */
function progressReached(progress: WatchTaskProgress, params: WatchLeafParams | undefined): boolean {
  if (params === undefined || progress.current === null) return false;
  if ('current' in params) return progress.current >= params.current;
  if ('percent' in params) return progress.total !== null && progress.current * 100 >= params.percent * progress.total;
  return false;
}

/**
 * When a `TASK_NO_PROGRESS_FOR` leaf starts to hold for this target if nothing changes before then: its
 * window after the Task's reported position last changed in the current epoch, or after the epoch began
 * when nothing has been reported in it. Null when waiting can never make it hold — the test is another
 * leaf, the target is not a Task, or the Task is terminal, which is finished rather than stalled.
 */
export function stallDeadline(test: WatchLeafTest, fact: WatchTargetFact): number | null {
  if (test.leaf !== 'TASK_NO_PROGRESS_FOR' || test.params === undefined || !('seconds' in test.params)) return null;
  if (fact.kind !== 'TASK' || TERMINAL_TASK_STATUSES.includes(fact.status)) return null;
  return (fact.progress.lastProgressAt ?? fact.epochStartedAt).getTime() + test.params.seconds * 1000;
}

/** Whether the predicate holds at `now` over the facts of the targets still in the set (none of them GONE). */
export function predicateHolds(predicate: WatchPredicate, facts: readonly WatchTargetFact[], now: number): boolean {
  switch (predicate.kind) {
    case 'ALL':
      return facts.every((fact) => leafHolds(predicate, fact, now));
    case 'ANY':
      return facts.some((fact) => leafHolds(predicate, fact, now));
    case 'AT_LEAST':
      return facts.filter((fact) => leafHolds(predicate, fact, now)).length >= predicate.count;
    case 'ALL_OF':
      return predicate.operands.every((operand) => predicateHolds(operand, facts, now));
    case 'ANY_OF':
      return predicate.operands.some((operand) => predicateHolds(operand, facts, now));
  }
}

/**
 * Whether the predicate could still hold over a set this many targets have been left in. Only a quorum
 * can ask for more than is left: GONE targets leave the sealed set and are never counted, so `AT_LEAST 3`
 * over two remaining targets cannot hold again however long the watch waits.
 */
export function predicateReachable(predicate: WatchPredicate, liveTargets: number): boolean {
  switch (predicate.kind) {
    case 'AT_LEAST':
      return liveTargets >= predicate.count;
    case 'ALL':
    case 'ANY':
      return liveTargets > 0;
    case 'ALL_OF':
      return predicate.operands.every((operand) => predicateReachable(operand, liveTargets));
    case 'ANY_OF':
      return predicate.operands.some((operand) => predicateReachable(operand, liveTargets));
  }
}

/** Every leaf the predicate names, once each. */
export function predicateLeaves(predicate: WatchPredicate): WatchLeaf[] {
  if ('leaf' in predicate) return [predicate.leaf];
  return [...new Set(predicate.operands.flatMap(predicateLeaves))];
}

/** Every leaf the predicate asks, once per label: the same leaf under two thresholds is two tests. */
export function predicateLeafTests(predicate: WatchPredicate): WatchLeafTest[] {
  if ('leaf' in predicate) {
    return [predicate.params === undefined ? { leaf: predicate.leaf } : { leaf: predicate.leaf, params: predicate.params }];
  }
  const tests = new Map<string, WatchLeafTest>();
  for (const test of predicate.operands.flatMap(predicateLeafTests)) {
    if (!tests.has(leafLabel(test))) tests.set(leafLabel(test), test);
  }
  return [...tests.values()];
}

/** A leaf's name, followed by its parameters when it takes any: `TASK_NO_PROGRESS_FOR(600s)`, `TASK_PROGRESS_AT_LEAST(50%)`. */
export function leafLabel(test: WatchLeafTest): string {
  const { params } = test;
  if (params === undefined) return test.leaf;
  if ('seconds' in params) return `${test.leaf}(${params.seconds}s)`;
  if ('percent' in params) return `${test.leaf}(${params.percent}%)`;
  return `${test.leaf}(${params.current})`;
}

/**
 * The earliest moment after `now` at which a no-progress leaf the predicate names starts to hold for one
 * of these targets, or null. It is when to look again without being told: a stall is decided by the one
 * evaluation schedule every watch already has, never by a timer waiting on a watch of its own.
 */
export function nextStallDeadline(predicate: WatchPredicate, facts: readonly WatchTargetFact[], now: number): number | null {
  let next: number | null = null;
  for (const test of predicateLeafTests(predicate)) {
    for (const fact of facts) {
      const deadline = stallDeadline(test, fact);
      if (deadline !== null && deadline > now && (next === null || deadline < next)) next = deadline;
    }
  }
  return next;
}

/** Each leaf a predicate asks, under its label, as it answered for one target. */
export function leafVerdicts(tests: readonly WatchLeafTest[], fact: WatchTargetFact, now: number): Record<string, boolean> {
  return Object.fromEntries(tests.map((test) => [leafLabel(test), leafHolds(test, fact, now)]));
}

/**
 * The source columns the asked leaves read, as a snapshot records them. A Task's progress is recorded only
 * when a progress leaf read it, so a predicate over statuses records statuses and nothing else.
 */
export function observationOf(fact: WatchTargetFact, tests: readonly WatchLeafTest[]): NonNullable<WatchTargetObservation['observed']> {
  if (fact.kind === 'SESSION') {
    return {
      status: fact.status,
      endReason: fact.endReason,
      runState: deriveSessionRunState(fact),
      lifecycleState: deriveSessionLifecycleState(fact),
      pendingApproval: fact.pendingApproval,
    };
  }
  if (!tests.some((test) => PROGRESS_LEAVES.has(test.leaf))) return { status: fact.status };
  return {
    status: fact.status,
    progress: {
      phase: fact.progress.phase,
      current: fact.progress.current,
      total: fact.progress.total,
      lastProgressAt: fact.progress.lastProgressAt?.toISOString() ?? null,
      epochStartedAt: fact.epochStartedAt.toISOString(),
    },
  };
}

/**
 * The predicate in the contract's own vocabulary, each aggregation carrying how many of the targets its
 * leaf held for — `ANY_OF(ALL TASK_TERMINAL 5/7, ANY TASK_FAILED 1/7)`, `AT_LEAST 2 TASK_DONE 1/3`.
 * Derived from the rows alone, so it is a Match's `reason` and never a log line.
 */
export function describePredicate(predicate: WatchPredicate, facts: readonly WatchTargetFact[], now: number): string {
  if ('leaf' in predicate) {
    const held = facts.filter((fact) => leafHolds(predicate, fact, now)).length;
    const kind = predicate.kind === 'AT_LEAST' ? `AT_LEAST ${predicate.count}` : predicate.kind;
    return `${kind} ${leafLabel(predicate)} ${held}/${facts.length}`;
  }
  return `${predicate.kind}(${predicate.operands.map((operand) => describePredicate(operand, facts, now)).join(', ')})`;
}
