/**
 * `TasksService.pinMany` on real PostgreSQL.
 *
 * What neither the unit tests nor a Prisma-level assertion can decide: this door is raw SQL, so
 * Prisma's `@updatedAt` never runs and the whole question "was this row written?" is answered by
 * PostgreSQL's `IS DISTINCT FROM` alone. It shows up in `updated_at`, which has exactly one reader
 * in the product — `readProjectListRollups` takes `max(task.updated_at)` per project as the
 * project's `lastActivityAt` — so a row skipped here is a project that stops reporting activity
 * for a write that changed nothing. A spec that only counted `changed` would pass on an
 * implementation that wrote every match and reported the difference.
 *
 * Destructive: it truncates. Run it against a throwaway database:
 *
 *   scripts/run-pg-spec.sh src/apiserver/src/tasks/task-batch-pin.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { BadRequestException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { TASK_BATCH_PIN_CHUNK } from './dto';
import { TasksService } from './tasks.service';

const URL = process.env.COORDINATOR_PG_URL;
const suite = URL ? test : test.skip;
const FLASH = 'deepseek-flash';
const PRO = 'deepseek-v4-pro';

/** A day old, so "did this row get written" is a comparison and not a guess about clock skew. */
const STALE = "now() - interval '1 day'";

function tasksService(db: PrismaClient): TasksService {
  return new TasksService(
    db as unknown as PrismaService,
    { create: () => { throw new Error('this fixture never dispatches'); } } as never,
    {
      publishForUser: () => undefined,
      publishTaskChanged: () => undefined,
    } as unknown as RealtimeService,
  );
}

interface World {
  owner: string;
  other: string;
  project: string;
  otherProject: string;
  list: string;
}

async function seed(client: Client): Promise<World> {
  const world: World = {
    owner: randomUUID(),
    other: randomUUID(),
    project: randomUUID(),
    otherProject: randomUUID(),
    list: randomUUID(),
  };
  await client.query('TRUNCATE "task", "project", "task_list", "user" CASCADE');
  // The owner mutex every chunk takes is `SELECT id FROM "user" … FOR UPDATE`, and a project's
  // owner is a foreign key, so both owners have to exist.
  for (const id of [world.owner, world.other]) {
    await client.query(
      `INSERT INTO "user"("id","email","name","password_hash") VALUES ($1,$2,'pin fixture','x')`,
      [id, `${id}@batch-pin.invalid`]);
  }
  await client.query(
    `INSERT INTO "project"("id","title","owner_id","updated_at") VALUES ($1,'p',$2,now()),($3,'q',$4,now())`,
    [world.project, world.owner, world.otherProject, world.other]);
  await client.query(
    `INSERT INTO "task_list"("id","title","owner_id","updated_at") VALUES ($1,'l',$2,now())`,
    [world.list, world.owner]);
  return world;
}

async function addTask(
  client: Client,
  world: World,
  spec: { id: string; owner: string; project?: string | null; list?: string | null; model?: string | null; provider?: string | null; labels?: string[] },
): Promise<void> {
  await client.query(
    `INSERT INTO "task"("id","title","owner_id","creator_type","creator_id","updated_at",
                        "project_id","list_id","model","provider","labels","completion_criterion")
     VALUES ($1,'t',$2,'AGENT',$2,${STALE},$3,$4,$5,$6,$7::text[],'EVIDENCE_JUDGMENT')`,
    [spec.id, spec.owner, spec.project ?? null, spec.list ?? null,
     spec.model ?? null, spec.provider ?? null, spec.labels ?? []]);
}

/** `updated_at` per id, as the date itself — what the database actually holds. */
async function pins(client: Client, ids: string[]) {
  const { rows } = await client.query<{ id: string; model: string | null; updated_at: Date; stale: boolean }>(
    `SELECT "id","model","updated_at", ("updated_at" < now() - interval '1 hour') AS stale
       FROM "task" WHERE "id" = ANY($1::uuid[]) ORDER BY "id"`, [ids]);
  return new Map(rows.map((row) => [row.id, row]));
}

suite('pinMany writes the rows that differ and leaves the ones that do not', async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const client = new Client({ connectionString: URL! });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  const prisma = prismaClientFor(URL!);
  t.after(async () => {
    await prisma.$disconnect().catch(() => undefined);
    await client.end().catch(() => undefined);
  });
  const tasks = tasksService(prisma);

  await t.test('a row already carrying the pin is not written, so its updated_at does not move', async () => {
    const world = await seed(client);
    const already = randomUUID();
    const needsIt = randomUUID();
    const wasNull = randomUUID();
    await addTask(client, world, { id: already, owner: world.owner, project: world.project, model: FLASH });
    await addTask(client, world, { id: needsIt, owner: world.owner, project: world.project, model: PRO });
    await addTask(client, world, { id: wasNull, owner: world.owner, project: world.project, model: null });

    const res = await tasks.pinMany(world.owner, { projectId: world.project, model: FLASH });

    // Three rows match the selector; two of them really change. The number the caller gets is the
    // second number — that is what makes it comparable to a row count from the N single-row PATCHes
    // this door replaces.
    assert.deepEqual(res, { changed: 2 });
    const after = await pins(client, [already, needsIt, wasNull]);
    assert.equal(after.get(already)!.stale, true, 'the row already at the target must not be written');
    assert.equal(after.get(needsIt)!.stale, false);
    assert.equal(after.get(wasNull)!.stale, false, 'null is not the target, so this row does change');
    assert.equal(after.get(needsIt)!.model, FLASH);
    assert.equal(after.get(wasNull)!.model, FLASH);
  });

  await t.test('it is idempotent: a second run writes nothing at all', async () => {
    const world = await seed(client);
    const one = randomUUID();
    const two = randomUUID();
    await addTask(client, world, { id: one, owner: world.owner, project: world.project, model: PRO });
    await addTask(client, world, { id: two, owner: world.owner, project: world.project, model: FLASH });

    assert.deepEqual(await tasks.pinMany(world.owner, { projectId: world.project, model: FLASH }),
      { changed: 1 });
    assert.deepEqual(await tasks.pinMany(world.owner, { projectId: world.project, model: FLASH }),
      { changed: 0 });
  });

  await t.test('provider and model are narrowed independently, so a row differing in one is written', async () => {
    const world = await seed(client);
    const providerOnly = randomUUID();
    const neither = randomUUID();
    await addTask(client, world, {
      id: providerOnly, owner: world.owner, project: world.project, model: FLASH, provider: 'codex',
    });
    await addTask(client, world, {
      id: neither, owner: world.owner, project: world.project, model: FLASH, provider: 'claude',
    });

    const res = await tasks.pinMany(world.owner,
      { projectId: world.project, provider: 'claude', model: FLASH });

    assert.deepEqual(res, { changed: 1 });
    const after = await pins(client, [providerOnly, neither]);
    assert.equal(after.get(providerOnly)!.stale, false, 'the provider differs, so this row changes');
    assert.equal(after.get(neither)!.stale, true, 'both already match, so this row does not');
  });

  await t.test('clearing a pin skips rows that are already null', async () => {
    const world = await seed(client);
    const hadOne = randomUUID();
    const wasNull = randomUUID();
    await addTask(client, world, { id: hadOne, owner: world.owner, project: world.project, model: FLASH });
    await addTask(client, world, { id: wasNull, owner: world.owner, project: world.project, model: null });

    assert.deepEqual(await tasks.pinMany(world.owner, { projectId: world.project, model: null }),
      { changed: 1 });
    const after = await pins(client, [hadOne, wasNull]);
    assert.equal(after.get(hadOne)!.model, null);
    assert.equal(after.get(wasNull)!.stale, true);
  });

  await t.test('the selection never leaves the caller\'s own tenant', async () => {
    const world = await seed(client);
    const mine = randomUUID();
    const theirs = randomUUID();
    await addTask(client, world, { id: mine, owner: world.owner, project: world.project, model: PRO });
    // Same shape of selection, another owner's project: the owner id is the first predicate and
    // nothing here discloses whether that project exists.
    await addTask(client, world, { id: theirs, owner: world.other, project: world.otherProject, model: PRO });

    assert.deepEqual(await tasks.pinMany(world.owner, { projectId: world.otherProject, model: FLASH }),
      { changed: 0 });
    const after = await pins(client, [mine, theirs]);
    assert.equal(after.get(mine)!.stale, true, 'another owner\'s projectId must not reach my rows');
    assert.equal(after.get(theirs)!.stale, true, 'and must not reach theirs either');
  });

  await t.test('listId and labels select the same way, and taskIds narrows rather than excludes', async () => {
    const world = await seed(client);
    const inList = randomUUID();
    const labelled = randomUUID();
    const bare = randomUUID();
    await addTask(client, world, { id: inList, owner: world.owner, list: world.list, model: PRO });
    await addTask(client, world, { id: labelled, owner: world.owner, project: world.project, model: PRO, labels: ['fineweb'] });
    await addTask(client, world, { id: bare, owner: world.owner, project: world.project, model: PRO });

    assert.deepEqual(await tasks.pinMany(world.owner, { listId: world.list, model: FLASH }),
      { changed: 1 });
    assert.deepEqual(await tasks.pinMany(world.owner, { labels: ['fineweb'], model: FLASH }),
      { changed: 1 });
    // Both selectors at once: the intersection, not either half.
    assert.deepEqual(
      await tasks.pinMany(world.owner, { taskIds: [bare, labelled], projectId: world.project, model: FLASH }),
      { changed: 1 });
    const after = await pins(client, [inList, labelled, bare]);
    assert.equal(after.get(inList)!.model, FLASH);
    assert.equal(after.get(labelled)!.model, FLASH);
    assert.equal(after.get(bare)!.stale, false);
  });

  await t.test('a request that names no selector, or no pin, is refused', async () => {
    const world = await seed(client);
    await assert.rejects(
      () => tasks.pinMany(world.owner, { model: FLASH }),
      (err: BadRequestException) => (err.getResponse() as { code: string }).code === 'PIN_BATCH_NO_SELECTOR');
    await assert.rejects(
      () => tasks.pinMany(world.owner, { projectId: world.project }),
      (err: BadRequestException) => (err.getResponse() as { code: string }).code === 'PIN_BATCH_NOTHING_TO_WRITE');
  });

  await t.test('more rows than one chunk are all written, and only once', async () => {
    const world = await seed(client);
    // One past a chunk, so the loop runs twice and the short second chunk ends it.
    const ids = Array.from({ length: TASK_BATCH_PIN_CHUNK + 1 }, () => randomUUID());
    for (const id of ids) {
      await addTask(client, world, { id, owner: world.owner, project: world.project, model: PRO });
    }

    assert.deepEqual(await tasks.pinMany(world.owner, { projectId: world.project, model: FLASH }),
      { changed: ids.length });
    const after = await pins(client, ids);
    assert.equal([...after.values()].filter((row) => row.stale).length, 0);
    // Looping to exhaustion is what stops here: everything already carries the pin.
    assert.deepEqual(await tasks.pinMany(world.owner, { projectId: world.project, model: FLASH }),
      { changed: 0 });
  });
});
