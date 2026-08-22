/**
 * §7.2 — which semantic turn a snapshot asks for, and §7.6 — whether it may be opened.
 *
 * Pure, and separate from `project-decision.service.ts` for the reason §7.2 TU4 exists at all: the
 * decision is a TOTAL ORDER over predicates that really do hold at the same time, and a total order
 * is only worth freezing if something can enumerate every combination of its inputs. Everything
 * here is a function of the frozen `decisionInput` plus facts the same pass already planned, so a
 * replay of one snapshot produces one reason, one digest and one action key.
 *
 * What v1.17 changed, and why this module exists now (`PC-CX-63`)
 * -------------------------------------------------------------
 * §7.2 TU2 used to read "任务失败永不开 turn", on the grounds that the coordinator is not a retry
 * mechanism and §9.5's backoff already owns retries. That reasoning holds for a task the loop can
 * still move by itself. It does not hold for the state a real failed run actually lands in: a
 * genuine `FAILED` session sets `task.status = FAILED` (runner-api / reaper both do), §7.4's first
 * precondition refuses anything that is not `OPEN` (`TASK_NOT_OPEN`), and §9.5 Q3 only opens a
 * `TEST_FAILED` blocker at `failureCount >= MAX_AUTO_RUN_FAILURES`. One ordinary failure therefore
 * produced: no dispatch ever again, no blocker, no turn — `runStateOf` fell through to `PLANNING`
 * and the project woke every 60s to decide nothing. That is AC3's silent idling with every clause
 * of the contract satisfied, which is what makes it a contract defect rather than a bug.
 *
 * The anti-foreman property TU2 was protecting is preserved by three frozen mechanisms, none of
 * them new: TR1 gives one turn per failure EPISODE (`(taskId, dispatchAttempt)`, not per delivery),
 * TR2 rate-limits per `reasonCode`, and TR3 turns a second look at an unchanged world into a
 * `COORDINATOR_NO_PROGRESS` blocker with a person's name on it.
 */

import { createHash } from 'node:crypto';
import { base62ToUuid } from '@orbit/shared';
import type { ProjectDecisionInput } from './project-decision.service';
import type { CoordinatorSessionPlan } from './project-coordinator-session';
import type { ProjectBlockerProjection } from './project-blocker';
import { failedTaskDisposition, loopCanRetryFailedTask } from './project-failed-retry';
import { PROJECT_BLOCKER_POLICY } from './project-blocker';
import type { PlannedVerificationVerdict } from './task-verification-verdict';

/**
 * §7.2 TU4's total order, most significant first. First true wins; the rest are suppressed.
 *
 * The order is not a preference list — every step is read off a clause that was already frozen:
 * people before machines (1), cause before consequence (2 ≻ 3 ≻ 4, each of 3 and 4 being the thing
 * that PRODUCES the row below it), §4.2 guard 3 ≻ 4 (blocked before acceptance), §4.2 guard 4 ≻ 7
 * (acceptance before planning), and `REPLAN` meaning "none of the others", exactly as `PLANNING`
 * does for state.
 */
export const TURN_REASON_ORDER = [
  'MANUAL',
  'VERDICT',
  'TASK_FAILURE',
  'BLOCKER_DECISION',
  'ACCEPTANCE',
  'REPLAN',
] as const;

export type TurnReasonCode = (typeof TURN_REASON_ORDER)[number];

/**
 * The `turnFacts` of every reason that is TRUE on this snapshot.
 *
 * A key that is PRESENT means the reason holds and carries its §7.2 fact projection; an ABSENT key
 * means it does not hold — or that this planner does not evaluate it yet, which for `ACCEPTANCE`
 * and `REPLAN` is the current state of things (see `turnReasonFactsOf`). Both readings answer TU4
 * the same way, so the order below is total whatever fills it.
 */
export type TurnReasonFacts = Partial<Record<TurnReasonCode, unknown>>;

/** §7.6's answer for the reason TU4 selected. */
export type CoordinatorTurnVerdict =
  /** TR1/TR2/TR3 all clear: this pass may open the turn. */
  | 'OPEN'
  /** TR2: the `(generation, reasonCode)` window has not passed. Nothing is consumed, nothing lost. */
  | 'RATE_LIMITED'
  /** TR3: the same `(generation, reasonDigest)` turn already ran and changed none of its facts. */
  | 'NO_PROGRESS'
  /** TR1: the same key is still in flight. §8.5 `ALREADY_APPLIED`; NOT a no-progress episode. */
  | 'IN_FLIGHT'
  /** TU7: no live coordination run to deliver into. §7.5's rotation goes first. */
  | 'NO_LIVE_RUN';

export interface PlannedCoordinatorTurn {
  reasonCode: TurnReasonCode;
  /** TR1: `sha256(reasonCode ‖ canonical(turnFacts))`. */
  reasonDigest: string;
  /** Exactly what the digest was taken over, for the audit row. */
  turnFacts: unknown;
  /** TU5: reasons that were also true and lost the order. Recorded, not dropped. */
  suppressed: TurnReasonCode[];
  verdict: CoordinatorTurnVerdict;
  /** §8.2's permanent key, spelled Base62 like everything else the decision audit carries. */
  idempotencyKey: string;
  /** TR2-b ③ / TR2-d: the instant the rate-limit window ends, when one is holding this back. */
  windowEndsAt: string | null;
  /** TR3's detail: the coordination run the previous identical turn was delivered into. */
  lastTurnSessionId: string | null;
}

/** Facts the same pass has already planned. Passed in rather than recomputed so the turn and the
 *  blockers/verdicts it reads cannot disagree about one snapshot. */
export interface TurnReasonContext {
  /** §11's open set AFTER this pass's plan — the same list §4.2's guards were evaluated against,
   *  so a blocker this pass is opening RIGHT NOW counts, exactly as it does for `run_state`. */
  openBlockers: readonly ProjectBlockerProjection[];
  /** §13.2's conclusions for this snapshot. */
  verdicts: readonly PlannedVerificationVerdict[];
  /** §7.5's answer, which TU7 reads to decide whether a turn has anywhere to land. */
  coordinator: CoordinatorSessionPlan;
}

/**
 * §8.2's key for a turn. The epoch is `coordinator_generation` plus TR1's digest, and GE4 names
 * this the one deliberate place where a permanent key may be recomputed by a returning world —
 * because TR3 gives that collision a defined consequence.
 */
export function openCoordinatorTurnIdempotencyKey(
  projectId: string,
  generation: bigint | string,
  reasonDigest: string,
): string {
  return `pc:v1:${projectId}:turn:${generation}:${reasonDigest}`;
}

/**
 * The `<generation>` inside a turn key, read back out of it.
 *
 * Read from the key rather than carried beside it so the epoch an action is CLAIMED under and the
 * epoch its permanent name was BUILT from cannot drift apart — §8.2 GE4 already allows this one key
 * to be recomputed by a returning world, and it is the generation that makes that safe.
 */
export function coordinatorTurnGeneration(idempotencyKey: string): string | null {
  const parts = idempotencyKey.split(':');
  return parts.length === 6 && parts[3] === 'turn' ? parts[4] : null;
}

/**
 * §7.2 TU4 / TU5: at most one reason comes out of one snapshot, and which one does not depend on
 * how anything was iterated.
 */
export function chooseTurnReason(
  facts: TurnReasonFacts,
): { reasonCode: TurnReasonCode; turnFacts: unknown; suppressed: TurnReasonCode[] } | null {
  const trueReasons = TURN_REASON_ORDER.filter((code) => Object.hasOwn(facts, code));
  if (trueReasons.length === 0) return null;
  const [reasonCode, ...suppressed] = trueReasons;
  return { reasonCode, turnFacts: facts[reasonCode], suppressed };
}

/** TR1's digest. The `v` is inside the hash so a change to the fact SHAPE cannot silently match an
 *  old episode's key the way a version beside the hash could. */
export function turnReasonDigest(reasonCode: TurnReasonCode, turnFacts: unknown): string {
  return createHash('sha256')
    .update(canonical({ v: 1, reasonCode, turnFacts }))
    .digest('hex');
}

/**
 * §7.2's fact projections, for the reasons a frozen `decisionInput` can answer today.
 *
 * `ACCEPTANCE` and `REPLAN` are deliberately absent: their inputs are §13.4's acceptance digest and
 * attempt, and §7.8's dispatchable set, and neither is computed in this pass. Leaving them out is
 * not the same as deciding they are false — TU4 is total either way, and a reason that is not
 * evaluated cannot win, which is strictly what the loop does today (it opens no turn at all).
 * Filling them in is the only change this function needs when those passes move here.
 */
export function turnReasonFactsOf(
  input: ProjectDecisionInput,
  context: TurnReasonContext,
): TurnReasonFacts {
  const facts: TurnReasonFacts = {};

  // TF5: ALL pending requests, not the one that triggered this pass — one turn answers every
  // request outstanding at the time, so two people clicking inside one window get one run.
  if (input.signals.length > 0) {
    facts.MANUAL = input.signals.map((signal) => signal.dedupeKey).sort();
  }

  // TF4: the verdict's own revision, so `FAIL → fix → FAIL` is two episodes and not one repeat.
  const conclusions = context.verdicts
    .filter((verdict) => verdict.verdict !== 'PASS')
    .map((verdict) => `${verdict.verifierTaskId}#${verdict.verdictRevision}:${verdict.verdict}`)
    .sort();
  if (conclusions.length > 0) facts.VERDICT = conclusions;

  const episodes = failureEpisodes(input);
  if (episodes.length > 0) facts.TASK_FAILURE = episodes;

  // TF2/TF4 + BL6: an escalated row has already been handed to a person, and waking the coordinator
  // for it again is the shape the foreman accident had.
  const blockers = context.openBlockers
    .filter((blocker) => PROJECT_BLOCKER_POLICY[blocker.kind].opensTurn && blocker.escalatedAt === null)
    .map((blocker) => `${blocker.kind}:${blocker.subjectId}#${blocker.lifecycleGeneration}:${blocker.conditionVersion}`)
    .sort();
  if (blockers.length > 0) facts.BLOCKER_DECISION = blockers;

  return facts;
}

/**
 * TF6 (v1.17): one failure EPISODE, identified by the dispatch that produced it.
 *
 * `dispatchAttempt` is the only counter in reach that DA1 already froze as persistent, monotonic
 * and never reset — including across §19.6's "a person fixed it, clear the failure count" recovery.
 * That is exactly GE2's test: take the world from A to B and back to A (fail, a person reopens the
 * task, it fails again) and the key must differ, because the second failure came from a later
 * dispatch. Two facts are deliberately NOT in here:
 *
 *   - `failureCount` — DA3 already bars it from every key, because §19.6 resets it and a reset
 *     counter recomputes a key the ledger has already applied;
 *   - `failureAttributable` — it CLASSIFIES an episode, it does not begin one. Letting it in would
 *     mean a failure whose attribution flipped bought a second turn on the same failed run.
 *
 * A task with a live session is excluded for the same reason §4.2 guard 5 exists: somebody is
 * working on it, and the failure being asked about is not settled yet.
 *
 * v1.18 (`PC-CX-64`): the predicate is `failedTaskDisposition`, not `status = FAILED`
 * ----------------------------------------------------------------------------------
 * TU2 is a two-state table and its judgement has always been one sentence — **控制环自己还能不能动
 * 它**. v1.17 answered it with the status alone because on that deployment the answer was the same:
 * §7.4 refused every `FAILED` task, so `FAILED` meant "the loop cannot move this". `PC-CX-64` gives
 * the loop §9.5 Q3's ladder back on that status, and the two stop being the same question. Reading
 * the status here now would open a turn for every ordinary failure the loop is ALREADY retrying —
 * the coordinator asked to look at a task that will be running again before it answers — which is
 * the "协调器不是重试机制" property TU2 was written to protect, failing in the other direction.
 *
 * So the reason fires on exactly the two arms nothing mechanical advances: an exhausted attempt
 * budget and a failure nothing attributed. Those are the worlds where "not opening a turn" is
 * silence rather than restraint, which is `PC-CX-63`'s sentence, unchanged.
 */
function failureEpisodes(input: ProjectDecisionInput): string[] {
  return input.world.tasks
    .filter((task) => {
      const disposition = failedTaskDisposition({
        status: task.status,
        hasLiveSession: task.liveSessionIds.length > 0,
        failureCount: task.failureCount,
        failureAttributable: task.failureAttributable,
        // S5: the snapshot's own answer, never a clock read here. Absent on decisions captured
        // before `dueTasks` existed, which read as "nothing is holding it" — the same default
        // §7.8's pass uses for the same field.
        retryBackoffExpired: input.evaluation.dueTasks[task.id]?.retryBackoffExpired ?? true,
      });
      return disposition !== 'NOT_FAILED'
        && disposition !== 'OCCUPIED'
        && !loopCanRetryFailedTask(disposition);
    })
    .map((task) => `${task.id}#${task.dispatchAttempt}`)
    .sort();
}

/**
 * §7.2 + §7.6 for one snapshot: which turn, on what facts, under which key, and whether it opens.
 *
 * Returns `null` when no reason holds, and when the snapshot predates the projections these rules
 * read (`world.blockers` / `runtime.coordinatorSessionId` absent) — an old decision has to replay
 * to what it produced, not to today's rules applied to yesterday's world.
 */
export function planCoordinatorTurn(
  input: ProjectDecisionInput,
  context: TurnReasonContext,
): PlannedCoordinatorTurn | null {
  if (context.coordinator.status === 'UNSUPPORTED' || context.coordinator.status === 'OUT_OF_LOOP') {
    return null;
  }
  const chosen = chooseTurnReason(turnReasonFactsOf(input, context));
  if (!chosen) return null;

  const generation = input.world.runtime.coordinatorGeneration;
  const reasonDigest = turnReasonDigest(chosen.reasonCode, chosen.turnFacts);
  // Two spellings of ONE key, the way §8.2 and `publicIdempotencyKey` already keep them: the plan
  // is the public audit protocol and spells the project Base62, the ledger row spells it raw, and
  // TR3 compares against the ledger's hash so it has to ask in the ledger's spelling.
  const idempotencyKey = openCoordinatorTurnIdempotencyKey(
    input.world.project.id, generation, reasonDigest,
  );
  const internalKey = openCoordinatorTurnIdempotencyKey(
    base62ToUuid(input.world.project.id), generation, reasonDigest,
  );
  const base = {
    reasonCode: chosen.reasonCode,
    reasonDigest,
    turnFacts: chosen.turnFacts,
    suppressed: chosen.suppressed,
    idempotencyKey,
  };

  // TU8 (v1.17): TR1 ≻ TR3 ≻ TR2 ≻ open. Key identity is asked first because it is the finest
  // question — TR2's window is a property of the `reasonCode`, and answering it first would let a
  // turn that TR3 has already ruled out consume a window it will never use.
  const previous = lastAppliedTurn(input, internalKey);
  if (previous) {
    return coordinatorRunIsBusy(input)
      ? { ...base, verdict: 'IN_FLIGHT', windowEndsAt: null, lastTurnSessionId: previous.resultSessionId }
      : { ...base, verdict: 'NO_PROGRESS', windowEndsAt: null, lastTurnSessionId: previous.resultSessionId };
  }

  const window = input.evaluation.turnWindows?.[chosen.reasonCode];
  if (window && !window.rateLimitExpired) {
    return { ...base, verdict: 'RATE_LIMITED', windowEndsAt: window.windowEndsAt, lastTurnSessionId: null };
  }

  // TU7: a turn is a message into a coordination run. With no live one there is nothing to deliver
  // into, and TR2-c already forbids answering the request from a pass that rotates instead. The
  // reason is a fact, not an event, so it is still true on the pass after the rotation.
  if (context.coordinator.status !== 'HEALTHY') {
    return { ...base, verdict: 'NO_LIVE_RUN', windowEndsAt: null, lastTurnSessionId: null };
  }

  return { ...base, verdict: 'OPEN', windowEndsAt: null, lastTurnSessionId: null };
}

/** The most recent APPLIED turn carrying this exact key, if this project has one. */
function lastAppliedTurn(
  input: ProjectDecisionInput,
  idempotencyKey: string,
): { resultSessionId: string | null } | null {
  const wanted = createHash('sha256').update(idempotencyKey).digest('hex');
  for (let i = input.world.actions.length - 1; i >= 0; i -= 1) {
    const action = input.world.actions[i];
    if (action.type !== 'OPEN_COORDINATOR_TURN' || action.status !== 'APPLIED') continue;
    if (action.idempotencyKeyHash !== wanted) continue;
    return { resultSessionId: action.resultSessionId };
  }
  return null;
}

/**
 * TR3's premise: has the previous turn ENDED?
 *
 * `AWAITING_INPUT` and `INTERRUPTED` are live RUNS (§7.5 will not rotate away from them) but they
 * are ended TURNS — the coordinator answered and is waiting. Reading them as still in flight is
 * what would make TR3 unreachable in exactly the state a coordinator spends its life in.
 */
function coordinatorRunIsBusy(input: ProjectDecisionInput): boolean {
  const status = input.world.coordinatorSession?.runStatus;
  return status === 'RUNNING' || status === 'PENDING';
}

/** Key-sorted JSON, the same canonical form `hashDecisionInput` and §7.5's digest use. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * The `conversation_turn.client_turn_id` one opened turn is filed under: §8.2's key, verbatim.
 *
 * One string in two tables rather than a derivation, because the two idempotency layers this turn
 * has are meant to be recognisably the same fact. `project_action.idempotency_key` stops a second
 * ledger claim; `conversation_turn (session_id, client_turn_id)` stops a second message — and a
 * reader (or a repair query) can join them without knowing a rule. The session scope is what makes
 * it safe to reuse the string as-is: the key already carries `generation`, and a generation belongs
 * to exactly one coordination run (§7.5), so one key can never name two sessions' turns.
 */
export function openCoordinatorTurnClientTurnId(idempotencyKey: string): string {
  return idempotencyKey;
}
