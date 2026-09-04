import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Prisma, PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectsService } from './projects.service';

/**
 * Migration 0229, against the catalog of a fully migrated, disposable PostgreSQL: the project
 * acceptance JUDGMENT is gone and the project acceptance CRITERIA are not.
 *
 * The two are one word apart in the schema — `project_acceptance_criterion` was a run's
 * per-criterion verdict row and is dropped; `project_acceptance_criterion_definition` is the
 * authored criterion itself and is kept, all 274 rows of it across 41 projects on the deployment
 * this was written against. So the preservation is asserted as loudly as the removal, on the same
 * database, in the same file.
 *
 *   COORDINATOR_PG_URL=postgresql://... \
 *   COORDINATOR_PG_EXPECTED_DATABASE=pcc... \
 *   COORDINATOR_PG_EXPECTED_USER=pcc... \
 *   COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=... \
 *   node --test build/projects/project-acceptance-judgment-removal.pg.spec.js
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** The four tables 0229 drops. Named here so a reader can see that the fifth is not among them. */
const REMOVED_TABLES = [
  'project_acceptance_run',
  'project_acceptance_criterion',
  'project_acceptance_conclusion',
  'project_acceptance_audit',
];

/** The sixteen functions that served them, plus the legacy blob's parser pair. */
const REMOVED_FUNCTIONS = [
  'project_acceptance_done_gate',
  'project_acceptance_advance_epoch',
  'project_acceptance_epoch_audit',
  'project_acceptance_criteria_fact',
  'project_acceptance_standing',
  'project_acceptance_is_pass',
  'project_acceptance_reopen',
  'project_acceptance_run_epoch',
  'project_acceptance_run_immutable',
  'project_acceptance_criterion_immutable',
  'project_acceptance_conclusion_immutable',
  'project_acceptance_conclusion_reconcile',
  'project_acceptance_conclusion_validate',
  'project_acceptance_audit_append_only',
  'project_acceptance_parse_legacy',
  'project_acceptance_sync_legacy_definitions',
];

/** The six that serve the criterion DEFINITIONS, and are kept for that reason. */
const PRESERVED_FUNCTIONS = [
  'project_acceptance_definition_normalize',
  'project_acceptance_definition_content_hash',
  'project_acceptance_definition_digest',
  'project_acceptance_definition_semantic_hash',
  'project_acceptance_definition_evaluation_plan_hash',
  'project_acceptance_definition_projection',
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

async function connect(): Promise<{
  db: PrismaClient;
  acceptance: ProjectAcceptanceService;
  projects: ProjectsService;
}> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const acceptance = new ProjectAcceptanceService(db as unknown as PrismaService);
  return { db, acceptance, projects: new ProjectsService(db as unknown as PrismaService, acceptance) };
}

async function fixture(db: PrismaClient, label: string) {
  const ownerId = randomUUID();
  const projectId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `${label}-${ownerId}@acceptance-removal.invalid`,
      name: label,
      passwordHash: 'x',
    },
  });
  await db.project.create({ data: { id: projectId, ownerId, title: `${label} project` } });
  return { ownerId, projectId };
}

test('the four judgment tables are gone, and the criterion definitions are not', { skip }, async () => {
  const { db } = await connect();
  try {
    const present = await db.$queryRaw<Array<{ relname: string }>>(Prisma.sql`
      SELECT c."relname" FROM "pg_class" c
       JOIN "pg_namespace" n ON n."oid" = c."relnamespace"
       WHERE n."nspname" = 'public' AND c."relkind" IN ('r', 'v', 'm', 'p')
         AND c."relname" LIKE 'project_acceptance%'
       ORDER BY c."relname"`);
    const names = present.map((row) => row.relname);

    for (const gone of REMOVED_TABLES) {
      assert.equal(names.includes(gone), false, `${gone} survives 0229`);
    }
    // Stated separately and positively, because the disaster this change could produce is deleting
    // the declaration table by mistaking it for the per-run verdict table one word shorter.
    assert.deepEqual(names, ['project_acceptance_criterion_definition']);

    const enums = await db.$queryRaw<Array<{ typname: string }>>(Prisma.sql`
      SELECT t."typname" FROM "pg_type" t WHERE t."typname" = 'project_acceptance_verdict'`);
    assert.deepEqual(enums, [], 'the verdict enum outlived the three columns it typed');
  } finally {
    await db.$disconnect();
  }
});

test('every judgment function is gone and every definition function is kept', { skip }, async () => {
  const { db } = await connect();
  try {
    const rows = await db.$queryRaw<Array<{ proname: string }>>(Prisma.sql`
      SELECT p."proname" FROM "pg_proc" p
       JOIN "pg_namespace" n ON n."oid" = p."pronamespace"
       WHERE n."nspname" = 'public' AND p."proname" LIKE 'project_acceptance%'
       ORDER BY p."proname"`);
    const names = rows.map((row) => row.proname);

    for (const gone of REMOVED_FUNCTIONS) {
      assert.equal(names.includes(gone), false, `${gone}() survives 0229`);
    }
    for (const kept of PRESERVED_FUNCTIONS) {
      assert.ok(names.includes(kept), `${kept}() was removed with the judgment it does not serve`);
    }
    assert.deepEqual([...names].sort(), [...PRESERVED_FUNCTIONS].sort(),
      'the surviving set is exactly the six that serve the criterion definitions');
  } finally {
    await db.$disconnect();
  }
});

test('the criterion definition table keeps its trigger and every column of its shape',
  { skip }, async () => {
    const { db } = await connect();
    try {
      const triggers = await db.$queryRaw<Array<{ tgname: string }>>(Prisma.sql`
        SELECT t."tgname" FROM "pg_trigger" t
         WHERE t."tgrelid" = 'project_acceptance_criterion_definition'::regclass
           AND NOT t."tgisinternal"
         ORDER BY t."tgname"`);
      assert.ok(triggers.some((t) => t.tgname === 'project_acceptance_definition_normalize'),
        'the normalize trigger went with the judgment it does not serve');

      const columns = await db.$queryRaw<Array<{ column_name: string }>>(Prisma.sql`
        SELECT "column_name" FROM "information_schema"."columns"
         WHERE "table_schema" = 'public'
           AND "table_name" = 'project_acceptance_criterion_definition'
         ORDER BY "ordinal_position"`);
      // Migration 0233 took the four wiring columns out of this shape —
      // `completion_criterion`, `acceptance_command`, `acceptance_expected_exit_code` and
      // `evidence_task_id`. Still the whole table in ordinal order, still exact: the point of this
      // census is that nobody adds or removes a column without saying so here.
      assert.deepEqual(columns.map((c) => c.column_name), [
        'id', 'project_id', 'ordinal', 'text', 'revision', 'content_hash',
        'created_at', 'updated_at', 'verification_method',
        'completion_criterion_override_reason', 'semantic_revision', 'semantic_hash',
        'evaluation_plan_revision', 'evaluation_plan_hash',
      ]);
    } finally {
      await db.$disconnect();
    }
  });

// The positive case, end to end and through the service the API uses: a criterion is authored,
// normalized by the trigger that stayed, and read back — with nothing that concludes anything
// about it.
test('project_update writes the criteria and project_get reads them back', { skip }, async () => {
  const { db, projects } = await connect();
  try {
    const target = await fixture(db, 'authoring');

    await projects.update(target.ownerId, target.projectId, {
      acceptanceCriteriaItems: [
        {
          text: 'The image boots',
          verificationMethod: 'Run the image smoke test and require a clean exit.',
          completionCriterionOverrideReason: 'A person judges the visible product behaviour',
        },
        {
          text: 'The suite is green',
          verificationMethod: 'Run npm test and require exit code 0.',
          completionCriterionOverrideReason: 'A person judges the reported result',
        },
      ],
    } as never);

    const read: any = await projects.get(target.ownerId, target.projectId);
    assert.deepEqual(read.acceptanceCriteriaItems.map((c: { text: string }) => c.text),
      ['The image boots', 'The suite is green']);
    // The trigger that stayed did its work: hashes and revisions are the database's, not the
    // caller's.
    for (const item of read.acceptanceCriteriaItems) {
      assert.match(item.contentHash, /^[0-9a-f]{64}$/);
      assert.match(item.semanticHash, /^[0-9a-f]{64}$/);
      assert.match(item.evaluationPlanHash, /^[0-9a-f]{64}$/);
      assert.equal(item.revision, 1);
    }
    // And nothing beside them concludes anything.
    assert.equal('acceptance' in read, false);
    assert.equal('acceptanceCriteria' in read, false);
  } finally {
    await db.$disconnect();
  }
});

test('the PostgreSQL target is a disposable database', { skip }, verifyDisposableDatabase);
