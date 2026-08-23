/**
 * §13.3 DEP — when does a dependency on a VERIFICATION task count as satisfied?
 *
 * Every dependency gate in this codebase used to answer one question: is the prerequisite DONE?
 * For ordinary work that is the whole of it. For a check it is the wrong question, and the way it
 * is wrong is the incident this file exists for: a verification task reaches `DONE` when its RUN
 * finishes, whatever it concluded. `H0V` ran, concluded **FAIL**, and went DONE — and every task
 * that named it as a prerequisite became READY, because `status = 'DONE'` was true. A failed check
 * released the work it was there to hold.
 *
 * `task.verdict` already carried the conclusion; nothing downstream read it. So the fix is not a
 * new mechanism, it is asking the column that already exists — plus the four facts that decide
 * whether that column is yet *worth* anything.
 *
 * ## The PASS epoch
 *
 * A subject is not "passed" by a verdict; it is passed by a verdict that is CURRENT. Two checks of
 * the same subject are two opinions, a re-run opens a new question, and a subject somebody reopened
 * is not the thing that was checked. So the unit is an EPOCH, and it belongs to the SUBJECT —
 * which is also what a dependency edge is ABOUT:
 *
 *   > The subject's PASS epoch is open when its NEWEST LIVE check has an applied PASS and the
 *   > subject is still DONE.
 *
 * ## The edge is judged by the subject, not by the row it names
 *
 * `dependsOn: A` means "wait until A is done". When A has a check, "done" is "done AND verified",
 * and that is the edge callers are told to write (see `AddDependencyDto`). So the epoch gates the
 * SUBJECT's own edge — a task depending on a DONE subject whose latest check says FAIL stays
 * blocked, which is the shape this project's own incident actually had: H1 and L1 named H0, not
 * H0V. A subject nobody checks is untouched: no verification rows, no epoch, plain DONE decides.
 *
 * An edge naming the CHECK is resolved to the SAME epoch rather than to "that run ended". Those
 * plans exist and must keep working, and reading them as "wait for this particular run" is both
 * narrower than the author meant and fragile — a re-run files a new check and the edge still names
 * the old one.
 *
 * The one exemption is the self-referential loop: a check may depend on the very subject it checks
 * (or on a sibling check of it) without waiting for its own conclusion, which is the deadlock the
 * `dependentVerifiesTaskId` argument exists to break.
 *
 * Anchoring on the subject rather than on the edge is deliberate, and it is what keeps the rule
 * from being a wedge in either direction:
 *
 *  - A newer check — filed, running, or concluded FAIL — CLOSES the epoch, so an older PASS stops
 *    releasing anything the moment somebody re-opens the question. That is the "old PASS, new
 *    verification" case, and reading the edge's own verifier would miss it entirely.
 *  - An older FAIL does NOT hold the epoch shut once a newer check passes. That is the ordinary
 *    fix-and-re-run, and it is the same statement §13.2's PASS already makes when it resolves every
 *    unresolved condition about the subject — not only the ones its own verifier raised.
 *
 * ## The four facts beyond the verdict value
 *
 * `verdict = 'PASS'` alone is not enough, and each of the others closes a window somebody
 * downstream could otherwise start work in:
 *
 *  1. **The check's run has settled naturally.** `SUCCEEDED` with `end_reason = 'task_done'` and a
 *     lifecycle of COMPLETED (§4.2). Not a turn count — V5's lesson, from one table over: turns are
 *     written when a turn ENDS while the task is marked DONE from inside it, so "0 turns" reads as
 *     "never ran" on exactly the runs that did. And not a bare `SUCCEEDED` either: a session a
 *     person ended with `complete`/`cancel` carries a different `end_reason`, and this project's
 *     own instructions forbid treating that as a task finishing.
 *  2. **No live run on the check.** A verdict written mid-turn is a conclusion the turn can still
 *     revise.
 *  3. **`APPLY_VERIFICATION_VERDICT` is APPLIED.** §13.2's consequences — the revert, the defect,
 *     the conditions — are what make a verdict *mean* something, and until the ledger says APPLIED
 *     none of them have happened. Releasing downstream before then is a race with the coordinator's
 *     own reconcile: the two would be acting on the same conclusion at the same instant, one
 *     starting work and the other reverting the subject under it.
 *  4. **The subject is DONE right now.** A FAIL reverts it (V4), and a person can reopen it. Either
 *     way, what the check passed is no longer what is there.
 *
 * Every one of these is read from a CURRENT authoritative row, never from an event. That is what
 * makes out-of-order `task.updated` / `session.ended` delivery and a service restart uninteresting
 * here: this predicate has no memory to get ahead of itself with. A duplicate `verdictRevision` is
 * excluded one layer down — the ledger key is `(verifier, revision)`, so the second delivery of one
 * conclusion collides rather than applying twice.
 *
 * ## Two spellings, one rule
 *
 * The pure function is what the Coordinator's pass, `dependencyState`, Run Now and the batch path
 * read; `verificationEpochOpenSql` is what the three legacy sweeps and §9.2's commit-point adapter
 * read. They have to agree or a task is ready to one and blocked to the other — the same hazard
 * `dependenciesSatisfiedSql` names about SU9, one clause further along. `verification-epoch.pg.spec`
 * runs both over the same rows.
 */

import { RunStatus } from '@orbit/shared';
import { TASK_OCCUPYING } from './reclaim-stalled-task';
import { taskNotRetiredSql } from './task-supersession';
import { verificationLiveness } from './verification-liveness';

/**
 * The one `end_reason` that means "the worker finished the task", as opposed to a person filing or
 * stopping the session. §7.5's hard constraint in this project's own instructions is written on
 * this value: a check whose session was `complete`d out from under it did not conclude.
 */
export const VERIFICATION_RUN_END_REASON = 'task_done';

/** Why a dependency on a check is not satisfied. Diagnostic AND wire: see `computeDependencyState`. */
export type VerificationEpochGate =
  /** Every check of this subject was cancelled or replaced, so nothing is going to conclude. */
  | 'NO_LIVE_VERIFICATION'
  /** The newest check has not finished — not DONE, or still holding a run. */
  | 'VERIFICATION_IN_FLIGHT'
  /** The newest check finished DONE and recorded nothing. Nobody concluded anything. */
  | 'VERDICT_ABSENT'
  | 'VERIFICATION_FAILED'
  | 'VERIFICATION_INCONCLUSIVE'
  /** A verdict written before migration 0124: no revision, therefore no action identity (V7). */
  | 'VERDICT_UNREVISIONED'
  /** The run did not end as a natural `task_done` success. */
  | 'RUN_NOT_SETTLED'
  /** The conclusion has not been made durable by `APPLY_VERIFICATION_VERDICT` yet. */
  | 'VERDICT_NOT_APPLIED'
  /** The check passed, but the subject is not DONE now — reverted by a FAIL, or reopened. */
  | 'SUBJECT_NOT_DONE';

/**
 * The gates that mean a PERSON has to do something, as opposed to "wait".
 *
 * Read by `computeDependencyState` to choose between `BLOCKED` and `BLOCKED_FAILED`, which is the
 * same split `CANCELLED`/`FAILED` prerequisites already get. A conclusion that says no, and a
 * subject whose every check was cancelled, are both terminal until somebody acts; everything else
 * resolves on its own as the check runs and the coordinator applies it.
 */
export const VERIFICATION_EPOCH_GATES_NEEDING_A_HUMAN: ReadonlySet<VerificationEpochGate> = new Set([
  'VERIFICATION_FAILED',
  'VERIFICATION_INCONCLUSIVE',
  'NO_LIVE_VERIFICATION',
]);

/** One run of a check, by its own terminal facts. */
export interface VerificationRunFact {
  runStatus: string;
  endReason: string | null;
  deletedAt: unknown;
  /** `completed_at ?? archived_at`: non-null is §4.2's COMPLETED lifecycle. */
  completionAt: unknown;
}

/** One check of a subject, as this predicate reads it. */
export interface VerificationEpochCheckFact {
  id: string;
  status: string;
  verdict: string | null;
  /** Decimal string, as BigInt columns cross every snapshot boundary here. */
  verdictRevision: string;
  /** §13.6 SU1: retired checks are not part of the epoch at all. */
  retired: boolean;
  /**
   * `APPLY_VERIFICATION_VERDICT` for exactly `(this check, this revision)` is APPLIED.
   *
   * `null` — not `false` — when the check is outside a Project: there is no ledger to have applied
   * it, so demanding one would block every downstream task of every check filed outside a Project
   * for good. The verdict column and the settled run are the durable facts those rows have.
   */
  verdictApplied: boolean | null;
  /**
   * `[K5]` criterion 7: the apply was tried to its bound and refused every time.
   *
   * Separate from `verdictApplied: false`, and that separation is the whole point. "Not applied
   * yet" is a wait — the next pass will do it. "Not applied, and the retries are spent" is a stall
   * that has already been escalated to a person, and reading the two as one sentence is how a
   * project sits stopped with every liveness check green.
   *
   * OPTIONAL, and absent reads as false: a caller that does not look at the ledger's refusals is
   * not entitled to claim a stall, and inventing one would tell somebody to go and fix a pass that
   * is about to succeed.
   */
  verdictApplyExhausted?: boolean;
  runs: readonly VerificationRunFact[];
}

/** The subject an epoch belongs to. */
export interface VerificationEpochSubjectFact {
  id: string;
  status: string;
}

/** A check counts toward the epoch unless it was retired or cancelled (§13.2 V8-d, same rule). */
export function verificationCountsTowardEpoch(check: VerificationEpochCheckFact): boolean {
  return !check.retired && check.status !== 'CANCELLED';
}

/**
 * Has this check's own run stopped, and did it stop by finishing the task?
 *
 * Both halves, because they fail differently: a live run means "not yet", and a run that ended any
 * other way means the conclusion has no execution behind it. A check with no run at all has not
 * run — `VERIFICATION_REQUIRED` and §13.1 AG7 are where that gets said out loud; here it is simply
 * not a pass.
 */
export function verificationRunSettled(check: VerificationEpochCheckFact): boolean {
  const live = check.runs.some((run) => TASK_OCCUPYING.includes(run.runStatus as RunStatus));
  if (live) return false;
  return check.runs.some((run) => run.deletedAt == null
    && run.runStatus === RunStatus.SUCCEEDED
    && run.endReason === VERIFICATION_RUN_END_REASON
    && run.completionAt != null);
}

/**
 * The check the epoch is decided ON: the newest one that still counts toward it, or null.
 *
 * Byte order over the id. Orbit's task ids decode to UUIDv7, so the last one is the most recently
 * filed — the same total order §7.8's pass and §10.4 W5-2a already rank by, and the same one
 * `ORDER BY id DESC LIMIT 1` gives the SQL spelling over `uuid`.
 *
 * Exported because `[K5]`'s liveness rule has to answer about the SAME row the gate answered about;
 * picking the newest check a second time, by a second spelling, is how two faces come to describe
 * two different worlds.
 */
export function newestLiveCheck(
  checks: readonly VerificationEpochCheckFact[],
): VerificationEpochCheckFact | null {
  const live = checks.filter(verificationCountsTowardEpoch)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return live.at(-1) ?? null;
}

/**
 * Is `subject`'s PASS epoch open — and if not, which clause said no?
 *
 * `checks` is every task whose `verifiesTaskId` names this subject, live or not; the filtering is
 * done here so both callers cannot disagree about which ones count.
 *
 * Ordered most-actionable first. The newest check decides, so its own answer comes before the
 * subject's: when a check has just concluded FAIL, "the check failed" is what somebody can act on
 * and "the subject is not DONE" is only its consequence.
 */
export function verificationEpochGate(
  subject: VerificationEpochSubjectFact,
  checks: readonly VerificationEpochCheckFact[],
): VerificationEpochGate | null {
  const newest = newestLiveCheck(checks);
  if (!newest) return 'NO_LIVE_VERIFICATION';
  if (newest.status !== 'DONE') return 'VERIFICATION_IN_FLIGHT';
  if (!newest.verdict) return 'VERDICT_ABSENT';
  if (newest.verdict === 'FAIL') return 'VERIFICATION_FAILED';
  if (newest.verdict !== 'PASS') return 'VERIFICATION_INCONCLUSIVE';
  if (!(BigInt(newest.verdictRevision) > 0n)) return 'VERDICT_UNREVISIONED';
  if (!verificationRunSettled(newest)) return 'RUN_NOT_SETTLED';
  if (newest.verdictApplied === false) return 'VERDICT_NOT_APPLIED';
  if (subject.status !== 'DONE') return 'SUBJECT_NOT_DONE';
  return null;
}

/**
 * The same rule in SQL, correlated to a PREREQUISITE alias that may be a subject or a check.
 *
 * The epoch subject is `COALESCE(pre.verifies_task_id, pre.id)` — a check resolves to what it
 * checks, and anything else stands for itself. A prerequisite whose subject has no verification row
 * at all is TRUE by the first disjunct, so this fragment can be `AND`ed onto any existing DONE test
 * without a second branch at the call site, and it changes nothing for a project that files no
 * checks.
 *
 * `dependent` is the alias of the task WAITING, and it is what breaks the self-referential
 * deadlock: a check that depends on the subject it checks — or on a sibling check of it — would
 * otherwise be waiting on its own conclusion, for ever. Omit it only where there is no dependent to
 * name (a fragment-level probe); every dependency gate passes one.
 *
 * The newest live check is picked with `ORDER BY id DESC LIMIT 1` rather than as a NOT EXISTS
 * "there is a passing one with nothing newer", so that this and `verificationEpochGate` select the
 * SAME row. The two agree on every world except the empty one, and disagreeing there is how a
 * subject with no checks would quietly read as passed. (`max(uuid)` does not exist in PostgreSQL;
 * the ordering is the load-bearing part either way.)
 *
 * **Every check is scoped to its subject's owner AND project** (unit L3, scope contract §3 SC6).
 * `assertVerificationEligible` already refuses to CREATE a check across either line, but a service
 * rule is not a database boundary: a row that arrived by raw SQL, by a repair script or by a binary
 * that never heard of the rule is read by this fragment exactly like a legitimate one. Unscoped,
 * `epoch_newest` picks by `id DESC` across every owner, so a forged check in another owner's
 * project — DONE, PASS, revision > 0, its own run settled, its own ledger APPLIED — becomes THE
 * newest check of somebody else's subject and opens their epoch. The same hole runs the other way
 * through `epoch_any`: one forged row makes a subject look verified-by-something and holds its
 * dependents for ever. Both are closed by refusing to let a check answer for a subject it does not
 * share an owner and a project with.
 *
 * `IS NOT DISTINCT FROM` on the project, never `=`: a subject and its check outside any project are
 * both NULL, which is the ordinary non-project verification path, and `=` would read that as "not
 * the same project" and hold every one of them.
 */
export function verificationEpochOpenSql(alias = 't', dependent?: string): string {
  const occupying = TASK_OCCUPYING.map((status) => `'${status}'`).join(', ');
  const subject = `COALESCE(${alias}."verifies_task_id", ${alias}."id")`;
  /** §3 SC6: a check only answers for a subject it shares an owner and a project with. */
  const sameScope = (check: string, subjectAlias: string) =>
    `${check}."owner_id" = ${subjectAlias}."owner_id"
         AND ${check}."project_id" IS NOT DISTINCT FROM ${subjectAlias}."project_id"`;
  // `IS NOT DISTINCT FROM`, never `=`. An ordinary dependent has a NULL `verifies_task_id`, and a
  // bare `=` would make this disjunct NULL rather than FALSE — which propagates out of the whole
  // fragment and, in an aggregate that is not inside a WHERE, fails OPEN. `subject` is COALESCEd
  // over a NOT NULL id, so it is never itself NULL and the comparison stays honest.
  const selfReferential = dependent
    ? `
    OR ${dependent}."verifies_task_id" IS NOT DISTINCT FROM ${subject}`
    : '';
  return `(NOT EXISTS (
      -- No check names this subject, so there is no epoch and DONE is the whole answer. The
      -- ordinary case, and the one that keeps this fragment inert for most of a project.
      --
      -- Joined to the subject row so the scope test has something to compare against: a check
      -- belonging to another owner or another project is not this subject's check, and must not be
      -- able to invent an epoch that holds this subject's dependents for ever.
      SELECT 1 FROM "task" epoch_any
        JOIN "task" epoch_any_subject ON epoch_any_subject."id" = ${subject}
       WHERE epoch_any."verifies_task_id" = ${subject}
         AND ${sameScope('epoch_any', 'epoch_any_subject')}
    )${selfReferential}
    OR EXISTS (
      -- The same exemption verificationEpochGates makes: work that was REPLACED takes its checks
      -- with it into history, so DEP steps aside and the row is judged by its status alone. A
      -- DISJUNCT, not a filter: "the subject was retired" has to make this fragment TRUE (step
      -- aside) rather than FALSE (hold for ever, with nobody left who could lift it).
      SELECT 1 FROM "task" epoch_retired
       WHERE epoch_retired."id" = ${subject}
         AND NOT ${taskNotRetiredSql('epoch_retired')}
    )
    OR EXISTS (
      SELECT 1 FROM "task" epoch_subject
       WHERE epoch_subject."id" = ${subject}
         AND epoch_subject."status" = 'DONE'
         AND EXISTS (
           SELECT 1 FROM "task" epoch_check
            WHERE epoch_check."id" = (
                    SELECT epoch_newest."id" FROM "task" epoch_newest
                     WHERE epoch_newest."verifies_task_id" = epoch_subject."id"
                       -- Before the ordering, not after it: an out-of-scope row must not be able to
                       -- BE the newest check and then be discarded, because a discarded winner is
                       -- an epoch with no check at all rather than the epoch its real check states.
                       AND ${sameScope('epoch_newest', 'epoch_subject')}
                       AND epoch_newest."status" <> 'CANCELLED'
                       AND ${taskNotRetiredSql('epoch_newest')}
                     ORDER BY epoch_newest."id" DESC LIMIT 1
                  )
              AND epoch_check."status" = 'DONE'
              AND epoch_check."verdict" = 'PASS'
              AND epoch_check."verdict_revision" > 0
              AND NOT EXISTS (
                    SELECT 1 FROM "session" epoch_live
                     WHERE epoch_live."task_id" = epoch_check."id"
                       AND epoch_live."deleted_at" IS NULL
                       AND epoch_live."status"::text IN (${occupying})
                  )
              AND EXISTS (
                    SELECT 1 FROM "session" epoch_run
                     WHERE epoch_run."task_id" = epoch_check."id"
                       AND epoch_run."deleted_at" IS NULL
                       AND epoch_run."status"::text = '${RunStatus.SUCCEEDED}'
                       AND epoch_run."end_reason" = '${VERIFICATION_RUN_END_REASON}'
                       AND (epoch_run."completed_at" IS NOT NULL
                            OR epoch_run."archived_at" IS NOT NULL)
                  )
              AND (epoch_check."project_id" IS NULL OR EXISTS (
                    SELECT 1 FROM "project_action" epoch_action
                     WHERE epoch_action."project_id" = epoch_check."project_id"
                       AND epoch_action."type"::text = 'APPLY_VERIFICATION_VERDICT'
                       AND epoch_action."status"::text = 'APPLIED'
                       AND epoch_action."subject_id" = epoch_check."id"
                       AND epoch_action."idempotency_key"
                           = ${verificationVerdictActionKeySqlExpr('epoch_check')}
                  ))
         )
    ))`;
}

/**
 * §8.2's permanent key for one conclusion's consequences, as one template in two languages.
 *
 * `projects/task-verification-verdict.ts` builds it for the writer; this builds the identical
 * string in SQL for the reader that has to ask "did that actually get applied". Internal UUIDs
 * throughout, because that is what the ledger's unique index is declared on — `uuid::text` is the
 * canonical lowercase hyphenated form, which is exactly how the writer spells it.
 */
export function verificationVerdictActionKeyOf(
  projectId: string,
  verifierTaskId: string,
  verdictRevision: string | bigint | number,
): string {
  return `pc:v1:${projectId}:verdict:${verifierTaskId}:${verdictRevision}`;
}

function verificationVerdictActionKeySqlExpr(alias: string): string {
  return `'pc:v1:' || ${alias}."project_id"::text || ':verdict:' || ${alias}."id"::text `
    + `|| ':' || ${alias}."verdict_revision"::text`;
}

/** One task row as the batch gate builder reads it — a check, a subject, or neither. */
export interface VerificationEpochTaskRow {
  id: string;
  status: string;
  verifiesTaskId: string | null;
  verdict: string | null;
  verdictRevision: string;
  /** See `VerificationEpochCheckFact.verdictApplied`; `null` for a check outside a Project. */
  verdictApplied: boolean | null;
  /** See `VerificationEpochCheckFact.verdictApplyExhausted`. Absent reads as false. */
  verdictApplyExhausted?: boolean;
  /** §13.6 SU1: `taskRetirement(row) != null`. */
  retired: boolean;
}

/** One task's place in an epoch: whose epoch it is, and what that epoch currently says. */
export interface VerificationEpochEntry {
  /** The SUBJECT the epoch belongs to — this row itself, or the subject it checks. */
  subjectTaskId: string;
  /** `null` when the epoch is open. */
  gate: VerificationEpochGate | null;
  /**
   * `[K5]`: true when nothing in motion will open this epoch — see `verificationLiveness`.
   *
   * Carried on the entry rather than re-derived by each reader because the answer depends on the
   * check's RUNS, which the readers do not have. False for an open epoch and for every ordinary
   * wait, so a caller that ignores it behaves exactly as it did before this field existed.
   *
   * OPTIONAL, and absent reads as false: an entry built by an older reader — or by a test that only
   * cares about the gate — asserts nothing about liveness, and inventing `true` for it would
   * escalate an ordinary wait into "somebody has to act" on no evidence.
   */
  stalled?: boolean;
}

/**
 * Every task in `tasks` that HAS an epoch, mapped to whose epoch it is and what it says.
 *
 * Keyed by the SUBJECT and by each of its checks, with the same answer for all of them, because
 * both spellings of the edge are about the same question. The subject entry is the one that
 * matters: `dependsOn: A` is what callers write, and once A has a check, A being DONE is no longer
 * the whole of "A is done".
 *
 * A subject with NO verification row at all gets no entry, and absent means "judge this row by its
 * status alone" — the pre-DEP behaviour, and the ordinary case for most of a project.
 *
 * A CANCELLED or superseded check gets an entry too. That cannot double-veto §13.6 SU9's chain:
 * `dependencySatisfied` only consults a gate on a row it has already found to be `DONE`, and SU4
 * forbids a DONE row from naming a successor — so a gate on a retired attempt is never the thing
 * deciding, while its presence gives a reader the reason instead of a bare status.
 *
 * One shape is deliberately absent: a subject that was RETIRED, and its checks with it. The finding
 * is history the moment the work it was about moved on (the same rule
 * `verificationFailureIsHistorySql` applies to the condition rows), so holding downstream on it
 * would be a wedge with nobody to lift it.
 *
 * A check whose subject is not in `tasks` at all fails CLOSED to `SUBJECT_NOT_DONE`: a scope this
 * read cannot see is not evidence that a subject is finished.
 */
export function verificationEpochGates(
  tasks: readonly VerificationEpochTaskRow[],
  runsByTaskId: ReadonlyMap<string, readonly VerificationRunFact[]>,
): Map<string, VerificationEpochEntry> {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const checksBySubject = new Map<string, VerificationEpochCheckFact[]>();
  for (const task of tasks) {
    if (!task.verifiesTaskId) continue;
    const fact: VerificationEpochCheckFact = {
      id: task.id,
      status: task.status,
      verdict: task.verdict,
      verdictRevision: task.verdictRevision,
      retired: task.retired,
      verdictApplied: task.verdictApplied,
      verdictApplyExhausted: task.verdictApplyExhausted === true,
      runs: runsByTaskId.get(task.id) ?? [],
    };
    const list = checksBySubject.get(task.verifiesTaskId);
    if (list) list.push(fact);
    else checksBySubject.set(task.verifiesTaskId, [fact]);
  }

  const epochs = new Map<string, VerificationEpochEntry>();
  for (const [subjectTaskId, checks] of checksBySubject) {
    const subject = byId.get(subjectTaskId);
    if (subject?.retired) continue;
    const gate = subject
      ? verificationEpochGate({ id: subject.id, status: subject.status }, checks)
      : 'SUBJECT_NOT_DONE';
    // `[K5]`: asked about the row the gate was decided on, and asked once for the whole epoch —
    // the subject entry and every check entry carry the same gate, so they carry the same answer
    // about whether anything will move it.
    const stalled = verificationLiveness(gate, newestLiveCheck(checks)).state === 'STALLED';
    if (subject) epochs.set(subjectTaskId, { subjectTaskId, gate, stalled });
    for (const check of checks) epochs.set(check.id, { subjectTaskId, gate, stalled });
  }
  return epochs;
}
