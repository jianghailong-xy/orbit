/**
 * `nextWakeAt` — contract §10.4, and specifically W5 (v1.6 frozen, v1.7 total-ordered and
 * clock-frozen).
 *
 * Every reason the loop might need to wake up produces a CANDIDATE; one total order picks exactly
 * one of them; a floor keeps the answer from being "right now"; and the whole table — not just the
 * winner — is written to the audit. Four properties fall out of that shape and none of them holds
 * without it:
 *
 *   - the same `decisionInput` always yields the same `(nextWakeAt, nextWakeReason)`, whatever
 *     order the candidates were collected in (`PC-CX-39`) and whatever the wall clock says when it
 *     runs (`PC-CX-40`);
 *   - a rate-limited request in the last five seconds of its window has a legal answer at all —
 *     "at most the deadline" and "at least now + 5s" have no common solution there, and W5 resolves
 *     it by letting the floor win and keeping the deadline's REASON (`PC-CX-35`);
 *   - a losing reason is recorded rather than dropped;
 *   - a USER blocker cannot stop the clock of the other blockers it masks (N-mask).
 */

import { ProjectBlockerProjection, PROJECT_BLOCKER_POLICY, compare } from './project-blocker';

/** W3: no wake is ever closer than five seconds to the instant this decision READ the world.
 *  Without a floor, "look again immediately" is a spin, and 10's resource assertions catch it. */
export const PROJECT_WAKE_FLOOR_MS = 5_000;

/** §10.4 clauses 5 and 6: the backstop cadence for an in-flight session and for PLANNING. */
export const PROJECT_WAKE_FALLBACK_MS = 60_000;

/** §7.6 TR2: one `(generation, reasonCode)` opens at most one turn per window. */
export const PROJECT_TURN_RATE_LIMIT_MS = 60_000;

/** W5 clause 1's frozen `subjectType` domain, in the byte order the third sort key uses. */
export type WakeSubjectType = 'BLOCKER' | 'PROJECT' | 'TASK' | 'TURN_WINDOW';

/** W5 clause 1's `source` column: which of §10.4's seven rules produced this candidate. */
export type WakeSource = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface ProjectWakeCandidate {
  at: string;
  source: WakeSource;
  subjectType: WakeSubjectType;
  /**
   * The persistent identity of the ROW that produced this candidate (W5-2b) — never an index into
   * whatever array it was collected from, which would make a replay that iterated differently
   * choose differently.
   *
   * For a blocker already on disk that is its Base62 id. For one this same pass is opening, the
   * row has no id yet, so it is the `dedupe_key` — equally persistent (it is a column, and it is a
   * pure function of the facts), unique among a project's open rows, and it cannot collide with a
   * Base62 id because it contains `:`.
   */
  subjectId: string;
  /** Display only: what this wake would be FOR. Never a sort key. */
  reason: string;
}

export interface ProjectWakeDecision {
  nextWakeAt: string | null;
  nextWakeReason: string | null;
  /** W5 clause 4: the whole table, in the total order, so "same hash ⇒ same audit row" holds. */
  candidates: ProjectWakeCandidate[];
  /** W5 clause 4: set when the floor moved the answer off the winning candidate's own instant. */
  flooredBy: 'W3' | null;
}

export interface ProjectWakeTaskFact {
  /** Base62. */
  id: string;
  retryBackoffUntil: string | null;
  runAt: string | null;
  /** §6.1 S5: the clock already folded into due/not-due at snapshot time. */
  retryBackoffExpired: boolean;
  runAtDue: boolean;
}

export interface ProjectWakeTurnWindow {
  /** §7.2's closed `reasonCode` table; `MANUAL` is its only row today. */
  reasonCode: string;
  /** TR2-a: the anchor action's `created_at + 60s`, a committed fact. */
  windowEndsAt: string;
}

export interface ProjectWakeInput {
  /** §6.1 S5's frozen instant, epoch SECONDS as `decisionInput` carries it. */
  epoch: number;
  /** Base62 project id — the subject of clauses 5 and 6. */
  projectId: string;
  runStateAfter: string;
  /** The open set AFTER this pass commits, masked rows included (N-mask). */
  blockers: readonly ProjectBlockerProjection[];
  tasks: readonly ProjectWakeTaskFact[];
  hasInFlightSession: boolean;
  /** TR2-b: windows still open at `epoch` that a pending request is currently held behind. */
  rateLimitedTurnWindows: readonly ProjectWakeTurnWindow[];
}

/**
 * Collect W5's candidate table. Clause by clause, in the order §10.4 lists them.
 *
 * Nothing here reads a clock: every `at` is either a committed timestamp or an offset from
 * `evaluation.epoch`. That is the whole of `PC-CX-40` — `now()` is not in `decisionInputHash`, so
 * a second clock reading here would make the same input produce two legal answers.
 */
export function collectProjectWakeCandidates(input: ProjectWakeInput): ProjectWakeCandidate[] {
  const epochMs = input.epoch * 1_000;
  const candidates: ProjectWakeCandidate[] = [];

  for (const blocker of input.blockers) {
    const subjectId = blocker.id ?? blocker.dedupeKey;
    // 1 — a blocker that can end without anybody's help MUST have a timer, or a provider coming
    // back would be noticed only by accident.
    if (blocker.recovery === 'TIME' || blocker.recovery === 'EVENT') {
      candidates.push({
        at: blocker.nextCheckAt,
        source: 1,
        subjectType: 'BLOCKER',
        subjectId,
        reason: `recheck ${blocker.kind}`,
      });
    }
    // 2 — the escalation alarm, `recovery = HUMAN` INCLUDED. This is the clause that makes
    // "owner = USER also needs a next_check_at" (§11.1) mechanical, and it is the ONLY reason a
    // waiting-on-a-person project still has a clock.
    if (!blocker.escalatedAt) {
      candidates.push({
        at: new Date(Date.parse(blocker.firstSeenAt)
          + PROJECT_BLOCKER_POLICY[blocker.kind].escalateMs).toISOString(),
        source: 2,
        subjectType: 'BLOCKER',
        subjectId,
        reason: `escalate ${blocker.kind}`,
      });
    }
  }

  for (const task of input.tasks) {
    // 3 / 4 — EVERY backing-off task and EVERY future `runAt`, not the earliest one (v1.7,
    // `PC-CX-39`): "the earliest" is undefined when two expire at the same instant, and the total
    // order below already decides that case without a second tie-break.
    if (task.retryBackoffUntil && !task.retryBackoffExpired) {
      candidates.push({
        at: task.retryBackoffUntil,
        source: 3,
        subjectType: 'TASK',
        subjectId: task.id,
        reason: 'task retry backoff expires',
      });
    }
    if (task.runAt && !task.runAtDue) {
      candidates.push({
        at: task.runAt,
        source: 4,
        subjectType: 'TASK',
        subjectId: task.id,
        reason: 'task becomes due',
      });
    }
  }

  // 5 / 6 — pure backstops: an ending session sends its own event, and PLANNING is woken by
  // whatever changes the graph. From `epoch`, not `now()` (v1.7, W5 clause 3).
  if (input.hasInFlightSession) {
    candidates.push({
      at: new Date(epochMs + PROJECT_WAKE_FALLBACK_MS).toISOString(),
      source: 5,
      subjectType: 'PROJECT',
      subjectId: input.projectId,
      reason: 'in-flight session may end',
    });
  }
  if (input.runStateAfter === 'PLANNING') {
    candidates.push({
      at: new Date(epochMs + PROJECT_WAKE_FALLBACK_MS).toISOString(),
      source: 6,
      subjectType: 'PROJECT',
      subjectId: input.projectId,
      reason: 'planning requires coordinator decision',
    });
  }

  // 7 — TR2-b/TR2-e. Without it a rate-limited explicit request is either consumed and lost, or
  // left pending with no timer pointing at its retry instant. The wording is per `reasonCode`, so
  // the day §7.2's table grows a second row this clause covers it unchanged.
  for (const window of input.rateLimitedTurnWindows) {
    candidates.push({
      at: window.windowEndsAt,
      source: 7,
      subjectType: 'TURN_WINDOW',
      subjectId: window.reasonCode,
      reason: window.reasonCode === 'MANUAL'
        ? 'manual trigger rate-limited'
        : `${window.reasonCode} turn rate-limited`,
    });
  }

  // I5 (`OPEN` ∧ coordinatorEnabled ∧ run_state ∉ {AWAITING_HUMAN, SETTLED} ⇒ a wake exists), and
  // §10.4's own words for everything the clauses above do not cover: "any other NULL is a defect".
  //
  // N-null's second branch is precisely "clauses 1–7 all inapplicable AND at least one open blocker,
  // every one of them HUMAN and already escalated" — and clause 2 makes that equivalent to "the
  // table is empty and there IS an open blocker". So an empty table with NO open blocker is the
  // undefined case, and producing a NULL there would be the defect §10.2 W4 then catches five
  // minutes later. It is reachable today because dispatch is not planned here: AWAITING_VERIFICATION
  // with nothing in flight matches no clause. This makes it a recorded wake instead of a backstop
  // hit, and it can never change an answer the contract does specify — it only runs when nothing
  // else produced a candidate at all.
  if (candidates.length === 0 && input.blockers.length === 0
      && input.runStateAfter !== 'SETTLED') {
    candidates.push({
      at: new Date(epochMs + PROJECT_WAKE_FALLBACK_MS).toISOString(),
      source: 6,
      subjectType: 'PROJECT',
      subjectId: input.projectId,
      reason: input.runStateAfter === 'AWAITING_VERIFICATION'
        ? 'verification may settle'
        : 'reconcile state recheck',
    });
  }

  return candidates;
}

/**
 * W5 clauses 2–4: pick the minimum under `(at, source, subjectType, subjectId)`, floor it at
 * `epoch + 5s`, and record the sorted table.
 *
 * The floor is a HARD lower bound and no deadline overrides it (clause 3). The costs are not
 * symmetric: a floored wake is late by at most five seconds, while dropping the floor turns every
 * window boundary into a spin. `nextWakeReason` still comes from the winning candidate — it answers
 * "what am I waking up for", not "am I on time".
 */
export function chooseProjectWake(
  input: Pick<ProjectWakeInput, 'epoch' | 'runStateAfter'>,
  candidates: readonly ProjectWakeCandidate[],
): ProjectWakeDecision {
  const sorted = [...candidates].sort(compareWakeCandidates);
  // N-null, first branch. SETTLED means the work is over; nothing is waiting on anything.
  if (input.runStateAfter === 'SETTLED') {
    return { nextWakeAt: null, nextWakeReason: null, candidates: [], flooredBy: null };
  }
  // N-null, second branch: none of clauses 1–7 applies. Given clause 2 that means every open
  // blocker is `HUMAN` AND already escalated, no task is backing off, none is scheduled, nothing is
  // in flight and no manual trigger is being held — the one shape in which a stopped clock is not
  // a bug.
  const chosen = sorted[0];
  if (!chosen) {
    return { nextWakeAt: null, nextWakeReason: null, candidates: [], flooredBy: null };
  }
  const floor = input.epoch * 1_000 + PROJECT_WAKE_FLOOR_MS;
  const chosenAt = Date.parse(chosen.at);
  const flooded = chosenAt < floor;
  return {
    nextWakeAt: new Date(flooded ? floor : chosenAt).toISOString(),
    nextWakeReason: chosen.reason,
    candidates: sorted,
    flooredBy: flooded ? 'W3' : null,
  };
}

/**
 * W5 clause 2's lexicographic order. Four keys, and W5-2a is why four and not two: a single source
 * can produce two candidates at the same instant — one provider blocker and one runner blocker
 * both due at `60s` — and `(at, source)` alone leaves the winner to array order.
 *
 * `subjectId` compares BY BYTES, never by a database collation. The contract spells the SQL form
 * `ORDER BY subject_id COLLATE "C"` for the same reason: otherwise one candidate table gives two
 * different `nextWakeReason`s on two machines with different locales.
 */
export function compareWakeCandidates(
  a: ProjectWakeCandidate,
  b: ProjectWakeCandidate,
): number {
  const at = Date.parse(a.at) - Date.parse(b.at);
  if (at !== 0) return at < 0 ? -1 : 1;
  if (a.source !== b.source) return a.source - b.source;
  const subjectType = compare(a.subjectType, b.subjectType);
  if (subjectType !== 0) return subjectType;
  return compare(a.subjectId, b.subjectId);
}
