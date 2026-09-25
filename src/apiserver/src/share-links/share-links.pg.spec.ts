/**
 * Public links as rows of their own — `share_link`, migration 0306 — over real HTTP (the real
 * ShareLinksController, SharedController and SessionsController behind main.ts's pipe,
 * interceptors and filters, the JWT guard fed by a stubbed verifier) against a real, fully migrated
 * PostgreSQL. docs/share-links-design.md §3–§5 is the contract. What it is held to:
 *
 *   (1) the backfill carries every `session.share_token` over unchanged, and the old link opens;
 *   (2) opening is idempotent; turning a link off 404s its token, and opening again mints a new one
 *       — for a session, a task and a project alike, with layers and expiry changed in between;
 *   (3) an expired link and a session in the trash answer exactly what a turned-off link answers,
 *       status and body; restoring the session opens its link again;
 *   (4) hard-deleting a task or a project deletes its links;
 *   (5) only the root page counts a view, and not when it is the owner's Preview (`?preview=1`);
 *   (6) another account can neither read nor change any of it;
 *   (7) the old `POST/DELETE /sessions/:id/share` and the session detail's `shareToken` behave as
 *       they did;
 *   (8) with Tool output off, the public events carry no tool input and no tool output;
 *   (9) the CHECK and the partial unique indexes refuse what they exist to refuse;
 *  (10) the session list says which sessions a link opens right now — not one turned off, past its
 *       expiry or paused by the trash — and the dialog's read counts what each layer holds.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/share-links/share-links.pg.spec.ts
 *
 * Not destructive: every row belongs to an owner this run creates.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { type IncomingHttpHeaders, request as httpRequest } from 'node:http';
import path from 'node:path';
import { test } from 'node:test';

import { type INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost, NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import {
  CreatorType,
  PrismaClient,
  RunnerStatus,
  RunStatus,
  SessionDispatchOrigin,
  TaskCompletionCriterion,
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
import { RealtimeService } from '../realtime/realtime.service';
import { SessionTagsService } from '../session-tags/session-tags.service';
import { AutoRetryService } from '../sessions/auto-retry.service';
import { MergeReceiptService } from '../sessions/merge-receipt.service';
import { SessionsController } from '../sessions/sessions.controller';
import { SessionsService } from '../sessions/sessions.service';
import { SharedRateLimiter } from '../shared/public-surface.guard';
import { SharedController } from '../shared/shared.controller';
import { ShareLinksController } from './share-links.controller';
import { ShareLinksService } from './share-links.service';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const MIGRATION = readFileSync(
  path.resolve(__dirname, '../../prisma/migrations/0306_share_link/migration.sql'),
  'utf8',
);

// What main.ts installs before the app serves anything: the session detail carries BIGINT columns,
// and without this JSON.stringify refuses them and every read of a real session is a 500.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function toJSON(this: bigint) {
  return this.toString();
};

type Json = Record<string, any>;
type Answer = { status: number; headers: IncomingHttpHeaders; body: Buffer; text: string; json: Json };

/** One request on a connection of its own (agent: false), so no answer rides a pooled socket. */
function send(
  base: string,
  method: string,
  path: string,
  options: { as?: 'owner' | 'other'; body?: unknown } = {},
): Promise<Answer> {
  const payload = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body));
  const headers: Record<string, string> = {};
  if (options.as) headers.authorization = `Bearer ${options.as}`;
  if (payload) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(payload.length);
  }
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${base}${path}`, { method, agent: false, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        const text = body.toString('utf8');
        let json: Json = {};
        try { json = JSON.parse(text) as Json; } catch { /* an empty or file body */ }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** The SQLSTATE and constraint a statement was refused with. */
async function refusal(sql: Client, text: string, values: unknown[]): Promise<{ code: string; constraint: string }> {
  try {
    await sql.query(text, values);
  } catch (error) {
    const e = error as { code?: string; constraint?: string };
    return { code: e.code ?? '', constraint: e.constraint ?? '' };
  }
  return { code: 'ACCEPTED', constraint: '' };
}

test('share links: one row per link, an owner interface for three roots, one 404 for every dead link', {
  skip: !URL, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const db: PrismaClient = prismaClientFor(url);
  const server: PrismaClient = prismaClientFor(url);
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
  const otherId = randomUUID();
  for (const [id, name] of [[ownerId, 'owner'], [otherId, 'other']] as const) {
    await db.user.create({
      data: { id, email: `${name}-${RUN}-${id}@share-links.invalid`, name, passwordHash: 'x' },
    });
  }
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: 'owner runner', tokenHash: `share-links-${runnerId}`,
      status: RunnerStatus.ONLINE, capabilities: [], capabilitiesReportedAt: new Date(),
    },
  });
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: `orbit ${RUN}`, enabled: true } });

  /** A session. `legacyToken` writes the retired columns, the way a link looked before 0306. */
  async function conversation(
    title: string,
    extra: { legacyToken?: string; legacySharedAt?: Date | null; deletedAt?: Date } = {},
  ): Promise<string> {
    const id = randomUUID();
    await db.session.create({
      data: {
        id, ownerId, creatorId: ownerId, workspaceId, title, prompt: title,
        status: RunStatus.AWAITING_INPUT, dispatchOrigin: SessionDispatchOrigin.USER,
        ...(extra.legacyToken ? { shareToken: extra.legacyToken, sharedAt: extra.legacySharedAt ?? null } : {}),
        ...(extra.deletedAt ? { deletedAt: extra.deletedAt } : {}),
      },
    });
    return id;
  }
  async function task(title: string): Promise<string> {
    const id = randomUUID();
    await db.task.create({
      data: {
        id, ownerId, title, creatorType: CreatorType.USER, creatorId: ownerId,
        completionCriterion: TaskCompletionCriterion.EVIDENCE_JUDGMENT,
      },
    });
    return id;
  }
  async function project(title: string): Promise<string> {
    const id = randomUUID();
    await db.project.create({ data: { id, ownerId, title } });
    return id;
  }
  async function event(sessionId: string, seq: number, type: string, payload: unknown) {
    await sql.query(
      `INSERT INTO run_event (id, session_id, seq, type, payload) VALUES (gen_random_uuid(), $1::uuid, $2, $3, $4::jsonb)`,
      [sessionId, seq, type, JSON.stringify(payload)],
    );
  }
  /** Every link row a root has, ended ones included, oldest first. */
  const rowsOf = async (column: 'session_id' | 'task_id' | 'project_id', id: string) => (await sql.query(
    `SELECT id, owner_id, token, include, expires_at, revoked_at, revoked_reason, view_count,
            last_viewed_at, created_at, updated_at
       FROM share_link WHERE ${column} = $1::uuid ORDER BY created_at, id`,
    [id],
  )).rows as Json[];
  const rowByToken = async (token: string) => (await sql.query(
    'SELECT * FROM share_link WHERE token = $1', [token],
  )).rows[0] as Json | undefined;
  const newToken = () => randomBytes(24).toString('base64url');
  const pub = uuidToBase62;

  // ── the app: the real controllers, main.ts's middleware, pipe, interceptors and filters ──────
  const sessions = new SessionsService(prisma, {} as never, {} as never);
  @Module({
    controllers: [SharedController, ShareLinksController, SessionsController],
    providers: [
      { provide: SessionsService, useValue: sessions },
      { provide: AttachmentsService, useValue: new AttachmentsService(prisma) },
      { provide: ShareLinksService, useValue: new ShareLinksService(prisma) },
      // A budget no case here comes near: the budget is public-surface.pg.spec's subject, not this one's.
      { provide: SharedRateLimiter, useValue: new SharedRateLimiter({ max: 100_000, windowMs: 60_000 }) },
      // SessionsController's other dependencies: the detail route touches none of them.
      { provide: PrismaService, useValue: {} },
      { provide: RealtimeService, useValue: {} },
      { provide: SessionTagsService, useValue: {} },
      { provide: MergeReceiptService, useValue: {} },
      { provide: AutoRetryService, useValue: {} },
      JwtAuthGuard,
      Reflector,
      // `Bearer other` is the second account; any other bearer is the owner.
      { provide: JwtService, useValue: { verifyAsync: async (token: string) => ({ sub: token === 'other' ? otherId : ownerId }) } },
    ],
  })
  class ShareLinksHarness {}

  // Errors only: a 500 here should arrive with its stack, and nothing else is worth printing.
  app = await NestFactory.create(ShareLinksHarness, { logger: ['error'], abortOnError: false });
  app.use(publicIdHeaders);
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  app.useGlobalInterceptors(new WorkspaceAliasInterceptor(), new PublicIdInterceptor());
  const httpAdapter = app.get(HttpAdapterHost).httpAdapter;
  app.useGlobalFilters(new TransientDbConflictFilter(new PublicIdExceptionFilter(httpAdapter), httpAdapter));
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();

  const visit = (token: string, rest = '') => send(base, 'GET', `/api/shared/${encodeURIComponent(token)}${rest}`);
  const owner = (method: string, p: string, body?: unknown) => send(base, method, `/api${p}`, { as: 'owner', body });
  const other = (method: string, p: string, body?: unknown) => send(base, method, `/api${p}`, { as: 'other', body });
  const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

  // Seeded BEFORE the backfill runs again in (1), so it has something to carry.
  const legacyAt = new Date('2026-07-01T12:34:56.789Z');
  const legacyToken = newToken();
  const legacy = await conversation('Shared before 0306', { legacyToken, legacySharedAt: legacyAt });
  const legacyTrashedToken = newToken();
  const legacyTrashed = await conversation('Shared, then trashed, before 0306', {
    legacyToken: legacyTrashedToken, legacySharedAt: legacyAt, deletedAt: new Date(),
  });
  const legacyUndatedToken = newToken();
  const legacyUndated = await conversation('A token with no shared_at', { legacyToken: legacyUndatedToken, legacySharedAt: null });
  const neverShared = await conversation('Never shared');

  await t.test('(1) the backfill carries every share_token over unchanged, and the old link opens', async () => {
    // The template database already ran 0306 against no sessions at all. The file is written to run
    // twice, so running it again here is its backfill meeting sessions that hold a token.
    await sql.query(MIGRATION);
    for (const [session, token] of [[legacy, legacyToken], [legacyTrashed, legacyTrashedToken], [legacyUndated, legacyUndatedToken]]) {
      assert.deepEqual(
        (await rowsOf('session_id', session)).map((row) => row.token),
        [token],
        'the backfill did not carry this session\'s share_token over as one link',
      );
    }
    const [carried] = await rowsOf('session_id', legacy);
    assert.equal(carried.token, legacyToken, 'the token string changed on the way over');
    assert.deepEqual(carried.include, { toolOutput: true });
    assert.equal(carried.owner_id, ownerId);
    assert.equal(new Date(carried.created_at).toISOString(), legacyAt.toISOString(), 'created_at is not shared_at');
    assert.equal(carried.revoked_at, null);
    assert.equal(carried.view_count, 0);
    const [trashed] = await rowsOf('session_id', legacyTrashed);
    assert.equal(trashed.token, legacyTrashedToken);
    assert.equal(trashed.revoked_at, null, 'the trash pauses a link, it does not end it');
    const [undated] = await rowsOf('session_id', legacyUndated);
    assert.equal(undated.token, legacyUndatedToken);
    assert.ok(Date.now() - new Date(undated.created_at).getTime() < 120_000, 'an undated token is dated now');
    assert.deepEqual(await rowsOf('session_id', neverShared), []);

    // Once more: nothing is carried twice.
    const before = Number((await sql.query('SELECT count(*)::int AS n FROM share_link')).rows[0].n);
    await sql.query(MIGRATION);
    assert.equal(Number((await sql.query('SELECT count(*)::int AS n FROM share_link')).rows[0].n), before);

    // The link handed out before 0306 still opens, as the same session.
    const page = await visit(legacyToken);
    assert.equal(page.status, 200, page.text);
    assert.equal(page.json.title, 'Shared before 0306');
    assert.equal(page.json.kind, 'SESSION');
    assert.deepEqual(page.json.include, { toolOutput: true });
    assert.equal(page.json.sharedAt, legacyAt.toISOString());
    // And the owner sees it where the old clients look for it.
    const detail = await owner('GET', `/sessions/${pub(legacy)}`);
    assert.equal(detail.status, 200, detail.text);
    assert.equal(detail.json.shareToken, legacyToken);
  });

  const roots = {
    session: { path: 'sessions', column: 'session_id' as const, make: () => conversation('A session to share') },
    task: { path: 'tasks', column: 'task_id' as const, make: () => task('A task to share') },
    project: { path: 'projects', column: 'project_id' as const, make: () => project('A project to share') },
  };
  const DEFAULTS = {
    session: { toolOutput: true },
    task: { commentsAndFiles: false, conversations: false, toolOutput: true },
    project: { taskPages: true, commentsAndFiles: false, conversations: false, toolOutput: true },
  };
  const CHANGE = {
    session: { toolOutput: false },
    task: { conversations: true },
    project: { taskPages: false, conversations: true },
  };
  /** What the owner reads for a root with no link. A session and a task also count their layers —
   *  these roots hold nothing yet (case 10 counts a transcript that has some; public-task.pg.spec a
   *  task that has comments, files and runs). */
  const UNSHARED = {
    session: { link: null, counts: { messages: 0, toolCalls: 0 } },
    task: { link: null, counts: { comments: 0, files: 0, transcripts: 0 } },
    project: { link: null },
  };

  await t.test('(2) opening is idempotent; off 404s the token; on again is a new token — for all three roots', async () => {
    for (const [kind, root] of Object.entries(roots) as [keyof typeof roots, (typeof roots)[keyof typeof roots]][]) {
      const id = await root.make();
      const at = `/${root.path}/${pub(id)}/share`;
      const none = await owner('GET', at);
      assert.equal(none.status, 200, `${kind}: ${none.text}`);
      assert.deepEqual(none.json, UNSHARED[kind], `${kind}: a root nobody shared has no link`);

      const opened = await owner('PUT', at, {});
      assert.equal(opened.status, 200, `${kind}: ${opened.text}`);
      const first = opened.json;
      assert.equal(first.kind, kind.toUpperCase());
      assert.equal(first.state, 'ACTIVE');
      assert.equal(first.stateReason, null);
      assert.deepEqual(first.include, DEFAULTS[kind], `${kind}: the defaults of contract §1`);
      assert.equal(first.root.id, pub(id));
      assert.equal(typeof first.token, 'string');
      assert.equal(first.token.length, 32);

      // The same PUT again is the same link, untouched.
      const again = await owner('PUT', at, {});
      assert.equal(again.status, 200);
      assert.deepEqual(again.json, first, `${kind}: a second identical PUT changed the link`);
      assert.equal((await rowsOf(root.column, id)).length, 1, `${kind}: a second PUT made a second row`);

      // Layers and expiry change on the same link, under the same token; repeating that is a no-op too.
      const until = future(7);
      const changed = await owner('PUT', at, { include: CHANGE[kind], expiresAt: until });
      assert.equal(changed.status, 200, `${kind}: ${changed.text}`);
      assert.equal(changed.json.token, first.token, `${kind}: changing a link re-minted its token`);
      assert.deepEqual(changed.json.include, { ...DEFAULTS[kind], ...CHANGE[kind] });
      assert.equal(changed.json.expiresAt, until);
      const same = await owner('PUT', at, { include: CHANGE[kind], expiresAt: until });
      assert.deepEqual(same.json, changed.json, `${kind}: repeating a change is not idempotent`);
      assert.equal((await owner('GET', at)).json.link.expiresAt, until);
      // `expiresAt: null` is Never again.
      assert.equal((await owner('PUT', at, { expiresAt: null })).json.expiresAt, null);

      const open = await visit(first.token);
      assert.equal(open.status, 200, `${kind}: ${open.text}`);
      assert.equal(open.json.kind, kind.toUpperCase());
      if (kind !== 'session') {
        assert.deepEqual(Object.keys(open.json).sort(), ['include', 'kind', 'root', 'sharedAt']);
      }
      if (kind === 'project') {
        assert.deepEqual(open.json.root, { id: pub(id), title: `A ${kind} to share`, status: 'OPEN', publicId: pub(id) });
      }
      if (kind === 'task') {
        // The task page itself — its fields and its layers — is public-task.pg.spec's subject.
        const { id: rootId, title, status } = open.json.root;
        assert.deepEqual({ rootId, title, status }, { rootId: pub(id), title: `A ${kind} to share`, status: 'OPEN' });
      }

      // Off: the token stops opening, and the row says why.
      const off = await owner('DELETE', at);
      assert.equal(off.status, 200, `${kind}: ${off.text}`);
      assert.equal((await visit(first.token)).status, 404, `${kind}: a turned-off token still opens`);
      const [ended] = await rowsOf(root.column, id);
      assert.equal(ended.revoked_reason, 'TURNED_OFF');
      assert.notEqual(ended.revoked_at, null);
      assert.deepEqual((await owner('GET', at)).json, UNSHARED[kind]);
      // Off twice is not an error.
      assert.equal((await owner('DELETE', at)).status, 200);

      // On again: a new row, a new token; the old one stays dead.
      const reopened = await owner('PUT', at, {});
      assert.equal(reopened.status, 200);
      assert.notEqual(reopened.json.token, first.token, `${kind}: the old token came back`);
      assert.notEqual(reopened.json.id, first.id);
      assert.equal((await visit(reopened.json.token)).status, 200);
      assert.equal((await visit(first.token)).status, 404, `${kind}: turning on again revived the old token`);
      assert.equal((await rowsOf(root.column, id)).length, 2);
    }

    // A layer the root does not have is refused, and nothing is written.
    const session = await conversation('Layers that do not apply');
    const refused = await owner('PUT', `/sessions/${pub(session)}/share`, { include: { taskPages: true } });
    assert.equal(refused.status, 400, refused.text);
    assert.deepEqual(await rowsOf('session_id', session), []);
    // So is an expiry in the past.
    const past = await owner('PUT', `/sessions/${pub(session)}/share`, { expiresAt: new Date(Date.now() - 60_000).toISOString() });
    assert.equal(past.status, 400, past.text);
    assert.deepEqual(await rowsOf('session_id', session), []);

    // Five openings at once converge on one link.
    const raced = await task('Opened five times at once');
    const answers = await Promise.all(
      Array.from({ length: 5 }, () => owner('PUT', `/tasks/${pub(raced)}/share`, {})),
    );
    assert.deepEqual(answers.map((a) => a.status), [200, 200, 200, 200, 200]);
    assert.equal(new Set(answers.map((a) => a.json.token)).size, 1, 'racing PUTs minted more than one token');
    assert.equal((await rowsOf('task_id', raced)).length, 1);
  });

  await t.test('(3) expired and trashed answer exactly what turned-off answers; restoring opens it again', async () => {
    // The answer to compare with: a link turned off.
    const offSession = await conversation('Turned off');
    const offToken = (await owner('PUT', `/sessions/${pub(offSession)}/share`, {})).json.token as string;
    await owner('DELETE', `/sessions/${pub(offSession)}/share`);
    const revoked = await visit(offToken);
    assert.equal(revoked.status, 404);
    assert.deepEqual(revoked.json, { statusCode: 404, message: 'shared link not found', error: 'Not Found' });
    const same = (answer: Answer, what: string) => {
      assert.equal(answer.status, revoked.status, `${what}: status`);
      assert.deepEqual(answer.body, revoked.body, `${what}: body differs from a turned-off link's`);
    };
    // A token that was never issued is not told apart either.
    same(await visit(newToken()), 'never issued');

    // Expired: the owner set a week; the week passed (moved in the row — the API refuses a past expiry).
    const expiring = await conversation('Expires');
    const expiringLink = (await owner('PUT', `/sessions/${pub(expiring)}/share`, { expiresAt: future(7) })).json;
    assert.equal((await visit(expiringLink.token)).status, 200);
    await sql.query(
      `UPDATE share_link SET expires_at = now() - interval '1 second' WHERE token = $1`, [expiringLink.token],
    );
    same(await visit(expiringLink.token), 'expired');
    same(await visit(expiringLink.token, '/events'), 'expired, events page');
    const expiredView = (await owner('GET', `/sessions/${pub(expiring)}/share`)).json.link;
    assert.equal(expiredView.state, 'ENDED');
    assert.equal(expiredView.stateReason, 'EXPIRED');
    // Share again: a new token; the expired one never comes back, and its row says EXPIRED.
    const again = (await owner('PUT', `/sessions/${pub(expiring)}/share`, {})).json;
    assert.notEqual(again.token, expiringLink.token);
    assert.equal((await visit(again.token)).status, 200);
    same(await visit(expiringLink.token), 'expired, after sharing again');
    assert.equal((await rowByToken(expiringLink.token))!.revoked_reason, 'EXPIRED');

    // In the trash: paused. Same answer on every route; restored, it opens again with the same token.
    const trashed = await conversation('Goes to the trash');
    await event(trashed, 1, RunEventType.USER, { text: 'hello' });
    const trashedLink = (await owner('PUT', `/sessions/${pub(trashed)}/share`, {})).json;
    assert.equal((await visit(trashedLink.token)).status, 200);
    await db.session.update({ where: { id: trashed }, data: { deletedAt: new Date() } });
    same(await visit(trashedLink.token), 'in the trash');
    same(await visit(trashedLink.token, '/events'), 'in the trash, events page');
    same(await visit(trashedLink.token, '/events/1'), 'in the trash, one event');
    const paused = (await owner('GET', `/sessions/${pub(trashed)}/share`)).json.link;
    assert.equal(paused.state, 'PAUSED');
    assert.equal(paused.stateReason, 'IN_TRASH');
    // Nor can it be opened or changed from the trash.
    assert.equal((await owner('PUT', `/sessions/${pub(trashed)}/share`, { include: { toolOutput: false } })).status, 409);
    await db.session.update({ where: { id: trashed }, data: { deletedAt: null } });
    const restored = await visit(trashedLink.token);
    assert.equal(restored.status, 200, restored.text);
    assert.equal(restored.json.title, 'Goes to the trash');
    // The legacy link that was in the trash before 0306 is the same kind of pause.
    same(await visit(legacyTrashedToken), 'in the trash since before 0306');
    await db.session.update({ where: { id: legacyTrashed }, data: { deletedAt: null } });
    assert.equal((await visit(legacyTrashedToken)).status, 200);

    // The owner's list names every state, with its reason.
    await db.session.update({ where: { id: trashed }, data: { deletedAt: new Date() } });
    const listed = await owner('GET', '/share-links');
    assert.equal(listed.status, 200, listed.text);
    const byToken = new Map((listed.json.links as Json[]).map((link) => [link.token, link]));
    const stateOf = (token: string) => [byToken.get(token)?.state, byToken.get(token)?.stateReason];
    assert.deepEqual(stateOf(offToken), ['ENDED', 'TURNED_OFF']);
    assert.deepEqual(stateOf(expiringLink.token), ['ENDED', 'EXPIRED']);
    assert.deepEqual(stateOf(again.token), ['ACTIVE', null]);
    assert.deepEqual(stateOf(trashedLink.token), ['PAUSED', 'IN_TRASH']);
    const row = byToken.get(again.token)!;
    assert.deepEqual(
      Object.keys(row).sort(),
      ['createdAt', 'expiresAt', 'id', 'include', 'kind', 'lastViewedAt', 'publicId', 'revokedAt', 'root',
        'state', 'stateReason', 'token', 'updatedAt', 'viewCount'],
    );
    assert.deepEqual(Object.keys(row.root).sort(), ['completedAt', 'id', 'lifecycleState', 'publicId', 'status', 'title']);
    await db.session.update({ where: { id: trashed }, data: { deletedAt: null } });

    // Ending by id, one and many.
    const one = await conversation('Ended by id');
    const oneLink = (await owner('PUT', `/sessions/${pub(one)}/share`, {})).json;
    assert.equal((await owner('DELETE', `/share-links/${oneLink.id}`)).status, 200);
    same(await visit(oneLink.token), 'turned off by id');
    const many = await Promise.all([task('Batch 1'), task('Batch 2')]);
    const manyLinks = await Promise.all(many.map(async (id) => (await owner('PUT', `/tasks/${pub(id)}/share`, {})).json));
    const batch = await owner('POST', '/share-links/turn-off', {
      shareLinkIds: [...manyLinks.map((link) => link.id), oneLink.id],
    });
    assert.equal(batch.status, 200, batch.text);
    assert.deepEqual(batch.json, { count: 2 }, 'the already-ended link was counted again');
    for (const link of manyLinks) same(await visit(link.token), 'turned off in a batch');
  });

  await t.test('(4) hard-deleting a task or a project deletes its links, ended ones too', async () => {
    const doomedTask = await task('Deleted with its links');
    const doomedProject = await project('Deleted with its links');
    const tokens: string[] = [];
    for (const at of [`/tasks/${pub(doomedTask)}/share`, `/projects/${pub(doomedProject)}/share`]) {
      tokens.push((await owner('PUT', at, {})).json.token);
      await owner('DELETE', at);
      tokens.push((await owner('PUT', at, {})).json.token);
    }
    assert.equal((await rowsOf('task_id', doomedTask)).length, 2);
    assert.equal((await rowsOf('project_id', doomedProject)).length, 2);

    await db.task.delete({ where: { id: doomedTask } });
    await db.project.delete({ where: { id: doomedProject } });
    assert.deepEqual(await rowsOf('task_id', doomedTask), []);
    assert.deepEqual(await rowsOf('project_id', doomedProject), []);
    for (const token of tokens) {
      assert.equal(await rowByToken(token), undefined, 'a deleted root left a link row behind');
      assert.equal((await visit(token)).status, 404);
    }
    // A purged session goes the same way.
    const purged = await conversation('Purged');
    const purgedToken = (await owner('PUT', `/sessions/${pub(purged)}/share`, {})).json.token;
    await db.session.delete({ where: { id: purged } });
    assert.equal(await rowByToken(purgedToken), undefined);
  });

  await t.test('(5) only the root page counts a view', async () => {
    const viewed = await conversation('Counted');
    await event(viewed, 1, RunEventType.USER, { text: 'show me' });
    await event(viewed, 2, RunEventType.ASSISTANT, { text: `the screenshot is /root/.orbit/worktrees/${viewed}/shot.png` });
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001', 'hex');
    const attachmentId = (await db.attachment.create({
      data: { ownerId, sessionId: viewed, mimeType: 'image/png', sizeBytes: png.length, fileName: 'shot.png', data: Uint8Array.from(png) },
      select: { id: true },
    })).id;
    const token = (await owner('PUT', `/sessions/${pub(viewed)}/share`, {})).json.token as string;
    const count = async () => {
      const row = (await rowByToken(token))!;
      return { views: row.view_count as number, last: row.last_viewed_at as Date | null };
    };
    assert.deepEqual(await count(), { views: 0, last: null });

    assert.equal((await visit(token)).status, 200);
    const once = await count();
    assert.equal(once.views, 1);
    assert.ok(once.last, 'last_viewed_at not recorded');

    // Everything below the root page: pages, one event, an attachment, an artifact.
    const below = [
      await visit(token, '/events'),
      await visit(token, '/events?before=2&limit=1'),
      await visit(token, '/events/2'),
      await visit(token, `/attachments/${pub(attachmentId)}`),
      await visit(token, `/artifacts?path=${encodeURIComponent(`/root/.orbit/worktrees/${viewed}/shot.png`)}`),
    ];
    assert.deepEqual(below.map((a) => a.status), [200, 200, 200, 200, 200], below.map((a) => a.text).join(' | '));
    assert.deepEqual(await count(), once, 'a request below the root page counted a view');

    // The owner's Preview (the dialog's Preview ↗ opens `/s/<token>?preview=1`) is its owner looking,
    // not a visitor: the root page, whole, without a view.
    const previewed = await visit(token, '?preview=1');
    assert.equal(previewed.status, 200, previewed.text);
    assert.equal(previewed.json.title, 'Counted');
    assert.deepEqual(await count(), once, 'the owner\'s Preview counted a view');

    // The root page again, and one that answers 404 — which is nobody's view.
    assert.equal((await visit(token, '?limit=1')).status, 200);
    assert.equal((await count()).views, 2);
    await owner('DELETE', `/sessions/${pub(viewed)}/share`);
    assert.equal((await visit(token)).status, 404);
    assert.equal((await count()).views, 2, 'a dead link counted a view');
    // The owner reads the count off the link.
    const listed = (await owner('GET', '/share-links')).json.links as Json[];
    assert.equal(listed.find((link) => link.token === token)!.viewCount, 2);

    // A task root counts the same way.
    const counted = await task('Counted task');
    const taskToken = (await owner('PUT', `/tasks/${pub(counted)}/share`, {})).json.token;
    await visit(taskToken);
    assert.equal((await rowByToken(taskToken))!.view_count, 1);
    // …and its Preview does not.
    assert.equal((await visit(taskToken, '?preview=1')).status, 200);
    assert.equal((await rowByToken(taskToken))!.view_count, 1, 'the owner\'s Preview of a task counted a view');
  });

  await t.test('(6) another account can neither read nor change any of it', async () => {
    const session = await conversation('Not theirs');
    const taskId = await task('Not theirs either');
    const projectId = await project('Nor this');
    const links: Json[] = [];
    for (const at of [`/sessions/${pub(session)}/share`, `/tasks/${pub(taskId)}/share`, `/projects/${pub(projectId)}/share`]) {
      links.push((await owner('PUT', at, {})).json);
      assert.equal((await other('GET', at)).status, 404, `GET ${at}`);
      assert.equal((await other('PUT', at, { expiresAt: future(1) })).status, 404, `PUT ${at}`);
      assert.equal((await other('DELETE', at)).status, 404, `DELETE ${at}`);
      // Unauthenticated is not an owner at all.
      assert.equal((await send(base, 'GET', `/api${at}`)).status, 401);
    }
    assert.equal((await other('POST', `/sessions/${pub(session)}/share`)).status, 404);
    // Their own list does not have the owner's links in it.
    const theirs = await other('GET', '/share-links');
    assert.equal(theirs.status, 200);
    assert.deepEqual(theirs.json, { links: [] });
    // Nor can they end one by id, alone or in a batch.
    assert.equal((await other('DELETE', `/share-links/${links[0].id}`)).status, 404);
    const batch = await other('POST', '/share-links/turn-off', { shareLinkIds: links.map((link) => link.id) });
    assert.equal(batch.status, 200);
    assert.deepEqual(batch.json, { count: 0 });

    // Every link is exactly as the owner left it, and still opens.
    for (const link of links) {
      const row = (await rowByToken(link.token))!;
      assert.equal(row.revoked_at, null);
      assert.equal(row.expires_at, null);
      assert.equal((await visit(link.token)).status, 200);
    }
    assert.equal((await rowsOf('session_id', session)).length, 1);
  });

  await t.test('(7) the old POST/DELETE /sessions/:id/share and the detail\'s shareToken behave as they did', async () => {
    const session = await conversation('Shared the old way');
    const detail = async () => (await owner('GET', `/sessions/${pub(session)}`)).json;
    assert.equal((await detail()).shareToken, null);

    const minted = await owner('POST', `/sessions/${pub(session)}/share`);
    assert.equal(minted.status, 201, minted.text);
    assert.deepEqual(Object.keys(minted.json).sort(), ['shareToken', 'sharedAt']);
    const token = minted.json.shareToken as string;
    // Idempotent, as it always was.
    const again = await owner('POST', `/sessions/${pub(session)}/share`);
    assert.deepEqual(again.json, minted.json);
    assert.equal((await detail()).shareToken, token);
    assert.equal((await detail()).sharedAt, minted.json.sharedAt);
    assert.equal((await visit(token)).status, 200);
    // The retired column is not written any more.
    const column = (await sql.query('SELECT share_token FROM session WHERE id = $1::uuid', [session])).rows[0];
    assert.equal(column.share_token, null);

    const revoked = await owner('DELETE', `/sessions/${pub(session)}/share`);
    assert.equal(revoked.status, 200, revoked.text);
    assert.equal(revoked.text, '');
    assert.equal((await detail()).shareToken, null);
    assert.equal((await visit(token)).status, 404);

    const fresh = (await owner('POST', `/sessions/${pub(session)}/share`)).json;
    assert.notEqual(fresh.shareToken, token);
    assert.equal((await detail()).shareToken, fresh.shareToken);

    // The old door opens with the defaults but does not undo a choice made through the new one.
    await owner('PUT', `/sessions/${pub(session)}/share`, { include: { toolOutput: false } });
    const kept = await owner('POST', `/sessions/${pub(session)}/share`);
    assert.equal(kept.json.shareToken, fresh.shareToken);
    assert.deepEqual((await owner('GET', `/sessions/${pub(session)}/share`)).json.link.include, { toolOutput: false });

    // A link past its expiry is not the session's link any more, to the old clients either.
    await owner('PUT', `/sessions/${pub(session)}/share`, { expiresAt: future(1) });
    await sql.query(`UPDATE share_link SET expires_at = now() - interval '1 second' WHERE token = $1`, [fresh.shareToken]);
    assert.equal((await detail()).shareToken, null);
    // And the old door on a trashed session is still refused without writing.
    const trashed = await conversation('Trashed, the old way', { deletedAt: new Date() });
    assert.equal((await owner('POST', `/sessions/${pub(trashed)}/share`)).status, 409);
    assert.deepEqual(await rowsOf('session_id', trashed), []);
  });

  await t.test('(8) Tool output off: the public events carry no tool input and no tool output', async () => {
    const SECRET = {
      input: `SECRET-INPUT-${RUN}`,
      output: `SECRET-OUTPUT-${RUN}`,
      bgCommand: `SECRET-BG-COMMAND-${RUN}`,
      bgOutput: `SECRET-BG-OUTPUT-${RUN}`,
      bgSummary: `SECRET-BG-SUMMARY-${RUN}`,
      bgPath: `SECRET-BG-PATH-${RUN}`,
    };
    const session = await conversation('Tool output');
    await event(session, 1, RunEventType.USER, { text: 'run the build' });
    await event(session, 2, RunEventType.TOOL_USE, {
      id: 'toolu_1', name: 'Bash', input: { command: `echo ${SECRET.input}`, description: SECRET.input.repeat(200) },
    });
    await event(session, 3, RunEventType.TOOL_RESULT, { toolUseId: 'toolu_1', content: SECRET.output, isError: false });
    await event(session, 4, RunEventType.TOOL_RESULT, {
      toolUseId: 'toolu_2', content: [{ type: 'text', text: SECRET.output }], isError: true,
    });
    await event(session, 5, RunEventType.BACKGROUND_TASK, {
      shellId: 'bash_1', toolUseId: 'toolu_1', status: 'completed', kind: 'job', exitCode: 0,
      command: SECRET.bgCommand, output: SECRET.bgOutput, summary: SECRET.bgSummary,
      outputPath: `/root/${SECRET.bgPath}`, outputFile: `/tmp/${SECRET.bgPath}`,
    });
    await event(session, 6, RunEventType.ASSISTANT, { text: 'The build passed.' });
    const at = `/sessions/${pub(session)}/share`;
    const token = (await owner('PUT', at, {})).json.token as string;
    const leaks = (answer: Answer) => Object.values(SECRET).filter((secret) => answer.text.includes(secret));

    // The control: with Tool output on, every one of them is on the page.
    const on = await visit(token);
    assert.equal(on.status, 200, on.text);
    assert.deepEqual(leaks(on), Object.values(SECRET), 'the fixture does not carry what (8) looks for');

    assert.deepEqual((await owner('PUT', at, { include: { toolOutput: false } })).json.include, { toolOutput: false });
    const answers = [
      await visit(token),
      await visit(token, `?maxPayload=256`),
      await visit(token, '/events'),
      await visit(token, '/events?maxPayload=256'),
      await visit(token, '/events/2'),
      await visit(token, '/events/3'),
      await visit(token, '/events/4'),
      await visit(token, '/events/5'),
    ];
    for (const answer of answers) {
      assert.equal(answer.status, 200, answer.text);
      assert.deepEqual(leaks(answer), [], `tool output reached a visitor: ${answer.text.slice(0, 300)}`);
    }
    const events = answers[0].json.events as Json[];
    const bySeq = new Map(events.map((e) => [e.seq, e]));
    assert.deepEqual(bySeq.get(2)!.payload, { id: 'toolu_1', name: 'Bash' }, 'a tool call keeps its name and nothing else');
    assert.deepEqual(bySeq.get(3)!.payload, { toolUseId: 'toolu_1', isError: false });
    assert.deepEqual(bySeq.get(4)!.payload, { toolUseId: 'toolu_2', isError: true });
    assert.deepEqual(bySeq.get(5)!.payload, { shellId: 'bash_1', toolUseId: 'toolu_1', status: 'completed', kind: 'job', exitCode: 0 });
    assert.deepEqual(bySeq.get(6)!.payload, { text: 'The build passed.' }, 'a message is not tool output');
    assert.deepEqual(bySeq.get(1)!.payload, { text: 'run the build' });
    // Nothing is left to expand, so nothing says it was trimmed.
    assert.ok((answers[3].json.events as Json[]).every((e) => !('truncated' in e)));
    assert.deepEqual(answers[4].json.payload, { id: 'toolu_1', name: 'Bash' });

    // Back on, it is all there again: the setting hides, it does not delete.
    await owner('PUT', at, { include: { toolOutput: true } });
    assert.deepEqual(leaks(await visit(token, '/events')), Object.values(SECRET));
  });

  await t.test('(9) the CHECK and the partial unique indexes refuse a second root and a second open link', async () => {
    const session = await conversation('Constrained');
    const taskId = await task('Constrained');
    const projectId = await project('Constrained');
    const insert = `INSERT INTO share_link (id, owner_id, token, session_id, task_id, project_id, revoked_at, revoked_reason)
                    VALUES (gen_random_uuid(), $1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, $6::timestamptz, $7)`;
    const link = (roots: { s?: string; t?: string; p?: string }, ended = false) =>
      [ownerId, newToken(), roots.s ?? null, roots.t ?? null, roots.p ?? null,
        ended ? new Date() : null, ended ? 'TURNED_OFF' : null];

    // Two roots, or none: the CHECK.
    const oneRoot = { code: '23514', constraint: 'share_link_one_root_chk' };
    assert.deepEqual(await refusal(sql, insert, link({ s: session, t: taskId })), oneRoot);
    assert.deepEqual(await refusal(sql, insert, link({ t: taskId, p: projectId })), oneRoot);
    assert.deepEqual(await refusal(sql, insert, link({})), oneRoot);

    // A second open link for the same root: that root's partial unique index.
    for (const [roots, index] of [
      [{ s: session }, 'share_link_session_active_key'],
      [{ t: taskId }, 'share_link_task_active_key'],
      [{ p: projectId }, 'share_link_project_active_key'],
    ] as const) {
      assert.deepEqual(await refusal(sql, insert, link(roots)), { code: 'ACCEPTED', constraint: '' });
      assert.deepEqual(await refusal(sql, insert, link(roots)), { code: '23505', constraint: index });
      // …which is partial: any number of ENDED links may sit beside the open one.
      assert.deepEqual(await refusal(sql, insert, link(roots, true)), { code: 'ACCEPTED', constraint: '' });
      assert.deepEqual(await refusal(sql, insert, link(roots, true)), { code: 'ACCEPTED', constraint: '' });
    }
    // An ended link says why, and only an ended one does.
    const reasonless = [ownerId, newToken(), session, null, null, new Date(), null];
    assert.deepEqual(await refusal(sql, insert, reasonless), { code: '23514', constraint: 'share_link_revoked_chk' });
    // One token, one link — live or ended.
    const [{ token }] = (await sql.query('SELECT token FROM share_link WHERE session_id = $1::uuid LIMIT 1', [session])).rows;
    const reused = [ownerId, token, null, taskId, null, new Date(), 'TURNED_OFF'];
    assert.deepEqual(await refusal(sql, insert, reused), { code: '23505', constraint: 'share_link_token_key' });
  });

  await t.test('(10) the list marks what a link opens right now; the dialog counts what each layer holds', async () => {
    const live = await conversation('Listed, shared');
    const plain = await conversation('Listed, never shared');
    const off = await conversation('Listed, turned off');
    const lapsed = await conversation('Listed, past its expiry');
    const binned = await conversation('Listed, shared then trashed');
    for (const id of [live, off, lapsed, binned]) {
      assert.equal((await owner('PUT', `/sessions/${pub(id)}/share`, {})).status, 200);
    }
    await owner('DELETE', `/sessions/${pub(off)}/share`);
    await sql.query(`UPDATE share_link SET expires_at = now() - interval '1 second' WHERE session_id = $1::uuid`, [lapsed]);
    await sql.query('UPDATE session SET deleted_at = now() WHERE id = $1::uuid', [binned]);
    /** `shared` on each of these sessions' rows, as a view of the list draws it. */
    const flags = async (view: string, ids: string[]) => {
      const list = await owner('GET', `/sessions?view=${view}`);
      assert.equal(list.status, 200, list.text);
      const rows = new Map((list.json as unknown as Json[]).map((row) => [row.id, row.shared]));
      return ids.map((id) => rows.get(pub(id)));
    };
    assert.deepEqual(
      await flags('open', [live, plain, off, lapsed]),
      [true, false, false, false],
      'only the session with a link that opens is marked shared',
    );
    // The trash pauses a link: it is not shared while it is there, and is again once it is back.
    assert.deepEqual(await flags('trash', [binned]), [false]);
    await sql.query('UPDATE session SET deleted_at = NULL WHERE id = $1::uuid', [binned]);
    assert.deepEqual(await flags('open', [binned]), [true]);

    // Counted over the whole transcript: `user` and `assistant` are messages, `tool_use` is a call;
    // results, system events and everything else are neither.
    const talk = await conversation('Counted');
    await event(talk, 1, RunEventType.USER, { text: 'run the build' });
    await event(talk, 2, RunEventType.SYSTEM, { subtype: 'init', sessionId: 'rt-1' });
    await event(talk, 3, RunEventType.ASSISTANT, { text: 'Running it.' });
    await event(talk, 4, RunEventType.TOOL_USE, { id: 'toolu_1', name: 'Bash', input: { command: 'make' } });
    await event(talk, 5, RunEventType.TOOL_RESULT, { toolUseId: 'toolu_1', content: 'ok', isError: false });
    await event(talk, 6, RunEventType.TOOL_USE, { id: 'toolu_2', name: 'Read', input: { file_path: 'x' } });
    await event(talk, 7, RunEventType.TOOL_RESULT, { toolUseId: 'toolu_2', content: 'x', isError: false });
    await event(talk, 8, RunEventType.ASSISTANT, { text: 'The build passed.' });
    await event(talk, 9, RunEventType.RESULT, { subtype: 'success' });
    const at = `/sessions/${pub(talk)}/share`;
    assert.deepEqual((await owner('GET', at)).json, { link: null, counts: { messages: 3, toolCalls: 2 } });
    // The same numbers with a link open, and only for its owner.
    await owner('PUT', at, {});
    const opened = await owner('GET', at);
    assert.equal(opened.json.link.state, 'ACTIVE');
    assert.deepEqual(opened.json.counts, { messages: 3, toolCalls: 2 });
    assert.equal((await other('GET', at)).status, 404);
  });
});
