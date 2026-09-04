/**
 * T6 on real PostgreSQL: the criterion loses its evaluation-plan lane, and the contract keeps its.
 *
 * `project_acceptance_criterion_definition` carried a second version/hash pair —
 * `evaluation_plan_revision` and `evaluation_plan_hash` — beside the semantic one. When 0195 split
 * the two lanes, the evaluation-plan side hashed the commands, the verifier prose and the evidence
 * wiring. Migration 0233 removed `completion_criterion`, `acceptance_command`,
 * `acceptance_expected_exit_code` and `evidence_task_id`, which left `verification_method` as its
 * only remaining input — a lane that no longer distinguishes anything the semantic lane does not.
 * The account owner decided to remove it, and migration 0234 does.
 *
 * Why this is a `.pg.spec` and not a unit test. Four of the six claims are claims about the
 * database catalog — which columns exist, how many, which trigger fires on which column list — and
 * one is a claim about plpgsql that only executing it can settle: `DROP COLUMN` does not touch a
 * function body, so a normalize trigger still assigning `NEW."evaluation_plan_hash"` deploys
 * cleanly and fails on the next INSERT anybody performs. A stubbed Prisma proves none of that.
 *
 * The two halves this file states together, on purpose:
 *
 *   * What went and what stayed, in one assertion. `evaluation_plan_revision` is spelled the same
 *     on two tables and typed differently on each: INTEGER on the criterion, which this removal
 *     takes, and BIGINT on `project_completion_contract`, which is the contract-level plan lane and
 *     is not in the decision at all. Asserting only the absence would pass just as well after a
 *     removal that took the wrong one, or took `semantic_hash` along for the ride.
 *
 *   * The frozen design contract. `contracts/outcome-reconciler-v2.contract.json` still listed
 *     `criteriaTrust` (from the `completion_criterion` 0233 dropped), `commands` (from
 *     `acceptance_command` + its exit code) and `evidenceWiring` (from `evidence_task_id`) as
 *     digest material. Nothing binds that digest to the live snapshot, so it cannot go red on its
 *     own — which is the reason to state it here rather than the reason to leave it.
 *
 * Destructive: it truncates. COORDINATOR_PG_URL must name the disposable guarded database with
 * current migrations applied. The full-api harness supplies it:
 *
 *   PATH=/opt/node26/bin:$PATH \
 *   OUTCOME_RELEASE_API_SPEC_REGEX='project-acceptance-evaluation-plan-removal\.pg\.spec\.js$' \
 *   OUTCOME_RELEASE_API_JOBS=1 bash scripts/outcome-reconciler-full-api.sh
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import { ProjectsService } from './projects.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** build/projects -> build -> apiserver -> src -> repository root. */
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CONTRACT = 'contracts/outcome-reconciler-v2.contract.json';

/** The two columns migration 0234 removes, spelled as the database spelled them. */
const REMOVED_COLUMNS = ['evaluation_plan_hash', 'evaluation_plan_revision'] as const;

/**
 * What a criterion still carries, and what a removal that reached one column too far would take.
 *
 * `completion_criterion_override_reason` is on this list because the account owner decided to keep
 * it: it is the advisory audit for a declaration 0233 already removed, and the seven criteria of
 * this project's own record say in that very field why the evidence is worth keeping.
 * `content_hash` is on it because nothing reads it any more and this project deliberately does not
 * fix that inconsistency — "unread" is not "removable" without a decision that was never made.
 */
const KEPT_COLUMNS = [
  'completion_criterion_override_reason',
  'content_hash',
  'revision',
  'semantic_hash',
  'semantic_revision',
  'text',
  'verification_method',
] as const;

/** The whole table after 0234, in ordinal order. */
const TABLE_SHAPE = [
  'id', 'project_id', 'ordinal', 'text', 'revision', 'content_hash',
  'created_at', 'updated_at', 'verification_method',
  'completion_criterion_override_reason', 'semantic_revision', 'semantic_hash',
] as const;

/** The lanes that survive, read straight out of the row. */
interface Lanes {
  content_hash: string | null;
  semantic_hash: string | null;
  revision: number;
  semantic_revision: number;
}

test('T6: the criterion evaluation-plan lane is removed, and the contract-level one is not', {
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
  await sql.query(
    'TRUNCATE "task", "session", "project", "workspace", "runner", "user" RESTART IDENTITY CASCADE',
  );

  // Nothing is stubbed: the service the API wires, over the real client.
  const projects = new ProjectsService(prisma as never);

  const ownerId = randomUUID();
  await sql.query(
    `INSERT INTO "user" ("id","email","name","password_hash") VALUES ($1,$2,'T6','x')`,
    [ownerId, `t6-${ownerId}@evaluation-plan-removal.invalid`],
  );

  async function project(title: string): Promise<string> {
    const id = randomUUID();
    await sql.query(
      `INSERT INTO "project" ("id","owner_id","title","updated_at") VALUES ($1,$2,$3,now())`,
      [id, ownerId, title],
    );
    return id;
  }

  async function lanes(projectId: string): Promise<Lanes[]> {
    const { rows } = await sql.query<Lanes>(
      `SELECT "content_hash", "semantic_hash", "revision", "semantic_revision"
         FROM "project_acceptance_criterion_definition"
        WHERE "project_id" = $1::uuid ORDER BY "ordinal"`,
      [projectId],
    );
    return rows;
  }

  /** Every column of the criterion definition, in the order the table declares them. */
  async function criterionColumns(): Promise<string[]> {
    const { rows } = await sql.query<{ column_name: string }>(
      `SELECT "column_name" FROM "information_schema"."columns"
        WHERE "table_schema" = 'public'
          AND "table_name" = 'project_acceptance_criterion_definition'
        ORDER BY "ordinal_position"`,
    );
    return rows.map((row) => row.column_name);
  }

  // ═══ 1. what went, and what stayed, in one statement ═══════════════════════════════════════════
  await t.test('the two evaluation-plan columns are gone and the seven kept ones are not',
    async () => {
      const columns = await criterionColumns();
      assert.deepEqual(REMOVED_COLUMNS.filter((column) => columns.includes(column)), [],
        'migration 0234 removes the criterion’s evaluation-plan lane');
      // Stated in the same breath so that a removal which reached one column too far cannot pass
      // the half above and leave nothing to say about the half below.
      assert.deepEqual(KEPT_COLUMNS.filter((column) => !columns.includes(column)), [],
        'the removal took a column the account owner decided to keep');
    });

  // ═══ 2. the whole table, exactly ═══════════════════════════════════════════════════════════════
  await t.test('the criterion definition is exactly twelve columns, in ordinal order', async () => {
    const columns = await criterionColumns();
    // Exact and ordered rather than a subset: the point of a census is that nobody adds or removes
    // a column without saying so here. 0233 left fourteen; this removal leaves twelve.
    assert.equal(columns.length, 12);
    assert.deepEqual(columns, [...TABLE_SHAPE]);
  });

  // ═══ 3. the contract-level plan lane is a different thing, and it stays ════════════════════════
  await t.test('project_completion_contract keeps its own evaluation_plan_revision', async () => {
    const { rows } = await sql.query<{ column_name: string; data_type: string }>(
      `SELECT "column_name", "data_type" FROM "information_schema"."columns"
        WHERE "table_schema" = 'public' AND "table_name" = 'project_completion_contract'
          AND "column_name" IN ('evaluation_plan_revision', 'evaluation_plan_digest',
                                'evaluation_plan_material')
        ORDER BY "column_name"`,
    );
    // The type is the tell that these were never the same lane: BIGINT here, INTEGER on the
    // criterion. The removal is of the criterion-level lane, and this is the contract-level one.
    assert.deepEqual(rows, [
      { column_name: 'evaluation_plan_digest', data_type: 'character' },
      { column_name: 'evaluation_plan_material', data_type: 'jsonb' },
      { column_name: 'evaluation_plan_revision', data_type: 'bigint' },
    ]);
  });

  // ═══ 4. authoring still runs, so the plpgsql was really rewritten ══════════════════════════════
  await t.test('a criterion can still be authored and rewritten, and its lanes are computed',
    async () => {
      // The executable half. `DROP COLUMN` leaves a function body alone, so a normalize trigger
      // still assigning `NEW."evaluation_plan_hash"` — or a hash function still called with a
      // signature that no longer exists — deploys cleanly and fails here, on the first row.
      const projectId = await project('the lanes that survive the removal');
      await projects.update(ownerId, projectId, {
        acceptanceCriteriaItems: [{
          text: 'The suite is green',
          verificationMethod: 'Run the suite and require a clean exit',
        }],
      } as never);
      const [created] = await lanes(projectId);
      assert.ok(created, 'the criterion was written');
      for (const lane of ['content_hash', 'semantic_hash'] as const) {
        assert.match(created[lane] ?? '', /^[0-9a-f]{64}$/, `${lane} was not computed on insert`);
      }
      assert.deepEqual([created.revision, created.semantic_revision], [1, 1]);

      // And on a rewrite, which is the other branch of the same function. Both halves of the
      // declaration move, so both counters advance: `revision` is still the combined identity of
      // the assertion and the method that decides it, and losing the plan lane does not make the
      // method stop counting towards it.
      const [stored] = await sql.query<{ id: string }>(
        `SELECT "id" FROM "project_acceptance_criterion_definition" WHERE "project_id" = $1::uuid`,
        [projectId],
      ).then((result) => result.rows);
      await projects.update(ownerId, projectId, {
        acceptanceCriteriaItems: [{
          id: stored.id,
          text: 'The suite is green on Linux',
          verificationMethod: 'Run the suite on Linux and require a clean exit',
        }],
      } as never);
      const [rewritten] = await lanes(projectId);
      for (const lane of ['content_hash', 'semantic_hash'] as const) {
        assert.match(rewritten[lane] ?? '', /^[0-9a-f]{64}$/, `${lane} was not computed on update`);
        assert.notEqual(rewritten[lane], created[lane], `${lane} did not move when its input did`);
      }
      assert.deepEqual([rewritten.revision, rewritten.semantic_revision], [2, 2]);

      // The stored lanes are reproducible from the live functions, which is the difference between
      // "a hash was written" and "the hash of what this row now says".
      const { rows: recomputed } = await sql.query<{ same: boolean }>(
        `SELECT d."semantic_hash" = project_acceptance_definition_semantic_hash(d."text")
                AND d."content_hash"
                    = project_acceptance_definition_content_hash(d."text", d."verification_method")
                  AS "same"
           FROM "project_acceptance_criterion_definition" d WHERE d."project_id" = $1::uuid`,
        [projectId],
      );
      assert.deepEqual(recomputed.map((row) => row.same), [true]);
    });

  // ═══ 5. the normalize trigger stayed, and stopped naming the two columns ═══════════════════════
  await t.test('the normalize trigger is installed and no longer fires on the removed columns',
    async () => {
      const { rows } = await sql.query<{ tgname: string; def: string }>(
        `SELECT t."tgname", pg_get_triggerdef(t."oid") AS "def"
           FROM "pg_trigger" t
          WHERE NOT t."tgisinternal"
            AND t."tgrelid" = 'public.project_acceptance_criterion_definition'::regclass
            AND t."tgname" = 'project_acceptance_definition_normalize'`,
      );
      assert.equal(rows.length, 1, 'the trigger that normalizes and hashes a criterion is still installed');
      // A trigger's `UPDATE OF` list is a tracked dependency: `DROP COLUMN` would have refused with
      // 2BP01 rather than rewrite it, so this states which way the migration resolved that.
      const definition = rows[0].def;
      for (const column of REMOVED_COLUMNS) {
        assert.doesNotMatch(definition, new RegExp(`\\b${column}\\b`),
          `the trigger still fires on ${column}`);
      }
      assert.match(definition, /BEFORE INSERT OR UPDATE OF/);
      for (const column of ['text', 'verification_method', 'semantic_hash', 'semantic_revision']) {
        assert.match(definition, new RegExp(`\\b${column}\\b`),
          `the trigger stopped firing on ${column}`);
      }

      // The untracked half of the same question, over every installed body rather than the two this
      // migration rewrote. PostgreSQL does not parse column references inside plpgsql, so a body
      // left naming a dropped column is invisible to `DROP COLUMN`, invisible to CASCADE, and
      // invisible to every test that does not execute it. Read from the live catalog: a later
      // CREATE OR REPLACE is what makes a migration file stale.
      const { rows: bodies } = await sql.query<{ proname: string }>(
        `SELECT p."oid"::regprocedure::text AS "proname"
           FROM "pg_proc" p JOIN "pg_namespace" n ON n."oid" = p."pronamespace"
          WHERE n."nspname" = 'public'
            AND p."prosrc" ~ 'evaluation_plan_(revision|hash)'
          ORDER BY 1`,
      );
      // An exact list, not "none": the one that remains reads
      // `project_completion_contract.evaluation_plan_revision`, the contract-level lane asserted
      // present above. Any other name here is a body pointing at a column that no longer exists.
      assert.deepEqual(bodies.map((row) => row.proname),
        ['project_refresh_completion_contract(uuid,text)'],
        'a function still reads the criterion columns 0234 dropped; it will fail when next executed');
    });

  // ═══ 6. the frozen design contract stops describing material that is gone ══════════════════════
  await t.test('the frozen digest contract no longer names removed material', async () => {
    const contract = JSON.parse(readFileSync(path.join(REPO_ROOT, CONTRACT), 'utf8'));
    const { contractMaterialFields, evaluationPlanMaterialFields } = contract.digestContract;

    // `criteriaTrust` was the criterion's `completion_criterion`, removed by 0233.
    assert.equal(contractMaterialFields.includes('criteriaTrust'), false,
      'criteriaTrust names the completion_criterion column migration 0233 removed');
    // `commands` was `acceptance_command` plus its expected exit code; `evidenceWiring` was
    // `evidence_task_id`. Both went in 0233 too.
    assert.equal(evaluationPlanMaterialFields.includes('commands'), false,
      'commands names the acceptance_command column migration 0233 removed');
    assert.equal(evaluationPlanMaterialFields.includes('evidenceWiring'), false,
      'evidenceWiring names the evidence_task_id column migration 0233 removed');

    // And what is left is not empty. The three that remain are the contract-level plan material,
    // which this removal does not touch and which `project_completion_contract_snapshot` really
    // does produce — so the array still describes something rather than nothing.
    assert.deepEqual(evaluationPlanMaterialFields,
      ['verifiers', 'collectorVersions', 'environment']);
    assert.deepEqual(contractMaterialFields,
      ['goal', 'outcomes', 'riskBoundary', 'criteria', 'ownerId', 'templateDigest',
        'delegationDigest']);
  });

  await t.test('the PostgreSQL target is a disposable database', async () => {
    await verifyCoordinatorPgIdentity(sql);
  });
});
