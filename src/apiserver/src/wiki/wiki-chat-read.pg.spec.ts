/**
 * `wiki_read`, a wiki chat's read of its space (contracts/wiki.contract.json `chat.read`; docs/wiki-contract.md §11 and §22.8;
 * design docs/wiki-chat-design.md §4.2; decision D10), held against the production apiserver — `build/main.js`, the whole
 * AppModule — over a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/wiki/wiki-chat-read.pg.spec.ts
 *
 * One account, one machine that beats, one space on a repository with a confirmed plan of two documents. In order:
 *
 *   1. a session that is no chat is refused WIKI_SESSION_EXCLUDED, a call with no session 400, and arguments that do not
 *      go together WIKI_SCHEMA;
 *   2. no arguments: the contents, opening with the header and the plan, plan draft and writer job lines;
 *   3. q: the sections whose title, covers and sentences hold every word, with the sentences that hold one; a sentence
 *      left out is never matched;
 *   4. doc and section: the whole definition with covers and every section's sentences and footnotes, or one section; a
 *      sentence written only from tainted, unvouched entries is left out; the via entries of what was shown are recorded
 *      as exposures of channel get, and nothing else is;
 *   5. an answer over readMaxChars is cut at a line with more, every part opens with the header, the parts read in turn
 *      hold every sentence once, and a cursor from another plan version starts over;
 *   6. draft: a card of this chat, with its rewrite's sentences before and now; another chat's card is WIKI_SCHEMA;
 *   7. a draft of the plan that waits for the owner, and the space's queued writer jobs, are reported.
 *
 * Not destructive: every row belongs to the account this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { toUuid, uuidToBase62, WIKI_CHAT_READ, WIKI_CHAT_RULES } from '@orbit/shared';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { hashPassword } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import '../test-support/daemon-routes-over-http';

const URL_ = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const REPO_URL = `https://github.com/example/read-${RUN}`;
const SHA = '1f'.repeat(20);
const ENGINES = [{ engine: 'claude', installed: true, auth: 'yes', version: '2.3.0' }];
const CAPABILITIES = 'source-pin/v1';
const QUOTE = 'the lease is two minutes on main now';
const BIG_SENTENCES = 120;

test('a wiki chat reads its wiki with wiki_read, and no other session does', { skip: !URL_, concurrency: 1, timeout: 900_000 }, async (t) => {
  const url = URL_!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma: PrismaClient = prismaClientFor(url);
  let server: Apiserver | undefined;
  t.after(async () => {
    await server?.stop();
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  const ownerId = randomUUID();
  const password = `pw-owner-${RUN}`;
  const email = `owner-${RUN}@wiki-read.invalid`;
  await sql.query(`INSERT INTO "user" (id, email, name, password_hash, role) VALUES ($1, $2, 'owner', $3, 'MEMBER')`, [ownerId, email, hashPassword(password)]);
  server = await startApiserver(url, `wiki-read-${randomUUID()}`);
  const api = (method: string, route: string, bearer?: string, body?: unknown, headers?: Record<string, string>): Promise<Reply> =>
    call(server!, method, route, bearer, body, headers);
  const login = await api('POST', '/api/auth/login', undefined, { email, password });
  assert.equal(login.status, 201, login.text);
  const ownerToken = login.json.accessToken as string;
  const minted = await api('POST', '/api/runners/enrollment-tokens', ownerToken, { label: `wiki read ${RUN}` });
  assert.equal(minted.status, 201, minted.text);
  const registered = await api('POST', '/api/runner/register', undefined, { enrollmentToken: minted.json.token, name: `hpc-${RUN}`, hostname: `hpc-${RUN}` });
  assert.equal(registered.status, 201, registered.text);
  const hpc = { runnerId: toUuid(registered.json.runnerId), token: registered.json.runnerToken as string };
  const beat = await api('POST', '/api/runner/heartbeat', hpc.token, { status: 'ONLINE', engines: ENGINES }, { 'x-orbit-runner-capabilities': CAPABILITIES });
  assert.equal(beat.status < 300, true, beat.text);
  const workspace = async (name: string) => {
    const id = randomUUID();
    await sql.query(
      `INSERT INTO "workspace" (id, name, owner_id, runner_id, work_dir, repo_url, enable_worktree) VALUES ($1, $2, $3, $4, $5, $6, true)`,
      [id, name, ownerId, hpc.runnerId, `/srv/${name}`, REPO_URL],
    );
    return id;
  };
  const wsChat = await workspace('orbit-develop');
  const wsPlain = await workspace('orbit-plain');
  const pub = (id: string) => uuidToBase62(id);

  // ── the space: a confirmed plan of two documents ────────────────────────────────────────────────────────────────
  const made = await api('POST', '/api/wiki/spaces', ownerToken, { title: `Orbit ${RUN}`, repoUrl: REPO_URL });
  assert.equal(made.status, 201, made.text);
  const spaceId = toUuid(made.json.id);
  const planId = randomUUID();
  const categories = [{ key: 'runtime', title: 'Runtime', question: 'How does it run?', forAgents: false }];
  await prisma.wikiPlan.create({
    data: {
      id: planId, spaceId, ownerId, version: 1, status: 'confirmed', origin: 'owner', authorUserId: ownerId,
      confirmedByUserId: ownerId, confirmedAt: new Date(), docsMin: 1, docsMax: 10, gate: {}, categories,
    },
  });
  const planDoc = async (position: number, slug: string, title: string, sections: Array<[string, string, string]>) => {
    const row = await prisma.wikiPlanDoc.create({
      data: {
        planId, ownerId, position, category: 'runtime', slug, title, question: `What is ${title}?`, audience: ['A new contributor'],
        scopeIn: ['Turns'], scopeOut: [] as never, lengthMin: 100, lengthMax: 2000,
      },
    });
    for (const [index, [key, sectionTitle, covers]] of sections.entries()) {
      await prisma.wikiPlanSection.create({
        data: { docId: row.id, ownerId, position: index, key, title: sectionTitle, kind: 'flow', covers, length: 200, sources: {} },
      });
    }
    return prisma.wikiDoc.create({ data: { spaceId, ownerId, slug, planId, planVersion: 1, planDocId: row.id, status: 'ok', repoSha: SHA } });
  };
  const runtime = await planDoc(0, 'sessions-runtime', 'Sessions runtime', [
    ['overview', 'Overview', 'What a session is, end to end'],
    ['turn-delivery', 'Turn delivery', 'How a turn reaches its runner'],
    ['leases', 'Leases', 'How long a runner holds a turn'],
  ]);
  const big = await planDoc(1, 'big-notes', 'Big notes', [['all', 'All of it', 'Everything, at length']]);

  // ── the entries the sentences came through ─────────────────────────────────────────────────────────────────────
  const ownerAdd = async (title: string) => {
    const reply = await api('POST', `/api/wiki/spaces/${pub(spaceId)}/changesets`, ownerToken, {
      ops: [{ op: 'add', entry: { kind: 'concept', title, summary: `${title}, as the owner wrote it.`, fields: { definition: title, boundaries: 'None.' } } }],
      rationale: 'the owner writes it', idempotencyKey: `owner-${randomUUID()}`,
    });
    assert.equal(reply.status, 200, reply.text);
    return toUuid(reply.json.ops[0].entryId);
  };
  const E_CONV = await ownerAdd('Turn leases');
  // Two entries resting on the web that nobody vouched for: what wiki_get leaves out.
  const E_TAINT = await ownerAdd('A web page on steering');
  const E_TAINT_ONLY = await ownerAdd('Another web page on steering');
  await sql.query(`UPDATE "wiki_entry" SET "tainted" = true, "trust" = 'unreviewed' WHERE "id" = ANY($1::uuid[])`, [[E_TAINT, E_TAINT_ONLY]]);
  const hidden = await api('GET', `/api/runner/wiki/entries/${pub(E_TAINT)}`, hpc.token);
  assert.notEqual(hidden.status, 200, 'the precondition: wiki_get does not serve such an entry to a session either');

  /** A section's sentences, each with the entries its footnotes came through (null: a footnote of its own, through none). */
  const writeSection = async (docId: string, key: string, sentences: Array<[string, Array<string | null>]>) => {
    const row = await prisma.wikiDocSection.create({
      data: { docId, ownerId, key, planSectionId: randomUUID(), materialSha256: 'f'.repeat(64), blocks: [{ kind: 'paragraph' }] as never, repoSha: SHA, model: 'spec-model' },
    });
    for (const [position, [text, vias]] of sentences.entries()) {
      const sentence = await prisma.wikiDocSentence.create({ data: { sectionId: row.id, ownerId, position, block: 0, text, status: vias.length > 0 ? 'sourced' : 'transition' } });
      for (const [at, via] of vias.entries()) {
        await prisma.wikiDocFootnote.create({
          data: {
            sentenceId: sentence.id, ownerId, position: at, kind: 'turn', ref: randomUUID(), sha: null, charStart: 0, charEnd: 5,
            locator: { sessionId: randomUUID() }, quote: 'lease', verdict: 'verified', checkedBy: 'server', viaEntryId: via,
          } as never,
        });
      }
    }
  };
  const S_SHOWN = 'The runner leases one turn at a time.';
  const S_WITHHELD = 'A steer joins the running turn from the zebra web page.';
  const S_MIXED = 'A steer is delivered with the next turn when no turn runs.';
  await writeSection(runtime.id, 'turn-delivery', [[S_SHOWN, [E_CONV]], [S_WITHHELD, [E_TAINT_ONLY]], [S_MIXED, [E_TAINT, null]]]);
  await writeSection(runtime.id, 'leases', [['A lease expires after ninety seconds.', []]]);
  const filler = 'and the runner keeps its lease while the turn runs '.repeat(18);
  await writeSection(big.id, 'all', Array.from({ length: BIG_SENTENCES }, (_, i) => [`Sentence ${String(i).padStart(3, '0')} says ${filler}.`, []] as [string, Array<string | null>]));

  // ── the chats ──────────────────────────────────────────────────────────────────────────────────────────────────
  const newChat = async () => {
    const reply = await api('POST', `/api/wiki/spaces/${pub(spaceId)}/chats`, ownerToken,
      { workspaceId: pub(wsChat), content: `The wiki says ninety seconds, but ${QUOTE}.`, clientTurnId: randomUUID() });
    assert.equal(reply.status, 201, reply.text);
    return toUuid(reply.json.sessionId);
  };
  const chat = await newChat();
  const otherChat = await newChat();
  const ordinary = await api('POST', '/api/sessions', ownerToken, { prompt: `An ordinary session: ${QUOTE}.`, workspaceId: pub(wsPlain) });
  assert.equal(ordinary.status, 201, ordinary.text);
  const plainSession = toUuid(ordinary.json.id);
  const asSession = (sessionId: string) => ({ 'x-orbit-session-id': pub(sessionId) });
  const read = (sessionId: string | null, params: Record<string, string> = {}) =>
    api('GET', `/api/runner/wiki/read${Object.keys(params).length > 0 ? `?${new URLSearchParams(params)}` : ''}`, hpc.token, undefined,
      sessionId ? asSession(sessionId) : undefined);
  const ok = async (params: Record<string, string> = {}, sessionId = chat) => {
    const reply = await read(sessionId, params);
    assert.equal(reply.status, 200, reply.text);
    const text = reply.json.text as string;
    assert.ok(text.startsWith(`${WIKI_CHAT_READ.header}\n`), `every answer opens with the header: ${text.slice(0, 200)}`);
    assert.ok(text.length <= WIKI_CHAT_RULES.readMaxChars, `${text.length} characters`);
    return reply.json as { view: string; planVersion: number | null; planDraft: { version: number } | null; writerJobs: Array<{ kind: string; state: string }>; text: string; more: string | null };
  };
  /** The space's jobs that write documents, queued, waiting or running, as the answer must name them. */
  const writers = async () => (await sql.query(
    `SELECT "kind", "state" FROM "wiki_job" WHERE "space_id" = $1::uuid AND "kind" IN ('maintain','docs_build','plan_draft','plan_revise','docs_follow')
       AND "state" IN ('queued','waiting','running') ORDER BY "created_at", "id"`, [spaceId])).rows.map((row) => [row.kind as string, row.state as string]);
  const exposures = async (entryId: string) => Number((await sql.query(
    `SELECT count(*)::int AS n FROM "wiki_exposure" WHERE "session_id" = $1::uuid AND "entry_id" = $2::uuid AND "channel" = 'get'`, [chat, entryId])).rows[0].n);

  // ── 1 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  await t.test('1. a session that is no chat is refused WIKI_SESSION_EXCLUDED; no session is a 400; arguments that do not go together are WIKI_SCHEMA', async () => {
    const plain = await read(plainSession);
    assert.deepEqual([plain.status, plain.json.code], [403, 'WIKI_SESSION_EXCLUDED'], plain.text);
    assert.match(plain.json.message, /works only in a wiki chat/u);
    const headless = await read(null);
    assert.equal(headless.status, 400, headless.text);
    for (const params of <Array<Record<string, string>>>[
      { q: 'lease', doc: 'sessions-runtime' },
      { doc: 'sessions-runtime', draft: pub(randomUUID()) },
      { section: 'leases' },
      { doc: 'no-such-doc' },
      { doc: 'sessions-runtime', section: 'no-such-section' },
      { more: 'not a cursor' },
      { draft: 'not an id' },
    ]) {
      const refused = await read(chat, params);
      assert.deepEqual([refused.status, refused.json.code], [400, 'WIKI_SCHEMA'], `${JSON.stringify(params)}: ${refused.text}`);
    }
  });

  // ── 2 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  await t.test('2. no arguments answers the contents, after the plan, the plan draft and the writer jobs', async () => {
    const answer = await ok();
    assert.deepEqual([answer.view, answer.planVersion, answer.planDraft, answer.more], ['contents', 1, null, null]);
    const jobs = await writers();
    assert.deepEqual(answer.writerJobs.map((job) => [job.kind, job.state]), jobs);
    const lines = answer.text.split('\n');
    assert.deepEqual(lines.slice(0, 4), [
      WIKI_CHAT_READ.header,
      'Plan: version 1 is in force.',
      'Plan draft: none waits for the owner.',
      jobs.length === 0 ? 'Writer jobs: none queued or running in this space.' : `Writer jobs: ${jobs.map(([kind, state]) => `${kind} ${state}`).join(', ')}.`,
    ]);
    for (const line of [
      '1.1 sessions-runtime · Sessions runtime · Runtime',
      '  §1 overview · Overview · not written',
      `  §2 turn-delivery · Turn delivery · written, repoSha ${SHA.slice(0, 12)}`,
      `  §3 leases · Leases · written, repoSha ${SHA.slice(0, 12)}`,
      '1.2 big-notes · Big notes · Runtime',
    ]) assert.ok(lines.includes(line), `the contents list ${line}:\n${answer.text}`);
    assert.ok(!answer.text.includes(S_SHOWN), 'the contents carry no sentences');
  });

  // ── 3 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  await t.test('3. q answers the sections whose title, covers and sentences hold every word, and never matches a sentence left out', async () => {
    const both = await ok({ q: 'RUNNER turn' });
    assert.equal(both.view, 'search');
    assert.match(both.text, /Search for "RUNNER turn": 3 sections whose title, covers and sentences hold every word\./u);
    assert.ok(both.text.includes('1.1 sessions-runtime · Sessions runtime · §2 turn-delivery · Turn delivery'), both.text);
    assert.ok(both.text.includes(`  ${S_SHOWN}`), 'with the sentences that hold a word');
    assert.ok(both.text.includes(`  ${S_MIXED}`), 'a sentence with a footnote of its own is shown');
    assert.ok(!both.text.includes(S_WITHHELD), 'never a sentence left out');
    // "zebra" is in the left-out sentence alone: nothing matches, so a search cannot tell what it says.
    const zebra = await ok({ q: 'zebra' });
    assert.match(zebra.text, /Search for "zebra": no section/u);
    assert.ok(!zebra.text.includes('turn-delivery'), zebra.text);
    // A word of the covers alone matches too.
    const covers = await ok({ q: 'end to end' });
    assert.match(covers.text, /1 section whose/u);
    assert.ok(covers.text.includes('§1 overview · Overview · not written'), covers.text);
  });

  // ── 4 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  await t.test('4. doc and section: the definition with covers, the sentences and footnotes, a tainted-only sentence left out, the via entries recorded', async () => {
    const counts = async () => [await exposures(E_CONV), await exposures(E_TAINT), await exposures(E_TAINT_ONLY)];
    const start = await counts();
    const leases = await ok({ doc: 'sessions-runtime', section: 'leases' });
    assert.equal(leases.view, 'section');
    assert.ok(leases.text.includes('§3 leases · Leases · written'), leases.text);
    assert.ok(leases.text.includes('A lease expires after ninety seconds.'));
    assert.ok(!leases.text.includes(S_SHOWN), 'one section alone');
    assert.ok(leases.text.includes('"covers": "How long a runner holds a turn"'));
    assert.ok(!leases.text.includes('"key": "overview"'), 'the definition holds that section alone');
    assert.deepEqual(await counts(), start, 'a part whose sentences came through no entry records nothing');

    const whole = await ok({ doc: 'sessions-runtime' });
    assert.equal(whole.view, 'doc');
    assert.ok(whole.text.includes('Document 1.1 sessions-runtime · Sessions runtime · Runtime, in plan version 1'), whole.text);
    for (const field of ['"slug": "sessions-runtime"', '"question": "What is Sessions runtime?"', '"covers": "What a session is, end to end"',
      '"key": "turn-delivery"', '"key": "leases"', 'To change how this document is planned, draft a plan card']) {
      assert.ok(whole.text.includes(field), `the definition holds ${field}`);
    }
    assert.ok(whole.text.includes(`${S_SHOWN}\n  - turn `), 'a sentence with its footnotes under it');
    assert.ok(whole.text.includes(`via entry ${pub(E_CONV)}`));
    assert.ok(whole.text.includes(S_MIXED));
    assert.ok(!whole.text.includes(S_WITHHELD), 'a sentence written only from tainted, unvouched entries is left out');
    assert.ok(!whole.text.includes(pub(E_TAINT_ONLY)), 'and so is the entry it came through');
    assert.ok(whole.text.includes('(A sentence is left out here: it was written only from entries that rest on the web and that nobody vouched for.)'));
    assert.deepEqual(await counts(), [start[0]! + 1, start[1]! + 1, 0],
      'one get row per via entry of a shown sentence, and none ever for the sentence left out');
  });

  // ── 5 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  await t.test('5. an answer over readMaxChars is cut at a line with more, and its parts read in turn hold every sentence once', async () => {
    const parts: string[] = [];
    let more: string | null = null;
    do {
      const answer = await ok({ doc: 'big-notes', ...(more ? { more } : {}) });
      parts.push(answer.text);
      if (answer.more) assert.match(answer.text, new RegExp(`\\[Cut at ${WIKI_CHAT_RULES.readMaxChars} characters: \\d+ more lines\\. Call wiki_read again with the same arguments and more "${answer.more}" for the rest\\.\\]$`, 'u'));
      more = answer.more;
    } while (more && parts.length < 10);
    assert.ok(parts.length >= 2, `cut into ${parts.length} parts`);
    assert.equal(more, null, 'the last part has no more');
    assert.match(parts[1]!, /\nContinued from line \d+ of \d+\.\n/u);
    const seen = parts.join('\n').match(/Sentence \d{3} says/gu) ?? [];
    assert.equal(seen.length, BIG_SENTENCES, 'every sentence once');
    assert.equal(new Set(seen).size, BIG_SENTENCES);
    // A cursor from another plan version starts over.
    const first = await ok({ doc: 'big-notes' });
    const moved = await ok({ doc: 'big-notes', more: `7:${first.more!.split(':')[1]}` });
    assert.match(moved.text, /The plan moved from version 7 to 1 since the part before, so this answer starts over\./u);
    assert.ok(moved.text.includes('Sentence 000 says'));
    const past = await ok({ doc: 'big-notes', more: '1:999999' });
    assert.match(past.text, /Nothing more: the part before was the last\./u);
    assert.equal(past.more, null);
  });

  // ── 6 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  await t.test("6. draft answers a card of this chat with its rewrite's sentences before and now; another chat's card is WIKI_SCHEMA", async () => {
    const drafted = await api('POST', '/api/runner/wiki/changesets', hpc.token, {
      ops: [{ op: 'amend', entryId: pub(E_CONV), baseRevision: 1, changes: { summary: 'A runner holds a turn for two minutes now.' }, sources: [{ kind: 'turn', session: 'self', quote: QUOTE }] }],
      rationale: 'the owner says so', idempotencyKey: `read-card-${RUN}`,
    }, asSession(chat));
    assert.equal(drafted.status, 200, drafted.text);
    const cardId = toUuid(drafted.json.draftId);
    const before = await ok({ draft: pub(cardId) });
    assert.equal(before.view, 'draft');
    assert.match(before.text, new RegExp(`\\nCard ${pub(cardId)} · .+ · draft\\n`, 'u'));
    assert.ok(before.text.includes('"state": "draft"'), before.text);
    assert.ok(before.text.includes('"key": "turn-delivery"'), 'the sections it rewrites');
    const foreign = await read(otherChat, { draft: pub(cardId) });
    assert.deepEqual([foreign.status, foreign.json.code], [400, 'WIKI_SCHEMA'], foreign.text);

    // The owner applies it, and its follow job rewrites the section as the job would: the section kept as a version.
    const applied = await api('POST', `/api/wiki/chat-drafts/${pub(cardId)}/apply`, ownerToken, {});
    assert.equal(applied.status, 200, applied.text);
    const job = (await sql.query(`SELECT "id"::text AS "id" FROM "wiki_job" WHERE "space_id" = $1::uuid AND "kind" = 'docs_follow' AND "input"::text LIKE $2`,
      [spaceId, `%${cardId}%`])).rows[0] as { id: string };
    assert.ok(job, 'its press is on a follow job');
    const section = await prisma.wikiDocSection.findFirstOrThrow({
      where: { docId: runtime.id, key: 'turn-delivery' },
      include: { sentences: { orderBy: { position: 'asc' }, include: { footnotes: { orderBy: { position: 'asc' } } } } },
    });
    const footnotes: Array<Record<string, unknown>> = [];
    const kept = section.sentences.map((s) => ({
      block: s.block, text: s.text, status: s.status, newTokens: [], withdrawn: null,
      notes: s.footnotes.map((f) => footnotes.push({ kind: f.kind, ref: f.ref, sha: f.sha, lineStart: f.lineStart, lineEnd: f.lineEnd, locator: f.locator, viaEntryId: f.viaEntryId }) - 1),
    }));
    const version = await prisma.wikiDocSectionVersion.create({
      data: {
        spaceId, ownerId, docSlug: 'sessions-runtime', sectionKey: 'turn-delivery', blocks: section.blocks as never, sentences: kept as never,
        footnotes: footnotes as never, repoSha: section.repoSha, materialSha256: section.materialSha256, model: section.model,
        generatedAt: section.generatedAt, reason: 'chat', reasonTitle: 'a chat', jobId: job.id,
      },
    });
    const NOW = 'The runner holds one turn for two minutes.';
    await prisma.wikiDocSentence.deleteMany({ where: { sectionId: section.id } });
    await prisma.wikiDocSentence.create({ data: { sectionId: section.id, ownerId, position: 0, block: 0, text: NOW, status: 'transition' } });
    const report = {
      kind: 'docs_follow', sha: SHA, left: 0, usage: { inputTokens: 0, outputTokens: 0, calls: 0 },
      sections: [{ doc: 'sessions-runtime', key: 'turn-delivery', outcome: 'written', changed: 3, versionId: version.id, forced: true, draftIds: [cardId] }],
    };
    await sql.query(`UPDATE "wiki_job" SET "state" = 'succeeded', "ended_at" = now(), "report" = $2::jsonb WHERE "id" = $1::uuid`, [job.id, JSON.stringify(report)]);

    const after = await ok({ draft: pub(cardId) });
    assert.match(after.text, new RegExp(`\\nCard ${pub(cardId)} · .+ · applied\\n`, 'u'));
    const rewrite = after.text.slice(after.text.indexOf('Its rewrite, section by section'));
    assert.ok(rewrite.startsWith('Its rewrite, section by section: the sentences before it and as they stand now.\n1.1 §2 · updated, 3 changed\n  Before:\n'), rewrite);
    const [was, now] = rewrite.split('\n  Now:\n');
    assert.ok(was!.includes(`    ${S_SHOWN}`) && was!.includes(`    ${S_MIXED}`), 'the sentences before it');
    assert.ok(!was!.includes(S_WITHHELD), 'the taint rule holds before a rewrite too');
    assert.ok(now!.includes(`    ${NOW}`) && !now!.includes(S_SHOWN), 'and as they stand now');
  });

  // ── 7 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  await t.test('7. a draft of the plan that waits for the owner, and the queued writer jobs, are told before wiki_draft would refuse', async () => {
    await prisma.wikiPlan.create({
      data: { spaceId, ownerId, version: 2, status: 'draft', origin: 'owner', authorUserId: ownerId, docsMin: 1, docsMax: 10, gate: {}, categories },
    });
    await sql.query(`INSERT INTO "wiki_job"("id","owner_id","space_id","kind","state") VALUES (gen_random_uuid(),$1,$2,'maintain','queued'), (gen_random_uuid(),$1,$2,'articles','queued')`,
      [ownerId, spaceId]);
    const answer = await ok({ q: 'lease' });
    assert.deepEqual(answer.planDraft, { version: 2 });
    const jobs = await writers();
    assert.ok(jobs.some(([kind, state]) => kind === 'maintain' && state === 'queued'));
    assert.deepEqual(answer.writerJobs.map((job) => [job.kind, job.state]), jobs, 'the jobs that write documents alone');
    assert.ok(!answer.writerJobs.some((job) => job.kind === 'articles'), 'an articles job writes no document');
    const lines = answer.text.split('\n');
    assert.equal(lines[1], 'Plan: version 1 is in force.');
    assert.match(lines[2]!, /^Plan draft: version 2 waits for the owner on the Plan page\. .*WIKI_PLAN_STALE/u);
    assert.equal(lines[3], `Writer jobs: ${jobs.map(([kind, state]) => `${kind} ${state}`).join(', ')}.`);
  });
});
