/**
 * A wiki chat's plan card of several documents, and its Undo (contracts/wiki.contract.json
 * `agentSurface.chat.draft.params.change`, `chat.drafts.read`, `chat.presses.apply`, `chat.presses.undo`,
 * `docs.versions.kept`; docs/wiki-contract.md §11, §28.5–§28.8, §30; design docs/wiki-chat-design.md §6's third row and
 * §7.3; board 42 ③; wiki chat project task C17), held against the production apiserver — `build/main.js`, the whole
 * AppModule — over a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty, with the wiki-worker's docs_build
 * job run in this process against a System model a local http server plays and the space's runner played here, as
 * wiki-chat-plan-card.pg.spec.ts (C12) plays them:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/wiki/wiki-chat-plan-split.pg.spec.ts
 *
 * One account, one machine, one space whose plan (version 1: a document of three sections, and a protected one) the
 * owner confirmed and the worker built. In order:
 *
 *   1. a split — a section moved out of 1.1 into a new document, and 1.1 written for a first-time reader — is one card:
 *      the plan the two documents make is gated once, and a change where both documents fail answers every error of
 *      both, and makes no card;
 *   2. a press whose second document the gate refuses — the projects its sections name are gone — writes nothing: no
 *      version, no confirmation, no build, no press, every error listed;
 *   3. one press stores a version of the owner's, confirms it and has it built: both documents' sections are written —
 *      the changed one again, the moved one in its new document — and the section that left 1.1 is kept as a version;
 *   4. Undo puts the plan back as a new confirmed version with version 1's content, and the sections the rebuild wrote
 *      or dropped back as they were — sentences and fingerprints — with no model asked and restore versions kept; the
 *      build that follows leaves every one of them as it is;
 *   5. once the plan moved on from a card's version, its Undo is refused and writes nothing.
 *
 * Not destructive: every row belongs to the account this run creates.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

import { toUuid, uuidToBase62, WIKI_REPO_OP_CAPABILITY, WIKI_REPO_OP_READ_CAPABILITY, WIKI_REPO_OPS } from '@orbit/shared';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { hashPassword } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import type { PushService } from '../push/push.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { wikiDocsBuildJobRunner } from '../wiki-worker/wiki-docs-build-job';
import { WikiJobExecutor } from '../wiki-worker/wiki-job-executor';
import { WikiModelRequestQueue } from '../wiki-worker/wiki-model-queue.service';
import { WikiModelStatusProbe } from '../wiki-worker/wiki-model-status';
import { WikiRepoOps } from '../wiki-worker/wiki-repo-ops';
import { readWikiSystemModel } from '../wiki-worker/wiki-system-model';
import { appendWikiChatNotes } from './wiki-chat-notes';
import { WikiDocs } from './wiki-docs';
import { WikiService } from './wiki.service';
import '../test-support/daemon-routes-over-http';

const URL_ = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const REPO_URL = `https://github.com/example/plan-split-${RUN}`;
const ENGINES = [{ engine: 'claude', installed: true, auth: 'yes', version: '2.3.0' }];
const CAPABILITIES = ['source-pin/v1', WIKI_REPO_OP_CAPABILITY, WIKI_REPO_OP_READ_CAPABILITY].join(',');
const KEY = `sk-spec-${randomUUID()}`;
const MODEL = 'qwen3.8-27b-fp8';
const SLUG = 'sessions-runtime';
/** The owner's writing requirement, which the agent puts on the section's covers (design §6, third row). */
const FIRST_TIME = 'for a first-time reader';
const NEW_COVERS = `How a turn is stored and delivered, ${FIRST_TIME}: the model first, then the numbers.`;
const WORDS = '1.1 is too long: give recovery a document of its own, and write the rest for a first-time reader.';

// ── the repository, the System model, the runner ────────────────────────────────────────────────────

const DESIGN = '# Design\n\n## 1. Transport\n\nThe runner polls the server over outbound HTTP; no inbound port is needed.\n\n'
  + '## 2. Delivery\n\nA turn is stored before it is delivered, and delivered at least once.\nDelivery is idempotent on the turn\'s id.\n\n'
  + '## 3. Recovery\n\nSeq stays monotonic across respawn.\nA respawned runner resumes from the last acknowledged turn.\n';
const RUNLOOP = 'package main\n\n// runLoop claims work from the server and keeps the heartbeat going.\n// It never opens an inbound port.\n'
  + 'func runLoop() {\n\tfor {\n\t\tclaim()\n\t}\n}\n';
const CONTRACT = '{\n  "name": "session",\n  "delivery": "at least once, idempotent on the turn id"\n}\n';
const FILES: Record<string, string> = { 'docs/design.md': DESIGN, 'src/runloop.go': RUNLOOP, 'contracts/session.contract.json': CONTRACT, 'README.md': 'An app.\n' };

/**
 * A writer that cites what it was handed (wiki-docs-build-job.pg.spec.ts's): every piece adopted, every material cited in
 * a sentence of its own with a verbatim quote — and, writing a section whose covers ask for a first-time reader, one
 * sentence more saying so, so a rewrite from the new covers reads differently from the one before.
 */
function writerAnswer(prompt: string): string {
  if (prompt.includes('the "merge"')) {
    const ids = [...prompt.matchAll(/^\[([A-Z]\d+)\] /gmu)].map(([, id]) => id);
    return `${ids.map((id) => `${id} | adopt | it is just what this section covers`).join('\n')}\nCurrent state:\n- the point of this section [${ids[0] ?? 'D1'}]\n`;
  }
  if (prompt.includes('(the overview, about')) return '### Overview\nThis document covers how a session runs[F1].\n';
  if (prompt.includes('give the footnotes below their verbatim quotes')) return '';
  if (!prompt.includes('# Task: write the document')) return '?';
  const materials = prompt.split('## The materials you may use (cite only these, by the ids they have)\n')[1]?.split('\n\n## How to write')[0] ?? '';
  const sentences: string[] = [];
  const quotes: string[] = [];
  for (const block of materials.split(/\n(?=\[[A-Z]\d+\] )/u)) {
    const id = /^\[([A-Z]\d+)\] /u.exec(block)?.[1];
    if (!id) continue;
    const line = block.split('\n').slice(1).map((one) => one.trim()).find((one) => one.length >= 10 && !one.startsWith('```'));
    sentences.push(`This section rests on ${id} in one sentence[${id}]. `);
    if (line) quotes.push(`[${id}] "${Array.from(line).slice(0, 60).join('')}"`);
  }
  if (sentences.length === 0) return '### Boundaries\nThis document covers only how a session runs.\n';
  // Only the section whose covers ask for it is written while they do: every other one's fingerprint stands.
  const first = /\[([A-Z]\d+)\]/u.exec(sentences[0]!)?.[1];
  if (prompt.includes(FIRST_TIME) && first) sentences.push(`It is written for a first-time reader[${first}]. `);
  return `### This section\n${sentences.join('').trim()}\n\nQuotes:\n${quotes.join('\n')}\n`;
}

interface FakeModel {
  base: string;
  prompts: string[];
  close: () => Promise<void>;
}

async function fakeModel(): Promise<FakeModel> {
  const sockets = new Set<Socket>();
  const model = { base: '', prompts: [] as string[] } as unknown as FakeModel;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let raw = '';
    request.on('data', (chunk: Buffer) => {
      raw += chunk.toString();
    });
    request.on('end', () => {
      if (request.url === '/health') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
        return;
      }
      const body = JSON.parse(raw) as { messages?: Array<{ content?: string }> };
      const prompt = body.messages?.[0]?.content ?? '';
      model.prompts.push(prompt);
      const text = writerAnswer(prompt);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
      response.write(event('message_start', { type: 'message_start', message: { model: MODEL, usage: { input_tokens: 100, output_tokens: 1 } } }));
      response.write(event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }));
      response.write(event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } }));
      response.write(event('message_stop', { type: 'message_stop' }));
      response.end();
    });
  });
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  model.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  model.close = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return model;
}

/** One `read` item as src/runner-go/wiki_repo_ops.go answers it: the whole file, up to the file cap. */
function readOne(item: { path: string }): Record<string, unknown> {
  if (!(item.path in FILES)) return { path: item.path, found: false, chars: 0 };
  const text = FILES[item.path]!;
  const size = Buffer.byteLength(text, 'utf8');
  if (size > WIKI_REPO_OPS.wholeFileBytes) return { path: item.path, found: false, reason: 'too_large', size, chars: 0 };
  return { path: item.path, found: true, size, text, truncated: false, chars: Array.from(text).length };
}

test('a plan card of two documents: a split gated as one edit, one press, its rebuild, and Undo with no model asked', { skip: !URL_, concurrency: 1, timeout: 900_000 }, async (t) => {
  const url = URL_!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma: PrismaClient = prismaClientFor(url);
  const db = prisma as unknown as PrismaService;
  const model = await fakeModel();
  let server: Apiserver | undefined;
  let running = true;
  let runnerLoop: Promise<void> = Promise.resolve();
  const workers: Array<{ queue: WikiModelRequestQueue; executor: WikiJobExecutor }> = [];
  t.after(async () => {
    running = false;
    await runnerLoop.catch(() => undefined);
    for (const one of workers) {
      await one.executor.onModuleDestroy().catch(() => undefined);
      await one.queue.onModuleDestroy().catch(() => undefined);
    }
    await sql.query('DELETE FROM "wiki_model_status"').catch(() => undefined);
    await server?.stop();
    await model.close().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  // ── the account, the machine, the space ───────────────────────────────────────────────────────────────────────────
  const ownerId = randomUUID();
  const password = `pw-owner-${RUN}`;
  const email = `owner-${RUN}@wiki-plan-split.invalid`;
  await sql.query(`INSERT INTO "user" (id, email, name, password_hash, role) VALUES ($1, $2, 'owner', $3, 'MEMBER')`, [ownerId, email, hashPassword(password)]);
  server = await startApiserver(url, `wiki-plan-split-${randomUUID()}`);
  const api = (method: string, route: string, bearer?: string, body?: unknown, headers?: Record<string, string>): Promise<Reply> =>
    call(server!, method, route, bearer, body, headers);
  const login = await api('POST', '/api/auth/login', undefined, { email, password });
  assert.equal(login.status, 201, login.text);
  const ownerToken = login.json.accessToken as string;
  const minted = await api('POST', '/api/runners/enrollment-tokens', ownerToken, { label: `plan split ${RUN}` });
  assert.equal(minted.status, 201, minted.text);
  const registered = await api('POST', '/api/runner/register', undefined, { enrollmentToken: minted.json.token, name: `hpc-${RUN}`, hostname: `hpc-${RUN}` });
  assert.equal(registered.status, 201, registered.text);
  const hpc = { runnerId: toUuid(registered.json.runnerId), token: registered.json.runnerToken as string };
  // One beat, now: the repository operations the builds make are claimed by the runner played below, never by a beat.
  const beat = await api('POST', '/api/runner/heartbeat', hpc.token, { status: 'ONLINE', engines: ENGINES }, { 'x-orbit-runner-capabilities': CAPABILITIES });
  assert.equal(beat.status < 300, true, beat.text);
  const workspaceId = randomUUID();
  await sql.query(
    `INSERT INTO "workspace" (id, name, owner_id, runner_id, work_dir, repo_url, enable_worktree) VALUES ($1, 'orbit-develop', $2, $3, '/srv/orbit-develop', $4, true)`,
    [workspaceId, ownerId, hpc.runnerId, REPO_URL],
  );
  const pub = (id: string) => uuidToBase62(id);
  const made = await api('POST', '/api/wiki/spaces', ownerToken, { title: `Orbit ${RUN}`, repoUrl: REPO_URL });
  assert.equal(made.status, 201, made.text);
  const spaceId = toUuid(made.json.id);
  // The build reads the repository through the maintenance workspace's runner: the maintenance names it (and stays off).
  const settings = await api('PATCH', `/api/wiki/spaces/${pub(spaceId)}`, ownerToken, { maintenance: { enabled: false, workspaceId: pub(workspaceId) } });
  assert.equal(settings.status, 200, settings.text);

  // ── the plan, version 1: one document of three sections and a protected one; confirmed through the plan's door ──────
  const sources = (over: Record<string, unknown>) => ({ docs: [], code: [], contracts: [], sessions: null, ...over });
  const planId = randomUUID();
  await prisma.wikiPlan.create({
    data: {
      id: planId, spaceId, ownerId, version: 1, status: 'draft', origin: 'owner', authorUserId: ownerId, docsMin: 1, docsMax: 10, gate: {},
      categories: [{ key: 'runtime', title: 'Runtime', question: 'How does it run?', forAgents: false, extra: {} }],
    },
  });
  const docRow = async (position: number, doc: Record<string, unknown>, sections: Array<Record<string, unknown>>) => {
    const row = await prisma.wikiPlanDoc.create({
      data: {
        planId, ownerId, position, category: 'runtime', slug: doc.slug as string, title: doc.title as string, question: doc.question as string,
        audience: doc.audience as string[], scopeIn: doc.scopeIn as string[], scopeOut: [] as never, lengthMin: 100, lengthMax: 4000,
        protected: doc.protected === true,
      },
    });
    for (const [i, section] of sections.entries()) {
      await prisma.wikiPlanSection.create({ data: { docId: row.id, ownerId, position: i, ...section } as never });
    }
  };
  await docRow(0, { slug: SLUG, title: 'Sessions runtime', question: 'How does a session run?', audience: ['A new contributor'], scopeIn: ['Turns'] }, [
    { key: 'turn-delivery', title: 'Turn delivery', kind: 'flow', covers: 'How a turn is stored and delivered.', length: 400,
      sources: sources({ docs: [{ path: 'docs/design.md', section: '2. Delivery' }], code: [{ path: 'src/runloop.go', symbols: ['runLoop'] }] }) },
    { key: 'recovery', title: 'Recovery', kind: 'concepts', covers: 'What survives a respawn.', length: 300,
      sources: sources({ docs: [{ path: 'docs/design.md', section: '3. Recovery' }] }) },
    { key: 'contract', title: 'The session contract', kind: 'interface', covers: 'What the session contract says.', length: 300,
      sources: sources({ contracts: [{ path: 'contracts/session.contract.json' }] }) },
  ]);
  await docRow(1, { slug: 'runbooks', title: 'Runbooks', question: 'How is it run by hand?', audience: ['An operator'], scopeIn: ['Restarts'], protected: true }, [
    { key: 'restart', title: 'Restarting', kind: 'ops', covers: 'How the runner is restarted.', length: 200, sources: sources({ docs: [{ path: 'docs/design.md', section: '1. Transport' }] }) },
  ]);
  const confirmed = await api('POST', `/api/wiki/spaces/${pub(spaceId)}/plan/versions/1/confirm`, ownerToken);
  assert.equal(confirmed.status, 200, confirmed.text);

  // ── the worker and the runner, in this process ────────────────────────────────────────────────────────────────────
  const quiet = { publishWikiChanged: () => undefined, publishForUser: () => undefined } as unknown as RealtimeService;
  const push = { notifyWikiReviewModeTripped: async () => undefined, notifyWikiVerificationTripped: async () => undefined } as unknown as PushService;
  const service = new WikiService(db, quiet, push);
  const docs = new WikiDocs(db, service, quiet);
  const config = readWikiSystemModel({ ORBIT_WIKI_MODEL_BASE_URL: model.base, ORBIT_WIKI_MODEL_API_KEY: KEY, ORBIT_WIKI_MODEL: MODEL, ORBIT_WIKI_MODEL_CONCURRENCY: '4' });
  await sql.query('DELETE FROM "wiki_model_status"');
  await new WikiModelStatusProbe(db, config).check();
  const options = { leaseMs: 2_000, renewMs: 300, partialMs: 40, pollMs: 25 };
  const queue = new WikiModelRequestQueue(db, config, new WikiModelStatusProbe(db, config), undefined, options);
  const executor = new WikiJobExecutor(db, queue, options, {
    docs_build: wikiDocsBuildJobRunner({ prisma: db, docs, wiki: service, repoOps: new WikiRepoOps(db), model: MODEL, repoWaitMs: 15_000 }),
  });
  workers.push({ queue, executor });
  const SHA = createHash('sha1').update(`head-${RUN}`).digest('hex');
  const ops = new WikiRepoOps(db);
  runnerLoop = (async () => {
    while (running) {
      const claimed = await ops.dispatch({ runnerId: hpc.runnerId, leaseOwner: randomUUID(), draining: false, capabilities: [WIKI_REPO_OP_CAPABILITY, WIKI_REPO_OP_READ_CAPABILITY] }).catch(() => []);
      for (const op of claimed) {
        let result: Record<string, unknown>;
        if (op.kind === 'snapshot') {
          const held = await prisma.wikiRepoSnapshot.findFirst({ where: { sha: SHA }, select: { sha: true } });
          result = op.input.skipSha === SHA && held
            ? { sha: SHA, skipped: true }
            : { sha: SHA, index: JSON.stringify({ sha: SHA, files: Object.entries(FILES).map(([path, text]) => ({ path, size: Buffer.byteLength(text) })), commits: [SHA] }) };
        } else {
          const items = ((op.input.items as Array<{ path: string }>) ?? []).map(readOne);
          result = { read: { sha: op.input.sha, items, chars: items.reduce((sum, one) => sum + (one.chars as number), 0) } };
        }
        await ops.applyWikiRepoOpResult({ id: op.id, runnerId: hpc.runnerId, body: { claimGeneration: op.claimGeneration, leaseOwner: op.leaseOwner, state: 'succeeded', result } });
      }
      await delay(15);
    }
  })();
  /** The newest build of a version, and its docs_build job. */
  const buildOf = async (version: number) => (await sql.query(
    `SELECT p."id"::text AS "id", p."state", p."outcome", p."job_id"::text AS "jobId", j."state" AS "jobState", j."report" AS "report"
       FROM "wiki_plan_job" p LEFT JOIN "wiki_job" j ON j."id" = p."job_id"
      WHERE p."space_id" = $1::uuid AND p."kind" = 'build' AND p."version" = $2 ORDER BY p."created_at" DESC, p."id" DESC LIMIT 1`,
    [spaceId, version])).rows[0] as { id: string; state: string; outcome: string | null; jobId: string | null; jobState: string | null; report: any } | undefined;
  /** Passes of the worker until the build of `version` ended, the runner beating meanwhile. */
  const build = async (version: number) => {
    const deadline = Date.now() + 120_000;
    for (;;) {
      await sql.query(`UPDATE "runner" SET "last_heartbeat_at" = now() WHERE "id" = $1::uuid`, [hpc.runnerId]);
      await executor.runOnce();
      await queue.runOnce();
      const row = await buildOf(version);
      if (row?.state === 'ended') break;
      assert.ok(Date.now() < deadline, `the build of version ${version} ended within 120s: ${JSON.stringify(row)}`);
      await delay(25);
    }
    await executor.whenIdle();
    return (await buildOf(version))!;
  };
  const sectionRows = async () => (await sql.query(
    `SELECT s."key", s."material_sha256" AS "sha" FROM "wiki_doc_section" s JOIN "wiki_doc" d ON d."id" = s."doc_id"
      WHERE d."space_id" = $1::uuid AND d."slug" = $2 ORDER BY s."key"`, [spaceId, SLUG])).rows as Array<{ key: string; sha: string }>;
  const sentencesOf = async (key: string) => (await sql.query(
    `SELECT se."text" FROM "wiki_doc_sentence" se JOIN "wiki_doc_section" s ON s."id" = se."section_id" JOIN "wiki_doc" d ON d."id" = s."doc_id"
      WHERE d."space_id" = $1::uuid AND d."slug" = $2 AND s."key" = $3 ORDER BY se."position"`, [spaceId, SLUG, key])).rows.map((row) => row.text as string);

  const v1 = await build(1);
  assert.deepEqual([v1.outcome, v1.jobState], ['succeeded', 'succeeded'], JSON.stringify(v1));
  const writtenV1 = await sectionRows();
  assert.deepEqual(writtenV1.map((row) => row.key), ['contract', 'recovery', 'turn-delivery'], 'version 1 is written, every section from its fingerprint');
  const before = new Map(writtenV1.map((row) => [row.key, row.sha]));
  const sentencesV1 = new Map<string, string[]>();
  for (const key of ['turn-delivery', 'recovery', 'contract']) sentencesV1.set(key, await sentencesOf(key));
  assert.ok(sentencesV1.get('recovery')!.length > 0 && !sentencesV1.get('turn-delivery')!.some((text) => text.includes('first-time reader')));

  // ── the chat, and the plan page's definition of the document ──────────────────────────────────────────────────
  const planPage = { page: { kind: 'plan', docSlug: SLUG, sectionKey: 'recovery' } };
  const chatMade = await api('POST', `/api/wiki/spaces/${pub(spaceId)}/chats`, ownerToken,
    { workspaceId: pub(workspaceId), content: WORDS, clientTurnId: randomUUID(), wikiContext: planPage });
  assert.equal(chatMade.status, 201, chatMade.text);
  const chat = toUuid(chatMade.json.sessionId);
  const asChat = { 'x-orbit-session-id': pub(chat) };
  const draft = (body: Record<string, unknown>) => api('POST', '/api/runner/wiki/drafts', hpc.token, body, asChat);
  const card = (id: string) => api('GET', `/api/wiki/chat-drafts/${pub(id)}`, ownerToken);
  const press = (id: string, what: string, headers?: Record<string, string>) => api('POST', `/api/wiki/chat-drafts/${pub(id)}/${what}`, ownerToken, {}, headers);
  const count = async (query: string, values: unknown[] = []) => Number((await sql.query(query, values)).rows[0].n);
  const planWrites = async () => ({
    versions: await count(`SELECT count(*)::int AS n FROM "wiki_plan" WHERE "space_id" = $1::uuid`, [spaceId]),
    confirmed: (await sql.query(`SELECT "version" FROM "wiki_plan" WHERE "space_id" = $1::uuid AND "status" = 'confirmed'`, [spaceId])).rows.map((row) => row.version),
    builds: await count(`SELECT count(*)::int AS n FROM "wiki_plan_job" WHERE "space_id" = $1::uuid AND "kind" = 'build'`, [spaceId]),
    buildJobs: await count(`SELECT count(*)::int AS n FROM "wiki_job" WHERE "space_id" = $1::uuid AND "kind" = 'docs_build'`, [spaceId]),
    docSections: await count(`SELECT count(*)::int AS n FROM "wiki_doc_section_version" WHERE "space_id" = $1::uuid`, [spaceId]),
  });
  const draftRow = async (id: string) => (await sql.query(`SELECT * FROM "wiki_chat_draft" WHERE "id" = $1::uuid`, [id])).rows[0];
  const delivered = await prisma.$transaction(async (tx) => appendWikiChatNotes(tx as never, {
    ownerId, spaceId, sessionId: chat, turn: { seq: 1, kind: 'message', wikiContext: planPage },
  }, WORDS));
  const block = delivered!.split('\n\n').find((one) => one.startsWith('<orbit_wiki_page'))!;
  const definition = JSON.parse(block.split('\n').slice(1, -1).join('\n'));
  // The page tells the agent how one card changes several documents: the server's words, with no runner release (C17).
  assert.match(definition.howToChange, /as change\.docs the documents as they should read/u);
  assert.match(definition.howToChange, /To split this document, send it without the sections that move, and a new document/u);
  const pageDoc = definition.doc as { sections: Array<Record<string, any>> } & Record<string, any>;
  const sectionOf = (key: string) => pageDoc.sections.find((s) => s.key === key)!;

  // The split (board 42 ③): 1.1 lets go of its recovery section, which a new document takes; 1.1's delivery section is
  // written for a first-time reader — the requirement on its covers.
  const NEW_DOC = 'recovery-and-respawn';
  const staying = { ...pageDoc, sections: [{ ...sectionOf('turn-delivery'), covers: NEW_COVERS }, sectionOf('contract')] };
  const newDoc = (sections: Array<Record<string, unknown>>) => ({
    category: 'runtime', slug: NEW_DOC, title: 'Recovery and respawn', question: 'What survives a respawn, and how does a runner resume?',
    audience: ['A new contributor'], scopeIn: ['Respawn'], scopeOut: [], length: { min: 100, max: 4000 }, sections,
  });
  const split = { docs: [staying, newDoc([sectionOf('recovery')])] };
  const reason = 'The owner finds 1.1 too long: recovery goes to a document of its own, and 1.1 is written for a first-time reader.';

  // ── 1 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  let cardA = '';
  let cardB = '';
  const projects = [randomUUID(), randomUUID()];
  await t.test('1. a split is one card: the plan its two documents make is gated once, and every error of both is answered', async () => {
    const writes = await planWrites();
    // Both documents wrong at once — a section of no kind in 1.1, a topic the space has none of and no question in the new
    // one, and 1.1 named twice: every error of both, each where it is, and no card.
    const wrong = await draft({
      kind: 'plan', reason, idempotencyKey: `wrong-${RUN}`,
      change: {
        docs: [
          { ...staying, sections: [{ ...staying.sections[0], kind: 'essay' }, staying.sections[1]] },
          { ...newDoc([{ ...sectionOf('recovery'), sources: { sessions: { projects: [], keywords: ['respawn'], topics: ['made-up'] } } }]), question: '' },
          { ...staying, title: 'Twice' },
        ],
      },
    });
    assert.deepEqual([wrong.status, wrong.json.code], [422, 'WIKI_PLAN_GATE'], wrong.text);
    assert.deepEqual((wrong.json.errors as Array<{ check: string; path: string }>).map((e) => [e.check, e.path]).sort(), [
      ['references', 'change.docs[1].sections[0].sources.sessions.topics[0]'],
      ['schema', 'change.docs[0].sections[0].kind'],
      ['schema', 'change.docs[1].question'],
      ['schema', 'change.docs[2].slug'],
    ], 'every error of every document, at once');
    // The protected document stays as it is, whichever document of the change touches it.
    const plan = await api('GET', `/api/wiki/spaces/${pub(spaceId)}/plan`, ownerToken);
    const runbooks = plan.json.confirmed.docs.find((one: { slug: string }) => one.slug === 'runbooks');
    const guarded = await draft({
      kind: 'plan', reason, idempotencyKey: `guarded-${RUN}`,
      change: { docs: [staying, { category: 'runtime', slug: 'runbooks', title: 'Runbooks, by hand', question: runbooks.question, audience: runbooks.audience, scopeIn: runbooks.scopeIn,
        scopeOut: [], length: runbooks.length, sections: runbooks.sections.map((s: Record<string, any>) => ({ key: s.key, title: s.title, kind: s.kind, covers: s.covers, length: s.length, sources: { docs: s.sources.docs, code: s.sources.code, contracts: s.sources.contracts } })) }] },
    });
    assert.deepEqual([guarded.status, guarded.json.code, guarded.json.errors.map((e: { check: string }) => e.check)], [422, 'WIKI_PLAN_GATE', ['protected']], guarded.text);
    // A category opened with no document filed under it is no category to open.
    const empty = await draft({ kind: 'plan', reason, idempotencyKey: `empty-${RUN}`, change: { ...split, categories: [{ key: 'ops', title: 'Operations' }] } });
    assert.deepEqual([empty.status, empty.json.errors?.map((e: { path: string }) => e.path)], [422, ['change.categories[0]']], empty.text);
    assert.deepEqual(await planWrites(), writes, 'nothing of the plan was written by any of them');
    assert.equal(await count(`SELECT count(*)::int AS n FROM "wiki_chat_draft" WHERE "session_id" = $1::uuid`, [chat]), 0, 'and no card made');

    const drafted = await draft({ kind: 'plan', reason, change: split, idempotencyKey: `split-${RUN}` });
    assert.equal(drafted.status, 200, drafted.text);
    assert.deepEqual(drafted.json.rewrites.map((r: { doc: string; key: string; where: string }) => [r.doc, r.key, r.where]), [
      [SLUG, 'turn-delivery', '1.1 §1'], [NEW_DOC, 'recovery', '1.3 §1'],
    ], 'its press rewrites the changed section, and the moved one in the document that takes it');
    cardA = toUuid(drafted.json.draftId);
    assert.deepEqual(await planWrites(), writes, 'a card writes nothing of the plan');
    const row = await draftRow(cardA);
    assert.deepEqual([row.change.baseVersion, row.change.version, row.change.docs.map((d: { slug: string }) => d.slug), row.change.categories],
      [1, null, [SLUG, NEW_DOC], []], 'the card keeps both documents as gated, and the version it was drafted on');
    assert.deepEqual(row.sections, [{ doc: SLUG, key: 'turn-delivery' }, { doc: NEW_DOC, key: 'recovery' }]);
    const read = await card(cardA);
    assert.equal(read.status, 200, read.text);
    assert.deepEqual([read.json.state, read.json.label, read.json.undoable], ['draft', 'Plan change', false]);
    assert.deepEqual(read.json.change, {
      baseVersion: 1, version: null,
      docs: [
        { slug: SLUG, title: 'Sessions runtime', number: '1.1', added: false, category: { key: 'runtime', title: 'Runtime', opens: false }, fields: [],
          sections: [{ key: 'turn-delivery', title: 'Turn delivery', number: 1, edit: 'changed', fields: ['covers'], covers: NEW_COVERS }] },
        { slug: NEW_DOC, title: 'Recovery and respawn', number: '1.3', added: true, category: { key: 'runtime', title: 'Runtime', opens: false }, fields: [], sections: [] },
      ],
      moves: [{ title: 'Recovery', from: { doc: SLUG, number: '1.1', key: 'recovery', section: 2 }, to: { doc: NEW_DOC, number: '1.3', key: 'recovery', section: 1 }, fields: [], covers: null }],
    }, 'the card says it document by document: the move, the covers, the new document numbered where it goes');
    assert.deepEqual(read.json.rewrites.map((r: { where: string; title: string }) => [r.where, r.title]), [['1.1 §1', 'Turn delivery'], ['1.3 §1', 'Recovery']]);

    // Card B: the same split, but the new document's two sections name projects in their session conditions.
    for (const [i, id] of projects.entries()) {
      await sql.query(`INSERT INTO "project" ("id", "title", "owner_id", "updated_at") VALUES ($1, $2, $3, now())`, [id, `Runner hosting ${i}`, ownerId]);
    }
    const named = (i: number) => ({ ...sectionOf('recovery'), ...(i === 1 ? { key: 'resume', title: 'Resuming' } : {}),
      sources: { docs: [{ path: 'docs/design.md', section: '3. Recovery' }], sessions: { projects: [pub(projects[i]!)], keywords: ['respawn'] } } });
    const second = await draft({ kind: 'plan', reason: 'Recovery on its own, with what the projects decided.', change: { docs: [staying, newDoc([named(0), named(1)])] }, idempotencyKey: `split-b-${RUN}` });
    assert.equal(second.status, 200, second.text);
    cardB = toUuid(second.json.draftId);
  });

  // ── 2 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  await t.test('2. a press whose second document the gate refuses writes nothing — no version, no confirmation, no build, no press — and lists every error', async () => {
    for (const id of projects) await sql.query(`DELETE FROM "project" WHERE "id" = $1::uuid`, [id]);
    const writes = await planWrites();
    const pressed = await press(cardB, 'apply');
    assert.deepEqual([pressed.status, pressed.json.code], [422, 'WIKI_PLAN_GATE'], pressed.text);
    assert.match(pressed.json.message, /did not pass the plan's gate \(references\): 2 errors/u);
    assert.deepEqual(pressed.json.errors.map((e: { path: string }) => e.path), [
      'change.docs[1].sections[0].sources.sessions.projects[0]', 'change.docs[1].sections[1].sources.sessions.projects[0]',
    ], 'each error, where it is in the document that failed');
    assert.deepEqual(await planWrites(), writes, 'the plan stands as it was, and no build was asked for');
    const row = await draftRow(cardB);
    assert.deepEqual([row.decision, row.decided_at, row.change.version], [null, null, null], 'and the card was not pressed');
    assert.equal((await card(cardB)).json.state, 'draft');
  });

  // ── 3 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  let built: Awaited<ReturnType<typeof build>> | undefined;
  await t.test('3. one press stores a version of the owner\'s, confirms it and rebuilds both documents', async () => {
    const writes = await planWrites();
    const pressed = await press(cardA, 'apply');
    assert.equal(pressed.status, 200, pressed.text);
    assert.deepEqual([pressed.json.draft.state, pressed.json.draft.change.version, pressed.json.draft.undoable], ['applied', 2, true], 'applied, and undoable while the plan stands there');
    const versions = (await sql.query(
      `SELECT "version", "status", "origin", "base_version" AS "base" FROM "wiki_plan" WHERE "space_id" = $1::uuid ORDER BY "version"`, [spaceId])).rows;
    assert.deepEqual(versions, [
      { version: 1, status: 'superseded', origin: 'owner', base: null },
      { version: 2, status: 'confirmed', origin: 'owner', base: 1 },
    ], 'one version of the owner\'s, made from the one the card was drafted on, and confirmed');
    const plan = await api('GET', `/api/wiki/spaces/${pub(spaceId)}/plan`, ownerToken);
    assert.deepEqual(plan.json.confirmed.docs.map((doc: { slug: string; sections: Array<{ key: string; covers: string }> }) => [doc.slug, doc.sections.map((s) => s.key)]), [
      [SLUG, ['turn-delivery', 'contract']], ['runbooks', ['restart']], [NEW_DOC, ['recovery']],
    ], 'both documents changed in one version: the section left 1.1 and is in the new document, after the category\'s last');
    const asked = await buildOf(2);
    assert.ok(asked && asked.state === 'made' && asked.jobId, `the build of version 2 was asked for: ${JSON.stringify(asked)}`);
    assert.deepEqual([(await planWrites()).versions, (await planWrites()).builds], [writes.versions + 1, writes.builds + 1]);
    assert.equal((await card(cardB)).json.state, 'changed', 'card B was drafted on version 1');

    const calls = model.prompts.length;
    built = await build(2);
    assert.deepEqual([built.outcome, built.jobState], ['succeeded', 'succeeded'], JSON.stringify(built));
    const reported = new Map((built.report.docs as Array<{ slug: string; sections: Array<{ key: string; outcome: string }> }>).map((doc) => [doc.slug, doc.sections.map((s) => [s.key, s.outcome])]));
    assert.deepEqual(reported.get(SLUG), [['turn-delivery', 'written'], ['contract', 'unchanged']], 'in 1.1, the section whose covers changed is written again');
    assert.deepEqual(reported.get(NEW_DOC), [['recovery', 'written']], 'and the new document is written, the moved section in it');
    assert.ok(model.prompts.slice(calls).some((prompt) => prompt.includes('# Task: write the document') && prompt.includes(NEW_COVERS)), 'the writer was handed the new covers');
    const turn = await sentencesOf('turn-delivery');
    assert.ok(turn.some((text) => text.includes('first-time reader')), `1.1's section written from the requirement: ${turn.join(' | ')}`);
    const moved = (await sql.query(
      `SELECT se."text" FROM "wiki_doc_sentence" se JOIN "wiki_doc_section" s ON s."id" = se."section_id" JOIN "wiki_doc" d ON d."id" = s."doc_id"
        WHERE d."space_id" = $1::uuid AND d."slug" = $2 AND s."key" = 'recovery'`, [spaceId, NEW_DOC])).rows;
    assert.ok(moved.length > 0, 'the moved section is written in its new document');
    assert.deepEqual((await sectionRows()).map((row) => row.key), ['contract', 'turn-delivery'], '1.1 no longer holds the section that left it');
    const kept = (await sql.query(
      `SELECT "doc_slug" AS "doc", "section_key" AS "key", "reason", "reason_plan_version" AS "version", "sentences" FROM "wiki_doc_section_version"
        WHERE "space_id" = $1::uuid ORDER BY "seq"`, [spaceId])).rows;
    assert.deepEqual(kept.map((one) => [one.doc, one.key, one.reason, one.version]), [[SLUG, 'turn-delivery', 'build', 2], [SLUG, 'recovery', 'build', 2]],
      'what the build replaced is kept — and the section it took out of 1.1 too (docs.versions.kept)');
    assert.deepEqual(kept[1].sentences.map((one: { text: string }) => one.text), sentencesV1.get('recovery'), 'the section that left, as it read');
    const read = await card(cardA);
    assert.deepEqual([read.json.rewrite.result, read.json.rewrite.sections.map((s: { where: string; result: string }) => [s.where, s.result])],
      ['updated', [['1.1 §1', 'updated'], ['1.3 §1', 'updated']]], JSON.stringify(read.json.rewrite));
  });

  // ── 4 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  await t.test('4. Undo puts the plan and the sections the rebuild wrote back, with no model asked, and the next build leaves them', async () => {
    const refused = await press(cardA, 'undo', asChat);
    assert.deepEqual([refused.status, refused.json.code], [403, 'WIKI_OWNER_CHANNEL_ONLY'], 'the owner door alone');
    const calls = model.prompts.length;
    const undone = await press(cardA, 'undo');
    assert.equal(undone.status, 200, undone.text);
    assert.deepEqual([undone.json.replayed, undone.json.draft.state, undone.json.planVersion], [false, 'undone', 3]);
    assert.deepEqual(undone.json.sections.map((s: { doc: string; key: string; outcome: string }) => [s.doc, s.key, s.outcome]), [
      [SLUG, 'turn-delivery', 'restored'], [SLUG, 'recovery', 'restored'],
    ], 'each section the rebuild wrote or took out, restored');
    assert.equal(model.prompts.length, calls, 'and no model was asked');
    const versions = (await sql.query(
      `SELECT "version", "status", "origin", "base_version" AS "base", "author_user_id"::text AS "author", "confirmed_by_user_id"::text AS "confirmer"
         FROM "wiki_plan" WHERE "space_id" = $1::uuid ORDER BY "version"`, [spaceId])).rows;
    assert.deepEqual(versions.slice(1), [
      { version: 2, status: 'superseded', origin: 'owner', base: 1, author: ownerId, confirmer: ownerId },
      { version: 3, status: 'confirmed', origin: 'owner', base: 2, author: ownerId, confirmer: ownerId },
    ], 'a new version of the owner\'s, made on the card\'s, and confirmed');
    const content = async (version: number) => (await sql.query(
      `SELECT d."slug", d."position", d."title", d."question", d."protected", s."key", s."position" AS "at", s."title" AS "section", s."covers", s."sources"
         FROM "wiki_plan" p JOIN "wiki_plan_doc" d ON d."plan_id" = p."id" JOIN "wiki_plan_section" s ON s."doc_id" = d."id"
        WHERE p."space_id" = $1::uuid AND p."version" = $2 ORDER BY d."position", s."position"`, [spaceId, version])).rows;
    assert.deepEqual(await content(3), await content(1), 'version 3 says what version 1 said, word for word, its keys too');
    // The sections back as they were before the press: their sentences and their fingerprints.
    const now = new Map((await sectionRows()).map((row) => [row.key, row.sha]));
    assert.deepEqual([...now.keys()].sort(), ['contract', 'recovery', 'turn-delivery']);
    for (const key of ['turn-delivery', 'recovery', 'contract']) {
      assert.equal(now.get(key), before.get(key), `${key}'s fingerprint is the one it was written from before the press`);
      assert.deepEqual(await sentencesOf(key), sentencesV1.get(key), `${key} reads as it did before the press`);
    }
    const restore = (await sql.query(
      `SELECT "section_key" AS "key", "reason", "restored_version_id" IS NOT NULL AS "restored" FROM "wiki_doc_section_version"
        WHERE "space_id" = $1::uuid AND "reason" = 'restore' ORDER BY "seq"`, [spaceId])).rows;
    assert.deepEqual(restore, [{ key: 'turn-delivery', reason: 'restore', restored: true }], 'what the restore replaced is kept, reason restore');
    const doc = await api('GET', `/api/wiki/spaces/${pub(spaceId)}/docs/${SLUG}`, ownerToken);
    assert.equal(doc.status, 200, doc.text);
    assert.deepEqual(doc.json.sections.map((s: { key: string }) => s.key), ['turn-delivery', 'recovery', 'contract'], 'the document reads with its three sections again');
    // The build the Undo asked for, as a confirmation asks: every section stands by its fingerprint.
    const asked = await buildOf(3);
    assert.ok(asked && asked.jobId, `the build of version 3 was asked for: ${JSON.stringify(asked)}`);
    const rebuilt = await build(3);
    assert.deepEqual([rebuilt.outcome, rebuilt.jobState], ['succeeded', 'succeeded'], JSON.stringify(rebuilt));
    const sections = (rebuilt.report.docs as Array<{ slug: string; sections: Array<{ key: string; outcome: string; calls: number }> }>).find((one) => one.slug === SLUG)!.sections;
    assert.deepEqual(sections.map((s) => [s.key, s.outcome, s.calls]), [['turn-delivery', 'unchanged', 0], ['recovery', 'unchanged', 0], ['contract', 'unchanged', 0]],
      'the build after the Undo leaves every section as it is');
    assert.equal(model.prompts.length, calls, 'still no model asked');
    for (const key of ['turn-delivery', 'recovery', 'contract']) assert.deepEqual(await sentencesOf(key), sentencesV1.get(key));
    const again = await press(cardA, 'undo');
    assert.deepEqual([again.status, again.json.replayed], [200, true], 'the same Undo again answers the first');
    assert.equal((await planWrites()).versions, 3, 'and writes nothing');
    const note = await prisma.$transaction(async (tx) => appendWikiChatNotes(tx as never, {
      ownerId, spaceId, sessionId: chat, turn: { seq: 99, kind: 'message', wikiContext: null },
    }, 'Thanks.'));
    assert.match(note ?? '', /undone="1">/u);
    assert.match(note ?? '', new RegExp(`- ${pub(cardA)} Plan change: undone\\. The plan is back to what version 1 said, stored and confirmed as version 3`, 'u'));
  });

  // ── 5 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  await t.test('5. once the plan moved on from a card\'s version, its Undo is refused and writes nothing', async () => {
    const contract = sectionOf('contract');
    const drafted = await draft({ kind: 'plan', reason: 'Say what the contract promises first.', idempotencyKey: `c-${RUN}`,
      change: { docs: [{ ...pageDoc, sections: pageDoc.sections.map((s) => (s.key === 'contract' ? { ...contract, covers: 'What the contract promises, first.' } : s)) }] } });
    assert.equal(drafted.status, 200, drafted.text);
    const cardC = toUuid(drafted.json.draftId);
    const pressed = await press(cardC, 'apply');
    assert.deepEqual([pressed.status, pressed.json.draft.change.version, pressed.json.draft.undoable], [200, 4, true], pressed.text);
    // The owner edits the plan on its page: a draft waits, and the plan no longer stands where card C's press left it.
    const plan = await api('GET', `/api/wiki/spaces/${pub(spaceId)}/plan`, ownerToken);
    const section = plan.json.confirmed.docs.find((one: { slug: string }) => one.slug === SLUG).sections[0];
    const edited = await api('POST', `/api/wiki/spaces/${pub(spaceId)}/plan/edits`, ownerToken, {
      baseVersion: 4, docSlug: SLUG, sectionKey: section.key,
      section: { key: section.key, title: section.title, kind: section.kind, covers: 'How a turn is stored, then delivered.', length: section.length, sources: section.sources },
    });
    assert.equal(edited.status, 200, edited.text);
    const read = await card(cardC);
    assert.deepEqual([read.json.state, read.json.undoable], ['applied', false], 'Undo is off once the plan moved on');
    const writes = await planWrites();
    const refused = await press(cardC, 'undo');
    assert.deepEqual([refused.status, refused.json.code], [409, 'WIKI_REVISION_CONFLICT'], refused.text);
    assert.match(refused.json.message, /the plan moved on since this card's press made version 4: it stands at version 5 \(draft\) now, so nothing was undone/u);
    assert.deepEqual(await planWrites(), writes, 'nothing written');
    assert.equal((await draftRow(cardC)).undone_at, null, 'and the card is still applied');
  });
});
