/**
 * `GET /projects/:id` on real PostgreSQL: the work side's answer, beside the criterion it answers.
 *
 * The derivation has its own pg spec, and that one is about the three clauses. This one is about
 * the OUTWARD read — that the answer reaches `acceptanceCriteriaItems`, under the derivation's own
 * two names, attached to the right criterion, with every task holding a clause up named in full.
 * `ProjectsService.get` is the whole of what the controller does with a project id, so this is the
 * interface layer rather than a layer beneath it.
 *
 * FOUR CRITERIA, ONE READ
 * -----------------------
 * One project states four criteria that land on the four different outcomes at the same instant,
 * and one `get` answers for all of them. A spec that gave each outcome its own project would pass
 * on a projection that merged by position, or by ordinal, or that answered every item with the
 * first row it derived — and merging by the wrong key is the mistake this projection can actually
 * make. Every item is checked field by field, including the tasks each unmet clause names, because
 * "this criterion is not met" that cannot say what would meet it is the thing the derivation was
 * written to avoid and the projection can drop.
 *
 * The negatives were run first against the projection that does not carry the answer — the read
 * returning what it returned before this unit — and all eight cases were red on the missing field
 * rather than on anything else. They were then run against a projection that merged the FIRST
 * derived row onto every criterion, which left the positive green and turned six of the eight red,
 * including the one below that exists for exactly that mistake. Both outputs are in the task's
 * comments. Neither stub touched this file, because a negative a test double can satisfy is not a
 * negative.
 *
 * Why this is a `.pg.spec`. Every fact folded here is produced the way the product produces it:
 * criteria are written and edited through `ProjectsService.update` (the only thing that increments
 * a criterion's revision), work is filed through `TasksService.create` (which resolves
 * `criterionKey` into the two columns the derivation reads), and the settled tasks reach DONE
 * through the same compare-and-set `runnerApi.turnComplete` performs against 0193/0230's fence. A
 * double handing the service canned satisfaction rows would prove this file can copy a field.
 *
 *   PATH=/opt/node26/bin:$PATH \
 *   OUTCOME_RELEASE_API_SPEC_REGEX='project-get-criterion-satisfaction\.pg\.spec\.js$' \
 *   OUTCOME_RELEASE_API_JOBS=1 bash scripts/outcome-reconciler-full-api.sh
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { uuidToBase62 } from '@orbit/shared';
import { addTwins } from '../common/public-id-body';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { TasksService } from '../tasks/tasks.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { criteriaFromDefinitions } from './project-acceptance';
import { ProjectAcceptanceService } from './project-acceptance.service';
import type { CriterionUnmetReason } from './project-criterion-satisfaction';
import { ProjectsService } from './projects.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** The verification method every criterion here declares; never the thing under test. */
const METHOD = 'Read it and say whether it holds';

/**
 * One criterion as the outward read states it, narrowed to what this spec reads.
 *
 * `satisfied` and `unmet` are OPTIONAL here, and deliberately: typed as required, a projection
 * that carried neither would fail to compile and this file could never be the thing that goes red
 * about it. Optional, the assertions below are what notices — which is what a negative control
 * over a missing field has to look like. The clause type itself is imported rather than restated,
 * because a second spelling of it here could agree with this file while disagreeing with the
 * answer callers actually receive.
 */
interface StatedCriterion {
  id: string;
  text: string;
  revision: number;
  satisfied?: boolean;
  unmet?: CriterionUnmetReason[];
}

/** The answer for one criterion, required to be there — a missing one is not a passing one. */
function answerOf(item: StatedCriterion): { satisfied: boolean; unmet: CriterionUnmetReason[] } {
  const { satisfied, unmet } = item;
  if (satisfied === undefined || unmet === undefined) {
    assert.fail(`the outward read carries no derived answer for “${item.text}”`);
  }
  return { satisfied, unmet };
}

test('GET /projects/:id says, beside each criterion, whether the work has met it', {
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
      email: `get-${ownerId}@criterion-satisfaction.invalid`,
      name: 'Project detail',
      passwordHash: 'x',
    },
  });
  await prisma.project.create({
    data: { id: projectId, ownerId, title: 'The project whose detail is read' },
  });

  /** State the whole collection through the owner's path, and read the keys back. */
  async function state(items: Array<{ id?: string; text: string }>) {
    const written = await projects.update(ownerId, projectId, {
      acceptanceCriteriaItems: items.map((item) => ({
        ...(item.id ? { id: item.id } : {}),
        text: item.text,
        verificationMethod: METHOD,
      })),
    } as never);
    return criteriaFromDefinitions(written.acceptanceCriteriaItems);
  }

  /**
   * Settle an EXECUTABLE task exactly as `runnerApi.turnComplete` settles one: `status = 'DONE'`
   * as a compare-and-set that repeats the declaration in its WHERE clause, through 0193/0230's
   * BEFORE UPDATE fence. Nothing else is written because nothing else is stored.
   */
  async function settleExecutable(taskId: string) {
    const written = await sql.query(
      `UPDATE "task" SET "status" = 'DONE'
        WHERE "id" = $1::uuid
          AND "status" IN ('OPEN', 'IN_PROGRESS')
          AND "completion_criterion" = 'EXECUTABLE'
          AND "acceptance_command" = 'true'
          AND "acceptance_expected_exit_code" = 0`,
      [taskId],
    );
    assert.equal(written.rowCount, 1, 'the EXECUTABLE task must reach DONE through the DONE fence');
  }

  /** The read under test: the project detail, and its criteria in the order it states them. */
  async function detail(): Promise<StatedCriterion[]> {
    const read = await projects.get(ownerId, projectId) as unknown as {
      acceptanceCriteriaItems: StatedCriterion[];
    };
    return read.acceptanceCriteriaItems;
  }

  const MET = 'the work filed against this one settled, against this wording';
  const UNSERVED = 'nobody has filed any work against this one';
  const UNSETTLED = 'the work filed against this one has not settled by its own criterion';
  const MOVES = 'the wording of this one is about to be corrected';
  const MOVED = 'the wording of this one has been corrected';

  const [metAtFirst, unservedAtFirst, unsettledAtFirst, movingAtFirst] = await state([
    { text: MET }, { text: UNSERVED }, { text: UNSETTLED }, { text: MOVES },
  ]);

  const EXECUTABLE_DECLARATION = {
    completionCriterion: 'EXECUTABLE',
    acceptanceCommand: 'true',
    acceptanceExpectedExitCode: 0,
  };

  // The criterion whose work is done, and whose wording has not moved under it.
  const metTask = await tasks.create(ownerId, {
    title: 'the command that returned what it said it would',
    projectId,
    criterionKey: metAtFirst.key,
    ...EXECUTABLE_DECLARATION,
  } as never);
  await settleExecutable(metTask.id);

  // The criterion somebody has filed work against and nobody has finished. VERIFICATION with no
  // carrier pointed at it: the task is OPEN and the fact that would settle it — a live PASS from
  // an independent check — does not exist, so the clause names it and says what it is waiting for.
  const unsettledTask = await tasks.create(ownerId, {
    title: 'the work still waiting for somebody to check it',
    projectId,
    criterionKey: unsettledAtFirst.key,
    completionCriterion: 'VERIFICATION',
    completionPolicy: 'VERIFICATION_PASSED',
  } as never);

  // The criterion whose wording moves out from under work that has already settled.
  const movingTask = await tasks.create(ownerId, {
    title: 'work filed, and settled, against a wording that then changed',
    projectId,
    criterionKey: movingAtFirst.key,
    ...EXECUTABLE_DECLARATION,
  } as never);
  await settleExecutable(movingTask.id);
  const [met, unserved, unsettled, moved] = await state([
    { id: metAtFirst.definitionId, text: MET },
    { id: unservedAtFirst.definitionId, text: UNSERVED },
    { id: unsettledAtFirst.definitionId, text: UNSETTLED },
    { id: movingAtFirst.definitionId, text: MOVED },
  ]);
  assert.deepEqual(
    [met.definitionRevision, unserved.definitionRevision,
      unsettled.definitionRevision, moved.definitionRevision],
    [1, 1, 1, 2],
    'exactly one criterion moved, and nothing here wrote a revision by hand');

  // ═══ 1. the positive ══════════════════════════════════════════════════════════════════════════
  await t.test('a criterion whose work has settled reads as satisfied, with nothing missing',
    async () => {
      const item = (await detail()).find((row) => row.id === met.definitionId);
      assert.ok(item, 'the criterion the project states must be in the project the read returns');
      assert.equal(item.text, MET, 'and the answer must be attached to the criterion it is about');
      assert.deepEqual(answerOf(item), { satisfied: true, unmet: [] },
        'the reason a satisfied criterion gives is that no clause is missing');
    });

  // ═══ 2. the negative for clause 1: nobody has filed anything ═════════════════════════════════
  await t.test('a criterion nobody serves reads as unsatisfied, and says nobody serves it',
    async () => {
      const item = (await detail()).find((row) => row.id === unserved.definitionId);
      assert.ok(item);
      assert.deepEqual(answerOf(item), {
        satisfied: false,
        unmet: [{ clause: 'NO_WORK_SERVES_IT', heldUpBy: [] }],
      }, '"every one of zero serving tasks has settled" is true and useless, and it is not served '
        + 'as satisfied; the clause has nobody to name and names nobody');
    });

  // ═══ 3. the negative for clause 2: the work is filed and unfinished ══════════════════════════
  await t.test('a criterion whose work has not settled names the work, and what would settle it',
    async () => {
      const item = (await detail()).find((row) => row.id === unsettled.definitionId);
      assert.ok(item);
      assert.deepEqual(answerOf(item), {
        satisfied: false,
        unmet: [{
          clause: 'SERVING_WORK_UNSETTLED',
          heldUpBy: [{
            taskId: unsettledTask.id,
            title: 'the work still waiting for somebody to check it',
            status: 'OPEN',
            completionCriterion: 'VERIFICATION',
            requiredAction: 'OBTAIN_INDEPENDENT_VERIFICATION_PASS',
            criterionRevision: 1,
            criterionRevisionStale: false,
          }],
        }],
      }, 'a reader is told which task holds this criterion up and what would settle THAT task — '
        + 'the whole reason an unmet clause carries work rather than only a boolean');
    });

  // ═══ 4. the negative for clause 3: the declaration is against wording that moved ══════════════
  await t.test('a criterion whose wording moved under settled work reads as stale', async () => {
    const item = (await detail()).find((row) => row.id === moved.definitionId);
    assert.ok(item);
    assert.equal(item.revision, 2, 'the criterion the answer sits beside is the one that moved');
    assert.deepEqual(answerOf(item), {
      satisfied: false,
      unmet: [{
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
      }],
    }, 'clause 3 is the only one missing: the work is settled, it is the declaration that is old, '
      + 'and the revision it was made against is served beside the one it is measured against');
  });

  // ═══ the four answers are four, and each is the one for its own criterion ═════════════════════
  await t.test('one read answers for every criterion, and never with another one’s answer',
    async () => {
      const items = await detail();
      assert.deepEqual(items.map((item) => item.text), [MET, UNSERVED, UNSETTLED, MOVED],
        'the read states the criteria in the project’s own order');
      assert.deepEqual(items.map((item) => answerOf(item).satisfied), [true, false, false, false],
        'four criteria, four outcomes, one call — a merge by position or by nothing would have '
          + 'to put the same answer on more than one of them');
      assert.deepEqual(
        items.map((item) => answerOf(item).unmet.map((reason) => reason.clause)),
        [[], ['NO_WORK_SERVES_IT'], ['SERVING_WORK_UNSETTLED'], ['DECLARATION_STALE']],
        'and each criterion is missing its own clause and no other');
    });

  // ═══ `satisfied` is not a fact of its own ════════════════════════════════════════════════════
  await t.test('`satisfied` is `unmet` being empty, on the projection as in the derivation',
    async () => {
      const items = await detail();
      assert.equal(items.length, 4, 'the invariant is only worth stating over every item');
      for (const item of items) {
        // `answerOf` is what says the pair travelled together — an item carrying one of them and
        // not the other never reaches the comparison.
        const { satisfied, unmet } = answerOf(item);
        assert.equal(satisfied, unmet.length === 0,
          `“${item.text}” is served with a boolean that disagrees with the clauses beside it`);
      }
    });

  // ═══ the task named is an address the caller can use ═════════════════════════════════════════
  await t.test('the task holding a criterion up is named in the spelling clients read', async () => {
    // The last step of the outward read is `PublicIdInterceptor`, whose mapper this is. `taskId`
    // is a name it classifies, so the task a clause names comes back in the same base62 spelling
    // as every other address in the response — which is what makes it something a reader can hand
    // straight to task_get instead of a uuid sitting beside encoded ids.
    const read = await projects.get(ownerId, projectId);
    addTwins(read, true);
    const items = (read as unknown as { acceptanceCriteriaItems: StatedCriterion[] })
      .acceptanceCriteriaItems;
    const item = items.find((row) => row.text === UNSETTLED);
    assert.ok(item);
    assert.deepEqual(answerOf(item).unmet.map((reason) => reason.heldUpBy.map((row) => row.taskId)),
      [[uuidToBase62(unsettledTask.id)]]);
  });

  // ═══ serving it is not gating on it ══════════════════════════════════════════════════════════
  await t.test('reading the answer writes nothing, and refuses nothing', async () => {
    const before = await prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { status: true, updatedAt: true },
    });
    // Three of this project's four criteria are unmet, which is the state in which a gate would
    // have something to say. Nothing says anything: the read returns, and the project is exactly
    // as it was. 0223 and 0229 recorded that `project.status = 'DONE'` is unguarded, and making
    // the answer visible is not a way of reinstating the guard that was removed.
    const items = await detail();
    assert.equal(items.filter((item) => answerOf(item).satisfied === false).length, 3);
    const after = await prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { status: true, updatedAt: true },
    });
    assert.deepEqual(after, before, 'the read left the project row untouched');
  });
});
