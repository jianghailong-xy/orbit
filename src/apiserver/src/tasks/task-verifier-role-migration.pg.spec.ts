import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Client } from 'pg';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';

const URL = process.env.COORDINATOR_PG_URL;
const skip = URL ? false : 'set COORDINATOR_PG_URL to run';
const SCHEMA = 'verifier_role_migration';
const ENUM_MIGRATION = readFileSync(path.resolve(
  __dirname, '../../prisma/migrations/0191_verifier_role_supersession_rule/migration.sql',
), 'utf8');
// 0192 predates migration 0224's rename of the HUMAN_SIGNOFF enum LABEL. Replaying it against a
// synthetic schema that declares today's spelling substitutes the label and nothing else.
const ROLE_MIGRATION = readFileSync(path.resolve(
  __dirname, '../../prisma/migrations/0192_verifier_role_completion/migration.sql',
), 'utf8').replaceAll("'HUMAN_SIGNOFF'", "'EVIDENCE_JUDGMENT'");

const OWNER = '00000000-0000-7000-8000-000000000001';
const SUBJECT = '00000000-0000-7000-8000-000000000002';
const verifier = (tail: number) => `00000000-0000-7000-8000-${String(tail).padStart(12, '0')}`;

async function seedPre0191(client: Client): Promise<void> {
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await client.query(`CREATE SCHEMA ${SCHEMA}`);
  await client.query(`SET search_path TO ${SCHEMA}`);
  await client.query(`
    CREATE TYPE "task_status" AS ENUM ('OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED', 'FAILED');
    CREATE TYPE "task_completion_criterion" AS ENUM
      ('EXECUTABLE', 'VERIFICATION', 'EVIDENCE_JUDGMENT');
    CREATE TYPE "task_completion_policy" AS ENUM
      ('MANUAL', 'ALL_CHILDREN_DONE', 'VERIFICATION_PASSED');
    CREATE TYPE "task_verdict" AS ENUM ('PASS', 'FAIL', 'INCONCLUSIVE');
    CREATE TYPE "creator_type" AS ENUM ('USER', 'AGENT');
    CREATE TYPE "task_judgment_request_status" AS ENUM ('OPEN', 'DECIDED', 'SUPERSEDED');
    CREATE TYPE "task_judgment_decision" AS ENUM ('PASS', 'FAIL', 'INCONCLUSIVE');
    CREATE TYPE "task_judgment_supersession_rule" AS ENUM
      ('EVIDENCE_REVISED', 'TASK_ALREADY_DONE');

    CREATE TABLE "task" (
      "id" uuid PRIMARY KEY,
      "owner_id" uuid NOT NULL,
      "status" "task_status" NOT NULL DEFAULT 'OPEN',
      "completion_criterion" "task_completion_criterion" NOT NULL DEFAULT 'EVIDENCE_JUDGMENT',
      "completion_policy" "task_completion_policy" NOT NULL DEFAULT 'MANUAL',
      "completion_criterion_override_reason" text,
      "acceptance_command" text,
      "acceptance_expected_exit_code" integer,
      "verifies_task_id" uuid,
      "verdict" "task_verdict",
      "terminal_reason" text,
      "superseded_by_task_id" uuid
    );
    CREATE TABLE "task_judgment_request" (
      "id" uuid PRIMARY KEY,
      "task_id" uuid NOT NULL,
      "owner_id" uuid NOT NULL,
      "evidence_id" uuid NOT NULL,
      "criterion_revision" text NOT NULL,
      "evidence_digest" text NOT NULL,
      "kind" "task_completion_criterion" NOT NULL,
      "recipient_type" text NOT NULL,
      "recipient_id" text NOT NULL,
      "status" "task_judgment_request_status" NOT NULL DEFAULT 'OPEN',
      "created_at" timestamp NOT NULL DEFAULT current_timestamp,
      "decided_at" timestamp,
      "decided_by_type" text,
      "decided_by_id" text,
      "decision" "task_judgment_decision",
      "decision_note" text,
      "superseded_at" timestamp,
      "superseded_by_id" uuid,
      "supersession_rule" "task_judgment_supersession_rule",
      "superseded_actor_type" "creator_type",
      "superseded_actor_id" uuid,
      "superseded_source_session_id" uuid,
      CONSTRAINT "task_judgment_request_lifecycle" CHECK (true)
    );
    CREATE TABLE "task_executable_judgment_result" (
      "request_id" uuid, "actual_exit_code" integer, "expected_exit_code" integer
    );
    CREATE TABLE "task_human_signoff" (
      "request_id" uuid, "task_id" uuid, "evidence_digest" text, "signed_by_id" uuid
    );
    CREATE TABLE "task_completion_evidence" (
      "id" uuid PRIMARY KEY, "task_id" uuid NOT NULL
    );

    CREATE FUNCTION "task_judgment_verifier_terminal_guard"() RETURNS trigger AS $$
    DECLARE request_status "task_judgment_request_status";
    BEGIN
      SELECT request."status" INTO request_status
        FROM "task_judgment_request" request
       WHERE request."id" = OLD."id"
         AND request."task_id" = OLD."verifies_task_id"
         AND request."kind" = 'VERIFICATION'
         AND request."recipient_type" = 'VERIFIER_TASK'
         AND request."recipient_id" = OLD."id"::text;
      IF NOT FOUND OR request_status = 'OPEN' THEN
        RETURN NEW;
      END IF;
      IF request_status = 'DECIDED' AND
         ROW(NEW."status", NEW."verdict", NEW."verifies_task_id") IS DISTINCT FROM
         ROW(OLD."status", OLD."verdict", OLD."verifies_task_id") THEN
        RAISE EXCEPTION 'TASK_JUDGMENT_VERIFIER_TERMINAL_IMMUTABLE';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER "task_judgment_verifier_terminal_guard"
      BEFORE UPDATE OF "status", "verdict", "verifies_task_id" ON "task"
      FOR EACH ROW EXECUTE FUNCTION "task_judgment_verifier_terminal_guard"();

    INSERT INTO "task" ("id", "owner_id") VALUES ('${SUBJECT}', '${OWNER}');
    INSERT INTO "task" ("id", "owner_id", "status") VALUES
      ('${verifier(17)}', '${OWNER}', 'DONE'),
      ('${verifier(18)}', '${OWNER}', 'OPEN');
    INSERT INTO "task_completion_evidence" ("id", "task_id") VALUES
      ('${verifier(19)}', '${verifier(18)}'),
      ('${verifier(27)}', '${verifier(25)}'),
      ('${verifier(29)}', '${verifier(28)}');
    INSERT INTO "task"
      ("id", "owner_id", "status", "verifies_task_id", "verdict",
       "completion_criterion_override_reason") VALUES
      ('${verifier(11)}', '${OWNER}', 'OPEN',        '${SUBJECT}', 'PASS',
       'legacy verifier uses EVIDENCE_JUDGMENT'),
      ('${verifier(12)}', '${OWNER}', 'FAILED',      '${SUBJECT}', 'FAIL',
       'legacy verifier uses EVIDENCE_JUDGMENT'),
      ('${verifier(13)}', '${OWNER}', 'IN_PROGRESS', '${SUBJECT}', 'INCONCLUSIVE',
       'legacy verifier uses EVIDENCE_JUDGMENT'),
      ('${verifier(14)}', '${OWNER}', 'DONE',        '${SUBJECT}', NULL,
       'legacy verifier uses EVIDENCE_JUDGMENT'),
      ('${verifier(16)}', '${OWNER}', 'CANCELLED',   '${SUBJECT}', 'PASS',
       'cancelled verifier retains its historical verdict'),
      ('${verifier(25)}', '${OWNER}', 'OPEN',        '${SUBJECT}', 'PASS',
       'matching verdict has not yet projected DONE'),
      ('${verifier(28)}', '${OWNER}', 'OPEN',        '${SUBJECT}', NULL,
       'decided request has not yet projected its verdict');
    INSERT INTO "task"
      ("id", "owner_id", "status", "verifies_task_id", "completion_criterion",
       "acceptance_command", "acceptance_expected_exit_code",
       "completion_criterion_override_reason") VALUES
      ('${verifier(15)}', '${OWNER}', 'OPEN', '${SUBJECT}', 'EXECUTABLE', 'npm test', 0,
       'legacy verifier uses EXECUTABLE');
    INSERT INTO "task_judgment_request"
      ("id", "task_id", "owner_id", "evidence_id", "criterion_revision", "evidence_digest",
       "kind", "recipient_type", "recipient_id")
    VALUES
      ('${verifier(21)}', '${verifier(14)}', '${OWNER}', '${verifier(22)}', repeat('a', 64),
       repeat('b', 64), 'EVIDENCE_JUDGMENT', 'ACCOUNT_OWNER', '${OWNER}');
    INSERT INTO "task_judgment_request"
      ("id", "task_id", "owner_id", "evidence_id", "criterion_revision", "evidence_digest",
       "kind", "recipient_type", "recipient_id", "status", "decided_at",
       "decided_by_type", "decided_by_id", "decision")
    VALUES
      ('${verifier(25)}', '${SUBJECT}', '${OWNER}', '${verifier(27)}', repeat('c', 64),
       repeat('d', 64), 'VERIFICATION', 'VERIFIER_TASK', '${verifier(25)}', 'DECIDED',
       current_timestamp, 'AGENT', '${verifier(25)}', 'PASS'),
      ('${verifier(28)}', '${SUBJECT}', '${OWNER}', '${verifier(29)}', repeat('e', 64),
       repeat('f', 64), 'VERIFICATION', 'VERIFIER_TASK', '${verifier(28)}', 'DECIDED',
       current_timestamp, 'AGENT', '${verifier(28)}', 'FAIL');
  `);
}

test('verifier-role migrations are deliberately split at the PostgreSQL enum commit boundary', () => {
  assert.match(ENUM_MIGRATION, /ADD VALUE 'VERIFIER_ROLE'/);
  assert.doesNotMatch(ENUM_MIGRATION, /UPDATE\s+"task_judgment_request"/i);
  assert.match(ROLE_MIGRATION, /completion_criterion_override_reason" = NULL/);
  assert.match(ROLE_MIGRATION, /supersession_rule" = 'VERIFIER_ROLE'/);
});

test('legacy HUMAN verifier rows migrate to one verdict-owned lifecycle', { skip }, async () => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const client = new Client({ connectionString: URL });
  await client.connect();
  try {
    await verifyCoordinatorPgIdentity(client);
    await seedPre0191(client);
    await client.query(ENUM_MIGRATION);
    await client.query(ROLE_MIGRATION);

    const rows = await client.query<{
      id: string; status: string; completion_criterion: string; completion_policy: string;
      completion_criterion_override_reason: string | null;
      acceptance_command: string | null; acceptance_expected_exit_code: number | null;
    }>(`SELECT "id", "status", "completion_criterion"::text,
              "completion_policy"::text, "completion_criterion_override_reason",
              "acceptance_command", "acceptance_expected_exit_code"
         FROM "task" WHERE "verifies_task_id" IS NOT NULL ORDER BY "id"`);
    assert.deepEqual(rows.rows.map((row) => ({
      status: row.status,
      criterion: row.completion_criterion,
      policy: row.completion_policy,
      reason: row.completion_criterion_override_reason,
      command: row.acceptance_command,
      exitCode: row.acceptance_expected_exit_code,
    })), [
      { status: 'DONE', criterion: 'VERIFICATION', policy: 'MANUAL', reason: null,
        command: null, exitCode: null },
      { status: 'DONE', criterion: 'VERIFICATION', policy: 'MANUAL', reason: null,
        command: null, exitCode: null },
      { status: 'DONE', criterion: 'VERIFICATION', policy: 'MANUAL', reason: null,
        command: null, exitCode: null },
      { status: 'OPEN', criterion: 'VERIFICATION', policy: 'MANUAL', reason: null,
        command: null, exitCode: null },
      { status: 'OPEN', criterion: 'VERIFICATION', policy: 'MANUAL', reason: null,
        command: null, exitCode: null },
      { status: 'CANCELLED', criterion: 'VERIFICATION', policy: 'MANUAL', reason: null,
        command: null, exitCode: null },
      { status: 'DONE', criterion: 'VERIFICATION', policy: 'MANUAL', reason: null,
        command: null, exitCode: null },
      { status: 'DONE', criterion: 'VERIFICATION', policy: 'MANUAL', reason: null,
        command: null, exitCode: null },
    ]);

    assert.deepEqual((await client.query(
      `SELECT "status"::text, "verdict"::text FROM "task" WHERE "id" = $1`, [verifier(25)],
    )).rows[0], { status: 'DONE', verdict: 'PASS' },
    'a matching verdict on a decided carrier must derive DONE despite the old terminal guard');
    assert.deepEqual((await client.query(
      `SELECT "status"::text, "verdict"::text FROM "task" WHERE "id" = $1`, [verifier(28)],
    )).rows[0], { status: 'DONE', verdict: 'FAIL' },
    'a decided request must repair both halves of a split carrier projection');

    await client.query(`UPDATE "task" SET "completion_criterion_override_reason" = 'maintenance'
                         WHERE "id" = $1`, [verifier(16)]);
    assert.deepEqual((await client.query(
      `SELECT "status"::text, "completion_criterion_override_reason"
         FROM "task" WHERE "id" = $1`, [verifier(16)],
    )).rows[0], { status: 'CANCELLED', completion_criterion_override_reason: null },
    'maintaining a cancelled verifier with a historical verdict must not revive it');

    await client.query(`UPDATE "task" SET "verifies_task_id" = $2 WHERE "id" = $1`,
      [verifier(17), SUBJECT]);
    assert.deepEqual((await client.query(
      `SELECT "status"::text, "completion_criterion"::text, "verdict"::text
         FROM "task" WHERE "id" = $1`, [verifier(17)],
    )).rows[0], { status: 'OPEN', completion_criterion: 'VERIFICATION', verdict: null },
    'an ordinary DONE fact cannot survive attachment of the verifier role');

    await assert.rejects(
      client.query(`UPDATE "task" SET "verifies_task_id" = $2 WHERE "id" = $1`,
        [verifier(18), SUBJECT]),
      /VERIFIER_ATTACH_COMPLETION_EVIDENCE_EXISTS/,
    );

    const request = (await client.query<{
      status: string; supersession_rule: string; superseded_actor_id: string | null;
    }>(`SELECT "status"::text, "supersession_rule"::text, "superseded_actor_id"::text
          FROM "task_judgment_request" WHERE "id" = '${verifier(21)}'`)).rows[0];
    assert.deepEqual(request, {
      status: 'SUPERSEDED', supersession_rule: 'VERIFIER_ROLE', superseded_actor_id: null,
    });

    const raw = verifier(31);
    await client.query(`INSERT INTO "task" ("id", "owner_id", "verifies_task_id")
                        VALUES ($1, $2, $3)`, [raw, OWNER, SUBJECT]);
    await client.query(`UPDATE "task" SET "verdict" = 'FAIL' WHERE "id" = $1`, [raw]);
    assert.deepEqual((await client.query(
      `SELECT "status"::text, "completion_criterion"::text, "completion_policy"::text
         FROM "task" WHERE "id" = $1`, [raw],
    )).rows[0], { status: 'DONE', completion_criterion: 'VERIFICATION', completion_policy: 'MANUAL' });
    await assert.rejects(
      client.query(`UPDATE "task" SET "status" = 'CANCELLED' WHERE "id" = $1`, [raw]),
      /VERIFIER_STATUS_DERIVED_FROM_VERDICT/,
    );

    const retired = verifier(34);
    await client.query(`INSERT INTO "task"
      ("id", "owner_id", "status", "verifies_task_id", "verdict", "terminal_reason")
      VALUES ($1, $2, 'FAILED', $3, 'FAIL', 'ABANDONED')`, [retired, OWNER, SUBJECT]);
    await client.query(`UPDATE "task" SET "terminal_reason" = NULL WHERE "id" = $1`, [retired]);
    assert.deepEqual((await client.query(
      `SELECT "status"::text, "verdict"::text, "terminal_reason"
         FROM "task" WHERE "id" = $1`, [retired],
    )).rows[0], { status: 'DONE', verdict: 'FAIL', terminal_reason: null },
    'clearing retirement must reactivate the retained verdict projection');

    await assert.rejects(client.query(`
      INSERT INTO "task_judgment_request"
        ("id", "task_id", "owner_id", "evidence_id", "criterion_revision", "evidence_digest",
         "kind", "recipient_type", "recipient_id")
      VALUES ($1, $2, $3, $4, repeat('c', 64), repeat('d', 64),
              'EVIDENCE_JUDGMENT', 'ACCOUNT_OWNER', $5)
    `, [verifier(32), raw, OWNER, verifier(33), OWNER]), /VERIFIER_JUDGMENT_REQUEST_REFUSED/);
    await client.query(`UPDATE "task" SET "verdict" = NULL WHERE "id" = $1`, [raw]);
    assert.equal((await client.query(
      `SELECT "status"::text FROM "task" WHERE "id" = $1`, [raw],
    )).rows[0].status, 'OPEN');

    await client.query(`UPDATE "task" SET "verdict" = 'FAIL' WHERE "id" = $1`, [raw]);
    await client.query(`UPDATE "task" SET "status" = 'CANCELLED', "verdict" = NULL
                         WHERE "id" = $1`, [raw]);
    assert.deepEqual((await client.query(
      `SELECT "status"::text, "verdict"::text FROM "task" WHERE "id" = $1`, [raw],
    )).rows[0], { status: 'CANCELLED', verdict: null },
    'raw cancellation must explicitly revoke the verdict in the same statement');
    await assert.rejects(
      client.query(`UPDATE "task" SET "verdict" = 'PASS' WHERE "id" = $1`, [raw]),
      /RETIRED_VERIFIER_VERDICT_REFUSED/,
    );
    // An unchanged verdict on a historical retired row does not poison unrelated maintenance.
    await client.query(`UPDATE "task" SET "verdict" = NULL,
                          "completion_criterion_override_reason" = NULL WHERE "id" = $1`, [raw]);
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await client.end();
  }
});
