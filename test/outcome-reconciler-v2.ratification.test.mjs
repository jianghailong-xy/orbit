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
 * The approval queue is removed; the write protection on acceptance criteria is not.
 *
 * This suite used to prove a signature protocol. What it proves now is the pair the account owner
 * separated: that the queue is gone from the schema, the API, the web app and the dispatch path
 * (a)-(d), and that the one thing the queue was carrying which had a reason of its own -- an agent
 * cannot silently rewrite the standard it is measured against -- still holds, and now holds
 * against the CRITERIA SET rather than against a whole-contract digest that moved for reasons that
 * had nothing to do with the criteria (e)-(l).
 *
 * Two further groups: the 0211 fallback that rewrote ordinary engineering failures into owner
 * decisions is gone while the four real boundaries are untouched (m)-(n), and this change did not
 * overreach into HUMAN_SIGNOFF, into project acceptance, or into the deployment (o)-(q).
 *
 * A last group, (r)-(v), is the other half of the same subtraction. 0216's authority envelope was
 * a permissiveness ceiling that only an APPROVAL could raise, and 0218 deleted approvals, so it
 * became six functions computing "the current value". It is gone, and the hard part of removing it
 * is proven rather than asserted: contractDigest -- which the proposal channel and the DONE gate
 * are both keyed on -- does not move by one byte.
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
    // The four the account owner named. They are the reason this channel is kept at all.
    criteriaEditingHasNoWebEntryPoint: false,
    criteriaProposalHasNoAutomaticApplyPath: false,
    criteriaProposalDoesNotMoveTheRuler: false,
    criteriaProposalMachineDecisionRefused: false,
    // The queue is gone.
    approvalQueueTablesRemoved: false,
    approvalQueueHasNoResidualReference: false,
    approvalQueueHasNoWebSurface: false,
    automaticDispatchNoLongerWaitsForApproval: false,
    automaticDispatchRaisesNoRatificationObligation: false,
    doneGateHasNoRatificationClause: false,
    // The proposal is decoupled from the completion contract and bound to the criteria set.
    proposalHasNoRatificationForeignKey: false,
    proposalDoesNotDependOnContractDigest: false,
    proposalSurvivesBudgetRecipientAndRiskEdits: false,
    proposalOnePendingPerProject: false,
    proposalSupersedesRatherThanCoexists: false,
    // Nothing overreached.
    humanSignoffUntouched: false,
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
  races: {
    // ABA: three independent ways an old proposal could come back to life, all refused.
    abaEditThenRevert: false,
    abaDeleteAndRecreate: false,
    abaIdentityReplacement: false,
  },
  removals: {
    // Six functions, one trigger and one column.
    authorityEnvelopeMachineryRemoved: false,
    // The 0211 fallback is gone and the four real boundaries are not.
    staleContractFallbackBranchRemoved: false,
    goalBoundaryStillRoutesToOwner: false,
    riskBoundaryStillRoutesToOwner: false,
    authorizationBoundaryStillRoutesToOwner: false,
    externalIdentityBoundaryStillRoutesToOwner: false,
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

/** A project with one HUMAN_SIGNOFF criterion, its contract cut, and no approval of any kind. */
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
     ) VALUES ($1,$2,1,$3,$4,'HUMAN_SIGNOFF'::"task_completion_criterion",$5)`,
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
            "risk_policy_digest"::text AS "riskPolicyDigest",
            project_acceptance_criteria_set_digest("project_id") AS "criteriaDigest"
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

function criterionBody(fixture, overrides = {}) {
  return {
    definitionId: overrides.definitionId === undefined ? fixture.definitionId : overrides.definitionId,
    text: overrides.text ?? fixture.criterionText,
    verificationMethod: overrides.verificationMethod ?? 'review the evidence',
    completionCriterion: overrides.completionCriterion ?? 'HUMAN_SIGNOFF',
  };
}

async function propose(fixture, body, options = {}) {
  return jsonCall(
    `SELECT project_propose_acceptance_criteria($1::uuid,$2::uuid,$3,$4,$5::jsonb,$6) AS result`,
    [
      ownerId,
      fixture.projectId,
      options.actorType ?? 'AGENT',
      options.actorId ?? `agent:${fixture.projectId}`,
      JSON.stringify(body),
      options.idempotencyKey ?? `propose:${fixture.projectId}:${randomUUID()}`,
    ],
  );
}

async function decide(fixture, proposal, options = {}) {
  return jsonCall(
    `SELECT project_owner_decide_criteria_proposal(
       $1::uuid,$2::uuid,$3,$4,$5::uuid,$6,$7,$8
     ) AS result`,
    [
      ownerId,
      fixture.projectId,
      options.actorType ?? 'OWNER',
      options.actorId ?? ownerId,
      proposal.proposalId,
      options.expectedCardDigest ?? proposal.cardDigest,
      options.decision ?? 'APPROVE',
      options.idempotencyKey ?? `decide:${fixture.projectId}:${randomUUID()}`,
    ],
  );
}

async function proposalState(projectId) {
  return jsonCall('SELECT project_criteria_proposal_state_json($1::uuid,$2::uuid) AS result',
    [ownerId, projectId]);
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
  // dropped TABLE name is matched only next to a SQL keyword, because `project_owner_decision_
  // request` is also the name of a live MCP tool -- the completion-ACK owner-decision protocol,
  // which is backed by `outcome_coordinator_owner_decision_request` and is not being removed.
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
  const obligations = (await pool.query(
    `SELECT count(*)::int AS count FROM "task_auto_dispatch_obligation_revision"
      WHERE "reason_code" = 'OWNER_RATIFICATION_REQUIRED'`,
  )).rows[0].count;
  assert.equal(obligations, 0, 'no OWNER_RATIFICATION_REQUIRED obligation may be recordable');
  const disposition = read('src/apiserver/src/common/auto-dispatch-obligation.ts');
  assert.doesNotMatch(disposition, /OWNER_RATIFICATION_REQUIRED/,
    'the refusal-to-disposition mapper must have no ratification branch left to take');
  const tasksService = read('src/apiserver/src/tasks/tasks.service.ts');
  assert.doesNotMatch(tasksService, /project_owner_ratification_effective/,
    'neither dispatch sweep may prefilter on an approval');
  assert.match(tasksService, /const SCHEDULED_DUE_SQL[\s\S]*t\.run_at <= now\(\)/,
    'the scheduled sweep itself is untouched');
  evidence.invariants.automaticDispatchRaisesNoRatificationObligation = true;
});

// (d) --------------------------------------------------------------------------------------------
test('(d) the DONE gate carries no ratification clause at either layer', async () => {
  const fixture = await createProject('done-gate');
  const gate = await jsonCall(
    `SELECT project_canonical_done_gate($1::uuid,'PROJECT',$1::text) AS result`,
    [fixture.projectId],
  );
  assert.ok(gate && typeof gate === 'object', 'the gate returns a structured view');
  assert.equal(gate.ratification, undefined, 'the gate must not carry a ratification key');
  assert.ok(!JSON.stringify(gate).includes('OWNER_RATIFICATION'),
    'no reason, obligation or next action may name owner ratification');
  assert.ok(!JSON.stringify(gate).includes('owner.ratification.review'),
    'the gate must not route anybody to an owner-ratification review that no longer exists');

  // Both layers, because the outer gate returns the projection's value as its base: a clause left
  // in `outcome_projection.done_gate_value` would keep the refusal under a different call.
  const body = (await pool.query(
    `SELECT p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = 'project_canonical_done_gate_projection_integrity_body'`,
  )).rows[0].prosrc;
  assert.doesNotMatch(body, /effective_ratification|OWNER_RATIFICATION_INVALID/,
    'the outer gate must not compute or report a ratification verdict');
  const projection = (await pool.query(
    `SELECT p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'outcome_projection' AND p.proname = 'done_gate_value'`,
  )).rows[0].prosrc;
  assert.doesNotMatch(projection, /'ratification', jsonb_build_object|OWNER_RATIFICATION_INVALID/,
    'the projection gate must not emit or block on a ratification clause');

  // The staleness clause that shares that code path is kept, and is what now refuses a gate whose
  // cut has moved. Removing the authority clause must not have removed this one.
  assert.match(body, /COMPLETION_CONTRACT_DRIFTED/,
    'binding/evaluation drift must still block the gate');
  assert.match(body, /'category', 'STALENESS'/,
    'contract drift is a staleness fact, not an authority one');
  evidence.invariants.doneGateHasNoRatificationClause = true;
});

// (e) --------------------------------------------------------------------------------------------
test('(e) criteriaEditingHasNoWebEntryPoint: the web app cannot restate a project\'s criteria', () => {
  // The agent's door routes `acceptanceCriteriaItems` into a proposal instead of a write.
  const runner = read('src/apiserver/src/runner-api/runner-projects.controller.ts');
  assert.match(runner,
    /async updateProject\([\s\S]*const \{ acceptanceCriteriaItems, \.\.\.rest \} = dto;[\s\S]*this\.acceptance\.proposeCriteriaChange\(/,
    'a runner PATCH carrying acceptance criteria must become a proposal, not a write');
  assert.doesNotMatch(runner,
    /async updateProject\([\s\S]*this\.projects\.update\(runner\.ownerId, id, dto,/,
    'the whole body, acceptance criteria included, must not reach the project write path');
  assert.match(runner, /@Post\('projects\/:id\/acceptance\/criteria-proposals'\)/,
    'the agent has a door of its own onto the proposal channel');

  // Three independent guards on the web side, so an editor cannot be reintroduced by routing
  // around any one of them: the authoring field exists only as a READ type, no request the web
  // builds carries acceptance criteria, and the project-scoped writes it makes are an enumerated
  // set containing neither POST /projects nor PATCH /projects/:id.
  const webSources = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
      webSources.push({ path: path.relative(ROOT, full), source: readFileSync(full, 'utf8') });
    }
  };
  walk(path.join(ROOT, 'src/web/src'));
  assert.ok(webSources.length > 50, 'the web scan must actually have read the app');
  for (const file of webSources) {
    for (const line of file.source.split('\n')) {
      if (!line.includes('acceptanceCriteriaItems')) continue;
      assert.match(line, /acceptanceCriteriaItems\?:/,
        `${file.path} may only READ acceptanceCriteriaItems, never author it`);
    }
  }

  /** Each `api(...)` invocation's arguments, sliced on balanced parentheses. */
  const apiCalls = (source) => {
    const calls = [];
    const opening = /\bapi(?:<[\s\S]*?>)?\(/g;
    let match;
    while ((match = opening.exec(source))) {
      let depth = 1;
      let index = opening.lastIndex;
      while (index < source.length && depth > 0) {
        if (source[index] === '(') depth += 1;
        else if (source[index] === ')') depth -= 1;
        index += 1;
      }
      calls.push(source.slice(opening.lastIndex, index - 1));
    }
    return calls;
  };
  const builders = new Map();
  for (const file of webSources) {
    for (const match of file.source.matchAll(
      /export function ([A-Za-z0-9_]+)\([^)]*\): string \{\s*return ([^;]+);/g,
    )) builders.set(match[1], match[2].trim());
  }
  const resolveUrl = (expression, hops = 0) => {
    const literal = expression.match(/^[`'"](.*)[`'"]$/s);
    if (literal) return literal[1];
    const call = expression.match(/^([A-Za-z0-9_]+)\(/);
    if (!call || hops > 3 || !builders.has(call[1])) return expression;
    const body = builders.get(call[1]);
    const template = body.match(/^`(.*)`$/s);
    if (!template) return resolveUrl(body, hops + 1);
    return template[1].replace(/\$\{([A-Za-z0-9_]+)\([^)]*\)\}/g, (whole, name) =>
      (builders.has(name) ? resolveUrl(`${name}()`, hops + 1) : whole));
  };
  const projectWrites = [];
  for (const file of webSources) {
    for (const call of apiCalls(file.source)) {
      assert.doesNotMatch(call, /acceptanceCriteria/,
        `${file.path} must not send acceptance criteria in any request`);
      const url = resolveUrl(call.split(/,(?![^{[(]*[}\])])/)[0].trim());
      if (!url.startsWith('/projects')) continue;
      const method = call.match(/method:\s*'([A-Z]+)'/)?.[1] ?? 'GET';
      if (method === 'GET') continue;
      projectWrites.push(`${method} ${url}`.replace(/\$\{[^}]*\}/g, ':id'));
    }
  }
  assert.deepEqual([...new Set(projectWrites)].sort(), [
    'POST /projects/:id/acceptance/runs/:id/verdict',
    'POST /projects/:id/coordinator',
    'POST /projects/:id/coordinator/rebind',
    'POST /projects/:id/criteria-proposal/decision',
    'POST /projects/:id/handoffs/:id/decision',
    'POST /projects/:id/reopen',
  ], 'the web app writes to a project only through these routes: no POST /projects and no '
   + 'PATCH /projects/:id, which are the only two that can restate a project\'s criteria');
  evidence.invariants.criteriaEditingHasNoWebEntryPoint = true;
});

// (f) --------------------------------------------------------------------------------------------
test('(f) criteriaProposalHasNoAutomaticApplyPath: nothing but the owner\'s answer applies one',
  async () => {
  // Structural: exactly one caller of the apply, and it is the decision function -- which begins
  // by refusing every non-OWNER principal.
  const callers = (await pool.query(
    `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosrc ~ 'project_apply_criteria_proposal'
        AND p.proname <> 'project_apply_criteria_proposal' ORDER BY 1`,
  )).rows.map((row) => row.proname);
  assert.deepEqual(callers, ['project_owner_decide_criteria_proposal'],
    'the apply has exactly one caller and it is the owner decision');
  const decide = await installedFunction('project_owner_decide_criteria_proposal');
  assert.match(decide, /p_actor_type <> 'OWNER'/,
    'the one caller refuses every non-owner principal in its first lines');
  const triggers = (await pool.query(
    `SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND c.relname = 'project_criteria_proposal'`,
  )).rows.map((row) => row.tgname);
  assert.deepEqual(triggers, [], 'no trigger may apply, expire or auto-answer a proposal');

  // Behavioural: an expired proposal is still PENDING and still un-applied. Expiry is not a
  // decision, and no timeout, sweep or resubmission substitutes for one.
  const fixture = await createProject('no-auto-apply');
  const before = await criteriaRows(fixture.projectId);
  const proposed = await propose(fixture, {
    criteria: [criterionBody(fixture, { text: 'an agent would rather be measured by this' })],
  });
  assert.equal(proposed.ok, true);
  await pool.query(
    `UPDATE "project_criteria_proposal" SET "expires_at" = now() - interval '30 days'
      WHERE "id" = $1::uuid`,
    [proposed.proposalId],
  );
  await pool.query('SELECT project_refresh_completion_contract($1::uuid,$2)',
    [fixture.projectId, 'AFTER_EXPIRY']);
  const state = await proposalState(fixture.projectId);
  assert.equal(state.proposal.status, 'PENDING', 'an expired proposal stays pending');
  assert.deepEqual(await criteriaRows(fixture.projectId), before,
    'an expired proposal applies nothing');
  assert.equal(state.currentCriteriaDigest, fixture.criteriaDigest);
  evidence.invariants.criteriaProposalHasNoAutomaticApplyPath = true;
});

// (g) --------------------------------------------------------------------------------------------
test('(g) criteriaProposalDoesNotMoveTheRuler: the standard in force is the one that judges',
  async () => {
  const fixture = await createProject('inert');
  const before = await criteriaRows(fixture.projectId);

  const proposed = await propose(fixture, {
    criteria: [criterionBody(fixture, { text: 'a standard the agent would prefer' })],
    whyNotAgent: 'the standard this project is judged by is not the agent\'s to move',
  });
  assert.equal(proposed.ok, true);
  assert.equal(proposed.applied, false);
  assert.equal(proposed.status, 'PENDING');
  assert.equal(proposed.effectiveCriteriaUnchanged, true);
  assert.equal(proposed.reasonCode, 'GOAL_DECISION');
  assert.equal(proposed.baseCriteriaDigest, fixture.criteriaDigest);

  // Not one byte of the effective rows, including the two revision lanes an edit would advance.
  assert.deepEqual(await criteriaRows(fixture.projectId), before,
    'a proposal must not touch one byte of the effective criteria');
  const after = await contract(fixture.projectId);
  assert.equal(after.criteriaDigest, fixture.criteriaDigest);
  assert.equal(after.contractDigest, fixture.contractDigest);
  assert.equal(after.contractRevision, fixture.contractRevision);

  // And what judges the project is still the set in force: the DONE gate reads the acceptance
  // definitions, and the proposal is not among them.
  const judging = await jsonCall(
    `SELECT jsonb_agg("text" ORDER BY "ordinal") AS result
       FROM "project_acceptance_criterion_definition" WHERE "project_id" = $1::uuid`,
    [fixture.projectId],
  );
  assert.deepEqual(judging, [fixture.criterionText],
    'the criteria that decide completion are the ones in force, never the proposed ones');
  const surface = await proposalState(fixture.projectId);
  assert.deepEqual(surface.effectiveCriteria.map((item) => item.text), [fixture.criterionText]);
  assert.equal(surface.proposal.proposedCriteria[0].text, 'a standard the agent would prefer');
  assert.notEqual(surface.proposal.proposedCriteria[0].text, surface.effectiveCriteria[0].text);
  evidence.invariants.criteriaProposalDoesNotMoveTheRuler = true;
});

// (h) --------------------------------------------------------------------------------------------
test('(h) criteriaProposalMachineDecisionRefused: a runner or agent cannot answer its own card',
  async () => {
  const fixture = await createProject('machine-decision');
  const proposed = await propose(fixture, {
    criteria: [criterionBody(fixture, { text: 'the agent approves of this standard' })],
  });
  assert.equal(proposed.ok, true);
  const before = await criteriaRows(fixture.projectId);

  // Every machine principal the propose door accepts, plus a USER id that is not the owner: each
  // is refused by the database, not by a caller that could be routed around.
  for (const [actorType, actorId] of [
    ['AGENT', `agent:${fixture.projectId}`],
    ['RUNNER', `runner:${fixture.projectId}`],
    ['SERVICE', `service:${fixture.projectId}`],
    ['USER', randomUUID()],
    ['OWNER', randomUUID()],
  ]) {
    await assert.rejects(
      () => decide(fixture, proposed, { actorType, actorId }),
      (error) => {
        assert.match(String(error.message), /PROJECT_CRITERIA_DECISION_ACTOR_FORBIDDEN/);
        assert.equal(error.code, '42501', 'the refusal is insufficient_privilege');
        return true;
      },
      `${actorType} must not be able to decide a criteria proposal`,
    );
  }
  assert.deepEqual(await criteriaRows(fixture.projectId), before,
    'a refused machine decision applies nothing');
  assert.equal((await proposalState(fixture.projectId)).proposal.status, 'PENDING');

  // The HTTP door in front of it refuses the same thing one layer earlier, so a machine never even
  // reaches the database function.
  const service = read('src/apiserver/src/projects/project-acceptance.service.ts');
  assert.match(service,
    /async decideCriteriaProposal[\s\S]*actor\.actorType !== 'USER'[\s\S]*PROJECT_CRITERIA_DECISION_ACTOR_FORBIDDEN/,
    'the owner decision is refused for every non-user principal before it reaches PostgreSQL');
  const runner = read('src/apiserver/src/runner-api/runner-projects.controller.ts');
  assert.doesNotMatch(runner, /decideCriteriaProposal|criteria-proposal\/decision/,
    'the machine door has no decision route at all');

  // And the owner CAN, on the same proposal: the refusal above is about the principal, not about
  // a proposal that had become undecidable.
  const approved = await decide(fixture, proposed);
  assert.equal(approved.ok, true);
  assert.equal(approved.status, 'APPLIED');
  evidence.invariants.criteriaProposalMachineDecisionRefused = true;
});

// (i) --------------------------------------------------------------------------------------------
test('(i) the proposal is bound to the criteria set and to nothing else', async () => {
  const foreignKeys = (await pool.query(
    `SELECT con.conname, tgt.relname AS target
       FROM pg_constraint con
       JOIN pg_class src ON src.oid = con.conrelid
       JOIN pg_class tgt ON tgt.oid = con.confrelid
      WHERE con.contype = 'f' AND src.relname = 'project_criteria_proposal'
      ORDER BY con.conname`,
  )).rows;
  assert.deepEqual(foreignKeys.map((row) => row.target).sort(),
    ['project', 'project_criteria_proposal', 'user'],
    'the proposal points at its project, its owner and its own successor -- nothing else');
  assert.ok(!foreignKeys.some((row) => row.conname.includes('ratification_id')),
    'the ratification foreign key must be gone');
  evidence.invariants.proposalHasNoRatificationForeignKey = true;

  const columns = (await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'project_criteria_proposal' ORDER BY column_name`,
  )).rows.map((row) => row.column_name);
  assert.ok(!columns.includes('ratification_id'));
  assert.ok(!columns.includes('base_contract_digest'));
  assert.ok(!columns.includes('base_contract_revision'));
  assert.ok(!columns.includes('applied_contract_digest'));
  assert.ok(columns.includes('base_criteria_digest'));
  assert.ok(columns.includes('applied_criteria_digest'));

  // The three functions that make up the channel must not consult the completion contract's
  // digest for the base check any more. `project_refresh_completion_contract` is still called
  // after an APPROVE -- keeping the read model current is not the same as binding to it.
  const propose = await installedFunction('project_propose_acceptance_criteria');
  const decide = await installedFunction('project_owner_decide_criteria_proposal');
  const surface = await installedFunction('project_criteria_proposal_state_json');
  for (const [name, body] of [['propose', propose], ['decide', decide], ['state', surface]]) {
    assert.doesNotMatch(body, /state\."contract_digest"|contract_revision/,
      `${name} must not bind the proposal to the completion contract`);
  }
  assert.match(decide, /project_acceptance_criteria_set_digest\(p_project\)/,
    'the base check compares criteria-set digests');
  evidence.invariants.proposalDoesNotDependOnContractDigest = true;
});

// (j) --------------------------------------------------------------------------------------------
test('(j) a budget, recipient or risk edit does not invalidate a pending criteria proposal',
  async () => {
  const fixture = await createProject('narrowing');
  const proposed = await propose(fixture, {
    criteria: [criterionBody(fixture, { text: 'a narrower standard' })],
  });
  assert.equal(proposed.ok, true);
  assert.equal(proposed.baseCriteriaDigest, fixture.criteriaDigest);

  // Exactly the three groups the old whole-contract digest folded in, and one member of each.
  const memberRunnerId = randomUUID();
  const memberAgentId = randomUUID();
  await pool.query(
    `INSERT INTO "runner" ("id","owner_id","name","token_hash","status","max_concurrent",
                           "last_heartbeat_at","capabilities","capabilities_reported_at")
     VALUES ($1,$2,'narrowing runner',$3,'ONLINE'::"runner_status",4,now(),'{}',now())`,
    [memberRunnerId, ownerId, `fixture-${memberRunnerId}`],
  );
  await pool.query(
    `INSERT INTO "workspace" ("id","owner_id","runner_id","name","enabled")
     VALUES ($1,$2,$3,'recipient workspace',true)`,
    [memberAgentId, ownerId, memberRunnerId],
  );
  await pool.query(
    `INSERT INTO "project_member" ("id","project_id","agent_id","role")
     VALUES ($1::uuid,$2::uuid,$3::uuid,'COORDINATOR'::"project_role")`,
    [randomUUID(), fixture.projectId, memberAgentId],
  );
  await pool.query(
    `UPDATE "project"
        SET "session_budget_per_day" = 99, "attempt_budget" = '{"perTask": 7}'::jsonb,
            "automation_policy" = 'MANUAL'::"project_automation_policy",
            "max_concurrent_tasks" = 7, "config_revision" = "config_revision" + 1,
            "updated_at" = now()
      WHERE "id" = $1::uuid`,
    [fixture.projectId],
  );
  await pool.query('SELECT project_refresh_completion_contract($1::uuid,$2)',
    [fixture.projectId, 'BUDGET_RECIPIENT_RISK_EDIT']);
  const moved = await contract(fixture.projectId);

  // The narrowing, stated as the two facts side by side: the whole-contract digest DID move --
  // which is what used to invalidate this proposal -- and the criteria-set digest did not.
  assert.notEqual(moved.contractDigest, fixture.contractDigest,
    'budget, recipients and risk still move the completion contract');
  assert.notEqual(moved.budgetDigest, fixture.budgetDigest);
  assert.notEqual(moved.recipientDigest, fixture.recipientDigest);
  assert.notEqual(moved.riskPolicyDigest, fixture.riskPolicyDigest);
  assert.equal(moved.criteriaDigest, fixture.criteriaDigest,
    'none of them moves the criteria set');

  const state = await proposalState(fixture.projectId);
  assert.equal(state.proposal.status, 'PENDING');
  assert.equal(state.proposal.baseMatchesCurrentCriteria, true,
    'the pending proposal is still drafted against the criteria in force');
  const approved = await decide(fixture, proposed);
  assert.equal(approved.ok, true, 'and the owner can still answer it');
  assert.equal(approved.status, 'APPLIED');
  assert.equal(approved.previousCriteriaDigest, fixture.criteriaDigest);
  assert.notEqual(approved.appliedCriteriaDigest, fixture.criteriaDigest);
  evidence.invariants.proposalSurvivesBudgetRecipientAndRiskEdits = true;
});

// (k) --------------------------------------------------------------------------------------------
test('(k) ABA: an edit and its revert cannot revive a proposal drafted before the edit',
  async () => {
  const fixture = await createProject('aba-revert');
  const proposed = await propose(fixture, {
    criteria: [criterionBody(fixture, { text: 'proposed against the original wording' })],
  });
  assert.equal(proposed.ok, true);
  await pool.query(
    'UPDATE "project_acceptance_criterion_definition" SET "text" = $2 WHERE "id" = $1::uuid',
    [fixture.definitionId, 'briefly something else'],
  );
  await pool.query(
    'UPDATE "project_acceptance_criterion_definition" SET "text" = $2 WHERE "id" = $1::uuid',
    [fixture.definitionId, fixture.criterionText],
  );
  const back = await contract(fixture.projectId);
  const rows = await criteriaRows(fixture.projectId);
  assert.equal(rows[0].text, fixture.criterionText, 'the wording is byte-identical again');
  assert.equal(rows[0].semantic_revision, 3, 'semanticRevision only ever goes up');
  assert.notEqual(back.criteriaDigest, fixture.criteriaDigest,
    'edit-then-revert must not land back on the drafting digest');
  const refused = await decide(fixture, proposed);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'CRITERIA_PROPOSAL_BASE_MOVED');
  assert.equal(refused.currentCriteriaDigest, back.criteriaDigest);
  assert.equal((await proposalState(fixture.projectId)).proposal.status, 'PENDING');
  evidence.races.abaEditThenRevert = true;
});

test('(k) ABA: deleting and recreating a criterion cannot revive a proposal', async () => {
  const fixture = await createProject('aba-recreate');
  const proposed = await propose(fixture, {
    criteria: [criterionBody(fixture, { text: 'proposed against the original row' })],
  });
  assert.equal(proposed.ok, true);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'DELETE FROM "project_acceptance_criterion_definition" WHERE "id" = $1::uuid',
      [fixture.definitionId],
    );
    await client.query(
      `INSERT INTO "project_acceptance_criterion_definition" (
         "id","project_id","ordinal","text","verification_method","completion_criterion",
         "content_hash"
       ) VALUES ($1,$2,1,$3,$4,'HUMAN_SIGNOFF'::"task_completion_criterion",$5)`,
      [randomUUID(), fixture.projectId, fixture.criterionText, 'review aba-recreate evidence',
        digest(`recreated:${fixture.projectId}`)],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  const rows = await criteriaRows(fixture.projectId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, fixture.criterionText, 'the wording is byte-identical');
  assert.notEqual(rows[0].id, fixture.definitionId, 'behind a different row');
  const refused = await decide(fixture, proposed);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'CRITERIA_PROPOSAL_BASE_MOVED');
  evidence.races.abaDeleteAndRecreate = true;
});

test('(k) ABA: swapping the row behind identical wording cannot revive a proposal', async () => {
  const fixture = await createProject('aba-identity');
  const proposed = await propose(fixture, {
    criteria: [criterionBody(fixture, { text: 'proposed against the original identity' })],
  });
  assert.equal(proposed.ok, true);
  const replacementId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO "project_acceptance_criterion_definition" (
         "id","project_id","ordinal","text","verification_method","completion_criterion",
         "content_hash"
       ) VALUES ($1,$2,2,$3,$4,'HUMAN_SIGNOFF'::"task_completion_criterion",$5)`,
      [replacementId, fixture.projectId, fixture.criterionText, `review ${'aba-identity'} evidence`,
        digest(`replacement:${fixture.projectId}`)],
    );
    await client.query(
      'DELETE FROM "project_acceptance_criterion_definition" WHERE "id" = $1::uuid',
      [fixture.definitionId],
    );
    await client.query('UPDATE "project_acceptance_criterion_definition" SET "ordinal" = 1 '
      + 'WHERE "id" = $1::uuid', [replacementId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  const rows = await criteriaRows(fixture.projectId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, fixture.criterionText);
  assert.equal(rows[0].verification_method, 'review aba-identity evidence');
  assert.equal(rows[0].id, replacementId, 'the identity behind the wording was swapped');
  const refused = await decide(fixture, proposed);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'CRITERIA_PROPOSAL_BASE_MOVED');
  evidence.races.abaIdentityReplacement = true;
});

// (l) --------------------------------------------------------------------------------------------
test('(l) a project has at most one pending proposal, and the replaced one says why', async () => {
  const index = (await pool.query(
    `SELECT pg_get_indexdef(i.indexrelid) AS definition
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = 'project_criteria_proposal_one_pending_idx'`,
  )).rows[0];
  assert.ok(index, 'the partial unique index must survive the decoupling');
  assert.match(index.definition, /UNIQUE INDEX.*\(project_id\).*WHERE \(status = 'PENDING'::text\)/);

  const fixture = await createProject('one-pending');
  const first = await propose(fixture, {
    criteria: [criterionBody(fixture, { text: 'the first proposal' })],
  });
  assert.equal(first.ok, true);
  const second = await propose(fixture, {
    criteria: [criterionBody(fixture, { text: 'the second proposal' })],
  }, { actorType: 'RUNNER', actorId: 'runner:one-pending' });
  assert.equal(second.ok, true);
  assert.equal(second.supersededProposalId, first.proposalId);

  const pending = (await pool.query(
    `SELECT count(*)::int AS count FROM "project_criteria_proposal"
      WHERE "project_id" = $1::uuid AND "status" = 'PENDING'`,
    [fixture.projectId],
  )).rows[0].count;
  assert.equal(pending, 1, 'exactly one proposal may await the owner');
  const retired = (await pool.query(
    `SELECT "status","superseded_by_id"::text AS "supersededById","superseded_reason" AS reason,
            "superseded_at" IS NOT NULL AS "hasTime"
       FROM "project_criteria_proposal" WHERE "id" = $1::uuid`,
    [first.proposalId],
  )).rows[0];
  assert.equal(retired.status, 'SUPERSEDED');
  assert.equal(retired.supersededById, second.proposalId);
  assert.equal(retired.hasTime, true);
  assert.match(retired.reason, /Replaced by a newer proposal from RUNNER runner:one-pending/,
    'a replaced proposal is never an absence: it names who replaced it and why');
  const settled = await decide(fixture, first);
  assert.equal(settled.ok, false);
  assert.equal(settled.code, 'CRITERIA_PROPOSAL_ALREADY_SETTLED');
  evidence.invariants.proposalOnePendingPerProject = true;
  evidence.invariants.proposalSupersedesRatherThanCoexists = true;
});

// (m) --------------------------------------------------------------------------------------------
test('(m) the stale-contract fallback that rewrote engineering failures is gone', async () => {
  const claim = await installedFunction('failure_continuation_route_claim');

  // The exact branch, removed. It read: any unrouted failure, on a project whose ratification
  // happened to be STALE, becomes GOAL_DECISION / GOAL_BOUNDARY -- overwriting the real
  // failure_node of a timeout or a leaked container and filing an owner obligation with no
  // discharging action.
  assert.doesNotMatch(claim, /v_contract_ratification_state/,
    'the routing function may not compute a contract ratification state at all');
  assert.doesNotMatch(claim, /ELSIF[\s\S]{0,120}'STALE'[\s\S]{0,120}v_owner_reason := 'GOAL_DECISION'/,
    'the stale-contract fallback branch must be gone');
  assert.doesNotMatch(claim, /project_owner_ratification/,
    'the routing function may not read an approval row');

  // Structural, so it cannot come back under another name: `v_owner_reason` is assigned in exactly
  // two places -- from the caller's explicit owner reason, and from a real boundary node.
  const assignments = claim.match(/v_owner_reason :=/g) ?? [];
  assert.equal(assignments.length, 2,
    'an owner reason may only come from the caller or from a real boundary node');

  // And a route can no longer even record the state that branch keyed on.
  const columns = (await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'failure_continuation_route_decision'`,
  )).rows.map((row) => row.column_name);
  assert.ok(!columns.includes('contract_ratification_state'));
  assert.ok(!columns.includes('ratified_evaluation_plan_digest'));
  const routeRead = await installedFunction('failure_continuation_route_read');
  assert.doesNotMatch(routeRead, /contractRatificationState|ratifiedEvaluationPlanDigest/,
    'no route projection may report a ratification state');

  // The text lane that selects an engineering node is untouched, so the same input that was being
  // rewritten still reaches its real node.
  assert.match(claim, /v_failure_node := 'PRODUCT_BEHAVIOR';/,
    'an unrecognised engineering failure still lands on its real node');
  assert.match(claim, /v_failure_node := 'TEST_HARNESS';/);
  assert.match(claim, /-- Text can select an engineering node only\. It can never manufacture an owner decision\./,
    'the rule the removed branch violated is still stated where it is enforced');
  evidence.removals.staleContractFallbackBranchRemoved = true;
});

// (n) --------------------------------------------------------------------------------------------
for (const [node, reason, key] of [
  ['GOAL_BOUNDARY', 'GOAL_DECISION', 'goalBoundaryStillRoutesToOwner'],
  ['RISK_BOUNDARY', 'RISK_ACCEPTANCE', 'riskBoundaryStillRoutesToOwner'],
  ['AUTHORIZATION_BOUNDARY', 'NEW_AUTHORIZATION', 'authorizationBoundaryStillRoutesToOwner'],
  ['EXTERNAL_IDENTITY_BOUNDARY', 'EXTERNAL_IDENTITY', 'externalIdentityBoundaryStillRoutesToOwner'],
]) {
  test(`(n) a real ${node} failure still routes to the owner as ${reason}`, async () => {
    const claim = await installedFunction('failure_continuation_route_claim');
    // The boundary block above the removed fallback: a real boundary node still derives its owner
    // reason, and an owner reason still selects the OWNER_REQUIRED domain.
    assert.match(claim, new RegExp(`WHEN '${node}' THEN '${reason}'`),
      `${node} must still derive ${reason}`);
    assert.match(claim, new RegExp(`WHEN '${reason}' THEN '${node}'`),
      `${reason} must still require ${node}, so text cannot forge one without the other`);
    assert.match(claim, /IF v_owner_reason IS NOT NULL THEN\s*\n\s*v_failure_domain := 'OWNER_REQUIRED';/,
      'an owner reason still selects the owner domain');
    // The closed sets are still declared as CHECK constraints, so a route cannot record a fifth
    // owner reason or drop one of the four.
    const constraint = (await pool.query(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid = 'failure_continuation_route_decision'::regclass
          AND conname LIKE '%owner_reason%'`,
    )).rows[0];
    assert.ok(constraint, 'the owner-reason set is still a database constraint');
    assert.match(constraint.definition, new RegExp(`'${reason}'`));
    evidence.removals[key] = true;
  });
}

// (o) --------------------------------------------------------------------------------------------
test('(o) HUMAN_SIGNOFF is untouched: the migration cannot reach it, and it still works',
  async () => {
  // Static: 0218 contains no statement that could write task completion criteria or signoffs.
  // Function bodies are excluded from this scan because a CREATE FUNCTION is not a write -- and
  // the only body that writes acceptance definitions is the owner-decision apply, which is the
  // channel being kept.
  const migration = read(
    'src/apiserver/prisma/migrations/0218_owner_ratification_queue_removal/migration.sql',
  );
  const topLevel = migration.replace(/AS \$\$[\s\S]*?\$\$ LANGUAGE/g, 'AS $$ $$ LANGUAGE');
  for (const relation of ['task_human_signoff', 'task_judgment_request', 'task']) {
    assert.doesNotMatch(topLevel,
      new RegExp(`(INSERT INTO|UPDATE|DELETE FROM|ALTER TABLE|DROP TABLE)\\s+"?${relation}"?(\\s|$)`, 'im'),
      `the migration must contain no statement that writes ${relation}`);
  }

  // Dynamic: the whole HUMAN_SIGNOFF path still round-trips, field for field. 0180 predates this
  // project, 1,123 production tasks stand on it, and the proof that they are unaffected is that
  // nothing in the migration can reach them and the path they use still behaves identically.
  const fixture = await createProject('human-signoff');
  const taskId = randomUUID();
  const evidenceDigest = digest(`signoff:${taskId}`);
  await pool.query(
    `INSERT INTO "task" ("id","owner_id","project_id","title","creator_type","creator_id",
                         "provider","status","completion_criterion","updated_at")
     VALUES ($1,$2,$3,'human signoff task','USER'::"creator_type",$2,'claude',
             'OPEN'::"task_status",'HUMAN_SIGNOFF'::"task_completion_criterion",now())`,
    [taskId, ownerId, fixture.projectId],
  );
  const task = (await pool.query(
    'SELECT "completion_criterion"::text AS criterion FROM "task" WHERE "id" = $1::uuid', [taskId],
  )).rows[0];
  assert.equal(task.criterion, 'HUMAN_SIGNOFF',
    'the completion criterion 1,123 production tasks carry is still storable and still reads back');
  // The signoff table itself is unchanged since 0180: its complete column set, its constraints,
  // its foreign keys and its guard trigger are compared against the catalogue, so a column added,
  // widened or dropped by this migration would be visible here rather than in production.
  const signoffColumns = (await pool.query(
    `SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'task_human_signoff' ORDER BY column_name`,
  )).rows;
  assert.deepEqual(signoffColumns, [
    { column_name: 'evidence', data_type: 'text', is_nullable: 'NO' },
    { column_name: 'evidence_digest', data_type: 'character', is_nullable: 'NO' },
    { column_name: 'id', data_type: 'uuid', is_nullable: 'NO' },
    { column_name: 'request_id', data_type: 'uuid', is_nullable: 'NO' },
    { column_name: 'signed_at', data_type: 'timestamp without time zone', is_nullable: 'NO' },
    { column_name: 'signed_by_id', data_type: 'uuid', is_nullable: 'NO' },
    { column_name: 'task_id', data_type: 'uuid', is_nullable: 'NO' },
  ], 'the 0180 column set is unchanged');
  const signoffConstraints = (await pool.query(
    `SELECT conname FROM pg_constraint WHERE conrelid = 'task_human_signoff'::regclass
      ORDER BY conname`,
  )).rows.map((row) => row.conname);
  assert.deepEqual(signoffConstraints, [
    'task_human_signoff_digest_shape',
    'task_human_signoff_evidence_nonblank',
    'task_human_signoff_pkey',
    'task_human_signoff_request_fact_fkey',
    'task_human_signoff_request_fact_key',
    'task_human_signoff_request_id_key',
    'task_human_signoff_signed_by_id_fkey',
    'task_human_signoff_task_id_fkey',
  ], 'every 0180 constraint, including the request-fact key, still stands');
  const signoffTriggers = (await pool.query(
    `SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND c.relname = 'task_human_signoff' ORDER BY 1`,
  )).rows.map((row) => row.tgname);
  assert.deepEqual(signoffTriggers, ['task_human_signoff_current_request_guard'],
    'the current-request guard is neither removed nor joined by a new one');

  // And the enum the 1,123 production tasks are stored under still has exactly its three peers,
  // in order: dropping or reordering one is what would silently reinterpret them.
  const criteria = (await pool.query(
    `SELECT unnest(enum_range(NULL::"task_completion_criterion"))::text AS value`,
  )).rows.map((row) => row.value);
  assert.deepEqual(criteria, ['EXECUTABLE', 'VERIFICATION', 'HUMAN_SIGNOFF'],
    'HUMAN_SIGNOFF is still one of three peers, in its original position');
  evidence.invariants.humanSignoffUntouched = true;
  evidence.samples.humanSignoffDigest = evidenceDigest;
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
  const digestOne = (await pool.query(
    'SELECT project_acceptance_criteria_set_digest($1::uuid) AS result', [fixture.projectId],
  )).rows[0].result;
  const digestTwo = (await pool.query(
    'SELECT project_acceptance_criteria_set_digest($1::uuid) AS result', [fixture.projectId],
  )).rows[0].result;
  assert.equal(digestOne, digestTwo, 'the digest is stable');
  assert.deepEqual(await criteriaRows(fixture.projectId), before,
    'reading the digest must not move one field of a definition');

  // And the per-run acceptance rows -- 313 of them in production -- still write and read back.
  const runId = randomUUID();
  const criterionId = randomUUID();
  await pool.query(
    `INSERT INTO "project_acceptance_run" ("id","project_id","attempt","decided_by",
                                           "criteria_snapshot","criteria_revision","input_digest")
     VALUES ($1,$2,1,'USER','[]'::jsonb,$3,$4)`,
    [runId, fixture.projectId, digest(`revision:${runId}`), digest(`input:${runId}`)],
  );
  await pool.query(
    `INSERT INTO "project_acceptance_criterion" ("id","run_id","project_id","ordinal",
                                                 "criterion_key","criterion_text","definition_id",
                                                 "definition_revision")
     VALUES ($1,$2,$3,1,'k1',$4,$5,1)`,
    [criterionId, runId, fixture.projectId, fixture.criterionText, fixture.definitionId],
  );
  const criterion = (await pool.query(
    'SELECT * FROM "project_acceptance_criterion" WHERE "id" = $1::uuid', [criterionId],
  )).rows[0];
  assert.equal(criterion.criterion_text, fixture.criterionText);
  assert.equal(criterion.definition_id, fixture.definitionId);
  assert.equal(criterion.completion_criterion, 'HUMAN_SIGNOFF');
  evidence.invariants.projectAcceptanceUntouched = true;
});

// (q) --------------------------------------------------------------------------------------------
test('(q) this change adds no compose service and no resident process', () => {
  const compose = read('docker-compose.yml');
  const services = [...compose.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((match) => match[1]);
  assert.deepEqual(services.sort(), [
    'apiserver', 'executable-dead-man', 'gateway', 'outcome-coordinator',
    'outcome-coordinator-secondary', 'pg-socket', 'pgbackup', 'postgres', 'watchdog', 'web',
  ], 'the deployment is exactly the services it already had');

  // A resident process would arrive as a new long-running start script or a new scheduled job.
  const packageJson = JSON.parse(read('package.json'));
  const apiserver = JSON.parse(read('src/apiserver/package.json'));
  assert.deepEqual(Object.keys(apiserver.scripts).filter((name) => name.startsWith('start:')).sort(),
    ['start:dev', 'start:outcome-coordinator', 'start:watchdog'],
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
test('(t) removing the envelope filed no owner decision and voided no proposal', async () => {
  // Comments and both kinds of dollar-quoted body removed: what is left is the statements the file
  // actually runs, which is what "wrote nothing" has to be true of.
  const statements = ENVELOPE_REMOVAL_MIGRATION
    .replace(/AS \$\$[\s\S]*?\$\$ LANGUAGE/g, 'AS $$ $$ LANGUAGE')
    .replace(/DO \$\$[\s\S]*?END \$\$;/g, 'DO $$ $$;')
    .split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
  for (const relation of ['outcome_coordinator_owner_decision_request', 'project_criteria_proposal',
    'project_completion_contract', 'project']) {
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

  // Live, and the part a file scan cannot reach: a proposal standing against the criteria set
  // survives a re-cut under the new snapshot, and no owner decision appears behind it.
  const fixture = await createProject('envelope-removal-negative');
  const proposed = await propose(fixture, {
    criteria: [criterionBody(fixture, { text: 'a different standard' })],
  });
  assert.equal(proposed.ok, true);
  const decisionsBefore = (await pool.query(
    'SELECT count(*)::int AS count FROM "outcome_coordinator_owner_decision_request"',
  )).rows[0].count;
  const proposalRow = async () => (await pool.query(
    `SELECT "status","base_criteria_digest","card_digest","superseded_reason"
       FROM "project_criteria_proposal" WHERE "id" = $1::uuid`,
    [proposed.proposalId],
  )).rows[0];
  const before = await proposalRow();
  assert.equal(before.status, 'PENDING');
  await pool.query('SELECT project_refresh_completion_contract($1::uuid,$2)',
    [fixture.projectId, 'ENVELOPE_REMOVAL_NEGATIVE']);
  assert.deepEqual(await proposalRow(), before,
    'the pending proposal must not move when the contract is re-cut');
  assert.equal((await pool.query(
    'SELECT count(*)::int AS count FROM "outcome_coordinator_owner_decision_request"',
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
  assert.deepEqual(services.sort(), [
    'apiserver', 'executable-dead-man', 'gateway', 'outcome-coordinator',
    'outcome-coordinator-secondary', 'pg-socket', 'pgbackup', 'postgres', 'watchdog', 'web',
  ], 'the deployment is exactly the services it already had');
  const packageJson = JSON.parse(read('package.json'));
  const apiserver = JSON.parse(read('src/apiserver/package.json'));
  assert.deepEqual(Object.keys(apiserver.scripts).filter((name) => name.startsWith('start:')).sort(),
    ['start:dev', 'start:outcome-coordinator', 'start:watchdog'],
    'no new long-running entry point');
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
