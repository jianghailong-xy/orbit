import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Client } from 'pg';

import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';

/**
 * The stalled EVIDENCE_JUDGMENT population: enumerable, and untouched by this project.
 *
 * Two claims, one per test, and they are different in kind.
 *
 *  1. NOTHING THIS PROJECT MIGRATED MOVED THESE ROWS. Proved by replaying the real migration
 *     history: deploy every migration up to the one before this project's first, seed the
 *     population there, deploy the rest, and compare `status` and `completion_criterion` row for
 *     row. The alternative — reading the five migration files and observing that none of them
 *     names `task.status` — is what a reader can already do, and it stops being true the moment a
 *     sibling task lands a sixth. The boundary here is the FIRST migration of this project rather
 *     than a fixed list, so a migration added after this file was written is covered by it without
 *     anybody remembering to come back.
 *
 *  2. THE REPORT QUERY ANSWERS THE QUESTION IT CLAIMS TO. `scripts/evidence-judgment-stalled-
 *     tasks.sql` is run as shipped against a seeded population, and every column it returns is
 *     recomputed from a different query — the count, `has_subtasks`, `declares_criterion` and the
 *     criterion named by `holds_up_criterion`.
 *
 * What is deliberately NOT here: any write that would settle, cancel or re-declare one of these
 * tasks. Migration 0228 removed the door that could satisfy EVIDENCE_JUDGMENT and this project
 * rebuilds it; until a holder decides, the correct behaviour towards 233 rows somebody else owns
 * is to list them and leave them alone.
 *
 * Destructive by design: it creates and drops a database of its own beside the case database, and
 * truncates the case database. Both are proved isolated before anything is written.
 */

const PG_URL = process.env.COORDINATOR_PG_URL;
const suite = PG_URL ? test : test.skip;

const API = path.resolve(__dirname, '../..');
const ROOT = path.resolve(__dirname, '../../../..');
const MIGRATIONS = path.join(API, 'prisma', 'migrations');
const PRISMA = path.join(API, 'node_modules', 'prisma', 'build', 'index.js');
const REPORT = path.join(ROOT, 'scripts', 'evidence-judgment-stalled-tasks.sql');

/**
 * The first migration of this project ("完成判据第三格"), created 2026-09-03T16:25Z. Everything
 * sorting at or after it is replayed as "this project's"; everything before it is the baseline the
 * population is seeded on. Naming one boundary rather than five files is what makes this cover a
 * migration nobody has written yet — including one from a sibling task in the same project, which
 * is exactly the case a frozen list would miss.
 */
const FIRST = '0232_task_criterion_declaration';

/** What that boundary selected when this was written, so a renamed or dropped file is noticed. */
const AT_WRITING = [
  '0232_task_criterion_declaration',
  '0233_project_acceptance_criterion_wiring_removal',
  '0234_project_acceptance_evaluation_plan_lane_removal',
  '0236_executable_acceptance_budget',
  '0237_task_completion_criterion_explicit_declaration',
];

const OWNER = '00000000-0000-7000-8000-0000000000a1';
const PROJECT = '00000000-0000-7000-8000-0000000000a2';

type Status = 'OPEN' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED' | 'FAILED';
type Criterion = 'EXECUTABLE' | 'VERIFICATION' | 'EVIDENCE_JUDGMENT';
type Policy = 'MANUAL' | 'ALL_CHILDREN_DONE' | 'VERIFICATION_PASSED';

interface Seed {
  readonly key: string;
  readonly status: Status;
  readonly criterion: Criterion;
  readonly policy: Policy;
  /** The key of the task this one is a subtask of — which is what gives THAT task subtasks. */
  readonly parent?: string;
  /** The ordinal of the project criterion this work says it serves. */
  readonly serves?: number;
  readonly executable?: boolean;
}

/**
 * One population covering every distinction either claim turns on: both live statuses, all three
 * policies, with and without subtasks, with and without a declared criterion — and four rows that
 * must NOT be listed, two on each side of the predicate.
 */
const POPULATION: readonly Seed[] = [
  { key: 'manual-childless-open', status: 'OPEN', criterion: 'EVIDENCE_JUDGMENT', policy: 'MANUAL' },
  { key: 'manual-childless-running', status: 'IN_PROGRESS', criterion: 'EVIDENCE_JUDGMENT', policy: 'MANUAL' },
  { key: 'rollup-with-child', status: 'OPEN', criterion: 'EVIDENCE_JUDGMENT', policy: 'ALL_CHILDREN_DONE' },
  { key: 'child-of-rollup', status: 'OPEN', criterion: 'EVIDENCE_JUDGMENT', policy: 'MANUAL', parent: 'rollup-with-child', serves: 1 },
  { key: 'rollup-childless', status: 'IN_PROGRESS', criterion: 'EVIDENCE_JUDGMENT', policy: 'VERIFICATION_PASSED', serves: 2 },
  // Outside it, and on both of its sides: a settled and a stopped status, then the two criteria
  // that do have an implementation to be judged by.
  { key: 'settled', status: 'DONE', criterion: 'EVIDENCE_JUDGMENT', policy: 'MANUAL' },
  { key: 'abandoned', status: 'CANCELLED', criterion: 'EVIDENCE_JUDGMENT', policy: 'MANUAL' },
  { key: 'executable-open', status: 'OPEN', criterion: 'EXECUTABLE', policy: 'MANUAL', executable: true, serves: 1 },
  { key: 'verification-open', status: 'OPEN', criterion: 'VERIFICATION', policy: 'VERIFICATION_PASSED' },
];

/** The predicate the report and the invariance check share, stated once. */
const STALLED = (seed: Seed): boolean =>
  seed.criterion === 'EVIDENCE_JUDGMENT' && (seed.status === 'OPEN' || seed.status === 'IN_PROGRESS');

const id = (key: string): string => {
  const index = POPULATION.findIndex((seed) => seed.key === key);
  assert.notEqual(index, -1, `no seed named ${key}`);
  return `00000000-0000-7000-8000-${String(index + 1).padStart(12, '0')}`;
};

/**
 * Ages run OPPOSITE to ids, so a report that orders by `created_at` and one that orders by `id`
 * cannot both be right and the ORDER BY is actually under test.
 */
const createdAt = (index: number): string =>
  new Date(Date.UTC(2026, 7, 1, 12, 0, 0) - index * 60_000).toISOString();

/** The order the report must return the stalled rows in: oldest first. */
const EXPECTED_ORDER = POPULATION
  .map((seed, index) => ({ seed, index }))
  .filter(({ seed }) => STALLED(seed))
  .sort((a, b) => b.index - a.index)
  .map(({ seed }) => seed.key);

interface Migrations {
  readonly baseline: string[];
  readonly project: string[];
}

function migrations(): Migrations {
  const all = readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  return {
    baseline: all.filter((name) => name < FIRST),
    project: all.filter((name) => name >= FIRST),
  };
}

function prisma(args: string[], env: NodeJS.ProcessEnv): void {
  try {
    execFileSync(process.execPath, [PRISMA, ...args], {
      cwd: API,
      timeout: 240_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: 'true', ...env },
    });
  } catch (error) {
    const failure = error as { stdout?: Buffer; stderr?: Buffer };
    assert.fail(`prisma ${args.join(' ')} failed:\n` +
      `${failure.stdout?.toString() ?? ''}\n${failure.stderr?.toString() ?? ''}`);
  }
}

async function connect(connectionString: string): Promise<Client> {
  const client = new Client({ connectionString, connectionTimeoutMillis: 10_000 });
  await client.connect();
  return client;
}

/**
 * A database of this case's own, beside the case database and carrying its name, so the pcc*
 * isolation the harness proved for one covers the other. Created empty rather than from the
 * template: the whole point is to start before the migrations under test.
 */
async function replayDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  assertCoordinatorPgUrlIsIsolated(PG_URL);
  const url = new URL(PG_URL);
  const name = `${decodeURIComponent(url.pathname.replace(/^\//, ''))}_ejr`;
  assert.ok(name.length <= 63, `replay database name ${name} exceeds PostgreSQL's identifier limit`);
  assert.match(name, /^pcc[0-9a-z]*[_-]/, 'the replay database must inherit the case pcc* prefix');

  const maintenance = new URL(PG_URL);
  maintenance.pathname = '/postgres';
  const admin = await connect(maintenance.href);
  const drop = async (): Promise<void> => {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`, [name]);
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
  };
  await drop();
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);

  const replay = new URL(PG_URL);
  replay.pathname = `/${name}`;
  return {
    url: replay.href,
    drop: async () => { await drop(); await admin.end(); },
  };
}

/** The migration directory as it stood before this project, assembled from the shipped files. */
function baselineTree(baseline: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'evidence-judgment-frontier-'));
  cpSync(path.join(API, 'prisma', 'schema.prisma'), path.join(dir, 'schema.prisma'));
  mkdirSync(path.join(dir, 'migrations'));
  cpSync(path.join(MIGRATIONS, 'migration_lock.toml'), path.join(dir, 'migrations', 'migration_lock.toml'));
  for (const name of baseline) {
    cpSync(path.join(MIGRATIONS, name), path.join(dir, 'migrations', name), { recursive: true });
  }
  return dir;
}

async function seedPopulation(client: Client, withDeclarations: boolean): Promise<void> {
  await client.query(
    `INSERT INTO "user" (id, email, name, password_hash) VALUES ($1, $2, 'stalled', 'x')`,
    [OWNER, `${OWNER}@stalled.invalid`]);
  await client.query(
    `INSERT INTO "project" (id, owner_id, title, updated_at) VALUES ($1, $2, 'stalled', now())`,
    [PROJECT, OWNER]);
  // Parents before children: `parent_task_id` is a foreign key onto this same table.
  const ordered = [...POPULATION].sort((a, b) => Number(Boolean(a.parent)) - Number(Boolean(b.parent)));
  for (const seed of ordered) {
    await client.query(
      `INSERT INTO "task"
         (id, owner_id, project_id, title, created_at, updated_at, creator_type, creator_id,
          status, completion_criterion, completion_policy, parent_task_id,
          acceptance_command, acceptance_expected_exit_code, completion_fence_revision)
       VALUES ($1, $2, $3, $4, $5, now(), 'USER', $2, $6::task_status,
               $7::task_completion_criterion, $8::task_completion_policy, $9, $10, $11, 1)`,
      [id(seed.key), OWNER, PROJECT, seed.key, createdAt(POPULATION.indexOf(seed)),
        seed.status, seed.criterion, seed.policy, seed.parent ? id(seed.parent) : null,
        seed.executable ? 'npm run test:outcome-reconciler:full-api' : null,
        seed.executable ? 0 : null]);
  }
  if (!withDeclarations) return;
  for (const ordinal of [1, 2]) {
    await client.query(
      `INSERT INTO "project_acceptance_criterion_definition"
         (id, project_id, ordinal, text, verification_method, content_hash)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [`00000000-0000-7000-8000-${String(900 + ordinal).padStart(12, '0')}`, PROJECT, ordinal,
        `criterion ${ordinal}`, `method ${ordinal}`, 'f'.repeat(64)]);
  }
  for (const seed of POPULATION) {
    if (seed.serves === undefined) continue;
    await client.query(
      `UPDATE "task" SET "criterion_definition_id" = d."id", "criterion_revision" = d."revision"
         FROM "project_acceptance_criterion_definition" d
        WHERE "task"."id" = $1 AND d."project_id" = $2 AND d."ordinal" = $3`,
      [id(seed.key), PROJECT, seed.serves]);
  }
}

interface Row { id: string; status: string; criterion: string }

/** The cohort, exactly as the acceptance criterion words it. */
async function cohort(client: Client): Promise<Row[]> {
  return (await client.query<Row>(
    `SELECT "id"::text AS id, "status"::text AS status,
            "completion_criterion"::text AS criterion
       FROM "task"
      WHERE "completion_criterion" = 'EVIDENCE_JUDGMENT'
        AND "status" IN ('OPEN', 'IN_PROGRESS')
      ORDER BY "id"`)).rows;
}

suite('this project\'s migrations leave every stalled EVIDENCE_JUDGMENT row exactly as it was', async (t) => {
  const { baseline, project } = migrations();
  assert.deepEqual(project.filter((name) => AT_WRITING.includes(name)), AT_WRITING,
    'a migration this boundary selected when it was written is no longer there under that name');
  assert.ok(baseline.length > 0 && baseline.at(-1)! < FIRST);

  const database = await replayDatabase();
  const tree = baselineTree(baseline);
  // One hook, in this order: dropping the database terminates every backend on it, so a client
  // still holding one would be torn down under itself and report the disconnect as an uncaught
  // error long after the assertions had passed.
  let open: Client | null = null;
  t.after(async () => {
    await open?.end();
    await database.drop();
    rmSync(tree, { recursive: true, force: true });
  });

  prisma(['migrate', 'deploy', '--config', path.join(API, 'prisma.frontier.config.ts')], {
    DATABASE_URL: database.url,
    ORBIT_FRONTIER_PRISMA_SCHEMA: path.join(tree, 'schema.prisma'),
    ORBIT_FRONTIER_PRISMA_MIGRATIONS: path.join(tree, 'migrations'),
  });

  const client = await connect(database.url);
  open = client;
  const applied = async (): Promise<string[]> => (await client.query<{ name: string }>(
    `SELECT "migration_name" AS name FROM "_prisma_migrations"
      WHERE "finished_at" IS NOT NULL ORDER BY "migration_name"`)).rows.map((row) => row.name);
  assert.deepEqual(await applied(), baseline, 'the baseline frontier is not where it was asked to stop');
  // The column this project added does not exist yet, which is the sense in which the population
  // below is genuinely "before".
  assert.equal((await client.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'task'
        AND column_name = 'criterion_definition_id'`)).rowCount, 0);

  await seedPopulation(client, false);
  const before = await cohort(client);
  assert.equal(before.length, POPULATION.filter(STALLED).length);
  assert.ok(before.length > 0, 'a comparison over an empty cohort would prove nothing');

  prisma(['migrate', 'deploy', '--schema', path.join(API, 'prisma', 'schema.prisma')],
    { DATABASE_URL: database.url });
  assert.deepEqual(await applied(), [...baseline, ...project].sort(),
    'the second deploy did not apply exactly this project\'s migrations');

  // The claim, row for row and in both directions: no row's status or criterion moved, no row
  // joined the cohort, and no row left it.
  assert.deepEqual(await cohort(client), before);
  // And no OTHER task row was rewritten into or out of the population either.
  assert.equal((await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM "task"`)).rows[0].n, String(POPULATION.length));

  // Negative control, on the real comparison and a real write: the same UPDATE a migration would
  // have to make is made here and rolled back. Without this, `deepEqual` passing would be
  // consistent with a comparison that cannot see anything.
  const [first, second] = before;
  await client.query('BEGIN');
  await client.query(`UPDATE "task" SET "status" = 'CANCELLED' WHERE "id" = $1`, [first.id]);
  await client.query(
    `UPDATE "task" SET "completion_criterion" = 'VERIFICATION' WHERE "id" = $1`, [second.id]);
  const mutated = await cohort(client);
  assert.notDeepEqual(mutated, before, 'the comparison cannot see a status or criterion rewrite');
  assert.equal(mutated.length, before.length - 2);
  await client.query('ROLLBACK');
  assert.deepEqual(await cohort(client), before);
});

suite('the report query lists exactly the stalled rows, and every mark it prints is recomputable', async (t) => {
  assertCoordinatorPgUrlIsIsolated(PG_URL);
  const client = await connect(PG_URL);
  t.after(async () => { await client.end(); });
  await verifyCoordinatorPgIdentity(client);
  await client.query('TRUNCATE "user" RESTART IDENTITY CASCADE');
  await seedPopulation(client, true);

  interface Reported {
    task_id: string;
    title: string;
    completion_policy: string;
    has_subtasks: boolean;
    declares_criterion: boolean;
    holds_up_criterion: string | null;
  }
  const reported = (await client.query<Reported>(readFileSync(REPORT, 'utf8'))).rows;

  // (1) The count and the membership, against the predicate read off the fixture.
  assert.deepEqual(reported.map((row) => row.title), EXPECTED_ORDER);
  assert.equal(reported.length, POPULATION.filter(STALLED).length);
  for (const seed of POPULATION.filter((candidate) => !STALLED(candidate))) {
    assert.ok(!reported.some((row) => row.task_id === id(seed.key)),
      `${seed.key} is ${seed.status}/${seed.criterion} and must not be listed`);
  }

  // (2) `has_subtasks`, recomputed from the other end of the same edge: the set of task ids that
  // appear as somebody's parent. The report asks EXISTS per row; this asks once, globally.
  const parents = new Set((await client.query<{ parent: string }>(
    `SELECT DISTINCT "parent_task_id"::text AS parent FROM "task"
      WHERE "parent_task_id" IS NOT NULL`)).rows.map((row) => row.parent));
  assert.deepEqual([...parents], [id('rollup-with-child')], 'the fixture lost its one parent');

  // (3) `declares_criterion` and the criterion named, recomputed from the criterion table.
  const declared = new Map((await client.query<{ task: string; label: string }>(
    `SELECT t."id"::text AS task,
            format('%s ordinal=%s revision=%s', d."id", d."ordinal", d."revision") AS label
       FROM "project_acceptance_criterion_definition" d
       JOIN "task" t ON t."criterion_definition_id" = d."id"`
  )).rows.map((row) => [row.task, row.label] as const));
  assert.equal(declared.size, POPULATION.filter((seed) => seed.serves !== undefined).length);

  for (const row of reported) {
    const seed = POPULATION.find((candidate) => id(candidate.key) === row.task_id)!;
    assert.equal(row.completion_policy, seed.policy);
    assert.equal(row.has_subtasks, parents.has(row.task_id));
    assert.equal(row.has_subtasks, POPULATION.some((child) => child.parent === seed.key));
    assert.equal(row.declares_criterion, declared.has(row.task_id));
    assert.equal(row.declares_criterion, seed.serves !== undefined);
    assert.equal(row.holds_up_criterion, declared.get(row.task_id) ?? null);
  }

  // The mark the inventory is actually about: EVIDENCE_JUDGMENT with no subtasks has no route to
  // DONE at all, because AG4 makes a policy on a childless task inert.
  assert.deepEqual(reported.filter((row) => !row.has_subtasks).map((row) => row.title),
    ['rollup-childless', 'child-of-rollup', 'manual-childless-running', 'manual-childless-open']);
});
