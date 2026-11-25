/**
 * The public share surface — `/api/shared/:token/…`, the one door into a session that asks for no
 * login — over real HTTP (the real SharedController behind the real PublicSurfaceGuard, with
 * main.ts's pipe, interceptors and filters around it) against a real, fully migrated PostgreSQL.
 * What the door is held to:
 *
 *   (a) an artifact is served only when its bytes are already stored. A path the transcript names
 *       but nobody stored answers 404 without a turn in the owner's session — which is how the
 *       runner is asked for a file — and without reading the session's run_event history;
 *   (b) the transcript comes in pages: the root keeps its old fields and adds the tail page and
 *       `hasMore`, `/events` pages backwards with `before`, trims with `maxPayload` and says so, and
 *       `/events/:seq` answers one event whole;
 *   (c) every answer, the refusals included, carries Cache-Control: no-store and
 *       X-Robots-Tag: noindex, nofollow;
 *   (d) one address that spends one link's budget is refused 429 — another address on that link,
 *       and the same address on another link, are not;
 *   (e) a session in the trash cannot be shared, and the refusal writes no token;
 *   (f) `/events?after=` reads what the session added since a seq, oldest first with a cursor to the
 *       rest, and the root's header as it stands now;
 *   (h) `/stream` (docs/session-viewer-stream-design.md §3–§4) is held by the same negative assertions
 *       as the guest door's (test-support/viewer-door-checks.ts) against `/events`, on a link with
 *       Tool output and one without: no field or event type the read does not carry, deltas on both,
 *       tool output only on the first, head frames saying what `events?after=` says; it is answered
 *       no-store and noindex, a token that opens nothing is a 404 status, and an open spends the
 *       visitor's budget like any request;
 *   (i) the anonymous stream caps (§6, D5): a visitor's fifth open stream on one link, a link's stream past its cap and
 *       a stream past the apiserver's total are each refused 429, and closing one stream frees its slot. The harness
 *       keeps the real per-visitor cap (4) and lowers the other two, so each is reached in a handful of streams.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/shared/public-surface.pg.spec.ts
 *
 * Not destructive: every row belongs to an owner this run creates.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { type IncomingHttpHeaders, request as httpRequest } from 'node:http';
import { test } from 'node:test';

import { type INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost, NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  CreatorType, PrismaClient, RunnerStatus, RunStatus, SessionDispatchOrigin, TaskCompletionCriterion,
} from '@prisma/client';
import { RunEventType, uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';

import { AttachmentsService } from '../attachments/attachments.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { publicIdHeaders } from '../common/public-id-headers';
import { PublicIdExceptionFilter } from '../common/public-id.filter';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { TransientDbConflictFilter } from '../common/transient-db-conflict.filter';
import { WorkspaceAliasInterceptor } from '../common/workspace-alias.interceptor';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { LEGACY_STATUS_SELECT } from '../sessions/session-legacy-words';
import { withSessionState } from '../sessions/session-state';
import { SessionsService } from '../sessions/sessions.service';
import { ViewerStreamService } from '../sessions/viewer-stream.service';
import { VIEWER_STREAM_CAPS, ViewerStreamCaps } from '../sessions/viewer-stream-caps';
import { RealtimeService } from '../realtime/realtime.service';
import { openStream, type HeldStream } from '../test-support/sse-client';
import { viewerStreamCrossings } from '../test-support/viewer-door-checks';
import { DriveContentService } from '../drive/drive-content.service';
import { DriveService } from '../drive/drive.service';
import { ShareLinksController } from '../share-links/share-links.controller';
import { ShareLinksService } from '../share-links/share-links.service';
import { SharedRateLimiter } from './public-surface.guard';
import { SharedController } from './shared.controller';
import { SharedStreamGuard } from './shared-stream.guard';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);

/** The budget this harness gives the guard, so (d) can spend it in a handful of requests — and (i) a visitor its
 *  four streams, a refused fifth, and one more after closing one. */
const BUDGET = 6;
/** The stream caps this harness gives the guard: the real one per visitor, and lowered ones per link and in all. */
const STREAM_CAPS = { perVisitor: VIEWER_STREAM_CAPS.perVisitor, perLink: 6, total: 9 };
/** Filler replies at seq 2..LAST_FILLER: more history than one page may hold (500). */
const LAST_FILLER = 600;
/** Length of the two bulky tool bodies, and the smallest cap `maxPayload` accepts. */
const BIG = 5_000;
const CAP = 256;
/** What the old root answered with, besides `events`. */
const OLD_FIELDS = [
  'title', 'workspaceName', 'status', 'runStatus', 'sessionState', 'runState',
  'lifecycleState', 'filingState', 'createdAt',
];
/** What every root answers with since links became `share_link` rows (0306), whatever the root. */
const LINK_FIELDS = ['kind', 'include', 'sharedAt'];
// Activity was added by the parked-session activity projection. The guest red line also requires
// public roots and polling to carry waitingOnOwner as a boolean, never approval contents.
// phase, released, lastTurnOutcome and waitingOn (plan step 5.1, sessions/session-phase.ts) are the shared
// header's as every session payload's: words about the state the root already shows, never what is asked.
// endReason and workFinished (plan phase 5) likewise: the stored end word and one boolean, no cause and no error.
const STATE_FIELDS = ['waitingOnOwner', 'phase', 'released', 'lastTurnOutcome', 'waitingOn', 'endReason', 'workFinished'];

type Json = Record<string, any>;
type Answer = { status: number; headers: IncomingHttpHeaders; body: Buffer; json: Json };

/** One request on a connection of its own (agent: false), so no answer rides a pooled socket. */
function send(
  base: string,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${base}${path}`, { method, agent: false, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        let json: Json = {};
        try { json = JSON.parse(body.toString('utf8')) as Json; } catch { /* a file body */ }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

test('the public share surface: stored artifacts only, a paged transcript, no-store and noindex, a budget per visitor, no sharing from the trash', {
  skip: !URL, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const db: PrismaClient = prismaClientFor(url);
  // The server's own client, reporting every statement it sends — how (a) sees what a request READ,
  // which a row count cannot.
  const statements: string[] = [];
  const server = new PrismaClient({
    adapter: new PrismaPg(url),
    log: [{ emit: 'event', level: 'query' }],
  });
  (server as unknown as { $on: (e: 'query', cb: (q: { query: string }) => void) => void })
    .$on('query', (q) => statements.push(q.query));
  let app: INestApplication | undefined;
  t.after(async () => {
    await app?.close().catch(() => undefined);
    await server.$disconnect().catch(() => undefined);
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  await verifyCoordinatorPgIdentity(sql);
  const prisma = server as unknown as PrismaService;

  // ── the world ──────────────────────────────────────────────────────────────────────────────
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `owner-${RUN}-${ownerId}@public-surface.invalid`, name: 'owner', passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId,
      ownerId,
      name: 'owner runner',
      tokenHash: `public-surface-${runnerId}`,
      status: RunnerStatus.ONLINE,
      capabilities: [],
      capabilitiesReportedAt: new Date(),
    },
  });
  const workspaceName = `orbit ${RUN}`;
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: workspaceName, enabled: true } });

  const newToken = () => randomBytes(24).toString('base64url');
  async function conversation(
    title: string,
    extra: { shareToken?: string; deletedAt?: Date } = {},
  ): Promise<string> {
    const id = randomUUID();
    await db.session.create({
      data: {
        id, ownerId, creatorId: ownerId, workspaceId, title, prompt: title,
        status: RunStatus.AWAITING_INPUT, dispatchOrigin: SessionDispatchOrigin.USER,
        ...(extra.deletedAt ? { deletedAt: extra.deletedAt } : {}),
      },
    });
    // A shared conversation's link is a `share_link` row since 0306, not the session's own column.
    if (extra.shareToken) {
      await sql.query(
        `INSERT INTO share_link (id, owner_id, token, session_id) VALUES (gen_random_uuid(), $1::uuid, $2, $3::uuid)`,
        [ownerId, extra.shareToken, id],
      );
    }
    return id;
  }
  async function event(sessionId: string, seq: number, type: string, payload: unknown, turnId?: string) {
    await sql.query(
      `INSERT INTO run_event (id, session_id, seq, type, payload, turn_id)
       VALUES (gen_random_uuid(), $1::uuid, $2, $3, $4::jsonb, $5::uuid)`,
      [sessionId, seq, type, JSON.stringify(payload), turnId ?? null],
    );
  }
  const turnsOf = async (sessionId: string) => Number((await sql.query(
    'SELECT count(*)::int AS n FROM conversation_turn WHERE session_id = $1::uuid', [sessionId],
  )).rows[0].n);
  // The session's open link, as `share_link` holds it (0306) — the shape the old column pair had.
  const shareOf = async (sessionId: string) => ((await sql.query(
    `SELECT token AS "shareToken", created_at AS "sharedAt" FROM share_link
      WHERE session_id = $1::uuid AND revoked_at IS NULL`,
    [sessionId],
  )).rows[0] ?? { shareToken: null, sharedAt: null }) as { shareToken: string | null; sharedAt: Date | null };

  // The shared conversation. Replayable history is seq 1..600 plus 602, 604 and 606; 601 and 605
  // are progress pings and 603 a live-only snapshot, all three stored but never part of a transcript.
  const token = newToken();
  const shared = await conversation('Draw the mock and show me', { shareToken: token });
  const missingPath = `/root/.orbit/worktrees/${shared}/mock.html`;
  const storedPath = `/root/.orbit/worktrees/${shared}/shots/stored.png`;
  const turn = randomUUID();
  await event(shared, 1, RunEventType.USER, { text: 'Draw the mock and show me' });
  await sql.query(
    `INSERT INTO run_event (id, session_id, seq, type, payload)
     SELECT gen_random_uuid(), $1::uuid, g, 'assistant', jsonb_build_object('text', 'reply ' || g)
       FROM generate_series(2, $2::int) g`,
    [shared, LAST_FILLER],
  );
  await event(shared, 601, RunEventType.SYSTEM, { model: null, subtype: 'status', sessionId: 'rt-1' });
  await event(shared, 602, RunEventType.TOOL_USE, {
    id: 'toolu_mock', name: 'Write', input: { file_path: missingPath, content: 'w'.repeat(BIG) },
  });
  await event(shared, 603, RunEventType.TOOL_OUTPUT, { toolUseId: 'toolu_mock', output: 'live only' });
  await event(shared, 604, RunEventType.TOOL_RESULT, { toolUseId: 'toolu_mock', content: 'r'.repeat(BIG) });
  await event(shared, 605, RunEventType.SYSTEM, { model: null, subtype: 'task_progress', sessionId: 'rt-1' });
  await event(shared, 606, RunEventType.ASSISTANT, {
    text: `The mock is at ${missingPath}; the screenshot is ${storedPath}.`,
  }, turn);
  const REPLAYABLE = [
    ...Array.from({ length: LAST_FILLER }, (_, i) => i + 1),
    602, 604, 606,
  ];
  // The screenshot's bytes, stored the way the owner's artifact door stores a fetched file.
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001', 'hex');
  const attachmentId = (await db.attachment.create({
    data: {
      ownerId, sessionId: shared, mimeType: 'image/png', sizeBytes: png.length,
      fileName: 'stored.png', data: Uint8Array.from(png),
    },
    select: { id: true },
  })).id;
  // A second shared conversation (another link), and one the owner never shared.
  const otherToken = newToken();
  const other = await conversation('Another shared conversation', { shareToken: otherToken });
  await event(other, 1, RunEventType.USER, { text: 'hello' });

  // ── the app: the real controllers, main.ts's middleware, pipe, interceptors and filters ──────
  // Queue and realtime are the ways a session reaches its runner; nothing under test may use them,
  // so any call is a TypeError that surfaces as a 500 against the status each request asserts.
  const sessions = new SessionsService(prisma, {} as never, {} as never);
  // The streams' live half: this process's own hub, published to directly by (h). No LISTEN connection is opened
  // (onModuleInit is never called), so nothing from another process reaches it.
  const realtime = new RealtimeService(prisma, { scheduleBadgeSync: () => undefined, notifySessionSettled: () => undefined } as never);
  t.after(() => realtime.onModuleDestroy());
  const caps = new ViewerStreamCaps(STREAM_CAPS);
  @Module({
    controllers: [SharedController, ShareLinksController],
    providers: [
      { provide: SessionsService, useValue: sessions },
      { provide: AttachmentsService, useValue: new AttachmentsService(prisma) },
      { provide: ShareLinksService, useValue: new ShareLinksService(prisma) },
      // Drive file links, which nothing here shares or opens (share-links-drive-file.pg.spec.ts holds them).
      { provide: DriveService, useValue: {} },
      { provide: DriveContentService, useValue: {} },
      { provide: SharedRateLimiter, useValue: new SharedRateLimiter({ max: BUDGET, windowMs: 60_000 }) },
      { provide: ViewerStreamService, useValue: new ViewerStreamService(prisma, realtime, sessions) },
      { provide: ViewerStreamCaps, useValue: caps },
      SharedStreamGuard,
      JwtAuthGuard,
      Reflector,
      { provide: JwtService, useValue: { verifyAsync: async () => ({ sub: ownerId }) } },
    ],
  })
  class PublicSurfaceHarness {}

  app = await NestFactory.create(PublicSurfaceHarness, { logger: false, abortOnError: false });
  app.use(publicIdHeaders);
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  app.useGlobalInterceptors(new WorkspaceAliasInterceptor(), new PublicIdInterceptor());
  const httpAdapter = app.get(HttpAdapterHost).httpAdapter;
  app.useGlobalFilters(new TransientDbConflictFilter(new PublicIdExceptionFilter(httpAdapter), httpAdapter));
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();

  // Every /shared answer of the run, for (c). Unless a case names the address it speaks from, each
  // request comes from an address of its own — the budget is (d)'s subject and no one else's.
  const surface: Answer[] = [];
  let visitors = 0;
  const freshAddress = () => {
    visitors += 1;
    return `10.${(visitors >> 16) & 255}.${(visitors >> 8) & 255}.${visitors & 255}`;
  };
  async function visit(path: string, from = freshAddress()): Promise<Answer> {
    const answer = await send(base, 'GET', `/api/shared/${path}`, { 'x-real-ip': from });
    surface.push(answer);
    return answer;
  }
  const at = (path: string) => `${encodeURIComponent(token)}${path}`;
  const seqs = (answer: Answer) => (answer.json.events as Json[]).map((e) => e.seq as number);
  const pub = uuidToBase62;

  await t.test('(a) an artifact comes only from stored bytes: no turn for the runner, no run_event scan', async () => {
    const turnsBefore = await turnsOf(shared);
    const mark = statements.length;

    const missing = await visit(at(`/artifacts?path=${encodeURIComponent(missingPath)}`));
    assert.equal(missing.status, 404, missing.body.toString());

    const stored = await visit(at(`/artifacts?path=${encodeURIComponent(storedPath)}`));
    assert.equal(stored.status, 200, stored.body.toString());
    assert.equal(stored.headers['content-type'], 'image/png');
    assert.deepEqual(stored.body, png);

    // The path check stays: the stored file's name, asked for outside this session's own
    // directories — nowhere at all, or in another session's checkout — is not this session's file.
    for (const elsewhere of ['/etc/stored.png', `/root/.orbit/worktrees/${other}/shots/stored.png`]) {
      const refused = await visit(at(`/artifacts?path=${encodeURIComponent(elsewhere)}`));
      assert.equal(refused.status, 404, `${elsewhere} is not this session's file`);
    }

    assert.equal(await turnsOf(shared), turnsBefore, 'a visitor put a turn in the owner session');
    const read = statements.slice(mark);
    assert.deepEqual(read.filter((q) => /run_event/.test(q)), [], 'the artifact door read run_event');
    assert.deepEqual(read.filter((q) => /conversation_turn/.test(q)), [], 'the artifact door wrote a turn');

    // The recorder's positive: a page request does read run_event, and it shows up.
    const pageMark = statements.length;
    assert.equal((await visit(at('/events?limit=1'))).status, 200);
    assert.ok(statements.slice(pageMark).some((q) => /run_event/.test(q)), 'the statement log saw nothing');
  });

  await t.test('(b) the transcript comes in pages; the root keeps its old fields', async () => {
    const row = await db.session.findUniqueOrThrow({
      where: { id: shared },
      select: { ...LEGACY_STATUS_SELECT, completedAt: true, archivedAt: true, deletedAt: true, createdAt: true },
    });
    const state = withSessionState(row);

    // The root: every old field, then the tail page (200) and hasMore, and the link's own three
    // (kind, include, sharedAt), and activity (TURN, BACKGROUND_JOB, WAITING, or null;
    // introduced by 29fc026c1). The guest red line also requires the public root to expose
    // waitingOnOwner as a boolean, without approval contents — nothing else.
    const root = await visit(at(''));
    assert.equal(root.status, 200, root.body.toString());
    assert.deepEqual(
      Object.keys(root.json).sort(),
      [...OLD_FIELDS, ...LINK_FIELDS, ...STATE_FIELDS, 'events', 'hasMore', 'agentName', 'activity'].sort(),
    );
    assert.ok(root.json.activity === null || ['TURN', 'BACKGROUND_JOB', 'WAITING'].includes(root.json.activity));
    assert.equal(root.json.kind, 'SESSION');
    assert.equal(typeof root.json.waitingOnOwner, 'boolean');
    assert.equal(root.json.title, 'Draw the mock and show me');
    assert.equal(root.json.workspaceName, workspaceName);
    assert.equal(root.json.createdAt, row.createdAt.toISOString());
    for (const field of ['status', 'runStatus', 'sessionState', 'runState', 'lifecycleState', 'filingState'] as const) {
      assert.equal(root.json[field], state[field], field);
    }
    assert.deepEqual(seqs(root), REPLAYABLE.slice(-200));
    assert.equal(root.json.hasMore, true);
    const last = (root.json.events as Json[]).at(-1)!;
    assert.equal(last.turnId, pub(turn), 'the event body went through PublicIdInterceptor');
    assert.equal((root.json.events as Json[]).find((e) => e.seq === 604)!.payload.content.length, BIG);
    assert.ok((root.json.events as Json[]).every((e) => !('truncated' in e)), 'nothing trimmed unasked');

    const rootTrimmed = await visit(at(`?limit=3&maxPayload=${CAP}`));
    assert.deepEqual(seqs(rootTrimmed), [602, 604, 606]);
    assert.equal(rootTrimmed.json.hasMore, true);
    assert.equal(rootTrimmed.json.events[1].payload.content.length, CAP);
    assert.equal(rootTrimmed.json.events[1].truncated, true);

    // The tail of /events, noise and live-only rows fenced out before the LIMIT.
    const tail = await visit(at('/events?limit=3'));
    assert.equal(tail.status, 200, tail.body.toString());
    assert.deepEqual(seqs(tail), [602, 604, 606]);
    assert.equal(tail.json.hasMore, true);
    // `before` pages backwards, and the oldest page says it is the last.
    const older = await visit(at('/events?limit=3&before=602'));
    assert.deepEqual(seqs(older), [598, 599, 600]);
    assert.equal(older.json.hasMore, true);
    const oldest = await visit(at('/events?before=3'));
    assert.deepEqual(seqs(oldest), [1, 2]);
    assert.equal(oldest.json.hasMore, false);
    // A page holds 500 at most, however many are asked for.
    const capped = await visit(at('/events?limit=100000'));
    assert.deepEqual(seqs(capped), REPLAYABLE.slice(-500));
    assert.equal(capped.json.hasMore, true);

    // maxPayload trims the tool bodies to a preview and marks exactly those events.
    const trimmed = await visit(at(`/events?limit=3&maxPayload=${CAP}`));
    const [use, result, reply] = trimmed.json.events as Json[];
    assert.equal(use.payload.input.content.length, CAP);
    assert.equal(use.payload.input.file_path, missingPath);
    assert.equal(use.truncated, true);
    assert.equal(result.payload.content.length, CAP);
    assert.equal(result.truncated, true);
    assert.equal('truncated' in reply, false);
    assert.equal(reply.payload.text, `The mock is at ${missingPath}; the screenshot is ${storedPath}.`);

    // /events/:seq: the whole of one event.
    const whole = await visit(at('/events/604'));
    assert.equal(whole.status, 200, whole.body.toString());
    assert.equal(whole.json.seq, 604);
    assert.equal(whole.json.type, RunEventType.TOOL_RESULT);
    assert.equal(whole.json.payload.content, 'r'.repeat(BIG));
    assert.equal('truncated' in whole.json, false);
    assert.equal((await visit(at('/events/602'))).json.payload.input.content.length, BIG);
    // Not a way around the fence, or out of this session: a ping, a live-only row, a seq that
    // does not exist, and this session's seq asked for through another link all answer 404.
    for (const seq of [601, 603, 605, 9_999]) {
      assert.equal((await visit(at(`/events/${seq}`))).status, 404, `seq ${seq}`);
    }
    assert.equal((await visit(`${encodeURIComponent(otherToken)}/events/604`)).status, 404);
    assert.equal((await visit(at('/events/not-a-seq'))).status, 400);
  });

  await t.test('(c) every /shared answer says no-store and noindex, refusals included', async () => {
    const answers = [
      await visit(at('')),
      await visit(at('/events')),
      await visit(at('/events/1')),
      await visit(at(`/attachments/${pub(attachmentId)}`)),
      await visit(at(`/artifacts?path=${encodeURIComponent(storedPath)}`)),
      await visit(at(`/artifacts?path=${encodeURIComponent(missingPath)}`)),
      await visit(at('/events/not-a-seq')),
      await visit(at('/attachments/not-an-id')),
      await visit(`${newToken()}`),
    ];
    assert.deepEqual(answers.map((a) => a.status), [200, 200, 200, 200, 200, 404, 400, 400, 404]);
    assert.deepEqual(answers[3].body, png, 'the attachment door answered the stored bytes');
    for (const answer of answers) {
      assert.equal(answer.headers['cache-control'], 'no-store');
      assert.equal(answer.headers['x-robots-tag'], 'noindex, nofollow');
    }
  });

  await t.test('(d) one address over one link\'s budget is refused 429; the others are not', async () => {
    const budgetToken = otherToken;
    const spender = '198.51.100.7';
    const neighbour = '198.51.100.8';
    const on = (path: string) => `${encodeURIComponent(budgetToken)}${path}`;
    // The budget is per link, not per route: it is spent across all of them.
    const spent = [
      await visit(on(''), spender),
      await visit(on('/events'), spender),
      await visit(on('/events/1'), spender),
      await visit(on(''), spender),
      await visit(on('/events?limit=1'), spender),
      await visit(on('/events?limit=2'), spender),
    ];
    assert.equal(spent.length, BUDGET);
    assert.deepEqual(spent.map((a) => a.status), spent.map(() => 200));

    const refused = await visit(on(''), spender);
    assert.equal(refused.status, 429, refused.body.toString());
    assert.equal(refused.headers['cache-control'], 'no-store');
    assert.equal(refused.headers['x-robots-tag'], 'noindex, nofollow');
    assert.equal((await visit(on('/events'), spender)).status, 429, 'still spent');

    // Not over theirs: another visitor on the same link, and the same visitor on another link.
    assert.equal((await visit(on(''), neighbour)).status, 200, 'another address on the same link');
    assert.equal((await visit(at('?limit=1'), spender)).status, 200, 'the same address on another link');
  });

  await t.test('(e) a session in the trash is not shared, and nothing is written', async () => {
    const share = (sessionId: string) => send(base, 'POST', `/api/sessions/${pub(sessionId)}/share`, {
      authorization: 'Bearer owner',
    });
    const trashed = await conversation('In the trash', { deletedAt: new Date() });
    const refused = await share(trashed);
    assert.equal(refused.status, 409, refused.body.toString());
    assert.deepEqual(await shareOf(trashed), { shareToken: null, sharedAt: null });

    // Shared before it was trashed: the paused link stays exactly as it was, and stays paused.
    const pausedToken = newToken();
    const paused = await conversation('Shared, then trashed', { shareToken: pausedToken, deletedAt: new Date() });
    const before = await shareOf(paused);
    const again = await share(paused);
    assert.equal(again.status, 409, again.body.toString());
    assert.equal(again.body.toString().includes(pausedToken), false, 'the refusal handed the token back');
    assert.deepEqual(await shareOf(paused), before);
    assert.equal((await visit(encodeURIComponent(pausedToken))).status, 404);

    // The same door on a session outside the trash writes the token it answers with.
    const live = await conversation('Not in the trash');
    const minted = await share(live);
    assert.equal(minted.status, 201, minted.body.toString());
    assert.equal(typeof minted.json.shareToken, 'string');
    assert.equal((await shareOf(live)).shareToken, minted.json.shareToken);
    assert.equal((await visit(encodeURIComponent(minted.json.shareToken))).status, 200);
  });

  await t.test('(f) `after` reads what the session added since a seq, with its header as it stands now', async () => {
    // Newer than a seq, oldest first, past the noise and the live-only row; the cursor says where the
    // rest start, and is null once the page reaches the newest event.
    const first = await visit(at('/events?after=598&limit=3'));
    assert.equal(first.status, 200, first.body.toString());
    assert.deepEqual(seqs(first), [599, 600, 602]);
    assert.equal(first.json.after, 602);
    const rest = await visit(at('/events?after=602&limit=3'));
    assert.deepEqual(seqs(rest), [604, 606]);
    assert.equal(rest.json.after, null);
    const caughtUp = await visit(at('/events?after=606'));
    assert.deepEqual(seqs(caughtUp), []);
    assert.equal(caughtUp.json.after, null);
    const trimmed = await visit(at(`/events?after=600&limit=1&maxPayload=${CAP}`));
    assert.deepEqual(seqs(trimmed), [602]);
    assert.equal(trimmed.json.events[0].truncated, true);

    // The header is the root's — its fields, as the root answers them, and nothing else.
    const root = await visit(at(''));
    assert.deepEqual(Object.keys(rest.json).sort(), [...OLD_FIELDS, ...STATE_FIELDS, 'agentName', 'activity', 'events', 'after'].sort());
    for (const field of [...OLD_FIELDS, ...STATE_FIELDS, 'agentName', 'activity']) assert.deepEqual(rest.json[field], root.json[field], field);

    // A conversation that moves on: the next read holds what it added and how it stands now.
    const liveToken = newToken();
    const live = await conversation('Still going', { shareToken: liveToken });
    await event(live, 1, RunEventType.USER, { text: 'go on' });
    const on = (path: string) => `${encodeURIComponent(liveToken)}${path}`;
    const waiting = await visit(on('/events?after=1'));
    assert.deepEqual(seqs(waiting), []);
    assert.equal(waiting.json.runState, 'AWAITING_INPUT');
    await db.session.update({ where: { id: live }, data: { status: RunStatus.RUNNING } });
    await event(live, 2, RunEventType.ASSISTANT, { text: 'going on' });
    const moved = await visit(on('/events?after=1'));
    assert.deepEqual(seqs(moved), [2]);
    assert.equal(moved.json.events[0].payload.text, 'going on');
    assert.equal(moved.json.runState, 'RUNNING');
  });

  await t.test('(g) the card names the link for a chat app, is no view, and a token that opens nothing is the one 404', async () => {
    const views = async () => Number((await sql.query(
      'SELECT view_count AS n FROM share_link WHERE token = $1', [token],
    )).rows[0].n);
    const before = await views();
    const card = await visit(at('/card'));
    assert.equal(card.status, 200, card.body.toString());
    assert.match(String(card.headers['content-type']), /^text\/html/);
    const head = card.body.toString('utf8');
    assert.match(head, /<title>Draw the mock and show me<\/title>/);
    assert.match(head, /<meta property="og:description" content="A conversation shared from Orbit" \/>/);
    assert.match(head, /<meta property="og:image" content="[^"]*\/icon-512\.png" \/>/);
    assert.equal(await views(), before, 'a chat fetching the card counted as a view');

    assert.equal((await visit(`${encodeURIComponent(newToken())}/card`)).status, 404);
  });

  await t.test('(h) the stream: the same negative assertions as its read, on a link with Tool output and one without', async (st) => {
    // The same session behind a second link, with Tool output off: a task link whose task it is a run of (a session
    // has one live session link), read through the conversation routes.
    const taskId = randomUUID();
    await db.task.create({
      data: {
        id: taskId, ownerId, title: `Shared task ${RUN}`, creatorType: CreatorType.USER, creatorId: ownerId,
        completionCriterion: TaskCompletionCriterion.EVIDENCE_JUDGMENT,
      },
    });
    await db.session.update({ where: { id: shared }, data: { taskId } });
    const bareToken = newToken();
    await sql.query(
      `INSERT INTO share_link (id, owner_id, token, task_id, include) VALUES (gen_random_uuid(), $1::uuid, $2, $3::uuid, '{"conversations": true, "toolOutput": false}'::jsonb)`,
      [ownerId, bareToken, taskId],
    );
    const LIVE_OUTPUT = `live-output-${RUN}`;
    const OWNER_ONLY = [`approval-${RUN}`, `translation-${RUN}`, `progress-${RUN}`];
    const streams: HeldStream[] = [];
    st.after(() => streams.forEach((held) => held.close()));
    const doors = [
      { name: 'session link with Tool output', token, at: '', toolOutput: true },
      { name: 'task link conversation without Tool output', token: bareToken, at: `/sessions/${pub(shared)}`, toolOutput: false },
    ];
    for (const door of doors) {
      const held = await openStream(`${base}/api/shared/${encodeURIComponent(door.token)}${door.at}/stream`, { 'x-real-ip': freshAddress() });
      streams.push(held);
      assert.equal(held.status, 200, door.name);
      // Nest's SSE writer sets its own Cache-Control over the guard's; it still says no-store.
      assert.match(String(held.headers['cache-control']), /(^|, )no-store(,|$)/, door.name);
      assert.equal(held.headers['x-robots-tag'], 'noindex, nofollow', door.name);
      await held.until((f) => f.type === 'head', `${door.name}: the opening head`);
    }
    // The cursor-less replay is the tail the read pages: the newest SSE_REPLAY_CAP (200) of the transcript.
    const replayed = streams[0]!.frames.filter((f) => f.seq > 0).map((f) => f.seq);
    assert.deepEqual(replayed, REPLAYABLE.slice(-200));

    // Every event type, live, as the ingest and the decisions publish them.
    const publish = (seq: number, type: string, payload: Record<string, unknown>) =>
      realtime.publish(shared, { seq, type: type as never, payload, ts: new Date().toISOString() });
    publish(0, RunEventType.TEXT_DELTA, { text: 'Hel' });
    publish(0, RunEventType.THINKING_DELTA, { text: 'hmm' });
    publish(0, RunEventType.TOOL_OUTPUT, { toolUseId: 'toolu_live', output: LIVE_OUTPUT });
    publish(0, RunEventType.BACKGROUND_OUTPUT, { shellId: 'bg', output: LIVE_OUTPUT });
    publish(0, RunEventType.APPROVAL_REQUEST, { id: randomUUID(), toolName: 'Bash', input: { command: OWNER_ONLY[0] } });
    publish(0, RunEventType.QUEUED_TURNS_CHANGED, {});
    publish(0, RunEventType.TRANSLATION, { of: 606, lang: 'zh', text: OWNER_ONLY[1] });
    publish(0, RunEventType.TASK_PROGRESS, { toolUseId: 'toolu_live', description: OWNER_ONLY[2] });
    publish(0, 'tombstone', {});
    publish(0, RunEventType.STATUS, { status: 'RUNNING' });
    await db.session.update({ where: { id: shared }, data: { status: RunStatus.RUNNING } });
    publish(0, RunEventType.APPROVAL_RESOLVED, { id: randomUUID(), behavior: 'allow' });
    // A durable reply, stored first as the ingest stores it, with a tool body the bare link must not show.
    await event(shared, 607, RunEventType.TOOL_USE, { id: 'toolu_live', name: 'Bash', input: { command: LIVE_OUTPUT } });
    publish(607, RunEventType.TOOL_USE, { id: 'toolu_live', name: 'Bash', input: { command: LIVE_OUTPUT } });
    await event(shared, 608, RunEventType.ASSISTANT, { text: 'live reply' });
    publish(608, RunEventType.ASSISTANT, { text: 'live reply' });

    for (const [i, door] of doors.entries()) {
      const held = streams[i]!;
      await held.until((f) => f.seq === 608, `${door.name}: the live reply`);
      await held.until((f) => f.type === 'head' && f.payload.runState === 'RUNNING', `${door.name}: the head after the status`);
    }
    await new Promise((r) => setTimeout(r, 600));
    for (const [i, door] of doors.entries()) {
      const held = streams[i]!;
      const page = await visit(`${encodeURIComponent(door.token)}${door.at}/events?after=${REPLAYABLE.at(-201)}&limit=500`);
      assert.equal(page.status, 200, page.body.toString());
      const { events: readEvents, after: _after, ...readHeader } = page.json;
      assert.deepEqual(
        viewerStreamCrossings({
          readEvents, readHeader, toolOutput: door.toolOutput, frames: held.frames, texts: held.texts,
          neverShown: [...OWNER_ONLY, ownerId, pub(ownerId), runnerId, pub(runnerId)],
        }),
        [],
        `${door.name}: the stream carries what its read does not`,
      );
      const types = new Set(held.frames.map((f) => f.type as string));
      assert.ok(types.has('text_delta') && types.has('thinking_delta'), `${door.name}: deltas`);
      assert.equal(types.has('tool_output'), door.toolOutput, `${door.name}: tool_output`);
      assert.equal(held.texts.some((text) => text.includes(LIVE_OUTPUT)), door.toolOutput, `${door.name}: tool output text`);
      const heads = held.frames.filter((f) => f.type === 'head');
      assert.deepEqual(heads.at(-1)!.payload, readHeader, `${door.name}: the last head is the read's header`);
    }

    // Refusals are statuses, with the surface's headers, and an open spends the budget.
    const nothing = await openStream(`${base}/api/shared/${newToken()}/stream`, { 'x-real-ip': freshAddress() });
    await nothing.ended;
    assert.equal(nothing.status, 404, nothing.body());
    assert.equal(nothing.headers['cache-control'], 'no-store');
    assert.equal(nothing.headers['x-robots-tag'], 'noindex, nofollow');
    const notAConversation = await openStream(`${base}/api/shared/${encodeURIComponent(token)}/sessions/${pub(shared)}/stream`, { 'x-real-ip': freshAddress() });
    await notAConversation.ended;
    assert.equal(notAConversation.status, 404, 'a session link opens no conversation stream');
    const spender = '198.51.100.70';
    const bareAt = `${encodeURIComponent(bareToken)}/sessions/${pub(shared)}`;
    for (let n = 0; n < BUDGET; n += 1) assert.equal((await visit(`${bareAt}/events?limit=1`, spender)).status, 200);
    const over = await openStream(`${base}/api/shared/${bareAt}/stream`, { 'x-real-ip': spender });
    await over.ended;
    assert.equal(over.status, 429, 'a stream open past the budget');
  });

  await t.test('(i) the anonymous stream caps: 429 at cap + 1 per visitor, per link and in all, and a closed stream frees its slot', async (st) => {
    const held: HeldStream[] = [];
    st.after(() => held.forEach((s) => s.close()));
    /** Wait until the caps count `n` open streams: a slot is given back when the server sees the answer close. */
    const settled = async (n: number, what: string) => {
      for (const started = Date.now(); caps.held !== n; await new Promise((r) => setTimeout(r, 20))) {
        if (Date.now() - started > 10_000) assert.fail(`${what}: the caps still count ${caps.held} streams, not ${n}`);
      }
    };
    await settled(0, 'the streams (h) closed');
    const linkA = newToken();
    const linkB = newToken();
    await conversation('Capped A', { shareToken: linkA });
    await conversation('Capped B', { shareToken: linkB });
    const open = async (link: string, from = freshAddress()) => {
      const s = await openStream(`${base}/api/shared/${encodeURIComponent(link)}/stream`, { 'x-real-ip': from });
      if (s.status === 200) held.push(s);
      else await s.ended;
      return s;
    };
    const refusedByCap = async (link: string, from: string | undefined, what: string) => {
      const before = caps.held;
      const s = await open(link, from);
      assert.equal(s.status, 429, `${what}: ${s.body()}`);
      assert.match(s.body(), /too many live viewers/, `${what}: the caps' refusal, not the request budget's`);
      assert.equal(s.headers['cache-control'], 'no-store', what);
      assert.equal(caps.held, before, `${what}: a refused stream holds no slot`);
      return s;
    };
    const closeOne = async (s: HeldStream, what: string) => {
      const n = caps.held;
      s.close();
      held.splice(held.indexOf(s), 1);
      await settled(n - 1, what);
    };

    // Per visitor on one link (4): the fifth is refused; another address on that link and the visitor on another
    // link are not; one closed, the visitor opens again.
    const visitor = '198.51.100.90';
    const mine: HeldStream[] = [];
    for (let n = 1; n <= STREAM_CAPS.perVisitor; n += 1) {
      const s = await open(linkA, visitor);
      assert.equal(s.status, 200, `the visitor's stream ${n}`);
      mine.push(s);
    }
    await refusedByCap(linkA, visitor, 'the visitor\'s fifth stream on the link');
    assert.equal((await open(linkA)).status, 200, 'another address on the same link');
    await closeOne(mine[0]!, 'the visitor closed one');
    assert.equal((await open(linkA, visitor)).status, 200, 'the visitor again, after closing one');
    assert.equal(caps.held, 5);

    // Per link (6 here): one more from a new address fills it, the next new address is refused; one closed frees it.
    assert.equal((await open(linkA)).status, 200, 'the link\'s sixth stream');
    await refusedByCap(linkA, undefined, 'the link\'s seventh stream');
    await closeOne(held.find((s) => !mine.includes(s))!, 'one of the link\'s streams closed');
    assert.equal((await open(linkA)).status, 200, 'the link again, after closing one');

    // In all (9 here): three on another link fill it, the next stream anywhere is refused; one closed frees it.
    for (let n = 7; n <= STREAM_CAPS.total; n += 1) assert.equal((await open(linkB)).status, 200, `stream ${n} in all`);
    await refusedByCap(linkB, undefined, 'the tenth stream in all');
    await closeOne(held.at(-1)!, 'one stream closed');
    assert.equal((await open(linkB)).status, 200, 'a stream again, after closing one');

    // Every slot is given back when its stream ends.
    held.splice(0).forEach((s) => s.close());
    await settled(0, 'every stream closed');
  });

  await t.test('(j) an ended session\'s root, to a visitor with no sign-in: the end word and workFinished, nothing else', async () => {
    // A task run that ended DONE, an End, and a failure release, each shared on a link of its own. Each row also
    // holds an error the page must never show; the root's keys are (b)'s, whatever the end.
    const secret = `engine exited: secret ${RUN}`;
    const ends = [
      { label: 'task done', row: { status: RunStatus.SUCCEEDED, endReason: 'task_done', lastTurnOutcome: 'ANSWERED' }, workFinished: true },
      { label: 'ended', row: { status: RunStatus.CANCELLED, endReason: 'ended', lastTurnOutcome: 'ANSWERED' }, workFinished: false },
      { label: 'failed', row: { status: RunStatus.FAILED, endReason: null, lastTurnOutcome: 'FAILED' }, workFinished: false },
    ] as const;
    for (const end of ends) {
      const endToken = newToken();
      const id = await conversation(`Ended: ${end.label}`, { shareToken: endToken });
      await event(id, 1, RunEventType.USER, { text: 'hello' });
      await db.session.update({ where: { id }, data: { ...end.row, finishedAt: new Date(), error: secret } });
      const root = await visit(`${encodeURIComponent(endToken)}`);
      assert.equal(root.status, 200, root.body.toString());
      assert.deepEqual(
        Object.keys(root.json).sort(),
        [...OLD_FIELDS, ...LINK_FIELDS, ...STATE_FIELDS, 'events', 'hasMore', 'agentName', 'activity'].sort(),
        end.label,
      );
      assert.equal(root.json.endReason, end.row.endReason, end.label);
      assert.equal(root.json.workFinished, end.workFinished, end.label);
      assert.equal(root.json.released, true, end.label);
      assert.equal(root.json.lastTurnOutcome, end.row.lastTurnOutcome, end.label);
      assert.ok(!root.body.toString().includes(secret), `${end.label}: the root showed the row's error`);
      assert.ok(!root.body.toString().includes(ownerId) && !root.body.toString().includes(pub(ownerId)), `${end.label}: the root named the owner`);
      const after = await visit(`${encodeURIComponent(endToken)}/events?after=0`);
      assert.equal(after.json.endReason, end.row.endReason, `${end.label}: the polled header`);
      assert.equal(after.json.workFinished, end.workFinished, `${end.label}: the polled header`);
      assert.ok(!after.body.toString().includes(secret), `${end.label}: the polled header showed the row's error`);
    }
  });

  await t.test('(c) …and so did every other /shared answer this run received', () => {
    const statuses = new Set(surface.map((a) => a.status));
    for (const status of [200, 400, 404, 429]) assert.ok(statuses.has(status), `no ${status} was collected`);
    for (const answer of surface) {
      assert.equal(answer.headers['cache-control'], 'no-store', `a ${answer.status}`);
      assert.equal(answer.headers['x-robots-tag'], 'noindex, nofollow', `a ${answer.status}`);
    }
  });
});
