/**
 * The tenant isolation census (docs/google-sign-in-design.md §5.6, §11 T1), held against the
 * production apiserver — `build/main.js`, the whole AppModule — over a real PostgreSQL that
 * `scripts/run-pg-spec.sh` migrates from empty:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/auth/tenant-isolation.pg.spec.ts
 *
 * Three accounts each hold a full set of objects (`Tenant`): A, an administrator, and B and B2,
 * members, as everybody open sign-up admits is. Every table carries a trigger for the run, so what
 * the database notes between a request and its answer is the whole of what that request wrote. Then:
 *
 *   (1)  every case in TENANT_ISOLATION_CASES, sent by B on A's objects: answered 404 or 403, and no
 *        write at all — nor any after the last of them was answered;
 *   (1b) every one whose path names one object under another, sent by B on its own parent with A's
 *        child in it, and again with an id that names nothing in that place: answered the same, and
 *        nothing written that names anything of A's;
 *   (1c) every case in TENANT_ISOLATION_FIELD_CASES, sent by B with A's object in the field, and by B2
 *        with an id that names nothing there — B's twin, sent each of these requests beside B, so its
 *        objects have had the same done to them: answered the same, and nothing written that names
 *        anything of A's;
 *   (2)  every case again, by its owner on its own objects (A, and B on its own nested and field
 *        cases): NOT answered 401, 403 or 404. The same request answered otherwise for the owner is
 *        what makes B's refusal the account's doing — not a path, a body or a state that refuses
 *        everybody.
 *
 * Not destructive: every row belongs to a user this run creates.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import { test } from 'node:test';

import { JwtService } from '@nestjs/jwt';
import { toUuid, uuidToBase62 } from '@orbit/shared';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { hashPassword } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { EMPTY_PROGRESS_VECTOR, scopeHash } from '../projects/convergence-progress';
import { ConvergenceLedgerService } from '../projects/convergence-ledger.service';
import { CRITERIA_WEAKENING_EFFECT_CLASS } from '../projects/criteria-weakening-intent';
import { DONE_REQUEST_DEDUPE_KEY, DONE_REQUEST_KIND, DONE_REQUEST_TITLE } from '../projects/project-done-request';
import { handoffCrossingKey } from '../projects/project-handoff';
import { SessionAttemptService } from '../projects/session-attempt.service';
import { encryptSecret } from '../providers/provider-crypto';
import { PatService } from './pat.service';
import { call, startApiserver, type Apiserver, type Reply } from './pat-test-apiserver';
import {
  TENANT_ISOLATION_CASES,
  TENANT_ISOLATION_FIELD_CASES,
  evidence,
  paramsOf,
  type Tenant,
  type TenantCase,
  type TenantRequest,
} from './tenant-isolation-cases';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const PROVIDER_SECRET_KEY = `tenant-isolation-${RUN}`;

/** What every table notes while the census runs: one row per row written, by whom it does not say. */
const WRITE_TRAP = `
  CREATE TABLE "tenant_census_write" (
    "seq" bigserial PRIMARY KEY,
    "tbl" text NOT NULL,
    "op" text NOT NULL,
    "row" jsonb
  );
  CREATE FUNCTION "tenant_census_note_write"() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    INSERT INTO "tenant_census_write" ("tbl", "op", "row")
    VALUES (TG_TABLE_NAME, TG_OP, CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END);
    RETURN NULL;
  END $$;
  DO $$
  DECLARE t record;
  BEGIN
    FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p') AND NOT c.relispartition
               AND c.relname NOT IN ('tenant_census_write', '_prisma_migrations')
    LOOP
      EXECUTE format(
        'CREATE TRIGGER "tenant_census_write" AFTER INSERT OR UPDATE OR DELETE ON %I '
        'FOR EACH ROW EXECUTE FUNCTION "tenant_census_note_write"()', t.relname);
      EXECUTE format(
        'CREATE TRIGGER "tenant_census_truncate" AFTER TRUNCATE ON %I '
        'FOR EACH STATEMENT EXECUTE FUNCTION "tenant_census_note_write"()', t.relname);
    END LOOP;
  END $$;
`;

/** The route's path with its parameters filled in, under /api, and its query. */
function pathOf(route: string, request: TenantRequest): string {
  let path = route.slice(route.indexOf(' ') + 1);
  for (const param of paramsOf(route)) path = path.replace(`:${param}`, encodeURIComponent(String(request.params[param])));
  const query = request.query ? `?${new URLSearchParams(request.query)}` : '';
  return `/api${path}${query}`;
}

const methodOf = (route: string) => route.slice(0, route.indexOf(' '));
const refused = (status: number) => status === 403 || status === 404;

/** A request with a file, as multipart/form-data with the one `file` field the upload route reads. */
function upload(server: Apiserver, method: string, path: string, bearer: string, file: NonNullable<TenantRequest['file']>): Promise<Reply> {
  const boundary = `census-${randomUUID()}`;
  const payload = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n`
      + `Content-Type: ${file.type}\r\n\r\n${file.content}\r\n--${boundary}--\r\n`,
  );
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1', port: server.port, path, method, agent: false,
        headers: { authorization: `Bearer ${bearer}`, 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': payload.length },
      },
      (res) => {
        const parts: Buffer[] = [];
        res.on('data', (chunk: Buffer) => parts.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(parts).toString('utf8');
          let json: unknown = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, json, text });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}


test('tenant isolation: every route that names something by path refuses another account its objects, and writes nothing', {
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
  const pats = new PatService(db as unknown as PrismaService);
  const attempts = new SessionAttemptService(db as unknown as PrismaService, new ConvergenceLedgerService(db as unknown as PrismaService));

  interface Account {
    userId: string;
    email: string;
    bearer: string;
  }
  const api = (who: Account, method: string, path: string, body?: unknown): Promise<Reply> =>
    call(server!, method, path, who.bearer, body);
  const ok = (reply: Reply, what: string): Reply => {
    assert.ok(reply.status >= 200 && reply.status < 300, `${what} answered ${reply.status}: ${reply.text}`);
    return reply;
  };
  const idOf = (reply: Reply, what: string): string => toUuid(ok(reply, what).json.id);

  async function account(name: string, role: 'ADMIN' | 'MEMBER'): Promise<Account> {
    const userId = randomUUID();
    const email = `tenant-${name}-${RUN}@tenant-isolation.invalid`;
    await db.user.create({ data: { id: userId, email, name: `Tenant ${name}`, passwordHash: hashPassword(`password-${RUN}`), role } });
    return { userId, email, bearer: await jwt.signAsync({ sub: userId, email }) };
  }

  /** A runner row, as an approved machine leaves one; offline, so nothing is dispatched to it. */
  async function runner(ownerId: string, name: string): Promise<string> {
    const id = randomUUID();
    await db.runner.create({
      data: {
        id,
        ownerId,
        name,
        tokenHash: createHash('sha256').update(`${id}-${RUN}`).digest('hex'),
        engines: [{
          engine: 'codex',
          installed: true,
          auth: 'yes',
          accounts: [{ id: 'c0ffee01', name: 'Census', auth: 'yes', home: `/census/.codex-accounts/c0ffee01` }],
        }],
      },
    });
    return id;
  }

  async function workspace(ownerId: string, runnerId: string, name: string): Promise<string> {
    const id = randomUUID();
    await db.workspace.create({ data: { id, ownerId, runnerId, name, enabled: true } });
    return id;
  }

  /** A session that has run and waits for its next message, as a runner leaves one. */
  async function session(ownerId: string, workspaceId: string, runnerId: string, title: string): Promise<string> {
    const id = randomUUID();
    await db.session.create({
      data: {
        id,
        title,
        prompt: title,
        ownerId,
        creatorId: ownerId,
        workspaceId,
        assignedRunnerId: runnerId,
        status: 'AWAITING_INPUT',
        startedAt: new Date(),
        runtimeSessionId: `runtime-${id}`,
      },
    });
    return id;
  }

  async function tenant(who: Account, name: string): Promise<Tenant> {
    const ownerId = who.userId;
    const as = (method: string, path: string, body?: unknown) => api(who, method, `/api${path}`, body);

    const runnerId = await runner(ownerId, `${name}-runner`);
    const workspaceId = await workspace(ownerId, runnerId, `${name}-workspace`);
    const [agentRuleId, workspaceRuleId] = [randomUUID(), randomUUID()];
    for (const id of [agentRuleId, workspaceRuleId]) {
      await db.workspacePermissionRule.create({ data: { id, workspaceId, toolName: 'Bash', ruleContent: `census ${id}` } });
    }

    const sessionId = await session(ownerId, workspaceId, runnerId, `${name} session`);
    const approvalId = randomUUID();
    await db.approval.create({ data: { id: approvalId, sessionId, toolName: 'Bash', input: { command: 'true' } } });
    const turnId = randomUUID();
    await db.conversationTurn.create({ data: { id: turnId, sessionId, seq: 2, clientTurnId: `census-queued-${turnId}`, content: 'queued' } });
    // A file the run changed, and one it wrote under its uploads and mentioned, as a runner leaves them.
    const artifactPath = `/census/.orbit/uploads/${sessionId}/census.txt`;
    await db.session.update({ where: { id: sessionId }, data: { changedFiles: [{ path: 'census.txt', status: 'M' }] } });
    const eventId = randomUUID();
    await db.runEvent.create({ data: { id: eventId, sessionId, seq: 1, type: 'assistant_text', payload: { text: `wrote ${artifactPath}` } } });
    await db.attachment.create({
      data: { ownerId, sessionId, mimeType: 'text/plain', sizeBytes: 6, fileName: 'census.txt', data: Buffer.from('census') },
    });

    const folderId = idOf(await as('POST', '/session-folders', { workspaceId, name: `${name} folder` }), 'a folder');
    const tagId = idOf(await as('POST', '/session-tags', { name: `${name} tag`, color: '#336699' }), 'a tag');

    const task = async (title: string, extra: Record<string, unknown> = {}) =>
      idOf(
        await as('POST', '/tasks', {
          title,
          completionCriterion: 'EXECUTABLE',
          acceptanceCommand: 'true',
          acceptanceExpectedExitCode: 0,
          autoRunWhenReady: false,
          ...extra,
        }),
        `task ${title}`,
      );
    const taskId = await task(`${name} task`);
    const dependencyTaskId = await task(`${name} prerequisite`);
    ok(await as('POST', `/tasks/${taskId}/dependencies`, { dependsOnTaskId: dependencyTaskId }), 'a dependency');
    const commentId = idOf(await as('POST', `/tasks/${taskId}/comments`, { body: 'a comment' }), 'a comment');
    const attachment = async () => {
      const id = randomUUID();
      await db.attachment.create({ data: { id, ownerId, taskId, mimeType: 'text/plain', sizeBytes: 6, fileName: 'census.txt', data: Buffer.from('census') } });
      return id;
    };

    const listId = idOf(await as('POST', '/task-lists', { title: `${name} list` }), 'a list');
    ok(await as('PATCH', `/task-lists/${listId}`, { instructions: 'revised' }), 'a list revision');
    const listRevision = (await db.taskListRevision.findFirstOrThrow({ where: { listId }, orderBy: { version: 'asc' } })).version;

    const criterion = { text: 'the census holds', verificationMethod: 'the census' };
    const project = async (title: string) => idOf(await as('POST', '/projects', { title, acceptanceCriteriaItems: [criterion] }), `project ${title}`);
    const projectId = await project(`${name} project`);
    const projectTaskId = await task(`${name} project task`, { projectId });
    const projectRead = ok(await as('GET', `/projects/${projectId}`), 'the project').json;
    const projectCriterion = { key: projectRead.acceptanceCriteriaItems[0].key, text: projectRead.acceptanceCriteriaItems[0].text };
    // An attempt at the project's task, opened for a session working on it, as dispatch opens one.
    const attemptSessionId = await session(ownerId, workspaceId, runnerId, `${name} attempt session`);
    await db.session.update({ where: { id: attemptSessionId }, data: { taskId: projectTaskId } });
    const attemptOf = await db.task.findUniqueOrThrow({ where: { id: projectTaskId }, select: { title: true, description: true, acceptanceCriteria: true } });
    const attemptId = (await attempts.open(ownerId, projectTaskId, {
      attemptKey: `dispatch:${attemptSessionId}`,
      sessionId: attemptSessionId,
      hypothesis: 'the census',
      progressVector: { ...EMPTY_PROGRESS_VECTOR, scopeHash: scopeHash(attemptOf) },
      observedAt: new Date(),
    })).attempt.id;

    // Evidence on a task judged by it, submitted from the session that did the work.
    const evidenceTaskId = await task(`${name} evidence task`, {
      projectId,
      completionCriterion: 'EVIDENCE_JUDGMENT',
      criterionKey: projectCriterion.key,
      acceptanceCommand: undefined,
      acceptanceExpectedExitCode: undefined,
    });
    const evidenceSessionId = await session(ownerId, workspaceId, runnerId, `${name} evidence session`);
    await db.session.update({ where: { id: evidenceSessionId }, data: { taskId: evidenceTaskId } });
    const toolUseId = `toolu_census_${name}_${RUN}`;
    await db.toolCall.create({ data: { sessionId: evidenceSessionId, name: 'Bash', toolUseId, input: { command: 'true' }, isError: false } });
    ok(
      await as('POST', `/tasks/${evidenceTaskId}/evidence`, {
        sourceSessionId: evidenceSessionId,
        evidence: { ...evidence('the fixture'), criterion: projectCriterion, checks: [{ kind: 'TOOL_CALL', ref: toolUseId }] },
      }),
      'evidence',
    );
    const evidenceCommentId = idOf(await as('POST', `/tasks/${evidenceTaskId}/comments`, { body: 'evidence, the old way' }), 'a comment');

    // What a project's coordinator and its machinery leave for the owner: a question, a request to
    // call it done, a blocker, a paused coordinator, a crossing to another project, a merge on offer
    // and a weakening of its criteria — each straight into its table, the way each spec of its own does.
    const later = new Date(Date.now() + 86_400_000);
    const openItem = (kind: string, dedupeKey: string, title: string, payload: object) =>
      db.projectOpenItem.create({
        data: {
          projectId, ownerId, kind, state: 'OPEN', assignee: 'OWNER', assigneeReason: 'DEFAULT', dedupeKey, title,
          payload, waitingSince: new Date(), assignedAt: new Date(), askedBySessionId: sessionId,
        } as never,
      });
    const openItemId = (await openItem('COORDINATOR_QUESTION', `CQ:${randomUUID()}`, 'Coordinator asks: ship it?', {
      question: 'ship it?', options: [], blocksTaskIds: [], ifUnanswered: null,
    })).id;
    const doneRequestItemId = (await openItem(DONE_REQUEST_KIND, DONE_REQUEST_DEDUPE_KEY, DONE_REQUEST_TITLE, {
      criteriaDigest: '0'.repeat(64), stateDigest: '1'.repeat(64), judgment: 'done', gaps: [], warnings: [],
    })).id;
    const blockerId = (await db.projectBlocker.create({
      data: {
        projectId, kind: 'AWAITING_USER_APPROVAL', owner: 'USER', recovery: 'HUMAN', severity: 'CRITICAL',
        requiredAction: 'decide', nextCheckAt: later, subjectType: 'TASK', subjectId: projectTaskId,
        detail: { reason: 'CENSUS' }, dedupeKey: `CENSUS:${projectTaskId}`, lifecycleGeneration: 1n,
        conditionVersion: 'c'.repeat(64), firstSeenAt: new Date(), lastSeenAt: new Date(),
      },
    })).id;
    const fuseEpisodeId = (await db.projectFuseEpisode.create({
      data: {
        projectId, ownerId, generation: 1, dimension: 'SELF_STARTED_TURNS', observed: 31, limitValue: 30,
        windowStart: new Date(Date.now() - 3_600_000), spend: { selfStartedTurns: 31, sessionsOpened: 0, successorRetries: 0 },
        crossingFact: { kind: 'SELF_STARTED_TURN' },
      },
    })).id;
    const handoffTargetId = await project(`${name} handoff target`);
    const handoffId = randomUUID();
    const payloadDigest = 'a'.repeat(64);
    await db.projectHandoffApproval.create({
      data: {
        id: handoffId, ownerId, fromProjectId: projectId, toProjectId: handoffTargetId, kind: 'FILE_TASK', payloadDigest,
        crossingKey: handoffCrossingKey({ ownerId, fromProjectId: projectId, toProjectId: handoffTargetId, kind: 'FILE_TASK', subjectTaskId: null, payloadDigest }),
        state: 'PENDING', title: 'a crossing', requestedBySessionId: sessionId, requestedAt: new Date(),
      },
    });
    const codebase = await db.projectCodebase.create({
      data: {
        ownerId, projectId, canonicalRepoUrl: `https://census.invalid/${name}`, upstreamRef: 'refs/heads/main',
        integrationRef: `refs/heads/project/${projectId}`, refAuthority: 'REMOTE', remoteName: 'origin',
        integrationRefSource: 'DEFAULT_RULE', integrationStartedAt: new Date(),
      },
    });
    const promotionId = (await db.projectPromotion.create({
      data: {
        projectId, ownerId, codebaseId: codebase.id, sourceKind: 'PROJECT_BRANCH', sourceRef: `refs/heads/project/${projectId}`,
        sourceSha: 'a'.repeat(40), upstreamRef: 'refs/heads/main', state: 'READY', includedTaskIds: [],
      },
    })).id;
    const contract = await db.projectCompletionContract.findUniqueOrThrow({ where: { projectId } });
    const criteriaIntentId = randomUUID();
    const criteriaCommitToken = randomUUID();
    await db.projectRatifiedActionIntent.create({
      data: {
        id: criteriaIntentId, projectId, ownerId, principalType: 'OWNER', principalId: ownerId, triggerKind: 'MANUAL',
        effectClass: CRITERIA_WEAKENING_EFFECT_CLASS, contractDigest: contract.contractDigest,
        contractRevision: contract.contractRevision, evaluationPlanDigest: contract.evaluationPlanDigest,
        riskPolicyDigest: contract.riskPolicyDigest, permissionDigest: contract.permissionDigest,
        budgetDigest: contract.budgetDigest, recipientDigest: contract.recipientDigest, budgetCharge: 0,
        action: {}, actionDigest: 'f'.repeat(64), idempotencyKey: `census-${criteriaIntentId}`, commitToken: criteriaCommitToken,
      },
    });

    const provider = async (label: string) =>
      idOf(await as('POST', '/providers/mine', { label, baseUrl: 'https://census.invalid/v1', apiKey: `sk-${label}-0123456789` }), `provider ${label}`);
    const providerId = await provider(`${name}-provider`);
    const poolMemberId = await provider(`${name}-pool-member`);
    const poolId = idOf(await as('POST', '/providers/pools', { label: `${name} pool` }), 'a pool');
    // Straight into the table: the route admits only a subscription token on Anthropic's endpoint,
    // whose quota the server would then go and read over the network.
    await db.providerPoolMember.create({ data: { poolId, providerId: poolMemberId, ownerId } });

    const sharedPoolId = idOf(await as('POST', '/providers/shared-pools', { label: `${name} shared pool` }), 'a shared pool');
    ok(await as('POST', `/providers/shared-pools/${sharedPoolId}/keys`, { label: `${name} key`, apiKey: `sk-proj-${name}-shared-${RUN}-0123456789` }), 'a shared key');
    const sharedPoolKeyId = (await db.poolApiKey.findFirstOrThrow({ where: { poolId: sharedPoolId } })).id;
    const person = await account(`${name}-person`, 'MEMBER');
    ok(await as('POST', `/providers/shared-pools/${sharedPoolId}/people`, { email: person.email }), 'a person');
    const invitee = await account(`${name}-invitee`, 'MEMBER');
    // Somebody else's pool this account was added to.
    const host = await account(`${name}-host`, 'MEMBER');
    const joinedSharedPoolId = idOf(await api(host, 'POST', '/api/providers/shared-pools', { label: `${name} joined pool` }), 'a joined pool');
    ok(await api(host, 'POST', `/api/providers/shared-pools/${joinedSharedPoolId}/people`, { email: who.email }), 'joining a pool');
    const codexPoolId = idOf(await as('POST', '/providers/pools', { label: `${name} codex pool`, engine: 'codex' }), 'a codex pool');

    const watchId = idOf(
      await as('POST', '/watches', {
        predicateVersion: 1,
        predicate: { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' },
        targets: [{ kind: 'TASK', id: taskId }],
        action: 'NOTIFY_USER',
      }),
      'a watch',
    );
    // Not due again until it expires: the evaluator's own clock writes nothing while the census runs.
    await sql.query(`UPDATE "watch" SET "next_evaluate_at" = "expires_at" WHERE "id" = $1`, [watchId]);
    const watchDeliveryId = randomUUID();
    await sql.query(
      `INSERT INTO "watch_delivery"("id","kind","watch_id","action","expiry_snapshot","state","attempts","last_error","dead_lettered_at")
       VALUES ($1, 'EXPIRY', $2, 'RESUME_SESSION', '{"evaluatedAt":"2026-01-01T00:00:00.000Z","targets":[]}'::jsonb, 'DEAD_LETTER', 1, 'census', now())`,
      [watchDeliveryId, watchId],
    );

    const wikiSpaceId = idOf(await as('POST', '/wiki/spaces', { title: `${name} wiki` }), 'a wiki space');
    // The wiki as its maintenance runs leave it: a topic with an article of two parts, an entry
    // waiting on its owner, a changeset waiting on its owner, a plan confirmed at version 1 with one
    // document, a draft of version 2, and a proposal to change it.
    const wikiTopicId = randomUUID();
    const wikiLeadId = randomUUID();
    const wikiEntryId = randomUUID();
    const wikiChangesetId = randomUUID();
    const wikiChangesetOpId = randomUUID();
    const wikiConfirmedPlanId = randomUUID();
    const wikiPlanProposalId = randomUUID();
    const wiki = (text: string, values: unknown[]) => sql.query(text, values);
    await wiki(`INSERT INTO "wiki_topic"("id","space_id","owner_id","slug","title") VALUES ($1,$2,$3,'census','Census')`, [wikiTopicId, wikiSpaceId, ownerId]);
    await wiki(
      `INSERT INTO "wiki_topic_summary"("id","topic_id","owner_id","part","kind","parent_id","title","body","citations","entry_set_sha256")
       VALUES ($1,$2,$3,0,'article',NULL,'Census','[]','[]',repeat('e',64)),
              (gen_random_uuid(),$2,$3,1,'subtopic',$1,'Census, part one','[]','[]',repeat('e',64))`,
      [wikiLeadId, wikiTopicId, ownerId],
    );
    await wiki(
      `INSERT INTO "wiki_entry"("id","owner_id","space_id","kind","status","trust","current_revision","title","summary","fields","topics")
       VALUES ($1,$2,$3,'concept','proposed','proposed',1,'A census entry','From the census.','{"definition":"x","boundaries":"y"}','{census}')`,
      [wikiEntryId, ownerId, wikiSpaceId],
    );
    await wiki(
      `INSERT INTO "wiki_changeset"("id","owner_id","space_id","origin","status","expires_at") VALUES ($1,$2,$3,'agent','pending',now() + interval '7 days')`,
      [wikiChangesetId, ownerId, wikiSpaceId],
    );
    await wiki(
      `INSERT INTO "wiki_changeset_op"("id","changeset_id","owner_id","seq","op","payload")
       VALUES ($3,$1,$2,0,'add','{"kind":"concept","title":"x","summary":"y","fields":{}}')`,
      [wikiChangesetId, ownerId, wikiChangesetOpId],
    );
    await wiki(
      `INSERT INTO "wiki_plan"("id","space_id","owner_id","version","status","origin","categories","docs_min","docs_max","gate","author_user_id","confirmed_by_user_id","confirmed_at")
       VALUES ($1,$2,$3,1,'confirmed','owner','[]',1,5,'{}',$3,$3,now())`,
      [wikiConfirmedPlanId, wikiSpaceId, ownerId],
    );
    await wiki(
      `INSERT INTO "wiki_plan_doc"("id","plan_id","owner_id","position","category","slug","title","question","length_min","length_max")
       VALUES (gen_random_uuid(),$1,$2,0,'census','census','Census','What does the census hold?',100,1000)`,
      [wikiConfirmedPlanId, ownerId],
    );
    await wiki(
      `INSERT INTO "wiki_plan"("id","space_id","owner_id","version","status","origin","base_version","categories","docs_min","docs_max","gate","author_user_id")
       VALUES (gen_random_uuid(),$1,$2,2,'draft','owner',1,'[]',1,5,'{}',$2)`,
      [wikiSpaceId, ownerId],
    );
    await wiki(
      `INSERT INTO "wiki_plan_proposal"("id","space_id","owner_id","base_version","reason","change","facts","gate","author_session_id")
       VALUES ($1,$2,$3,1,'the census','{}','[]','{}',$4)`,
      [wikiPlanProposalId, wikiSpaceId, ownerId, sessionId],
    );

    const deviceUserCode = `${name.toUpperCase()}${RUN.slice(0, 4)}-CNSS`.slice(0, 9);
    await db.deviceEnrollment.create({
      data: {
        deviceCodeHash: createHash('sha256').update(`${deviceUserCode}-${RUN}`).digest('hex'),
        userCode: deviceUserCode,
        name: `${name}-runner`,
        hostname: `${name}.census.invalid`,
        status: 'APPROVED',
        runnerId,
        approvedById: ownerId,
        approvedAt: new Date(),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });

    // One session asking another of the same account a question (sessions/session-request.ts).
    const cliLoginUserCode = `cli-${name}-${RUN}`;
    await db.patDeviceLogin.create({
      data: {
        deviceCodeHash: createHash('sha256').update(`${cliLoginUserCode}-device`).digest('hex'),
        userCode: cliLoginUserCode,
        name: `${name} cli`,
        scopes: ['tasks:read'],
        hostname: `${name}.census.invalid`,
        status: 'APPROVED',
        decidedById: ownerId,
        decidedAt: new Date(),
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    const device = await db.deviceToken.create({
      data: {
        userId: ownerId, token: `census-${name}-${RUN}`, platform: 'android', environment: 'production',
        bundleId: 'io.orbitd.android', installationId: randomUUID(),
      },
    });
    const sessionRequestId = randomUUID();
    await db.sessionRequest.create({
      data: {
        id: sessionRequestId,
        ownerId,
        fromSessionId: await session(ownerId, workspaceId, runnerId, `${name} asking session`),
        toSessionId: sessionId,
        turnId: randomUUID(),
        clientTurnId: `census-request-${sessionRequestId}`,
        requestPreview: 'a request',
        replyBy: new Date(Date.now() + 3_600_000),
      },
    });

    const adminSubject = await account(`${name}-subject`, 'MEMBER');
    const adminSubjectTokenId = (await pats.issue(adminSubject.userId, { name: 'subject token', scopes: ['tasks:read'], expiresInDays: 30, createdVia: 'WEB' })).id;
    const adminProvider = async (label: string) => {
      const id = randomUUID();
      await db.modelProvider.create({
        data: { id, slug: `${label}-${RUN}`, label, baseUrl: 'https://census.invalid/v1', apiKeyEnc: encryptSecret(`sk-${label}`) },
      });
      return id;
    };

    const shareTaskId = await task(`${name} shared task`);
    ok(await as('PUT', `/tasks/${shareTaskId}/share`, {}), 'a share link');
    const shareLinkId = (await db.shareLink.findFirstOrThrow({ where: { ownerId, taskId: shareTaskId } })).id;

    const purgedSessionId = await session(ownerId, workspaceId, runnerId, `${name} trashed session`);
    await db.session.update({ where: { id: purgedSessionId }, data: { deletedAt: new Date() } });

    const codexResetOperationId = randomUUID();
    await sql.query(
      `INSERT INTO "codex_rate_limit_reset_operation"
         ("id","owner_id","runner_id","account_fingerprint","client_request_id","provider_idempotency_key","consume_state",
          "consume_outcome","refresh_state","created_at","updated_at","consume_confirmed_at","completed_at")
       VALUES ($1,$2,$3,$4,gen_random_uuid(),gen_random_uuid(),'CONFIRMED','nothingToReset','NOT_REQUIRED',now(),now(),now(),now())`,
      [codexResetOperationId, ownerId, runnerId, `cxa1_${'1'.repeat(32)}`],
    );

    return {
      userId: ownerId,
      runnerId,
      runnerAccount: { engine: 'codex', account: 'c0ffee01' },
      codexAccount: 'c0ffee01',
      codexResetOperationId,
      deviceUserCode,
      cliLoginUserCode,
      deviceToken: device.token,
      deviceRegistrationId: device.id,
      workspaceId,
      agentRuleId,
      workspaceRuleId,
      sessionId,
      evidenceSessionId,
      approvalId,
      turnId,
      eventId,
      eventSeq: 1,
      sessionRequestId,
      folderId,
      tagId,
      attachmentId: await attachment(),
      taskId,
      commentId,
      evidenceTaskId,
      evidenceCommentId,
      dependencyTaskId,
      listId,
      listRevision,
      projectId,
      projectTaskId,
      attemptId,
      projectCriterionId: toUuid(projectRead.acceptanceCriteriaItems[0].id),
      openItemId,
      doneRequestItemId,
      blockerId,
      fuseEpisodeId,
      handoffId,
      promotionId,
      criteriaIntentId,
      criteriaCommitToken,
      providerId,
      poolId,
      poolMemberId,
      codexPoolId,
      sharedPoolId,
      joinedSharedPoolId,
      inviteeEmail: invitee.email,
      sharedPoolKeyId,
      sharedPoolPersonId: person.userId,
      watchId,
      watchDeliveryId,
      wikiSpaceId,
      wikiEntryId,
      wikiChangesetId,
      wikiChangesetOpId,
      wikiPlanProposalId,
      wikiPlanVersion: 2,
      wikiArticleSlug: 'census',
      wikiArticlePart: 1,
      wikiDocSlug: 'census',
      wikiTopicSlug: 'census',
      adminSubjectId: adminSubject.userId,
      adminSubjectTokenId,
      adminProviderId: await adminProvider(`${name}-admin-provider`),
      spare: {
        accessTokenId: idOf(await as('POST', '/access-tokens', { name: `${name} spare`, scopes: ['tasks:read'] }), 'a token'),
        adminProviderId: await adminProvider(`${name}-admin-provider-spare`),
        adminSubjectId: (await account(`${name}-subject-spare`, 'MEMBER')).userId,
        agentId: await workspace(ownerId, runnerId, `${name}-spare-agent`),
        workspaceId: await workspace(ownerId, runnerId, `${name}-spare-workspace`),
        attachmentId: await attachment(),
        projectId: await project(`${name} spare project`),
        providerId: await provider(`${name}-spare-provider`),
        poolId: idOf(await as('POST', '/providers/pools', { label: `${name} spare pool` }), 'a spare pool'),
        sharedPoolId: idOf(await as('POST', '/providers/shared-pools', { label: `${name} spare shared pool` }), 'a spare shared pool'),
        runnerId: await runner(ownerId, `${name}-spare-runner`),
        folderId: idOf(await as('POST', '/session-folders', { workspaceId, name: `${name} spare folder` }), 'a spare folder'),
        sessionId: await session(ownerId, workspaceId, runnerId, `${name} spare session`),
        purgedSessionId,
        tagId: idOf(await as('POST', '/session-tags', { name: `${name} spare tag`, color: '#663399' }), 'a spare tag'),
        shareLinkId,
        listId: idOf(await as('POST', '/task-lists', { title: `${name} spare list` }), 'a spare list'),
        taskId: await task(`${name} spare task`),
      },
    };
  }

  const userA = await account('a', 'ADMIN');
  const userB = await account('b', 'MEMBER');
  const a = await tenant(userA, 'a');
  const b = await tenant(userB, 'b');
  // B's twin, for what an id that names nothing is answered: a request of B's own changes B's own
  // objects, so the request it is compared with goes to an account that has had the same done to it.
  const userB2 = await account('b2', 'MEMBER');
  const b2 = await tenant(userB2, 'b2');

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
  /** The same rows, cut short for a failure message. */
  const shown = (written: string[]) => written.map((row) => row.slice(0, 300));
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  // Quiet before anything is asked: what making the fixtures set going has finished writing.
  for (let quiet = 0, last = await mark(); quiet < 3;) {
    await sleep(1_000);
    const now = await mark();
    quiet = now === last ? quiet + 1 : 0;
    last = now;
  }

  /** A route's request, as JSON or, carrying a file, as multipart. */
  const send = (who: Account, route: string, request: TenantRequest): Promise<Reply> =>
    request.file
      ? upload(server!, methodOf(route), pathOf(route, request), who.bearer, request.file)
      : api(who, methodOf(route), pathOf(route, request), request.body);
  /** One request from B (or another account), and every row the database recorded while it was answered. */
  const fromB = async (route: string, request: TenantRequest, who: Account = userB) => {
    const before = await mark();
    const reply = await send(who, route, request);
    await sleep(25);
    return { reply, written: await writtenSince(before) };
  };
  /**
   * An answer as text with what differs between any two answers spelled one way — every id, in either
   * spelling, every instant, digest and cursor, the seq a session gives each new turn, and B2's names
   * for its objects, which are B's with a 2 — so that the answer to an id of A's and the answer to an
   * id that names nothing compare on everything else: the status, the words, which fields are there
   * and what the rest of them hold.
   */
  const answerOf = (reply: Reply) =>
    `${reply.status} ${reply.text}`
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
      .replace(/\b[0-9a-f]{64}\b/g, '<digest>')
      .replace(/\beyJ[0-9A-Za-z_-]+/g, '<cursor>')
      .replace(/\b[0-9A-Za-z]{20,22}\b/g, '<id>')
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, '<instant>')
      .replace(/"seq":\d+/g, '"seq":<n>')
      .replace(/\bb2(?=[ -])/g, 'b');

  const cases = Object.entries(TENANT_ISOLATION_CASES) as Array<[string, TenantCase]>;
  /** The request on B's own objects with A's in the nested params — or, given one, an id that names nothing. */
  const crossed = (kase: TenantCase, nobody?: string): TenantRequest => {
    const own = kase.request(b, b);
    const theirs = kase.request(a, b);
    const params = { ...own.params };
    for (const nested of kase.nested ?? []) params[nested] = nobody ?? theirs.params[nested];
    return { ...own, params };
  };

  /** Every id of A's, as a row would spell it: what a write of B's must never name. */
  const idsOfA = new Set<string>();
  const collect = (value: unknown): void => {
    if (typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(value)) idsOfA.add(value).add(uuidToBase62(value));
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  collect(a);
  const namingA = (written: string[]) =>
    shown(written.filter((row) => row.includes('<A>') || [...idsOfA].some((id) => row.includes(id))));

  // ── (1) B on A's objects: refused, and nothing written ─────────────────────────────────────
  let attacked = await mark();
  for (const [route, kase] of cases) {
    await t.test(`${route}: B on A's is answered 404 or 403 and writes nothing`, async () => {
      const { reply, written } = await fromB(route, kase.request(a, b));
      assert.deepEqual(
        { answered: refused(reply.status) ? '404 or 403' : reply.status, written: shown(written) },
        { answered: '404 or 403', written: [] },
        reply.text.slice(0, 600),
      );
    });
  }
  await t.test('nothing B asked of A\'s objects was written late either', async () => {
    await sleep(2_000);
    assert.deepEqual(shown(await writtenSince(attacked)), []);
  });

  // ── (1b) B's own parent, A's child: a check on the parent alone lets this through ─────────────
  // What it must answer is exactly what it answers for an id that names nothing — so it says nothing
  // about A's — and nothing it writes may name anything of A's. It may write B's own: a request on
  // B's own task wakes B's own watch on it, as it would for any request there.
  attacked = await mark();
  for (const [route, kase] of cases) {
    if (!kase.nested) continue;
    await t.test(`${route}: B on its own with A's ${kase.nested.join(', ')} writes nothing of A's and is answered as for an id that names nothing`, async () => {
      const theirs = crossed(kase);
      const nobody = crossed(kase, randomUUID());
      const { reply, written } = await fromB(route, theirs);
      const control = await fromB(route, nobody);
      assert.deepEqual(
        { answer: answerOf(reply), writtenOfA: namingA(written) },
        { answer: answerOf(control.reply), writtenOfA: [] },
      );
    });
  }
  // ── (1c) B's own request with A's object in a field of its body or query ─────────────────────
  // Held to the same: answered exactly as the same request with an id that names nothing in that
  // field, and nothing written that names anything of A's.
  /** A tenant whose every object is one nobody has: a fresh id each, the same id each time it is read. */
  const nobody = (): Tenant => {
    const fresh = (cache: Map<PropertyKey, string>) => (_: object, key: PropertyKey) => {
      if (!cache.has(key)) cache.set(key, randomUUID());
      return cache.get(key);
    };
    const spare = new Proxy({}, { get: fresh(new Map()) });
    const own = fresh(new Map());
    return new Proxy({} as Tenant, { get: (target, key) => (key === 'spare' ? spare : own(target, key)) });
  };
  /**
   * B's own receipt of a Run press (`task_run_request`, owner B): it records the ids the press named —
   * A's among them, when B named one — and is answered alike for an id that names nothing. It is B's
   * record of what B sent, and links nothing; it is not a write of A's.
   */
  const ownRunReceipt = (row: string) => /^\w+ task_run_request /.test(row) && row.includes('"owner_id":"<B>"');
  const fieldCases = Object.entries(TENANT_ISOLATION_FIELD_CASES);
  const routeOfField = (key: string) => key.split(' ').slice(0, 2).join(' ');
  for (const [key, kase] of fieldCases) {
    await t.test(`${key}: B's own request with A's in it writes nothing of A's and is answered as for an id that names nothing`, async () => {
      const route = routeOfField(key);
      const { reply, written } = await fromB(route, kase.request(a, b));
      const control = await fromB(route, kase.request(nobody(), b2), userB2);
      assert.deepEqual(
        { answer: answerOf(reply), writtenOfA: namingA(written.filter((row) => !ownRunReceipt(row))) },
        { answer: answerOf(control.reply), writtenOfA: [] },
      );
    });
  }
  await t.test('nothing B asked with A\'s ids in it wrote anything of A\'s late either', async () => {
    await sleep(2_000);
    assert.deepEqual(namingA((await writtenSince(attacked)).filter((row) => !ownRunReceipt(row))), []);
  });

  // ── (2) the same requests from the owner: answered by the route itself ──────────────────────
  // Deletes last, and a path's deeper deletes before its shallower ones, so that no case takes away
  // what a later one asks for.
  const depth = (route: string) => route.split('/').length;
  const ordered = [...cases].sort(([x], [y]) => {
    const dx = methodOf(x) === 'DELETE' ? 1 : 0;
    const dy = methodOf(y) === 'DELETE' ? 1 : 0;
    return dx - dy || (dx ? depth(y) - depth(x) : 0);
  });
  for (const [route, kase] of ordered) {
    const controls: Array<[string, Account, TenantRequest]> = [['A on its own', userA, kase.request(a, a)]];
    if (kase.nested) controls.push(['B on its own', userB, kase.request(b, b)]);
    for (const [what, who, request] of controls) {
      await t.test(`${route}: ${what} is answered by the route`, async () => {
        const reply = await send(who, route, request);
        assert.ok(![401, 403, 404].includes(reply.status), `answered ${reply.status}: ${reply.text.slice(0, 600)}`);
      });
    }
  }
  // And each field case with B's own object in its field: read by the route, not stripped before it.
  for (const [key, kase] of fieldCases) {
    await t.test(`${key}: B's own request with its own in it is answered by the route`, async () => {
      const reply = await send(userB, routeOfField(key), kase.request(b, b));
      assert.ok(![401, 403, 404].includes(reply.status), `answered ${reply.status}: ${reply.text.slice(0, 600)}`);
    });
  }
});
