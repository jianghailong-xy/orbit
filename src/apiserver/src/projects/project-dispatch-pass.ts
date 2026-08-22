/**
 * §7.8 — which tasks this snapshot would dispatch, as a pure function of the snapshot.
 *
 * The unit this file belongs to exists because §7.3's table is applied by units that each propose
 * their own action list (`plannedActions` says so in as many words), and until now no unit proposed
 * `DISPATCH_TASK` at all: `ProjectTaskDispatcherService` was reachable only from the e2e rig, whose
 * own comment — "exactly as a pass that chose to would" — named a pass that did not exist. A
 * project could sit `OPEN`, un-blocked, with a ready task and free concurrency, and take twenty-three
 * consecutive decisions without one `dispatch_attempt`. That is AC3's silent idling, from inside.
 *
 * The split this file draws is the whole design: **the pass chooses, the dispatcher admits.**
 *
 * Choosing is §7.4's preconditions read off the frozen snapshot, and nothing else — no clock, no
 * randomness, no second query. Admitting is §9.2's matrix, §9.4's budgets, §7.4's commit-point
 * re-checks and PAC §5's resolution chain, which `ProjectTaskDispatcherService` already runs inside
 * the ledger's transaction under the project row lock. Anything this file decided that the
 * dispatcher also decides would be a second implementation of a gate, and §7.4 A6 is a page about
 * what happens when the two disagree.
 *
 * So the predicates here are deliberately only the ones whose falsity means **"this is not a next
 * step at all"**: a task that is not open, not the coordinator's to dispatch, held, not due, already
 * running, waiting on a prerequisite, or stopped by a blocker. The ones whose falsity means "not
 * right now" — runner offline, provider down, over the concurrency cap, needs an approval — are
 * left to the dispatcher on purpose, because a refusal it writes is an auditable fact with a
 * recovery code and a `retryAt`, whereas a candidate this file silently dropped is not observable
 * anywhere. §11.2's first seven kinds only ever open because a dispatch was attempted and refused;
 * a pass that pre-filtered them would keep those blockers from ever being raised, and §11.4 clears
 * them by *attempting again* and not being refused, so it would keep them from ever being cleared
 * either.
 *
 * Two things break that symmetry, and both for the same reason: they are the cases where letting a
 * doomed attempt through costs a PERMANENT action key on every wake, forever, with nothing in §11
 * pacing it.
 *
 *  - The capacity caps (§9.4). Over-cap dispatches are refused `PROJECT_CONCURRENCY_LIMIT` /
 *    `AGENT_CONCURRENCY_LIMIT`, which §11.2 lists as non-blocking, so no blocker ever opens to slow
 *    them down. Capping the candidate list by the snapshot's own free slots is §7.4 precondition 6's
 *    first half — "在快照上判一次…只是为了不白跑" — and the commit-point half stays where it is.
 *  - One attempt per task per window (`PROJECT_DISPATCH_RETRY_WINDOW_MS`), because a refusal
 *    generates the signal that would produce the next one. See that constant for why §11's clocks
 *    cannot be the throttle.
 */

import { ProjectDecisionInput } from './project-decision.service';
import {
  PROJECT_BLOCKER_RESOLUTION_CHAIN_KINDS,
  ProjectBlockerFact,
} from './project-blocker';
import { failedTaskDisposition, loopCanRetryFailedTask } from './project-failed-retry';
import {
  TaskRetirement,
  dependencySatisfied,
  taskRetirement,
} from '../tasks/task-supersession';
import { isLiveSessionStatus } from './project-coordinator-session';

/** How many dispatches one pass may propose, however much capacity the project reports. */
export const PROJECT_DISPATCH_PASS_MAX_PER_WAKE = 8;

/**
 * The shortest interval between two dispatch attempts on ONE task, and the reason this file has a
 * clock rule at all.
 *
 * §8.3 advances `task.dispatch_attempt` for every claimed action — applied, refused or stale — and
 * migration 0117's `project_task_event_source` turns any scalar write on a task into a
 * `task.updated` signal. So a REFUSED dispatch enqueues the event that wakes the pass that would
 * dispatch it again: a self-sustaining loop that mints one permanent action key per wake for as
 * long as the refusal's cause lasts. An APPLIED one terminates on its own (the task now holds a
 * live Session, §7.4 precondition 4); a refused one has nothing to stop it.
 *
 * §11's rows cannot be that stop. §11.4 clears a resolution-chain kind ONLY by letting an attempt
 * through and watching it not be refused, so any rule keyed on "a blocker is open" deadlocks the
 * very row it is waiting on; and a `recovery = EVENT` row's `nextCheckAt` is recomputed as
 * `now + pollMs` on every touch (§11.3), so a project being reconciled every ten seconds pushes
 * that instant away faster than it arrives.
 *
 * What is left is a floor, which is what §7.6 TR2 already does for the other repeatable action:
 * one attempt per window, per subject. 60s is TR2's window and the dispatcher's own
 * `RUNNER_RETRY_MS`, and it sits far inside §10.4's five-minute hard cap for `L`.
 */
export const PROJECT_DISPATCH_RETRY_WINDOW_MS = 60_000;

/**
 * Why a task this pass looked at is not a candidate. Diagnostic only: it enters no key, no digest
 * and no decision — it exists so "the loop is doing nothing" has an answer that is not a shrug.
 */
export type ProjectDispatchSkipReason =
  | 'TASK_NOT_OPEN'
  /**
   * §13.6 SU6: this attempt was replaced or abandoned. Its own reason and not `TASK_NOT_OPEN`,
   * because the two send a reader to opposite places — "it has not started" versus "somebody else
   * finished this". It is also the one skip whose absence was an incident: without it a `FAILED`
   * task that had been re-done read as an ordinary retryable failure and was dispatched again.
   */
  | 'TASK_SUPERSEDED'
  /** §9.5 Q3's terminal cells: the failure is real and nothing mechanical advances it (`PC-CX-64`). */
  | 'TASK_FAILED_TERMINAL'
  | 'NOT_COORDINATOR_AUTHORITY'
  | 'TASK_DISPATCH_HELD'
  | 'TASK_NOT_DUE'
  | 'RETRY_BACKOFF_ACTIVE'
  | 'TASK_ALREADY_RUNNING'
  | 'TASK_DEPENDENCIES_INCOMPLETE'
  | 'VERIFICATION_SUBJECT_NOT_DONE'
  /**
   * §13.6 SU6, the derived half: this task CHECKS an attempt that was replaced or abandoned. The
   * check is obsolete — its subject will never be dispatched again, so it can never become DONE,
   * and `VERIFICATION_SUBJECT_NOT_DONE` would be true forever while reading as a temporary wait.
   * A separate reason because it is a TERMINAL answer, and everything downstream keys on that: no
   * blocker, no retry, no wake, no AWAITING_VERIFICATION.
   */
  | 'VERIFICATION_SUBJECT_SUPERSEDED'
  | 'WHO_UNRESOLVED'
  | 'PROJECT_BLOCKED'
  | 'TASK_BLOCKED'
  | 'RECENTLY_REFUSED'
  | 'PROJECT_CONCURRENCY_LIMIT'
  | 'AGENT_CONCURRENCY_LIMIT'
  | 'PASS_LIMIT_REACHED';

export interface ProjectDispatchCandidate {
  /** Base62, exactly as the snapshot spells it. */
  taskId: string;
  /** `task.dispatch_attempt` as this snapshot saw it — the epoch the key below is minted for. */
  attempt: string;
}

export interface ProjectDispatchSelection {
  candidates: ProjectDispatchCandidate[];
  /** Every task that was considered and rejected, with the first predicate that rejected it. */
  skipped: Array<{ taskId: string; reason: ProjectDispatchSkipReason }>;
  /** Free project slots this snapshot reported, before the pass limit was applied. */
  freeSlots: number;
}

/**
 * §8.2's permanent key for one dispatch attempt, in the ledger's spelling (raw ids).
 *
 * `attempt` is `task.dispatch_attempt` **as the snapshot read it**, not a counter this process
 * keeps: §8.3 advances that column once per claimed action row and never on a replay, so re-running
 * an identical pass against an unchanged world mints the identical key and lands on
 * `ALREADY_APPLIED`. That is the whole of the replay-idempotence property — no attempt bookkeeping
 * lives outside the database.
 */
export function projectDispatchIdempotencyKey(
  projectId: string,
  taskId: string,
  attempt: string,
): string {
  return `pc:v1:${projectId}:dispatch:${taskId}:${attempt}`;
}

/**
 * §7.4 preconditions 1–5 on the snapshot, capped by §9.4's free slots.
 *
 * Pure: same `ProjectDecisionInput` in, byte-identical selection out. Every fact it reads is a
 * field of the input — `evaluation.dueTasks` supplies the two answers that would otherwise need a
 * clock (S5), and `world.blockers` supplies §11's guard. Nothing here calls `Date.now()`, and that
 * is load-bearing rather than stylistic: the plan built from this list is replayed by
 * `assertDecisionReplay` and compared byte-for-byte.
 *
 * `autoRunWhenReady` is deliberately NOT read. §12.3 D4 freezes it as the legacy sweep's switch and
 * says in as many words that it does not apply to a `COORDINATOR`-authority task; §2 B3 forbids
 * treating "turn autoRun on for everything" as a stand-in for the coordinator. Reading it here
 * would resurrect both — a user who cleared the box would silently lose control-loop dispatch,
 * which is the behaviour D4 requires the UI to promise is impossible.
 *
 * `world.runtime.runState` is deliberately NOT read either (§7.8 DP6). §4.2 RS0 is the project's
 * one-line summary for people and for §10.4's wake table, evaluated first-match-wins over the whole
 * project; admission is per task. Reading the summary as a gate is wrong in both directions, and
 * one of them is a deadlock:
 *
 *  - `AWAITING_VERIFICATION` fires on "the project contains a verification task that is not DONE",
 *    which is true from the instant somebody files one — before its subject has even been
 *    dispatched. Gating on it would stop the subject, stop the check, and leave nothing that could
 *    ever clear the state. §10.3 already lists `AWAITING_VERIFICATION` among the states that must
 *    keep proving they are not idling, rather than among the two that are excused.
 *  - `EXECUTING` fires on "some task is running", which is exactly the world in which the second of
 *    `maxConcurrentTasks = 3` slots should be filled. §9.4's cap bounds parallelism; the label is
 *    not a mutex.
 *  - `BLOCKED` / `AWAITING_HUMAN` do stop dispatch — but what stops it is the open blockers that
 *    PRODUCED them, which §11 BL1 reads directly, here and at the commit point. Gating on the label
 *    as well would put one rule in two places.
 *  - `SETTLED` means the project is not OPEN, and §8.1 grants no lease on one.
 */
export function selectDispatchableTasks(
  input: ProjectDecisionInput,
  limit = PROJECT_DISPATCH_PASS_MAX_PER_WAKE,
): ProjectDispatchSelection {
  const project = input.world.project;
  const empty: ProjectDispatchSelection = { candidates: [], skipped: [], freeSlots: 0 };
  if (project.status !== 'OPEN' || !project.coordinatorEnabled) return empty;

  // The whole snapshot's indexes, built BEFORE the first branch that reads them. The
  // project-blocked early return below explains every considered task, and "considered" is one of
  // the questions §13.6 SU6 answers — so these have to exist by then, not eleven lines later.
  const statusOf = new Map(input.world.tasks.map((task) => [task.id, task.status]));
  // Absent fields read as "not retired" (pre-0129), which is what every one of those rows was.
  const retirementOf = new Map(input.world.tasks.map((task) => [task.id, taskRetirement({
    supersededByTaskId: task.supersededByTaskId ?? null,
    terminalReason: task.terminalReason ?? null,
  })]));
  // §13.6 SU9's edges: attempt → the attempt that replaced it. A successor outside this snapshot is
  // deliberately absent rather than assumed, which makes the walk stop and the dependency read as
  // outstanding — the same answer an unknown prerequisite already gets.
  const successorOf = new Map(input.world.tasks.map(
    (task) => [task.id, task.supersededByTaskId ?? null],
  ));
  const obsoleteSubjects = new Set(
    [...retirementOf].filter(([, retired]) => retired != null).map(([id]) => id),
  );

  // §4.2's `run_state` is deliberately absent from this predicate; see `dispatchStoppedByRunState`.
  const blockers = input.world.blockers ?? [];
  if (blockers.some((blocker) => blocker.subjectType === 'PROJECT')) {
    return {
      candidates: [],
      skipped: input.world.tasks
        .filter((task) => consideredForDispatch(task, obsoleteSubjects))
        .map((task) => ({ taskId: task.id, reason: 'PROJECT_BLOCKED' as const }))
        .sort(byTaskId),
      freeSlots: 0,
    };
  }

  // `world.actions` is ordered by `(created_at, id)`, so the last one seen per subject is that
  // task's latest attempt — the same read `refusedDispatchConditions` makes of the same list.
  const latestDispatch = new Map<string, ProjectDecisionInput['world']['actions'][number]>();
  for (const action of input.world.actions) {
    if (action.type !== 'DISPATCH_TASK' || !action.subjectId) continue;
    latestDispatch.set(action.subjectId, action);
  }
  const epochMs = input.evaluation.epoch * 1_000;
  const liveByAgent = new Map<string, number>();
  let live = 0;
  for (const session of input.world.sessions) {
    if (session.taskId == null || session.deletedAt) continue;
    if (!isLiveSessionStatus(session.runStatus)) continue;
    live += 1;
    const agentId = input.world.tasks.find((task) => task.id === session.taskId)?.assigneeAgentId;
    if (agentId) liveByAgent.set(agentId, (liveByAgent.get(agentId) ?? 0) + 1);
  }
  const agentCap = new Map(input.world.team.map((member) => [member.agentId, member.maxConcurrentTasks]));
  const freeSlots = Math.max(0, project.maxConcurrentTasks - live);

  const skipped: ProjectDispatchSelection['skipped'] = [];
  const ready: ProjectDispatchCandidate[] = [];
  // Byte order over the Base62 id, the same total order §10.4 W5-2a gives its candidate table.
  // Orbit's task ids decode to UUIDv7, so this is also oldest-first — a ready task cannot be
  // starved by one filed after it, and two passes over one world agree on who goes first.
  for (const task of [...input.world.tasks].sort((a, b) => compare(a.id, b.id))) {
    const due = input.evaluation.dueTasks[task.id];
    const reason = firstFailure(
      task, due, statusOf, successorOf, retirementOf, blockers,
      latestDispatch.get(task.id), epochMs,
    );
    if (reason) {
      if (consideredForDispatch(task, obsoleteSubjects)) skipped.push({ taskId: task.id, reason });
      continue;
    }
    ready.push({ taskId: task.id, attempt: task.dispatchAttempt });
  }

  const candidates: ProjectDispatchCandidate[] = [];
  const takenByAgent = new Map<string, number>();
  for (const candidate of ready) {
    const task = input.world.tasks.find((row) => row.id === candidate.taskId)!;
    const agentId = task.assigneeAgentId!;
    if (candidates.length >= freeSlots) {
      skipped.push({ taskId: candidate.taskId, reason: 'PROJECT_CONCURRENCY_LIMIT' });
      continue;
    }
    const cap = agentCap.get(agentId);
    const inFlight = (liveByAgent.get(agentId) ?? 0) + (takenByAgent.get(agentId) ?? 0);
    if (cap != null && inFlight >= cap) {
      skipped.push({ taskId: candidate.taskId, reason: 'AGENT_CONCURRENCY_LIMIT' });
      continue;
    }
    if (candidates.length >= limit) {
      skipped.push({ taskId: candidate.taskId, reason: 'PASS_LIMIT_REACHED' });
      continue;
    }
    takenByAgent.set(agentId, (takenByAgent.get(agentId) ?? 0) + 1);
    candidates.push(candidate);
  }
  return { candidates, skipped: skipped.sort(byTaskId), freeSlots };
}

function firstFailure(
  task: ProjectDecisionInput['world']['tasks'][number],
  due: { runAtDue: boolean; retryBackoffExpired: boolean } | undefined,
  statusOf: Map<string, string>,
  successorOf: Map<string, string | null>,
  retirementOf: Map<string, TaskRetirement | null>,
  blockers: readonly ProjectBlockerFact[],
  latestDispatch: ProjectDecisionInput['world']['actions'][number] | undefined,
  epochMs: number,
): ProjectDispatchSkipReason | null {
  // §13.6 SU6, before anything else this function asks. A retired attempt is not a task whose
  // preconditions failed — it is not this project's next step at all, whatever its status, its
  // authority or its backoff say. Asked first so the sentence a reader gets names the fact that
  // actually decided it, and so the answer cannot change when some other precondition does.
  const retirement = taskRetirement({
    supersededByTaskId: task.supersededByTaskId ?? null,
    terminalReason: task.terminalReason ?? null,
  });
  if (retirement != null) return 'TASK_SUPERSEDED';
  // ...and the derived half, HERE rather than beside §7.4 precondition 3 where it naturally reads.
  // The order is the point: below this line come the failure ladder, the retry budget and §11's
  // blockers, and every one of them would answer first for a FAILED check whose subject was
  // replaced — reporting `TASK_FAILED_TERMINAL`, opening a `TEST_FAILED` row and waking a person
  // about a check that can never run again for a reason that has nothing to do with its failures.
  // An obsolete task is not a task whose preconditions failed; it is not a step at all.
  if (task.verifiesTaskId && retirementOf.get(task.verifiesTaskId) != null) {
    return 'VERIFICATION_SUBJECT_SUPERSEDED';
  }
  // §7.4 precondition 1, v1.18 (`PC-CX-64`). `OPEN` is one of the two statuses a dispatchable task
  // can be in, not the only one: a real failed run leaves `FAILED`, and §9.5 Q3's retry ladder is
  // written for exactly that task. `failedTaskDisposition` is the single judgement — the same one
  // §9.2 admits on, §7.2 TU2 reads to decide whether the coordinator hears about it, and §11.4
  // turns into a row — so a task this pass calls retryable cannot be one the dispatcher refuses as
  // exhausted, or one the turn planner simultaneously reports as beyond mechanical help.
  if (task.status !== 'OPEN') {
    const disposition = failedTaskDisposition(dispatchFailureFacts(
      task, due, task.verifiesTaskId ? retirementOf.get(task.verifiesTaskId) : null,
    ));
    // The backoff arm falls through to the shared `RETRY_BACKOFF_ACTIVE` skip below, so one world
    // reports one reason whichever status the task is in.
    if (!loopCanRetryFailedTask(disposition)) {
      return disposition === 'NOT_FAILED' || disposition === 'OCCUPIED'
        ? 'TASK_NOT_OPEN'
        : 'TASK_FAILED_TERMINAL';
    }
  }
  // §12.3: the authority column answers "whose task is this to dispatch", and a LEGACY one is the
  // three existing sweeps' to start. Proposing it here is the duplicate dispatch §12.3 exists to
  // prevent, and §7.7 D6's trigger would refuse the Session anyway.
  if (task.dispatchAuthority !== 'COORDINATOR') return 'NOT_COORDINATOR_AUTHORITY';
  if (task.dispatchHold) return 'TASK_DISPATCH_HELD';
  // S5: due and backoff are answered by the snapshot, never by reading a clock here.
  if (due && !due.runAtDue) return 'TASK_NOT_DUE';
  if (due && !due.retryBackoffExpired) return 'RETRY_BACKOFF_ACTIVE';
  // §7.4 precondition 4.
  if (task.liveSessionIds.length > 0) return 'TASK_ALREADY_RUNNING';
  // §7.4 precondition 3, first half. A prerequisite this snapshot cannot see is NOT ready: the
  // snapshot is project-scoped, so an edge that leaves the project is an unknown, and an unknown
  // prerequisite has to read as outstanding.
  // §7.4 precondition 3, first half — through §13.6 SU9's chain. An edge points at an ATTEMPT, and
  // when that attempt was replaced the work moved to its successor while the edge did not. Read as
  // `status = 'DONE'` it is a prerequisite nothing can ever complete.
  if (task.dependsOnTaskIds.some((id) => !dependencySatisfied(id, statusOf, successorOf))) {
    return 'TASK_DEPENDENCIES_INCOMPLETE';
  }
  // §7.4 precondition 3, second half: a check may not run before the thing it checks is finished.
  // The REPLACED case was split out and answered at the top of this function; what is left here is
  // the genuine wait.
  if (task.verifiesTaskId && statusOf.get(task.verifiesTaskId) !== 'DONE') {
    return 'VERIFICATION_SUBJECT_NOT_DONE';
  }
  // Not a gate this pass enforces — §9.2 does, and it DENYs — but an unassigned task has no agent
  // whose concurrency cap could be counted below, so it cannot be ranked. It reaches the dispatcher
  // through §11's resolution chain the moment somebody assigns it.
  if (!task.assigneeAgentId) return 'WHO_UNRESOLVED';
  // §11 BL1, task-scoped half. Kept byte-identical in intent to `openBlockersStoppingDispatch`,
  // including its one exception: a resolution-chain kind must NOT stop the attempt, because §11.4
  // clears those rows only by letting an attempt through and watching it not be refused.
  if (blockers.some((blocker) => blocker.subjectType === 'TASK'
    && blocker.subjectId === task.id
    && !PROJECT_BLOCKER_RESOLUTION_CHAIN_KINDS.includes(blocker.kind))) {
    return 'TASK_BLOCKED';
  }
  // The self-loop guard (see `PROJECT_DISPATCH_RETRY_WINDOW_MS`). Last, so that a task whose world
  // has genuinely moved on — finished, held, blocked, out of slots — reports the reason a reader
  // can act on rather than "come back later".
  if (latestDispatch?.status === 'REFUSED'
    && Date.parse(latestDispatch.createdAt) + PROJECT_DISPATCH_RETRY_WINDOW_MS > epochMs) {
    return 'RECENTLY_REFUSED';
  }
  return null;
}

/**
 * Which tasks this pass owes an explanation for. `FAILED` joins `OPEN` in v1.18 for the reason the
 * skip list exists at all: a task the loop stopped retrying is precisely the one whose absence from
 * the candidate list a person needs a sentence about, and before `PC-CX-64` it was the one status
 * that got none.
 */
function consideredForDispatch(
  task: {
    status: string; supersededByTaskId?: string | null; terminalReason?: string | null;
    verifiesTaskId?: string | null;
  },
  obsoleteSubjects?: ReadonlySet<string>,
): boolean {
  if (task.verifiesTaskId && obsoleteSubjects?.has(task.verifiesTaskId)) return true;
  // A retired attempt is explained whatever status it holds: `TASK_SUPERSEDED` on a CANCELLED row
  // is the sentence that tells a reader the work moved rather than stopped, and it is the one this
  // project's own history had no way to say.
  if (taskRetirement({
    supersededByTaskId: task.supersededByTaskId ?? null,
    terminalReason: task.terminalReason ?? null,
  }) != null) {
    return true;
  }
  return task.status === 'OPEN' || task.status === 'FAILED';
}

/**
 * §6.1's two halves of one judgement, put back together: the task row carries the failure history,
 * `evaluation.dueTasks` carries the clock's answer about it (S5). `liveSessionIds` is the snapshot's
 * own projection, so `OCCUPIED` here means exactly what precondition 4 means below.
 */
function dispatchFailureFacts(
  task: ProjectDecisionInput['world']['tasks'][number],
  due: { runAtDue: boolean; retryBackoffExpired: boolean } | undefined,
  subjectRetirement?: TaskRetirement | null,
) {
  return {
    status: task.status,
    hasLiveSession: task.liveSessionIds.length > 0,
    failureCount: task.failureCount,
    failureAttributable: task.failureAttributable,
    // An absent entry predates `dueTasks` and reads as "no backoff is holding it", which is what
    // `selectDispatchableTasks` already assumes for `runAtDue` two lines below.
    retryBackoffExpired: due?.retryBackoffExpired ?? true,
    retirement: taskRetirement({
      supersededByTaskId: task.supersededByTaskId ?? null,
      terminalReason: task.terminalReason ?? null,
    }),
    subjectRetirement: subjectRetirement ?? null,
  };
}

function byTaskId(a: { taskId: string }, b: { taskId: string }): number {
  return compare(a.taskId, b.taskId);
}

/** By bytes, never by a database collation — §10.4 W5-2a's rule, for the same reason. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
