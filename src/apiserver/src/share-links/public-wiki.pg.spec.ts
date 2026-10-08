/**
 * Wiki links — a public link rooted at a wiki space (`share_link.wiki_space_id`, migration 0403) —
 * over real HTTP (the real ShareLinksController and SharedController behind main.ts's pipe,
 * interceptors and filters, the JWT guard fed by a stubbed verifier) against a real, fully migrated
 * PostgreSQL. docs/share-links-design.md §10 is the contract. What it is held to:
 *
 *   (1) the owner's dialog read counts the written documents and the footnotes their pages carry;
 *       opening is idempotent, Footnotes defaults off and is the one layer a wiki link has;
 *   (2) the root page lists the written documents by category, and nothing the plan has that nobody
 *       has written yet; only it counts a view;
 *   (3) a document page is the text alone without Footnotes, and with them the footnotes numbered
 *       again — never a commit, an id, a title, a model, a withdrawn sentence, the repository's address,
 *       or a merge receipt's or an owner decision's words;
 *   (4) a document not written, one the plan does not have, and every route of another kind of link
 *       are the dead link's 404;
 *   (5) `GET /share-links` lists a wiki link only to a client that asks for the kind;
 *   (6) another account can neither read nor change any of it;
 *   (7) with the wiki off for the owner (ORBIT_WIKI), the owner's routes are the wiki's 404 and the
 *       public pages the dead link's;
 *   (8) turning off ends the token, and deleting the space deletes its links;
 *   (9) the CHECK, the composite foreign key and the partial unique index refuse what they exist to.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/share-links/public-wiki.pg.spec.ts
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
import { CreatorType, PrismaClient, RunnerStatus, RunStatus, SessionDispatchOrigin, TaskCompletionCriterion } from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';
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
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { SessionsService } from '../sessions/sessions.service';
import { SharedRateLimiter } from '../shared/public-surface.guard';
import { SharedController } from '../shared/shared.controller';
import { WikiDocs } from '../wiki/wiki-docs';
import { ShareLinksController } from './share-links.controller';
import { ShareLinksService } from './share-links.service';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);

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
        try { json = JSON.parse(text) as Json; } catch { /* an empty body */ }
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

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4';
const MODEL = 'claude-wiki-secret-model';
const REPO = `github.com/acme-secret-${RUN}/orbit`;

test('wiki links: a space\'s written documents, read-only, with Footnotes the one layer', {
  skip: !URL, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const db: PrismaClient = prismaClientFor(url);
  const server: PrismaClient = prismaClientFor(url);
  let app: INestApplication | undefined;
  const flag = process.env.ORBIT_WIKI;
  t.after(async () => {
    if (flag === undefined) delete process.env.ORBIT_WIKI;
    else process.env.ORBIT_WIKI = flag;
    await app?.close().catch(() => undefined);
    await server.$disconnect().catch(() => undefined);
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  await verifyCoordinatorPgIdentity(sql);
  const prisma = server as unknown as PrismaService;
  delete process.env.ORBIT_WIKI; // on, the default

  // ── the world ──────────────────────────────────────────────────────────────────────────────
  const ownerId = randomUUID();
  const otherId = randomUUID();
  const ownerEmail = `owner-${RUN}@public-wiki.invalid`;
  await db.user.create({ data: { id: ownerId, email: ownerEmail, name: `Owner Name ${RUN}`, passwordHash: 'x' } });
  await db.user.create({ data: { id: otherId, email: `other-${RUN}@public-wiki.invalid`, name: 'other', passwordHash: 'x' } });
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `secret runner ${RUN}`, tokenHash: `public-wiki-${runnerId}`,
      status: RunnerStatus.ONLINE, capabilities: [], capabilitiesReportedAt: new Date(),
    },
  });
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: `workspace ${RUN}`, enabled: true } });
  // The records the footnotes cite, each with a title a visitor must never read.
  const sessionId = randomUUID();
  const sessionTitle = `Secret session title ${RUN}`;
  await db.session.create({
    data: {
      id: sessionId, ownerId, creatorId: ownerId, workspaceId, title: sessionTitle, prompt: 'p',
      status: RunStatus.AWAITING_INPUT, dispatchOrigin: SessionDispatchOrigin.USER,
    },
  });
  const taskId = randomUUID();
  const taskTitle = `Secret task title ${RUN}`;
  await db.task.create({
    data: {
      id: taskId, ownerId, title: taskTitle, creatorType: CreatorType.USER, creatorId: ownerId,
      completionCriterion: TaskCompletionCriterion.EVIDENCE_JUDGMENT,
    },
  });

  /** A space with a confirmed plan of three documents in two categories, two of them written. */
  async function space(owner: string, slug: string): Promise<string> {
    const id = randomUUID();
    await db.wikiSpace.create({ data: { id, ownerId: owner, slug, title: `Space ${slug}`, repoUrlNorm: owner === ownerId ? REPO : null } });
    const planId = randomUUID();
    await db.wikiPlan.create({
      data: {
        id: planId, spaceId: id, ownerId: owner, version: 1, status: 'confirmed', origin: 'owner',
        authorUserId: owner, confirmedByUserId: owner, confirmedAt: new Date(), docsMin: 1, docsMax: 10, gate: {},
        categories: [
          { key: 'runtime', title: 'Runtime', question: 'How does it run?', forAgents: false },
          { key: 'ops', title: 'Operations', question: 'How is it run?', forAgents: false },
        ],
      },
    });
    const plan: Array<{ category: string; slug: string; title: string; sections: string[]; scopeOut?: unknown }> = [
      { category: 'runtime', slug: 'session-runtime', title: 'Session runtime', sections: ['loop', 'later'],
        scopeOut: [{ text: 'Where it is stored', docs: ['storage'] }, { text: 'Deploying it', docs: ['deploy'] }] },
      { category: 'runtime', slug: 'storage', title: 'Storage', sections: ['tables'] },
      { category: 'ops', slug: 'deploy', title: 'Deploy', sections: ['steps'] },
    ];
    for (const [position, doc] of plan.entries()) {
      const planDoc = await db.wikiPlanDoc.create({
        data: {
          planId, ownerId: owner, position, category: doc.category, slug: doc.slug, title: doc.title,
          question: `What is ${doc.title}?`, audience: ['A new contributor'], scopeIn: [`${doc.title} itself`],
          scopeOut: (doc.scopeOut ?? []) as never, lengthMin: 100, lengthMax: 2000,
        },
      });
      for (const [p, key] of doc.sections.entries()) {
        await db.wikiPlanSection.create({
          data: { docId: planDoc.id, ownerId: owner, position: p, key, title: `Section ${key}`, kind: 'flow', covers: 'it', length: 200, sources: {} },
        });
      }
    }
    return id;
  }

  /** A written document: one section per entry of `sections`, each its blocks, sentences and footnotes. */
  async function write(
    owner: string,
    spaceId: string,
    slug: string,
    sections: Array<{
      key: string;
      blocks: Array<{ kind: string; text?: string }>;
      sentences: Array<{ block: number; text: string; status?: string; footnotes?: Array<Record<string, unknown>> }>;
    }>,
  ): Promise<void> {
    const doc = await db.wikiDoc.create({
      data: { spaceId, ownerId: owner, slug, planId: randomUUID(), planVersion: 1, planDocId: randomUUID(), status: 'needs_review', repoSha: SHA },
    });
    for (const section of sections) {
      const row = await db.wikiDocSection.create({
        data: {
          docId: doc.id, ownerId: owner, key: section.key, planSectionId: randomUUID(), materialSha256: 'f'.repeat(64),
          blocks: section.blocks as never, repoSha: SHA, model: MODEL,
          dispositions: [{ material: 'S1', kind: 'turn', ref: randomUUID(), action: 'drop', into: null, reason: `secret disposition ${RUN}` }] as never,
        },
      });
      for (const [position, sentence] of section.sentences.entries()) {
        const withdrawn = sentence.status === 'withdrawn';
        const stored = await db.wikiDocSentence.create({
          data: {
            sectionId: row.id, ownerId: owner, position, block: sentence.block, text: sentence.text, status: sentence.status ?? 'sourced',
            ...(withdrawn ? { withdrawnAt: new Date(), withdrawnReason: 'retired', withdrawnEntryId: randomUUID() } : {}),
          },
        });
        for (const [p, footnote] of (sentence.footnotes ?? []).entries()) {
          await db.wikiDocFootnote.create({ data: { sentenceId: stored.id, ownerId: owner, position: p, ...footnote } as never });
        }
      }
    }
  }

  const viaEntryId = randomUUID();
  const turnRecord = randomUUID();
  const commentRecord = randomUUID();
  const receiptRecord = randomUUID();
  const code = {
    kind: 'code', ref: 'src/runner/loop.ts', sha: SHA, lineStart: 10, lineEnd: 12, quote: 'claimTurn(',
    excerpt: 'function claim() {\n  claimTurn(next);\n}', verdict: 'verified', checkedBy: 'runner',
    locator: { symbol: 'RunLoop.claim' }, viaEntryId,
  };
  const turn = {
    kind: 'turn', ref: turnRecord, charStart: 0, charEnd: 20, quote: 'claim the next turn', verdict: 'verified', checkedBy: 'server',
    locator: { sessionId, seq: 4, at: '2026-09-30T08:00:00.000Z', label: 'user' }, viaEntryId,
  };
  const comment = {
    kind: 'task_comment', ref: commentRecord, charStart: 0, charEnd: 10, quote: 'it retries', verdict: 'verified', checkedBy: 'server',
    locator: { taskId, at: '2026-09-30T09:00:00.000Z', label: 'USER' },
  };
  const receipt = {
    kind: 'merge_receipt', ref: receiptRecord, charStart: 0, charEnd: 12, quote: `secret receipt ${RUN}`, verdict: 'verified', checkedBy: 'server',
    locator: { sessionId, taskId, at: '2026-09-30T10:00:00.000Z', label: 'MERGED' },
  };
  const designDoc = {
    kind: 'design_doc', ref: 'docs/deploy.md', sha: SHA, lineStart: 1, lineEnd: 3, quote: 'docker compose up', excerpt: '## Steps\n\ndocker compose up -d',
    verdict: 'verified', checkedBy: 'runner', locator: { section: 'Steps' },
  };

  const spaceId = await space(ownerId, `orbit-${RUN}`);
  await write(ownerId, spaceId, 'session-runtime', [{
    key: 'loop',
    blocks: [{ kind: 'heading', text: 'How it starts' }, { kind: 'paragraph' }, { kind: 'code', text: 'orbit run --once' }],
    sentences: [
      { block: 1, text: 'A session claims a turn.', footnotes: [code, turn, receipt] },
      { block: 1, text: `A withdrawn claim ${RUN}.`, status: 'withdrawn', footnotes: [{ ...turn, ref: randomUUID(), quote: 'withdrawn words' }] },
      { block: 1, text: 'It retries a failed turn.', footnotes: [comment] },
    ],
  }]);
  await write(ownerId, spaceId, 'deploy', [{
    key: 'steps',
    blocks: [{ kind: 'paragraph' }],
    sentences: [{ block: 0, text: 'Deploy it with compose.', footnotes: [designDoc] }],
  }]);
  const otherSpaceId = await space(otherId, `other-${RUN}`);

  // ── the app: the real controllers, main.ts's middleware, pipe, interceptors and filters ──────
  @Module({
    controllers: [SharedController, ShareLinksController],
    providers: [
      { provide: ShareLinksService, useValue: new ShareLinksService(prisma, new WikiDocs(prisma, {} as never)) },
      // A wiki link reads neither: the transcript and attachment routes answer it the one 404.
      { provide: SessionsService, useValue: {} },
      { provide: AttachmentsService, useValue: {} },
      { provide: SharedRateLimiter, useValue: new SharedRateLimiter({ max: 100_000, windowMs: 60_000 }) },
      JwtAuthGuard,
      Reflector,
      // `Bearer other` is the second account; any other bearer is the owner.
      { provide: JwtService, useValue: { verifyAsync: async (token: string) => ({ sub: token === 'other' ? otherId : ownerId }) } },
    ],
  })
  class PublicWikiHarness {}

  app = await NestFactory.create(PublicWikiHarness, { logger: ['error'], abortOnError: false });
  app.use(publicIdHeaders);
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  app.useGlobalInterceptors(new WorkspaceAliasInterceptor(), new PublicIdInterceptor());
  const httpAdapter = app.get(HttpAdapterHost).httpAdapter;
  app.useGlobalFilters(new TransientDbConflictFilter(new PublicIdExceptionFilter(httpAdapter), httpAdapter));
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();

  const pub = uuidToBase62;
  const visit = (token: string, rest = '') => send(base, 'GET', `/api/shared/${encodeURIComponent(token)}${rest}`);
  const owner = (method: string, p: string, body?: unknown) => send(base, method, `/api${p}`, { as: 'owner', body });
  const other = (method: string, p: string, body?: unknown) => send(base, method, `/api${p}`, { as: 'other', body });
  const at = `/wiki/spaces/${pub(spaceId)}/share`;
  const rows = async (id: string) => (await sql.query(
    'SELECT id, token, include, revoked_at, revoked_reason, view_count FROM share_link WHERE wiki_space_id = $1::uuid ORDER BY created_at, id', [id],
  )).rows as Json[];

  /** Nothing in a public answer names the account, the repository, a commit, a record or the model. */
  const assertPrivateStaysOut = (answer: Answer, what: string) => {
    for (const value of [
      ownerId, pub(ownerId), ownerEmail, `Owner Name ${RUN}`, `secret runner ${RUN}`, `workspace ${RUN}`,
      REPO, `acme-secret-${RUN}`, SHA, SHA.slice(0, 7), MODEL, `secret disposition ${RUN}`,
      sessionId, pub(sessionId), sessionTitle, taskId, pub(taskId), taskTitle,
      turnRecord, pub(turnRecord), commentRecord, pub(commentRecord), receiptRecord, pub(receiptRecord),
      viaEntryId, pub(viaEntryId), `secret receipt ${RUN}`, `A withdrawn claim ${RUN}.`, 'withdrawn words',
      spaceId, pub(spaceId), `orbit-${RUN}`,
    ]) {
      assert.ok(!answer.text.includes(value), `${what}: the public answer carries ${value}`);
    }
    for (const field of ['sha', 'repoSha', 'recordId', 'sessionId', 'taskId', 'projectId', 'viaEntryId', 'model', 'ownerId', 'repoUrlNorm']) {
      assert.ok(!answer.text.includes(`"${field}"`), `${what}: the public answer has "${field}"`);
    }
  };

  let token = '';

  await t.test('(1) the dialog counts what a link exposes; opening is idempotent, Footnotes is off by default', async () => {
    const none = await owner('GET', at);
    assert.equal(none.status, 200, none.text);
    // Two written documents. Their footnotes: the code, the turn and the comment, and the design doc —
    // not the merge receipt, and not the turn only the withdrawn sentence cites.
    assert.deepEqual(none.json, { link: null, counts: { documents: 2, footnotes: 4 } });

    const opened = await owner('PUT', at, {});
    assert.equal(opened.status, 200, opened.text);
    assert.equal(opened.json.kind, 'WIKI');
    assert.equal(opened.json.state, 'ACTIVE');
    assert.deepEqual(opened.json.include, { footnotes: false });
    // `publicId` beside `id` is the PublicIdInterceptor's, as on every answer of the owner's.
    assert.deepEqual(opened.json.root, { id: pub(spaceId), publicId: pub(spaceId), title: 'orbit', slug: `orbit-${RUN}` });
    token = opened.json.token;
    assert.equal(token.length, 32);
    assert.deepEqual((await owner('PUT', at, {})).json, opened.json, 'a second identical PUT changed the link');
    assert.equal((await rows(spaceId)).length, 1);

    // A layer a wiki link does not have is refused, and nothing changes.
    for (const layer of ['taskPages', 'commentsAndFiles', 'conversations', 'toolOutput']) {
      const refused = await owner('PUT', at, { include: { [layer]: true } });
      assert.equal(refused.status, 400, `${layer}: ${refused.text}`);
    }
    assert.deepEqual((await rows(spaceId))[0].include, {});
    // And a wiki's layer is refused on any other root.
    const project = await db.project.create({ data: { ownerId, title: `p ${RUN}` } });
    assert.equal((await owner('PUT', `/projects/${pub(project.id)}/share`, { include: { footnotes: true } })).status, 400);

    const read = await owner('GET', at);
    assert.equal(read.json.link.token, token);
    assert.deepEqual(read.json.counts, { documents: 2, footnotes: 4 });
  });

  await t.test('(2) the root page: written documents by category, and the one request that counts a view', async () => {
    const page = await visit(token);
    assert.equal(page.status, 200, page.text);
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.match(String(page.headers['x-robots-tag']), /noindex/);
    assert.deepEqual(Object.keys(page.json).sort(), ['include', 'kind', 'root', 'sharedAt']);
    assert.equal(page.json.kind, 'WIKI');
    assert.deepEqual(page.json.include, { footnotes: false });
    assert.deepEqual(page.json.root, {
      name: 'orbit',
      documents: 2,
      categories: [
        // `storage` is in the plan and not written: it is not listed, and neither is its title.
        { key: 'runtime', number: 1, title: 'Runtime', docs: [{ slug: 'session-runtime', number: '1.1', title: 'Session runtime', lead: 'A session claims a turn. It retries a failed turn.' }] },
        { key: 'ops', number: 2, title: 'Operations', docs: [{ slug: 'deploy', number: '2.1', title: 'Deploy', lead: 'Deploy it with compose.' }] },
      ],
    });
    assertPrivateStaysOut(page, 'the root page');
    assert.ok(!page.text.includes('Storage'), 'a document not written yet is named');

    const views = async () => Number((await rows(spaceId))[0].view_count);
    assert.equal(await views(), 1);
    await visit(token, '?preview=1');
    await visit(token, '/docs/session-runtime');
    assert.equal(await views(), 1, 'a Preview or a document page counted as a view');
  });

  await t.test('(3) a document: the text alone without Footnotes, and with them nothing that leads back', async () => {
    const page = await visit(token, '/docs/session-runtime');
    assert.equal(page.status, 200, page.text);
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.deepEqual(Object.keys(page.json).sort(), ['doc', 'include', 'wiki']);
    assert.deepEqual(page.json.wiki, { name: 'orbit' });
    const doc = page.json.doc;
    assert.equal('footnotes' in doc, false, 'footnotes without the layer');
    assert.deepEqual(doc.sections, [{
      key: 'loop',
      number: 1,
      title: 'Section loop',
      blocks: [
        { kind: 'heading', text: 'How it starts', sentences: [] },
        { kind: 'paragraph', text: null, sentences: [{ text: 'A session claims a turn.', notes: [] }, { text: 'It retries a failed turn.', notes: [] }] },
        { kind: 'code', text: 'orbit run --once', sentences: [] },
      ],
    }], 'the unwritten section and the withdrawn sentence are left out');
    // `storage` is not written: named by its number and title, never linked.
    assert.deepEqual(doc.scopeOut, [
      { text: 'Where it is stored', docs: [{ slug: null, number: '1.2', title: 'Storage' }] },
      { text: 'Deploying it', docs: [{ slug: 'deploy', number: '2.1', title: 'Deploy' }] },
    ]);
    assertPrivateStaysOut(page, 'a document without Footnotes');
    for (const quote of ['claimTurn(', 'claim the next turn', 'it retries', 'src/runner/loop.ts']) {
      assert.ok(!page.text.includes(quote), `without Footnotes the page carries ${quote}`);
    }

    assert.equal((await owner('PUT', at, { include: { footnotes: true } })).json.include.footnotes, true);
    const noted = await visit(token, '/docs/session-runtime');
    assert.equal(noted.status, 200, noted.text);
    assert.deepEqual(noted.json.include, { footnotes: true });
    const sentences = noted.json.doc.sections[0].blocks[1].sentences;
    assert.deepEqual(sentences.map((s: Json) => s.notes), [[1, 2], [3]], 'numbered 1, 2, 3 with the receipt gone');
    assert.deepEqual(noted.json.doc.footnotes, [
      {
        n: 1, kind: 'code', verdict: 'verified', quote: 'claimTurn(', path: 'src/runner/loop.ts', lineStart: 10, lineEnd: 12,
        section: null, symbol: 'RunLoop.claim', excerpt: 'function claim() {\n  claimTurn(next);\n}', seq: null, at: null, label: null, notePath: null,
      },
      {
        n: 2, kind: 'turn', verdict: 'verified', quote: 'claim the next turn', path: null, lineStart: null, lineEnd: null,
        section: null, symbol: null, excerpt: null, seq: 4, at: '2026-09-30T08:00:00.000Z', label: 'user', notePath: null,
      },
      {
        n: 3, kind: 'task_comment', verdict: 'verified', quote: 'it retries', path: null, lineStart: null, lineEnd: null,
        section: null, symbol: null, excerpt: null, seq: null, at: '2026-09-30T09:00:00.000Z', label: 'USER', notePath: null,
      },
    ]);
    assertPrivateStaysOut(noted, 'a document with Footnotes');

    const deploy = await visit(token, '/docs/deploy');
    assert.equal(deploy.status, 200, deploy.text);
    assert.deepEqual(deploy.json.doc.footnotes.map((f: Json) => [f.n, f.kind, f.path, f.section]), [[1, 'design_doc', 'docs/deploy.md', 'Steps']]);
    assertPrivateStaysOut(deploy, 'the second document');
    // The root page says which layers are on, and nothing more.
    assert.deepEqual((await visit(token)).json.include, { footnotes: true });
  });

  await t.test('(4) what the link does not open is the dead link\'s 404', async () => {
    const dead = await visit(randomBytes(24).toString('base64url'));
    assert.equal(dead.status, 404);
    for (const rest of [
      '/docs/storage', // in the plan, not written
      '/docs/no-such-doc',
      '/docs/..%2F..%2Fspaces',
      '/events',
      `/events/1`,
      `/tasks/${pub(taskId)}`,
      `/sessions/${pub(sessionId)}`,
      `/sessions/${pub(sessionId)}/events`,
      `/attachments/${pub(randomUUID())}`,
      '/artifacts?path=x',
    ]) {
      const answer = await visit(token, rest);
      assert.equal(answer.status, 404, `${rest}: ${answer.text}`);
      assert.deepEqual(answer.body, dead.body, `${rest}: not the dead link's answer`);
    }
    // And a document page on another kind of link.
    const project = await db.project.create({ data: { ownerId, title: `docs ${RUN}` } });
    const projectToken = (await owner('PUT', `/projects/${pub(project.id)}/share`, {})).json.token as string;
    const onProject = await visit(projectToken, '/docs/session-runtime');
    assert.equal(onProject.status, 404);
    assert.deepEqual(onProject.body, dead.body);
  });

  await t.test('(5) the owner\'s list names a wiki link only to a client that asks for the kind', async () => {
    const kinds = async (query: string) => ((await owner('GET', `/share-links${query}`)).json.links as Json[]).map((link) => link.kind);
    assert.ok(!(await kinds('')).includes('WIKI'), 'a shipped client was handed a kind it cannot decode');
    assert.ok((await kinds('')).includes('PROJECT'));
    const all = (await owner('GET', '/share-links?kind=SESSION,TASK,PROJECT,WIKI')).json.links as Json[];
    const wiki = all.find((link) => link.kind === 'WIKI');
    assert.ok(wiki, 'asked for, the wiki link is listed');
    assert.equal(wiki.token, token);
    assert.deepEqual(wiki.root, { id: pub(spaceId), publicId: pub(spaceId), title: 'orbit', slug: `orbit-${RUN}` });
    assert.deepEqual(wiki.include, { footnotes: true });
    assert.deepEqual([...new Set(await kinds('?kind=WIKI'))], ['WIKI']);
    assert.deepEqual([...new Set(await kinds('?kind=WIKI&kind=PROJECT'))].sort(), ['PROJECT', 'WIKI']);
    // A kind this server does not know is passed over.
    assert.deepEqual(await kinds('?kind=NOT_A_KIND'), []);
    assert.deepEqual([...new Set(await kinds('?kind=WIKI,NOT_A_KIND'))], ['WIKI']);
  });

  await t.test('(6) another account can neither read nor change it', async () => {
    for (const [method, body] of [['GET', undefined], ['PUT', {}], ['PUT', { include: { footnotes: false } }], ['DELETE', undefined]] as const) {
      const answer = await other(method, at, body);
      assert.equal(answer.status, 404, `${method}: ${answer.text}`);
    }
    const [row] = await rows(spaceId);
    assert.equal(row.revoked_at, null);
    assert.deepEqual(row.include, { footnotes: true });
    // Nor open a link on its own space for the owner's: its own space is its own.
    const mine = await other('PUT', `/wiki/spaces/${pub(otherSpaceId)}/share`, {});
    assert.equal(mine.status, 200, mine.text);
    assert.equal(mine.json.root.title, `Space other-${RUN}`, 'a space with no repository is named by its title');
    assert.equal((await owner('GET', `/wiki/spaces/${pub(otherSpaceId)}/share`)).status, 404);
    assert.equal((await other('DELETE', `/share-links/${pub((await rows(spaceId))[0].id as string)}`)).status, 404);
    assert.equal((await rows(spaceId))[0].revoked_at, null);
  });

  await t.test('(7) with the wiki off for the owner: the wiki\'s 404 on the owner\'s routes, the dead link\'s in public', async () => {
    const dead = await visit(randomBytes(24).toString('base64url'));
    process.env.ORBIT_WIKI = 'off';
    try {
      const read = await owner('GET', at);
      assert.equal(read.status, 404, read.text);
      assert.equal(read.json.code, 'WIKI_DISABLED');
      assert.equal((await owner('PUT', at, {})).json.code, 'WIKI_DISABLED');
      for (const rest of ['', '/docs/session-runtime']) {
        const answer = await visit(token, rest);
        assert.equal(answer.status, 404, rest);
        assert.deepEqual(answer.body, dead.body, `${rest}: not the dead link's answer`);
      }
      assert.equal((await rows(spaceId))[0].revoked_at, null, 'switching the wiki off ended the link');
    } finally {
      delete process.env.ORBIT_WIKI;
    }
    assert.equal((await visit(token)).status, 200, 'switched back on, the link opens again');
  });

  await t.test('(8) off ends the token for good; deleting the space deletes its links', async () => {
    assert.equal((await owner('DELETE', at)).status, 200);
    assert.equal((await visit(token)).status, 404);
    assert.equal((await visit(token, '/docs/deploy')).status, 404);
    const [ended] = await rows(spaceId);
    assert.equal(ended.revoked_reason, 'TURNED_OFF');
    const again = await owner('PUT', at, {});
    assert.notEqual(again.json.token, token);
    assert.deepEqual(again.json.include, { footnotes: false }, 'a new link starts from the defaults');
    assert.equal((await visit(again.json.token)).status, 200);
    assert.equal((await rows(spaceId)).length, 2);

    await db.wikiSpace.delete({ where: { id: spaceId } });
    assert.deepEqual(await rows(spaceId), [], 'a deleted space left its links behind');
    assert.equal((await visit(again.json.token)).status, 404);
  });

  await t.test('(9) one root of four, a space of the link\'s own owner, one open link per space', async () => {
    const project = await db.project.create({ data: { ownerId: otherId, title: `two roots ${RUN}` } });
    assert.deepEqual(
      await refusal(sql, `INSERT INTO share_link (id, owner_id, token, project_id, wiki_space_id) VALUES (gen_random_uuid(), $1, $2, $3, $4)`,
        [otherId, randomBytes(24).toString('base64url'), project.id, otherSpaceId]),
      { code: '23514', constraint: 'share_link_one_root_chk' },
    );
    // Another account's space — one with no link, so no other refusal comes first — under the owner:
    // the composite key refuses it.
    const unshared = await space(otherId, `unshared-${RUN}`);
    assert.deepEqual(
      await refusal(sql, `INSERT INTO share_link (id, owner_id, token, wiki_space_id) VALUES (gen_random_uuid(), $1, $2, $3)`,
        [ownerId, randomBytes(24).toString('base64url'), unshared]),
      { code: '23503', constraint: 'share_link_wiki_space_fkey' },
    );
    // The other account already has its space's link open (6): a second open one is refused.
    assert.deepEqual(
      await refusal(sql, `INSERT INTO share_link (id, owner_id, token, wiki_space_id) VALUES (gen_random_uuid(), $1, $2, $3)`,
        [otherId, randomBytes(24).toString('base64url'), otherSpaceId]),
      { code: '23505', constraint: 'share_link_wiki_space_active_key' },
    );
  });
});
