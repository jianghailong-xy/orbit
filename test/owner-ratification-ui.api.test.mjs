import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test, { after, before } from 'node:test';

const require = createRequire(import.meta.url);
const { Pool } = require('pg');
const { Module, ValidationPipe } = require('@nestjs/common');
const { HttpAdapterHost, NestFactory } = require('@nestjs/core');
const { JwtModule, JwtService } = require('@nestjs/jwt');
const { uuidToBase62, toUuid } = require('@orbit/shared');

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

const URL = process.env.OWNER_RATIFICATION_UI_PG_URL;
const EXPECTED_DATABASE = process.env.OWNER_RATIFICATION_UI_PG_EXPECTED_DATABASE;
const EXPECTED_USER = process.env.OWNER_RATIFICATION_UI_PG_EXPECTED_USER;
const EXPECTED_SYSTEM_IDENTIFIER =
  process.env.OWNER_RATIFICATION_UI_PG_EXPECTED_SYSTEM_IDENTIFIER;
const EVIDENCE_PATH = process.env.OWNER_RATIFICATION_UI_API_EVIDENCE_PATH;
const SECRET = 'owner-ratification-ui-fixture-jwt-secret-at-least-32-bytes';
const PROTECTED_PUBLIC_REQUEST = '4p6aWT57DodHjWYEPs2PIJ';
const PROTECTED_REQUEST = toUuid(PROTECTED_PUBLIC_REQUEST);

assert.ok(URL, 'OWNER_RATIFICATION_UI_PG_URL is required');
assert.ok(EXPECTED_DATABASE, 'expected disposable database name is required');
assert.ok(EXPECTED_USER, 'expected disposable database role is required');
assert.ok(EXPECTED_SYSTEM_IDENTIFIER, 'expected disposable cluster identity is required');
assert.ok(EVIDENCE_PATH, 'OWNER_RATIFICATION_UI_API_EVIDENCE_PATH is required');

BigInt.prototype.toJSON = function toJSON() { return this.toString(); };

const pool = new Pool({ connectionString: URL, max: 20 });
const ownerId = randomUUID();
const otherOwnerId = randomUUID();
const observedUrls = [];
const logLines = [];
const errorBodies = [];
let app;
let prisma;
let origin;
let ownerToken;
let otherToken;
let canonicalFixture;
let protectedBefore;

const evidence = {
  schemaVersion: 1,
  suite: 'owner-ratification-ui-api',
  postgres: { required: true, connected: false, database: null, systemIdentifier: null },
  surfaces: {
    pendingInbox: false,
    projectAttentionPayload: false,
    projectDetail: false,
    canonicalIdentityEqual: false,
    reviewContractComplete: false,
  },
  transport: {
    ownerAuthenticatedOnly: false,
    exactRequestDigestCtaIdempotency: false,
    ctaAbsentFromUrls: false,
    ctaAbsentFromLogs: false,
    ctaAbsentFromErrors: false,
    ctaAbsentFromTelemetry: false,
    privateNoStore: false,
  },
  resilience: {
    approveDoubleClickAppendOnce: false,
    approveAutomaticallyRearmed: false,
    denyReplayRecovered: false,
    mixedClientConflictRecovered: false,
    staleFailedClosed: false,
    expiredReplacementCommitted: false,
    wrongCtaFailedClosed: false,
    crossOwnerNotFound: false,
  },
  protectedProductionRequest: {
    publicId: PROTECTED_PUBLIC_REQUEST,
    forbiddenAsTestTarget: true,
    fixtureSentinelOnly: true,
    beforeDigest: null,
    afterDigest: null,
    unchanged: false,
    observedInHttpUrl: false,
  },
  samples: {},
};

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function loggerLine(values) {
  return values.map((value) => {
    if (value instanceof Error) return `${value.name}:${value.message}`;
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); } catch { return String(value); }
  }).join(' ');
}

const harnessLogger = {
  log: (...values) => logLines.push(loggerLine(values)),
  error: (...values) => logLines.push(loggerLine(values)),
  warn: (...values) => logLines.push(loggerLine(values)),
  debug: (...values) => logLines.push(loggerLine(values)),
  verbose: (...values) => logLines.push(loggerLine(values)),
  fatal: (...values) => logLines.push(loggerLine(values)),
};

async function insertOwner(id, label) {
  await pool.query(
    `INSERT INTO "user" ("id","email","name","password_hash") VALUES ($1,$2,$3,'x')`,
    [id, `${label}-${id}@example.test`, `${label} owner`],
  );
}

async function ratificationState(owner, projectId) {
  const result = await pool.query(
    'SELECT project_owner_ratification_state_json($1::uuid,$2::uuid) AS state',
    [owner, projectId],
  );
  return result.rows[0].state;
}

async function createProjectFixture(label, options = {}) {
  const projectId = randomUUID();
  const taskId = randomUUID();
  const fixtureOwner = options.ownerId ?? ownerId;
  const criterionCount = options.criterionCount ?? 14;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO "project" (
         "id","owner_id","title","goal","coordinator_enabled","automation_policy",
         "max_concurrent_tasks","session_budget_per_day","attempt_budget","updated_at"
       ) VALUES ($1,$2,$3,$4,true,'GUARDED_AUTO'::"project_automation_policy",3,NULL,NULL,now())`,
      [projectId, fixtureOwner, `${label} project`, `${label}: exact guarded owner goal`],
    );
    await client.query(
      `INSERT INTO "project_acceptance_criterion_definition" (
         "id","project_id","ordinal","text","verification_method","completion_criterion",
         "content_hash"
       )
       SELECT gen_random_uuid(), $1::uuid, ordinal,
              $2 || ' criterion ' || ordinal::text,
              'fixture review ' || ordinal::text,
              'HUMAN_SIGNOFF'::"task_completion_criterion",
              encode(digest(($1::text || ':' || ordinal::text)::bytea, 'sha256'), 'hex')
         FROM generate_series(1, $3::int) ordinal`,
      [projectId, label, criterionCount],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  let state = await ratificationState(fixtureOwner, projectId);
  if (options.withObligation !== false) {
    await pool.query(
      `INSERT INTO "task" (
         "id","title","status","owner_id","creator_type","creator_id","project_id","updated_at"
       ) VALUES ($1,$2,'OPEN'::"task_status",$3,'USER'::"creator_type",$3,$4,now())`,
      [taskId, `${label} task`, fixtureOwner, projectId],
    );
    const epoch = await pool.query(
      'SELECT "epoch" FROM "task_dispatch_epoch" WHERE "task_id"=$1',
      [taskId],
    );
    assert.equal(epoch.rows.length, 1, 'fixture task dispatch epoch was not created');
    await pool.query(
      `SELECT task_auto_dispatch_record(
         $1::uuid,$2::uuid,$3::bigint,'READY_SWEEP','REFUSED',
         'OWNER_RATIFICATION_REQUIRED',$4::jsonb,'OWNER','RATIFY_CURRENT_CONTRACT',
         NULL,now()+interval '1 hour'
       )`,
      [
        fixtureOwner,
        taskId,
        epoch.rows[0].epoch,
        JSON.stringify({
          code: 'OWNER_RATIFICATION_REQUIRED',
          message: 'fixture waits for exact owner ratification',
          nextAction: 'RATIFY_CURRENT_CONTRACT',
        }),
      ],
    );
    state = await ratificationState(fixtureOwner, projectId);
  }
  return { ownerId: fixtureOwner, projectId, taskId, state };
}

async function protectedSnapshot() {
  const result = await pool.query(
    `SELECT row_to_json(request)::text AS value
       FROM "project_owner_decision_request" request WHERE request."id"=$1`,
    [PROTECTED_REQUEST],
  );
  assert.equal(result.rows.length, 1, 'protected request fixture sentinel is absent');
  return digest(result.rows[0].value);
}

function bearer(token) {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

async function http(token, urlPath, init = {}) {
  observedUrls.push(urlPath);
  const response = await fetch(`${origin}${urlPath}`, {
    ...init,
    headers: { ...bearer(token), ...(init.headers ?? {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) errorBodies.push(body);
  return { response, body };
}

function privateRequestBody(read, decision, key) {
  return {
    decision,
    decisionRequestId: read.decisionRequest.id,
    ctaToken: read.decisionRequest.ctaToken,
    expectedContractDigest: read.contractDigest,
    idempotencyKey: key,
  };
}

function canonicalIdentity(reference) {
  return {
    decisionRequestId: reference.decisionRequestId,
    requestRevision: reference.requestRevision,
    obligationId: reference.obligationId,
    obligationRevision: reference.obligationRevision,
    contractDigest: reference.contractDigest,
    reason: reference.reasonCode,
    owner: reference.owner,
    ownerId: reference.ownerId,
    watermark: reference.evaluatedThroughWatermark,
  };
}

before(async () => {
  const isolation = await pool.query(`
    SELECT current_database() AS database, current_user AS role,
           (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier,
           current_setting('server_version') AS version
  `);
  const server = isolation.rows[0];
  assert.equal(server.database, EXPECTED_DATABASE);
  assert.equal(server.role, EXPECTED_USER);
  assert.equal(server.system_identifier, EXPECTED_SYSTEM_IDENTIFIER);
  assert.match(server.version, /^1[6-9]\./);
  evidence.postgres = {
    required: true,
    connected: true,
    database: server.database,
    systemIdentifier: server.system_identifier,
    version: server.version.split(' ')[0],
  };

  await insertOwner(ownerId, 'primary');
  await insertOwner(otherOwnerId, 'other');
  canonicalFixture = await createProjectFixture('canonical');

  const protectedOwner = randomUUID();
  await insertOwner(protectedOwner, 'protected-sentinel');
  const protectedFixture = await createProjectFixture('protected-sentinel', {
    ownerId: protectedOwner,
    criterionCount: 1,
    withObligation: false,
  });
  await pool.query(
    `UPDATE "project_owner_decision_request" SET "id"=$1
      WHERE "project_id"=$2 AND "status"='PENDING'`,
    [PROTECTED_REQUEST, protectedFixture.projectId],
  );
  protectedBefore = await protectedSnapshot();
  evidence.protectedProductionRequest.beforeDigest = protectedBefore;

  prisma = new PrismaService();
  await prisma.$connect();
  const acceptance = new ProjectAcceptanceService(prisma);
  const projects = new ProjectsService(prisma, acceptance);

  class OwnerRatificationUiHarnessModule {}
  Module({
    imports: [JwtModule.register({ secret: SECRET })],
    controllers: [ProjectsController],
    providers: [
      JwtAuthGuard,
      { provide: ProjectsService, useValue: projects },
      { provide: ProjectAcceptanceService, useValue: acceptance },
      { provide: ProjectHandoffService, useValue: {} },
      { provide: SessionAttemptService, useValue: {} },
      { provide: TaskCheckpointService, useValue: {} },
    ],
  })(OwnerRatificationUiHarnessModule);

  app = await NestFactory.create(OwnerRatificationUiHarnessModule, { logger: harnessLogger });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalInterceptors(new PublicIdInterceptor());
  const adapter = app.get(HttpAdapterHost).httpAdapter;
  app.useGlobalFilters(new PublicIdExceptionFilter(adapter));
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  assert.ok(address && typeof address === 'object');
  origin = `http://127.0.0.1:${address.port}/api`;
  const jwt = app.get(JwtService);
  ownerToken = jwt.sign({ sub: ownerId, email: 'owner@example.test' });
  otherToken = jwt.sign({ sub: otherOwnerId, email: 'other@example.test' });
});

after(async () => {
  const protectedAfter = await protectedSnapshot();
  evidence.protectedProductionRequest.afterDigest = protectedAfter;
  evidence.protectedProductionRequest.unchanged = protectedAfter === protectedBefore;
  evidence.protectedProductionRequest.observedInHttpUrl = observedUrls.some(
    (value) => value.includes(PROTECTED_PUBLIC_REQUEST) || value.includes(PROTECTED_REQUEST),
  );
  assert.equal(protectedAfter, protectedBefore, 'protected request sentinel changed');
  assert.equal(evidence.protectedProductionRequest.observedInHttpUrl, false);
  if (app) await app.close();
  if (prisma) await prisma.$disconnect();
  await pool.end();
  mkdirSync(path.dirname(EVIDENCE_PATH), { recursive: true });
  writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence)}\n`);
});

test('runs only against the isolated fixture database and forbids the protected request target', () => {
  assert.equal(evidence.postgres.connected, true);
  assert.notEqual(EXPECTED_DATABASE, 'orbit');
  assert.equal(observedUrls.length, 0);
});

test('one canonical pending reference is identical in inbox, project Attention payload and detail', async () => {
  const projectPublicId = uuidToBase62(canonicalFixture.projectId);
  const [inbox, list, detail] = await Promise.all([
    http(ownerToken, '/projects/ratification/pending?limit=100'),
    http(ownerToken, '/projects?status=OPEN'),
    http(ownerToken, `/projects/${projectPublicId}`),
  ]);
  for (const result of [inbox, list, detail]) assert.equal(result.response.status, 200);
  const inboxRef = inbox.body.items.find((item) => item.projectId === projectPublicId);
  const listRef = list.body.find((item) => item.id === projectPublicId).ownerRatification;
  const detailRef = detail.body.ownerRatification;
  assert.ok(inboxRef && listRef && detailRef);
  assert.deepEqual(canonicalIdentity(inboxRef), canonicalIdentity(listRef));
  assert.deepEqual(canonicalIdentity(inboxRef), canonicalIdentity(detailRef));
  assert.equal(inboxRef.reasonCode, 'OWNER_RATIFICATION_REQUIRED');
  assert.equal(inboxRef.owner, 'OWNER');
  assert.equal(inboxRef.linkedObligations.length, 1);
  assert.equal(inboxRef.evaluatedThroughWatermark, '0');
  assert.equal(JSON.stringify([inbox.body, list.body, detail.body]).includes('ctaToken'), false);

  evidence.surfaces.pendingInbox = true;
  evidence.surfaces.projectAttentionPayload = true;
  evidence.surfaces.projectDetail = true;
  evidence.surfaces.canonicalIdentityEqual = true;
  evidence.samples.canonicalIdentity = canonicalIdentity(inboxRef);
});

test('private no-store review is complete and its CTA never enters ordinary surfaces', async () => {
  const projectPublicId = uuidToBase62(canonicalFixture.projectId);
  const read = await http(ownerToken, `/projects/${projectPublicId}/ratification`);
  assert.equal(read.response.status, 200);
  assert.match(read.response.headers.get('cache-control') ?? '', /no-store/);
  assert.equal(read.response.headers.get('referrer-policy'), 'no-referrer');
  assert.ok(read.body.decisionRequest.ctaToken);
  assert.equal(read.body.decisionSurface.reference.decisionRequestId, read.body.decisionRequest.id);
  assert.equal(read.body.decisionSurface.reference.contractDigest, read.body.contractDigest);
  assert.equal(read.body.semanticContract.criteria.length, 14);
  assert.match(read.body.semanticContract.goal, /exact guarded owner goal/);
  assert.equal(read.body.semanticContract.riskBoundary.automationPolicy, 'GUARDED_AUTO');
  assert.equal(read.body.semanticContract.permissions.maxConcurrentTasks, 3);
  assert.equal(read.body.semanticContract.budget.sessionBudgetPerDay, null);
  assert.equal(read.body.semanticContract.budget.attemptBudget, null);
  assert.ok(read.body.decisionSurface.semanticDiff);
  assert.ok(read.body.decisionSurface.whyNotAgent);
  assert.ok(read.body.decisionSurface.impacts.APPROVE);
  assert.ok(read.body.decisionSurface.impacts.DENY);
  assert.ok(read.body.decisionSurface.recommendation);
  assert.ok(read.body.decisionSurface.noActionConsequence);
  assert.ok(read.body.decisionSurface.resumeAfterDecision);
  assert.ok(read.body.decisionSurface.reference.expiresAt);
  assert.equal(read.body.latestDecision, null);

  const deniedRead = await http(otherToken, `/projects/${projectPublicId}/ratification`);
  assert.equal(deniedRead.response.status, 404);
  assert.equal(JSON.stringify(deniedRead.body).includes(read.body.decisionRequest.ctaToken), false);
  evidence.surfaces.reviewContractComplete = true;
  evidence.transport.ownerAuthenticatedOnly = true;
  evidence.transport.privateNoStore = true;
  evidence.samples.privateRead = {
    criteria: read.body.semanticContract.criteria.length,
    automationPolicy: read.body.semanticContract.riskBoundary.automationPolicy,
    maxConcurrent: read.body.semanticContract.permissions.maxConcurrentTasks,
    nullBudgetMeaningRequiredByWeb: true,
  };
});

test('APPROVE double-click appends once, binds every exact field and rearms guarded execution', async () => {
  const fixture = await createProjectFixture('approve-double');
  const projectPublicId = uuidToBase62(fixture.projectId);
  const read = (await http(ownerToken, `/projects/${projectPublicId}/ratification`)).body;
  const body = privateRequestBody(read, 'APPROVE', `approve-double:${randomUUID()}`);
  const [left, right] = await Promise.all([
    http(ownerToken, `/projects/${projectPublicId}/ratification`, { method: 'POST', body }),
    http(ownerToken, `/projects/${projectPublicId}/ratification`, { method: 'POST', body }),
  ]);
  assert.equal(left.response.status, 201);
  assert.equal(right.response.status, 201);
  assert.deepEqual([left.body.duplicate, right.body.duplicate].sort(), [false, true]);
  assert.equal(left.body.contractDigest, body.expectedContractDigest);
  assert.equal(right.body.contractDigest, body.expectedContractDigest);
  assert.equal(JSON.stringify([left.body, right.body]).includes(body.ctaToken), false);
  const stored = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM "project_owner_ratification" WHERE "project_id"=$1) AS approvals,
       (SELECT count(*)::int FROM "project_owner_decision_request"
         WHERE "project_id"=$1 AND "decision"='APPROVE'
           AND "decision_idempotency_key"=$2) AS receipts,
       (SELECT bool_and("due_at" <= now()) FROM "task_auto_dispatch_wakeup"
         WHERE "project_id"=$1 AND "state"='PENDING') AS due_now`,
    [fixture.projectId, body.idempotencyKey],
  );
  assert.deepEqual(stored.rows[0], { approvals: 1, receipts: 1, due_now: true });
  assert.equal(left.body.automaticResume.scheduled, true);
  assert.equal(right.body.automaticResume.scheduled, true);

  const recovered = (await http(ownerToken, `/projects/${projectPublicId}/ratification`)).body;
  assert.equal(recovered.latestDecision.decisionRequestId, body.decisionRequestId);
  assert.equal(recovered.latestDecision.decision, 'APPROVE');
  assert.equal(recovered.latestDecision.contractDigest, body.expectedContractDigest);
  evidence.transport.exactRequestDigestCtaIdempotency = true;
  evidence.resilience.approveDoubleClickAppendOnce = true;
  evidence.resilience.approveAutomaticallyRearmed = true;
});

test('DENY has a durable same-key retry receipt and mixed clients cannot reverse the winner', async () => {
  const fixture = await createProjectFixture('deny-retry');
  const projectPublicId = uuidToBase62(fixture.projectId);
  const read = (await http(ownerToken, `/projects/${projectPublicId}/ratification`)).body;
  const body = privateRequestBody(read, 'DENY', `deny-retry:${randomUUID()}`);
  const first = await http(ownerToken, `/projects/${projectPublicId}/ratification`, {
    method: 'POST', body,
  });
  const networkRetry = await http(ownerToken, `/projects/${projectPublicId}/ratification`, {
    method: 'POST', body,
  });
  assert.equal(first.response.status, 201);
  assert.equal(first.body.decision, 'DENY');
  assert.equal(first.body.duplicate, false);
  assert.equal(networkRetry.response.status, 201);
  assert.equal(networkRetry.body.decision, 'DENY');
  assert.equal(networkRetry.body.duplicate, true);

  const mixedSame = await http(ownerToken, `/projects/${projectPublicId}/ratification`, {
    method: 'POST',
    body: { ...body, idempotencyKey: `mixed-deny:${randomUUID()}` },
  });
  assert.equal(mixedSame.response.status, 201);
  assert.equal(mixedSame.body.decision, 'DENY');
  assert.equal(mixedSame.body.duplicate, true);
  const mixedOpposite = await http(ownerToken, `/projects/${projectPublicId}/ratification`, {
    method: 'POST',
    body: { ...body, decision: 'APPROVE', idempotencyKey: `mixed-approve:${randomUUID()}` },
  });
  assert.equal(mixedOpposite.response.status, 409);
  assert.equal(mixedOpposite.body.code, 'OWNER_DECISION_ALREADY_SPENT');
  assert.equal(mixedOpposite.body.recordedDecision, 'DENY');
  assert.equal(JSON.stringify(mixedOpposite.body).includes(body.ctaToken), false);

  const recovered = (await http(ownerToken, `/projects/${projectPublicId}/ratification`)).body;
  assert.equal(recovered.latestDecision.decisionRequestId, body.decisionRequestId);
  assert.equal(recovered.latestDecision.decision, 'DENY');
  const counts = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM "project_owner_ratification" WHERE "project_id"=$1) AS approvals,
       (SELECT count(*)::int FROM "project_owner_decision_request"
         WHERE "project_id"=$1 AND "decision"='DENY') AS denials`,
    [fixture.projectId],
  );
  assert.deepEqual(counts.rows[0], { approvals: 0, denials: 1 });
  evidence.resilience.denyReplayRecovered = true;
  evidence.resilience.mixedClientConflictRecovered = true;
});

test('stale, expired, wrong-CTA and cross-owner submissions fail closed with recovery', async () => {
  const stale = await createProjectFixture('stale-tab');
  const stalePublic = uuidToBase62(stale.projectId);
  const staleRead = (await http(ownerToken, `/projects/${stalePublic}/ratification`)).body;
  await pool.query('UPDATE "project" SET "goal"="goal" || $2 WHERE "id"=$1', [
    stale.projectId,
    ' changed after old tab',
  ]);
  const staleResult = await http(ownerToken, `/projects/${stalePublic}/ratification`, {
    method: 'POST',
    body: privateRequestBody(staleRead, 'APPROVE', `stale:${randomUUID()}`),
  });
  assert.equal(staleResult.response.status, 409);
  assert.equal(staleResult.body.code, 'OWNER_DECISION_STALE');
  evidence.resilience.staleFailedClosed = true;

  const expired = await createProjectFixture('expired-tab');
  const expiredPublic = uuidToBase62(expired.projectId);
  const expiredRead = (await http(ownerToken, `/projects/${expiredPublic}/ratification`)).body;
  await pool.query(
    `UPDATE "project_owner_decision_request" SET "expires_at"=now()-interval '1 second'
      WHERE "id"=$1`,
    [toUuid(expiredRead.decisionRequest.id)],
  );
  const expiredResult = await http(ownerToken, `/projects/${expiredPublic}/ratification`, {
    method: 'POST',
    body: privateRequestBody(expiredRead, 'APPROVE', `expired:${randomUUID()}`),
  });
  assert.equal(expiredResult.response.status, 409);
  assert.equal(expiredResult.body.code, 'OWNER_DECISION_CTA_EXPIRED');
  assert.notEqual(expiredResult.body.newDecisionRequestId, expiredRead.decisionRequest.id);
  const expiryRows = await pool.query(
    `SELECT "id", "status" FROM "project_owner_decision_request"
      WHERE "project_id"=$1 ORDER BY "request_generation"`,
    [expired.projectId],
  );
  assert.equal(expiryRows.rows.find((row) => row.id === toUuid(expiredRead.decisionRequest.id)).status, 'EXPIRED');
  assert.ok(expiryRows.rows.some((row) => row.status === 'PENDING'));
  evidence.resilience.expiredReplacementCommitted = true;

  const wrong = await createProjectFixture('wrong-cta');
  const wrongPublic = uuidToBase62(wrong.projectId);
  const wrongRead = (await http(ownerToken, `/projects/${wrongPublic}/ratification`)).body;
  const wrongToken = await http(ownerToken, `/projects/${wrongPublic}/ratification`, {
    method: 'POST',
    body: {
      ...privateRequestBody(wrongRead, 'APPROVE', `wrong:${randomUUID()}`),
      ctaToken: randomUUID(),
    },
  });
  assert.equal(wrongToken.response.status, 409);
  assert.equal(wrongToken.body.code, 'OWNER_DECISION_CTA_MISMATCH');
  evidence.resilience.wrongCtaFailedClosed = true;

  const crossOwner = await http(otherToken, `/projects/${wrongPublic}/ratification`, {
    method: 'POST',
    body: privateRequestBody(wrongRead, 'APPROVE', `cross:${randomUUID()}`),
  });
  assert.equal(crossOwner.response.status, 404);
  evidence.resilience.crossOwnerNotFound = true;

  const ctas = [staleRead, expiredRead, wrongRead].map((value) => value.decisionRequest.ctaToken);
  for (const cta of ctas) {
    assert.equal(observedUrls.some((value) => value.includes(cta)), false);
    assert.equal(logLines.some((value) => value.includes(cta)), false);
    assert.equal(errorBodies.some((value) => JSON.stringify(value).includes(cta)), false);
  }
  const telemetry = await pool.query(
    `SELECT count(*)::int AS count FROM "client_version"
      WHERE "kind" ILIKE $1 OR "version" ILIKE $1`,
    [`%${wrongRead.decisionRequest.ctaToken}%`],
  );
  assert.equal(telemetry.rows[0].count, 0);
  evidence.transport.ctaAbsentFromUrls = true;
  evidence.transport.ctaAbsentFromLogs = true;
  evidence.transport.ctaAbsentFromErrors = true;
  evidence.transport.ctaAbsentFromTelemetry = true;
});
