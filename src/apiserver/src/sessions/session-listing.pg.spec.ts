import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';

import { type INestApplication, Module } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import { toUuid, uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { PG_ADAPTER_OPTIONS } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionTagsService } from '../session-tags/session-tags.service';
import { fixtureFacts, type SessionFixture } from '../test-support/session-word';
import { AutoRetryService } from './auto-retry.service';
import { MergeReceiptService } from './merge-receipt.service';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';

/**
 * `GET /sessions/listing` against the migrated PostgreSQL and the real HTTP route, driven by
 * contracts/session-listing.fixtures.json — the same cases src/web/src/lib/sessionListingFixture.test.ts
 * feeds through the web's sessionProjectListing, so the server and the web are held to one answer.
 * Every read is taken whole and again two entries a page, following `next`: the pages must add up to
 * the same entries, none skipped or repeated.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/sessions/session-listing.pg.spec.ts
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const ROOT = path.resolve(__dirname, '../../../..');

BigInt.prototype.toJSON = function () { return this.toString(); };

interface FixtureSession {
  id: string; workspace?: string; lifecycle?: string; folder?: string; project?: string; role?: string;
  activity?: string; pinnedAt?: string; listedAt?: string; createdAt?: string; lastTurnAt?: string;
  completedAt?: string; archivedAt?: string;
}
interface ExpectedFolder { folderId: string; rowCount: number; needsYou: number; running: boolean; jobs: boolean }
interface Read {
  view: 'open' | 'completed';
  folderId: string | null;
  expected: { folders: ExpectedFolder[] | null; entries: Array<Record<string, unknown>> };
}
interface Case {
  name: string;
  folders: Array<{ id: string; name: string }>;
  foreignFolders: Array<{ id: string; name: string }>;
  projects: string[];
  sessions: FixtureSession[];
  reads: Read[];
}
const FIXTURE = JSON.parse(readFileSync(path.join(ROOT, 'contracts/session-listing.fixtures.json'), 'utf8')) as {
  defaultCreatedAt: string;
  rows: Record<string, { status: string; phase: string; released: boolean; pendingApprovals: number }>;
  cases: Case[];
};

interface Harness {
  app: INestApplication;
  base: string;
  sql: Client;
  db: PrismaClient;
  bearers: Map<string, string>;
}

let harness: Promise<Harness> | undefined;

function boot(): Promise<Harness> {
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
              return { sub, email: `${sub}@listing.invalid` };
            },
          },
        },
      ],
    })
    class ListingModule {}

    const app = await NestFactory.create(ListingModule, { logger: false, abortOnError: false });
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

interface Seeded {
  h: Harness;
  ownerId: string;
  bearer: string;
  here: string;
  /** Fixture name → database id, and back. */
  ids: Map<string, string>;
  names: Map<string, string>;
}

/** One case's sessions, folders and projects under an owner of its own. Session ids sort as their
 *  fixture names do, so the order's last tie-break (id ascending) reads the same on both sides. */
async function seed(c: Case): Promise<Seeded> {
  const h = await boot();
  const ownerId = randomUUID();
  await h.db.user.create({ data: { id: ownerId, email: `${ownerId}@listing.invalid`, name: 'listing', passwordHash: 'x' } });
  const bearer = `bearer-${ownerId}`;
  h.bearers.set(bearer, ownerId);
  const runnerId = randomUUID();
  await h.db.runner.create({
    data: {
      id: runnerId, ownerId, name: `listing-${runnerId}`, tokenHash: `hash-${runnerId}`,
      status: 'ONLINE', capabilities: [], capabilitiesReportedAt: new Date(), maxConcurrent: 8,
    },
  });
  const workspace = async (name: string) => (await h.db.workspace.create({
    data: { ownerId, runnerId, name: `listing ${name} ${ownerId}`, enabled: true },
  })).id;
  const workspaces = { here: await workspace('here'), elsewhere: await workspace('elsewhere') };
  const ids = new Map<string, string>();
  for (const folder of c.folders) {
    ids.set(folder.id, (await h.db.sessionFolder.create({ data: { ownerId, workspaceId: workspaces.here, name: folder.name } })).id);
  }
  for (const folder of c.foreignFolders) {
    ids.set(folder.id, (await h.db.sessionFolder.create({ data: { ownerId, workspaceId: workspaces.elsewhere, name: folder.name } })).id);
  }
  for (const project of c.projects) {
    ids.set(project, (await h.db.project.create({ data: { ownerId, title: `listing ${project}` } })).id);
  }
  const prefix = randomBytes(4).toString('hex');
  const ordered = [...c.sessions].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  ordered.forEach((s, i) => ids.set(s.id, `${prefix}-0000-7000-8000-${(i + 1).toString(16).padStart(12, '0')}`));
  for (const s of c.sessions) {
    const id = ids.get(s.id)!;
    const project = s.project ? ids.get(s.project)! : null;
    const taskId = project && (s.role ?? 'TASK') === 'TASK'
      ? (await h.db.task.create({
          data: {
            ownerId, creatorType: 'USER', creatorId: ownerId, title: `task of ${s.id}`,
            projectId: project, completionCriterion: 'OWNER_CONFIRMED',
          },
        })).id
      : null;
    const completed = s.lifecycle === 'completed';
    const state: SessionFixture =
      completed ? { status: 'SUCCEEDED', finishedAt: new Date(), ...(s.archivedAt ? { archivedAt: new Date() } : { completedAt: new Date() }) }
        : s.activity === 'needsYou' || s.activity === 'running' ? { status: 'RUNNING' }
          : s.activity === 'jobs' ? { status: 'AWAITING_INPUT', runningBgJobs: ['bgj_listing'], runningBgJobActivity: {} }
            : { status: 'AWAITING_INPUT' };
    await h.db.session.create({
      data: {
        id, ownerId, creatorId: ownerId, title: s.id, prompt: 'p', dispatchOrigin: 'USER',
        workspaceId: s.workspace === 'elsewhere' ? workspaces.elsewhere : workspaces.here,
        folderId: s.folder ? ids.get(s.folder)! : null,
        taskId,
        ...fixtureFacts(state),
      } as Prisma.SessionUncheckedCreateInput,
    });
    if (project && s.role === 'COORDINATOR') {
      await h.db.project.update({ where: { id: project }, data: { coordinatorSessionId: id } });
    }
    // Needing you is a question a turn in flight has asked and nobody has answered (workspaceSessionCounts'
    // blocked set), not a failure: a failed project member is folded into its project row and counts nowhere.
    if (s.activity === 'needsYou') {
      const turn = await h.db.conversationTurn.create({
        data: { sessionId: id, seq: 1, clientTurnId: randomUUID(), kind: 'message', deliveredAt: new Date() },
      });
      await h.db.approval.create({
        data: {
          sessionId: id, turnId: turn.id, toolName: 'AskUserQuestion', toolUseId: `ask-${id}`,
          input: { questions: [{ question: 'Go on?', options: [{ label: 'Yes' }] }] },
        },
      });
    }
    // The clocks last: a settled status or a first completed_at stamps listed_at (migration 1490), and the
    // fixture names it. completed_at is already set here, so moving it does not stamp it again.
    // An archived-only row is a legacy one: since migration 0076 session_completed_at_compat mirrors each column
    // into the other, so it is written with that trigger off, inside one transaction nobody else sees it off in.
    const legacy = completed && !!s.archivedAt;
    await h.sql.query('BEGIN');
    if (legacy) await h.sql.query('ALTER TABLE session DISABLE TRIGGER session_completed_at_compat');
    await h.sql.query(
      `UPDATE session SET listed_at = $2, created_at = $3, last_turn_at = $4, pinned_at = $5,
              completed_at = $6, archived_at = $7 WHERE id = $1`,
      [
        id, s.listedAt ?? null, s.createdAt ?? FIXTURE.defaultCreatedAt, s.lastTurnAt ?? null, s.pinnedAt ?? null,
        completed && !legacy ? (s.completedAt ?? s.listedAt) : null, legacy ? s.archivedAt : null,
      ],
    );
    if (legacy) await h.sql.query('ALTER TABLE session ENABLE TRIGGER session_completed_at_compat');
    await h.sql.query('COMMIT');
  }
  return { h, ownerId, bearer, here: workspaces.here, ids, names: new Map([...ids].map(([name, id]) => [id, name])) };
}

interface Page {
  folders?: Array<{ folderId: string; rowCount: number; needsYou: number; running: boolean; jobs: boolean }>;
  entries: Array<
    | { kind: 'session'; session: { id: string } }
    | { kind: 'project'; projectId: string; placedAt: string; spokeAt: string; memberCount: number; running: boolean; jobs: boolean;
        coordinator: { id: string } | null }
  >;
  next: string | null;
  restarted?: boolean;
}

async function get(s: Seeded, query: Record<string, string | undefined>, headers: Record<string, string> = {}) {
  const params = new URLSearchParams(Object.entries(query).filter((e): e is [string, string] => e[1] !== undefined));
  return fetch(`${s.h.base}/api/sessions/listing?${params}`, { headers: { authorization: `Bearer ${s.bearer}`, ...headers } });
}

async function read(s: Seeded, query: Record<string, string | undefined>): Promise<Page> {
  const res = await get(s, query);
  assert.equal(res.status, 200, await res.clone().text());
  return await res.json() as Page;
}

function named(s: Seeded, page: Page) {
  const name = (id: string) => s.names.get(toUuid(id)) ?? `unknown ${id}`;
  return {
    // The fields the contract names; the response also carries `folderPublicId`, the twin every id gets.
    folders: page.folders?.map((f) => ({
      folderId: name(f.folderId), rowCount: f.rowCount, needsYou: f.needsYou, running: f.running, jobs: f.jobs,
    })),
    entries: page.entries.map((entry) => entry.kind === 'session'
      ? { kind: 'session', id: name(entry.session.id) }
      : {
          kind: 'project',
          id: name(entry.projectId),
          coordinator: entry.coordinator ? name(entry.coordinator.id) : null,
          memberCount: entry.memberCount,
          placedAt: entry.placedAt,
          spokeAt: entry.spokeAt,
          running: entry.running,
          jobs: entry.jobs,
        }),
  };
}

for (const c of FIXTURE.cases) {
  test(`fixture: ${c.name}`, { skip }, async () => {
    const s = await seed(c);
    for (const r of c.reads) {
      const label = `${r.view}${r.folderId ? ` in ${r.folderId}` : ''}`;
      const query = {
        workspaceId: uuidToBase62(s.here),
        view: r.view,
        folderId: r.folderId ? uuidToBase62(s.ids.get(r.folderId)!) : undefined,
      };
      // The first page at the default size: the list's first forty entries, the attention sections all among them.
      const first = await read(s, query);
      assert.deepEqual(named(s, first).entries, r.expected.entries.slice(0, 40), `${label}: the first page`);
      assert.equal(first.next !== null, r.expected.entries.length > 40, `${label}: a next page only past forty`);
      const whole = await read(s, { ...query, limit: '200' });
      assert.equal(whole.next, null, `${label}: one page holds it all`);
      const got = named(s, whole);
      assert.deepEqual(got.entries, r.expected.entries, `${label}: entries`);
      if (r.expected.folders === null) assert.equal(whole.folders, undefined, `${label}: no folder rows on a folder's page`);
      else assert.deepEqual(got.folders, r.expected.folders, `${label}: folder rows`);

      // Two entries a page, following `next`: the same entries in the same order, folder rows on the first page only.
      const paged: Array<Record<string, unknown>> = [];
      let after: string | undefined;
      let pages = 0;
      do {
        const page = await read(s, { ...query, limit: '2', after });
        pages += 1;
        assert.ok(page.entries.length <= 2, `${label}: page ${pages} holds at most 2`);
        assert.equal(page.restarted, undefined, `${label}: page ${pages} is no restart`);
        if (pages === 1 && r.expected.folders !== null) assert.deepEqual(named(s, page).folders, r.expected.folders);
        else assert.equal(page.folders, undefined, `${label}: page ${pages} has no folder rows`);
        paged.push(...named(s, page).entries);
        after = page.next ?? undefined;
      } while (after && pages < 50);
      assert.deepEqual(paged, r.expected.entries, `${label}: the pages add up to the whole`);
      assert.equal(pages, Math.max(1, Math.ceil(r.expected.entries.length / 2)), `${label}: no empty trailing page`);
    }

    // What the fixture says each Open session's row carries (`rows`), the web spec's rows are built from: GET /sessions
    // answers it for every Open session here, the ones a project entry holds too.
    const res = await fetch(`${s.h.base}/api/sessions?view=open&workspaceId=${uuidToBase62(s.here)}`, {
      headers: { authorization: `Bearer ${s.bearer}` },
    });
    assert.equal(res.status, 200);
    const rows = await res.json() as Array<{ id: string; status: string; phase: string; released: boolean; pendingApprovals: number }>;
    const open = c.sessions.filter((f) => (f.workspace ?? 'here') === 'here' && (f.lifecycle ?? 'open') === 'open');
    assert.equal(rows.length, open.length);
    for (const row of rows) {
      const name = s.names.get(toUuid(row.id))!;
      const fixture = open.find((f) => f.id === name)!;
      assert.deepEqual(
        { status: row.status, phase: row.phase, released: row.released, pendingApprovals: row.pendingApprovals },
        FIXTURE.rows[fixture.activity ?? 'none'],
        `${name}'s row`,
      );
    }
  });
}

test('304 when nothing moved; a new folder or a moved session answers 200', { skip }, async () => {
  const s = await seed(FIXTURE.cases.find((c) => c.folders.length > 0)!);
  const query = { workspaceId: uuidToBase62(s.here), view: 'open' };
  const first = await get(s, query);
  assert.equal(first.status, 200);
  const etag = first.headers.get('etag');
  assert.ok(etag?.startsWith('W/"ol1-'), `a version ETag: ${etag}`);
  const again = await get(s, query, { 'if-none-match': etag! });
  assert.equal(again.status, 304, 'nothing moved');
  assert.equal(await again.text(), '');

  // Every parameter scopes it: a folder's page, another view, a page size or a cursor never match it.
  for (const other of [{ view: 'completed' }, { limit: '2' }, { folderId: uuidToBase62(s.ids.get('F1')!) }]) {
    const res = await get(s, { ...query, ...other }, { 'if-none-match': etag! });
    assert.equal(res.status, 200, `scoped by ${Object.keys(other)[0]}`);
  }

  // A new, empty folder moves no session — the Open list's version stands — yet it is a folder row here.
  await s.h.db.sessionFolder.create({ data: { ownerId: s.ownerId, workspaceId: s.here, name: 'Brand new' } });
  const afterFolder = await get(s, query, { 'if-none-match': etag! });
  assert.equal(afterFolder.status, 200, 'a new folder is news');
  const folderEtag = afterFolder.headers.get('etag')!;
  assert.notEqual(folderEtag, etag);
  assert.equal((await afterFolder.json() as Page).folders?.length, 4);
  assert.equal((await get(s, query, { 'if-none-match': folderEtag })).status, 304);

  // Filing a session into a folder moves the version.
  await s.h.db.session.update({ where: { id: s.ids.get('l1')! }, data: { folderId: s.ids.get('F3')! } });
  const moved = await get(s, query, { 'if-none-match': folderEtag });
  assert.equal(moved.status, 200, 'a moved session is news');
  assert.deepEqual(named(s, await moved.json() as Page).entries, [{ kind: 'session', id: 'u1' }]);
});

test('a malformed read is refused before anything is read', { skip }, async () => {
  const s = await seed(FIXTURE.cases[0]);
  const workspaceId = uuidToBase62(s.here);
  assert.equal((await get(s, { view: 'open' })).status, 400, 'workspaceId is required');
  assert.equal((await get(s, { workspaceId, view: 'trash' })).status, 400, 'only open and completed');
  assert.equal((await get(s, { workspaceId, limit: '0' })).status, 400);
  assert.equal((await get(s, { workspaceId, after: 'not-a-cursor' })).status, 400);
  // Another account's workspace lists nothing of theirs.
  const stranger = await seed(FIXTURE.cases[1]);
  const theirs = await read(stranger, { workspaceId });
  assert.deepEqual(theirs, { folders: [], entries: [], next: null });
});

test('a cursor from before the Completed order switched starts again from the first page, never a mixed page', { skip }, async () => {
  const c = FIXTURE.cases.find((each) => each.reads.some((r) => r.view === 'completed') && each.projects.length === 0)!;
  const s = await seed(c);
  const query = { workspaceId: uuidToBase62(s.here), view: 'completed' };
  const first = await read(s, { ...query, limit: '2' });
  assert.deepEqual(named(s, first).entries, c.reads[0].expected.entries.slice(0, 2), 'nothing held: the Completed order');
  assert.ok(first.next?.startsWith('c.'), `a cursor of the Completed order: ${first.next}`);
  assert.equal(first.restarted, undefined);
  const next = await read(s, { ...query, limit: '2', after: first.next! });
  assert.equal(next.restarted, undefined, 'a next page in the same order is no restart');
  assert.equal(next.folders, undefined, 'and carries no folder rows');

  // One of them becomes a project's coordinator: something is held now, and the list sorts by listedAt.
  const project = await s.h.db.project.create({ data: { ownerId: s.ownerId, title: 'held after the first page' } });
  await s.h.db.project.update({ where: { id: project.id }, data: { coordinatorSessionId: s.ids.get('kb')! } });
  s.names.set(project.id, 'held');
  const whole = named(s, await read(s, query)).entries;
  assert.equal(whole[0].id, 'ka', 'now by listedAt: ka was listed last');
  const second = await read(s, { ...query, limit: '2', after: first.next! });
  assert.equal(second.restarted, true, 'the old cursor is answered as a restart');
  const fresh = await read(s, { ...query, limit: '2' });
  assert.equal(fresh.restarted, undefined);
  assert.deepEqual(named(s, second).entries, named(s, fresh).entries, "a restart's entries are a fresh first page's");
  assert.deepEqual(named(s, second).entries, whole.slice(0, 2), 'the new order from the top');
  assert.deepEqual(named(s, second).folders, [{ folderId: 'F10', rowCount: 1, needsYou: 0, running: false, jobs: false }],
    'a restart carries the folder rows a first page does');
  assert.deepEqual(named(s, second).folders, named(s, fresh).folders);
  assert.equal(second.next, fresh.next);
  assert.ok(second.next?.startsWith('p.'));
});
