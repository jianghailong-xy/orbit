/**
 * T3 on real PostgreSQL: "is this criterion satisfied?", derived from the work side, with the
 * reason it is not.
 *
 * One positive and three negatives, one negative per clause, and every one of the four asserts the
 * derived answer AND what the derivation says about it — a boolean nobody can act on is the thing
 * this unit exists to avoid. The three negatives were run first against a `criterionSatisfaction`
 * whose body returned `satisfied: true, unmet: []` for every criterion; all three were red, and
 * that output is in the task's comments. The stub replaced the derivation function itself rather
 * than a caller of it, because a negative that a double could satisfy is not a negative.
 *
 * Why this is a `.pg.spec`. Every fact the derivation folds is produced here the way the product
 * produces it: criteria are written and edited through `ProjectsService.update` (the owner's own
 * path, and the only thing that increments a criterion's revision), work is filed through
 * `TasksService.create` (which is what resolves `criterionKey` into 0232's two columns), verdicts
 * are recorded through `TasksService.update`, and the two settled-by-EXECUTABLE rows are written
 * by the same compare-and-set `runnerApi.turnComplete` performs, through 0193/0230's DONE fence.
 * A fixture that INSERTed the answers would prove this file can read what it just wrote.
 *
 *   PATH=/opt/node26/bin:$PATH \
 *   OUTCOME_RELEASE_API_SPEC_REGEX='project-criterion-satisfaction\.pg\.spec\.js$' \
 *   OUTCOME_RELEASE_API_JOBS=1 bash scripts/outcome-reconciler-full-api.sh
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { CreatorType, type PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { deriveTaskCompletionStatus } from '../tasks/task-completion-criterion';
import { TaskCompletionEvidenceService } from '../tasks/task-completion-evidence.service';
import { TasksService } from '../tasks/tasks.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { criteriaFromDefinitions } from './project-acceptance';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { readCriterionDeclarations } from './project-criterion-declaration-staleness';
import {
  type CriterionSatisfaction,
  readCriterionSatisfaction,
} from './project-criterion-satisfaction';
import { ProjectsService } from './projects.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** The verification method every criterion here declares; never the thing under test. */
/**
 * The verification method every criterion here declares; never the thing under test.
 *
 * A rung of the HUMAN → VERIFICATION → EXECUTABLE ladder, with `STRICTER` the next rung up, and
 * that is what makes the one edit below an edit that TAKES EFFECT: a criteria edit lands only when
 * it walks the ruler toward strictness, and a rewritten `text` is a direction nothing can read, so
 * it is held for the account owner instead (`criteria-weakening-intent.pg.spec.ts`).
 */
const METHOD = 'VERIFICATION';
/** The rung the moved criterion is promoted TO — a stricter exam for the same assertion. */
const STRICTER = 'EXECUTABLE';
/** The four columns on the CRITERION that T4 removed, spelled as the database spells them. */
const WIRING_COLUMNS = [
  'evidence_task_id',
  'completion_criterion',
  'acceptance_command',
  'acceptance_expected_exit_code',
] as const;
/**
 * What a criterion still stores besides its identity, and what this derivation must not read.
 *
 * The four above are gone (migration 0233), so dropping them is no longer a statement anybody can
 * make; `evaluation_plan_hash` joined them in 0234 and left this list for the same reason. These
 * are the successor: everything a criterion carries today that is not `id`, `ordinal` or
 * `revision`. A derivation that named one of them could not survive the rolled-back DROP below.
 */
const NON_IDENTITY_COLUMNS = [
  'text',
  'verification_method',
  'completion_criterion_override_reason',
  'content_hash',
  'semantic_hash',
] as const;
/** build/projects -> build -> apiserver -> src -> repository root. */
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const MODULE = 'src/apiserver/src/projects/project-criterion-satisfaction.ts';
const SPEC = 'src/apiserver/src/projects/project-criterion-satisfaction.pg.spec.ts';
/**
 * The other readers, named one at a time. None is admitted by a pattern: the list being exact is
 * what makes a new consumer something somebody has to come and write down, and on 2026-09-04 two
 * of them arrived at once from tasks that never touched each other's files.
 *
 * `UpdateTaskDto.criterionKey` exists to put clause 3 out, so its spec reads clause 3 back through
 * this derivation rather than re-implementing the comparison and proving only that it can subtract
 * two numbers.
 *
 * The pending-decision queue's own spec cross-checks the rows it puts in front of a decider against
 * the work THIS derivation names as still outstanding — two answers computed from different
 * columns, asserted to agree. It calls `readCriterionSatisfaction` to do it, which makes it a
 * consumer this census has to see, and a test rather than a gate: it reads the answer and writes
 * nothing on the strength of it.
 */
const REDECLARATION_SPEC = 'src/apiserver/src/tasks/task-criterion-redeclaration.pg.spec.ts';
const PENDING_JUDGMENTS_SPEC = 'src/apiserver/src/tasks/pending-evidence-judgments.pg.spec.ts';
/**
 * The wake `CRITERION_READY` is, asserted against what this derivation says about the same
 * criterion.
 *
 * `CriterionReadyProducer` does NOT read this module — it derives its fact from the serving set
 * directly, the way `readCriterionSatisfaction` itself does, and `coordinator-wake.ts` owns the
 * predicate. Its spec reads the answer here for one thing only: to show that the criterion it
 * declines to wake on is the one this derivation reports as `NO_WORK_SERVES_IT`, rather than an
 * emptiness the producer defined for itself. A read, and nothing is written on the strength of it.
 */
const CRITERION_READY_SPEC = 'src/apiserver/src/tasks/task-criterion-ready-delivery.pg.spec.ts';
/**
 * The one reader that is not a test, and the spec that holds it to being a read.
 *
 * `ProjectsService.get` serves the answer beside the criterion it is about, so a person or a
 * coordinator looking at a project can see WHICH clause is missing and WHICH task is holding it
 * up. That is the visibility this derivation was written for, and it is the whole of what the
 * service does with it: the answer is projected onto `acceptanceCriteriaItems` and returned. It
 * reaches no `WHERE`, no compare-and-set and no refusal — in particular not `project.status =
 * 'DONE'`, which 0223 and 0229 left unguarded on purpose and which is not re-guarded by a read
 * being able to see what a guard would have looked at.
 *
 * So this case says what it always said, only it can no longer say it by there being nobody: the
 * readers are exactly these, each is named with its reason, and none of them is a gate.
 */
const SERVICE = 'src/apiserver/src/projects/projects.service.ts';
const SERVICE_SPEC = 'src/apiserver/src/projects/project-get-criterion-satisfaction.pg.spec.ts';
/**
 * The second reader that is not a test, and the one that made half the sentence below stop being
 * true.
 *
 * WHAT IT DOES WITH THE ANSWER. `readDerivedProjectDone` folds `satisfied` into a conjunction —
 * every stated criterion satisfied AND `landing === 'LANDED'` AND written by somebody other than
 * the session producing its evidence, plus one confirmation naming the version of the criteria
 * that stands today — and `storeDerivedProjectStatus` writes what that
 * conjunction projects into `project.status`, in both directions between OPEN and DONE, on the two
 * edges that have no requester (after the owner's confirmation, and the post-commit edge of a task
 * write). So this answer does now reach a status write, which is the half of the assertion below
 * that had to be rewritten rather than kept and made to pass.
 *
 * AND ONE READ IT HANDS ON. `readDerivedProjectDoneReading` returns the satisfaction rows beside
 * the projection it folded from them (`readDerivedProjectDone` keeps only the projection), and the
 * one caller that takes the rows is the coordinator's `PROJECT_ACCEPTANCE_LANDED` message
 * (`coordinator-delivery.service.ts`, rendered by `buildCoordinatorDeliveryMessage`): when a
 * confirmed project is still held back, the message quotes each held criterion's `unmet` clauses
 * as words. Neither file imports this module, which is why neither is in the census; what they do
 * with the answer is display, the same as `ProjectsService.get` — nothing is written or refused on
 * the strength of it.
 *
 * WHY IT IS STILL NOT A GATE, AND WHY THAT IS CHECKED RATHER THAN SAID. A gate refuses somebody's
 * write; this refuses nobody. Everything that could set `status` before can still set it, and the
 * one rule that turns any of them away is `refuseProjectStatusWrite`, which is about who is asking
 * and predates it. That distinction is the whole load-bearing claim of the file, so the case below
 * reads it out of the projection's source: a refusal added there later would leave every sentence
 * here intact while making them false.
 *
 * WHOSE DECISION THAT WAS. 0229 removed the DONE gate on the owner's decision of 2026-09-03, and
 * `MODULE`'s own header forbids reinstating an equivalent protection under another name; a design
 * review then barred the deriver outright. None of that was overruled by whoever wrote 36e62c76:
 * that review barred it ON ITS OWN AUTHORITY and named re-deliberation with the owner as the way
 * through, and on 2026-09-08 the owner was asked with 0229's sentence quoted back and answered
 * that it should be built (`docs/project-done-gate.md`, `docs/human-only-authority.md` §"What is
 * true today about project DONE"). A census entry is not where that is settled — it is where a
 * reader of this derivation can find that it was.
 */
const DONE_PROJECTION = 'src/apiserver/src/projects/project-done-derived.ts';
/**
 * The third reader that is not a test: a shared project's public page, and a second read endpoint.
 *
 * `readPublicProject` draws a project link's Acceptance criteria block for a visitor
 * (docs/share-links-design.md §7), and that block is all it reads the answer for: each stated
 * criterion's `satisfied`, and the tasks its `unmet` reasons name, copied field by field into the
 * public projection and returned. It is `ProjectsService.get`'s answer shown to somebody else, not
 * a second opinion — `share-links/public-project.pg.spec.ts` asserts the two agree criterion by
 * criterion, reading the owner's side through `GET /projects/:id` rather than importing this
 * module, which is why that spec is not named here. A read-only projection and not a gate: nothing
 * is written on the strength of the answer, and the one thing `readPublicProject` refuses — the 404
 * of a link whose project is gone — is decided before the answer is read.
 */
const PUBLIC_PROJECT = 'src/apiserver/src/share-links/public-project.ts';
/**
 * The fourth reader that is not a test, and the first that refuses a write on the strength of the
 * answer — so the other half of the sentence below had to be rewritten too, not kept and made to
 * pass.
 *
 * WHAT IT DOES WITH THE ANSWER. `readDoneState` reads each stated criterion's `satisfied`, and the
 * work its `unmet` reasons hold up, into what a coordinator's request to have its project recorded
 * done is checked against. `doneReadiness` turns every criterion not satisfied into a REFUSE finding
 * (`DONE_CRITERION_UNSATISFIED`), and `ProjectOpenItemService.requestDone` — the coordinator's
 * `project_request_done` — answers any REFUSE with 409 `DONE_REQUEST_NOT_READY` and files nothing.
 * `doneStateDigest` also folds `satisfied` into the digest a filed request carries, so a request the
 * answer has moved under is superseded on the next read (`supersedeStaleDoneRequest`) and the
 * owner's press that answers it is a 409 (`doneRequestMoved`): it asks about a project that is no
 * longer there.
 *
 * WHOSE DECISION THAT WAS. `MODULE`'s header leaves whether an unsatisfied criterion should block
 * anything to the owner, and for this one door the owner answered: on 2026-10-01 they decided (D2
 * of the project-closing redesign, project 34Y7My8sqhKLWtmCQYv1l, and its criterion 2) that the
 * coordinator asks for a project to be closed, behind a check that refuses while a criterion is not
 * met — `project-done-request.pg.spec.ts` holds that refusal. What it stands between is the
 * coordinator and the owner's card, not the owner and the record: `recordProjectDone` records the
 * findings as accepted gaps when no request is being answered, so the owner can still
 * record a project done over a criterion that is not met. The case below holds the refusal to the
 * coordinator's door.
 */
const DONE_REQUEST = 'src/apiserver/src/projects/project-done-request.ts';
/** The coordinator's door, and the only one that turns `doneReadiness`'s REFUSE into a refusal. */
const DONE_REQUEST_DOOR = 'src/apiserver/src/projects/project-open-item.service.ts';

/** Every source file that could wire this derivation into something. */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'build' || entry.name === 'dist'
      || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(full));
    else if (/\.(ts|tsx|js|mjs|cjs|go|sql|swift|kt|prisma|json|sh|md)$/u.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

/**
 * What makes one of those files a READER: a module specifier that resolves to `MODULE`.
 *
 * Membership used to be "the file's text contains `project-criterion-satisfaction`", and on
 * 2026-09-17 that turned main red for two files that read nothing. The background-jobs
 * conversation fixtures — `src/web/src/lib/backgroundJobs.fixtures.ts` and its macOS twin — quote
 * a real `bg_run` command line verbatim, and that command line names this spec's own path. Quoted
 * transcript is what those fixtures are FOR, so the census is the side that had to move: a name
 * occurring inside a chat log is not a consumer of anything, and neither is this comment.
 *
 * Matching the module's exported SYMBOLS instead would have been looser, not stricter, in the
 * same direction: `coordinator-wake.ts`, `criteria-settlement-seal.pg.spec.ts` and
 * `tasks.service.ts` all name `readCriterionSatisfaction` in prose while importing nothing, and
 * `ProjectAcceptanceCard.tsx` declares its own `CriterionUnmetReason` for the wire. All four would
 * have arrived here as readers they are not.
 *
 * What this does NOT relax is the reason the census exists. An import is caught whatever the
 * importer then does with the answer, so a new consumer still cannot arrive without somebody
 * coming here to write down what it does — held to that by the control in the task's comments: a
 * temporary file carrying that same command line leaves this case green, and one line of `import`
 * in the same file turns it red.
 */
const IMPORTS_MODULE =
  /\b(?:from|import|require)\s*\(?\s*['"][^'"\n]*project-criterion-satisfaction(?:\.[cm]?[jt]s)?['"]/u;

test('T3: a criterion is satisfied by three clauses, and says which one is missing', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma: PrismaClient = prismaClientFor(url);
  t.after(async () => {
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  const projects = new ProjectsService(prisma as unknown as PrismaService,
    new ProjectAcceptanceService(prisma as unknown as PrismaService));
  const tasks = new TasksService(prisma as never, {} as never, {
    publishTaskChanged() {},
    publishForUser() {},
  } as never);

  const ownerId = randomUUID();
  const projectId = randomUUID();
  await prisma.user.create({
    data: {
      id: ownerId,
      email: `t3-${ownerId}@criterion-satisfaction.invalid`,
      name: 'T3',
      passwordHash: 'x',
    },
  });
  await prisma.project.create({
    data: { id: projectId, ownerId, title: 'T3 subject project' },
  });

  /** State the whole collection through the owner's path, and read the keys back. */
  async function state(items: Array<{ id?: string; text: string; verificationMethod?: string }>) {
    const written = await projects.update(ownerId, projectId, {
      acceptanceCriteriaItems: items.map((item) => ({
        ...(item.id ? { id: item.id } : {}),
        text: item.text,
        verificationMethod: item.verificationMethod ?? METHOD,
      })),
    } as never);
    return criteriaFromDefinitions(written.acceptanceCriteriaItems);
  }

  /**
   * Settle an EXECUTABLE task exactly as `runnerApi.turnComplete` settles one: `status = 'DONE'`
   * as a compare-and-set that repeats the declaration in its WHERE clause, through 0193/0230's
   * BEFORE UPDATE fence. Nothing else is written, because 0230 stores nothing else — the exit code
   * is compared in memory there and dropped, which is precisely why this read has only the status
   * to look at for this criterion.
   */
  async function settleExecutable(taskId: string, command: string, exitCode: number) {
    const written = await sql.query(
      `UPDATE "task" SET "status" = 'DONE'
        WHERE "id" = $1::uuid
          AND "status" IN ('OPEN', 'IN_PROGRESS')
          AND "completion_criterion" = 'EXECUTABLE'
          AND "acceptance_command" = $2
          AND "acceptance_expected_exit_code" = $3`,
      [taskId, command, exitCode],
    );
    assert.equal(written.rowCount, 1, 'the EXECUTABLE task must reach DONE through the DONE fence');
  }

  /** The read under test, narrowed to one criterion. */
  async function satisfactionOf(definitionId: string): Promise<CriterionSatisfaction> {
    const derived = await readCriterionSatisfaction(prisma, ownerId, projectId);
    const row = derived.find((entry) => entry.definitionId === definitionId);
    assert.ok(row, 'the criterion must be in the read that answers for this project’s criteria');
    return row;
  }

  const ALL_MET = 'every clause of this one holds';
  const NOBODY_SERVES = 'nobody has filed any work against this one';
  const ONE_OUTSTANDING = 'two pieces of work serve this one and only one of them has settled';
  const MOVES = 'the wording of this one is about to be corrected';

  const [metAtFirst, unservedAtFirst, partialAtFirst, movingAtFirst] = await state([
    { text: ALL_MET }, { text: NOBODY_SERVES }, { text: ONE_OUTSTANDING }, { text: MOVES },
  ]);

  // ── the criterion every clause holds for ──────────────────────────────────────────────────────
  // Three serving tasks, one per settlement fact this system actually has: an EXECUTABLE
  // comparison that agreed, a subject settled by an independent PASS, and the check itself, which
  // is work filed against the same criterion and is settled by its own verdict.
  const EXECUTABLE_DECLARATION = { acceptanceCommand: 'true', acceptanceExpectedExitCode: 0 };
  const metExecutable = await tasks.create(ownerId, {
    title: 'the command that returns what it said it would',
    projectId,
    criterionKey: metAtFirst.key,
    completionCriterion: 'EXECUTABLE',
    ...EXECUTABLE_DECLARATION,
  } as never);
  await settleExecutable(metExecutable.id, 'true', 0);
  // Through the batch door, not two creates: the gate and its check go in together, and the check
  // is more than a title here — it serves the same criterion, which only a batch item can say.
  const [metSubject, metVerifier] = await tasks.createMany(ownerId, {
    tasks: [
      {
        title: 'the work an independent check settles',
        ref: 'met-subject',
        projectId,
        criterionKey: metAtFirst.key,
        completionCriterion: 'VERIFICATION',
        completionPolicy: 'VERIFICATION_PASSED',
      },
      {
        title: 'the check itself, which also serves this criterion',
        ref: 'met-check',
        projectId,
        criterionKey: metAtFirst.key,
        verifiesRef: 'met-subject',
      },
    ],
  } as never);
  await tasks.update(ownerId, metVerifier.id, { verdict: 'PASS' } as never);

  // ── the criterion two tasks serve, one of which has not settled ───────────────────────────────
  // The unsettled one is DONE. That is not a trick: its status came from the aggregate policy it
  // also declares — a projection over its children, not the fact it said would settle it — while
  // its own declared criterion, EVIDENCE_JUDGMENT, asks for something nobody has produced yet: an
  // independent CONFIRM of its completion evidence. A derivation that read `status = 'DONE'` would
  // call this criterion met.
  const partialSettled = await tasks.create(ownerId, {
    title: 'the piece of this one that did settle',
    projectId,
    criterionKey: partialAtFirst.key,
    completionCriterion: 'EXECUTABLE',
    ...EXECUTABLE_DECLARATION,
  } as never);
  await settleExecutable(partialSettled.id, 'true', 0);
  const partialOutstanding = await tasks.create(ownerId, {
    title: 'the piece of this one that never settled by its own criterion',
    projectId,
    criterionKey: partialAtFirst.key,
    completionCriterion: 'EVIDENCE_JUDGMENT',
    completionPolicy: 'ALL_CHILDREN_DONE',
  } as never);
  const outstandingChild = await tasks.create(ownerId, {
    title: 'a subtask that serves no criterion of its own',
    projectId,
    parentTaskId: partialOutstanding.id,
    completionCriterion: 'EXECUTABLE',
    ...EXECUTABLE_DECLARATION,
  } as never);
  await settleExecutable(outstandingChild.id, 'true', 0);
  const aggregated = await sql.query(
    `UPDATE "task" SET "status" = 'DONE'
      WHERE "id" = $1::uuid AND "status" <> 'DONE'
        AND "completion_policy" = 'ALL_CHILDREN_DONE'`,
    [partialOutstanding.id],
  );
  assert.equal(aggregated.rowCount, 1,
    'the DONE fence must accept this row: a state the product itself produces, not an invention');

  // ── the criterion whose wording moves under settled work ──────────────────────────────────────
  const movingTask = await tasks.create(ownerId, {
    title: 'work filed, and settled, against a wording that then changed',
    projectId,
    criterionKey: movingAtFirst.key,
    completionCriterion: 'EXECUTABLE',
    ...EXECUTABLE_DECLARATION,
  } as never);
  await settleExecutable(movingTask.id, 'true', 0);
  const [met, unserved, partial, moved] = await state([
    { id: metAtFirst.definitionId, text: ALL_MET },
    { id: unservedAtFirst.definitionId, text: NOBODY_SERVES },
    { id: partialAtFirst.definitionId, text: ONE_OUTSTANDING },
    { id: movingAtFirst.definitionId, text: MOVES, verificationMethod: STRICTER },
  ]);
  assert.equal(moved.definitionId, movingAtFirst.definitionId,
    'the criterion must be the same row: an edit, not a replacement');
  assert.deepEqual(
    [met.definitionRevision, unserved.definitionRevision,
      partial.definitionRevision, moved.definitionRevision],
    [1, 1, 1, 2],
    'exactly one criterion moved, and nothing here wrote a revision by hand');

  // ═══ 1. the positive ══════════════════════════════════════════════════════════════════════════
  await t.test('all three clauses hold: the criterion is satisfied, with nothing missing',
    async () => {
    // Not vacuous: work really was filed against this one, and all of it really is there.
    const [declared] = (await readCriterionDeclarations(prisma, ownerId, projectId))
      .filter((row) => row.definitionId === met.definitionId);
    assert.deepEqual(declared.servingTasks.map((row) => row.taskId).sort(),
      [metExecutable.id, metSubject.id, metVerifier.id].sort());

    const derived = await satisfactionOf(met.definitionId);
    assert.equal(derived.satisfied, true);
    assert.deepEqual(derived.unmet, [],
      'the reason a satisfied criterion gives is that no clause is missing');
    assert.equal(derived.revision, 1);
  });

  // ═══ 2. the negative for clause 1: the empty case is not satisfied vacuously ═══════════════════
  await t.test('no work serves it: unsatisfied, and the reason is that nobody serves it',
    async () => {
    const derived = await satisfactionOf(unserved.definitionId);
    assert.equal(derived.satisfied, false,
      '"every one of zero serving tasks has settled" is true and useless');
    assert.deepEqual(derived.unmet, [{ clause: 'NO_WORK_SERVES_IT', heldUpBy: [] }],
      'the one clause that fails is the first one, and it has nobody to name');
  });

  // ═══ 3. the negative for clause 2: a conjunction, not a disjunction ═══════════════════════════
  await t.test('one of two serving tasks is unsettled: unsatisfied, and it is named', async () => {
    const derived = await satisfactionOf(partial.definitionId);
    assert.equal(derived.satisfied, false,
      'one settled task among two does not make the stated condition true');
    assert.deepEqual(derived.unmet, [{
      clause: 'SERVING_WORK_UNSETTLED',
      heldUpBy: [{
        taskId: partialOutstanding.id,
        title: 'the piece of this one that never settled by its own criterion',
        status: 'DONE',
        completionCriterion: 'EVIDENCE_JUDGMENT',
        requiredAction: 'SUBMIT_EVIDENCE_AND_AWAIT_INDEPENDENT_DECISION',
        criterionRevision: 1,
        criterionRevisionStale: false,
      }],
    }], 'the reason names the task that holds it up and what would settle THAT task');

    // The two halves of "by its own declared criterion, not by a blanket status":
    // the named task IS DONE, and the task that is not named is the one whose criterion settled.
    const [held] = derived.unmet[0].heldUpBy;
    assert.equal(held.status, 'DONE');
    assert.ok(!derived.unmet[0].heldUpBy.some((row) => row.taskId === partialSettled.id),
      'the EXECUTABLE task whose comparison agreed is settled and is not holding anything up');
  });

  // ═══ 3b. the same clause, released by the fact its holder's criterion actually asks for ═══════
  // This is where the third criterion having no implementation was expensive: `servingTaskSettled`
  // asked the shared evaluator, the evaluator could only answer UNSATISFIED, and so every criterion
  // any such task served was unmet forever, whatever the work had done. The facts are produced the
  // way the product produces them — the evidence door, then the decision door — because a fixture
  // that INSERTed a decision would prove this read can read what it just wrote.
  await t.test('an independent CONFIRM settles the EVIDENCE_JUDGMENT task and releases the clause',
    async () => {
    const workerSessionId = randomUUID();
    const decidingSessionId = randomUUID();
    await prisma.session.create({
      // Attached to the task without claiming its work: AG6 refuses a live work session on a
      // roll-up node, so the evidence for one comes from a session that is talking about it rather
      // than running it. Which session it is matters to the door for one reason only — the
      // decision below may not come from this one.
      data: {
        id: workerSessionId,
        ownerId,
        creatorId: ownerId,
        taskId: partialOutstanding.id,
        title: 'the run that produced the evidence',
        prompt: 'do the work',
        startsTaskWork: false,
      },
    });
    await prisma.session.create({
      // No task of its own: the run that judges this work never executed it, which is the whole of
      // what the decision door checks before it accepts an answer.
      data: {
        id: decidingSessionId,
        ownerId,
        creatorId: ownerId,
        title: 'the run that judges it',
        prompt: 'read the ledger and decide',
      },
    });
    await prisma.toolCall.create({
      data: {
        sessionId: workerSessionId,
        name: 'Bash',
        toolUseId: 'toolu_criterion_satisfaction',
        input: { command: 'true', description: 'the work this evidence cites' },
        isError: false,
      },
    });
    const evidence = new TaskCompletionEvidenceService(prisma as unknown as PrismaService);
    const actor = { type: CreatorType.USER, id: ownerId } as const;

    await evidence.submit(ownerId, partialOutstanding.id, actor, {
      sourceSessionId: workerSessionId,
      evidence: {
        claim: 'the piece of work filed against this criterion is done',
        criterion: { key: partial.key, text: ONE_OUTSTANDING },
        checks: [{ kind: 'TOOL_CALL', ref: 'toolu_criterion_satisfaction' }],
        gaps: [],
      },
    });
    // Still held up: a claim nobody has answered is not a judgment, and this clause knows the
    // difference — which is the same distinction the criterion itself is made of.
    assert.equal((await satisfactionOf(partial.definitionId)).satisfied, false,
      'submitted evidence is a claim; the criterion asks for a decision about it');

    await evidence.decide(ownerId, partialOutstanding.id, actor, {
      decidingSessionId,
      evidenceRevision: '1',
      decision: 'CONFIRM',
    });

    const released = await satisfactionOf(partial.definitionId);
    assert.deepEqual(released.unmet, [],
      'nothing holds it up: the work it named settled by the criterion that work declared');
    assert.equal(released.satisfied, true);
  });

  // ═══ 4. the negative for clause 3: a declaration measured against a criterion that moved ══════
  await t.test('a serving task declared a stale revision: unsatisfied, and the reason is stale',
    async () => {
    const derived = await satisfactionOf(moved.definitionId);
    assert.equal(derived.revision, 2);
    assert.equal(derived.satisfied, false,
      'the work settled, and it settled against a wording that has since moved');
    assert.deepEqual(derived.unmet, [{
      clause: 'DECLARATION_STALE',
      heldUpBy: [{
        taskId: movingTask.id,
        title: 'work filed, and settled, against a wording that then changed',
        status: 'DONE',
        completionCriterion: 'EXECUTABLE',
        requiredAction: 'RUN_ACCEPTANCE_COMMAND',
        criterionRevision: 1,
        criterionRevisionStale: true,
      }],
    }], 'clause 3 is the only one missing: the work is settled, it is the declaration that is old');
  });

  // ═══ nothing on the criterion side is on this path ════════════════════════════════════════════
  await t.test('the derivation reads nothing on the criterion but its identity', async () => {
    const before = await readCriterionSatisfaction(prisma, ownerId, projectId);
    assert.ok(before.length === 4 && before.some((row) => !row.satisfied),
      'the comparison below is only worth making over an answer with content in it');

    // T4 landed: the four columns this case used to drop are already gone, so dropping them is no
    // longer a statement — their absence is.
    const { rows: wiring } = await sql.query<{ column_name: string }>(
      `SELECT "column_name" FROM information_schema.columns
        WHERE "table_schema" = 'public'
          AND "table_name" = 'project_acceptance_criterion_definition'
          AND "column_name" = ANY($1::text[])`,
      [[...WIRING_COLUMNS]],
    );
    assert.deepEqual(wiring.map((row) => row.column_name), [],
      'migration 0233 removed the criterion’s wiring towards the work');

    class Rollback extends Error {}
    let survivingColumns: string[] = [];
    let after: CriterionSatisfaction[] = [];
    // The same technique, aimed at what is left, and stronger than reading the source for column
    // names: everything a criterion still carries beyond its identity is actually dropped, the
    // derivation is actually re-run, and the answer is actually the same. A derivation that named
    // any of them could not survive this — the statement would fail, not merely disagree.
    //
    // Inside one transaction that always rolls back, because Postgres DDL is transactional and
    // this case's database outlives this test. CASCADE because several of these are wired into
    // objects of their own — the normalize trigger's column list, the content index — and taking
    // those with them is a side effect the rollback undoes. The cascade cannot reach anything this
    // read needs, which is not an argument but an assertion below: the criterion's identity
    // columns are still there, and the answer is unchanged.
    await assert.rejects(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`ALTER TABLE "project_acceptance_criterion_definition" ${
        NON_IDENTITY_COLUMNS.map((column) => `DROP COLUMN "${column}" CASCADE`).join(', ')}`);
      const remaining = await tx.$queryRawUnsafe<Array<{ column_name: string }>>(
        `SELECT "column_name" FROM information_schema.columns
          WHERE "table_schema" = 'public'
            AND "table_name" = 'project_acceptance_criterion_definition'`);
      survivingColumns = remaining.map((row) => row.column_name).sort();
      after = await readCriterionSatisfaction(tx as unknown as PrismaService, ownerId, projectId);
      throw new Rollback();
    }, { timeout: 120_000, maxWait: 60_000 }), Rollback);

    assert.deepEqual(NON_IDENTITY_COLUMNS.filter((column) => survivingColumns.includes(column)), [],
      'all of them had to be gone for the re-derivation to have proved anything');
    for (const kept of ['id', 'ordinal', 'revision']) {
      assert.ok(survivingColumns.includes(kept),
        `the cascade must not have taken ${kept}, which is what the derivation reads`);
    }
    assert.deepEqual(after, before,
      'the same answer, derived from a criterion table stripped to its identity');

    // And the case's database is intact, so the rollback is a fact rather than an intention.
    const { rows } = await sql.query<{ column_name: string }>(
      `SELECT "column_name" FROM information_schema.columns
        WHERE "table_schema" = 'public'
          AND "table_name" = 'project_acceptance_criterion_definition'
          AND "column_name" = ANY($1::text[]) ORDER BY "column_name"`,
      [[...NON_IDENTITY_COLUMNS]],
    );
    assert.deepEqual(rows.map((row) => row.column_name), [...NON_IDENTITY_COLUMNS].sort());
  });

  // ═══ it is a read, and every reader of it is named ═══════════════════════════════════════════
  await t.test('nothing wires the derived answer into a status write or any gate', async () => {
    // Walked from the filesystem rather than from `git ls-files`, which reports nothing about a
    // file that has not been committed yet — the one state in which a new gate would be invisible.
    const mentions = [...sourceFiles(path.join(REPO_ROOT, 'src')),
      ...sourceFiles(path.join(REPO_ROOT, 'scripts'))]
      .map((file) => path.relative(REPO_ROOT, file))
      // The definition itself is admitted by name, because no import can find it: a module does
      // not import itself. It is picked out of the same walk rather than appended to the result,
      // so a `MODULE` that was moved or deleted leaves the census one short here instead of being
      // asserted into existence.
      .filter((file) => file === MODULE
        || IMPORTS_MODULE.test(readFileSync(path.join(REPO_ROOT, file), 'utf8')))
      .sort();
    assert.deepEqual(
      mentions,
      [MODULE, SPEC, REDECLARATION_SPEC, PENDING_JUDGMENTS_SPEC, CRITERION_READY_SPEC,
        SERVICE, SERVICE_SPEC, DONE_PROJECTION, PUBLIC_PROJECT, DONE_REQUEST].sort(),
      'the readers of the derivation — the module itself, and every file that imports it — are '
        + 'exactly these, each named above with what it does with the answer: four tests of it, '
        + 'two read endpoints that serve it (the owner’s project, and a shared project’s public '
        + 'page), the first one’s own test, one projection that folds it into `project.status` '
        + '(since the owner’s 2026-09-08 re-deliberation of 0229), and the check a coordinator’s '
        + 'done request has to pass (since the owner’s 2026-10-01 decision on how a project is '
        + 'closed). That check is the one gate among them, and what it refuses is the '
        + 'coordinator’s request: nothing keeps the owner from recording a project done over a '
        + 'criterion that is not met. A file arriving here is a consumer somebody has to come and '
        + 'write down');

    const source = readFileSync(path.join(REPO_ROOT, MODULE), 'utf8');
    assert.doesNotMatch(
      source, /\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/u,
      'the derivation writes nothing');
    assert.doesNotMatch(source, /\$execute/u, 'and it has no raw escape hatch either');

    // The one member that does turn the answer into a status write, held to the difference the
    // sentence above now rests on. Comments are stripped first: this projection argues about gates
    // at length in its own header, and a case that read the argument instead of the code would go
    // red for a paragraph and green for a refusal.
    const projection = readFileSync(path.join(REPO_ROOT, DONE_PROJECTION), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');
    assert.doesNotMatch(projection, /\bthrow\b/u,
      'the projection refuses nobody: it recomputes the column from committed rows and stores the '
        + 'answer, so there is no write for it to turn away');

    // The coordinator gates its request; the owner reads and records findings without refusing.
    const askers = sourceFiles(path.join(REPO_ROOT, 'src/apiserver/src'))
      .map((file) => path.relative(REPO_ROOT, file))
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.spec.ts') && file !== DONE_REQUEST)
      .filter((file) => /\bdoneReadiness\s*\(/u.test(readFileSync(path.join(REPO_ROOT, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '')))
      .sort();
    assert.deepEqual(askers, ['src/apiserver/src/projects/project-acceptance.service.ts', DONE_REQUEST_DOOR].sort(),
      'only the coordinator’s done request is refused on `doneReadiness`, and no write of the '
        + 'owner’s is');
  });
});

/**
 * Clause 2 asked about work a check is pointed at, and about work that was reopened.
 *
 * A criterion whose check said FAIL read satisfied, and so did one whose work had been reopened with
 * its evidence still confirmed, and on 2026-11-03 `project-done-derived.ts` stored that as a project
 * DONE (`project-done-derived.pg.spec.ts` has the story and the column). This file is about the
 * answer itself: for each shape, whether the criterion is met, which rows hold it up, and what would
 * settle each of them. A reader who is told a criterion is unmet because of a check that already has
 * a verdict, and then told it "needs its verdict recorded", has been told something false.
 *
 * WHY ONE CRITERION PER SHAPE
 * ---------------------------
 * Each one is read on its own, with its own work, so no shape can pass on another's rows. Facts are
 * produced at the doors production uses, as everywhere in this file.
 *
 * WHICH CHECK ANSWERS, WHEN THERE ARE SEVERAL
 * -------------------------------------------
 * A subject's newest live check, for the subject and for every check of it. That is the rule the
 * dependency gate and the aggregation already hold (`newestLiveCheck`). On production on 2026-11-03,
 * 13 subjects had two or more checks and 8 of them an older FAIL under a newer PASS, none of those
 * yet under one criterion, so the shape is ordinary and waiting to arrive here. The alternative, each
 * check needing its own PASS, wedges it: a FAIL can be retired only by revoking it and cancelling the
 * row, and a cancelled row is not DONE. An older PASS must not stand over a newer FAIL either, which
 * is why "any PASS" is not the rule. Both directions are below.
 */
test('a check that did not pass, or work that was reopened, does not settle a criterion', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma: PrismaClient = prismaClientFor(url);
  t.after(async () => {
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  const projects = new ProjectsService(prisma as unknown as PrismaService,
    new ProjectAcceptanceService(prisma as unknown as PrismaService));
  const tasks = new TasksService(prisma as never, {} as never, {
    publishTaskChanged() {},
    publishForUser() {},
    publishTaskResync() {},
  } as never);
  const evidence = new TaskCompletionEvidenceService(prisma as unknown as PrismaService);

  const ownerId = randomUUID();
  const projectId = randomUUID();
  await prisma.user.create({
    data: {
      id: ownerId,
      email: `checks-${ownerId}@criterion-satisfaction.invalid`,
      name: 'Checks',
      passwordHash: 'x',
    },
  });
  await prisma.project.create({
    data: { id: projectId, ownerId, title: 'The project of checks and reopened work' },
  });

  const SHAPES = [
    'FAIL', 'INCONCLUSIVE', 'NO_VERDICT', 'PASS',
    'OLDER_FAIL_NEWER_PASS', 'OLDER_PASS_NEWER_FAIL', 'OLDER_PASS_NEWER_RUNNING',
    'NEWER_CHECK_CANCELLED', 'CHECK_SERVES_NOTHING_FAIL', 'CHECK_SERVES_NOTHING_PASS',
    'ONLY_THE_CHECK_SERVES_SUBJECT_REOPENED', 'CONFIRMED_THEN_REOPENED_CHECK_PASS',
    'CONFIRMED_THEN_REOPENED_CHECK_FAIL', 'CONFIRMED_THEN_CANCELLED', 'SUBJECT_REOPENED_WITH_ITS_PASS',
    'MANUAL_SUBJECT_CHECK_PASSED', 'EXECUTABLE_FAILED',
  ] as const;
  type Shape = (typeof SHAPES)[number];
  const written = await projects.update(ownerId, projectId, {
    acceptanceCriteriaItems: SHAPES.map((text) => ({ text, verificationMethod: METHOD })),
  } as never);
  const criteria = criteriaFromDefinitions(written.acceptanceCriteriaItems);
  const criterionOf = (shape: Shape) => {
    const found = criteria.find((row) => row.text === shape);
    assert.ok(found, `the fixture states ${shape}`);
    return found;
  };

  const OBTAIN_PASS = 'OBTAIN_INDEPENDENT_VERIFICATION_PASS';
  const RECORD_VERDICT = 'RECORD_VERIFICATION_VERDICT';
  const SUBMIT_EVIDENCE = 'SUBMIT_EVIDENCE_AND_AWAIT_INDEPENDENT_DECISION';
  const RUN_COMMAND = 'RUN_ACCEPTANCE_COMMAND';

  /** The finished work a shape's check is pointed at. */
  async function settledWork(shape: Shape, serves = true) {
    const task = await tasks.create(ownerId, {
      title: `the work of ${shape}`,
      projectId,
      ...(serves ? { criterionKey: criterionOf(shape).key } : {}),
      completionCriterion: 'EXECUTABLE',
      acceptanceCommand: 'true',
      acceptanceExpectedExitCode: 0,
    } as never);
    const settled = await sql.query(
      `UPDATE "task" SET "status" = 'DONE'
        WHERE "id" = $1::uuid AND "status" IN ('OPEN', 'IN_PROGRESS')
          AND "completion_criterion" = 'EXECUTABLE'`,
      [task.id],
    );
    assert.equal(settled.rowCount, 1, 'the EXECUTABLE task must reach DONE through the DONE fence');
    return task;
  }

  /**
   * One check of `subject`, with its verdict written the way a verifier writes one. Created one at a
   * time, so `created_at` orders them.
   */
  async function checkOf(
    subject: { id: string },
    shape: Shape,
    verdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE' | null,
    options: { serves?: boolean; suffix?: string } = {},
  ) {
    const check = await tasks.create(ownerId, {
      title: `the check of ${shape}${options.suffix ?? ''}`,
      projectId,
      ...(options.serves === false ? {} : { criterionKey: criterionOf(shape).key }),
      verifiesTaskId: subject.id,
    } as never);
    if (verdict) await tasks.update(ownerId, check.id, { verdict } as never);
    return check;
  }

  /** Evidence-judgment work with its one revision confirmed, by a session that did not do it. */
  async function confirmedWork(shape: Shape) {
    const task = await tasks.create(ownerId, {
      title: `the work of ${shape}`,
      projectId,
      criterionKey: criterionOf(shape).key,
      completionCriterion: 'EVIDENCE_JUDGMENT',
    } as never);
    const workerSessionId = randomUUID();
    const decidingSessionId = randomUUID();
    await prisma.session.create({
      data: {
        id: workerSessionId,
        ownerId,
        creatorId: ownerId,
        taskId: task.id,
        title: 'the run that produced the evidence',
        prompt: 'do the work',
        startsTaskWork: false,
      },
    });
    await prisma.session.create({
      data: {
        id: decidingSessionId,
        ownerId,
        creatorId: ownerId,
        title: 'the run that judges it',
        prompt: 'read the ledger and decide',
      },
    });
    const toolUseId = `toolu_${randomUUID()}`;
    await prisma.toolCall.create({
      data: {
        sessionId: workerSessionId,
        name: 'Bash',
        toolUseId,
        input: { command: 'true', description: 'the work this evidence cites' },
        isError: false,
      },
    });
    const actor = { type: CreatorType.USER, id: ownerId } as const;
    await evidence.submit(ownerId, task.id, actor, {
      sourceSessionId: workerSessionId,
      evidence: {
        claim: `the work of ${shape} is done`,
        criterion: { key: criterionOf(shape).key, text: shape },
        checks: [{ kind: 'TOOL_CALL', ref: toolUseId }],
        gaps: [],
      },
    });
    await evidence.decide(ownerId, task.id, actor, {
      decidingSessionId,
      evidenceRevision: '1',
      decision: 'CONFIRM',
    });
    return task;
  }

  async function answerOf(shape: Shape): Promise<CriterionSatisfaction> {
    const derived = await readCriterionSatisfaction(prisma, ownerId, projectId);
    const row = derived.find((entry) => entry.definitionId === criterionOf(shape).definitionId);
    assert.ok(row, `${shape} must be in the read`);
    return row;
  }

  /** Whether it is met, and, when it is not, who holds it up and what would settle each. */
  async function assertHeldUpBy(
    shape: Shape,
    expected: ReadonlyArray<{ task: { id: string }; status: string; requiredAction: string }>,
  ) {
    const answer = await answerOf(shape);
    assert.equal(answer.satisfied, expected.length === 0,
      `${shape}: satisfied is ${answer.satisfied} and ${expected.length} task(s) were expected to hold it up`);
    const held = answer.unmet.filter((reason) => reason.clause === 'SERVING_WORK_UNSETTLED')
      .flatMap((reason) => reason.heldUpBy)
      .map(({ taskId, status, requiredAction }) => ({ taskId, status, requiredAction }))
      .sort((a, b) => a.taskId.localeCompare(b.taskId));
    assert.deepEqual(held, expected
      .map(({ task, status, requiredAction }) => ({ taskId: task.id, status, requiredAction }))
      .sort((a, b) => a.taskId.localeCompare(b.taskId)), `${shape}: who holds it up, and why`);
    assert.deepEqual(answer.unmet.map((reason) => reason.clause),
      expected.length > 0 ? ['SERVING_WORK_UNSETTLED'] : [], `${shape}: which clauses`);
  }

  await t.test('a FAIL and an INCONCLUSIVE hold the criterion, and the row says a PASS is missing',
    async () => {
      for (const verdict of ['FAIL', 'INCONCLUSIVE'] as const) {
        const work = await settledWork(verdict);
        const check = await checkOf(work, verdict, verdict);
        await assertHeldUpBy(verdict, [
          // Both rows, for the reason a dependency on `work` is held by the same check: it is the
          // work that has to change, and the check is the row that said so.
          { task: work, status: 'DONE', requiredAction: OBTAIN_PASS },
          { task: check, status: 'DONE', requiredAction: OBTAIN_PASS },
        ]);
      }
    });

  await t.test('a check with no verdict holds it too, and that row does need its verdict', async () => {
    const work = await settledWork('NO_VERDICT');
    const check = await checkOf(work, 'NO_VERDICT', null);
    await assertHeldUpBy('NO_VERDICT', [
      { task: work, status: 'DONE', requiredAction: OBTAIN_PASS },
      { task: check, status: 'OPEN', requiredAction: RECORD_VERDICT },
    ]);
  });

  await t.test('the work DONE and its check PASS is what meets it', async () => {
    const work = await settledWork('PASS');
    await checkOf(work, 'PASS', 'PASS');
    await assertHeldUpBy('PASS', []);
  });

  await t.test('of several checks the newest live one answers, in both directions', async () => {
    const fixed = await settledWork('OLDER_FAIL_NEWER_PASS');
    await checkOf(fixed, 'OLDER_FAIL_NEWER_PASS', 'FAIL', { suffix: ' (first)' });
    await checkOf(fixed, 'OLDER_FAIL_NEWER_PASS', 'PASS', { suffix: ' (re-run)' });
    await assertHeldUpBy('OLDER_FAIL_NEWER_PASS', []);

    const regressed = await settledWork('OLDER_PASS_NEWER_FAIL');
    const older = await checkOf(regressed, 'OLDER_PASS_NEWER_FAIL', 'PASS', { suffix: ' (first)' });
    const newer = await checkOf(regressed, 'OLDER_PASS_NEWER_FAIL', 'FAIL', { suffix: ' (re-run)' });
    await assertHeldUpBy('OLDER_PASS_NEWER_FAIL', [
      { task: regressed, status: 'DONE', requiredAction: OBTAIN_PASS },
      { task: older, status: 'DONE', requiredAction: OBTAIN_PASS },
      { task: newer, status: 'DONE', requiredAction: OBTAIN_PASS },
    ]);

    const reopened = await settledWork('OLDER_PASS_NEWER_RUNNING');
    const passed = await checkOf(reopened, 'OLDER_PASS_NEWER_RUNNING', 'PASS', { suffix: ' (first)' });
    const running = await checkOf(reopened, 'OLDER_PASS_NEWER_RUNNING', null, { suffix: ' (re-run)' });
    await assertHeldUpBy('OLDER_PASS_NEWER_RUNNING', [
      { task: reopened, status: 'DONE', requiredAction: OBTAIN_PASS },
      { task: passed, status: 'DONE', requiredAction: OBTAIN_PASS },
      { task: running, status: 'OPEN', requiredAction: RECORD_VERDICT },
    ]);

    // A cancelled check answers nothing, so the one before it answers again. It serves nothing
    // here, because a cancelled row that does serve a criterion holds it for the other reason.
    const dropped = await settledWork('NEWER_CHECK_CANCELLED');
    await checkOf(dropped, 'NEWER_CHECK_CANCELLED', 'PASS', { suffix: ' (first)' });
    const cancelled = await checkOf(dropped, 'NEWER_CHECK_CANCELLED', null, {
      serves: false, suffix: ' (dropped)',
    });
    await assertHeldUpBy('NEWER_CHECK_CANCELLED', [
      { task: dropped, status: 'DONE', requiredAction: OBTAIN_PASS },
      { task: { id: (await taskByTitle('the check of NEWER_CHECK_CANCELLED (first)')).id }, status: 'DONE', requiredAction: OBTAIN_PASS },
    ]);
    await tasks.update(ownerId, cancelled.id, { status: 'CANCELLED' } as never);
    await assertHeldUpBy('NEWER_CHECK_CANCELLED', []);
  });

  async function taskByTitle(title: string): Promise<{ id: string }> {
    const { rows } = await sql.query<{ id: string }>(
      `SELECT "id"::text FROM "task" WHERE "project_id" = $1::uuid AND "title" = $2`,
      [projectId, title],
    );
    assert.equal(rows.length, 1, `exactly one task is called ${title}`);
    return rows[0]!;
  }

  await t.test('a check that serves no criterion still answers for the work that does', async () => {
    const failed = await settledWork('CHECK_SERVES_NOTHING_FAIL');
    await checkOf(failed, 'CHECK_SERVES_NOTHING_FAIL', 'FAIL', { serves: false });
    await assertHeldUpBy('CHECK_SERVES_NOTHING_FAIL', [
      { task: failed, status: 'DONE', requiredAction: OBTAIN_PASS },
    ]);

    const passed = await settledWork('CHECK_SERVES_NOTHING_PASS');
    await checkOf(passed, 'CHECK_SERVES_NOTHING_PASS', 'PASS', { serves: false });
    await assertHeldUpBy('CHECK_SERVES_NOTHING_PASS', []);
  });

  await t.test('a PASS does not stand once the work it passed is reopened, whoever serves what',
    async () => {
      const work = await settledWork('ONLY_THE_CHECK_SERVES_SUBJECT_REOPENED', false);
      const check = await checkOf(work, 'ONLY_THE_CHECK_SERVES_SUBJECT_REOPENED', 'PASS');
      await assertHeldUpBy('ONLY_THE_CHECK_SERVES_SUBJECT_REOPENED', []);

      await tasks.update(ownerId, work.id, { status: 'OPEN' } as never);
      await assertHeldUpBy('ONLY_THE_CHECK_SERVES_SUBJECT_REOPENED', [
        { task: check, status: 'DONE', requiredAction: OBTAIN_PASS },
      ]);
    });

  await t.test('a standing CONFIRM does not settle work that was reopened, whatever the check says',
    async () => {
      for (const [shape, verdict] of [
        ['CONFIRMED_THEN_REOPENED_CHECK_PASS', 'PASS'],
        ['CONFIRMED_THEN_REOPENED_CHECK_FAIL', 'FAIL'],
      ] as const) {
        const work = await confirmedWork(shape);
        const check = await checkOf(work, shape, verdict);
        await tasks.update(ownerId, work.id, { status: 'OPEN' } as never);
        await assertHeldUpBy(shape, [
          { task: work, status: 'OPEN', requiredAction: SUBMIT_EVIDENCE },
          { task: check, status: 'DONE', requiredAction: OBTAIN_PASS },
        ]);
      }

      // And cancelled is not DONE either. Production holds this shape on one OPEN project.
      const work = await confirmedWork('CONFIRMED_THEN_CANCELLED');
      await assertHeldUpBy('CONFIRMED_THEN_CANCELLED', []);
      await tasks.update(ownerId, work.id, { status: 'CANCELLED' } as never);
      await assertHeldUpBy('CONFIRMED_THEN_CANCELLED', [
        { task: work, status: 'CANCELLED', requiredAction: SUBMIT_EVIDENCE },
      ]);
    });

  await t.test('a VERIFICATION subject reads the same rule: not DONE is not settled', async () => {
    const [subject, check] = await tasks.createMany(ownerId, {
      tasks: [
        {
          title: 'the subject its check settles',
          ref: 'reopened-subject',
          projectId,
          criterionKey: criterionOf('SUBJECT_REOPENED_WITH_ITS_PASS').key,
          completionCriterion: 'VERIFICATION',
          completionPolicy: 'VERIFICATION_PASSED',
        },
        {
          title: 'the check that settled it',
          ref: 'reopened-check',
          projectId,
          criterionKey: criterionOf('SUBJECT_REOPENED_WITH_ITS_PASS').key,
          verifiesRef: 'reopened-subject',
        },
      ],
    } as never);
    await tasks.update(ownerId, check.id, { verdict: 'PASS' } as never);
    await assertHeldUpBy('SUBJECT_REOPENED_WITH_ITS_PASS', []);

    // Taken out of DONE by the row itself, past every door that would put it back: this is the
    // state, and what the doors do about it is their business.
    const reopened = await sql.query(
      `UPDATE "task" SET "status" = 'OPEN' WHERE "id" = $1::uuid AND "status" = 'DONE'`,
      [subject.id],
    );
    assert.equal(reopened.rowCount, 1, 'the subject was DONE on its check’s PASS');
    await assertHeldUpBy('SUBJECT_REOPENED_WITH_ITS_PASS', [
      { task: subject, status: 'OPEN', requiredAction: OBTAIN_PASS },
      { task: check, status: 'DONE', requiredAction: OBTAIN_PASS },
    ]);
  });

  await t.test('a MANUAL subject its check passed is not DONE, so it holds until it is declared to be',
    async () => {
      // `recompute` leaves MANUAL alone and the DONE fence has no lane for it, so nothing derives this
      // row's DONE from a PASS. The read used to call it settled anyway, with the task OPEN.
      const shape = 'MANUAL_SUBJECT_CHECK_PASSED';
      const [subject, check] = await tasks.createMany(ownerId, {
        tasks: [
          {
            title: 'a work row a check settles',
            ref: 'manual-subject',
            projectId,
            criterionKey: criterionOf(shape).key,
            completionCriterion: 'VERIFICATION',
            completionPolicy: 'MANUAL',
          },
          {
            title: 'the check of that work row',
            ref: 'manual-check',
            projectId,
            criterionKey: criterionOf(shape).key,
            verifiesRef: 'manual-subject',
          },
        ],
      } as never);
      await tasks.update(ownerId, check.id, { verdict: 'PASS' } as never);
      await assertHeldUpBy(shape, [
        { task: subject, status: 'OPEN', requiredAction: OBTAIN_PASS },
        { task: check, status: 'DONE', requiredAction: OBTAIN_PASS },
      ]);

      // The way out is an edit anybody allowed to write the task can make.
      await tasks.update(ownerId, subject.id, { completionPolicy: 'VERIFICATION_PASSED' } as never);
      await assertHeldUpBy(shape, []);
    });

  await t.test('a serving task that ended FAILED holds it, as it always has', async () => {
    const task = await tasks.create(ownerId, {
      title: 'the work that failed',
      projectId,
      criterionKey: criterionOf('EXECUTABLE_FAILED').key,
      completionCriterion: 'EXECUTABLE',
      acceptanceCommand: 'true',
      acceptanceExpectedExitCode: 0,
    } as never);
    await tasks.update(ownerId, task.id, { status: 'FAILED' } as never);
    await assertHeldUpBy('EXECUTABLE_FAILED', [
      { task, status: 'FAILED', requiredAction: RUN_COMMAND },
    ]);
  });

  // ═══ what the check itself does is unchanged: this rule is the criterion's, and nobody else's ══

  await t.test('a FAIL still concludes its check, and still blocks what waits on it', async () => {
    const work = await tasks.create(ownerId, {
      title: 'the work under a check whose lifecycle is the point',
      projectId,
      completionCriterion: 'EXECUTABLE',
      acceptanceCommand: 'true',
      acceptanceExpectedExitCode: 0,
    } as never);
    await sql.query(
      `UPDATE "task" SET "status" = 'DONE' WHERE "id" = $1::uuid`, [work.id],
    );
    const check = await tasks.create(ownerId, {
      title: 'the check whose lifecycle is the point',
      projectId,
      verifiesTaskId: work.id,
    } as never);
    const onTheCheck = await tasks.create(ownerId, {
      title: 'waits on the check',
      projectId,
      dependsOnTaskIds: [check.id],
      autoRunWhenReady: false,
    } as never);
    const onTheWork = await tasks.create(ownerId, {
      title: 'waits on the work',
      projectId,
      dependsOnTaskIds: [work.id],
      autoRunWhenReady: false,
    } as never);

    const carrier = async () => {
      const { rows } = await sql.query<{ status: string; verdict: string | null; revision: string }>(
        `SELECT "status"::text, "verdict"::text, "verdict_revision"::text AS "revision"
           FROM "task" WHERE "id" = $1::uuid`,
        [check.id],
      );
      return rows[0]!;
    };

    // The evaluator every door derives a carrier's own DONE from: any conclusion concludes it.
    for (const ownVerdict of ['PASS', 'FAIL', 'INCONCLUSIVE'] as const) {
      assert.equal(deriveTaskCompletionStatus({
        completionCriterion: 'VERIFICATION',
        verifiesTaskId: work.id,
        ownVerdict,
      }), 'DONE', `${ownVerdict} concludes the carrier`);
    }
    assert.equal(deriveTaskCompletionStatus({
      completionCriterion: 'VERIFICATION',
      verifiesTaskId: work.id,
      ownVerdict: null,
    }), null, 'and no conclusion concludes nothing');

    await tasks.update(ownerId, check.id, { verdict: 'FAIL' } as never);
    assert.deepEqual(await carrier(), { status: 'DONE', verdict: 'FAIL', revision: '1' },
      'the FAIL is written, the check is DONE and its revision advanced, exactly as before');
    for (const dependent of [onTheCheck, onTheWork]) {
      assert.equal((await tasks.get(ownerId, dependent.id)).dependencyState, 'BLOCKED_FAILED',
        'a task waiting on a check, or on the work it checks, is stopped by the FAIL');
    }

    // A check holding a FAIL cannot be given another status while the verdict stands.
    await assert.rejects(
      tasks.update(ownerId, check.id, { status: 'CANCELLED' } as never),
      (error: { response?: { code?: string } }) =>
        error.response?.code === 'VERIFIER_STATUS_DERIVED_FROM_VERDICT',
      'its status is derived from the verdict, so it has to be revoked first',
    );
    await tasks.update(ownerId, check.id, { verdict: null } as never);
    assert.deepEqual(await carrier(), { status: 'OPEN', verdict: null, revision: '1' },
      'revoking takes the derived DONE with it and leaves the counter where it was');
    await tasks.update(ownerId, check.id, { verdict: 'FAIL' } as never);
    assert.deepEqual(await carrier(), { status: 'DONE', verdict: 'FAIL', revision: '2' },
      'and a second conclusion is a second revision');
  });
});
