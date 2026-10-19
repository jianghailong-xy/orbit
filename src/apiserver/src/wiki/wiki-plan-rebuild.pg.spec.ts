/**
 * The documents of a plan's version in force asked for again (contracts/wiki.contract.json `plan.jobs.rebuild`,
 * migration 0429; owner's call 2026-10-17), held against the production apiserver — `build/main.js`, the whole
 * AppModule — over a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/wiki/wiki-plan-rebuild.pg.spec.ts
 *
 * The scene is production's of 2026-10-15/16: a space whose owner confirmed v1, whose one build ended failed after 10
 * attempts on a repository fault, and which nothing asked for again.
 *
 *   (1) refused, and nothing written: another account's space (404), a session header (WIKI_OWNER_CHANNEL_ONLY), an
 *       access token (OWNER_INTERACTIVE_CREDENTIAL_REQUIRED), an administrator viewing Orbit as the owner
 *       (IMPERSONATION_READ_ONLY), a draft, a superseded version or no such version (WIKI_PLAN_STALE, 404), and a space
 *       with no plan in force (WIKI_PLAN_UNCONFIRMED);
 *   (2) the owner asks on the plan page: a build of the version in force, made as a docs_build wiki_job at the owner's
 *       priority — no task, no session, no Activity row — which the plan's read shows writing the documents;
 *   (3) asked again while it is on its way, one after another and two at once: the same job, and no second row;
 *   (4) the day's maintenance runs used up: once that build has ended, the next is made all the same, and the day's
 *       count does not move;
 *   (5) the support door: a member is refused 403, an access token PAT_FORBIDDEN, a view-as token
 *       IMPERSONATION_FORBIDDEN, a missing, blank or long reason WIKI_SCHEMA — nothing written; an administrator is
 *       answered with the owner's build (trigger support, requested by the administrator) and one Activity row naming
 *       the account, the space, the version, the job and the reason; asked again, the same build, recorded again; and
 *       the account's spaces read as picking one needs.
 *
 * Not destructive: every row belongs to a user this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { JwtService } from '@nestjs/jwt';
import { toUuid, WIKI_DOCS_BUILD_JOB, WIKI_PLAN_REBUILD } from '@orbit/shared';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { PatService } from '../auth/pat.service';
import { hashPassword } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { wikiMaintenanceRunsToday } from './wiki-maintenance-run';

const URL_ = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);

interface Account {
  id: string;
  email: string;
  login: string;
}

test('the documents of a plan in force asked for again: by its owner, and by an administrator for support', {
  skip: !URL_, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL_!;
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = async (query: string, values: unknown[] = []): Promise<any[]> => (await sql.query(query, values)).rows;

  const jwtSecret = `wiki-plan-rebuild-${randomUUID()}`;
  const jwt = new JwtService({ secret: jwtSecret });
  const account = async (name: string, role: 'ADMIN' | 'MEMBER'): Promise<Account> => {
    const id = randomUUID();
    const email = `${name}-${RUN}@wiki-plan-rebuild.invalid`;
    await db.user.create({ data: { id, email, name, passwordHash: hashPassword(`pw-${name}`), role } });
    return { id, email, login: await jwt.signAsync({ sub: id, email }) };
  };
  const owner = await account('owner', 'MEMBER');
  const stranger = await account('stranger', 'MEMBER');
  const admin = await account('admin', 'ADMIN');
  server = await startApiserver(url, jwtSecret, { ORBIT_WIKI: 'on' });
  const api = (method: string, path: string, bearer: string, body?: unknown, headers?: Record<string, string>): Promise<Reply> =>
    call(server!, method, `/api${path}`, bearer, body, headers);
  const ok = (reply: Reply, what: string): Reply => {
    assert.ok(reply.status >= 200 && reply.status < 300, `${what} answered ${reply.status}: ${reply.text}`);
    return reply;
  };
  const refused = (reply: Reply, status: number, code: string | null, what: string): void => {
    assert.equal(reply.status, status, `${what}: ${reply.text}`);
    if (code !== null) assert.equal(reply.json?.code, code, `${what}: ${reply.text}`);
  };

  /** A space of `who`'s, its maintenance on `workspaceId` when given, with no draft job of its creation left. */
  const space = async (who: Account, title: string, workspaceId: string | null): Promise<string> => {
    const id = toUuid(ok(await api('POST', '/wiki/spaces', who.login, { title }), `${title} made`).json.id);
    if (workspaceId) {
      ok(await api('POST', `/wiki/spaces/${id}/workspaces`, who.login, { workspaceId }), `${title} bound`);
      ok(await api('PATCH', `/wiki/spaces/${id}`, who.login, { maintenance: { enabled: true, workspaceId } }), `${title} maintained`);
    }
    // The draft the space's creation asked for is not this spec's: the space stands as a confirmed plan leaves it.
    await sql.query(`DELETE FROM "wiki_plan_job" WHERE "space_id" = $1`, [id]);
    await sql.query(`DELETE FROM "wiki_job" WHERE "space_id" = $1`, [id]);
    return id;
  };
  /** Version `version` of the space's plan, with one document, as `status`. */
  const version = async (spaceId: string, ownerId: string, n: number, status: 'confirmed' | 'draft' | 'superseded'): Promise<void> => {
    const planId = randomUUID();
    await sql.query(
      `INSERT INTO "wiki_plan"("id","space_id","owner_id","version","status","origin","base_version","categories","docs_min","docs_max","gate",
                               "author_user_id","confirmed_by_user_id","confirmed_at","superseded_at")
       VALUES ($1,$2,$3,$4,$5,'owner',$6,'[]',1,5,'{}',$3,$7,$8,$9)`,
      [planId, spaceId, ownerId, n, status, n > 1 ? n - 1 : null, status === 'draft' ? null : ownerId,
        status === 'draft' ? null : new Date(), status === 'superseded' ? new Date() : null],
    );
    await sql.query(
      `INSERT INTO "wiki_plan_doc"("id","plan_id","owner_id","position","category","slug","title","question","length_min","length_max")
       VALUES (gen_random_uuid(),$1,$2,0,'dev','session-runtime','How a session runs','How does a session run?',100,1000)`,
      [planId, ownerId],
    );
  };
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.runner.create({ data: { id: runnerId, ownerId: owner.id, name: 'the space runner', tokenHash: `rebuild-${runnerId}` } });
  await db.workspace.create({ data: { id: workspaceId, ownerId: owner.id, runnerId, name: `cbai ${RUN}`, enabled: true } });

  // The owner's space: v1 superseded by v2, which is in force; v3, a draft. Its one build of v2 failed as production's did.
  const spaceId = await space(owner, `cbai docs ${RUN}`, workspaceId);
  await version(spaceId, owner.id, 1, 'superseded');
  await version(spaceId, owner.id, 2, 'confirmed');
  await version(spaceId, owner.id, 3, 'draft');
  const failedJob = randomUUID();
  const failedBuild = randomUUID();
  const fault = 'Ended after 10 attempts: REPO_OP_FAILED: the snapshot of origin/main failed: /work/cbai is not a git checkout: exit status 128';
  await sql.query(
    `INSERT INTO "wiki_job"("id","owner_id","space_id","kind","input","priority","state","attempts","failure_kind","error","started_at","ended_at")
     VALUES ($1,$2,$3,'docs_build',$4,1,'failed',10,'infra',$5,now() - interval '1 day',now() - interval '1 day')`,
    [failedJob, owner.id, spaceId, JSON.stringify({ planJobId: failedBuild }), fault],
  );
  await sql.query(
    `INSERT INTO "wiki_plan_job"("id","space_id","owner_id","kind","trigger","state","job_id","made_at","ended_at","outcome","version","error",
                                 "requested_by_user_id","created_at")
     VALUES ($1,$2,$3,'build','owner','ended',$4,now() - interval '1 day',now() - interval '1 day','failed',2,$5,$3,now() - interval '1 day')`,
    [failedBuild, spaceId, owner.id, failedJob, fault],
  );
  // A second space of the owner's with a draft and nothing in force.
  const draftOnly = await space(owner, `drafts only ${RUN}`, null);
  await version(draftOnly, owner.id, 1, 'draft');

  const ownersBuilds = (ownerId: string) => rows(
    `SELECT "id","state","trigger","version","job_id","task_id","requested_by_user_id" FROM "wiki_plan_job"
      WHERE "owner_id" = $1 AND "kind" = 'build' ORDER BY "created_at","id"`, [ownerId]);
  const footprint = async () => ({
    builds: (await rows(`SELECT count(*)::int AS n FROM "wiki_plan_job" WHERE "kind" = 'build' AND "owner_id" = $1`, [owner.id]))[0].n,
    jobs: (await rows(`SELECT count(*)::int AS n FROM "wiki_job" WHERE "owner_id" = $1`, [owner.id]))[0].n,
    tasks: (await rows(`SELECT count(*)::int AS n FROM "task" WHERE "owner_id" = $1`, [owner.id]))[0].n,
    activity: (await rows(`SELECT count(*)::int AS n FROM "activity" WHERE "type" = $1 AND "actor_id" = ANY($2::uuid[])`,
      [WIKI_PLAN_REBUILD.activity, [owner.id, stranger.id, admin.id]]))[0].n,
  });
  const build = (bearer: string, id: string, n: number, headers?: Record<string, string>) =>
    api('POST', `/wiki/spaces/${id}/plan/versions/${n}/build`, bearer, {}, headers);
  const pats = new PatService(db as unknown as PrismaService);
  const ownerToken = (await pats.issue(owner.id, { name: 'every wiki scope', scopes: ['wiki:read', 'wiki:write'], expiresInDays: 30, createdVia: 'WEB' })).token;
  const adminToken = (await pats.issue(admin.id, { name: 'an administrator\'s', scopes: ['wiki:read', 'wiki:write'], expiresInDays: 30, createdVia: 'WEB' })).token;
  const viewing = ok(await api('POST', `/admin/users/${owner.id}/impersonate`, admin.login, { reason: `the rebuild spec ${RUN}` }), 'viewing as the owner').json
    .accessToken as string;

  let made = '';
  await t.test('(1) refused, and nothing written: another account, a session, a token, a viewer, a version not in force', async () => {
    const before = await footprint();
    refused(await build(stranger.login, spaceId, 2), 404, null, 'another account\'s space');
    refused(await build(owner.login, spaceId, 2, { 'x-orbit-session-id': randomUUID() }), 403, 'WIKI_OWNER_CHANNEL_ONLY', 'with a session header');
    refused(await build(ownerToken, spaceId, 2), 403, 'OWNER_INTERACTIVE_CREDENTIAL_REQUIRED', 'with an access token');
    refused(await build(viewing, spaceId, 2), 403, 'IMPERSONATION_READ_ONLY', 'an administrator viewing Orbit as the owner');
    refused(await build(owner.login, spaceId, 3), 409, 'WIKI_PLAN_STALE', 'a draft');
    refused(await build(owner.login, spaceId, 1), 409, 'WIKI_PLAN_STALE', 'a superseded version');
    refused(await build(owner.login, spaceId, 9), 404, null, 'no such version');
    refused(await build(owner.login, draftOnly, 1), 409, 'WIKI_PLAN_UNCONFIRMED', 'a space with no plan in force');
    assert.deepEqual(await footprint(), before, 'no build, job, task or Activity row was written');
  });

  await t.test('(2) the owner asks: a build of the version in force, made on the server, and no task, session or Activity row', async () => {
    const before = await footprint();
    const reply = ok(await build(owner.login, spaceId, 2), 'the owner asks for the documents again');
    assert.equal(reply.json.created, true, reply.text);
    assert.deepEqual([reply.json.job.kind, reply.json.job.trigger, reply.json.job.state, reply.json.job.version, reply.json.job.taskId],
      ['build', 'owner', 'running', 2, null]);
    made = toUuid(reply.json.job.id);
    const [row] = (await ownersBuilds(owner.id)).filter((one) => one.id === made);
    assert.deepEqual([row.state, row.trigger, row.version, row.task_id, row.requested_by_user_id], ['made', 'owner', 2, null, owner.id]);
    const [job] = await rows(`SELECT "kind","priority","state","input" FROM "wiki_job" WHERE "id" = $1`, [row.job_id]);
    assert.deepEqual(job, { kind: WIKI_DOCS_BUILD_JOB.kind, priority: WIKI_DOCS_BUILD_JOB.priority, state: 'queued', input: { planJobId: made } });
    assert.deepEqual(await footprint(), { ...before, builds: before.builds + 1, jobs: before.jobs + 1 }, 'one build and its job; no task, no Activity row');
    assert.equal((await rows(`SELECT count(*)::int AS n FROM "session" WHERE "owner_id" = $1`, [owner.id]))[0].n, 0, 'no session');
    // The plan's read is the page's: the version in force, its build writing the documents.
    const plan = ok(await api('GET', `/wiki/spaces/${spaceId}/plan`, owner.login), 'the plan read').json;
    assert.deepEqual([toUuid(plan.job.id), plan.job.kind, plan.job.state, plan.confirmed.version], [made, 'build', 'running', 2]);
  });

  await t.test('(3) asked again while it is on its way, one after another and two at once: the same job, and no second row', async () => {
    const before = await footprint();
    const again = ok(await build(owner.login, spaceId, 2), 'asked again');
    assert.deepEqual([again.json.created, toUuid(again.json.job.id)], [false, made]);
    const both = await Promise.all([build(owner.login, spaceId, 2), build(owner.login, spaceId, 2)]);
    for (const reply of both) assert.deepEqual([ok(reply, 'at once').json.created, toUuid(reply.json.job.id)], [false, made]);
    assert.deepEqual(await footprint(), before, 'nothing written');
    assert.equal((await ownersBuilds(owner.id)).filter((one) => ['queued', 'held', 'made'].includes(one.state)).length, 1, 'one build on its way');
  });

  await t.test('(4) the day\'s maintenance runs used up: the next build is made all the same, and counted against nothing', async () => {
    // The build above ends failed (its runner away, say), and the space's run of the day uses up a limit of one.
    const [row] = (await ownersBuilds(owner.id)).filter((one) => one.id === made);
    await sql.query(`UPDATE "wiki_job" SET "state" = 'failed', "failure_kind" = 'infra', "error" = 'the spec ends it', "ended_at" = now() WHERE "id" = $1`, [row.job_id]);
    await sql.query(`UPDATE "wiki_plan_job" SET "state" = 'ended', "outcome" = 'failed', "error" = 'the spec ends it', "ended_at" = now() WHERE "id" = $1`, [made]);
    const settings = (await rows(`SELECT "settings" FROM "wiki_space" WHERE "id" = $1`, [spaceId]))[0].settings;
    await sql.query(`UPDATE "wiki_space" SET "settings" = $2 WHERE "id" = $1`, [spaceId, { ...settings, maintenance: { ...settings.maintenance, dailyRunLimit: 1 } }]);
    const runJob = randomUUID();
    await sql.query(`INSERT INTO "wiki_job"("id","owner_id","space_id","kind","state","started_at","ended_at") VALUES ($1,$2,$3,'maintain','succeeded',now(),now())`, [
      runJob, owner.id, spaceId,
    ]);
    await sql.query(`INSERT INTO "wiki_maintenance_run"("id","space_id","owner_id","job_id","started_at","outcome","ended_at") VALUES ($1,$2,$3,$4,now(),'succeeded',now())`, [
      randomUUID(), spaceId, owner.id, runJob,
    ]);
    const day = await wikiMaintenanceRunsToday(db as unknown as PrismaService, owner.id, spaceId);
    assert.deepEqual([day.limit, day.used, day.remaining], [1, 1, 0], 'the day\'s runs are used up');

    const reply = ok(await build(owner.login, spaceId, 2), 'asked with the day used up');
    assert.equal(reply.json.created, true, reply.text);
    assert.notEqual(toUuid(reply.json.job.id), made, 'a build of its own: the ended one does not answer');
    made = toUuid(reply.json.job.id);
    const after = await wikiMaintenanceRunsToday(db as unknown as PrismaService, owner.id, spaceId);
    assert.deepEqual([after.used, after.remaining], [1, 0], 'the build is not counted against the day');
  });

  await t.test('(5) the support door: refused to all but an administrator, recorded with why, and the same build as the owner\'s', async () => {
    const route = `/admin/wiki/spaces/${spaceId}/plan/build`;
    const before = await footprint();
    refused(await api('POST', route, owner.login, { reason: 'mine' }), 403, null, 'a member');
    refused(await api('POST', route, adminToken, { reason: 'a token' }), 403, 'PAT_FORBIDDEN', 'an administrator\'s access token');
    refused(await api('POST', route, viewing, { reason: 'viewing' }), 403, 'IMPERSONATION_FORBIDDEN', 'a view-as token');
    refused(await api('GET', `/admin/wiki/users/${owner.id}/spaces`, owner.login), 403, null, 'a member reading spaces');
    refused(await api('POST', route, admin.login, {}), 400, 'WIKI_SCHEMA', 'no reason');
    refused(await api('POST', route, admin.login, { reason: '   ' }), 400, 'WIKI_SCHEMA', 'a blank reason');
    refused(await api('POST', route, admin.login, { reason: 'x'.repeat(WIKI_PLAN_REBUILD.reasonMaxChars + 1) }), 400, 'WIKI_SCHEMA', 'a long reason');
    refused(await api('POST', route, admin.login, { reason: 'why', version: 2 }), 400, 'WIKI_SCHEMA', 'a field it does not take');
    refused(await api('POST', `/admin/wiki/spaces/${randomUUID()}/plan/build`, admin.login, { reason: 'nobody\'s' }), 404, null, 'a space that is nobody\'s');
    refused(await api('POST', `/admin/wiki/spaces/${draftOnly}/plan/build`, admin.login, { reason: 'drafts' }), 409, 'WIKI_PLAN_UNCONFIRMED', 'no plan in force');
    assert.deepEqual(await footprint(), before, 'nothing written by any refusal');

    // The build of (4) is on its way: the administrator is answered with it, and the request is recorded.
    const first = ok(await api('POST', route, admin.login, { reason: `  support request ${RUN}: 0 of 34 documents  ` }), 'an administrator asks');
    assert.deepEqual([first.json.created, toUuid(first.json.job.id), toUuid(first.json.ownerId)], [false, made, owner.id]);
    // It ends, and the administrator's next request makes a build of its own, recorded as theirs.
    const [open] = (await ownersBuilds(owner.id)).filter((one) => one.id === made);
    await sql.query(`UPDATE "wiki_job" SET "state" = 'failed', "failure_kind" = 'content', "error" = 'the spec ends it', "ended_at" = now() WHERE "id" = $1`, [open.job_id]);
    await sql.query(`UPDATE "wiki_plan_job" SET "state" = 'ended', "outcome" = 'failed', "error" = 'the spec ends it', "ended_at" = now() WHERE "id" = $1`, [made]);
    const second = ok(await api('POST', route, admin.login, { reason: `support request ${RUN}, again` }), 'the administrator asks again');
    assert.equal(second.json.created, true, second.text);
    const supported = toUuid(second.json.job.id);
    assert.equal(second.json.job.trigger, 'support');
    const [row] = (await ownersBuilds(owner.id)).filter((one) => one.id === supported);
    assert.deepEqual([row.state, row.trigger, row.version, row.task_id, row.requested_by_user_id], ['made', 'support', 2, null, admin.id]);
    const [job] = await rows(`SELECT "kind","priority","state" FROM "wiki_job" WHERE "id" = $1`, [row.job_id]);
    assert.deepEqual(job, { kind: WIKI_DOCS_BUILD_JOB.kind, priority: WIKI_DOCS_BUILD_JOB.priority, state: 'queued' });
    // Every request answered with a job is the administrator's Activity row, naming the account, the space, the job and why.
    assert.deepEqual(
      await rows(`SELECT "actor_id", "payload", "credential_kind", "credential_id" FROM "activity" WHERE "type" = $1 AND "actor_id" = $2
                   ORDER BY "created_at", "id"`, [WIKI_PLAN_REBUILD.activity, admin.id]),
      [
        { actor_id: admin.id, payload: { userId: owner.id, spaceId, version: 2, planJobId: made, created: false, reason: `support request ${RUN}: 0 of 34 documents` }, credential_kind: 'LOGIN', credential_id: null },
        { actor_id: admin.id, payload: { userId: owner.id, spaceId, version: 2, planJobId: supported, created: true, reason: `support request ${RUN}, again` }, credential_kind: 'LOGIN', credential_id: null },
      ],
    );
    // The owner's plan read shows it as any build of theirs.
    const plan = ok(await api('GET', `/wiki/spaces/${spaceId}/plan`, owner.login), 'the owner reads the plan').json;
    assert.deepEqual([toUuid(plan.job.id), plan.job.trigger, plan.job.state], [supported, 'support', 'running']);

    // The account's spaces, as the administrator picks one: what picking needs, oldest first.
    const listed = ok(await api('GET', `/admin/wiki/users/${owner.id}/spaces`, admin.login), 'the owner\'s spaces').json;
    assert.equal(toUuid(listed.userId), owner.id);
    assert.deepEqual(listed.spaces.map((one: { id: string; title: string; confirmedVersion: number | null; docs: unknown; building: boolean }) =>
      [toUuid(one.id), one.title, one.confirmedVersion, one.docs, one.building]), [
      [spaceId, `cbai docs ${RUN}`, 2, { written: 0, total: 1 }, true],
      [draftOnly, `drafts only ${RUN}`, null, null, false],
    ]);
    // The id's public spelling beside it (PublicIdInterceptor), and nothing the space knows.
    assert.deepEqual(Object.keys(listed.spaces[0]).sort(), ['building', 'confirmedVersion', 'docs', 'id', 'publicId', 'title'], 'nothing the space knows');
    refused(await api('GET', `/admin/wiki/users/${randomUUID()}/spaces`, admin.login), 404, null, 'an account that does not exist');
  });
});
