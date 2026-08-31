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
const {
  RunnerProjectsController,
} = require(path.join(API_DIST, 'runner-api/runner-projects.controller.js'));
const { RunnerAuthGuard } = require(path.join(API_DIST, 'runner-api/runner-auth.guard.js'));
const {
  OutcomeSurfaceService,
} = require(path.join(API_DIST, 'outcome-reconciler/outcome-surface.service.js'));
const { sha256 } = require(path.join(API_DIST, 'common/crypto.util.js'));
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
let projectsService;

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
  conversational: {
    draftedInSessionVisibleInThatSession: false,
    renderedContractComplete: false,
    decisionRequestExplained: false,
    ownerCredentialDecided: false,
    automaticResumeRearmed: false,
    runnerSelfRatificationForbidden: false,
    approveWhatYouSawEnforced: false,
    noAutomaticApprovalPath: false,
    expiredCtaReplaySafe: false,
    inboxAndSessionSurfacesAgree: false,
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

  projectsService = projects;
  class OwnerRatificationUiHarnessModule {}
  Module({
    imports: [JwtModule.register({ secret: SECRET })],
    // The runner door is mounted beside the owner door on purpose: the whole question this suite
    // now answers is what an AGENT-drafted contract does to the OWNER's surfaces, and that cannot
    // be proven by a harness in which no agent credential exists.
    controllers: [ProjectsController, RunnerProjectsController],
    providers: [
      JwtAuthGuard,
      RunnerAuthGuard,
      { provide: PrismaService, useValue: prisma },
      { provide: ProjectsService, useValue: projects },
      { provide: ProjectAcceptanceService, useValue: acceptance },
      { provide: ProjectHandoffService, useValue: {} },
      { provide: SessionAttemptService, useValue: {} },
      { provide: TaskCheckpointService, useValue: {} },
      { provide: OutcomeSurfaceService, useValue: {} },
    ],
  })(OwnerRatificationUiHarnessModule);

  // abortOnError: false so a wiring mistake throws here instead of Nest calling process.exit(1)
  // behind the capturing logger, which turns a one-line DI error into an empty TAP stream.
  app = await NestFactory.create(
    OwnerRatificationUiHarnessModule,
    { logger: harnessLogger, abortOnError: false },
  );
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

// ---------------------------------------------------------------------------------------------
// The third path: an agent drafts the completion contract inside a conversation, the owner reads
// the rendered contract on that same conversation's surface, and confirms it with their own
// credential. Nothing below relaxes who may decide — every proof here is either "the owner can now
// see it where it was written" or "the drafter still cannot approve its own work".
// ---------------------------------------------------------------------------------------------

/** A runner credential, its workspace, and one conversation this owner is having in it. */
async function createConversationFixture(label) {
  const runnerId = randomUUID();
  const runnerToken = `runner-${randomUUID()}`;
  const workspaceId = randomUUID();
  const sessionId = randomUUID();
  await pool.query(
    `INSERT INTO "runner" ("id","name","owner_id","token_hash","enrolled_at")
     VALUES ($1,$2,$3,$4,now())`,
    [runnerId, `${label}-runner`, ownerId, sha256(runnerToken)],
  );
  await pool.query(
    `INSERT INTO "workspace" ("id","name","owner_id","runner_id","created_at")
     VALUES ($1,$2,$3,$4,now())`,
    [workspaceId, `${label}-workspace`, ownerId, runnerId],
  );
  await pool.query(
    `INSERT INTO "session" (
       "id","title","prompt","owner_id","creator_id","assigned_runner_id","workspace_id",
       "running_bg_shells","running_subagents","updated_at"
     ) VALUES ($1,$2,$3,$4,$4,$5,$6,'{}','{}',now())`,
    [sessionId, `${label} conversation`, `${label} prompt`, ownerId, runnerId, workspaceId],
  );
  return { runnerId, runnerToken, workspaceId, sessionId };
}

const DRAFTED_GOAL = '在 guarded 授权内完成会话内起草的工作，并保留全部审计线索';
const DRAFTED_COMMAND = 'npm run test:outcome-reconciler:surfaces';

/**
 * The three criteria the agent ends up with, one per completion criterion.
 *
 * EXECUTABLE and VERIFICATION both require an `evidenceTaskId`, which cannot exist in the same
 * request that creates the project — so the agent does what an agent actually does: it files the
 * project, files the work, and then binds each criterion to the task that will answer it.
 */
function draftedCriteria(executableTaskId, verifierTaskId) {
  return [
    {
      text: '所有对外副作用都写入可审计的 run_event',
      verificationMethod: 'npm run test:outcome-reconciler:surfaces 退出码 0',
      completionCriterion: 'EXECUTABLE',
      acceptanceCommand: DRAFTED_COMMAND,
      acceptanceExpectedExitCode: 0,
      evidenceTaskId: executableTaskId,
      completionCriterionOverrideReason: 'fixture declares each criterion shape explicitly',
    },
    {
      text: 'Owner 在会话内确认过精确 contract digest',
      verificationMethod: 'project_owner_ratification.source 为 OWNER',
      completionCriterion: 'HUMAN_SIGNOFF',
      completionCriterionOverrideReason: 'fixture declares each criterion shape explicitly',
    },
    {
      text: '每条验收标准都能被独立复核',
      verificationMethod: '人工复核记录',
      completionCriterion: 'VERIFICATION',
      evidenceTaskId: verifierTaskId,
      completionCriterionOverrideReason: 'fixture declares each criterion shape explicitly',
    },
  ];
}
const DRAFTED_CRITERIA = draftedCriteria('placeholder', 'placeholder');
/** What a first `project_create` can say before any task exists to carry evidence. */
const INITIAL_CRITERIA = DRAFTED_CRITERIA.map((criterion) => ({
  text: criterion.text,
  verificationMethod: criterion.verificationMethod,
  completionCriterion: 'HUMAN_SIGNOFF',
  completionCriterionOverrideReason: criterion.completionCriterionOverrideReason,
}));

/**
 * The work the drafted criteria point at. A project criterion may only name evidence whose shape
 * matches it — an EXECUTABLE criterion needs an EXECUTABLE task with the same command and exit
 * code, a VERIFICATION criterion needs a task that verifies something — so the fixture files both
 * rather than pretending one task can answer every criterion.
 */
async function createDraftedTasks(projectId, label) {
  const executableTaskId = randomUUID();
  const verifierTaskId = randomUUID();
  await pool.query(
    `INSERT INTO "task" (
       "id","title","status","owner_id","creator_type","creator_id","project_id",
       "completion_criterion","acceptance_command","acceptance_expected_exit_code","updated_at"
     ) VALUES ($1,$2,'OPEN'::"task_status",$3,'USER'::"creator_type",$3,$4,
               'EXECUTABLE'::"task_completion_criterion",$5,0,now())`,
    [executableTaskId, `${label} executable task`, ownerId, projectId, DRAFTED_COMMAND],
  );
  await pool.query(
    `INSERT INTO "task" (
       "id","title","status","owner_id","creator_type","creator_id","project_id",
       "completion_criterion","verifies_task_id","updated_at"
     ) VALUES ($1,$2,'OPEN'::"task_status",$3,'USER'::"creator_type",$3,$4,
               'VERIFICATION'::"task_completion_criterion",$5,now())`,
    [verifierTaskId, `${label} verification task`, ownerId, projectId, executableTaskId],
  );
  return { executableTaskId, verifierTaskId };
}

/** Let the drafted project block on the owner exactly as automatic dispatch would, so approving
 *  it has something real to rearm rather than an empty UPDATE that would count zero. It is
 *  recorded LAST: the obligation binds the contract digest it observed, and a later contract edit
 *  would leave the rearm matching nothing. */
async function blockOnOwnerRatification(taskId) {
  const epoch = await pool.query(
    'SELECT "epoch" FROM "task_dispatch_epoch" WHERE "task_id"=$1',
    [taskId],
  );
  assert.equal(epoch.rows.length, 1, 'drafted task dispatch epoch was not created');
  await pool.query(
    `SELECT task_auto_dispatch_record(
       $1::uuid,$2::uuid,$3::bigint,'READY_SWEEP','REFUSED',
       'OWNER_RATIFICATION_REQUIRED',$4::jsonb,'OWNER','RATIFY_CURRENT_CONTRACT',
       NULL,now()+interval '1 hour'
     )`,
    [
      ownerId,
      taskId,
      epoch.rows[0].epoch,
      JSON.stringify({
        code: 'OWNER_RATIFICATION_REQUIRED',
        message: 'drafted work waits for exact owner ratification',
        nextAction: 'RATIFY_CURRENT_CONTRACT',
      }),
    ],
  );
}

async function draftProjectInConversation(label) {
  const conversation = await createConversationFixture(label);
  const created = await http(conversation.runnerToken, '/runner/projects', {
    method: 'POST',
    headers: { 'x-orbit-session-id': conversation.sessionId },
    body: {
      title: `${label} drafted project`,
      goal: DRAFTED_GOAL,
      acceptanceCriteriaItems: INITIAL_CRITERIA,
    },
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  // Normalize whichever spelling the boundary served, so the assertions below compare one form.
  const projectId = toUuid(created.body.id);
  const projectPublicId = uuidToBase62(projectId);
  const bound = await pool.query(
    'SELECT "coordinator_session_id" AS session FROM "project" WHERE "id"=$1',
    [projectId],
  );
  assert.equal(bound.rows[0].session, conversation.sessionId,
    'the project was not bound to the conversation that drafted it');
  // Governance is the OWNER's, and the runner door refuses to set it — so the agent's draft lands
  // on the schema defaults. Put the account in the state this question only arises in (automation
  // turned on by its owner) exactly as the canonical fixture does, without letting the agent do it.
  await pool.query(
    `UPDATE "project" SET "coordinator_enabled"=true,
            "automation_policy"='GUARDED_AUTO'::"project_automation_policy",
            "max_concurrent_tasks"=3, "updated_at"=now()
      WHERE "id"=$1`,
    [projectId],
  );
  const { executableTaskId, verifierTaskId } = await createDraftedTasks(projectId, label);
  // The agent now binds each criterion to the work that answers it. Sent headless, because the
  // acceptance-criteria edit is a HUMAN_ONLY-labelled action when it names an acting session and
  // this fixture is about the ratification boundary, not that label.
  const criteriaBound = await http(conversation.runnerToken, `/runner/projects/${projectPublicId}`, {
    method: 'PATCH',
    body: {
      acceptanceCriteriaItems: draftedCriteria(
        uuidToBase62(executableTaskId), uuidToBase62(verifierTaskId),
      ),
    },
  });
  assert.equal(criteriaBound.response.status, 200, JSON.stringify(criteriaBound.body));
  await blockOnOwnerRatification(executableTaskId);
  return { ...conversation, projectId, projectPublicId, executableTaskId, verifierTaskId };
}

async function ratificationCount(projectId) {
  const rows = await pool.query(
    'SELECT count(*)::int AS count FROM "project_owner_ratification" WHERE "project_id"=$1',
    [projectId],
  );
  return rows.rows[0].count;
}

test('an agent-drafted contract is pending on the conversation that drafted it', async () => {
  const drafted = await draftProjectInConversation('conversational-visible');
  const sessionPublicId = uuidToBase62(drafted.sessionId);

  // (a) The session view resolves its own pending question from the session id alone.
  const scoped = await http(
    ownerToken, `/projects/ratification/pending?limit=100&sessionId=${sessionPublicId}`,
  );
  assert.equal(scoped.response.status, 200);
  assert.equal(scoped.body.items.length, 1);
  const [reference] = scoped.body.items;
  assert.equal(reference.coordinatorSessionId, sessionPublicId);
  assert.equal(reference.projectId, drafted.projectPublicId);
  assert.equal(reference.status, 'PENDING');
  assert.equal(reference.owner, 'OWNER');
  assert.equal(reference.eligibility.requiresOwnerNow, true);
  assert.equal(JSON.stringify(scoped.body).includes('ctaToken'), false);

  // A runner credential drafting a project never ratifies it on the way in.
  assert.equal(await ratificationCount(drafted.projectId), 0);

  // (i) The same question, read from the global inbox, is byte-for-byte the same identity.
  const inbox = await http(ownerToken, '/projects/ratification/pending?limit=100');
  const fromInbox = inbox.body.items
    .find((item) => item.projectId === drafted.projectPublicId);
  assert.ok(fromInbox, 'the drafted question disappeared from the global inbox');
  assert.deepEqual(canonicalIdentity(fromInbox), canonicalIdentity(reference));
  assert.equal(fromInbox.contractDigest, reference.contractDigest);
  assert.equal(fromInbox.coordinatorSessionId, sessionPublicId);
  assert.equal(fromInbox.expiresAt, reference.expiresAt);

  // Another conversation's session id selects nothing rather than widening the read.
  const other = await createConversationFixture('conversational-unrelated');
  const empty = await http(
    ownerToken,
    `/projects/ratification/pending?limit=100&sessionId=${uuidToBase62(other.sessionId)}`,
  );
  assert.equal(empty.response.status, 200);
  assert.deepEqual(empty.body.items, []);

  evidence.conversational.draftedInSessionVisibleInThatSession = true;
  evidence.conversational.inboxAndSessionSurfacesAgree = true;
  evidence.samples.conversationalReference = {
    coordinatorSessionId: reference.coordinatorSessionId,
    projectId: reference.projectId,
    contractDigest: reference.contractDigest,
  };
});

test('the conversation surface reads exactly what the agent wrote, and why it is not the agent’s call', async () => {
  const drafted = await draftProjectInConversation('conversational-contract');
  const read = await http(ownerToken, `/projects/${drafted.projectPublicId}/ratification`);
  assert.equal(read.response.status, 200);
  const contract = read.body.semanticContract;
  const surface = read.body.decisionSurface;

  // (b) Five distinct classes of drafted content, each asserted on its own.
  assert.equal(contract.goal, DRAFTED_GOAL);
  assert.deepEqual(
    contract.criteria.map((criterion) => criterion.text).sort(),
    DRAFTED_CRITERIA.map((criterion) => criterion.text).sort(),
  );
  const trustByHash = new Map(
    contract.criteriaTrust.map((item) => [item.semanticHash, item.completionCriterion]),
  );
  const declared = new Map(contract.criteria.map(
    (criterion) => [criterion.text, trustByHash.get(criterion.semanticHash)],
  ));
  for (const criterion of DRAFTED_CRITERIA) {
    assert.equal(declared.get(criterion.text), criterion.completionCriterion,
      `criterion "${criterion.text}" lost its completionCriterion`);
  }
  assert.equal(contract.riskBoundary.automationPolicy, 'GUARDED_AUTO');
  assert.equal(contract.permissions.coordinatorEnabled, true);
  assert.equal(Object.hasOwn(contract.budget, 'sessionBudgetPerDay'), true);
  assert.equal(Object.hasOwn(contract.budget, 'attemptBudget'), true);

  // The private read names the conversation it belongs to, so a session surface can prove the
  // contract it rendered is the one drafted where it is embedded.
  assert.equal(read.body.coordinatorSessionId, uuidToBase62(drafted.sessionId));

  // (j) Everything acceptance criterion 8 requires a decision request to say.
  assert.ok(String(surface.whyNotAgent ?? '').length > 0);
  assert.deepEqual(surface.options, ['APPROVE', 'DENY']);
  assert.ok(String(surface.impacts.APPROVE ?? '').length > 0);
  assert.ok(String(surface.impacts.DENY ?? '').length > 0);
  assert.ok(String(surface.recommendation ?? '').length > 0);
  assert.ok(String(surface.noActionConsequence ?? '').length > 0);
  assert.ok(String(surface.resumeAfterDecision ?? '').length > 0);
  assert.ok(Date.parse(surface.reference.expiresAt) > Date.now());

  evidence.conversational.renderedContractComplete = true;
  evidence.conversational.decisionRequestExplained = true;
});

test('only the owner’s own credential decides it, and approving rearms the drafted work', async () => {
  const drafted = await draftProjectInConversation('conversational-decide');

  // (e) The credential that drafted it cannot approve it, through either machine door.
  const selfConfirm = await http(
    drafted.runnerToken,
    `/runner/projects/${drafted.projectPublicId}/acceptance/criteria-confirmation`,
    { method: 'POST', headers: { 'x-orbit-session-id': drafted.sessionId } },
  );
  assert.equal(selfConfirm.response.status, 403);
  assert.equal(selfConfirm.body.code, 'OWNER_RATIFICATION_ACTOR_FORBIDDEN');
  assert.equal(await ratificationCount(drafted.projectId), 0);

  // The same refusal at the service boundary the constraint names: an atomic creation-time
  // decision is admitted only for principal.type === 'OWNER' whose id IS the owner.
  await assert.rejects(
    () => projectsService.create(
      ownerId,
      {
        title: 'runner tries to self-approve',
        goal: DRAFTED_GOAL,
        acceptanceCriteriaItems: DRAFTED_CRITERIA,
        ownerRatification: { decision: 'APPROVE', idempotencyKey: `self:${randomUUID()}` },
      },
      undefined,
      { type: 'RUNNER', id: drafted.runnerId },
    ),
    (error) => {
      assert.equal(error.getStatus?.(), 403);
      assert.equal(error.getResponse().code, 'OWNER_RATIFICATION_ACTOR_FORBIDDEN');
      return true;
    },
  );
  evidence.conversational.runnerSelfRatificationForbidden = true;

  // (c) The decision itself: the owner's own authenticated connection, no token handover.
  const read = (await http(ownerToken, `/projects/${drafted.projectPublicId}/ratification`)).body;
  const body = privateRequestBody(read, 'APPROVE', `conversational:${randomUUID()}`);
  const decided = await http(ownerToken, `/projects/${drafted.projectPublicId}/ratification`, {
    method: 'POST', body,
  });
  assert.equal(decided.response.status, 201);
  assert.equal(decided.body.contractDigest, body.expectedContractDigest);
  const stored = await pool.query(
    `SELECT "source", "ratified_by_type" AS "ratifiedByType", "contract_digest"::text AS digest
       FROM "project_owner_ratification" WHERE "project_id"=$1`,
    [drafted.projectId],
  );
  assert.equal(stored.rows.length, 1);
  assert.equal(stored.rows[0].source, 'OWNER');
  assert.equal(stored.rows[0].ratifiedByType, 'OWNER');
  assert.equal(stored.rows[0].digest, body.expectedContractDigest);

  // (d) Approving rearms the persistent wake in the same transaction — no second click.
  assert.equal(decided.body.automaticResume.scheduled, true);
  assert.ok(decided.body.automaticResume.rearmedWakeups > 0,
    `expected a rearmed wake, saw ${decided.body.automaticResume.rearmedWakeups}`);
  const due = await pool.query(
    `SELECT bool_and("due_at" <= now()) AS due FROM "task_auto_dispatch_wakeup"
      WHERE "project_id"=$1 AND "state"='PENDING'`,
    [drafted.projectId],
  );
  assert.equal(due.rows[0].due, true);

  // The conversation's own surface stops asking once it has been answered.
  const after = await http(
    ownerToken,
    `/projects/ratification/pending?limit=100&sessionId=${uuidToBase62(drafted.sessionId)}`,
  );
  assert.deepEqual(after.body.items, []);

  evidence.conversational.ownerCredentialDecided = true;
  evidence.conversational.automaticResumeRearmed = true;
  evidence.samples.conversationalDecision = {
    source: stored.rows[0].source,
    rearmedWakeups: decided.body.automaticResume.rearmedWakeups,
  };
});

test('approve-what-you-saw survives the agent editing the contract after it was rendered', async () => {
  const drafted = await draftProjectInConversation('conversational-stale');
  const rendered = (await http(ownerToken, `/projects/${drafted.projectPublicId}/ratification`)).body;
  const renderedDigest = rendered.contractDigest;

  // The agent keeps working and changes the drafted goal after the owner read it.
  const edited = await http(drafted.runnerToken, `/runner/projects/${drafted.projectPublicId}`, {
    method: 'PATCH',
    headers: { 'x-orbit-session-id': drafted.sessionId },
    body: { goal: `${DRAFTED_GOAL}（agent 在渲染之后又改了一次）` },
  });
  assert.equal(edited.response.status, 200);

  // (f) The decision the owner had in front of them is refused with a typed reason.
  const stale = await http(ownerToken, `/projects/${drafted.projectPublicId}/ratification`, {
    method: 'POST',
    body: privateRequestBody(rendered, 'APPROVE', `stale-conversation:${randomUUID()}`),
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.code, 'OWNER_DECISION_STALE');
  assert.equal(await ratificationCount(drafted.projectId), 0);

  // …and re-reading yields the NEW contract, so the surface re-renders what actually changed.
  const current = (await http(ownerToken, `/projects/${drafted.projectPublicId}/ratification`)).body;
  assert.notEqual(current.contractDigest, renderedDigest);
  assert.match(current.semanticContract.goal, /agent 在渲染之后又改了一次/);
  const scoped = await http(
    ownerToken,
    `/projects/ratification/pending?limit=100&sessionId=${uuidToBase62(drafted.sessionId)}`,
  );
  assert.equal(scoped.body.items.length, 1);
  assert.equal(scoped.body.items[0].contractDigest, current.contractDigest);
  assert.notEqual(scoped.body.items[0].contractDigest, renderedDigest);

  evidence.conversational.approveWhatYouSawEnforced = true;
});

test('no timeout, retry or replay can ratify without the owner’s credential', async () => {
  const drafted = await draftProjectInConversation('conversational-no-auto');
  const read = (await http(ownerToken, `/projects/${drafted.projectPublicId}/ratification`)).body;

  // (g) A machine spending an authority that was never granted — repeatedly.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const preapproved = await http(
      drafted.runnerToken, `/runner/projects/${drafted.projectPublicId}/ratification`,
      {
        method: 'POST',
        body: {
          authority: 'PREAPPROVED_TEMPLATE',
          authorityId: uuidToBase62(randomUUID()),
          expectedContractDigest: read.contractDigest,
          idempotencyKey: `machine-attempt-${attempt}:${randomUUID()}`,
        },
      },
    );
    assert.ok(preapproved.response.status >= 400 && preapproved.response.status < 500,
      `a machine preapproval answered ${preapproved.response.status}`);
    assert.equal(await ratificationCount(drafted.projectId), 0);
  }

  // Another account's credential is not the owner's credential either.
  const crossOwner = await http(otherToken, `/projects/${drafted.projectPublicId}/ratification`, {
    method: 'POST',
    body: privateRequestBody(read, 'APPROVE', `cross-owner:${randomUUID()}`),
  });
  assert.equal(crossOwner.response.status, 404);
  assert.equal(await ratificationCount(drafted.projectId), 0);

  // Expiry is not consent: letting the one-use CTA lapse and retrying refuses and writes nothing.
  await pool.query(
    `UPDATE "project_owner_decision_request" SET "expires_at"=now()-interval '1 second'
      WHERE "id"=$1`,
    [toUuid(read.decisionRequest.id)],
  );
  const lapsed = await http(ownerToken, `/projects/${drafted.projectPublicId}/ratification`, {
    method: 'POST',
    body: privateRequestBody(read, 'APPROVE', `lapsed:${randomUUID()}`),
  });
  assert.equal(lapsed.response.status, 409);
  assert.equal(lapsed.body.code, 'OWNER_DECISION_CTA_EXPIRED');
  assert.equal(await ratificationCount(drafted.projectId), 0);
  evidence.conversational.noAutomaticApprovalPath = true;

  // (h) The lapsed CTA replays safely: a typed refusal every time, never a bare 500, and never a
  // second ratification once the owner has answered the request the server rotated to.
  const current = (await http(ownerToken, `/projects/${drafted.projectPublicId}/ratification`)).body;
  assert.notEqual(current.decisionRequest.id, read.decisionRequest.id);
  const approved = await http(ownerToken, `/projects/${drafted.projectPublicId}/ratification`, {
    method: 'POST',
    body: privateRequestBody(current, 'APPROVE', `after-expiry:${randomUUID()}`),
  });
  assert.equal(approved.response.status, 201);
  assert.equal(await ratificationCount(drafted.projectId), 1);
  for (let replay = 0; replay < 2; replay += 1) {
    const again = await http(ownerToken, `/projects/${drafted.projectPublicId}/ratification`, {
      method: 'POST',
      body: privateRequestBody(read, 'APPROVE', `expired-replay-${replay}:${randomUUID()}`),
    });
    assert.equal(again.response.status, 409);
    assert.notEqual(again.response.status, 500);
    assert.ok(typeof again.body.code === 'string' && again.body.code.length > 0);
    assert.equal(await ratificationCount(drafted.projectId), 1);
  }
  evidence.conversational.expiredCtaReplaySafe = true;
});
