/**
 * A wiki chat's plan card (contracts/wiki.contract.json `agentSurface.chat.draft.plan`, `chat.drafts.kinds.plan`,
 * `chat.presses.apply`, `chat.drafts.results.plan`, `chat.notes.page`; docs/wiki-contract.md §28.4–§28.8; design
 * docs/wiki-chat-design.md §6's third row; wiki chat project task C12), held against the production apiserver —
 * `build/main.js`, the whole AppModule — over a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty, with
 * the wiki-worker's docs_build job run in this process against a System model a local http server plays and the space's
 * runner played here, as wiki-worker/wiki-docs-build-job.pg.spec.ts plays them:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/wiki/wiki-chat-plan-card.pg.spec.ts
 *
 * One account, one machine, one space on a repository whose plan (version 1: a document of three sections, and a
 * protected one) the owner confirmed and the worker built. In order:
 *
 *   1. the plan page brings the agent the document's whole definition — as a plan card's change takes it, every section's
 *      covers and sources with it — and the section it shows, which a session cannot read (plan.who unchanged);
 *   2. wiki_draft's plan kind: the plan's gate answers the agent that wrote the change, protection included, and a card
 *      is made that writes nothing of the plan;
 *   3. a press whose change the gate refuses — a project its session condition names is gone — writes nothing: no
 *      version, no confirmation, no build, no press, the card a draft still and the refusal said;
 *   4. Apply & rebuild goes through the plan's own doors: a new version of origin owner made from the one the card was
 *      drafted on, confirmed, the one in force superseded, its build asked for — and a card drafted on the old version
 *      reads changed, its Apply refused WIKI_REVISION_CONFLICT;
 *   5. the covers change moves that section's fingerprint, so the build writes it again — it alone, from the new covers —
 *      and the card reads Wiki updated; the next build leaves it as it is: the requirement held;
 *   6. a draft of the plan waiting for the owner refuses a plan card WIKI_PLAN_STALE; Undo is refused; Try again asks for
 *      a failed build again while its version is in force, and not once another is;
 *   7. the next message tells the agent the version the press made;
 *   8. the wiki moved to Trash (contract `space.trash`), a plan card's press is the plain 404 and stores no version of the
 *      plan, nor confirms one.
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
const REPO_URL = `https://github.com/example/plan-card-${RUN}`;
const ENGINES = [{ engine: 'claude', installed: true, auth: 'yes', version: '2.3.0' }];
const CAPABILITIES = ['source-pin/v1', WIKI_REPO_OP_CAPABILITY, WIKI_REPO_OP_READ_CAPABILITY].join(',');
const KEY = `sk-spec-${randomUUID()}`;
const MODEL = 'qwen3.8-27b-fp8';
const SLUG = 'sessions-runtime';
/** The owner's writing requirement, which the agent puts on the section's covers (design §6, third row). */
const FIRST_TIME = 'for a first-time reader';
const NEW_COVERS = `What survives a respawn, ${FIRST_TIME}: the model first, then the numbers.`;
const WORDS = 'Write the recovery section for a first-time reader: the model first, then the numbers.';

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

test('a plan card: the page brings the plan, the gate answers the agent, one press edits, confirms and rebuilds, and a covers change is written again', { skip: !URL_, concurrency: 1, timeout: 900_000 }, async (t) => {
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
  const email = `owner-${RUN}@wiki-plan-card.invalid`;
  await sql.query(`INSERT INTO "user" (id, email, name, password_hash, role) VALUES ($1, $2, 'owner', $3, 'MEMBER')`, [ownerId, email, hashPassword(password)]);
  server = await startApiserver(url, `wiki-plan-card-${randomUUID()}`);
  const api = (method: string, route: string, bearer?: string, body?: unknown, headers?: Record<string, string>): Promise<Reply> =>
    call(server!, method, route, bearer, body, headers);
  const login = await api('POST', '/api/auth/login', undefined, { email, password });
  assert.equal(login.status, 201, login.text);
  const ownerToken = login.json.accessToken as string;
  const minted = await api('POST', '/api/runners/enrollment-tokens', ownerToken, { label: `plan card ${RUN}` });
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
  const recoveryV1 = await sentencesOf('recovery');
  assert.ok(recoveryV1.length > 0 && !recoveryV1.some((text) => text.includes('first-time reader')), recoveryV1.join(' | '));

  // ── the chat ─────────────────────────────────────────────────────────────────────────────────────────────────────
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

  // ── 1 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  let pageDoc: Record<string, any> = {};
  await t.test('1. the plan page brings the document whole, as a plan card takes it, and the section it shows', async () => {
    const delivered = await prisma.$transaction(async (tx) => appendWikiChatNotes(tx as never, {
      ownerId, spaceId, sessionId: chat, turn: { seq: 1, kind: 'message', wikiContext: planPage },
    }, WORDS));
    const block = delivered!.split('\n\n').find((one) => one.startsWith('<orbit_wiki_page'))!;
    assert.match(block, /^<orbit_wiki_page of="plan" doc="1\.1" slug="sessions-runtime" section="2" key="recovery">\n/u, block.slice(0, 200));
    const definition = JSON.parse(block.split('\n').slice(1, -1).join('\n'));
    assert.deepEqual([definition.planVersion, definition.number, definition.categoryTitle, definition.section], [1, '1.1', 'Runtime', { number: 2, key: 'recovery', title: 'Recovery' }]);
    assert.match(definition.howToChange, /wiki_draft with kind plan/u);
    assert.match(definition.howToChange, /A writing requirement goes into the covers of the sections it is for/u);
    pageDoc = definition.doc;
    assert.deepEqual(Object.keys(pageDoc), ['category', 'slug', 'title', 'question', 'audience', 'scopeIn', 'scopeOut', 'length', 'sections'],
      'every field a change sends back, and nothing the gate would refuse');
    assert.deepEqual(pageDoc.sections.map((s: { key: string; covers: string; sources: { docs: unknown[] } }) => [s.key, s.covers, s.sources.docs.length]), [
      ['turn-delivery', 'How a turn is stored and delivered.', 1], ['recovery', 'What survives a respawn.', 1], ['contract', 'What the session contract says.', 0],
    ], 'each section with its covers and its sources: what a session cannot read');
    // The message door takes a plan page at a section, and refuses a blank one before anything is filed.
    const sent = await api('POST', `/api/sessions/${pub(chat)}/turns`, ownerToken, { clientTurnId: randomUUID(), intent: 'NEXT_TURN', content: 'And §2?', wikiContext: planPage });
    assert.equal(sent.status, 201, sent.text);
    const blank = await api('POST', `/api/sessions/${pub(chat)}/turns`, ownerToken,
      { clientTurnId: randomUUID(), intent: 'NEXT_TURN', content: 'x', wikiContext: { page: { kind: 'plan', docSlug: SLUG, sectionKey: ' ' } } });
    assert.deepEqual([blank.status, blank.json.code, blank.json.errors?.map((e: { path: string }) => e.path)], [400, 'WIKI_SCHEMA', ['wikiContext.page.sectionKey']], blank.text);
  });

  // ── 2 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  const withCovers = (covers: string) => ({ ...pageDoc, sections: pageDoc.sections.map((s: { key: string }) => (s.key === 'recovery' ? { ...s, covers } : s)) });
  let cardA = '';
  let cardB = '';
  const projectId = randomUUID();
  await t.test("2. wiki_draft's plan kind: the gate answers the agent that wrote the change, and the card writes nothing of the plan", async () => {
    const base = { kind: 'plan', reason: 'The owner wants the recovery section written for a first-time reader.' };
    const writes = await planWrites();
    const refused = async (body: Record<string, unknown>, status: number, code: string) => {
      const answer = await draft({ ...base, idempotencyKey: `refused-${randomUUID()}`, ...body });
      assert.deepEqual([answer.status, answer.json.code], [status, code], answer.text);
      return answer.json as { message: string; errors?: Array<{ check: string; path: string; message: string }> };
    };
    // A change of no proposal's shape, a section of no kind, a topic the space has none of: the plan's gate, every error.
    const shape = await refused({ change: { doc: pageDoc, note: 'x' } }, 422, 'WIKI_PLAN_GATE');
    assert.deepEqual(shape.errors!.map((e) => e.path), ['change.note']);
    const kind = await refused({ change: { doc: { ...pageDoc, sections: pageDoc.sections.map((s: object, i: number) => (i === 1 ? { ...s, kind: 'essay' } : s)) } } }, 422, 'WIKI_PLAN_GATE');
    assert.deepEqual(kind.errors!.map((e) => [e.check, e.path]), [['schema', 'change.doc.sections[1].kind']]);
    const topic = await refused({
      change: { doc: { ...pageDoc, sections: pageDoc.sections.map((s: object, i: number) => (i === 2 ? { ...s, sources: { sessions: { projects: [], keywords: ['lease'], topics: ['made-up'] } } } : s)) } },
    }, 422, 'WIKI_PLAN_GATE');
    assert.deepEqual(topic.errors!.map((e) => [e.check, e.path]), [['references', 'change.doc.sections[2].sources.sessions.topics[0]']]);
    // A protected document stays as it is: only the owner changes it, on the Plan page.
    const runbooks = { category: 'runtime', slug: 'runbooks', title: 'Runbooks, rewritten', question: 'How is it run by hand?', audience: ['An operator'], scopeIn: ['Restarts'], scopeOut: [],
      length: { min: 100, max: 4000 }, sections: [{ key: 'restart', title: 'Restarting', kind: 'ops', covers: 'How the runner is restarted.', length: 200, sources: { docs: [{ path: 'docs/design.md', section: '1. Transport' }] } }] };
    const guarded = await refused({ change: { doc: runbooks } }, 422, 'WIKI_PLAN_GATE');
    assert.deepEqual(guarded.errors!.map((e) => e.check), ['protected']);
    // A rewrite's sections are no plan card's.
    const sections = await refused({ change: { doc: pageDoc }, sections: [{ doc: SLUG, section: 'recovery' }] }, 400, 'WIKI_SCHEMA');
    assert.deepEqual(sections.errors!.map((e) => e.path), ['sections']);
    assert.deepEqual(await planWrites(), writes, 'nothing of the plan was written by any of them');
    assert.equal(await count(`SELECT count(*)::int AS n FROM "wiki_chat_draft" WHERE "session_id" = $1::uuid`, [chat]), 0, 'and no card made');

    // The owner's words, put on the section's covers: a card, and nothing of the plan written.
    const body = { ...base, change: { doc: withCovers(NEW_COVERS) }, idempotencyKey: `plan-a-${RUN}` };
    const drafted = await draft(body);
    assert.equal(drafted.status, 200, drafted.text);
    assert.deepEqual([drafted.json.status, drafted.json.kind, drafted.json.replayed], ['draft', 'plan', false]);
    assert.deepEqual(drafted.json.rewrites.map((r: { key: string; where: string; title: string }) => [r.key, r.where, r.title]), [['recovery', '1.1 §2', 'Recovery']],
      'its press rewrites the section whose covers it changes');
    cardA = toUuid(drafted.json.draftId);
    const again = await draft(body);
    assert.deepEqual([again.status, again.json.replayed, toUuid(again.json.draftId)], [200, true, cardA], 'the same call under its key is the card it made');
    const reused = await draft({ ...body, reason: 'another' });
    assert.equal(reused.json.code, 'WIKI_IDEMPOTENCY_KEY_REUSED', reused.text);
    assert.deepEqual(await planWrites(), writes, 'a card writes nothing of the plan');
    const row = await draftRow(cardA);
    assert.deepEqual([row.kind, row.ops, row.rewrites, row.sections, row.change.baseVersion, row.change.version], ['plan', [], [], [{ doc: SLUG, key: 'recovery' }], 1, null]);
    const read = await card(cardA);
    assert.equal(read.status, 200, read.text);
    assert.deepEqual([read.json.kind, read.json.state, read.json.label, read.json.undoable, read.json.rewrite], ['plan', 'draft', 'Plan change', false, null]);
    assert.deepEqual(read.json.change, {
      baseVersion: 1, version: null,
      doc: { slug: SLUG, title: 'Sessions runtime', number: '1.1' },
      category: { key: 'runtime', title: 'Runtime', opens: false },
      fields: [],
      sections: [{ key: 'recovery', title: 'Recovery', number: 2, edit: 'changed', fields: ['covers'], covers: NEW_COVERS }],
    }, 'the change as the card shows it: one section, its covers');

    // Card B names a project in a session condition: the gate finds it now.
    await sql.query(`INSERT INTO "project" ("id", "title", "owner_id", "updated_at") VALUES ($1, 'Runner hosting', $2, now())`, [projectId, ownerId]);
    const named = { ...pageDoc, sections: pageDoc.sections.map((s: object, i: number) => (i === 2 ? { ...s, covers: 'What the contract says, and what its project decided.', sources: { contracts: [{ path: 'contracts/session.contract.json' }], sessions: { projects: [pub(projectId)], keywords: ['contract'] } } } : s)) };
    const second = await draft({ ...base, reason: 'Cite what the project decided.', change: { doc: named }, idempotencyKey: `plan-b-${RUN}` });
    assert.equal(second.status, 200, second.text);
    cardB = toUuid(second.json.draftId);
    assert.deepEqual((await draftRow(cardB)).change.doc.sections[2].sources.sessions.projects, [projectId], 'the project kept by its id, as the gate resolved it');
  });

  // ── 3 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  await t.test('3. a press the gate refuses writes nothing — no version, no confirmation, no build, no press — and says so', async () => {
    await sql.query(`DELETE FROM "project" WHERE "id" = $1::uuid`, [projectId]);
    const writes = await planWrites();
    const pressed = await press(cardB, 'apply');
    assert.deepEqual([pressed.status, pressed.json.code], [422, 'WIKI_PLAN_GATE'], pressed.text);
    assert.match(pressed.json.message, /did not pass the plan's gate \(references\)/u);
    assert.match(pressed.json.errors[0].path, /sections\[2\]\.sources\.sessions\.projects\[0\]$/u);
    assert.deepEqual(await planWrites(), writes, 'the plan stands as it was, and no build was asked for');
    const row = await draftRow(cardB);
    assert.deepEqual([row.decision, row.decided_at, row.change.version], [null, null, null], 'and the card was not pressed');
    assert.equal((await card(cardB)).json.state, 'draft', 'it is a draft still, for the owner to Discard or the chat to draft again');
  });

  // ── 4 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  await t.test("4. Apply & rebuild goes through the plan's own doors: a version of origin owner, confirmed, its build asked for", async () => {
    const writes = await planWrites();
    const refused = await press(cardA, 'apply', asChat);
    assert.deepEqual([refused.status, refused.json.code], [403, 'WIKI_OWNER_CHANNEL_ONLY'], 'the owner door alone');
    const pressed = await press(cardA, 'apply');
    assert.equal(pressed.status, 200, pressed.text);
    assert.deepEqual([pressed.json.replayed, pressed.json.draft.state, pressed.json.draft.change.version, pressed.json.draft.undoable], [false, 'applied', 2, false]);
    assert.ok(['rewriting', 'waiting'].includes(pressed.json.draft.rewrite.result), JSON.stringify(pressed.json.draft.rewrite));
    const versions = (await sql.query(
      `SELECT "version", "status", "origin", "base_version" AS "base", "author_user_id"::text AS "author", "confirmed_by_user_id"::text AS "confirmer", "proposal_id" AS "proposal"
         FROM "wiki_plan" WHERE "space_id" = $1::uuid ORDER BY "version"`, [spaceId])).rows;
    assert.deepEqual(versions, [
      { version: 1, status: 'superseded', origin: 'owner', base: null, author: ownerId, confirmer: ownerId, proposal: null },
      { version: 2, status: 'confirmed', origin: 'owner', base: 1, author: ownerId, confirmer: ownerId, proposal: null },
    ], 'an edit of the owner made from the version the card was drafted on, and confirmed: the one in force superseded');
    const plan = await api('GET', `/api/wiki/spaces/${pub(spaceId)}/plan`, ownerToken);
    assert.equal(plan.status, 200, plan.text);
    const doc = plan.json.confirmed.docs.find((one: { slug: string }) => one.slug === SLUG);
    assert.deepEqual(doc.sections.map((s: { key: string; covers: string }) => [s.key, s.covers]), [
      ['turn-delivery', 'How a turn is stored and delivered.'], ['recovery', NEW_COVERS], ['contract', 'What the session contract says.'],
    ], 'the plan in force carries the requirement on the section\'s covers');
    assert.equal(plan.json.draft, null);
    assert.equal(plan.json.confirmed.gate.checks.protected, 'passed', 'gated as an accepted proposal is, protection included');
    const asked = await buildOf(2);
    assert.ok(asked && asked.state === 'made' && asked.jobId, `the build of version 2 was asked for, as a confirmation asks: ${JSON.stringify(asked)}`);
    const after = await planWrites();
    assert.deepEqual([after.versions, after.builds, after.buildJobs], [writes.versions + 1, writes.builds + 1, writes.buildJobs + 1]);
    const replay = await press(cardA, 'apply');
    assert.deepEqual([replay.status, replay.json.replayed], [200, true], 'the same press again answers the first');
    assert.equal((await planWrites()).versions, after.versions, 'and writes nothing');
    // Card B was drafted on version 1: the plan moved off it, so it reads changed and its Apply is refused.
    assert.equal((await card(cardB)).json.state, 'changed');
    const moved = await press(cardB, 'apply');
    assert.deepEqual([moved.status, moved.json.code], [409, 'WIKI_REVISION_CONFLICT'], moved.text);
    assert.equal((await planWrites()).versions, after.versions);
  });

  // ── 5 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  await t.test('5. the covers change moves the fingerprint: the build writes that section again, alone, and the requirement holds', async () => {
    const calls = model.prompts.length;
    const built = await build(2);
    assert.deepEqual([built.outcome, built.jobState], ['succeeded', 'succeeded'], JSON.stringify(built));
    const reported = (built.report.docs as Array<{ slug: string; sections: Array<{ key: string; outcome: string; calls: number; materialSha256: string }> }>)
      .find((one) => one.slug === SLUG)!.sections;
    assert.deepEqual(reported.map((s) => [s.key, s.outcome]), [['turn-delivery', 'unchanged'], ['recovery', 'written'], ['contract', 'unchanged']],
      'only the section whose covers changed is written again');
    assert.deepEqual(reported.filter((s) => s.outcome === 'unchanged').map((s) => s.calls), [0, 0], 'nothing is asked of the model for the others');
    const written = new Map((await sectionRows()).map((row) => [row.key, row.sha]));
    assert.notEqual(written.get('recovery'), before.get('recovery'), 'its fingerprint holds the covers, so it moved');
    assert.deepEqual([written.get('turn-delivery'), written.get('contract')], [before.get('turn-delivery'), before.get('contract')]);
    const asked = model.prompts.slice(calls);
    assert.ok(asked.length > 0 && asked.some((prompt) => prompt.includes('# Task: write the document') && prompt.includes(NEW_COVERS)),
      'the writer was handed the new covers');
    const now = await sentencesOf('recovery');
    assert.ok(now.some((text) => text.includes('first-time reader')), `written from the requirement: ${now.join(' | ')}`);
    const kept = (await sql.query(`SELECT "section_key", "reason", "reason_plan_version" AS "version", "job_id"::text AS "job" FROM "wiki_doc_section_version" WHERE "space_id" = $1::uuid`, [spaceId])).rows;
    assert.deepEqual(kept, [{ section_key: 'recovery', reason: 'build', version: 2, job: built.jobId }], 'what it replaced is kept, as replaced by the build of version 2');
    // The card reads its rebuild: Wiki updated, the section's new sentence counted, See changes on it.
    const read = await card(cardA);
    assert.deepEqual([read.json.rewrite.result, read.json.rewrite.sections.map((s: { where: string; result: string }) => [s.where, s.result])],
      ['updated', [['1.1 §2', 'updated']]], JSON.stringify(read.json.rewrite));
    assert.ok(read.json.rewrite.sections[0].changed >= 1, 'its new sentence counted');
    assert.equal(read.json.rewrite.sections[0].versionId !== null, true, 'See changes opens the version the build kept');
    assert.equal(toUuid((await draftRow(cardA)).change.build), (await buildOf(2))!.id, 'the card names the build its press asked for');
    const seen = await press(cardA, 'seen');
    assert.deepEqual([seen.status, seen.json.seen], [200, true]);
    // The next build of the same version: the section stands as its fingerprint says — the requirement held.
    const again = await api('POST', `/api/wiki/spaces/${pub(spaceId)}/plan/versions/2/build`, ownerToken);
    assert.equal(again.status, 200, again.text);
    const rebuilt = await build(2);
    const second = (rebuilt.report.docs as Array<{ slug: string; sections: Array<{ key: string; outcome: string }> }>).find((one) => one.slug === SLUG)!.sections;
    assert.deepEqual(second.map((s) => s.outcome), ['unchanged', 'unchanged', 'unchanged'], 'nothing written again: the covers are the plan\'s now');
    assert.deepEqual(await sentencesOf('recovery'), now);
    assert.equal((await card(cardA)).json.rewrite.result, 'updated', 'the owner\'s later rebuild is not the card\'s: it still says what its own press did');
  });

  // ── 6 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  await t.test('6. a waiting draft refuses a plan card; Undo is refused; Try again asks for a failed build while its version is in force', async () => {
    const undo = await press(cardA, 'undo');
    assert.equal(undo.status, 409, undo.text);
    assert.match(undo.json.message, /the plan keeps every version/u);
    const early = await press(cardA, 'retry');
    assert.equal(early.status, 409, 'Try again is for a failed rebuild');
    // Had the card's own build ended with the section left unwritten, the card reads failed, and Try again asks for it again.
    const own = (await sql.query(`SELECT "job_id"::text AS "jobId" FROM "wiki_plan_job" WHERE "id" = $1::uuid`, [toUuid((await draftRow(cardA)).change.build)])).rows[0];
    await sql.query(`UPDATE "wiki_job" SET "state" = 'failed', "report" = $2::jsonb WHERE "id" = $1::uuid`,
      [own.jobId, JSON.stringify({ kind: 'docs_build', docs: [{ slug: SLUG, sections: [{ key: 'recovery', outcome: 'failed' }] }] })]);
    const failed = await card(cardA);
    assert.deepEqual([failed.json.rewrite.result, failed.json.rewrite.seen], ['failed', true]);
    const builds = (await planWrites()).builds;
    const retried = await press(cardA, 'retry');
    assert.equal(retried.status, 200, retried.text);
    assert.equal((await planWrites()).builds, builds + 1, 'the documents of version 2 asked for again');
    assert.ok(['rewriting', 'waiting'].includes(retried.json.draft.rewrite.result), JSON.stringify(retried.json.draft.rewrite));
    assert.equal(retried.json.draft.rewrite.seen, false, 'unseen again');
    await sql.query(`UPDATE "wiki_job" SET "state" = 'cancelled', "ended_at" = now() WHERE "space_id" = $1::uuid AND "kind" = 'docs_build' AND "state" IN ('queued', 'running', 'waiting')`, [spaceId]);
    await sql.query(`UPDATE "wiki_plan_job" SET "state" = 'ended', "outcome" = 'failed', "ended_at" = now() WHERE "space_id" = $1::uuid AND "kind" = 'build' AND "state" <> 'ended'`, [spaceId]);
    // The owner edits the plan on its page: a draft waits for them, and a plan card is refused until it is settled.
    const plan = await api('GET', `/api/wiki/spaces/${pub(spaceId)}/plan`, ownerToken);
    const section = plan.json.confirmed.docs.find((one: { slug: string }) => one.slug === SLUG).sections[0];
    const edited = await api('POST', `/api/wiki/spaces/${pub(spaceId)}/plan/edits`, ownerToken, {
      baseVersion: 2, docSlug: SLUG, sectionKey: section.key,
      section: { key: section.key, title: section.title, kind: section.kind, covers: 'How a turn is stored, then delivered.', length: section.length, sources: section.sources },
    });
    assert.equal(edited.status, 200, edited.text);
    const waiting = await draft({ kind: 'plan', reason: 'r', change: { doc: withCovers('Something else.') }, idempotencyKey: `plan-c-${RUN}` });
    assert.deepEqual([waiting.status, waiting.json.code], [409, 'WIKI_PLAN_STALE'], waiting.text);
    assert.match(waiting.json.message, /has a draft the owner has not confirmed \(version 3\)/u);
    // Version 3 confirmed: version 2, which card A's press made, is in force no more, and its Try again asks for nothing.
    const confirmedV3 = await api('POST', `/api/wiki/spaces/${pub(spaceId)}/plan/versions/3/confirm`, ownerToken);
    assert.equal(confirmedV3.status, 200, confirmedV3.text);
    assert.equal((await card(cardA)).json.rewrite.result, 'failed');
    const gone = await press(cardA, 'retry');
    assert.equal(gone.status, 409, gone.text);
    assert.match(gone.json.message, /no longer the one in force/u);
  });

  // ── 7 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  await t.test('7. the next message tells the agent the version the press made', async () => {
    const note = await prisma.$transaction(async (tx) => appendWikiChatNotes(tx as never, {
      ownerId, spaceId, sessionId: chat, turn: { seq: 99, kind: 'message', wikiContext: null },
    }, 'Thanks.'));
    assert.match(note ?? '', /<orbit_wiki_drafts applied="1" edited="0" discarded="0" undone="0">/u);
    assert.match(note ?? '', new RegExp(`- ${pub(cardA)} Plan change: applied by the owner\\. It made version 2 of the plan from version 1 and confirmed it`, 'u'));
  });

  // ── 8 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  await t.test('8. a plan card of a wiki in Trash: its press is the plain 404, and stores no version of the plan', async () => {
    // A card drafted on the version in force (3), which its press would edit and confirm.
    const drafted = await draft({ kind: 'plan', reason: 'Say how long a respawn takes.', change: { doc: withCovers('What survives a respawn, and how long it takes.') }, idempotencyKey: `plan-d-${RUN}` });
    assert.equal(drafted.status, 200, drafted.text);
    const cardD = toUuid(drafted.json.draftId);
    assert.deepEqual([(await draftRow(cardD)).change.baseVersion, (await card(cardD)).json.state], [3, 'draft']);
    const trashed = await api('DELETE', `/api/wiki/spaces/${pub(spaceId)}`, ownerToken);
    assert.equal(trashed.status, 200, trashed.text);
    const writes = await planWrites();
    assert.deepEqual([writes.versions, writes.confirmed], [3, [3]], 'the plan as the Trash found it');
    const pressed = await press(cardD, 'apply');
    assert.equal(pressed.status, 404, pressed.text);
    assert.deepEqual(await planWrites(), writes, 'no version stored, none confirmed, no build asked for');
    const row = await draftRow(cardD);
    assert.deepEqual([row.decision, row.decided_at, row.change.version], [null, null, null], 'and the card was not pressed');
  });
});
