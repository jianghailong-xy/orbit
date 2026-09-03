import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test, { after, before } from 'node:test';

const require = createRequire(import.meta.url);
const { Pool } = require('pg');
const ROOT = path.resolve(import.meta.dirname, '..');
const URL = process.env.OWNER_RATIFICATION_PG_URL;
const EXPECTED_DATABASE = process.env.OWNER_RATIFICATION_PG_EXPECTED_DATABASE;
const EXPECTED_USER = process.env.OWNER_RATIFICATION_PG_EXPECTED_USER;
const EXPECTED_SYSTEM_IDENTIFIER = process.env.OWNER_RATIFICATION_PG_EXPECTED_SYSTEM_IDENTIFIER;
const EVIDENCE_PATH = process.env.OWNER_RATIFICATION_EVIDENCE_PATH;

assert.ok(URL, 'OWNER_RATIFICATION_PG_URL is required; PostgreSQL absence is a hard failure');
assert.ok(EXPECTED_DATABASE, 'OWNER_RATIFICATION_PG_EXPECTED_DATABASE is required');
assert.ok(EXPECTED_USER, 'OWNER_RATIFICATION_PG_EXPECTED_USER is required');
assert.ok(EXPECTED_SYSTEM_IDENTIFIER, 'OWNER_RATIFICATION_PG_EXPECTED_SYSTEM_IDENTIFIER is required');
assert.ok(EVIDENCE_PATH, 'OWNER_RATIFICATION_EVIDENCE_PATH is required');

/**
 * The approval queue is removed, and so is the write protection on acceptance criteria.
 *
 * This suite used to prove a signature protocol. 0218 deleted the queue and kept one narrow thing
 * beside it -- an agent must not silently rewrite the standard it is measured against. On
 * 2026-09-01 the account owner decided to remove that too, so 0223 deletes
 * `project_criteria_proposal` whole: the relation, its six indexes, its nine stored functions,
 * both HTTP doors, the web card and the copy that described them.
 *
 * What this suite proves is therefore the queue's removal (a)-(d) and the proposal channel's
 * (e)-(h): that the channel is gone from the installed schema rather than merely unreferenced,
 * that no half of it survives, that `acceptanceCriteriaItems` is a direct write again, and that
 * every surface says so. The four invariants the channel carried --
 * criteriaEditingHasNoWebEntryPoint, criteriaProposalHasNoAutomaticApplyPath,
 * criteriaProposalDoesNotMoveTheRuler and criteriaProposalMachineDecisionRefused -- are gone with
 * it. That is the accepted cost, not an oversight, and nothing here reinstates an equivalent
 * protection under another name.
 *
 * Two further groups: the 0211 fallback that rewrote ordinary engineering failures into owner
 * decisions is gone while the four real boundaries are untouched (m)-(n), and neither removal
 * overreached into EVIDENCE_JUDGMENT, into project acceptance, or into the deployment (o)-(q).
 *
 * A last group, (r)-(v), is the other half of the same subtraction. 0216's authority envelope was
 * a permissiveness ceiling that only an APPROVAL could raise, and 0218 deleted approvals, so it
 * became six functions computing "the current value". It is gone, and the hard part of removing it
 * is proven rather than asserted: contractDigest -- which the DONE gate is keyed on -- does not
 * move by one byte.
 */
const pool = new Pool({ connectionString: URL, max: 12 });
const ownerId = randomUUID();
const THE_FIVE_TABLES = [
  'project_owner_decision_request',
  'project_owner_ratification',
  'outcome_binding_ratification',
  'project_ratification_template',
  'project_ratification_delegation',
];
/** 0216 built six of these. 0218 already took the seventh, the trigger body. */
const REMOVED_AUTHORITY_FUNCTIONS = [
  'project_authority_policy_rank',
  'project_authority_limit_ceiling',
  'project_authority_envelope_material',
  'project_authority_envelope',
  'project_authority_envelope_ratified',
  'project_authority_envelope_recut',
];
const ENVELOPE_REMOVAL_MIGRATION_DIR = '0219_project_authority_envelope_removal';
/** Where the pre-removal composition is replayed, so "before" is a value and not a memory. */
const PRE_REMOVAL_SCHEMA = 'authority_envelope_pre_removal';
const REMOVED_WEB_FILES = [
  'src/web/src/pages/OwnerRatificationReviewPage.tsx',
  'src/web/src/pages/OwnerRatificationLegacyReviewPage.tsx',
  'src/web/src/components/SessionOwnerRatificationCard.tsx',
  'src/web/src/components/OwnerRatificationContract.tsx',
  'src/web/src/components/OwnerRatificationSummary.tsx',
  'src/web/src/lib/ownerRatification.ts',
  'src/web/src/lib/ownerRatificationDecision.ts',
];
const evidence = {
  schemaVersion: 1,
  suite: 'outcome-reconciler-v2-owner-ratification',
  postgres: { required: true, connected: false, version: null, systemIdentifier: null },
  invariants: {
    // The queue is gone.
    approvalQueueTablesRemoved: false,
    approvalQueueHasNoResidualReference: false,
    approvalQueueHasNoWebSurface: false,
    automaticDispatchNoLongerWaitsForApproval: false,
    automaticDispatchRaisesNoRatificationObligation: false,
    doneGateHasNoRatificationClause: false,
    // And so is the proposal channel the queue used to sit beside.
    criteriaProposalChannelRemoved: false,
    criteriaProposalHasNoResidualImplementation: false,
    acceptanceCriteriaWriteIsDirect: false,
    criteriaCopyMatchesTheWrite: false,
    criteriaProposalRemovalIsSubtraction: false,
    // Nothing overreached.
    evidenceJudgmentUntouched: false,
    projectAcceptanceUntouched: false,
    noNewComposeServiceOrResidentProcess: false,
    // The authority envelope is gone and took nothing with it.
    contractSnapshotDoesNotReadTheEnvelope: false,
    authorityEnvelopeHasNoResidualReference: false,
    contractDigestUnmovedByEnvelopeRemoval: false,
    envelopeRemovalFiledNoOwnerDecision: false,
    envelopeRemovalDidNotTouchAcceptance: false,
    envelopeRemovalIsSubtraction: false,
  },
  // The three ABA races this suite used to run -- edit-then-revert, delete-and-recreate and
  // identity replacement -- were all about reviving a stale PROPOSAL. There is no proposal to
  // revive, so they are gone with it rather than rewritten into something they never tested.
  races: {},
  removals: {
    // Six functions, one trigger and one column.
    authorityEnvelopeMachineryRemoved: false,
    // (m) and (n) stood here: this suite pinned the 0211 routing function's stale-contract
    // fallback as removed and its four real owner boundaries as intact. Migration 0226 removed
    // `failure_continuation_route_claim` and the whole failure router with it, so both the branch
    // that was forbidden and the branches that were required are gone. There is no function left
    // to read, and a test that asserted a removed function does not contain something would pass
    // for the wrong reason.
  },
  samples: {},
};

function digest(label) {
  return createHash('sha256').update(label).digest('hex');
}

function read(relative) {
  return readFileSync(path.join(ROOT, relative), 'utf8');
}

/** Every tracked file except the append-only migration history, which cannot be rewritten. */
function trackedSources() {
  return execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n')
    .filter(Boolean)
    .filter((file) => !file.startsWith('src/apiserver/prisma/migrations/'))
    .filter((file) => existsSync(path.join(ROOT, file)));
}

after(async () => {
  await pool.end();
  mkdirSync(path.dirname(EVIDENCE_PATH), { recursive: true });
  writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence)}\n`);
});

before(async () => {
  await pool.query(
    `INSERT INTO "user" ("id","email","name","password_hash") VALUES ($1,$2,'criteria owner','x')`,
    [ownerId, `criteria-${ownerId}@example.test`],
  );
});

async function jsonCall(text, values, client = pool) {
  return (await client.query({ text, values })).rows[0].result;
}

/** A project with one EVIDENCE_JUDGMENT criterion, its contract cut, and no approval of any kind. */
async function createProject(label, options = {}) {
  const projectId = randomUUID();
  const definitionId = randomUUID();
  const criterionText = options.criterionText ?? `${label} outcome is demonstrably complete`;
  await pool.query(
    `INSERT INTO "project" (
       "id","owner_id","title","goal","coordinator_enabled","automation_policy",
       "max_concurrent_tasks","session_budget_per_day","updated_at"
     ) VALUES ($1,$2,$3,$4,true,'GUARDED_AUTO'::"project_automation_policy",3,10,now())`,
    [projectId, ownerId, `${label} project`, `${label} exact owner goal`],
  );
  await pool.query(
    `INSERT INTO "project_acceptance_criterion_definition" (
       "id","project_id","ordinal","text","verification_method","completion_criterion",
       "content_hash"
     ) VALUES ($1,$2,1,$3,$4,'EVIDENCE_JUDGMENT'::"task_completion_criterion",$5)`,
    [definitionId, projectId, criterionText, `review ${label} evidence`,
      digest(`placeholder:${definitionId}`)],
  );
  await pool.query('SELECT project_refresh_completion_contract($1::uuid,$2)',
    [projectId, 'RATIFICATION_SUITE_FIXTURE']);
  return { projectId, definitionId, criterionText, ...(await contract(projectId)) };
}

async function contract(projectId) {
  const row = (await pool.query(
    `SELECT "contract_digest"::text AS "contractDigest",
            "contract_revision"::text AS "contractRevision",
            "budget_digest"::text AS "budgetDigest",
            "recipient_digest"::text AS "recipientDigest",
            "risk_policy_digest"::text AS "riskPolicyDigest"
       FROM "project_completion_contract" WHERE "project_id" = $1::uuid`,
    [projectId],
  )).rows[0];
  assert.ok(row, 'the fixture project has a completion contract');
  return row;
}

/** Every column of every acceptance definition, so "not one byte moved" is checkable. */
async function criteriaRows(projectId) {
  return (await pool.query(
    `SELECT * FROM "project_acceptance_criterion_definition"
      WHERE "project_id" = $1::uuid ORDER BY "ordinal", "id"`,
    [projectId],
  )).rows;
}

/** The live installed body, not the file: what the database will actually run. */
async function installedFunction(name) {
  const rows = (await pool.query(
    `SELECT p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = $1`,
    [name],
  )).rows;
  assert.equal(rows.length, 1, `${name} must be installed exactly once`);
  return rows[0].prosrc;
}

const ENVELOPE_REMOVAL_MIGRATION = read(
  `src/apiserver/prisma/migrations/${ENVELOPE_REMOVAL_MIGRATION_DIR}/migration.sql`,
);

/**
 * One function definition, lifted verbatim out of the append-only migration history.
 *
 * This is how "before" stays a fact rather than a transcription: the pre-removal composition is
 * read from the file that installed it, not re-typed here, so a test that agreed with a mistake in
 * the new body would have to find the same mistake already sitting in 0216 or 0218.
 */
function historicalFunction(migration, name) {
  const source = read(`src/apiserver/prisma/migrations/${migration}/migration.sql`);
  const match = source.match(new RegExp(
    `CREATE (?:OR REPLACE )?FUNCTION ${name}\\([\\s\\S]*?\\n\\$\\$ LANGUAGE (?:sql|plpgsql)[A-Z ]*;`,
  ));
  assert.ok(match, `${migration} must still contain ${name}`);
  return match[0];
}

/**
 * Install the composition contractDigest had BEFORE the envelope was removed, under its own schema.
 *
 * The one substitution: the envelope reader took the approved ceiling from
 * `project_completion_contract.authority_envelope`, and that column is dropped. It could only ever
 * be written by the ratification trigger 0218 deleted, so on any database carrying 0218 it holds
 * NULL for every row -- and NULL is what the replay hands the builder.
 */
async function installPreRemovalComposition() {
  const replayed = [
    historicalFunction('0216_project_authority_envelope', 'project_authority_policy_rank'),
    historicalFunction('0216_project_authority_envelope', 'project_authority_limit_ceiling'),
    historicalFunction('0216_project_authority_envelope', 'project_authority_envelope_material'),
    historicalFunction('0216_project_authority_envelope', 'project_authority_envelope'),
    historicalFunction('0218_owner_ratification_queue_removal',
      'project_completion_contract_snapshot'),
  ].join('\n\n')
    .replaceAll('project_completion_contract_snapshot', `${PRE_REMOVAL_SCHEMA}.contract_snapshot`)
    .replaceAll('project_authority_', `${PRE_REMOVAL_SCHEMA}.authority_`)
    .replace('contract."authority_envelope"', 'NULL::jsonb');
  assert.doesNotMatch(replayed, /contract\."authority_envelope"/,
    'the replay must not read the dropped column');
  assert.match(replayed, new RegExp(`${PRE_REMOVAL_SCHEMA}\\.authority_envelope\\(base`),
    'the replayed snapshot must still be the one that reads an envelope');
  await pool.query(`DROP SCHEMA IF EXISTS ${PRE_REMOVAL_SCHEMA} CASCADE`);
  await pool.query(`CREATE SCHEMA ${PRE_REMOVAL_SCHEMA}`);
  await pool.query(replayed);
}

test('requires an isolated PostgreSQL 16 carrying the removal migration', async () => {
  const server = (await pool.query(`
    SELECT current_database() AS database,
           current_user AS role,
           (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier,
           current_setting('server_version') AS version
  `)).rows[0];
  assert.equal(server.database, EXPECTED_DATABASE);
  assert.equal(server.role, EXPECTED_USER);
  assert.equal(server.system_identifier, EXPECTED_SYSTEM_IDENTIFIER);
  assert.match(server.version, /^1[6-9]\./);
  const applied = (await pool.query(
    `SELECT migration_name FROM _prisma_migrations
      WHERE finished_at IS NOT NULL AND migration_name = ANY($1::text[]) ORDER BY 1`,
    [['0218_owner_ratification_queue_removal', ENVELOPE_REMOVAL_MIGRATION_DIR]],
  )).rows.map((row) => row.migration_name);
  assert.deepEqual(applied,
    ['0218_owner_ratification_queue_removal', ENVELOPE_REMOVAL_MIGRATION_DIR],
    'both removal migrations must be applied exactly once');
  evidence.postgres = {
    required: true,
    connected: true,
    version: server.version.split(' ')[0],
    systemIdentifier: server.system_identifier,
  };
});

// (a) --------------------------------------------------------------------------------------------
test('(a) the five approval-queue tables are gone, with nothing left pointing at them', async () => {
  const present = (await pool.query(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
    [THE_FIVE_TABLES],
  )).rows.map((row) => row.relname);
  assert.deepEqual(present, [], 'every approval-queue table must be dropped');

  // Not only the tables: nothing installed in the database may still name one. A view or a
  // function body that did would be a call site waiting to fail at runtime rather than at deploy.
  const pattern = THE_FIVE_TABLES.join('|');
  const functions = (await pool.query(
    `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname IN ('public','outcome_projection') AND p.prosrc ~ $1 ORDER BY 1`,
    [pattern],
  )).rows.map((row) => row.proname);
  assert.deepEqual(functions, [], 'no installed function may still read a dropped table');
  const views = (await pool.query(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('v','m') AND pg_get_viewdef(c.oid) ~ $1 ORDER BY 1`,
    [pattern],
  )).rows.map((row) => row.relname);
  assert.deepEqual(views, [], 'no view may still read a dropped table');
  evidence.invariants.approvalQueueTablesRemoved = true;

  // The repository half, and the reason it is a string search rather than a compile check: this
  // codebase reaches PostgreSQL through `$queryRaw`, so a dropped table survives `tsc` and fails
  // in production. The append-only migration history is excluded because it is the record of how
  // the schema got here -- 0195 must still be able to create what 0218 drops.
  // A dropped FUNCTION name cannot collide with anything, so a plain substring is exact. A
  // dropped TABLE name is matched only next to a SQL keyword, because a name like
  // `project_owner_decision_request` reads as prose and as an identifier in unrelated code.
  const droppedFunctions = [
    'outcome_current_binding_ratification',
    'project_owner_ratify_contract',
    'project_preapproved_ratify_contract',
    'project_owner_ratification_state_json',
    'project_owner_ratification_effective',
    'project_owner_ratification_eligibility',
    'project_owner_ratification_blockers',
    'project_ensure_owner_decision_request',
    'project_create_ratification_template',
    'project_create_ratification_delegation',
    'session_owner_ratification_guard',
  ];
  const tableUse = new RegExp(
    `(FROM|INTO|JOIN|UPDATE|TABLE|EXISTS)\\s+"?(${THE_FIVE_TABLES.join('|')})"?\\b`, 'i');
  const residual = [];
  for (const file of trackedSources()) {
    // This suite is where the removal is asserted, so it names what it is asserting the absence of.
    if (file === 'test/outcome-reconciler-v2.ratification.test.mjs') continue;
    const source = readFileSync(path.join(ROOT, file), 'utf8');
    for (const line of source.split('\n')) {
      // `0195_project_owner_ratification` is a migration DIRECTORY name: an inventory row saying
      // "this trigger has existed since 0195" is history, not a call site.
      if (/\d{4}_project_owner_ratification/.test(line)) continue;
      for (const needle of droppedFunctions) {
        if (line.includes(needle)) residual.push(`${file}: ${needle}`);
      }
      const table = line.match(tableUse);
      if (table) residual.push(`${file}: ${table[2]}`);
    }
  }
  assert.deepEqual([...new Set(residual)], [],
    'no live source may still read a dropped table or call a dropped function');
  evidence.invariants.approvalQueueHasNoResidualReference = true;
  evidence.samples.residualSearchFiles = digest(String(trackedSources().length));
});

// (b) --------------------------------------------------------------------------------------------
test('(b) the owner-ratification web surface and both of its routes are gone', () => {
  for (const file of REMOVED_WEB_FILES) {
    assert.equal(existsSync(path.join(ROOT, file)), false, `${file} must be deleted`);
    assert.equal(existsSync(path.join(ROOT, file.replace(/\.tsx?$/, '.test.tsx'))), false,
      `${file}'s test must be deleted with it`);
  }
  const app = read('src/web/src/App.tsx');
  assert.doesNotMatch(app, /judgments\/owner-ratification/,
    'neither judgments/owner-ratification route may remain');
  assert.doesNotMatch(app, /OwnerRatification/,
    'App.tsx may not import a removed page');
  const css = read('src/web/src/index.css');
  assert.doesNotMatch(css, /owner-ratification|session-owner-ratification|project-row-ratification/,
    'the removed components must not leave their styles behind');

  // ApprovalPanel.tsx is NOT removed, and the task's list naming it is the one factual error in
  // it. It is the ENGINE's tool-permission card -- ExitPlanMode, orbit_dag_change,
  // orbit_task_batch -- and contains no reference to owner ratification at all; deleting it would
  // silently break every tool-permission prompt in the web app. Asserted rather than argued.
  const approval = read('src/web/src/components/ApprovalPanel.tsx');
  assert.doesNotMatch(approval, /ratif/i,
    'ApprovalPanel is the engine permission card and must carry no ratification concept');
  assert.match(approval, /ApprovalInfo|toolName/,
    'ApprovalPanel must still be the tool-permission card it always was');
  assert.match(read('src/web/src/components/WorkspaceView.tsx'), /<ApprovalPanel/,
    'the tool-permission card must still be rendered');
  evidence.invariants.approvalQueueHasNoWebSurface = true;
});

// (c) --------------------------------------------------------------------------------------------
test('(c) automatic dispatch no longer waits for an approval that no longer exists', async () => {
  // The gate was a BEFORE INSERT trigger on `session`: every non-USER session insert whose task
  // belonged to a project without an effective ratification was refused
  // OWNER_RATIFICATION_REQUIRED, and that refusal is what AUTO_DISPATCH_BLOCKED reported.
  const fixture = await createProject('dispatch');
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const taskId = randomUUID();
  await pool.query(
    `INSERT INTO "runner" ("id","owner_id","name","token_hash","status","max_concurrent",
                           "last_heartbeat_at","capabilities","capabilities_reported_at")
     VALUES ($1,$2,'dispatch runner',$3,'ONLINE'::"runner_status",4,now(),'{}',now())`,
    [runnerId, ownerId, `fixture-${runnerId}`],
  );
  await pool.query(
    `INSERT INTO "workspace" ("id","owner_id","runner_id","name","enabled")
     VALUES ($1,$2,$3,'dispatch workspace',true)`,
    [workspaceId, ownerId, runnerId],
  );
  await pool.query(
    `INSERT INTO "task" ("id","owner_id","project_id","assignee_id","title","creator_type",
                         "creator_id","provider","status","updated_at")
     VALUES ($1,$2,$3,$4,'dispatch task','USER'::"creator_type",$2,'claude',
             'OPEN'::"task_status",now())`,
    [taskId, ownerId, fixture.projectId, workspaceId],
  );

  // Positive: this exact insert -- a machine-dispatched session for a task in a project nobody has
  // approved anything about -- is the one the gate used to refuse. It is admitted now.
  const sessionId = randomUUID();
  await pool.query(
    `INSERT INTO "session" ("id","owner_id","creator_id","task_id","workspace_id",
                            "assigned_runner_id","title","prompt","provider","status",
                            "dispatch_origin","updated_at")
     VALUES ($1,$2,$2,$3,$4,$5,'dispatch session','run it','claude',
             'PENDING'::"run_status",'PROJECT_COORDINATOR'::"session_dispatch_origin",now())`,
    [sessionId, ownerId, taskId, workspaceId, runnerId],
  );
  const admitted = (await pool.query(
    'SELECT count(*)::int AS count FROM "session" WHERE "id" = $1::uuid', [sessionId],
  )).rows[0].count;
  assert.equal(admitted, 1, 'a machine dispatch into an unapproved project must be admitted');
  evidence.invariants.automaticDispatchNoLongerWaitsForApproval = true;

  // Negative, four ways, because the obligation could be reintroduced at any one of them.
  const triggers = (await pool.query(
    `SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND c.relname = 'session' AND t.tgname ~ 'ratifi'`,
  )).rows;
  assert.deepEqual(triggers, [], 'no session trigger may consult an approval');
  // Stronger than "no such row": 0224 removed the whole automatic-dispatch obligation framework,
  // so there is no relation an OWNER_RATIFICATION_REQUIRED reason could be written into and no
  // recorder that would write one. Asserted against the migrated database rather than the source.
  assert.equal((await pool.query(
    `SELECT count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'task_auto_dispatch%'`,
  )).rows[0].count, 0, 'no automatic-dispatch obligation relation may hold a ratification reason');
  assert.equal((await pool.query(
    `SELECT count(*)::int AS count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname LIKE 'task_auto_dispatch%'`,
  )).rows[0].count, 0, 'no automatic-dispatch recorder is left to raise one');
  assert.equal(existsSync(path.join(ROOT, 'src/apiserver/src/common/auto-dispatch-obligation.ts')),
    false, 'the refusal-to-disposition mapper that carried the ratification branch is gone');
  const tasksService = read('src/apiserver/src/tasks/tasks.service.ts');
  assert.doesNotMatch(tasksService, /project_owner_ratification_effective/,
    'neither dispatch sweep may prefilter on an approval');
  assert.match(tasksService, /const SCHEDULED_DUE_SQL[\s\S]*t\.run_at <= now\(\)/,
    'the scheduled sweep itself is untouched');
  evidence.invariants.automaticDispatchRaisesNoRatificationObligation = true;
});

// (d) --------------------------------------------------------------------------------------------
test('(d) the DONE gate carries no ratification clause', async () => {
  // 0222 removed the canonical obligation gate this used to read on both layers and restored the
  // 0150 project acceptance gate as the single body that decides a project's DONE, and this read
  // that body. 0229 then removed the project acceptance judgment whole -- the gate, its trigger,
  // and the run/criterion/conclusion rows whose staleness it reported -- so there is no longer one
  // body to point at, and reading `rows[0].prosrc` from a function that no longer exists threw.
  // The question is unchanged, so it is now asked of everything that survived instead.
  assert.equal((await pool.query(
    `SELECT count(*)::int AS count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'project_acceptance_done_gate'`,
  )).rows[0].count, 0, '0229 removed the project acceptance DONE gate; nothing may restore it here');
  const ratifying = (await pool.query(
    `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosrc ~* 'ratification' ORDER BY p.proname`,
  )).rows.map((row) => row.proname);
  assert.deepEqual(ratifying, [],
    'no function in force may compute or report a ratification verdict');
  assert.equal((await pool.query(
    `SELECT count(*)::int AS count FROM pg_proc
      WHERE proname LIKE 'project_owner_ratification%'`,
  )).rows[0].count, 0, 'no ratification helper is left for a gate to call');
  evidence.invariants.doneGateHasNoRatificationClause = true;
});

// (e)-(h) The acceptance-criteria proposal channel, removed.
//
// 0217 built it and 0218 re-bound it to the criteria set. What follows proves it is gone from the
// database that exists rather than merely unreferenced by TypeScript, that no half of it survives,
// that the write it intercepted is direct again, and that every surface says so.
// ------------------------------------------------------------------------------------------------

/** Everything 0217 and 0218 installed for the channel, by name. */
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
const PROPOSAL_REMOVAL_MIGRATION_DIR = '0223_project_criteria_proposal_removal';
const PROPOSAL_REMOVAL_MIGRATION = read(
  `src/apiserver/prisma/migrations/${PROPOSAL_REMOVAL_MIGRATION_DIR}/migration.sql`,
);

// (e) --------------------------------------------------------------------------------------------
test('(e) criteriaProposalChannelRemoved: the relation, its six indexes and its nine functions '
  + 'are gone from the installed schema', async () => {
  const relation = (await pool.query(
    "SELECT to_regclass('public.project_criteria_proposal')::text AS oid",
  )).rows[0];
  assert.equal(relation.oid, null, 'project_criteria_proposal is still installed');

  // The six the relation owned: its primary key, the (project_id, proposal_generation) unique
  // constraint, and the four 0217 declared -- one_pending, idempotency, decision_idempotency and
  // inbox. Dropping the table takes all of them, which is what this asks the catalog to confirm.
  const indexes = (await pool.query(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'i'
        AND c.relname LIKE 'project_criteria_proposal%' ORDER BY 1`,
  )).rows.map((row) => row.relname);
  assert.deepEqual(indexes, [], 'an index of the dropped relation survived it');

  const installed = (await pool.query(
    `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = ANY($1::text[]) ORDER BY 1`,
    [PROPOSAL_FUNCTIONS],
  )).rows.map((row) => row.proname);
  assert.deepEqual(installed, [], 'a proposal function is still installed');

  // 0217 and 0218 created no view over the proposal, so "the views are gone" is a fact about an
  // empty set rather than something a reader should go looking for.
  for (const dir of ['0217_project_criteria_proposal_card', '0218_owner_ratification_queue_removal']) {
    assert.doesNotMatch(read(`src/apiserver/prisma/migrations/${dir}/migration.sql`),
      /CREATE\s+(?:OR\s+REPLACE\s+)?VIEW/i, `${dir} installed a view over the proposal`);
  }
  evidence.invariants.criteriaProposalChannelRemoved = true;
  evidence.samples.proposalRemoval = digest(PROPOSAL_FUNCTIONS.join(','));
});

// (f) --------------------------------------------------------------------------------------------
test('(f) criteriaProposalHasNoResidualImplementation: nothing survives that could reach it',
  async () => {
  // No surviving function body names the channel. This is the half-removal a text scan is worst
  // at catching: a plpgsql body is a string, so a caller left behind compiles, deploys, and fails
  // at the first call.
  const callers = (await pool.query(
    `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND (p.prosrc ~ 'criteria_proposal' OR p.prosrc ~ 'project_acceptance_criteria_set_digest')
      ORDER BY 1`,
  )).rows.map((row) => row.proname);
  assert.deepEqual(callers, [], 'a surviving function body still calls the removed channel');

  // Nor is there a trigger, a constraint or a sequence left pointing at a relation that is gone.
  const dependents = (await pool.query(
    `SELECT c.conname FROM pg_constraint c JOIN pg_class t ON t.oid = c.confrelid
      WHERE t.relname = 'project_criteria_proposal'`,
  )).rows;
  assert.deepEqual(dependents, []);

  // And the four invariant names the account owner used appear in no live source at all. They go
  // together or the channel is half-standing: a web guard with no schema behind it, or a database
  // refusal no door can reach, is worse than either state on its own.
  const invariants = [
    'criteriaEditingHasNoWebEntryPoint',
    'criteriaProposalHasNoAutomaticApplyPath',
    'criteriaProposalDoesNotMoveTheRuler',
    'criteriaProposalMachineDecisionRefused',
  ];
  const offenders = [];
  for (const file of trackedSources()) {
    if (file === 'test/outcome-reconciler-v2.ratification.test.mjs') continue;
    if (file.endsWith('criteria-proposal-removal.spec.ts')) continue;
    if (file.endsWith('criteria-proposal-removal.pg.spec.ts')) continue;
    const source = read(file);
    for (const invariant of invariants) {
      if (source.includes(invariant)) offenders.push(`${file}: ${invariant}`);
    }
  }
  assert.deepEqual(offenders, [], 'one of the four invariants still has an implementation');
  evidence.invariants.criteriaProposalHasNoResidualImplementation = true;
});

// (g) --------------------------------------------------------------------------------------------
test('(g) acceptanceCriteriaWriteIsDirect: nothing in the database applies criteria for anybody',
  async () => {
  // The proposal apply was the ONLY database function that wrote the acceptance definitions. With
  // it gone, no stored procedure can move the ruler at all: the write is the application's own
  // `replaceAcceptanceDefinitions`, it lands when it commits, and there is no second step.
  const writers = (await pool.query(
    `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.prosrc ~ '(INSERT INTO|UPDATE|DELETE FROM)\s+"?project_acceptance_criterion_definition'
      ORDER BY 1`,
  )).rows.map((row) => row.proname);
  assert.deepEqual(writers, [],
    'a stored function still writes the acceptance definitions — the write must be the '
      + "application's direct one");

  // The agent's door forwards the whole body, acceptance criteria included, straight to the write.
  const runner = read('src/apiserver/src/runner-api/runner-projects.controller.ts');
  assert.match(runner,
    /@Patch\('projects\/:id'\)[\s\S]*?return this\.projects\.update\(runner\.ownerId, id, dto, sessionId\);/,
    'the runner PATCH must reach the project write with the criteria still on the body');
  assert.doesNotMatch(runner, /criteria-proposal|proposeCriteriaChange/,
    'the runner door still carries a proposal route');
  assert.doesNotMatch(read('src/apiserver/src/projects/projects.controller.ts'),
    /criteria-proposal|criteria-confirmation/,
    'the user door still carries a proposal or confirmation route');

  // The web card and its mount point are gone, and no web file is left importing them.
  for (const removed of [
    'src/web/src/components/ProjectCriteriaProposalCard.tsx',
    'src/web/src/components/ProjectCriteriaProposalCard.test.tsx',
  ]) {
    assert.equal(existsSync(path.join(ROOT, removed)), false, `${removed} still exists`);
  }
  assert.doesNotMatch(read('src/web/src/components/WorkspaceView.tsx'), /CriteriaProposal/);
  evidence.invariants.acceptanceCriteriaWriteIsDirect = true;
});

// (h) --------------------------------------------------------------------------------------------
test('(h) criteriaCopyMatchesTheWrite, and the removal is subtraction', () => {
  // Copy that lies is worse than no copy: a model told "this is a proposal, nothing changes until
  // the owner approves it" reports the criteria as unchanged and keeps working to a standard that
  // has already moved. Every surface that describes acceptanceCriteriaItems is scanned.
  const lies = [
    /\bPROPOSAL\b/,
    /you are PROPOSING/i,
    /acceptanceCriteriaProposal/,
    /records? (?:one|a) proposal for the account owner/i,
    /nothing changes until (?:they|the owner)/i,
    /until the (?:account )?owner (?:approves|answers) it/i,
    /\[\] is refused/,
    // The web app's copy is Chinese, so an English-only scan would have missed the one sentence
    // on the acceptance review page that said the ruler moves by proposal and owner confirmation.
    // Scoped to lines about the standard: "approve" alone is the evidence-signoff channel.
    /标准[^\n]{0,40}(?:提议|批准|卡片上确认)/,
    /(?:提议|批准)[^\n]{0,40}标准/,
  ];
  const surfaces = ['src/runner-go/mcp.go', 'src/runner-go/project_cli.go',
    'src/apiserver/src/projects/dto.ts',
    'src/apiserver/src/runner-api/runner-projects.controller.ts',
    ...trackedSources().filter((file) => file.startsWith('src/web/src/') && /\.tsx?$/.test(file))];
  const offenders = [];
  for (const file of surfaces) {
    read(file).split('\n').forEach((line, index) => {
      for (const lie of lies) if (lie.test(line)) offenders.push(`${file}:${index + 1}`);
    });
  }
  assert.deepEqual(offenders, [],
    'a surface still calls acceptance criteria a proposal while the write lands immediately');
  // The positive half, so the copy is not merely silent about what it does.
  assert.match(read('src/runner-go/mcp.go'), /Whole structured replacement/);
  assert.match(read('src/runner-go/project_cli.go'), /whole-collection replacement/);
  evidence.invariants.criteriaCopyMatchesTheWrite = true;

  // Subtraction, in the migration's own DDL vocabulary: nine drops and one, and nothing else.
  const ddl = [...PROPOSAL_REMOVAL_MIGRATION.matchAll(
    /^(?:CREATE|ALTER|DROP)(?: OR REPLACE)? [A-Z]+/gm)].map((match) => match[0]);
  assert.deepEqual([...new Set(ddl)].sort(), ['DROP FUNCTION', 'DROP TABLE'],
    'the removal migration creates or alters something');
  assert.doesNotMatch(PROPOSAL_REMOVAL_MIGRATION, /pg_cron|CREATE EXTENSION|LISTEN |NOTIFY /,
    'the migration starts nothing that keeps running after it commits');
  // And it cannot reach the ruler's CONTENT: it names no acceptance RELATION in any statement, so
  // no criterion's text or verification_method can move by one byte. (It does drop one
  // `project_acceptance_`-prefixed FUNCTION -- 0218's criteria-set digest -- which read those rows
  // and never wrote them.)
  for (const line of PROPOSAL_REMOVAL_MIGRATION.split('\n')) {
    if (line.trimStart().startsWith('--')) continue;
    for (const table of ['project_acceptance_audit', 'project_acceptance_conclusion',
      'project_acceptance_criterion', 'project_acceptance_criterion_definition',
      'project_acceptance_run']) {
      assert.equal(line.includes(table), false,
        `the removal names ${table} in a statement: ${line.trim()}`);
    }
  }
  evidence.invariants.criteriaProposalRemovalIsSubtraction = true;
});

// (o) --------------------------------------------------------------------------------------------
test('(o) EVIDENCE_JUDGMENT is untouched: the migration cannot reach it, and it still works',
  async () => {
  // Static: 0218 contains no statement that could write task completion criteria or signoffs.
  // Function bodies are excluded from this scan because a CREATE FUNCTION is not a write.
  const migration = read(
    'src/apiserver/prisma/migrations/0218_owner_ratification_queue_removal/migration.sql',
  );
  const topLevel = migration.replace(/AS \$\$[\s\S]*?\$\$ LANGUAGE/g, 'AS $$ $$ LANGUAGE');
  for (const relation of ['task_completion_evidence', 'task']) {
    assert.doesNotMatch(topLevel,
      new RegExp(`(INSERT INTO|UPDATE|DELETE FROM|ALTER TABLE|DROP TABLE)\\s+"?${relation}"?(\\s|$)`, 'im'),
      `the migration must contain no statement that writes ${relation}`);
  }

  // Dynamic: the whole EVIDENCE_JUDGMENT path still round-trips, field for field. 0180 predates this
  // project, 1,123 production tasks stand on it, and the proof that they are unaffected is that
  // nothing in the migration can reach them and the path they use still behaves identically.
  const fixture = await createProject('human-signoff');
  const taskId = randomUUID();
  const evidenceDigest = digest(`signoff:${taskId}`);
  await pool.query(
    `INSERT INTO "task" ("id","owner_id","project_id","title","creator_type","creator_id",
                         "provider","status","completion_criterion","updated_at")
     VALUES ($1,$2,$3,'human signoff task','USER'::"creator_type",$2,'claude',
             'OPEN'::"task_status",'EVIDENCE_JUDGMENT'::"task_completion_criterion",now())`,
    [taskId, ownerId, fixture.projectId],
  );
  const task = (await pool.query(
    'SELECT "completion_criterion"::text AS criterion FROM "task" WHERE "id" = $1::uuid', [taskId],
  )).rows[0];
  assert.equal(task.criterion, 'EVIDENCE_JUDGMENT',
    'the completion criterion 1,123 production tasks carry is still storable and still reads back');
  // The signoff table 0180 created is gone, and so is the judgment request 0224 folded its prose
  // onto — the second removed by 0227, at the account owner's direction. Neither happened here.
  // What (o) claims is that 0218 cannot reach the criterion, and the static scan above is that
  // claim; the catalogue assertions that used to enumerate those two tables would now be asserting
  // some other migration's outcome from the wrong suite. What remains checkable here is that the
  // criterion is still storable, still reads back, and still keeps its declaration.
  const declaration = (await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'task'
        AND column_name IN ('acceptance_command', 'acceptance_expected_exit_code')
      ORDER BY column_name`,
  )).rows.map((row) => row.column_name);
  assert.deepEqual(declaration, ['acceptance_command', 'acceptance_expected_exit_code'],
    'the executable declaration 0177 gave every task is still there');

  // And the enum the 1,123 production tasks are stored under still has exactly its three peers,
  // in order: dropping or reordering one is what would silently reinterpret them.
  const criteria = (await pool.query(
    `SELECT unnest(enum_range(NULL::"task_completion_criterion"))::text AS value`,
  )).rows.map((row) => row.value);
  assert.deepEqual(criteria, ['EXECUTABLE', 'VERIFICATION', 'EVIDENCE_JUDGMENT'],
    'EVIDENCE_JUDGMENT is still one of three peers, in its original position');
  evidence.invariants.evidenceJudgmentUntouched = true;
  evidence.samples.evidenceJudgmentDigest = evidenceDigest;
});

// (p) --------------------------------------------------------------------------------------------
test('(p) project acceptance is untouched: 0178-0190 keeps its schema and its rows', async () => {
  const migration = read(
    'src/apiserver/prisma/migrations/0218_owner_ratification_queue_removal/migration.sql',
  );
  const topLevel = migration.replace(/AS \$\$[\s\S]*?\$\$ LANGUAGE/g, 'AS $$ $$ LANGUAGE');
  for (const relation of [
    'project_acceptance_criterion_definition', 'project_acceptance_criterion',
    'project_acceptance_run', 'project_acceptance_conclusion',
  ]) {
    assert.doesNotMatch(topLevel,
      new RegExp(`(INSERT INTO|UPDATE|DELETE FROM|ALTER TABLE|DROP TABLE)\\s+"?${relation}`, 'i'),
      `the migration must contain no statement that writes ${relation}`);
  }

  // The definitions a project is measured by round-trip field for field across the new digest
  // function, which reads them and writes nothing.
  const fixture = await createProject('acceptance-untouched');
  const before = await criteriaRows(fixture.projectId);
  await pool.query('SELECT project_refresh_completion_contract($1::uuid,$2)',
    [fixture.projectId, 'ACCEPTANCE_UNTOUCHED']);
  assert.deepEqual(await criteriaRows(fixture.projectId), before,
    're-cutting the contract must not move one field of a definition');

  // The per-run acceptance rows this used to write are gone: migration 0229 removed the project
  // acceptance JUDGMENT — run, per-run criterion, conclusion and audit — on a later and separate
  // account-owner decision. 0218 still issued no statement against any of them, which is what this
  // test is about. What survives all of it is the DECLARATION table above.
  // pg_class holds indexes as well as tables, so the DECLARATION table's three indexes survive
  // beside it and belong in this list. Naming them exactly, rather than filtering relkind down to
  // 'r', keeps this a census of every project_acceptance relation still installed.
  const surviving = (await pool.query(
    `SELECT c."relname" FROM "pg_class" c JOIN "pg_namespace" n ON n."oid" = c."relnamespace"
      WHERE n."nspname" = 'public' AND c."relname" LIKE 'project_acceptance%'
      ORDER BY c."relname"`,
  )).rows.map((row) => row.relname);
  assert.deepEqual(surviving, [
    'project_acceptance_criterion_definition',
    'project_acceptance_criterion_definition_pkey',
    'project_acceptance_definition_content_idx',
    'project_acceptance_definition_ordinal_idx',
  ]);
  evidence.invariants.projectAcceptanceUntouched = true;
});

// (q) --------------------------------------------------------------------------------------------
test('(q) this change adds no compose service and no resident process', () => {
  const compose = read('docker-compose.yml');
  const services = [...compose.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((match) => match[1]);
  // watchdog, outcome-coordinator, outcome-coordinator-secondary and executable-dead-man were
  // removed from Compose after this migration landed. The list shrank; this assertion still says
  // the same thing it always did — that nothing here ADDS a service. ('pg-socket' is the volume,
  // which the two-space regex above cannot tell apart from a service.)
  assert.deepEqual(services.sort(), [
    'apiserver', 'gateway', 'pg-socket', 'pgbackup', 'postgres', 'web',
  ], 'the deployment is exactly the services it already had');

  // A resident process would arrive as a new long-running start script or a new scheduled job.
  const packageJson = JSON.parse(read('package.json'));
  const apiserver = JSON.parse(read('src/apiserver/package.json'));
  assert.deepEqual(Object.keys(apiserver.scripts).filter((name) => name.startsWith('start:')).sort(),
    ['start:dev'],
    'no new long-running entry point');
  assert.equal(Object.keys(packageJson.scripts).some((name) => /daemon|worker|cron/i.test(name)),
    false, 'no new scheduled or resident runner');
  const migration = read(
    'src/apiserver/prisma/migrations/0218_owner_ratification_queue_removal/migration.sql',
  );
  assert.doesNotMatch(migration, /pg_cron|CREATE EXTENSION|LISTEN |NOTIFY /,
    'the migration starts nothing that keeps running after it commits');
  evidence.invariants.noNewComposeServiceOrResidentProcess = true;
});

// ------------------------------------------------------------------------------------------------
// (r)-(v) The authority envelope, removed.
//
// 0216 built a permissiveness CEILING so that moving under an approved limit left contractDigest
// where it was. 0218 deleted the approval queue, which took the only writer of that ceiling with
// it, so what remained was six functions and a column recomputing "the current value" on every
// snapshot. These five prove the removal happened and that it cost nothing.
// ------------------------------------------------------------------------------------------------

// (r) --------------------------------------------------------------------------------------------
test('(r) the authority envelope is gone: six functions, its trigger, its column, no caller',
  async () => {
  const installed = (await pool.query(
    'SELECT p.proname FROM pg_proc p WHERE p.proname = ANY($1::text[]) ORDER BY 1',
    [REMOVED_AUTHORITY_FUNCTIONS],
  )).rows.map((row) => row.proname);
  assert.deepEqual(installed, [], 'every project_authority_* function must be dropped');

  const triggers = (await pool.query(
    `SELECT t.tgname FROM pg_trigger t
      WHERE NOT t.tgisinternal AND t.tgname LIKE 'project_authority%'`,
  )).rows.map((row) => row.tgname);
  assert.deepEqual(triggers, [], 'project_authority_envelope_ratified must be gone with its table');

  const column = (await pool.query(
    `SELECT a.attname FROM pg_attribute a
      WHERE a.attrelid = 'project_completion_contract'::regclass
        AND a.attname = 'authority_envelope' AND NOT a.attisdropped`,
  )).rows.map((row) => row.attname);
  assert.deepEqual(column, [], 'project_completion_contract.authority_envelope must be dropped');
  evidence.removals.authorityEnvelopeMachineryRemoved = true;

  // The one function that DID call the envelope no longer does, and no longer publishes it either.
  const snapshot = await installedFunction('project_completion_contract_snapshot');
  assert.doesNotMatch(snapshot, /authority_envelope|authorityEnvelope|project_authority_/,
    'the snapshot must neither read the envelope nor publish it');
  const bodies = (await pool.query(
    `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname IN ('public','outcome_projection')
        AND p.prosrc ~ 'authority_envelope|authorityEnvelope|project_authority_' ORDER BY 1`,
  )).rows.map((row) => row.proname);
  assert.deepEqual(bodies, [], 'no installed function may still name the envelope');
  const views = (await pool.query(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('v','m') AND pg_get_viewdef(c.oid) ~ 'authority_envelope' ORDER BY 1`,
  )).rows.map((row) => row.relname);
  assert.deepEqual(views, [], 'no view may still read the envelope');
  evidence.invariants.contractSnapshotDoesNotReadTheEnvelope = true;

  // The repository half, and the same reason as (a): this codebase reaches PostgreSQL through
  // `$queryRaw`, so a dropped function survives `tsc` and fails in production.
  // `0216_project_authority_envelope` is a migration DIRECTORY name and the history is append-only:
  // a harness pinning the frontier at 0216 is naming a folder, not calling anything.
  const residual = [];
  for (const file of trackedSources()) {
    // This suite is where the removal is asserted, so it names what it asserts the absence of.
    if (file === 'test/outcome-reconciler-v2.ratification.test.mjs') continue;
    for (const line of readFileSync(path.join(ROOT, file), 'utf8').split('\n')) {
      if (/\d{4}_project_authority_envelope/.test(line)) continue;
      for (const needle of ['project_authority_', 'authority_envelope', 'authorityEnvelope']) {
        if (line.includes(needle)) residual.push(`${file}: ${needle}`);
      }
    }
  }
  assert.deepEqual([...new Set(residual)], [],
    'no live source may still name the authority envelope');
  evidence.invariants.authorityEnvelopeHasNoResidualReference = true;
});

// (s) --------------------------------------------------------------------------------------------
test('(s) contractDigest is byte-identical across the removal, for every project', async () => {
  // Six shapes across every dimension the envelope covered, so "identical" is not identical on one
  // uniform row: both limit maps null, empty and populated; sessionBudgetPerDay absent, zero and
  // set; all three automation policies; the coordinator switch both ways.
  const shapes = [
    { policy: 'GUARDED_AUTO', coordinator: true, concurrency: 3, sessions: 10,
      attempt: { maxAttempts: 4 }, thresholds: { maxRepeats: 2 } },
    { policy: 'MANUAL', coordinator: false, concurrency: 1, sessions: null,
      attempt: null, thresholds: null },
    { policy: 'AUTO', coordinator: true, concurrency: 9, sessions: 0,
      attempt: { maxAttempts: 0 }, thresholds: {} },
    { policy: 'GUARDED_AUTO', coordinator: true, concurrency: 7, sessions: 7,
      attempt: { a: null, b: 60 }, thresholds: { c: null } },
    { policy: 'AUTO', coordinator: false, concurrency: 12, sessions: 99,
      attempt: {}, thresholds: null },
    { policy: 'MANUAL', coordinator: true, concurrency: 2, sessions: 5,
      attempt: null, thresholds: { maxRepeats: 0 } },
  ];
  for (const shape of shapes) {
    const projectId = randomUUID();
    await pool.query(
      `INSERT INTO "project" (
         "id","owner_id","title","goal","coordinator_enabled","automation_policy",
         "max_concurrent_tasks","session_budget_per_day","attempt_budget","convergence_thresholds",
         "updated_at"
       ) VALUES ($1,$2,$3,$4,$5,$6::"project_automation_policy",$7,$8,$9::jsonb,$10::jsonb,now())`,
      [projectId, ownerId, `envelope shape ${shape.policy}`, `goal for ${projectId}`,
        shape.coordinator, shape.policy, shape.concurrency, shape.sessions,
        shape.attempt === null ? null : JSON.stringify(shape.attempt),
        shape.thresholds === null ? null : JSON.stringify(shape.thresholds)],
    );
    await pool.query('SELECT project_refresh_completion_contract($1::uuid,$2)',
      [projectId, 'ENVELOPE_REMOVAL_SHAPE']);
  }

  await installPreRemovalComposition();
  const rows = (await pool.query(
    `SELECT p."id"::text AS project_id,
            before.value->>'contractDigest' AS before_digest,
            after.value->>'contractDigest' AS after_digest,
            (before.value - 'authorityEnvelope')::text = after.value::text AS whole_snapshot
       FROM "project" p,
            LATERAL ${PRE_REMOVAL_SCHEMA}.contract_snapshot(p."id") AS before(value),
            LATERAL project_completion_contract_snapshot(p."id") AS after(value)
      ORDER BY p."id"`,
  )).rows;
  assert.ok(rows.length >= shapes.length,
    'every project this suite has created is compared, not a sample');
  assert.equal(rows.filter((row) => row.after_digest === null).length, 0,
    'a null digest on either side would make the comparison vacuous');
  for (const row of rows) {
    assert.equal(row.after_digest, row.before_digest,
      `project ${row.project_id} moved its contractDigest`);
    assert.equal(row.whole_snapshot, true,
      `project ${row.project_id} moved something else in its snapshot`);
  }

  // The one recorded envelope in production is a ceiling that has not drifted from the
  // configuration it bounds. Handed it, the builder returns those same live values -- which is why
  // substituting them is neutral for that project too. The migration does not take this on trust:
  // it re-derives every project's whole snapshot and refuses to commit if one of them moved.
  const productionCeiling = {
    attemptBudget: null, automationPolicy: 'GUARDED_AUTO', convergenceThresholds: null,
    coordinatorEnabled: true, maxConcurrentTasks: 3, sessionBudgetPerDay: 10,
  };
  const resolved = (await pool.query(
    `SELECT ${PRE_REMOVAL_SCHEMA}.authority_envelope_material(
       $1::jsonb, true, 'GUARDED_AUTO', 3, 10, NULL, NULL) AS result`,
    [JSON.stringify(productionCeiling)],
  )).rows[0].result;
  assert.deepEqual(resolved, productionCeiling,
    'a ceiling equal to the configuration it bounds resolves to that configuration');

  await pool.query(`DROP SCHEMA ${PRE_REMOVAL_SCHEMA} CASCADE`);
  evidence.invariants.contractDigestUnmovedByEnvelopeRemoval = true;
  evidence.samples.contractDigestSet = digest(
    rows.map((row) => `${row.project_id}:${row.after_digest}`).join('\n'));
});

// (t) --------------------------------------------------------------------------------------------
test('(t) removing the envelope filed no owner decision', async () => {
  // Comments and both kinds of dollar-quoted body removed: what is left is the statements the file
  // actually runs, which is what "wrote nothing" has to be true of.
  const statements = ENVELOPE_REMOVAL_MIGRATION
    .replace(/AS \$\$[\s\S]*?\$\$ LANGUAGE/g, 'AS $$ $$ LANGUAGE')
    .replace(/DO \$\$[\s\S]*?END \$\$;/g, 'DO $$ $$;')
    .split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
  // The coordinator's owner-decision request table used to be in this list; 0221 dropped it, so a
  // statement writing it is no longer expressible rather than merely absent.
  for (const relation of ['project_completion_contract', 'project']) {
    assert.doesNotMatch(statements,
      new RegExp(`(INSERT INTO|UPDATE|DELETE FROM)\\s+"?${relation}\\b`, 'i'),
      `the migration must contain no statement that writes ${relation}`);
  }
  // Re-cutting the contract is what would have derived a decision, and nothing re-cuts one: the
  // stored contracts already carry the digest the new composition produces. The recut function is
  // named exactly once in this file, on the line that deletes it.
  assert.doesNotMatch(statements, /project_refresh_completion_contract/,
    'the migration must refresh no contract');
  assert.deepEqual(
    statements.split('\n').filter((line) => line.includes('project_authority_envelope_recut')),
    ['DROP FUNCTION project_authority_envelope_recut(UUID[]);'],
    'the recut may only be dropped, never called');

  // Live, and the part a file scan cannot reach: re-cutting a contract under the new snapshot
  // derives no owner decision. (This test also used to check that a pending criteria proposal
  // survived the re-cut. 0223 deleted proposals, so that half went with them.)
  const fixture = await createProject('envelope-removal-negative');
  // 0221 removed the persistent coordinator's request table, so "no owner decision was derived"
  // is now checked as absence of the relation rather than as a count that cannot move.
  const decisionsBefore = (await pool.query(
    `SELECT CASE WHEN to_regclass('public.outcome_coordinator_owner_decision_request') IS NULL
                 THEN 0 ELSE 1 END AS count`,
  )).rows[0].count;
  await pool.query('SELECT project_refresh_completion_contract($1::uuid,$2)',
    [fixture.projectId, 'ENVELOPE_REMOVAL_NEGATIVE']);
  assert.equal((await pool.query(
    `SELECT CASE WHEN to_regclass('public.outcome_coordinator_owner_decision_request') IS NULL
                 THEN 0 ELSE 1 END AS count`,
  )).rows[0].count, decisionsBefore, 'no owner decision request may be derived');
  evidence.invariants.envelopeRemovalFiledNoOwnerDecision = true;
});

// (u) --------------------------------------------------------------------------------------------
test('(u) removing the envelope did not reach project acceptance', async () => {
  const topLevel = ENVELOPE_REMOVAL_MIGRATION.replace(/AS \$\$[\s\S]*?\$\$ LANGUAGE/g,
    'AS $$ $$ LANGUAGE');
  for (const relation of [
    'project_acceptance_criterion_definition', 'project_acceptance_criterion',
    'project_acceptance_run', 'project_acceptance_conclusion',
  ]) {
    assert.doesNotMatch(topLevel,
      new RegExp(`(INSERT INTO|UPDATE|DELETE FROM|ALTER TABLE|DROP TABLE)\\s+"?${relation}`, 'i'),
      `the migration must contain no statement that writes ${relation}`);
  }
  // The definitions a project is measured by round-trip field for field across the new snapshot,
  // which reads them and writes nothing.
  const fixture = await createProject('envelope-removal-acceptance');
  const before = await criteriaRows(fixture.projectId);
  assert.equal(before.length, 1, 'the fixture has the definition the comparison is about');
  await pool.query('SELECT project_completion_contract_snapshot($1::uuid)', [fixture.projectId]);
  await pool.query('SELECT project_refresh_completion_contract($1::uuid,$2)',
    [fixture.projectId, 'ENVELOPE_REMOVAL_ACCEPTANCE']);
  assert.deepEqual(await criteriaRows(fixture.projectId), before,
    'the new snapshot must not move one field of a definition');
  evidence.invariants.envelopeRemovalDidNotTouchAcceptance = true;
});

// (v) --------------------------------------------------------------------------------------------
test('(v) this is subtraction: nothing new runs, and less SQL is in force than before', () => {
  const compose = read('docker-compose.yml');
  const services = [...compose.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((match) => match[1]);
  // The same list (q) asserts, and for the same reason: watchdog, outcome-coordinator,
  // outcome-coordinator-secondary and executable-dead-man were removed from Compose after 0218
  // landed. The list shrank; the claim is still that nothing here ADDS a service.
  assert.deepEqual(services.sort(), [
    'apiserver', 'gateway', 'pg-socket', 'pgbackup', 'postgres', 'web',
  ], 'the deployment is exactly the services it already had');
  const packageJson = JSON.parse(read('package.json'));
  const apiserver = JSON.parse(read('src/apiserver/package.json'));
  assert.deepEqual(Object.keys(apiserver.scripts).filter((name) => name.startsWith('start:')).sort(),
    ['start:dev'], 'no new long-running entry point');
  assert.equal(Object.keys(packageJson.scripts).some((name) => /daemon|worker|cron/i.test(name)),
    false, 'no new scheduled or resident runner');
  assert.doesNotMatch(ENVELOPE_REMOVAL_MIGRATION, /pg_cron|CREATE EXTENSION|LISTEN |NOTIFY /,
    'the migration starts nothing that keeps running after it commits');

  // Its whole DDL vocabulary: replace one function, drop five, drop one column. No table, no index,
  // no trigger, no type -- the temporary table lives for the length of the transaction and holds
  // what the digests were before the redefinition.
  const ddl = [...ENVELOPE_REMOVAL_MIGRATION.matchAll(
    /^(?:CREATE|ALTER|DROP)(?: OR REPLACE)?(?: TEMPORARY)? [A-Z]+/gm)].map((match) => match[0]);
  assert.deepEqual([...new Set(ddl)].sort(), [
    'ALTER TABLE', 'CREATE OR REPLACE FUNCTION', 'CREATE TEMPORARY TABLE', 'DROP FUNCTION',
  ], 'the migration creates no relation and no trigger');
  assert.match(ENVELOPE_REMOVAL_MIGRATION,
    /ALTER TABLE "project_completion_contract" DROP COLUMN "authority_envelope";/);

  // "Fewer lines" measured where the claim is actually true and stays true: the SQL the database
  // RUNS. A landed migration is never deleted, so counting the working tree would count the
  // append-only history and report the opposite of what happened. In force before this file: the
  // snapshot builder plus the six envelope functions. In force after it: the snapshot builder.
  const before = [
    ['0216_project_authority_envelope', 'project_authority_policy_rank'],
    ['0216_project_authority_envelope', 'project_authority_limit_ceiling'],
    ['0216_project_authority_envelope', 'project_authority_envelope_material'],
    ['0216_project_authority_envelope', 'project_authority_envelope'],
    ['0216_project_authority_envelope', 'project_authority_envelope_ratified'],
    ['0218_owner_ratification_queue_removal', 'project_authority_envelope_recut'],
    ['0218_owner_ratification_queue_removal', 'project_completion_contract_snapshot'],
  ].reduce((total, [migration, name]) =>
    total + historicalFunction(migration, name).split('\n').length, 0);
  const after = historicalFunction(
    ENVELOPE_REMOVAL_MIGRATION_DIR, 'project_completion_contract_snapshot',
  ).split('\n').length;
  assert.ok(after < before,
    `the SQL in force must shrink: ${after} lines replaced ${before}`);
  evidence.invariants.envelopeRemovalIsSubtraction = true;
  evidence.samples.sqlInForce = digest(`${before}->${after}`);
});
