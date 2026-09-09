import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { RunnerProjectsController } from '../runner-api/runner-projects.controller';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectsService } from './projects.service';

/**
 * The acceptance-criteria proposal channel, proved gone against the schema that actually exists,
 * and the write it used to intercept, proved direct.
 *
 * `outcome-reconciler/criteria-proposal-removal.spec.ts` replays the migration history and scans
 * the tree; this file asks the migrated database. The two answer different questions: a `DROP`
 * statement that never ran, or a function some later migration quietly recreated, would pass the
 * text scan and fail here.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const PROPOSAL_FUNCTIONS = [
  'project_acceptance_criteria_set_digest',
  'project_apply_criteria_proposal',
  'project_criteria_proposal_card',
  'project_criteria_proposal_diff',
  'project_criteria_proposal_effective_criteria',
  'project_criteria_proposal_normalize',
  'project_criteria_proposal_state_json',
  'project_owner_decide_criteria_proposal',
  'project_propose_acceptance_criteria',
];

/** Every relation the account owner said must survive the removal, and nothing else. */
const ACCEPTANCE_TABLES = [
  'project_acceptance_audit',
  'project_acceptance_conclusion',
  'project_acceptance_criterion',
  'project_acceptance_criterion_definition',
  'project_acceptance_run',
];

let safety: Promise<void> | undefined;
async function verifyDisposableDatabase(): Promise<void> {
  if (safety) return safety;
  safety = (async () => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const client = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
    await client.connect();
    try {
      await verifyCoordinatorPgIdentity(client);
    } finally {
      await client.end();
    }
  })();
  return safety;
}

async function connect() {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const acceptance = new ProjectAcceptanceService(db as unknown as PrismaService);
  return {
    db,
    acceptance,
    projects: new ProjectsService(db as unknown as PrismaService, acceptance),
  };
}

async function catalog<T>(query: string, values: unknown[] = []): Promise<T[]> {
  await verifyDisposableDatabase();
  const client = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
  await client.connect();
  try {
    return (await client.query(query, values)).rows as T[];
  } finally {
    await client.end();
  }
}

async function base(db: PrismaClient, label: string) {
  const ownerId = randomUUID();
  const projectId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `${label}-${ownerId}@criteria-proposal-removal.invalid`,
      name: label,
      passwordHash: 'x',
    },
  });
  await db.project.create({
    data: { id: projectId, ownerId, title: `${label} project`, goal: `Prove ${label}` },
  });
  return { ownerId, projectId };
}

function criterion(text: string, verificationMethod?: string) {
  return {
    text,
    // A rung of the HUMAN → VERIFICATION → EXECUTABLE ladder where a case needs an edit that
    // TAKES EFFECT. Since the weakening door was wired, the ordinary write path applies an edit
    // only when it walks the ruler toward strictness; the cases below therefore state criteria by
    // ADDING or by PROMOTING, and the ones that drop a criterion assert what a held edit leaves
    // behind. None of that is the proposal channel coming back — see the header.
    verificationMethod:
      verificationMethod ?? 'A person reads the delivered work against this assertion.',
  };
}

/** The criteria in force, in the order they are stated. */
async function inForce(db: PrismaClient, projectId: string): Promise<string[]> {
  const rows = await db.projectAcceptanceCriterionDefinition.findMany({
    where: { projectId },
    orderBy: { ordinal: 'asc' },
    select: { text: true },
  });
  return rows.map((row) => row.text);
}

test('the proposal relation, its indexes and its nine functions are absent from the schema',
  { skip }, async () => {
    const [relation] = await catalog<{ oid: string | null }>(
      "SELECT to_regclass('public.project_criteria_proposal')::text AS oid",
    );
    assert.equal(relation?.oid, null, 'project_criteria_proposal is still installed');

    const indexes = await catalog<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'i' AND c.relname LIKE 'project_criteria_proposal%'
        ORDER BY 1`,
    );
    assert.deepEqual(indexes.map((row) => row.relname), [],
      'an index of the dropped relation survived it');

    const functions = await catalog<{ proname: string }>(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = ANY($1::text[]) ORDER BY 1`,
      [PROPOSAL_FUNCTIONS],
    );
    assert.deepEqual(functions.map((row) => row.proname), []);

    // Nothing left BEHIND either: no surviving function body still calls one of the nine, which is
    // what a half-removal would look like from the database's side.
    const callers = await catalog<{ proname: string }>(
      `SELECT DISTINCT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND (p.prosrc ~ 'criteria_proposal' OR p.prosrc ~ 'project_acceptance_criteria_set_digest')
        ORDER BY 1`,
    );
    assert.deepEqual(callers.map((row) => row.proname), []);
  });

test('the project_acceptance_* relation the proposal protected is still installed, with the '
  + 'two columns that carry the ruler', { skip }, async () => {
  const tables = await catalog<{ relname: string }>(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'project_acceptance%'
      ORDER BY 1`,
  );
  // The four judgment relations that stood beside it were dropped by 0229 — a later and separate
  // account-owner decision, and one 0223 issued no statement about. What 0223 was protecting is
  // the ruler, and the ruler is what is left.
  assert.deepEqual(tables.map((row) => row.relname), ['project_acceptance_criterion_definition'],
    'the removal reached a project_acceptance_* relation');

  const columns = await catalog<{ attname: string }>(
    `SELECT a.attname FROM pg_attribute a
      WHERE a.attrelid = 'public.project_acceptance_criterion_definition'::regclass
        AND a.attnum > 0 AND NOT a.attisdropped AND a.attname IN ('text', 'verification_method')
      ORDER BY 1`,
  );
  assert.deepEqual(columns.map((row) => row.attname), ['text', 'verification_method'],
    'the two fields the account owner named must be exactly as they were');
});

test('project_update writes acceptance criteria directly: one call, in force, no confirmation',
  { skip }, async () => {
    const { db, acceptance, projects } = await connect();
    try {
      const target = await base(db, 'direct-write');
      const runner = { id: randomUUID(), ownerId: target.ownerId } as never;
      // The acceptance service is the real one and is handed to the controller, so a route that
      // still diverted criteria into a proposal would reach a function that no longer exists.
      const controller = new RunnerProjectsController(projects, acceptance, {} as never, {} as never);

      const first: any = await projects.update(target.ownerId, target.projectId, {
        acceptanceCriteriaItems: [criterion('The corpus is indexed end to end.')],
      } as never);
      assert.deepEqual(await inForce(db, target.projectId),
        ['The corpus is indexed end to end.']);

      // ONE call through the agent's own door, with no acting session and no second step. The
      // whole collection restated with one criterion added — a tightening, which is the walk the
      // ruler may take on its own and so the shape that still lands in one call. The criterion
      // already on record is restated UNDER ITS OWN ID: an item with no id is one being added, so
      // omitting it would read as dropping that criterion and adding a lookalike, which is a
      // loosening and would be held.
      const response = await controller.updateProject(runner, target.projectId, undefined, {
        acceptanceCriteriaItems: [
          { id: first.acceptanceCriteriaItems[0].id, ...criterion('The corpus is indexed end to end.') },
          criterion('The corpus is deduplicated.'),
        ],
      } as never) as Record<string, unknown>;

      // In force immediately: read straight back, with nothing approved in between.
      assert.deepEqual(await inForce(db, target.projectId),
        ['The corpus is indexed end to end.', 'The corpus is deduplicated.'],
        'the acceptance criteria an agent sent are the ones now judging this project');
      // And the response says so plainly rather than reporting a pending card.
      for (const key of ['acceptanceCriteriaProposal', 'acceptanceCriteriaApplied',
        'acceptanceCriteriaNote', 'acceptanceCriteriaHold']) {
        assert.equal(key in response, false, `the response still reports ${key}`);
      }
      assert.equal(response.id, target.projectId);
      assert.deepEqual(
        (response.acceptanceCriteriaItems as Array<{ text: string }> | undefined)
          ?.map((item) => item.text),
        ['The corpus is indexed end to end.', 'The corpus is deduplicated.'],
      );

    } finally {
      await db.$disconnect();
    }
  });

test('a second write replaces the set rather than appending to it', { skip }, async () => {
  const { db, acceptance, projects } = await connect();
  try {
    const target = await base(db, 'whole-collection');
    const runner = { id: randomUUID(), ownerId: target.ownerId } as never;
    const controller = new RunnerProjectsController(projects, acceptance, {} as never, {} as never);

    await controller.updateProject(runner, target.projectId, undefined, {
      acceptanceCriteriaItems: [criterion('First'), criterion('Second')],
    } as never);
    assert.deepEqual(await inForce(db, target.projectId), ['First', 'Second']);

    // Whole-collection replacement is what both the MCP and CLI copy now promise, and this is the
    // write that tells replacement from appending: a path that APPENDED would leave three
    // criteria here. It leaves two — the two that were already there — because a replacement that
    // drops a criterion is a loosening, and a loosening is held for the account owner rather than
    // applied (`criteria-weakening-intent.pg.spec.ts`). What it is NOT, either way, is a criterion
    // this call added to the set.
    const response = await controller.updateProject(runner, target.projectId, undefined, {
      acceptanceCriteriaItems: [criterion('Only this one')],
    } as never) as Record<string, unknown>;
    assert.deepEqual(await inForce(db, target.projectId), ['First', 'Second'],
      'the collection is stated whole; nothing was appended to it');
    const held = response.acceptanceCriteriaHold as { applied: boolean } | undefined;
    assert.ok(held, 'and the caller is told its edit did not take effect');
    assert.equal(held.applied, false);
  } finally {
    await db.$disconnect();
  }
});

// `[]` was refused for as long as `acceptanceCriteriaItems` had to be a proposal an owner could
// answer, and a project measured by nothing was not one. It is not refused any more — the
// refusal 0223 removed has not come back. Clearing every criterion is the largest loosening
// there is, so what the call gets is a 200 and a held edit, not a 400.
test('an empty structured set is accepted rather than refused, and is held', { skip }, async () => {
  const { db, acceptance, projects } = await connect();
  try {
    const target = await base(db, 'empty-clears');
    const runner = { id: randomUUID(), ownerId: target.ownerId } as never;
    const controller = new RunnerProjectsController(projects, acceptance, {} as never, {} as never);

    await controller.updateProject(runner, target.projectId, undefined, {
      acceptanceCriteriaItems: [criterion('Something to clear')],
    } as never);
    assert.deepEqual(await inForce(db, target.projectId), ['Something to clear']);

    const response = await controller.updateProject(runner, target.projectId, undefined,
      { acceptanceCriteriaItems: [] } as never) as Record<string, unknown>;
    // Not a refusal: the call answered with the project, as it has since 0223.
    assert.equal(response.id, target.projectId);
    const held = response.acceptanceCriteriaHold as { applied: boolean } | undefined;
    assert.ok(held, 'an emptied ruler is held for the account owner rather than refused');
    assert.equal(held.applied, false);
    assert.deepEqual(await inForce(db, target.projectId), ['Something to clear'],
      'and the criteria that were in force still are');
  } finally {
    await db.$disconnect();
  }
});

// The acceptance overview read `project_acceptance_criteria_set_digest` for its `criteriaDigest`
// until 0223 dropped that function with the rest of the channel. It reads `acceptance_criteria_
// digest` again -- the 0189 column, which is where the field came from before 0218 introduced
// the proposal-facing one. Exercised end to end because a
// dropped function behind a `$queryRaw` is not a compile error, it is a 500 in production.
test('the project read still reports the criteria set, and it is the one just written',
  { skip }, async () => {
    const { db, acceptance, projects } = await connect();
    try {
      const target = await base(db, 'overview-digest');
      const runner = { id: randomUUID(), ownerId: target.ownerId } as never;
      const controller = new RunnerProjectsController(projects, acceptance, {} as never, {} as never);

      // Stated on a RUNG of the ladder, because the second write below promotes it: a method that
      // is free prose on either side of an edit is a direction nothing can read, and an edit whose
      // direction cannot be read is held rather than applied.
      await controller.updateProject(runner, target.projectId, undefined, {
        acceptanceCriteriaItems: [criterion('The first standard', 'VERIFICATION')],
      } as never);
      const before: any = await projects.get(target.ownerId, target.projectId);
      assert.deepEqual(
        before.acceptanceCriteriaItems.map((c: { text: string }) => c.text),
        ['The first standard']);

      // The exam rather than the assertion, promoted up the ladder and under the criterion's own
      // id: that is the edit that still lands, and it moves `content_hash`, which is what this
      // case is really reading.
      await controller.updateProject(runner, target.projectId, undefined, {
        acceptanceCriteriaItems: [{
          id: before.acceptanceCriteriaItems[0].id,
          ...criterion('The first standard', 'EXECUTABLE'),
        }],
      } as never);
      const after: any = await projects.get(target.ownerId, target.projectId);
      assert.deepEqual(
        after.acceptanceCriteriaItems.map(
          (c: { text: string; verificationMethod: string }) => [c.text, c.verificationMethod],
        ),
        [['The first standard', 'EXECUTABLE']],
        'the read must show the set the write left, not the one it replaced');
      assert.notEqual(after.acceptanceCriteriaItems[0].contentHash,
        before.acceptanceCriteriaItems[0].contentHash,
        'moving the ruler must move the content hash that names it');
    } finally {
      await db.$disconnect();
    }
  });
