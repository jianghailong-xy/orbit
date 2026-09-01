import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { PrismaClient, TaskCompletionCriterion } from '@prisma/client';
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
  'project_acceptance_criteria_confirmation',
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

function criterion(text: string) {
  return {
    text,
    verificationMethod: 'A person reads the delivered work against this assertion.',
    completionCriterion: TaskCompletionCriterion.HUMAN_SIGNOFF,
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

test('every project_acceptance_* relation the proposal protected is still installed, with the '
  + 'two columns that carry the ruler', { skip }, async () => {
  const tables = await catalog<{ relname: string }>(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'project_acceptance%'
      ORDER BY 1`,
  );
  assert.deepEqual(tables.map((row) => row.relname), ACCEPTANCE_TABLES,
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
      const controller = new RunnerProjectsController(projects, acceptance, {} as never);

      await projects.update(target.ownerId, target.projectId, {
        acceptanceCriteriaItems: [criterion('The corpus is indexed end to end.')],
      } as never);
      assert.deepEqual(await inForce(db, target.projectId),
        ['The corpus is indexed end to end.']);

      // ONE call through the agent's own door, with no acting session and no second step.
      const response = await controller.updateProject(runner, target.projectId, undefined, {
        acceptanceCriteriaItems: [criterion('The corpus is indexed AND deduplicated.')],
      } as never) as Record<string, unknown>;

      // In force immediately: read straight back, with nothing approved in between.
      assert.deepEqual(await inForce(db, target.projectId),
        ['The corpus is indexed AND deduplicated.'],
        'the acceptance criteria an agent sent are the ones now judging this project');
      // And the response says so plainly rather than reporting a pending card.
      for (const key of
        ['acceptanceCriteriaProposal', 'acceptanceCriteriaApplied', 'acceptanceCriteriaNote']) {
        assert.equal(key in response, false, `the response still reports ${key}`);
      }
      assert.equal(response.id, target.projectId);
      assert.deepEqual(
        (response.acceptanceCriteriaItems as Array<{ text: string }> | undefined)
          ?.map((item) => item.text),
        ['The corpus is indexed AND deduplicated.'],
      );

      // `[]` is a clear again. It was refused for as long as it had to be a proposal an owner
      // could answer, and a project measured by nothing was not one.
      await controller.updateProject(runner, target.projectId, undefined,
        { acceptanceCriteriaItems: [] } as never);
      assert.deepEqual(await inForce(db, target.projectId), []);
    } finally {
      await db.$disconnect();
    }
  });
