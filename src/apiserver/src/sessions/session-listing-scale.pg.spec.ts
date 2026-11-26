import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

import { type INestApplication, Module } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PrismaPg } from '@prisma/adapter-pg';
import { type Prisma, PrismaClient } from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { PG_ADAPTER_OPTIONS } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionTagsService } from '../session-tags/session-tags.service';
import { AutoRetryService } from './auto-retry.service';
import { listingRowIsWorking, listingRowNeedsOwner, type ListingRowFacts } from './session-listing';
import { MergeReceiptService } from './merge-receipt.service';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';

/**
 * What `GET /sessions/listing` costs against the whole Open list it replaces (docs/session-list-scale-design.md
 * §5 T1): one workspace with 1,500 Open sessions, ten folders and thirty projects, read both ways over HTTP on
 * the same seed. Each read follows a write, so the Open list's version moves and neither read is answered from
 * a build another read made (`sharedOpenList` keeps one for 5 s). It prints the medians and asserts the page
 * is what it should be: forty entries, the folder rows, and a small fraction of the whole list's bytes. Then, with a
 * failed session and a retrying one deep in the list, that the first page holds every row the web draws above the
 * days (Pinned, Needs you, Working), however long ago it was listed.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/sessions/session-listing-scale.pg.spec.ts
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const SESSIONS = 1_500;
const FOLDERS = 10;
const PROJECTS = 30;
const MEMBERS = 9;
const ROUNDS = 7;

let harness: Promise<{ app: INestApplication; base: string; sql: Client; db: PrismaClient; bearers: Map<string, string> }> | undefined;

function boot() {
  harness ??= (async () => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const sql = new Client({ connectionString: URL, connectionTimeoutMillis: 5_000 });
    await sql.connect();
    await verifyCoordinatorPgIdentity(sql);
    const db = new PrismaClient({ adapter: new PrismaPg(URL!, PG_ADAPTER_OPTIONS) });
    const prisma = db as unknown as PrismaService;
    const bearers = new Map<string, string>();
    const realtime = new RealtimeService(prisma, { scheduleBadgeSync: () => undefined } as never);
    const sessions = new SessionsService(prisma, {} as never, realtime);

    @Module({
      controllers: [SessionsController],
      providers: [
        { provide: SessionsService, useValue: sessions },
        { provide: PrismaService, useValue: db },
        { provide: RealtimeService, useValue: {} },
        { provide: SessionTagsService, useValue: {} },
        { provide: MergeReceiptService, useValue: {} },
        { provide: AutoRetryService, useValue: {} },
        JwtAuthGuard,
        Reflector,
        {
          provide: JwtService,
          useValue: {
            verifyAsync: async (token: string) => {
              const sub = bearers.get(token);
              if (!sub) throw new Error('not a bearer this run issued');
              return { sub, email: `${sub}@listing-scale.invalid` };
            },
          },
        },
      ],
    })
    class ScaleModule {}

    const app = await NestFactory.create(ScaleModule, { logger: false, abortOnError: false });
    app.setGlobalPrefix('api');
    app.useGlobalInterceptors(new PublicIdInterceptor());
    await app.listen(0, '127.0.0.1');
    return { app, base: await app.getUrl(), sql, db, bearers };
  })();
  return harness;
}

after(async () => {
  if (!harness) return;
  const h = await harness;
  await h.app.close();
  await h.db.$disconnect();
  await h.sql.end();
});

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

test(`first page of the listing vs the whole Open list on ${SESSIONS} Open sessions`, { skip, timeout: 600_000 }, async (t) => {
  const h = await boot();
  const ownerId = randomUUID();
  await h.db.user.create({ data: { id: ownerId, email: `${ownerId}@listing-scale.invalid`, name: 'scale', passwordHash: 'x' } });
  const bearer = `bearer-${ownerId}`;
  h.bearers.set(bearer, ownerId);
  const runnerId = randomUUID();
  await h.db.runner.create({
    data: {
      id: runnerId, ownerId, name: `scale-${runnerId}`, tokenHash: `hash-${runnerId}`,
      status: 'ONLINE', capabilities: [], capabilitiesReportedAt: new Date(), maxConcurrent: 8,
    },
  });
  const workspaceId = (await h.db.workspace.create({ data: { ownerId, runnerId, name: `scale ${ownerId}`, enabled: true } })).id;
  const folders: string[] = [];
  for (let i = 0; i < FOLDERS; i += 1) {
    folders.push((await h.db.sessionFolder.create({ data: { ownerId, workspaceId, name: `Folder ${i + 1}` } })).id);
  }

  const t0 = Date.parse('2026-11-01T00:00:00.000Z');
  const rows: Prisma.SessionCreateManyInput[] = [];
  const coordinators: Array<{ projectId: string; sessionId: string }> = [];
  const base = (i: number, extra: Partial<Prisma.SessionCreateManyInput> = {}): Prisma.SessionCreateManyInput => ({
    id: randomUUID(), ownerId, creatorId: ownerId, title: `Scale session ${i} — a title of ordinary length`,
    prompt: 'p', dispatchOrigin: 'USER', workspaceId, status: 'AWAITING_INPUT',
    createdAt: new Date(t0 + i * 60_000), listedAt: new Date(t0 + i * 60_000 + 30_000),
    lastAssistantText: 'Recap: '.padEnd(400, 'x'),
    // Every row names the same columns: a column one row of a createMany leaves out is written NULL, not its default.
    folderId: null, pinnedAt: null, taskId: null, runningBgJobs: [], runningBgJobActivity: {},
    ...extra,
  });
  // Thirty projects: a coordinator here (a third of them filed in a folder) and nine task runs each.
  for (let p = 0; p < PROJECTS; p += 1) {
    const projectId = (await h.db.project.create({ data: { ownerId, title: `Scale project ${p}` } })).id;
    const coordinator = base(rows.length, { folderId: p % 3 === 0 ? folders[p % FOLDERS] : null, pinnedAt: p < 2 ? new Date() : null });
    rows.push(coordinator);
    coordinators.push({ projectId, sessionId: coordinator.id! });
    const tasks = Array.from({ length: MEMBERS }, () => ({
      id: randomUUID(), ownerId, creatorType: 'USER' as const, creatorId: ownerId, title: `scale task ${p}`,
      projectId, completionCriterion: 'OWNER_CONFIRMED' as const,
    }));
    await h.db.task.createMany({ data: tasks });
    for (const task of tasks) rows.push(base(rows.length, { taskId: task.id }));
  }
  // The rest: two fifths filed in folders, a few pinned, a few running or with a job in flight.
  while (rows.length < SESSIONS) {
    const i = rows.length;
    rows.push(base(i, {
      folderId: i % 5 < 2 ? folders[i % FOLDERS] : null,
      pinnedAt: i % 97 === 0 ? new Date() : null,
      ...(i % 61 === 0 ? { status: 'RUNNING' as const } : {}),
      ...(i % 67 === 0 ? { runningBgJobs: ['bgj_scale'], runningBgJobActivity: {} } : {}),
    }));
  }
  await h.db.session.createMany({ data: rows });
  for (const { projectId, sessionId } of coordinators) {
    await h.db.project.update({ where: { id: projectId }, data: { coordinatorSessionId: sessionId } });
  }

  // A session in another workspace of the account, written before each read so the version moves.
  const other = (await h.db.workspace.create({ data: { ownerId, runnerId, name: `scale other ${ownerId}`, enabled: true } })).id;
  const nudge = (await h.db.session.create({
    data: { ownerId, creatorId: ownerId, title: 'nudge', prompt: 'p', dispatchOrigin: 'USER', workspaceId: other, status: 'AWAITING_INPUT' },
  })).id;
  let n = 0;
  const timed = async (url: string) => {
    n += 1;
    await h.db.session.update({ where: { id: nudge }, data: { title: `nudge ${n}` } });
    const started = performance.now();
    const res = await fetch(`${h.base}${url}`, { headers: { authorization: `Bearer ${bearer}` } });
    const body = await res.text();
    const ms = performance.now() - started;
    assert.equal(res.status, 200, body.slice(0, 500));
    return { ms, bytes: Buffer.byteLength(body), body };
  };
  const ws = uuidToBase62(workspaceId);
  const fullUrl = `/api/sessions?view=open&workspaceId=${ws}`;
  const listingUrl = `/api/sessions/listing?workspaceId=${ws}&view=open`;
  // One untimed read of each first, so neither pays for a cold plan cache or connection.
  await timed(fullUrl);
  await timed(listingUrl);
  const full: Array<{ ms: number; bytes: number }> = [];
  const listing: Array<{ ms: number; bytes: number }> = [];
  let page: { folders: unknown[]; entries: Array<{ kind: string }>; next: string | null } | undefined;
  for (let round = 0; round < ROUNDS; round += 1) {
    full.push(await timed(fullUrl));
    const read = await timed(listingUrl);
    listing.push(read);
    page = JSON.parse(read.body);
  }
  const fullRows = (JSON.parse((await timed(fullUrl)).body) as unknown[]).length;
  const report = {
    seed: { openSessions: fullRows, folders: FOLDERS, projects: PROJECTS, membersPerProject: MEMBERS + 1 },
    wholeOpenList: { medianMs: Math.round(median(full.map((r) => r.ms))), bytes: full[0].bytes },
    listingFirstPage: {
      medianMs: Math.round(median(listing.map((r) => r.ms))), bytes: listing[0].bytes,
      entries: page!.entries.length, projectEntries: page!.entries.filter((e) => e.kind === 'project').length,
      folderRows: page!.folders.length,
    },
    rounds: ROUNDS,
  };
  t.diagnostic(`session listing scale: ${JSON.stringify(report)}`);
  console.log(`SESSION_LISTING_SCALE ${JSON.stringify(report)}`);

  assert.equal(fullRows, SESSIONS);
  assert.equal(page!.entries.length, 40);
  assert.equal(page!.folders.length, FOLDERS);
  assert.ok(page!.next, 'more pages follow');
  assert.ok(listing[0].bytes * 10 < full[0].bytes, `the first page (${listing[0].bytes} B) is under a tenth of the whole list (${full[0].bytes} B)`);

  // Deep in the list, among the oldest rows of their own: a failure nobody retries (Needs you) and one a retry is
  // armed for (Working).
  const deep = rows.filter((r, i) => i >= PROJECTS * (MEMBERS + 1) && !r.folderId && !r.pinnedAt && r.status === 'AWAITING_INPUT'
    && !(r.runningBgJobs as string[]).length).slice(0, 2);
  await h.db.session.update({
    where: { id: deep[0].id! },
    data: { status: 'FAILED', finishedAt: new Date(), lastTurnOutcome: 'FAILED' },
  });
  await h.db.session.update({
    where: { id: deep[1].id! },
    data: { status: 'FAILED', finishedAt: new Date(), lastTurnOutcome: 'FAILED', retryAt: new Date(Date.now() + 60_000) },
  });
  // A settled status stamps listed_at (migration 1490): put them back where they were listed.
  for (const r of deep) await h.sql.query('UPDATE session SET listed_at = $2 WHERE id = $1', [r.id, r.listedAt]);
  type Row = ListingRowFacts & { id: string; pinnedAt: string | null; folderId: string | null; projectMembership: unknown };
  const whole = JSON.parse((await timed(fullUrl)).body) as Row[];
  // The rows of their own in no folder that the web's sessionTimeSections draws above the days.
  const attention = whole.filter((r) => !r.folderId && !r.projectMembership
    && (r.pinnedAt || listingRowNeedsOwner(r) || listingRowIsWorking(r)));
  const firstPage = JSON.parse((await timed(listingUrl)).body) as { entries: Array<{ kind: string; session?: { id: string } }> };
  const onFirst = new Set(firstPage.entries.flatMap((e) => e.session ? [e.session.id] : []));
  const sections = {
    needsYou: attention.filter((r) => !r.pinnedAt && listingRowNeedsOwner(r)).length,
    working: attention.filter((r) => !r.pinnedAt && !listingRowNeedsOwner(r) && listingRowIsWorking(r)).length,
    pinned: attention.filter((r) => r.pinnedAt).length,
  };
  t.diagnostic(`attention rows: ${JSON.stringify(sections)}`);
  console.log(`SESSION_LISTING_ATTENTION ${JSON.stringify(sections)}`);
  assert.ok(attention.some((r) => r.id === uuidToBase62(deep[0].id!) && listingRowNeedsOwner(r)), 'the failure needs you');
  assert.ok(attention.some((r) => r.id === uuidToBase62(deep[1].id!) && listingRowIsWorking(r)), 'the retry is working');
  assert.ok(attention.length > 10 && attention.length < 40, `${attention.length} attention rows fit one page`);
  assert.deepEqual(attention.filter((r) => !onFirst.has(r.id)).map((r) => r.id), [], 'every attention row is on the first page');
  // And they lead it: the first page's session entries open with them.
  const leading = firstPage.entries.slice(0, attention.length + 2).flatMap((e) => e.session ? [e.session.id] : []);
  for (const r of attention) assert.ok(leading.includes(r.id), `${r.id} leads the first page`);
});
