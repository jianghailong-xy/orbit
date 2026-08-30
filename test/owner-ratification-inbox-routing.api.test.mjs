import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test, { after, before } from 'node:test';

const require = createRequire(import.meta.url);
const { Pool } = require('pg');
const { Module, ValidationPipe } = require('@nestjs/common');
const { HttpAdapterHost, NestFactory } = require('@nestjs/core');
const { JwtModule, JwtService } = require('@nestjs/jwt');
const { uuidToBase62 } = require('@orbit/shared');

const ROOT = path.resolve(import.meta.dirname, '..');
const API_DIST = path.join(ROOT, 'src/apiserver/dist');
const { ProjectsController } = require(path.join(API_DIST, 'projects/projects.controller.js'));
const { ProjectsService } = require(path.join(API_DIST, 'projects/projects.service.js'));
const {
  ProjectAcceptanceService,
} = require(path.join(API_DIST, 'projects/project-acceptance.service.js'));
const { ProjectHandoffService } = require(path.join(API_DIST, 'projects/project-handoff.service.js'));
const { SessionAttemptService } = require(path.join(API_DIST, 'projects/session-attempt.service.js'));
const { TaskCheckpointService } = require(path.join(API_DIST, 'projects/task-checkpoint.service.js'));
const { PrismaService } = require(path.join(API_DIST, 'prisma/prisma.service.js'));
const { JwtAuthGuard } = require(path.join(API_DIST, 'auth/jwt-auth.guard.js'));
const {
  PublicIdInterceptor,
} = require(path.join(API_DIST, 'common/public-id.interceptor.js'));
const {
  PublicIdExceptionFilter,
} = require(path.join(API_DIST, 'common/public-id.filter.js'));
const {
  OutcomeProjectionService,
} = require(path.join(API_DIST, 'outcome-reconciler/outcome-projection.service.js'));
const {
  OutcomeSurfaceService,
} = require(path.join(API_DIST, 'outcome-reconciler/outcome-surface.service.js'));
const {
  OutcomeSurfacesController,
} = require(path.join(API_DIST, 'outcome-reconciler/outcome-surfaces.controller.js'));

const URL = process.env.OWNER_RATIFICATION_ROUTING_PG_URL;
const EXPECTED_DATABASE = process.env.OWNER_RATIFICATION_ROUTING_PG_EXPECTED_DATABASE;
const EXPECTED_USER = process.env.OWNER_RATIFICATION_ROUTING_PG_EXPECTED_USER;
const EXPECTED_SYSTEM_IDENTIFIER =
  process.env.OWNER_RATIFICATION_ROUTING_PG_EXPECTED_SYSTEM_IDENTIFIER;
const EVIDENCE_PATH = process.env.OWNER_RATIFICATION_ROUTING_EVIDENCE_PATH;
const FIXTURE_PATH = process.env.OWNER_RATIFICATION_ROUTING_FIXTURE_PATH;
const SECRET = 'owner-ratification-routing-fixture-jwt-secret-at-least-32-bytes';

assert.ok(URL, 'OWNER_RATIFICATION_ROUTING_PG_URL is required');
assert.ok(EXPECTED_DATABASE, 'expected disposable database name is required');
assert.ok(EXPECTED_USER, 'expected disposable database role is required');
assert.ok(EXPECTED_SYSTEM_IDENTIFIER, 'expected disposable cluster identity is required');
assert.ok(EVIDENCE_PATH, 'OWNER_RATIFICATION_ROUTING_EVIDENCE_PATH is required');
assert.ok(FIXTURE_PATH, 'OWNER_RATIFICATION_ROUTING_FIXTURE_PATH is required');

BigInt.prototype.toJSON = function toJSON() { return this.toString(); };

const pool = new Pool({ connectionString: URL, max: 20 });
const seeded = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
assert.equal(seeded.seededBeforeMigration, '0210_owner_ratification_inbox_eligibility');
const ownerId = seeded.ownerId;
let app;
let prisma;
let origin;
let token;
const fixtures = seeded.fixtures;

const evidence = {
  schemaVersion: 1,
  suite: 'owner-ratification-inbox-routing-api',
  postgres: { required: true, connected: false, database: null, systemIdentifier: null },
  migration: {
    sameBatchInitialShape: false,
    legacyRowsMarkedDeferred: false,
    originalAuditRetained: false,
  },
  routing: {
    openActiveIncluded: false,
    openInactiveExcluded: false,
    doneExcluded: false,
    cancelledExcluded: false,
    staleContractIncluded: false,
    legacyOutcomeInboxFiltered: false,
  },
  consistency: {
    inboxAttentionDetailIdentity: false,
    eligibilityReasonShared: false,
    obligationRevisionBindingShared: false,
    repeatedReadsIdempotent: false,
    onePendingPerProject: false,
    differentDigestsIndependent: false,
  },
  samples: {},
};

async function addRatificationBlocker(project, suffix = '0') {
  const taskId = randomUUID();
  await pool.query(
    `INSERT INTO "task" (
       "id","title","status","owner_id","creator_type","creator_id","project_id","updated_at"
     ) VALUES ($1,$2,'OPEN'::"task_status",$3,'USER'::"creator_type",$3,$4,now())`,
    [taskId, `${project.label} blocker ${suffix}`, ownerId, project.projectId],
  );
  const epoch = (await pool.query(
    'SELECT "epoch" FROM "task_dispatch_epoch" WHERE "task_id"=$1',
    [taskId],
  )).rows[0]?.epoch;
  assert.ok(epoch !== undefined);
  await pool.query(
    `SELECT task_auto_dispatch_record(
       $1::uuid,$2::uuid,$3::bigint,'READY_SWEEP','REFUSED',
       'OWNER_RATIFICATION_REQUIRED',$4::jsonb,'OWNER','RATIFY_CURRENT_CONTRACT',
       NULL,now()+interval '1 hour'
     )`,
    [
      ownerId,
      taskId,
      epoch,
      JSON.stringify({
        code: 'OWNER_RATIFICATION_REQUIRED',
        message: 'fixture canonical action is blocked by exact ratification',
        nextAction: 'owner.ratification.review',
      }),
    ],
  );
  return taskId;
}

async function state(projectId) {
  return (await pool.query(
    'SELECT project_owner_ratification_state_json($1::uuid,$2::uuid) AS state',
    [ownerId, projectId],
  )).rows[0].state;
}

async function approveCurrent(project) {
  const current = await state(project.projectId);
  assert.ok(current.decisionRequest, `${project.label} must be actionable before approval`);
  const result = (await pool.query(
    `SELECT project_owner_ratify_contract(
       $1::uuid,$2::uuid,'OWNER',$1::text,$3,$4::uuid,$5::uuid,
       'APPROVE',$6,false
     ) AS result`,
    [
      ownerId,
      project.projectId,
      current.contractDigest,
      current.decisionRequest.id,
      current.decisionRequest.ctaToken,
      `routing-stale:${project.projectId}`,
    ],
  )).rows[0].result;
  assert.equal(result.ok, true);
  return current;
}

async function forceHistoricalStatus(projectId, status) {
  const client = await pool.connect();
  try {
    await client.query("SET session_replication_role='replica'");
    await client.query(
      'UPDATE "project" SET "status"=$2::"project_status","updated_at"=now() WHERE "id"=$1',
      [projectId, status],
    );
  } finally {
    await client.query("SET session_replication_role='origin'");
    client.release();
  }
}

function bearer() {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

async function http(urlPath, init = {}) {
  const response = await fetch(`${origin}${urlPath}`, {
    ...init,
    headers: { ...bearer(), ...(init.headers ?? {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

function publicId(project) {
  return uuidToBase62(project.projectId);
}

function sharedIdentity(item) {
  return {
    projectId: item.projectId,
    contractDigest: item.contractDigest,
    obligationId: item.obligationId,
    obligationRevision: item.obligationRevision,
    bindingDigest: item.linkedObligations?.[0]?.bindingDigest ?? item.bindingDigest,
    evaluatedThroughWatermark: item.evaluatedThroughWatermark,
    reasonCode: item.reasonCode,
    eligibilityReasonCode: item.eligibility.reasonCode,
    eligibilityReason: item.eligibility.reason,
    bindingStatus: item.eligibility.bindingStatus,
  };
}

before(async () => {
  const server = (await pool.query(`
    SELECT current_database() AS database, current_user AS role,
           (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier,
           current_setting('server_version') AS version
  `)).rows[0];
  assert.equal(server.database, EXPECTED_DATABASE);
  assert.equal(server.role, EXPECTED_USER);
  assert.equal(server.system_identifier, EXPECTED_SYSTEM_IDENTIFIER);
  evidence.postgres = {
    required: true,
    connected: true,
    database: server.database,
    systemIdentifier: server.system_identifier,
    version: server.version.split(' ')[0],
  };

  const batch = await pool.query(
    `SELECT request."project_id" AS "projectId",request."request_generation"::text AS generation,
            request."contract_revision"::text AS revision,request."semantic_diff" AS diff,
            request."routing_state" AS routing,request."created_at"::text AS "createdAt",
            project."status"::text AS "projectStatus"
       FROM "project_owner_decision_request" request
       JOIN "project" project ON project."id"=request."project_id"
      WHERE request."project_id"=ANY($1::uuid[]) ORDER BY request."project_id"`,
    [Object.values(fixtures).map((item) => item.projectId)],
  );
  assert.equal(batch.rows.length, 5);
  assert.ok(batch.rows.every((row) => row.generation === '1' && row.revision === '1'));
  assert.ok(batch.rows.every((row) => row.diff.initial === true));
  assert.ok(batch.rows.every((row) => row.routing === 'DEFERRED'));
  assert.equal(new Set(batch.rows.map((row) => row.createdAt)).size, 1);
  assert.equal(
    batch.rows.find((row) => row.projectId === fixtures.done.projectId).projectStatus,
    'DONE',
  );
  assert.equal(
    batch.rows.find((row) => row.projectId === fixtures.cancelled.projectId).projectStatus,
    'CANCELLED',
  );
  evidence.migration.sameBatchInitialShape = true;
  evidence.migration.legacyRowsMarkedDeferred = true;

  const { active, done, cancelled, stale } = fixtures;
  await Promise.all([
    addRatificationBlocker(active),
    addRatificationBlocker(done),
    addRatificationBlocker(cancelled),
    addRatificationBlocker(stale, 'old-contract'),
  ]);
  const oldStale = await approveCurrent(stale);
  stale.oldContractDigest = oldStale.contractDigest;
  await pool.query(
    'UPDATE "project" SET "goal"=$2,"updated_at"=now() WHERE "id"=$1',
    [stale.projectId, 'stale-contract materially changed goal'],
  );
  await addRatificationBlocker(stale, 'current-contract');
  await forceHistoricalStatus(done.projectId, 'DONE');
  await forceHistoricalStatus(cancelled.projectId, 'CANCELLED');

  prisma = new PrismaService();
  await prisma.$connect();
  const acceptance = new ProjectAcceptanceService(prisma);
  const projects = new ProjectsService(prisma, acceptance);
  const projections = new OutcomeProjectionService(prisma);
  const outcomes = new OutcomeSurfaceService(prisma, projections, acceptance);

  class RoutingHarnessModule {}
  Module({
    imports: [JwtModule.register({ secret: SECRET })],
    controllers: [ProjectsController, OutcomeSurfacesController],
    providers: [
      JwtAuthGuard,
      { provide: ProjectsService, useValue: projects },
      { provide: ProjectAcceptanceService, useValue: acceptance },
      { provide: ProjectHandoffService, useValue: {} },
      { provide: SessionAttemptService, useValue: {} },
      { provide: TaskCheckpointService, useValue: {} },
      { provide: OutcomeSurfaceService, useValue: outcomes },
    ],
  })(RoutingHarnessModule);

  app = await NestFactory.create(RoutingHarnessModule, { logger: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalInterceptors(new PublicIdInterceptor());
  const adapter = app.get(HttpAdapterHost).httpAdapter;
  app.useGlobalFilters(new PublicIdExceptionFilter(adapter));
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  assert.ok(address && typeof address === 'object');
  origin = `http://127.0.0.1:${address.port}/api`;
  token = app.get(JwtService).sign({ sub: ownerId, email: 'routing@example.test' });
});

after(async () => {
  if (app) await app.close();
  if (prisma) await prisma.$disconnect();
  await pool.end();
  mkdirSync(path.dirname(EVIDENCE_PATH), { recursive: true });
  writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence)}\n`);
});

test('runs only against the isolated PostgreSQL fixture', () => {
  assert.equal(evidence.postgres.connected, true);
  assert.notEqual(EXPECTED_DATABASE, 'orbit');
});

test('only OPEN projects with a current ratification boundary enter both global inbox APIs', async () => {
  const [canonical, legacy] = await Promise.all([
    http('/projects/ratification/pending?limit=100'),
    http('/outcomes/inbox?limit=100'),
  ]);
  assert.equal(canonical.response.status, 200);
  assert.equal(legacy.response.status, 200);
  const expected = [publicId(fixtures.active), publicId(fixtures.stale)].sort();
  assert.deepEqual(canonical.body.items.map((item) => item.projectId).sort(), expected);
  assert.equal(canonical.body.total, 2);
  const legacyRatifications = legacy.body.items.filter(
    (item) => item.decisionType === 'OWNER_RATIFICATION',
  );
  assert.deepEqual(legacyRatifications.map((item) => item.projectId).sort(), expected);
  assert.equal(legacyRatifications.length, 2);

  for (const reference of canonical.body.items) {
    assert.equal(reference.eligible, true);
    assert.equal(reference.eligibility.eligible, true);
    assert.equal(reference.eligibility.requiresOwnerNow, true);
    assert.equal(reference.eligibility.state, 'ACTIVE');
    assert.equal(reference.eligibility.projectStatus, 'OPEN');
    assert.equal(reference.reasonCode, 'OWNER_RATIFICATION_REQUIRED');
    const oldItem = legacyRatifications.find((item) => item.projectId === reference.projectId);
    assert.ok(oldItem);
    assert.deepEqual(sharedIdentity(reference), sharedIdentity({
      ...oldItem,
      linkedObligations: oldItem.eligibility.linkedObligations,
    }));
  }
  evidence.routing.openActiveIncluded = true;
  evidence.routing.openInactiveExcluded = true;
  evidence.routing.doneExcluded = true;
  evidence.routing.cancelledExcluded = true;
  evidence.routing.staleContractIncluded = true;
  evidence.routing.legacyOutcomeInboxFiltered = true;
  evidence.consistency.eligibilityReasonShared = true;
  evidence.consistency.obligationRevisionBindingShared = true;
  evidence.samples.activeInbox = canonical.body.items.map(sharedIdentity);
});

test('Project Attention and detail use the identical active reference and hide terminal/deferred rows', async () => {
  const [inbox, openProjects, allProjects, activeDetail, staleDetail] = await Promise.all([
    http('/projects/ratification/pending?limit=100'),
    http('/projects?status=OPEN'),
    http('/projects'),
    http(`/projects/${publicId(fixtures.active)}`),
    http(`/projects/${publicId(fixtures.stale)}`),
  ]);
  for (const result of [inbox, openProjects, allProjects, activeDetail, staleDetail]) {
    assert.equal(result.response.status, 200);
  }
  for (const fixture of [fixtures.active, fixtures.stale]) {
    const id = publicId(fixture);
    const fromInbox = inbox.body.items.find((item) => item.projectId === id);
    const fromAttention = openProjects.body.find((item) => item.id === id).ownerRatification;
    const fromDetail = id === publicId(fixtures.active)
      ? activeDetail.body.ownerRatification
      : staleDetail.body.ownerRatification;
    assert.deepEqual(sharedIdentity(fromAttention), sharedIdentity(fromInbox));
    assert.deepEqual(sharedIdentity(fromDetail), sharedIdentity(fromInbox));
  }
  assert.equal(
    openProjects.body.find((item) => item.id === publicId(fixtures.inactive)).ownerRatification,
    null,
  );
  for (const fixture of [fixtures.done, fixtures.cancelled]) {
    assert.equal(
      allProjects.body.find((item) => item.id === publicId(fixture)).ownerRatification,
      null,
    );
  }
  assert.equal(staleDetail.body.ownerRatification.eligibility.bindingStatus, 'STALE');
  evidence.consistency.inboxAttentionDetailIdentity = true;
});

test('inactive and terminal initial requests remain complete audit records without an urgent CTA', async () => {
  for (const [fixture, reasonCode] of [
    [fixtures.inactive, 'OWNER_RATIFICATION_DEFERRED_NO_BLOCKING_ACTION'],
    [fixtures.done, 'OWNER_RATIFICATION_PROJECT_NOT_OPEN'],
    [fixtures.cancelled, 'OWNER_RATIFICATION_PROJECT_NOT_OPEN'],
  ]) {
    const review = await http(`/projects/${publicId(fixture)}/ratification`);
    const compatibility = await http(`/outcomes/ratifications/projects/${publicId(fixture)}`);
    assert.equal(review.response.status, 200);
    assert.equal(compatibility.response.status, 200);
    assert.equal(review.body.decisionRequest, null);
    assert.equal(review.body.decisionSurface, null);
    assert.equal(compatibility.body.decisionRequest, null);
    assert.equal(review.body.eligibility.eligible, false);
    assert.equal(review.body.eligibility.reasonCode, reasonCode);
    const audit = review.body.auditRequests.find(
      (item) => item.requestGeneration === '1',
    );
    assert.ok(audit);
    assert.equal(audit.id, uuidToBase62(fixture.initialRequest.id));
    assert.equal(audit.contractDigest, fixture.initialRequest.contractDigest);
    assert.equal(audit.contractRevision, '1');
    assert.equal(audit.requestGeneration, '1');
    assert.equal(audit.semanticDiff.initial, true);
    assert.equal(audit.routingState, 'DEFERRED');
    assert.equal(JSON.stringify(review.body).includes('ctaToken'), false);
    assert.equal(JSON.stringify(compatibility.body).includes('ctaToken'), false);
  }
  evidence.migration.originalAuditRetained = true;
});

test('repeated reads derive no duplicate PENDING and stale digest approval never carries forward', async () => {
  const first = await http(`/projects/${publicId(fixtures.stale)}/ratification`);
  const second = await http(`/projects/${publicId(fixtures.stale)}/ratification`);
  assert.equal(first.response.status, 200);
  assert.equal(second.response.status, 200);
  assert.equal(first.body.decisionRequest.id, second.body.decisionRequest.id);
  assert.equal(first.body.contractDigest, second.body.contractDigest);
  assert.notEqual(first.body.contractDigest, fixtures.stale.oldContractDigest);
  assert.equal(first.body.ratified, false);
  assert.equal(first.body.eligibility.bindingStatus, 'STALE');
  const rows = await pool.query(
    `SELECT "status",count(*)::int AS count
       FROM "project_owner_decision_request" WHERE "project_id"=$1
      GROUP BY "status" ORDER BY "status"`,
    [fixtures.stale.projectId],
  );
  assert.equal(rows.rows.find((row) => row.status === 'PENDING').count, 1);
  assert.equal(rows.rows.find((row) => row.status === 'APPROVED').count, 1);
  const digests = first.body.auditRequests.map((item) => item.contractDigest);
  assert.equal(new Set(digests).size, 2);
  evidence.consistency.repeatedReadsIdempotent = true;
  evidence.consistency.onePendingPerProject = true;
  evidence.consistency.differentDigestsIndependent = true;
  evidence.samples.staleAudit = first.body.auditRequests.map((item) => ({
    id: item.id,
    status: item.status,
    contractDigest: item.contractDigest,
    contractRevision: item.contractRevision,
    requestGeneration: item.requestGeneration,
    semanticDiff: item.semanticDiff,
  }));
});

test('approving one active digest removes only that request and leaves the other Project actionable', async () => {
  const review = await http(`/projects/${publicId(fixtures.active)}/ratification`);
  const request = review.body.decisionRequest;
  assert.ok(request?.ctaToken);
  const decided = await http(`/projects/${publicId(fixtures.active)}/ratification`, {
    method: 'POST',
    body: {
      decision: 'APPROVE',
      decisionRequestId: request.id,
      ctaToken: request.ctaToken,
      expectedContractDigest: review.body.contractDigest,
      idempotencyKey: `routing-independent:${fixtures.active.projectId}`,
    },
  });
  assert.equal(decided.response.status, 201);
  assert.equal(decided.body.ok, true);
  const inbox = await http('/projects/ratification/pending?limit=100');
  assert.equal(inbox.response.status, 200);
  assert.deepEqual(inbox.body.items.map((item) => item.projectId), [publicId(fixtures.stale)]);
  assert.equal(inbox.body.items[0].contractDigest, (await state(fixtures.stale.projectId)).contractDigest);
});
