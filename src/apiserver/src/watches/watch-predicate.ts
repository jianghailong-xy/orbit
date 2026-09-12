/**
 * The Watch predicate grammar (docs/watch-contract.md §2) and what each leaf means against the rows
 * it names.
 *
 * Pure: nothing here reads a database or a clock. `WatchEvaluatorService` reads the leaves'
 * `sourceColumns` inside its evaluating transaction and hands the rows in; this only decides. The
 * leaves call the derivations the rest of the server already answers the same questions with —
 * `UNSETTLED_SESSION_STATUSES`, `deriveSessionRunState`, `deriveSessionLifecycleState` — so a watch
 * cannot disagree with `session_create(wait)` or the session list about whether a turn settled or
 * a session ended.
 */
import {
  deriveSessionLifecycleState,
  deriveSessionRunState,
  SessionLifecycleState,
  SessionRunState,
  TaskStatus,
} from '@orbit/shared';

import { UNSETTLED_SESSION_STATUSES } from '../common/session-scheduling';

/** The grammar this build evaluates. A watch stored under another version is left to a build that serves it. */
export const WATCH_PREDICATE_VERSION = 1;

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
} as const satisfies Record<string, WatchTargetKind>;

export type WatchLeaf = keyof typeof WATCH_LEAF_TARGET_KIND;

export type WatchPredicate =
  | { kind: 'ALL' | 'ANY'; over: 'ALL_TARGETS'; leaf: WatchLeaf }
  | { kind: 'ALL_OF' | 'ANY_OF'; operands: WatchPredicate[] };

/** One target's source columns, as the evaluating transaction read them. */
export type WatchTargetFact =
  | { kind: 'TASK'; status: string }
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
 * The stored predicate as a term of the grammar, or null when it is not one. Creation refuses such a
 * predicate; this is the evaluator declining to guess at one that got past it anyway.
 */
export function parseWatchPredicate(value: unknown): WatchPredicate | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const term = value as Record<string, unknown>;
  if (term.kind === 'ALL' || term.kind === 'ANY') {
    if (term.over !== 'ALL_TARGETS' || typeof term.leaf !== 'string') return null;
    if (!Object.hasOwn(WATCH_LEAF_TARGET_KIND, term.leaf)) return null;
    return { kind: term.kind, over: 'ALL_TARGETS', leaf: term.leaf as WatchLeaf };
  }
  if (term.kind === 'ALL_OF' || term.kind === 'ANY_OF') {
    if (!Array.isArray(term.operands) || term.operands.length === 0) return null;
    const operands = term.operands.map(parseWatchPredicate);
    return operands.every((operand): operand is WatchPredicate => operand !== null)
      ? { kind: term.kind, operands }
      : null;
  }
  return null;
}

/** Whether one leaf holds for one target. A leaf asked about the wrong kind of target does not hold. */
export function leafHolds(leaf: WatchLeaf, fact: WatchTargetFact): boolean {
  switch (leaf) {
    case 'TASK_TERMINAL':
      return fact.kind === 'TASK' && TERMINAL_TASK_STATUSES.includes(fact.status);
    case 'TASK_FAILED':
      return fact.kind === 'TASK' && fact.status === TaskStatus.FAILED;
    case 'TASK_DONE':
      return fact.kind === 'TASK' && fact.status === TaskStatus.DONE;
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

/** Whether the predicate holds over the facts of the targets still in the set (none of them GONE). */
export function predicateHolds(predicate: WatchPredicate, facts: readonly WatchTargetFact[]): boolean {
  switch (predicate.kind) {
    case 'ALL':
      return facts.every((fact) => leafHolds(predicate.leaf, fact));
    case 'ANY':
      return facts.some((fact) => leafHolds(predicate.leaf, fact));
    case 'ALL_OF':
      return predicate.operands.every((operand) => predicateHolds(operand, facts));
    case 'ANY_OF':
      return predicate.operands.some((operand) => predicateHolds(operand, facts));
  }
}

/** Every leaf the predicate names, once each. */
export function predicateLeaves(predicate: WatchPredicate): WatchLeaf[] {
  if ('leaf' in predicate) return [predicate.leaf];
  return [...new Set(predicate.operands.flatMap(predicateLeaves))];
}

/**
 * The predicate in the contract's own vocabulary, each aggregation carrying how many of the targets
 * its leaf held for — `ANY_OF(ALL TASK_TERMINAL 5/7, ANY TASK_FAILED 1/7)`. Derived from the rows
 * alone, so it is a Match's `reason` and never a log line.
 */
export function describePredicate(predicate: WatchPredicate, facts: readonly WatchTargetFact[]): string {
  if ('leaf' in predicate) {
    const held = facts.filter((fact) => leafHolds(predicate.leaf, fact)).length;
    return `${predicate.kind} ${predicate.leaf} ${held}/${facts.length}`;
  }
  return `${predicate.kind}(${predicate.operands.map((operand) => describePredicate(operand, facts)).join(', ')})`;
}
