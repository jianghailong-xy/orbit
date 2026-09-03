/**
 * T2 on real PostgreSQL: a declaration whose criterion has moved is MARKED — not silently
 * accepted, and not silently detached.
 *
 * The two failures this rules out are opposites, and each is comfortable on its own. Accepting
 * the difference silently leaves work claiming to serve a condition whose words have changed
 * under it. Detaching silently lets one typo correction throw every task filed under a criterion
 * off it. What the read does instead is say so, and leave `criterion_definition_id` exactly where
 * it was — which is why the positive case below asserts the mark and the surviving relation in
 * the same breath.
 *
 * Why this is a `.pg.spec`. The staleness the read reports is manufactured here the way a person
 * manufactures it: by editing the criterion's TEXT through the service an owner edits it through.
 * Whether that increments `revision` is a fact about a BEFORE UPDATE trigger and the write path
 * above it, so an `UPDATE ... SET revision = revision + 1` in a fixture would prove the read can
 * subtract two numbers and nothing about whether the product ever produces two different ones.
 * The same goes for `ON DELETE SET NULL` not firing on an edit: only a real edit shows that.
 *
 *   PATH=/opt/node26/bin:$PATH \
 *   OUTCOME_RELEASE_API_SPEC_REGEX='project-criterion-declaration-staleness\.pg\.spec\.js$' \
 *   OUTCOME_RELEASE_API_JOBS=1 bash scripts/outcome-reconciler-full-api.sh
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { TasksService } from '../tasks/tasks.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { COORDINATOR_WAKE_EVENTS } from './coordinator-wake';
import { criteriaFromDefinitions } from './project-acceptance';
import { ProjectAcceptanceService } from './project-acceptance.service';
import {
  CriterionServingTask,
  readCriterionDeclarations,
} from './project-criterion-declaration-staleness';
import { ProjectsService } from './projects.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** The snapshot column, spelled as the database spells it. Asserted to exist, never assumed. */
const SNAPSHOT_COLUMN = 'criterion_revision';
/** What this codebase already calls a value measured against something that has since moved. */
const HOUSE_ADJECTIVE = 'STALE';
/** Those two words and no third one: the marker's name is derived, so a synonym cannot pass. */
const MARKER = `${SNAPSHOT_COLUMN.replace(/_([a-z])/gu, (_, c: string) => c.toUpperCase())}`
  + `${HOUSE_ADJECTIVE[0]}${HOUSE_ADJECTIVE.slice(1).toLowerCase()}`;

/** The verification method every criterion here declares; never the thing under test. */
const METHOD = 'Read it and say whether it holds';

test('T2: a declaration whose criterion moved is marked, and stays attached', {
  skip, concurrency: 1, timeout: 180_000,
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

  // Nothing is stubbed. Both services are the ones Nest wires, over the real client: the criteria
  // are authored and edited through `ProjectsService.update` — the owner's path — and the work is
  // filed through `TasksService.create`, which is what resolves `criterionKey` into the two
  // columns 0232 added.
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
      email: `t2-${ownerId}@criterion-staleness.invalid`,
      name: 'T2',
      passwordHash: 'x',
    },
  });
  await prisma.project.create({
    data: { id: projectId, ownerId, title: 'T2 subject project' },
  });

  /** State the whole collection, and read back what a caller would be told to name each one by. */
  async function state(items: Array<{ id?: string; text: string }>) {
    const written = await projects.update(ownerId, projectId, {
      acceptanceCriteriaItems: items.map((item) => ({
        ...(item.id ? { id: item.id } : {}),
        text: item.text,
        verificationMethod: METHOD,
        completionCriterion: 'EVIDENCE_JUDGMENT',
      })),
    } as never);
    return criteriaFromDefinitions(written.acceptanceCriteriaItems);
  }

  /** The two columns, read straight out of the row rather than through the read model. */
  async function columnsOf(taskId: string) {
    const { rows } = await sql.query<{
      criterion_definition_id: string | null;
      criterion_revision: number | null;
    }>(
      `SELECT "criterion_definition_id"::text AS criterion_definition_id, "criterion_revision"
         FROM "task" WHERE "id" = $1::uuid`,
      [taskId],
    );
    assert.equal(rows.length, 1, 'the task must still be there to have a declaration');
    return rows[0];
  }

  /** The read under test, narrowed to one criterion. */
  async function servingTasksOf(definitionId: string): Promise<CriterionServingTask[]> {
    const read = await readCriterionDeclarations(prisma, ownerId, projectId);
    const criterion = read.find((row) => row.definitionId === definitionId);
    assert.ok(criterion, 'the criterion must be in the read that lists this project’s criteria');
    return criterion.servingTasks;
  }

  const MOVED = 'the wording of this criterion is about to be corrected';
  const CORRECTED = 'the wording of this criterion has been corrected';
  const UNTOUCHED = 'the wording of this criterion is left alone';

  const [movedAtFirst, untouched] = await state([{ text: MOVED }, { text: UNTOUCHED }]);
  assert.equal(movedAtFirst.definitionRevision, 1);
  assert.equal(untouched.definitionRevision, 1);

  const staleTask = await tasks.create(ownerId, {
    title: 'work filed against the wording that is about to change',
    projectId,
    criterionKey: movedAtFirst.key,
  } as never);
  const currentTask = await tasks.create(ownerId, {
    title: 'work filed against a wording nobody touches',
    projectId,
    criterionKey: untouched.key,
  } as never);
  assert.deepEqual(await columnsOf(staleTask.id),
    { criterion_definition_id: movedAtFirst.definitionId, criterion_revision: 1 });

  // ═══ the product path that moves the ruler ════════════════════════════════════════════════
  // One edit of one criterion's text, through the same call the owner's client makes, carrying
  // every criterion's id so this is an EDIT rather than a delete and a re-create. That
  // distinction is the test's foundation: a re-created criterion would be a new row, the task's
  // FK would have gone to NULL by ON DELETE SET NULL, and everything below would be measuring
  // detachment while claiming to measure staleness.
  const [moved, stillUntouched] = await state([
    { id: movedAtFirst.definitionId, text: CORRECTED },
    { id: untouched.definitionId, text: UNTOUCHED },
  ]);
  assert.equal(moved.definitionId, movedAtFirst.definitionId,
    'the criterion must be the same row: an edit, not a replacement');
  assert.equal(moved.definitionRevision, 2,
    'editing the assertion increments the revision — nothing here wrote that column by hand');
  assert.equal(stillUntouched.definitionRevision, 1,
    'and it increments only the criterion that changed');

  // ═══ 1. the positive, with the relation surviving it ══════════════════════════════════════
  await t.test('a task whose criterion has moved is marked, and is still attached to it', async () => {
    const [row, ...rest] = await servingTasksOf(moved.definitionId);
    assert.deepEqual(rest, [], 'one task serves this criterion at this point');
    assert.equal(row.taskId, staleTask.id);

    assert.equal(row.criterionRevisionStale, true,
      'the declaration says 1 and the criterion says 2: that is the whole predicate');
    assert.equal(row.criterionRevision, 1,
      'the snapshot is not advanced to the current value — that would erase the fact');

    // The same assertion, because the mark means nothing without it: stale is a visible state,
    // not a detachment. Read from the read model AND from the column underneath it.
    assert.equal(row.criterionDefinitionId, moved.definitionId);
    assert.deepEqual(await columnsOf(staleTask.id),
      { criterion_definition_id: moved.definitionId, criterion_revision: 1 });
  });

  // ═══ 2. the negative: an agreeing revision carries no mark ════════════════════════════════
  // The one assertion a marker that is always true would fail, and the reason this file exists in
  // a mode that does not check per-case receipts: it was run against exactly that stub first.
  await t.test('a task whose declaration still matches its criterion is not marked', async () => {
    const [row, ...rest] = await servingTasksOf(untouched.definitionId);
    assert.deepEqual(rest, []);
    assert.equal(row.taskId, currentTask.id);

    assert.equal(row.criterionRevision, stillUntouched.definitionRevision);
    assert.equal(row.criterionRevisionStale, false,
      'a criterion nobody edited cannot have made the work filed under it stale');
  });

  // ═══ 3. the word is the one already in use ════════════════════════════════════════════════
  await t.test('the mark reuses the existing vocabulary rather than a synonym of it', async () => {
    const { rows } = await sql.query<{ table_name: string }>(
      `SELECT "table_name" FROM information_schema.columns
        WHERE "table_schema" = 'public' AND "column_name" = $1 ORDER BY "table_name"`,
      [SNAPSHOT_COLUMN],
    );
    const carriers = rows.map((row) => row.table_name);
    // The declaration (0232) and the completion-evidence card (0178) call this snapshot the same
    // thing, which is why the marker below is that name plus one adjective rather than a new noun.
    assert.ok(carriers.includes('task'), `${SNAPSHOT_COLUMN} must be the task column 0232 added`);
    assert.ok(carriers.includes('task_completion_evidence'),
      `${SNAPSHOT_COLUMN} must still be the evidence ledger's name for the same snapshot`);
    assert.ok(COORDINATOR_WAKE_EVENTS.some((event) => event.endsWith(`_${HOUSE_ADJECTIVE}`)),
      `${HOUSE_ADJECTIVE} must remain this codebase's word for a value that has been overtaken`);

    const [row] = await servingTasksOf(moved.definitionId);
    // Spelled out as a literal as well as derived, so that renaming the field is red here whether
    // the rename keeps the derivation's shape or not.
    assert.equal(MARKER, 'criterionRevisionStale');
    assert.deepEqual(Object.keys(row).sort(), [
      'criterionDefinitionId',
      'criterionRevision',
      'criterionRevisionStale',
      'status',
      'taskId',
      'title',
    ]);
    assert.equal((row as unknown as Record<string, unknown>)[MARKER], true);
    for (const synonym of
      ['Outdated', 'Obsolete', 'Expired', 'Drifted', 'Mismatch', 'Changed', 'Moved', 'Dirty']) {
      assert.deepEqual(Object.keys(row).filter((key) => key.includes(synonym)), [],
        `${synonym} would be a second word for what ${MARKER} already says`);
    }
  });

  // ═══ 4. and it blocks nothing ═════════════════════════════════════════════════════════════
  await t.test('the mark gates no write: work is still filable against the moved criterion', async () => {
    const fresh = await tasks.create(ownerId, {
      title: 'work filed against the corrected wording',
      projectId,
      criterionKey: moved.key,
    } as never);

    const serving = await servingTasksOf(moved.definitionId);
    assert.deepEqual(serving.map((row) => [row.taskId, row.criterionRevisionStale]), [
      [staleTask.id, true],
      [fresh.id, false],
    ], 'one criterion, two declarations, and the read distinguishes them without touching either');
  });
});
