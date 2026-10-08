/**
 * The tenant isolation census's second half (docs/google-sign-in-design.md §5.6, §11 T2): the doors a
 * runner credential opens, and the share links' doors, which nothing guards — held against the
 * production apiserver (`build/main.js`, the whole AppModule) over a real PostgreSQL that
 * `scripts/run-pg-spec.sh` migrates from empty:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/auth/tenant-isolation-runner.pg.spec.ts
 *
 * Three accounts — A, an administrator, and B and B2, members as everybody open sign-up admits is —
 * each hold the first half's objects (tenant-isolation-fixtures.ts) and, on their own registered
 * machine, what a runner credential addresses: sessions in each state the machine protocol needs, a
 * service token, an orchestration credential, share links of each kind. Every table carries a
 * trigger for the run, so what the database notes between a request and its answer is the whole of
 * what that request wrote. Then, with every credential of B's own each route serves (`runner`,
 * `session`, `service` — tenant-isolation-runner-cases.ts):
 *
 *   (1)  every case in RUNNER_ISOLATION_CASES, sent by B on A's objects and on ids that name nothing:
 *        answered the same, and nothing written that names anything of A's — nor after;
 *   (1b) every one whose path names one object under another, sent on B's own parent with A's child
 *        in it, and with an id that names nothing there: answered the same, nothing of A's written;
 *   (1c) every case in RUNNER_ISOLATION_FIELD_CASES, sent by B with A's object in the field, and by B2
 *        — B's twin, which is sent each of these beside B — with an id that names nothing there:
 *        answered the same, nothing of A's written;
 *   (1d) every case in SHARED_ISOLATION_CASES, through B's link of that kind and through another of
 *        A's own links, with something of A's that is under neither: answered as through the same link
 *        with an id that names nothing, and nothing of A's written;
 *   (2)  the owners: A with each credential on its own objects, B on its own nested and field cases,
 *        and A through its own link on what is under it — answered by the route: not 401, 403 or 404,
 *        and not what the same request with an id that names nothing is answered. So the request does
 *        reach its object, and every refusal above is the account's doing.
 *
 * Not destructive: every row belongs to a user this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { JwtService } from '@nestjs/jwt';
import { uuidToBase62 } from '@orbit/shared';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { call, startApiserver, type Apiserver, type Reply } from './pat-test-apiserver';
import { type Tenant, type TenantRequest } from './tenant-isolation-cases';
import {
  WRITE_TRAP,
  answerOf,
  censusFixtures,
  methodOf,
  pathOf,
  runnerTokenOf,
  upload,
  type CensusAccount,
} from './tenant-isolation-fixtures';
import {
  RUNNER_ISOLATION_CASES,
  RUNNER_ISOLATION_FIELD_CASES,
  SHARED_ISOLATION_CASES,
  type RunnerCase,
  type RunnerCredential,
  type RunnerObjects,
  type RunnerTenant,
  type SharedCase,
  type SharedLinkKind,
} from './tenant-isolation-runner-cases';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const PROVIDER_SECRET_KEY = `tenant-isolation-${RUN}`;

/** What an account holds to reach the runner gate with — its own, each of them. */
interface Holder {
  account: CensusAccount;
  runnerToken: string;
  /** The session the `session` credential speaks for, and the orchestration credential issued to it. */
  callingSessionId: string;
  orchestrationToken: string;
  serviceToken: string;
  /** A share link of each kind, by its token: the one each shared case goes through. */
  links: Record<SharedLinkKind, string>;
  /** Another link of each kind, sharing other objects of the account's. */
  otherLinks: Record<SharedLinkKind, string>;
}

test('tenant isolation: past the runner gate and through the share links, another account\'s objects are answered as nothing and written to by nobody', {
  skip: !URL, concurrency: 1, timeout: 1_800_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const db: PrismaClient = prismaClientFor(url);
  let server: Apiserver | undefined;
  t.after(async () => {
    await server?.stop();
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  await verifyCoordinatorPgIdentity(sql);
  process.env.PROVIDER_SECRET_KEY = PROVIDER_SECRET_KEY;

  const jwtSecret = `tenant-isolation-${randomUUID()}`;
  const jwt = new JwtService({ secret: jwtSecret });
  server = await startApiserver(url, jwtSecret, {
    ORBIT_WIKI: 'on',
    PROVIDER_SECRET_KEY,
    // No reaching models.dev from a spec: the catalogue keeps the lists this build shipped.
    MODEL_CATALOG_URL: 'http://127.0.0.1:9/',
  });
  const fixtures = censusFixtures({ run: RUN, db, sql, server, jwt });
  const { account, tenant, ok, idOf } = fixtures;

  /** A request as the runner gate takes it: B's (or A's) own credential, and the request's own headers. */
  const credentialed = (who: Holder, as: RunnerCredential | 'none', request: TenantRequest) => {
    switch (as) {
      case 'runner':
        return { bearer: who.runnerToken, headers: { ...request.headers } };
      case 'session':
        return {
          bearer: who.runnerToken,
          headers: { 'x-orbit-session-id': who.callingSessionId, 'x-orbit-session-token': who.orchestrationToken, ...request.headers },
        };
      case 'service':
        return { bearer: who.serviceToken, headers: { ...request.headers } };
      case 'none':
        return { bearer: undefined, headers: { ...request.headers } };
    }
  };
  const send = (who: Holder, as: RunnerCredential | 'none', route: string, request: TenantRequest): Promise<Reply> => {
    const { bearer, headers } = credentialed(who, as, request);
    return request.file
      ? upload(server!, methodOf(route), pathOf(route, request), { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...headers }, request.file)
      : call(server!, methodOf(route), pathOf(route, request), bearer, request.body, headers);
  };

  const asRunner = (runnerId: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    call(server!, method, `/api${path}`, runnerTokenOf(runnerId, RUN), body, headers);

  /** Everything the runner gate's cases address on one account's machine, beside the first half's. */
  async function runnerObjects(who: CensusAccount, of: Tenant, name: string): Promise<RunnerObjects> {
    const ownerId = who.userId;
    const as = (method: string, path: string, body?: unknown) => fixtures.api(who, method, `/api${path}`, body);
    /** A session of the machine's, open and waiting, with anything more of its row set. */
    const open = async (title: string, data: Record<string, unknown> = {}) => {
      const id = await fixtures.session(ownerId, of.workspaceId, of.runnerId, `${name} ${title}`);
      if (Object.keys(data).length > 0) await db.session.update({ where: { id }, data });
      return id;
    };
    const turnOf = async (sessionId: string, data: Record<string, unknown>) => {
      const id = randomUUID();
      await db.conversationTurn.create({ data: { id, sessionId, seq: 1, clientTurnId: `census-${id}`, ...data } as never });
      return id;
    };
    const task = async (title: string, extra: Record<string, unknown> = {}) =>
      idOf(await as('POST', '/tasks', {
        title: `${name} ${title}`, completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0,
        autoRunWhenReady: false, ...extra,
      }), `task ${title}`);
    const fileOf = async (where: { sessionId?: string; taskId?: string }) => {
      const id = randomUUID();
      await db.attachment.create({
        data: { id, ownerId, ...where, mimeType: 'text/plain', sizeBytes: 6, fileName: 'census.txt', data: Buffer.from('census') },
      });
      return id;
    };
    const eventOf = (sessionId: string) =>
      db.runEvent.create({ data: { sessionId, seq: 1, type: 'assistant_text', payload: { text: 'the census was here' } } });

    // The machine stays online for the whole run — a session RUNNING on a machine that went quiet is
    // ended by the reaper, a write nobody asked for — and its workspace has a directory, as a machine's
    // does, which a transcript import needs before it reads anything else.
    await db.runner.update({ where: { id: of.runnerId }, data: { status: 'ONLINE', lastHeartbeatAt: new Date(Date.now() + 2 * 3_600_000) } });
    await db.workspace.update({ where: { id: of.workspaceId }, data: { workDir: '/census/workspace' } });

    // ── the machine protocol's sessions ──
    const callingSessionId = await open('calling session');
    const coordinatorSessionId = await open('coordinator');
    await sql.query(`UPDATE "project" SET "coordinator_session_id" = $1 WHERE "id" = $2`, [coordinatorSessionId, of.projectId]);
    const newCoordinatorSessionId = await open('new coordinator');
    const runtimeSessionId = randomUUID();
    const machineSessionId = await open('machine session', { status: 'RUNNING', runtimeSessionId });
    const orphanSessionId = await open('orphan session', { assignedRunnerId: null });
    const takeoverSessionId = await open('takeover session', { status: 'RUNNING' });
    const leaseOwner = randomUUID();
    const leaseGeneration = randomUUID();
    const activateSessionId = await open('activate session', { status: 'RUNNING', inboxLeaseOwner: leaseOwner, inboxLeaseGeneration: leaseGeneration });
    const inboxSessionId = await open('inbox session', { status: 'RUNNING' });
    await turnOf(inboxSessionId, { kind: 'interrupt', status: 'PENDING' });
    const turnSessionId = await open('turn session', { status: 'RUNNING' });
    const shellTurnId = await turnOf(turnSessionId, { kind: 'shell', status: 'IN_FLIGHT', content: 'true', deliveredAt: new Date() });
    const finalizeSessionId = await open('finalize session', { status: 'RUNNING' });
    const completeSessionId = await open('complete session', { status: 'RUNNING' });
    const sessionAttachmentId = await fileOf({ sessionId: machineSessionId });
    const allowedApprovalId = randomUUID();
    await db.approval.create({ data: { id: allowedApprovalId, sessionId: machineSessionId, toolName: 'Bash', input: { command: 'true' }, status: 'ALLOWED' } });
    const artifactRequestId = await turnOf(machineSessionId, {
      kind: 'artifact', status: 'PENDING', content: JSON.stringify({ source: 'worktree', path: 'census.txt' }),
    });

    // ── jobs and operations the machine holds the claim of ──
    const codebase = await db.projectCodebase.findFirstOrThrow({ where: { projectId: of.projectId }, select: { id: true } });
    const integrationJobId = randomUUID();
    // A task of the project's own for this landing: the first half's fixture already holds a QUEUED
    // landing of the project's task, and `project_integration_job_task_inflight_key` allows one live
    // LAND_TASK a task (0281 J3) — the two were the same task until this line, which made this spec red
    // before it ran a single case (a4c1b1f8f).
    // Nothing either census holds is lost by it: each still stands up a landing of its own. The first
    // half's queued job stays on the project's task, where its Retry case names it. The two cases here
    // name this job by its id and its claim (lease owner, generation), never by its task, and the task
    // is made as `projectTaskId` is, OPEN in the same project. And it is returned with the rest
    // (`landingTaskId`), so a write naming it is still one of A's to the write trap.
    const landingTaskId = await task('task whose landing the machine holds', { projectId: of.projectId });
    await db.projectIntegrationJob.create({
      data: {
        id: integrationJobId, projectId: of.projectId, ownerId, codebaseId: codebase.id, kind: 'LAND_TASK', taskId: landingTaskId,
        serialKey: `census:${integrationJobId}`, targetRef: `refs/heads/project/${of.projectId}`, upstreamRef: 'refs/heads/main',
        sourceRef: 'refs/heads/census', state: 'RUNNING', runnerId: of.runnerId, claimLeaseOwner: leaseOwner, claimGeneration: 1n,
        claimedAt: new Date(), heartbeatAt: new Date(), startedAt: new Date(), idempotencyKey: `census:${integrationJobId}`,
      },
    });
    // A wiki repository operation of the machine's, claimed by it: the job it answers, and the row the
    // three repo-op doors name (migration 0402). Claimed as the integration job above is, so a case on it
    // carries the claim rather than an id alone.
    const wikiRepoOpId = randomUUID();
    const wikiRepoJobId = randomUUID();
    await sql.query(
      `INSERT INTO "wiki_job" ("id","owner_id","space_id","kind","state") VALUES ($1,$2,$3,'maintain','queued')`,
      [wikiRepoJobId, ownerId, of.wikiSpaceId],
    );
    await sql.query(
      `INSERT INTO "wiki_repo_op"
         ("id","job_id","owner_id","space_id","workspace_id","runner_id","kind","input","state",
          "lease_owner","claim_generation","claimed_at","heartbeat_at")
       VALUES ($1,$2,$3,$4,$5,$6,'snapshot','{}','running',$7,1,now(),now())`,
      [wikiRepoOpId, wikiRepoJobId, ownerId, of.wikiSpaceId, of.workspaceId, of.runnerId, leaseOwner],
    );
    const codexOperationId = randomUUID();
    await sql.query(
      `INSERT INTO "codex_rate_limit_reset_operation"
         ("id","owner_id","runner_id","account_fingerprint","client_request_id","provider_idempotency_key","consume_state",
          "refresh_state","claim_lease_owner","claim_generation","claimed_at","created_at","updated_at")
       VALUES ($1,$2,$3,$4,gen_random_uuid(),gen_random_uuid(),'CLAIMED','NONE',$5,1,now(),now(),now())`,
      [codexOperationId, ownerId, of.runnerId, `cxa1_${'2'.repeat(32)}`, leaseOwner],
    );
    const spareServiceTokenId = idOf(
      await asRunner(of.runnerId, 'POST', '/runner/service-tokens', { scopes: ['session:get'], ttlSeconds: 3600, workspaceId: of.workspaceId }),
      'a spare service token',
    );

    // ── sessions other sessions act on ──
    const replyRequestId = randomUUID();
    await db.sessionRequest.create({
      data: {
        id: replyRequestId, ownerId, fromSessionId: await open('asking session'), toSessionId: callingSessionId, turnId: randomUUID(),
        clientTurnId: `census-ask-${replyRequestId}`, requestPreview: 'a question', replyBy: new Date(Date.now() + 3_600_000),
      },
    });
    const [interruptSessionId, endSessionId, completedSessionId, deletedSessionId, archivedSessionId] = [
      await open('interrupted session'), await open('ended session'), await open('completed session'),
      await open('deleted session'), await open('archived session'),
    ];

    // ── the project's coordinator's items ──
    const coordinatorItem = (title: string) =>
      db.projectOpenItem.create({
        data: {
          projectId: of.projectId, ownerId, kind: 'TASK_FAILED', state: 'OPEN', assignee: 'COORDINATOR', assigneeReason: 'DEFAULT',
          taskId: of.projectTaskId, dedupeKey: `TF:${of.projectTaskId}:${randomUUID()}`, title,
          payload: { how: 'RUN_FAILED', chain: { failuresInChain: 1, limit: 3 } }, waitingSince: new Date(), assignedAt: new Date(),
        } as never,
        select: { id: true },
      });
    const coordinatorItemId = (await coordinatorItem('Task failed, for the census to resolve')).id;
    const handOverItemId = (await coordinatorItem('Task failed, for the census to hand over')).id;

    // ── a watch the calling session observes, providers by slug, a task in the list ──
    const watchId = idOf(
      await asRunner(of.runnerId, 'POST', '/runner/watches', {
        predicateVersion: 1, predicate: { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' }, targets: [{ kind: 'TASK', id: of.taskId }],
      }, { 'x-orbit-session-id': callingSessionId }),
      'a watch of the calling session',
    );
    // Not due again until it expires: the evaluator's own clock writes nothing while the census runs.
    await sql.query(`UPDATE "watch" SET "next_evaluate_at" = "expires_at" WHERE "id" = $1`, [watchId]);
    const slugOf = async (id: string) => (await db.modelProvider.findUniqueOrThrow({ where: { id }, select: { slug: true } })).slug;
    const listTaskId = await task('listed task', { listId: of.listId });
    const verifiedTaskId = await task('verified task', { projectId: of.projectId });
    const verifierTaskId = await task('verifier task', {
      projectId: of.projectId, verifiesTaskId: verifiedTaskId, completionCriterion: 'VERIFICATION',
      acceptanceCommand: undefined, acceptanceExpectedExitCode: undefined,
    });

    // ── a task confirmed by its owner: its run, the run's request, and the session reviewing it ──
    const confirmTaskId = await task('confirmed task', {
      completionCriterion: 'OWNER_CONFIRMED', ownerConfirmationReason: 'DEPLOY',
      acceptanceCommand: undefined, acceptanceExpectedExitCode: undefined,
    });
    const confirmRunSessionId = await open('confirmed task run', { taskId: confirmTaskId });
    const confirmRequestId = randomUUID();
    await db.taskOwnerConfirmationRequest.create({
      data: { id: confirmRequestId, taskId: confirmTaskId, ownerId, sessionId: confirmRunSessionId, turnId: randomUUID() },
    });
    const reviewerSessionId = await open('reviewer');
    await db.taskOwnerConfirmationReview.create({
      data: {
        requestId: confirmRequestId, taskId: confirmTaskId, ownerId, reviewerKind: 'TASK_CREATOR', reviewerSessionId,
        windowSeconds: 3600, dueAt: new Date(Date.now() + 3_600_000),
      },
    });

    // ── the wiki: a workspace bound to the space, and the space's maintenance ──
    ok(await as('POST', `/wiki/spaces/${of.wikiSpaceId}/workspaces`, { workspaceId: of.workspaceId }), 'binding the space');
    const wikiSessionId = await open('wiki session');
    const maintenanceListId = idOf(await as('POST', '/task-lists', { title: `${name} wiki maintenance` }), 'a maintenance list');
    const maintenanceTaskId = await task('wiki maintenance', { listId: maintenanceListId });
    await sql.query(
      `UPDATE "wiki_space" SET "settings" = "settings" || jsonb_build_object('maintenance', jsonb_build_object('listId', $1::text)) WHERE "id" = $2`,
      [maintenanceListId, of.wikiSpaceId],
    );
    const wikiMaintainerSessionId = await open('wiki maintainer', { taskId: maintenanceTaskId });
    // The draft the space asked for when it was made, made now into the maintainer's task.
    const draft = await db.wikiPlanJob.findFirst({
      where: { spaceId: of.wikiSpaceId, kind: { in: ['draft', 'revise'] }, state: { in: ['queued', 'held', 'made'] } },
      select: { id: true },
    });
    const wikiPlanJobId = draft?.id ?? randomUUID();
    await db.wikiPlanJob.upsert({
      where: { id: wikiPlanJobId },
      update: { state: 'made', taskId: maintenanceTaskId, madeAt: new Date(), heldReason: null, heldAt: null },
      create: { id: wikiPlanJobId, spaceId: of.wikiSpaceId, ownerId, kind: 'draft', trigger: 'owner', state: 'made', taskId: maintenanceTaskId, madeAt: new Date() },
    });
    const confirmedDoc = await db.wikiPlanDoc.findFirstOrThrow({ where: { ownerId, slug: of.wikiDocSlug, plan: { status: 'confirmed' } }, select: { id: true } });
    await db.wikiPlanSection.create({
      data: {
        docId: confirmedDoc.id, ownerId, position: 0, key: 'intro', title: 'Introduction', kind: 'overview', covers: 'what the census holds',
        length: 200, sources: { docs: [], code: [], contracts: [], sessions: null },
      },
    });
    const opOf = async (sessionId: string) => {
      const changesetId = randomUUID();
      await db.wikiChangeset.create({
        data: { id: changesetId, ownerId, spaceId: of.wikiSpaceId, origin: 'agent', sessionId, status: 'pending', expiresAt: new Date(Date.now() + 7 * 86_400_000) },
      });
      const opId = randomUUID();
      await db.wikiChangesetOp.create({
        data: {
          id: opId, changesetId, ownerId, seq: 0, op: 'add', decision: 'verifying',
          payload: { kind: 'concept', title: 'A census concept', summary: 'From the census.', fields: { definition: 'x', boundaries: 'y' } },
        },
      });
      return opId;
    };
    const wikiVerifyingOpId = await opOf(wikiSessionId);
    const wikiAdoptableOpId = await opOf(await open('ended wiki session', { status: 'SUCCEEDED', completedAt: new Date() }));

    // ── what the account shares: a session, a task and a project, each with something under it ──
    const sharedSessionId = await open('shared session');
    await eventOf(sharedSessionId);
    const sharedSessionAttachmentId = await fileOf({ sessionId: sharedSessionId });
    const sharedTaskId = await task('shared task');
    const sharedTaskRunSessionId = await open('shared task run', { taskId: sharedTaskId });
    await eventOf(sharedTaskRunSessionId);
    const sharedTaskAttachmentId = await fileOf({ taskId: sharedTaskId });
    const sharedProjectId = idOf(
      await as('POST', '/projects', { title: `${name} shared project`, acceptanceCriteriaItems: [{ text: 'shared', verificationMethod: 'read it' }] }),
      'a shared project',
    );
    const sharedProjectTaskId = await task('shared project task', { projectId: sharedProjectId });
    const sharedProjectRunSessionId = await open('shared project run', { taskId: sharedProjectTaskId });
    await eventOf(sharedProjectRunSessionId);
    const sharedProjectAttachmentId = await fileOf({ taskId: sharedProjectTaskId });

    return {
      callingSessionId, coordinatorSessionId, newCoordinatorSessionId, machineSessionId, runtimeSessionId, orphanSessionId,
      takeoverSessionId, activateSessionId, leaseOwner, leaseGeneration, inboxSessionId, turnSessionId, shellTurnId,
      finalizeSessionId, completeSessionId, sessionAttachmentId, allowedApprovalId, artifactRequestId, integrationJobId, landingTaskId,
      codexOperationId, wikiRepoOpId, spareServiceTokenId, replyRequestId, interruptSessionId, endSessionId, completedSessionId,
      deletedSessionId, archivedSessionId, coordinatorItemId, handOverItemId, watchId, verifierTaskId, verifiedTaskId,
      providerSlug: await slugOf(of.providerId), spareProviderSlug: await slugOf(of.spare.providerId), listTaskId,
      confirmTaskId, confirmRunSessionId, confirmRequestId, reviewerSessionId, wikiSessionId, wikiMaintainerSessionId,
      wikiPlanJobId, wikiVerifyingOpId, wikiAdoptableOpId, sharedSessionId, sharedSessionAttachmentId, sharedTaskId,
      sharedTaskRunSessionId, sharedTaskAttachmentId, sharedProjectId, sharedProjectTaskId, sharedProjectRunSessionId,
      sharedProjectAttachmentId,
    };
  }

  /** What the account holds to reach its machine and its links with: its credentials, and its links' tokens. */
  async function holder(who: CensusAccount, of: RunnerTenant): Promise<Holder> {
    const name = who.email.split('@')[0];
    const as = (method: string, path: string, body?: unknown) => fixtures.api(who, method, `/api${path}`, body);
    const tokenOf = async (path: string, include: Record<string, boolean>, what: string) => {
      const reply = ok(await as('PUT', path, { include, expiresAt: null }), what);
      assert.equal(typeof reply.json.token, 'string', `${what} answered no token: ${reply.text}`);
      return reply.json.token as string;
    };
    const other = async (kind: SharedLinkKind) => {
      if (kind === 'session') return tokenOf(`/sessions/${await fixtures.session(who.userId, of.workspaceId, of.runnerId, `${name} other shared session`)}/share`, {}, 'another session link');
      if (kind === 'task') {
        const taskId = idOf(await as('POST', '/tasks', {
          title: `${name} other shared task`, completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0, autoRunWhenReady: false,
        }), 'another shared task');
        return tokenOf(`/tasks/${taskId}/share`, { conversations: true, commentsAndFiles: true }, 'another task link');
      }
      const projectId = idOf(
        await as('POST', '/projects', { title: `${name} other shared project`, acceptanceCriteriaItems: [{ text: 'other', verificationMethod: 'read it' }] }),
        'another shared project',
      );
      return tokenOf(`/projects/${projectId}/share`, { taskPages: true, conversations: true, commentsAndFiles: true }, 'another project link');
    };
    const credential = ok(
      await asRunner(of.runnerId, 'POST', `/runner/sessions/${of.runner.callingSessionId}/orchestration-credential`),
      'an orchestration credential',
    ).json.orchestrationToken as string;
    const service = ok(
      await asRunner(of.runnerId, 'POST', '/runner/service-tokens', {
        scopes: ['session:get', 'session:list', 'session:send', 'session:create'], ttlSeconds: 3600, workspaceId: of.workspaceId,
      }),
      'a service token',
    ).json.token as string;
    return {
      account: who,
      runnerToken: runnerTokenOf(of.runnerId, RUN),
      callingSessionId: of.runner.callingSessionId,
      orchestrationToken: credential,
      serviceToken: service,
      links: {
        session: await tokenOf(`/sessions/${of.runner.sharedSessionId}/share`, {}, 'a session link'),
        task: await tokenOf(`/tasks/${of.runner.sharedTaskId}/share`, { conversations: true, commentsAndFiles: true }, 'a task link'),
        project: await tokenOf(`/projects/${of.runner.sharedProjectId}/share`, { taskPages: true, conversations: true, commentsAndFiles: true }, 'a project link'),
      },
      otherLinks: { session: await other('session'), task: await other('task'), project: await other('project') },
    };
  }

  const runnerTenant = async (who: CensusAccount, name: string): Promise<RunnerTenant> => {
    const base = await tenant(who, name);
    return { ...base, runner: await runnerObjects(who, base, name) };
  };

  const userA = await account('a', 'ADMIN');
  const userB = await account('b', 'MEMBER');
  const a = await runnerTenant(userA, 'a');
  const b = await runnerTenant(userB, 'b');
  // B's twin, for what an id that names nothing is answered: a request of B's own changes B's own
  // objects, so the request it is compared with goes to an account that has had the same done to it.
  const userB2 = await account('b2', 'MEMBER');
  const b2 = await runnerTenant(userB2, 'b2');
  const [holderA, holderB, holderB2] = [await holder(userA, a), await holder(userB, b), await holder(userB2, b2)];

  // ── the write trap ─────────────────────────────────────────────────────────────────────────
  await sql.query(WRITE_TRAP);
  const mark = async (): Promise<bigint> =>
    BigInt((await sql.query<{ seq: string }>(`SELECT coalesce(max("seq"), 0)::text AS "seq" FROM "tenant_census_write"`)).rows[0].seq);
  /** Every row written since `since`, as a person reads it: A's and B's ids spelled <A> and <B>. */
  const writtenSince = async (since: bigint) =>
    (await sql.query<{ tbl: string; op: string; row: unknown }>(
      `SELECT "tbl", "op", "row" FROM "tenant_census_write" WHERE "seq" > $1 ORDER BY "seq"`,
      [since.toString()],
    )).rows.map((w) => `${w.op} ${w.tbl} ${JSON.stringify(w.row).split(userA.userId).join('<A>').split(userB.userId).join('<B>')}`);
  const shown = (written: string[]) => written.map((row) => row.slice(0, 300));
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  // Quiet before anything is asked: what making the fixtures set going has finished writing.
  for (let quiet = 0, last = await mark(); quiet < 3;) {
    await sleep(1_000);
    const now = await mark();
    quiet = now === last ? quiet + 1 : 0;
    last = now;
  }

  /** One request, and every row the database recorded while it was answered. */
  const sent = async (who: Holder, as: RunnerCredential | 'none', route: string, request: TenantRequest) => {
    const before = await mark();
    const reply = await send(who, as, route, request);
    await sleep(25);
    return { reply, written: await writtenSince(before) };
  };

  /**
   * Every id of A's, as a row would spell it: what a write of B's must never name. Not the engine's own
   * id for A's conversation: that names no row of A's, and a session of B's importing a copy of the same
   * transcript carries the same one, as it should.
   */
  const idsOfA = new Set<string>();
  const collect = (value: unknown): void => {
    if (typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(value)) idsOfA.add(value).add(uuidToBase62(value.slice(0, 36)));
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  collect({ ...a, runner: { ...a.runner, runtimeSessionId: null } });
  /**
   * B's own run events, as B's machine reported them (`run_event` rows of a session of B's): the turn id
   * an event names is the machine's word, kept beside the event with no foreign key, and every reader of
   * events by turn reads them under their own session (runner-api.controller.ts events). It is B's record
   * of what B sent, and links nothing; it is not a write of A's.
   */
  const sessionsOfB = new Set((await db.session.findMany({ where: { ownerId: userB.userId }, select: { id: true } })).map((row) => row.id));
  const ownRunEvent = (row: string) => {
    const session = /^INSERT run_event .*"session_id":"([0-9a-f-]{36})"/.exec(row)?.[1];
    return session !== undefined && sessionsOfB.has(session);
  };
  const namingA = (written: string[]) =>
    shown(written.filter((row) => !ownRunEvent(row) && (row.includes('<A>') || [...idsOfA].some((id) => row.includes(id)))));

  /** A tenant whose every object is one nobody has: a fresh id each, the same id each time it is read. */
  const nobody = (): RunnerTenant => {
    const proxy = (): object => {
      const cache = new Map<PropertyKey, unknown>();
      return new Proxy({}, {
        get: (_, key) => {
          if (!cache.has(key)) cache.set(key, key === 'spare' || key === 'runner' ? proxy() : randomUUID());
          return cache.get(key);
        },
      });
    };
    return proxy() as RunnerTenant;
  };

  // ── (1) B's credentials on A's objects: answered as nothing, and nothing of A's written ─────────
  const cases = Object.entries(RUNNER_ISOLATION_CASES) as Array<[string, RunnerCase]>;
  let attacked = await mark();
  for (const [route, kase] of cases) {
    for (const as of kase.as) {
      await t.test(`${route} as ${as}: B on A's is answered as on nothing, and writes nothing of A's`, async () => {
        const { reply, written } = await sent(holderB, as, route, kase.request(a, b));
        const control = await sent(holderB, as, route, kase.request(nobody(), b));
        assert.deepEqual(
          { answer: answerOf(reply), writtenOfA: namingA(written) },
          { answer: answerOf(control.reply), writtenOfA: [] },
        );
      });
    }
  }
  await t.test('nothing B asked of A\'s objects wrote anything of A\'s late either', async () => {
    await sleep(2_000);
    assert.deepEqual(namingA(await writtenSince(attacked)), []);
  });

  // ── (1b) B's own parent, A's child: a check on the parent alone lets this through ─────────────
  attacked = await mark();
  /** The request on B's own objects with A's in the nested params — or, given one, an id that names nothing. */
  const crossed = (kase: RunnerCase, nobodyId?: string): TenantRequest => {
    const own = kase.request(b, b);
    const theirs = kase.request(a, b);
    const params = { ...own.params };
    for (const nested of kase.nested ?? []) params[nested] = nobodyId ?? theirs.params[nested];
    return { ...own, params };
  };
  for (const [route, kase] of cases) {
    if (!kase.nested) continue;
    for (const as of kase.as) {
      await t.test(`${route} as ${as}: B on its own with A's ${kase.nested.join(', ')} writes nothing of A's and is answered as on nothing`, async () => {
        const { reply, written } = await sent(holderB, as, route, crossed(kase));
        const control = await sent(holderB, as, route, crossed(kase, randomUUID()));
        assert.deepEqual(
          { answer: answerOf(reply), writtenOfA: namingA(written) },
          { answer: answerOf(control.reply), writtenOfA: [] },
        );
      });
    }
  }

  // ── (1c) B's own request with A's object in a field of its query, headers or body ────────────
  const fieldCases = Object.entries(RUNNER_ISOLATION_FIELD_CASES);
  const routeOfField = (key: string) => key.split(' ').slice(0, 2).join(' ');
  /**
   * B's request while another transaction holds a row of A's — FOR KEY SHARE, the mode a session
   * starting on a task or a progress report takes. Answered before the hold ends, or it waited on it.
   */
  const whileHeld = async ([table, id]: readonly [string, string], ask: () => Promise<{ reply: Reply; written: string[] }>) => {
    const held = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    await held.connect();
    try {
      await held.query('BEGIN');
      const row = await held.query(`SELECT 1 FROM "${table}" WHERE "id" = $1 FOR KEY SHARE`, [id]);
      assert.equal(row.rowCount, 1, `no ${table} ${id} of A's to hold`);
      const asked = ask();
      const first = await Promise.race([asked.then(() => 'answered'), sleep(5_000).then(() => 'still waiting on A\'s row')]);
      await held.query('ROLLBACK');
      return { ...(await asked), whileHeld: first };
    } finally {
      await held.end().catch(() => undefined);
    }
  };
  for (const [key, kase] of fieldCases) {
    // One tenant of nothing per case, as B names the same objects of A's under every credential: a request
    // that leaves something of its own behind — an import, say — meets it again on the next, on both sides.
    const nothing = nobody();
    for (const as of kase.as) {
      await t.test(`${key} as ${as}: B's own request with A's in it writes nothing of A's and is answered as with nothing`, async () => {
        const route = routeOfField(key);
        const { reply, written } = await sent(holderB, as, route, kase.request(a, b));
        const control = await sent(holderB2, as, route, kase.request(nothing, b2));
        assert.deepEqual(
          { answer: answerOf(reply), writtenOfA: namingA(written) },
          { answer: answerOf(control.reply), writtenOfA: [] },
        );
      });
      if (!kase.heldRow) continue;
      await t.test(`${key} as ${as}: while A's ${kase.heldRow(a)[0]} is held, B's own request with A's in it neither waits for it nor is answered otherwise`, async () => {
        const route = routeOfField(key);
        const held = await whileHeld(kase.heldRow!(a), () => sent(holderB, as, route, kase.request(a, b)));
        const control = await sent(holderB2, as, route, kase.request(nothing, b2));
        assert.deepEqual(
          { answered: held.whileHeld, answer: answerOf(held.reply), writtenOfA: namingA(held.written) },
          { answered: 'answered', answer: answerOf(control.reply), writtenOfA: [] },
        );
      });
    }
  }

  // ── (1d) another link's token with A's object in it ───────────────────────────────────────────
  for (const [route, kase] of Object.entries(SHARED_ISOLATION_CASES)) {
    for (const [kind, request] of Object.entries(kase.through) as Array<[SharedLinkKind, NonNullable<SharedCase['through'][SharedLinkKind]>]>) {
      const through: Array<[string, string]> = [
        [`B's ${kind} link`, holderB.links[kind]],
        [`another ${kind} link of A's`, holderA.otherLinks[kind]],
      ];
      for (const [what, token] of through) {
        await t.test(`${route}: through ${what}, A's is answered as nothing and writes nothing of A's`, async () => {
          const { reply, written } = await sent(holderB, 'none', route, request(a, token));
          const control = await sent(holderB, 'none', route, request(nobody(), token));
          assert.deepEqual(
            { answer: answerOf(reply), writtenOfA: namingA(written) },
            { answer: answerOf(control.reply), writtenOfA: [] },
          );
        });
      }
    }
  }
  await t.test('nothing asked with A\'s ids in it wrote anything of A\'s late either', async () => {
    await sleep(2_000);
    assert.deepEqual(namingA(await writtenSince(attacked)), []);
  });

  // ── (2) the same requests from the owners: answered by the route ─────────────────────────────
  // Deletes last, and a path's deeper deletes before its shallower ones, so that no case takes away
  // what a later one asks for. Each owner's answer is held against the same request on an id that
  // names nothing, asked first: a request every id is refused alike reaches no object, so it would
  // prove nothing about B's.
  const answeredByTheRoute = (reply: Reply, nothing: Reply) => {
    assert.ok(![401, 403, 404].includes(reply.status), `answered ${reply.status}: ${reply.text.slice(0, 600)}`);
    assert.notEqual(answerOf(reply), answerOf(nothing), `answered as an id that names nothing: ${reply.text.slice(0, 600)}`);
  };
  const depth = (route: string) => route.split('/').length;
  const ordered = [...cases].sort(([x], [y]) => {
    const dx = methodOf(x) === 'DELETE' ? 1 : 0;
    const dy = methodOf(y) === 'DELETE' ? 1 : 0;
    return dx - dy || (dx ? depth(y) - depth(x) : 0);
  });
  for (const [route, kase] of ordered) {
    for (const as of kase.as) {
      const controls: Array<[string, Holder, RunnerTenant]> = [['A on its own', holderA, a]];
      if (kase.nested) controls.push(['B on its own', holderB, b]);
      for (const [what, who, own] of controls) {
        await t.test(`${route} as ${as}: ${what} is answered by the route`, async () => {
          const nothing = await send(who, as, route, kase.request(nobody(), own));
          answeredByTheRoute(await send(who, as, route, kase.request(own, own)), nothing);
        });
      }
    }
  }
  for (const [key, kase] of fieldCases) {
    for (const as of kase.as) {
      await t.test(`${key} as ${as}: B's own request with its own in it is answered by the route`, async () => {
        const reply = await send(holderB, as, routeOfField(key), kase.request(b, b));
        assert.ok(![401, 403, 404].includes(reply.status), `answered ${reply.status}: ${reply.text.slice(0, 600)}`);
      });
    }
  }
  for (const [route, kase] of Object.entries(SHARED_ISOLATION_CASES)) {
    for (const [kind, request] of Object.entries(kase.through) as Array<[SharedLinkKind, NonNullable<SharedCase['through'][SharedLinkKind]>]>) {
      await t.test(`${route}: A through its own ${kind} link is answered by the route`, async () => {
        const nothing = await send(holderA, 'none', route, request(nobody(), holderA.links[kind]));
        answeredByTheRoute(await send(holderA, 'none', route, request(a, holderA.links[kind])), nothing);
      });
    }
  }
});
