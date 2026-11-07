/**
 * A wiki chat's cards and the owner's presses (contracts/wiki.contract.json `agentSurface.chat`, `chat.drafts`,
 * `chat.presses`, `reviewModes.chat`; docs/wiki-contract.md §7.7, §11, §28.5–§28.9; design docs/wiki-chat-design.md §7;
 * wiki chat project task C6), held against the production apiserver — `build/main.js`, the whole AppModule — over a real
 * PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/wiki/wiki-chat-drafts.pg.spec.ts
 *
 * Two accounts, one machine that beats, one space on a repository with a confirmed plan and a written document. In order:
 *
 *   1. in Manual, Tiered and Automatic alike a chat's wiki_propose drafts every op — add, amend, reinforce, challenge,
 *      retire and a principle's add — as one card, answered the same in all three: nothing of the wiki is written (no
 *      changeset, op, entry, revision, source or flag), nothing waits in Review, and no place is taken — the card is made
 *      while the space's review queue is full, with more ops than a turn may hold;
 *   2. an ordinary session's wiki_propose is what it was in each mode, and its principle is refused WIKI_KIND_OWNER_ONLY;
 *   3. Discard marks the card and writes nothing else;
 *   4. Apply, with the space in Automatic: one changeset of origin agent whose session is the chat, every op accepted —
 *      confirmed, a principle the owner's, a reinforce's sources added with its trust unchanged — and no verification;
 *      the challenge flags its entry and waits in Review, counted in the space's pendingOps, until Re-confirm clears it;
 *      the card's Rewrites queued as forced sections of a follow job at priority 1;
 *   5. a card whose base moved reads Changed since this draft, and its Apply is refused WIKI_REVISION_CONFLICT with
 *      nothing written;
 *   6. Edit lays the owner's changes over an op, recorded edited, the revision the owner's;
 *   7. Undo through the card and through the revert route, on twin cards: the add retired, the amend's entry back to the
 *      revision and the trust it had before the Apply, the section the card's rewrite wrote restored — the same rows by
 *      either door; and a queued follow job loses the card's press;
 *   8. a card replaces an open card of its chat, and nothing else;
 *   9. a wiki_note's corrects in a chat drafts its challenge as a card;
 *  10. wiki_draft is a chat's alone: its shape, its refusals (a plan change of no proposal's shape is the plan gate's,
 *      C12), its rewrite card, Try again and seen, and chatWaiting;
 *      and a follow job's write of a section only undone cards asked for writes nothing (`WikiDocs.store`);
 *  11. the next message tells the agent what was pressed, once (`<orbit_wiki_drafts>`);
 *  12. a card of a chat that ended reads Not applied;
 *  13. every press and read with a session header is refused WIKI_OWNER_CHANNEL_ONLY; another account's is the plain 404;
 *  14. the card read, a chat's cards and the chats list's counts.
 *
 * Not destructive: every row belongs to accounts this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { toUuid, uuidToBase62, WIKI_CHAT_COPY, WIKI_DOCS_FOLLOW, WIKI_DOCS_FOLLOW_WAITING } from '@orbit/shared';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { hashPassword } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import type { PushService } from '../push/push.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { appendWikiChatNotes } from './wiki-chat-notes';
import { WikiDocs, wikiDocsBuildJobPrincipal } from './wiki-docs';
import { WikiService } from './wiki.service';
import '../test-support/daemon-routes-over-http';

const URL_ = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const REPO_URL = `https://github.com/example/drafts-${RUN}`;
const SHA = '1f'.repeat(20);
const ENGINES = [{ engine: 'claude', installed: true, auth: 'yes', version: '2.3.0' }];
const CAPABILITIES = 'source-pin/v1';
const QUOTE = 'the lease is two minutes on main now';
const WORDS = `The wiki says ninety seconds, but ${QUOTE}. Fix what the wiki knows.`;
const MODES = ['manual', 'tiered', 'automatic'] as const;

/** A body without the public-id twins every answer carries beside its ids. */
const withoutTwins = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutTwins);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !/(?:^p|P)ublicIds?$/u.test(key))
    .map(([key, one]) => [key, withoutTwins(one)]));
};

test('a wiki chat drafts cards, and only the owner presses them', { skip: !URL_, concurrency: 1, timeout: 900_000 }, async (t) => {
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

  const account = async (name: string) => {
    const id = randomUUID();
    const password = `pw-${name}-${RUN}`;
    const email = `${name}-${RUN}@wiki-drafts.invalid`;
    await sql.query(`INSERT INTO "user" (id, email, name, password_hash, role) VALUES ($1, $2, $3, $4, 'MEMBER')`,
      [id, email, name, hashPassword(password)]);
    return { id, email, password };
  };
  const owner = await account('owner');
  const stranger = await account('stranger');
  server = await startApiserver(url, `wiki-drafts-${randomUUID()}`);
  const api = (method: string, route: string, bearer?: string, body?: unknown, headers?: Record<string, string>): Promise<Reply> =>
    call(server!, method, route, bearer, body, headers);
  const signIn = async (who: { email: string; password: string }) => {
    const reply = await api('POST', '/api/auth/login', undefined, { email: who.email, password: who.password });
    assert.equal(reply.status, 201, reply.text);
    return reply.json.accessToken as string;
  };
  const ownerToken = await signIn(owner);
  const strangerToken = await signIn(stranger);
  const minted = await api('POST', '/api/runners/enrollment-tokens', ownerToken, { label: `wiki drafts ${RUN}` });
  assert.equal(minted.status, 201, minted.text);
  const registered = await api('POST', '/api/runner/register', undefined, { enrollmentToken: minted.json.token, name: `hpc-${RUN}`, hostname: `hpc-${RUN}` });
  assert.equal(registered.status, 201, registered.text);
  const hpc = { runnerId: toUuid(registered.json.runnerId), token: registered.json.runnerToken as string };
  const beat = async () => {
    const reply = await api('POST', '/api/runner/heartbeat', hpc.token, { status: 'ONLINE', engines: ENGINES }, { 'x-orbit-runner-capabilities': CAPABILITIES });
    assert.equal(reply.status < 300, true, reply.text);
  };
  await beat();
  const workspace = async (name: string) => {
    const id = randomUUID();
    await sql.query(
      `INSERT INTO "workspace" (id, name, owner_id, runner_id, work_dir, repo_url, enable_worktree) VALUES ($1, $2, $3, $4, $5, $6, true)`,
      [id, name, owner.id, hpc.runnerId, `/srv/${name}`, REPO_URL],
    );
    return id;
  };
  const wsChat = await workspace('orbit-develop');
  const wsPlain = await workspace('orbit-plain');
  const pub = (id: string) => uuidToBase62(id);

  // ── the space: a confirmed plan of one document, two of its sections written ─────────────────────────────────────
  const made = await api('POST', '/api/wiki/spaces', ownerToken, { title: `Orbit ${RUN}`, repoUrl: REPO_URL });
  assert.equal(made.status, 201, made.text);
  const spaceId = toUuid(made.json.id);
  const planId = randomUUID();
  await prisma.wikiPlan.create({
    data: {
      id: planId, spaceId, ownerId: owner.id, version: 1, status: 'confirmed', origin: 'owner', authorUserId: owner.id,
      confirmedByUserId: owner.id, confirmedAt: new Date(), docsMin: 1, docsMax: 10, gate: {},
      categories: [{ key: 'runtime', title: 'Runtime', question: 'How does it run?', forAgents: false }],
    },
  });
  const planDoc = await prisma.wikiPlanDoc.create({
    data: {
      planId, ownerId: owner.id, position: 0, category: 'runtime', slug: 'sessions-runtime', title: 'Sessions runtime',
      question: 'How does a session run?', audience: ['A new contributor'], scopeIn: ['Turns'], scopeOut: [] as never, lengthMin: 100, lengthMax: 2000,
    },
  });
  for (const [position, section] of [['overview', 'Overview'], ['turn-delivery', 'Turn delivery'], ['leases', 'Leases']].entries()) {
    await prisma.wikiPlanSection.create({
      data: { docId: planDoc.id, ownerId: owner.id, position, key: section[0]!, title: section[1]!, kind: 'flow', covers: 'what it covers', length: 200, sources: {} },
    });
  }
  const doc = await prisma.wikiDoc.create({
    data: { spaceId, ownerId: owner.id, slug: 'sessions-runtime', planId, planVersion: 1, planDocId: planDoc.id, status: 'ok', repoSha: SHA },
  });

  // ── the entries the owner wrote, and what a review mode applied (trust unreviewed) ──────────────────────────────
  const ownerAdd = async (kind: string, title: string, fields: Record<string, unknown>, summary = `${title}, as the owner wrote it.`) => {
    const reply = await api('POST', `/api/wiki/spaces/${pub(spaceId)}/changesets`, ownerToken, {
      ops: [{ op: 'add', entry: { kind, title, summary, fields } }],
      rationale: 'the owner writes it', idempotencyKey: `owner-${randomUUID()}`,
    });
    assert.equal(reply.status, 200, reply.text);
    return toUuid(reply.json.ops[0].entryId);
  };
  const machineTrust = (entryId: string) => sql.query(`UPDATE "wiki_entry" SET "trust" = 'unreviewed' WHERE "id" = $1::uuid`, [entryId]);
  const E_CONV = await ownerAdd('convention', 'Leases last ninety seconds', { rule: 'A runner holds a turn for ninety seconds.', scope: ['src/runner-go'] });
  await machineTrust(E_CONV);
  const E_REIN = await ownerAdd('concept', 'Turn lease', { definition: 'How long a runner holds a turn.', boundaries: 'Not the session lease.' });
  const E_CHAL = await ownerAdd('concept', 'Steer delivery', { definition: 'A steer joins the running turn.', boundaries: 'Not a new turn.' });
  const E_RET = await ownerAdd('concept', 'The old inbox poll', { definition: 'The inbox was polled every second.', boundaries: 'Before leases.' });
  const TWIN_SUMMARY = 'Reclaim waits one whole lease, as the owner wrote it.';
  const E_A = await ownerAdd('convention', 'Twin A: reclaim waits a lease', { rule: 'Reclaim waits a whole lease.', scope: ['src/runner-go'] }, TWIN_SUMMARY);
  const E_B = await ownerAdd('convention', 'Twin B: reclaim waits a lease', { rule: 'Reclaim waits a whole lease.', scope: ['src/runner-go'] }, TWIN_SUMMARY);
  await machineTrust(E_A);
  await machineTrust(E_B);

  // The written sections: turn-delivery cites a record through E_CONV (a card amending it rewrites that section), leases
  // holds one sentence of its own.
  const writeSection = async (key: string, text: string, via: string | null) => {
    const row = await prisma.wikiDocSection.create({
      data: { docId: doc.id, ownerId: owner.id, key, planSectionId: randomUUID(), materialSha256: 'f'.repeat(64), blocks: [{ kind: 'paragraph' }] as never, repoSha: SHA, model: 'spec-model' },
    });
    const sentence = await prisma.wikiDocSentence.create({ data: { sectionId: row.id, ownerId: owner.id, position: 0, block: 0, text, status: via ? 'sourced' : 'transition' } });
    if (via) {
      await prisma.wikiDocFootnote.create({
        data: {
          sentenceId: sentence.id, ownerId: owner.id, position: 0, kind: 'turn', ref: randomUUID(), sha: null, charStart: 0, charEnd: 5,
          locator: { sessionId: randomUUID() }, quote: 'lease', verdict: 'verified', checkedBy: 'server', viaEntryId: via,
        } as never,
      });
    }
  };
  await writeSection('turn-delivery', 'The runner leases one turn at a time.', E_CONV);
  const LEASES_BEFORE = 'A lease expires after ninety seconds.';
  await writeSection('leases', LEASES_BEFORE, null);

  const settings = (body: Record<string, unknown>) => api('PATCH', `/api/wiki/spaces/${pub(spaceId)}`, ownerToken, body);
  const setMode = async (mode: string) => {
    const reply = await settings({ reviewMode: mode });
    assert.equal(reply.status, 200, reply.text);
  };
  const chatPage = { page: { kind: 'doc', docSlug: 'sessions-runtime', sectionKey: 'leases' } };
  const newChat = async (wikiContext: unknown = chatPage, content = WORDS) => {
    const reply = await api('POST', `/api/wiki/spaces/${pub(spaceId)}/chats`, ownerToken,
      { workspaceId: pub(wsChat), content, clientTurnId: randomUUID(), ...(wikiContext ? { wikiContext } : {}) });
    assert.equal(reply.status, 201, reply.text);
    return toUuid(reply.json.sessionId);
  };
  const ordinarySession = async () => {
    const reply = await api('POST', '/api/sessions', ownerToken, { prompt: `An ordinary session: ${QUOTE}.`, workspaceId: pub(wsPlain) });
    assert.equal(reply.status, 201, reply.text);
    return toUuid(reply.json.id);
  };
  const asSession = (sessionId: string) => ({ 'x-orbit-session-id': pub(sessionId) });
  const propose = (sessionId: string, body: Record<string, unknown>) => api('POST', '/api/runner/wiki/changesets', hpc.token, body, asSession(sessionId));
  const draft = (sessionId: string, body: Record<string, unknown>) => api('POST', '/api/runner/wiki/drafts', hpc.token, body, asSession(sessionId));
  const card = (draftId: string, bearer = ownerToken, headers?: Record<string, string>) => api('GET', `/api/wiki/chat-drafts/${pub(draftId)}`, bearer, undefined, headers);
  const press = (draftId: string, what: string, body?: unknown, bearer = ownerToken, headers?: Record<string, string>) =>
    api('POST', `/api/wiki/chat-drafts/${pub(draftId)}/${what}`, bearer, body ?? {}, headers);
  const source = { kind: 'turn', session: 'self', quote: QUOTE };
  const entryRow = async (id: string) => (await sql.query(`SELECT * FROM "wiki_entry" WHERE "id" = $1::uuid`, [id])).rows[0];
  const count = async (query: string, values: unknown[] = []) => Number((await sql.query(query, values)).rows[0].n);
  const writes = async () => ({
    changesets: await count(`SELECT count(*)::int AS n FROM "wiki_changeset" WHERE "space_id" = $1::uuid`, [spaceId]),
    ops: await count(`SELECT count(*)::int AS n FROM "wiki_changeset_op" o JOIN "wiki_changeset" c ON c."id" = o."changeset_id" WHERE c."space_id" = $1::uuid`, [spaceId]),
    entries: await count(`SELECT count(*)::int AS n FROM "wiki_entry" WHERE "space_id" = $1::uuid`, [spaceId]),
    revisions: await count(`SELECT count(*)::int AS n FROM "wiki_entry_revision" r JOIN "wiki_entry" e ON e."id" = r."entry_id" WHERE e."space_id" = $1::uuid`, [spaceId]),
    sources: await count(`SELECT count(*)::int AS n FROM "wiki_source" s JOIN "wiki_entry_revision" r ON r."id" = s."revision_id" JOIN "wiki_entry" e ON e."id" = r."entry_id" WHERE e."space_id" = $1::uuid`, [spaceId]),
    challenged: await count(`SELECT count(*)::int AS n FROM "wiki_entry" WHERE "space_id" = $1::uuid AND "challenged"`, [spaceId]),
    verifyJobs: await count(`SELECT count(*)::int AS n FROM "wiki_job" WHERE "space_id" = $1::uuid AND "kind" = 'verify'`, [spaceId]),
  });
  const spaceRow = async () => {
    const reply = await api('GET', '/api/wiki/spaces', ownerToken);
    assert.equal(reply.status, 200, reply.text);
    return (reply.json as Array<{ id: string; pendingOps: number; chatWaiting: number }>).find((row) => toUuid(row.id) === spaceId)!;
  };
  const followJobs = async () => (await sql.query(
    `SELECT "id"::text AS "id", "state", "priority", "input" FROM "wiki_job" WHERE "space_id" = $1::uuid AND "kind" = 'docs_follow' ORDER BY "created_at", "id"`,
    [spaceId])).rows as Array<{ id: string; state: string; priority: number; input: { facts: Array<Record<string, unknown>> } }>;
  const draftRow = async (id: string) => (await sql.query(`SELECT * FROM "wiki_chat_draft" WHERE "id" = $1::uuid`, [id])).rows[0];

  /** Six ops, one of each kind a chat drafts: add, amend, reinforce, challenge, retire, and a principle's add. */
  const sixOps = () => [
    { op: 'add', entry: { kind: 'concept', title: 'Lease length on main', summary: 'A turn lease lasts two minutes on main.', fields: { definition: 'Two minutes.', boundaries: 'Turn leases only.' } }, sources: [source] },
    { op: 'amend', entryId: pub(E_CONV), baseRevision: 1, changes: { summary: 'A runner holds a turn for two minutes now.' }, sources: [source] },
    { op: 'reinforce', entryId: pub(E_REIN), sources: [source] },
    { op: 'challenge', entryId: pub(E_CHAL), reason: 'The owner says a steer no longer joins the running turn.' },
    { op: 'retire', entryId: pub(E_RET), baseRevision: 1, reason: 'The inbox has not been polled since leases.' },
    { op: 'add', entry: { kind: 'principle', title: 'The owner words what the wiki holds', summary: 'What the owner says in a chat is first-hand.', fields: { statement: 'Owner words are first-hand.', rationale: 'They were said by the owner.' } }, sources: [source] },
  ];

  // ── 1 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  const chats: Record<string, string> = {};
  const cards: Record<string, string> = {};
  await t.test('1. in Manual, Tiered and Automatic alike every op of a chat drafts one card: nothing written, nothing in Review, no place taken', async () => {
    // A full review queue: thirty ops wait on the owner. An ordinary proposal is refused for it; a card takes no place in it.
    const filler = randomUUID();
    await sql.query(`INSERT INTO "wiki_changeset" ("id","owner_id","space_id","origin","status","expires_at") VALUES ($1,$2,$3,'agent','pending',now() + interval '7 days')`,
      [filler, owner.id, spaceId]);
    for (let seq = 0; seq < 30; seq += 1) {
      await sql.query(`INSERT INTO "wiki_changeset_op" ("id","changeset_id","owner_id","seq","op","payload") VALUES (gen_random_uuid(),$1,$2,$3,'add','{}')`,
        [filler, owner.id, seq]);
    }
    await setMode('manual');
    const plain = await ordinarySession();
    const refused = await propose(plain, { ops: [sixOps()[0]], rationale: 'r', idempotencyKey: `plain-full-${RUN}` });
    assert.equal(refused.status, 429, refused.text);
    assert.equal(refused.json.ops[0].reasons[0].code, 'WIKI_REVIEW_QUEUE_FULL', 'the queue is full for an ordinary session');

    const answers: unknown[] = [];
    for (const mode of MODES) {
      await setMode(mode);
      const before = await writes();
      const pendingBefore = (await spaceRow()).pendingOps;
      chats[mode] = await newChat();
      const answer = await propose(chats[mode]!, { ops: sixOps(), rationale: 'What the owner said in the chat.', idempotencyKey: `six-${mode}-${RUN}` });
      assert.equal(answer.status, 200, `${mode}: ${answer.text}`);
      const body = withoutTwins(answer.json) as Record<string, any>;
      assert.equal(body.status, 'draft', `${mode}: a card`);
      cards[mode] = toUuid(body.draftId);
      assert.deepEqual(body.ops.map((op: { status: string }) => op.status), ['draft', 'draft', 'draft', 'draft', 'draft', 'draft'],
        `${mode}: six ops — more than a turn holds — all drafted, the principle with them`);
      assert.deepEqual(body.rewrites.map((r: { doc: string; key: string; where: string; title: string }) => [r.key, r.where, r.title]),
        [['leases', '1.1 §3', 'Leases'], ['turn-delivery', '1.1 §2', 'Turn delivery']],
        `${mode}: the attached section first, then the one a footnote of E_CONV is in`);
      assert.deepEqual(await writes(), before, `${mode}: nothing of the wiki was written`);
      assert.equal((await spaceRow()).pendingOps, pendingBefore, `${mode}: nothing waits in Review for it`);
      const row = await draftRow(cards[mode]!);
      assert.deepEqual([row.kind, row.session_id, row.space_id, row.decision, row.ops.length, row.tainted], ['entry', chats[mode], spaceId, null, 6, false]);
      answers.push({ ...body, draftId: 'D' });
    }
    assert.deepEqual(answers[1], answers[0], 'Tiered answers as Manual does');
    assert.deepEqual(answers[2], answers[0], 'Automatic answers as Manual does');
    // The same call again under its key is the card it made.
    const again = await propose(chats.manual!, { ops: sixOps(), rationale: 'What the owner said in the chat.', idempotencyKey: `six-manual-${RUN}` });
    assert.deepEqual([again.status, again.json.replayed, toUuid(again.json.draftId)], [200, true, cards.manual]);
    const reused = await propose(chats.manual!, { ops: [sixOps()[0]], rationale: 'another', idempotencyKey: `six-manual-${RUN}` });
    assert.equal(reused.json.code ?? reused.json.ops?.[0]?.reasons?.[0]?.code, 'WIKI_IDEMPOTENCY_KEY_REUSED', reused.text);
    // A dry run checks and makes nothing; a request none of whose ops passed makes nothing and answers as ever.
    const dry = await propose(chats.manual!, { ops: sixOps(), rationale: 'r', idempotencyKey: `dry-${RUN}`, dryRun: true });
    assert.deepEqual([dry.status, dry.json.status, dry.json.draftId, dry.json.dryRun], [200, 'draft', null, true]);
    const none = await propose(chats.manual!, { ops: [{ op: 'amend', entryId: pub(E_CONV), baseRevision: 7, changes: { summary: 'x' }, sources: [source] }], rationale: 'r', idempotencyKey: `none-${RUN}` });
    assert.equal(none.status, 409, none.text);
    assert.deepEqual([none.json.status, none.json.changesetId, none.json.ops[0].status], [undefined, null, 'conflict'], 'no card, the answer a proposal has');
    assert.equal(await count(`SELECT count(*)::int AS n FROM "wiki_chat_draft" WHERE "session_id" = $1::uuid`, [chats.manual]), 1, 'only the one card');
    await sql.query(`DELETE FROM "wiki_changeset" WHERE "id" = $1::uuid`, [filler]);
  });

  // ── 2 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  await t.test("2. an ordinary session's wiki_propose is what it was, in every mode", async () => {
    for (const mode of MODES) {
      await setMode(mode);
      const plain = await ordinarySession();
      const before = await writes();
      const answer = await propose(plain, { ops: [sixOps()[0]], rationale: 'the session learned it', idempotencyKey: `plain-${mode}-${RUN}` });
      assert.equal(answer.status, 200, `${mode}: ${answer.text}`);
      assert.equal(answer.json.status, undefined, `${mode}: no card`);
      assert.equal(answer.json.draftId, undefined);
      assert.equal(typeof answer.json.changesetId, 'string', `${mode}: a changeset recorded`);
      const op = answer.json.ops[0];
      if (mode === 'manual') assert.deepEqual([op.status, op.waitsFor], ['pending', undefined], 'Manual: it waits for the owner');
      if (mode === 'automatic') assert.deepEqual([op.status, op.waitsFor], ['pending', 'verification'], 'Automatic: it waits for its verdict');
      if (mode === 'tiered') assert.ok(['applied', 'pending'].includes(op.status), `Tiered: as its mode says (${op.status})`);
      const after = await writes();
      assert.equal(after.changesets, before.changesets + 1);
      assert.equal(after.ops, before.ops + 1);
      if (mode === 'automatic') assert.equal(after.verifyJobs, before.verifyJobs + 1, 'and the server verifies it');
      assert.equal(await count(`SELECT count(*)::int AS n FROM "wiki_chat_draft" WHERE "session_id" = $1::uuid`, [plain]), 0, 'no card for a session that is no chat');
      const principle = await propose(plain, { ops: [sixOps()[5]], rationale: 'r', idempotencyKey: `plain-principle-${mode}-${RUN}` });
      assert.equal(principle.status, 403, principle.text);
      assert.equal(principle.json.ops[0].reasons[0].code, 'WIKI_KIND_OWNER_ONLY', `${mode}: a principle is the owner's to write`);
    }
  });

  // ── 3 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  await t.test('3. Discard marks the card and writes nothing else', async () => {
    const before = await writes();
    const discarded = await press(cards.tiered!, 'discard');
    assert.equal(discarded.status, 200, discarded.text);
    assert.deepEqual([discarded.json.replayed, discarded.json.draft.state, discarded.json.draft.decision], [false, 'discarded', 'discarded']);
    assert.deepEqual(await writes(), before, 'no rejection, no reason, no counter-example');
    assert.equal(await count(`SELECT count(*)::int AS n FROM "wiki_entry" WHERE "space_id" = $1::uuid AND "status" = 'rejected'`, [spaceId]), 0);
    const twice = await press(cards.tiered!, 'discard');
    assert.deepEqual([twice.status, twice.json.replayed], [200, true], 'the same press twice answers the first');
    const apply = await press(cards.tiered!, 'apply');
    assert.equal(apply.status, 409, apply.text);
    assert.match(apply.json.message, /this card is discarded/u);
    assert.equal(apply.json.code, undefined, 'a plain 409, naming its state');
    assert.deepEqual(await writes(), before);
  });

  // ── 4 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  let challengeOp = '';
  let applyChangeset = '';
  await t.test('4. Apply records one changeset of the chat and accepts it — confirmed, a principle the owner\'s, no verification — and queues its rewrite', async () => {
    // Automatic, the mode that would otherwise verify every op: a card is no op of the mode.
    await setMode('automatic');
    const before = await writes();
    const pendingBefore = (await spaceRow()).pendingOps;
    const conv = await entryRow(E_CONV);
    const reinSources = await count(`SELECT count(*)::int AS n FROM "wiki_source" s JOIN "wiki_entry_revision" r ON r."id" = s."revision_id" WHERE r."entry_id" = $1::uuid`, [E_REIN]);
    const applied = await press(cards.manual!, 'apply');
    assert.equal(applied.status, 200, applied.text);
    const view = withoutTwins(applied.json.draft) as Record<string, any>;
    assert.deepEqual([view.state, view.decision, view.undoable], ['applied', 'applied', false], 'applied; a card with a retire is not undoable');
    applyChangeset = toUuid(view.changesetId);
    const changeset = (await sql.query(`SELECT * FROM "wiki_changeset" WHERE "id" = $1::uuid`, [applyChangeset])).rows[0];
    assert.deepEqual([changeset.origin, changeset.session_id, changeset.idempotency_key, changeset.status],
      ['agent', chats.manual, `wiki-chat:${cards.manual}`, 'pending'], "origin agent, the chat its session; open while the challenge waits");
    const ops = (await sql.query(`SELECT * FROM "wiki_changeset_op" WHERE "changeset_id" = $1::uuid ORDER BY "seq"`, [applyChangeset])).rows;
    assert.deepEqual(ops.map((op) => [op.op, op.decision, op.applied_by_mode, op.spot_check]), [
      ['add', 'accepted', null, false], ['amend', 'accepted', null, false], ['reinforce', 'accepted', null, false],
      ['challenge', 'pending', null, false], ['retire', 'accepted', null, false], ['add', 'accepted', null, false],
    ], 'every op accepted by the owner, the challenge waiting in Review; nothing by the mode, no spot check, nothing verifying');
    challengeOp = ops[3].id;
    const added = await entryRow(ops[0].result_entry_id);
    assert.deepEqual([added.status, added.trust], ['active', 'confirmed'], 'an add is confirmed');
    const principle = await entryRow(ops[5].result_entry_id);
    assert.deepEqual([principle.kind, principle.status, principle.trust], ['principle', 'active', 'owner'], "a principle is the owner's own write");
    const amended = await entryRow(E_CONV);
    assert.deepEqual([amended.current_revision, amended.trust, amended.summary], [conv.current_revision + 1, 'confirmed', 'A runner holds a turn for two minutes now.'],
      'the amend applied, and what the machine wrote is the owner\'s to vouch for now');
    const reinforced = await entryRow(E_REIN);
    assert.equal(reinforced.trust, 'owner', "a reinforce leaves the entry's trust as it found it");
    assert.equal(await count(`SELECT count(*)::int AS n FROM "wiki_source" s JOIN "wiki_entry_revision" r ON r."id" = s."revision_id" WHERE r."entry_id" = $1::uuid`, [E_REIN]),
      reinSources + 1, 'and adds its source');
    const challenged = await entryRow(E_CHAL);
    assert.deepEqual([challenged.challenged, challenged.trust, challenged.status], [true, 'owner', 'active'], 'the challenge flags the entry, and confirms nothing');
    assert.equal((await entryRow(E_RET)).status, 'retired');
    const after = await writes();
    assert.equal(after.verifyJobs, before.verifyJobs, 'no verification, even in Automatic');
    assert.equal((await spaceRow()).pendingOps, pendingBefore + 1, "the challenge counts in the space's waiting number");
    const review = await api('GET', `/api/wiki/review?space=${pub(spaceId)}`, ownerToken);
    assert.equal(review.status, 200, review.text);
    assert.ok(JSON.stringify(review.json).includes(pub(challengeOp)), 'and waits in Review');
    // The card reads as raised: its challenge op pending, its entry challenged, its trust untouched — not confirmed.
    const challengeView = view.ops[3];
    assert.deepEqual([challengeView.op, challengeView.decision, challengeView.entry.challenged, challengeView.entry.trust], ['challenge', 'pending', true, 'owner']);
    assert.deepEqual(view.ops.map((op: { decision: string }) => op.decision), ['accepted', 'accepted', 'accepted', 'pending', 'accepted', 'accepted']);
    // The rewrite: the card's two sections marked stale and queued as forced sections of a follow job at priority 1.
    const jobs = await followJobs();
    const job = jobs.find((one) => one.input.facts.some((fact) => fact.draftId === cards.manual));
    assert.ok(job, 'a follow job carries the press');
    assert.deepEqual([job!.state, job!.priority], ['queued', WIKI_DOCS_FOLLOW.priorities.press]);
    const fact = job!.input.facts.find((one) => one.draftId === cards.manual)!;
    assert.deepEqual([fact.kind, fact.chatId, fact.sections], ['press', chats.manual, [{ doc: 'sessions-runtime', key: 'leases' }, { doc: 'sessions-runtime', key: 'turn-delivery' }]]);
    assert.equal((fact.entryIds as string[]).length, 6, 'with the entries it wrote');
    const stale = (await sql.query(`SELECT "key", "stale_at" IS NOT NULL AS "stale" FROM "wiki_doc_section" WHERE "doc_id" = $1::uuid ORDER BY "key"`, [doc.id])).rows;
    assert.deepEqual(stale, [{ key: 'leases', stale: true }, { key: 'turn-delivery', stale: true }]);
    // No wiki-worker runs here, so the job is held up, and the card says why: nothing blocks in silence (design §11).
    assert.deepEqual([view.rewrite?.result, view.rewrite?.jobId && toUuid(view.rewrite.jobId)], ['waiting', job!.id], 'the card reads its rewrite');
    assert.ok((WIKI_DOCS_FOLLOW_WAITING as readonly string[]).includes(view.rewrite.reason), `a waiting reason: ${view.rewrite.reason}`);
    assert.equal((await spaceRow()).chatWaiting, 1, 'and a held-up rewrite waits on the owner');
    // The same press again answers the first.
    const again = await press(cards.manual!, 'apply');
    assert.deepEqual([again.status, again.json.replayed, again.json.draft.state], [200, true, 'applied']);
    assert.equal(await count(`SELECT count(*)::int AS n FROM "wiki_changeset" WHERE "idempotency_key" = $1`, [`wiki-chat:${cards.manual}`]), 1);
    const undo = await press(cards.manual!, 'undo');
    assert.equal(undo.status, 409, undo.text);
    assert.match(undo.json.message, /cannot be undone/u);
    // Re-confirm in Review answers the challenge, and the flag goes.
    const decided = await api('POST', `/api/wiki/changesets/${pub(applyChangeset)}/decide`, ownerToken, { decisions: [{ opId: pub(challengeOp), action: 'reconfirm' }] });
    assert.equal(decided.status, 200, decided.text);
    assert.equal((await entryRow(E_CHAL)).challenged, false, 'Re-confirm clears it');
  });

  // ── 5 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  await t.test('5. a card whose base moved reads Changed since this draft, and its Apply writes nothing', async () => {
    const read = await card(cards.automatic!);
    assert.equal(read.status, 200, read.text);
    assert.equal(read.json.state, 'changed', 'E_CONV left revision 1 and E_RET left active');
    const before = await writes();
    const applied = await press(cards.automatic!, 'apply');
    assert.equal(applied.status, 409, applied.text);
    assert.equal(applied.json.code, 'WIKI_REVISION_CONFLICT');
    assert.deepEqual(await writes(), before, 'nothing was written');
    assert.equal((await draftRow(cards.automatic!)).decision, null);
    const discarded = await press(cards.automatic!, 'discard');
    assert.deepEqual([discarded.status, discarded.json.draft.state], [200, 'discarded'], 'Redo or Discard');
  });

  // ── 6 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  await t.test("6. Edit lays the owner's changes over the card's op, recorded edited, the revision the owner's", async () => {
    const chat = await newChat(null);
    const drafted = await propose(chat, {
      ops: [{ op: 'add', entry: { kind: 'concept', title: 'Reclaim of a lease', summary: 'A runner reclaims an expired lease.', fields: { definition: 'Taking a turn back.', boundaries: 'Expired leases.' } }, sources: [source] }],
      rationale: 'r', idempotencyKey: `edit-${RUN}`,
    });
    assert.equal(drafted.status, 200, drafted.text);
    const id = toUuid(drafted.json.draftId);
    const shapeless = await press(id, 'edit', { ops: [{ seq: 0 }] });
    assert.deepEqual([shapeless.status, shapeless.json.code], [400, 'WIKI_SCHEMA']);
    const unknown = await press(id, 'edit', { ops: [{ seq: 3, changes: { title: 'x' } }] });
    assert.deepEqual([unknown.status, unknown.json.code], [400, 'WIKI_SCHEMA'], 'no op 3 on this card');
    const edited = await press(id, 'edit', { ops: [{ seq: 0, changes: { title: 'Reclaiming an expired lease' } }] });
    assert.equal(edited.status, 200, edited.text);
    assert.deepEqual([edited.json.draft.state, edited.json.draft.decision], ['applied', 'edited']);
    const op = (await sql.query(`SELECT * FROM "wiki_changeset_op" WHERE "changeset_id" = $1::uuid`, [toUuid(edited.json.draft.changesetId)])).rows[0];
    assert.equal(op.decision, 'edited');
    const entry = await entryRow(op.result_entry_id);
    assert.deepEqual([entry.title, entry.trust, entry.current_revision], ['Reclaiming an expired lease', 'confirmed', 2]);
    const revisions = (await sql.query(`SELECT "revision", "author_kind", "author_user_id" FROM "wiki_entry_revision" WHERE "entry_id" = $1::uuid ORDER BY "revision"`, [entry.id])).rows;
    assert.deepEqual(revisions.map((r) => [r.revision, r.author_kind, r.author_user_id]), [[1, 'agent', null], [2, 'owner', owner.id]],
      "the proposal stays the chat's, and the edit is the owner's revision");
    const again = await press(id, 'apply');
    assert.equal(again.status, 409, 'an edited card is applied already');
  });

  // ── 6½ ────────────────────────────────────────────────────────────────────────────────────────────────────────
  await t.test("6½. an applied card's rewrite reads as its follow job's report says, and one that read the same waits until seen", async () => {
    const job = (await followJobs()).find((one) => one.input.facts.some((fact) => fact.draftId === cards.manual))!;
    const report = {
      kind: 'docs_follow', sha: SHA, left: 0, usage: { inputTokens: 0, outputTokens: 0, calls: 0 },
      sections: [
        { doc: 'sessions-runtime', key: 'leases', outcome: 'unchanged', changed: null, versionId: null, forced: true, draftIds: [cards.manual] },
        { doc: 'sessions-runtime', key: 'turn-delivery', outcome: 'written', changed: 1, versionId: null, forced: true, draftIds: [cards.manual] },
      ],
    };
    await sql.query(`UPDATE "wiki_job" SET "state" = 'succeeded', "ended_at" = now(), "report" = $2::jsonb WHERE "id" = $1::uuid`, [job.id, JSON.stringify(report)]);
    const read = await card(cards.manual!);
    assert.deepEqual([read.json.rewrite.result, read.json.rewrite.seen, read.json.rewrite.sections.map((s: { where: string; result: string; changed: number | null }) => [s.where, s.result, s.changed])],
      ['same', false, [['1.1 §3', 'same', null], ['1.1 §2', 'updated', 1]]]);
    assert.equal((await spaceRow()).chatWaiting, 1, 'a rewrite that read the same waits on the owner');
    const seen = await press(cards.manual!, 'seen');
    assert.deepEqual([seen.status, seen.json.seen], [200, true]);
    assert.equal((await spaceRow()).chatWaiting, 0, 'until they have seen it');
    const twice = await press(cards.manual!, 'seen');
    assert.deepEqual([twice.status, twice.json.replayed, twice.json.seen], [200, true, true], 'set once');
  });

  // ── 7 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  /** What a follow job's write of a section does to it, as the job would: the section as it stood kept as a version. */
  const rewriteAsTheJob = async (jobId: string, key: string, text: string) => {
    const section = await prisma.wikiDocSection.findFirstOrThrow({ where: { docId: doc.id, key }, include: { sentences: { orderBy: { position: 'asc' } } } });
    await prisma.wikiDocSectionVersion.create({
      data: {
        spaceId, ownerId: owner.id, docSlug: 'sessions-runtime', sectionKey: key, blocks: section.blocks as never,
        sentences: section.sentences.map((s) => ({ block: s.block, text: s.text, status: s.status, notes: [], newTokens: [], withdrawn: null })) as never,
        footnotes: [] as never, repoSha: section.repoSha, materialSha256: section.materialSha256, model: section.model,
        generatedAt: section.generatedAt, reason: 'chat', reasonTitle: 'a chat', jobId,
      },
    });
    await prisma.wikiDocSentence.deleteMany({ where: { sectionId: section.id } });
    await prisma.wikiDocSentence.create({ data: { sectionId: section.id, ownerId: owner.id, position: 0, block: 0, text, status: 'transition' } });
    await prisma.wikiDocSection.update({ where: { id: section.id }, data: { materialSha256: 'e'.repeat(64), generatedAt: new Date(), staleAt: null } });
  };
  const leasesText = async () => (await sql.query(
    `SELECT se."text" FROM "wiki_doc_sentence" se JOIN "wiki_doc_section" s ON s."id" = se."section_id" WHERE s."doc_id" = $1::uuid AND s."key" = 'leases' ORDER BY se."position"`,
    [doc.id])).rows.map((row) => row.text);
  let undoneCard = '';
  await t.test('7. Undo, through the card and through the revert route alike, takes the Apply back and restores what its rewrite wrote', async () => {
    await setMode('automatic');
    const twin = async (entryId: string, label: string) => {
      const chat = await newChat();
      const drafted = await propose(chat, {
        ops: [
          { op: 'add', entry: { kind: 'concept', title: `${label}: reclaim timing`, summary: 'Reclaim waits two minutes.', fields: { definition: 'Two minutes.', boundaries: 'Reclaim only.' } }, sources: [source] },
          { op: 'amend', entryId: pub(entryId), baseRevision: 1, changes: { summary: 'Reclaim waits two minutes now.' }, sources: [source] },
        ],
        rationale: 'r', idempotencyKey: `twin-${label}-${RUN}`,
      });
      assert.equal(drafted.status, 200, drafted.text);
      const id = toUuid(drafted.json.draftId);
      assert.deepEqual(drafted.json.rewrites.map((r: { key: string }) => r.key), ['leases']);
      const verifying = (await writes()).verifyJobs;
      const applied = await press(id, 'apply');
      assert.equal(applied.status, 200, applied.text);
      assert.deepEqual([applied.json.draft.undoable, (await entryRow(entryId)).trust], [true, 'confirmed']);
      assert.equal((await writes()).verifyJobs, verifying, 'no verification in Automatic');
      const job = (await followJobs()).find((one) => one.state === 'queued' && one.input.facts.some((fact) => fact.draftId === id))!;
      assert.ok(job, 'its press is on a queued follow job');
      await rewriteAsTheJob(job.id, 'leases', `${label}: a lease expires after two minutes.`);
      assert.deepEqual(await leasesText(), [`${label}: a lease expires after two minutes.`]);
      return { id, chat, changesetId: toUuid(applied.json.draft.changesetId), addedId: toUuid(applied.json.draft.ops[0].entryId), jobId: job.id };
    };
    const projection = async (x: { id: string; changesetId: string; addedId: string; jobId: string }, entryId: string) => {
      const entry = await entryRow(entryId);
      const revisions = (await sql.query(`SELECT "revision", "summary", "author_kind" FROM "wiki_entry_revision" WHERE "entry_id" = $1::uuid ORDER BY "revision"`, [entryId])).rows;
      const revert = (await sql.query(`SELECT "origin", "status" FROM "wiki_changeset" WHERE "idempotency_key" = $1`, [`revert:${x.changesetId}`])).rows;
      const job = (await sql.query(`SELECT "state" FROM "wiki_job" WHERE "id" = $1::uuid`, [x.jobId])).rows[0];
      return {
        card: (await card(x.id)).json.state,
        undoneAt: (await draftRow(x.id)).undone_at !== null,
        added: [(await entryRow(x.addedId)).status, (await entryRow(x.addedId)).trust],
        amended: [entry.current_revision, entry.trust, entry.summary],
        revisions: revisions.map((r) => [r.revision, r.summary, r.author_kind]),
        revert,
        leases: await leasesText(),
        job: job.state,
        restoreVersions: await count(`SELECT count(*)::int AS n FROM "wiki_doc_section_version" WHERE "space_id" = $1::uuid AND "reason" = 'restore'`, [spaceId]),
      };
    };
    const summaryBefore = TWIN_SUMMARY;
    const a = await twin(E_A, 'Twin A');
    undoneCard = a.id;
    const viaCard = await press(a.id, 'undo');
    assert.equal(viaCard.status, 200, viaCard.text);
    assert.deepEqual(viaCard.json.sections.map((s: { key: string; outcome: string }) => [s.key, s.outcome]), [['leases', 'restored']]);
    const viaCardRows = await projection(a, E_A);
    const b = await twin(E_B, 'Twin B');
    const viaRevert = await api('POST', `/api/wiki/changesets/${pub(b.changesetId)}/revert`, ownerToken);
    assert.equal(viaRevert.status, 200, viaRevert.text);
    assert.equal(viaRevert.json.draft.state, 'undone', 'the revert route took the card\'s Undo');
    const viaRevertRows = await projection(b, E_B);
    assert.deepEqual(viaCardRows.revisions, [[1, summaryBefore, 'owner'], [2, 'Reclaim waits two minutes now.', 'agent'], [3, summaryBefore, 'owner']]);
    assert.deepEqual({ ...viaCardRows, restoreVersions: 0 }, {
      card: 'undone', undoneAt: true, added: ['retired', 'confirmed'], amended: [3, 'unreviewed', summaryBefore],
      revisions: viaCardRows.revisions, revert: [{ origin: 'owner', status: 'settled' }], leases: [LEASES_BEFORE], job: 'cancelled', restoreVersions: 0,
    }, 'the add retired, the amend back with the trust it had before, the section restored, the queued job left with nothing cancelled');
    assert.deepEqual({ ...viaRevertRows, restoreVersions: 0 }, { ...viaCardRows, restoreVersions: 0 }, 'the same rows by either door');
    assert.equal(viaRevertRows.restoreVersions, viaCardRows.restoreVersions + 1, 'each restore kept what it replaced');
    const twice = await press(a.id, 'undo');
    assert.deepEqual([twice.status, twice.json.replayed], [200, true]);
  });

  // ── 8 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  await t.test('8. a card replaces an open card of its chat, and nothing else', async () => {
    const chat = await newChat(null);
    const op = (title: string) => ({ op: 'add', entry: { kind: 'concept', title, summary: `${title}.`, fields: { definition: 'd', boundaries: 'b' } }, sources: [source] });
    const first = await propose(chat, { ops: [op('Inbox claims one turn')], rationale: 'r', idempotencyKey: `r1-${RUN}` });
    const firstId = toUuid(first.json.draftId);
    const second = await propose(chat, { ops: [op('The inbox claims one turn at a time')], rationale: 'r', idempotencyKey: `r2-${RUN}`, replaces: first.json.draftId });
    assert.equal(second.status, 200, second.text);
    const secondId = toUuid(second.json.draftId);
    const read = await card(firstId);
    assert.deepEqual([read.json.state, toUuid(read.json.replacedBy)], ['replaced', secondId]);
    assert.equal(toUuid((await card(secondId)).json.replaces), firstId);
    const pressed = await press(firstId, 'apply');
    assert.equal(pressed.status, 409, 'only the newest of a chain can be pressed');
    const again = await propose(chat, { ops: [op('A third take')], rationale: 'r', idempotencyKey: `r3-${RUN}`, replaces: pub(firstId) });
    assert.deepEqual([again.status, again.json.code, again.json.errors?.[0]?.path], [400, 'WIKI_SCHEMA', 'replaces'], 'a replaced card is no open card');
    const elsewhere = await propose(chats.manual!, { ops: [op('From another chat')], rationale: 'r', idempotencyKey: `r4-${RUN}`, replaces: pub(secondId) });
    assert.deepEqual([elsewhere.status, elsewhere.json.code], [400, 'WIKI_SCHEMA'], "another chat's card is none of this chat's");
    assert.equal(await count(`SELECT count(*)::int AS n FROM "wiki_chat_draft" WHERE "session_id" = $1::uuid`, [chat]), 2, 'nothing made by a refusal');
  });

  // ── 9 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  await t.test("9. a wiki_note's corrects in a chat drafts its challenge as a card; the note is kept as anywhere", async () => {
    const chat = await newChat(null);
    const before = await writes();
    const noted = await api('POST', '/api/runner/wiki/notes', hpc.token, { text: 'The steer waits for the running turn now.', corrects: pub(E_CHAL) }, asSession(chat));
    assert.equal(noted.status, 200, noted.text);
    assert.equal(noted.json.noted, true);
    assert.equal(noted.json.challenged.status, 'draft');
    const id = toUuid(noted.json.challenged.draftId);
    const row = await draftRow(id);
    assert.deepEqual([row.kind, row.ops[0].op, row.session_id], ['entry', 'challenge', chat]);
    const after = await writes();
    assert.deepEqual({ ...after }, { ...before }, 'no op filed, and the entry not flagged');
    assert.equal((await entryRow(E_CHAL)).challenged, false);
    assert.equal(await count(`SELECT count(*)::int AS n FROM "wiki_note" WHERE "session_id" = $1::uuid`, [chat]), 1, 'the note is kept');
    // A note without corrects is what it was.
    const plain = await api('POST', '/api/runner/wiki/notes', hpc.token, { text: 'Leases moved to two minutes in the runner.' }, asSession(chat));
    assert.deepEqual([plain.status, plain.json.challenged], [200, undefined]);
  });

  // ── 10 ────────────────────────────────────────────────────────────────────────────────────────────────────────
  let rewriteCard = '';
  await t.test('10. wiki_draft is a chat\'s alone: its rewrite card, Try again and seen, and what it adds to the waiting count', async () => {
    const plain = await ordinarySession();
    const body = { kind: 'rewrite', sections: [{ doc: 'sessions-runtime', section: 'leases' }], reason: 'The lease moved to two minutes on main.', idempotencyKey: `rw-${RUN}` };
    const excluded = await draft(plain, body);
    assert.deepEqual([excluded.status, excluded.json.code], [403, 'WIKI_SESSION_EXCLUDED'], excluded.text);
    assert.match(excluded.json.message, /works only in a wiki chat/u);
    const chat = await newChat(null);
    // The plan kind is open (C12, wiki-chat-plan-card.pg.spec.ts holds it): a change of no proposal's shape is refused by the plan's gate.
    const plan = await draft(chat, { kind: 'plan', change: { op: 'edit' }, reason: 'r', idempotencyKey: `plan-${RUN}` });
    assert.deepEqual([plan.status, plan.json.code], [422, 'WIKI_PLAN_GATE'], plan.text);
    assert.deepEqual(plan.json.errors.map((e: { path: string }) => e.path).sort(), ['change.doc', 'change.op']);
    const unknown = await draft(chat, { ...body, sections: [{ doc: 'sessions-runtime', section: 'overview' }], idempotencyKey: `rw-x-${RUN}` });
    assert.deepEqual([unknown.status, unknown.json.code, unknown.json.errors[0].path], [400, 'WIKI_SCHEMA', 'sections[0]'], 'a section not written yet');
    const blank = await draft(chat, { ...body, replaces: '  ', idempotencyKey: `rw-b-${RUN}` });
    assert.deepEqual([blank.status, blank.json.code, blank.json.errors[0].path], [400, 'WIKI_SCHEMA', 'replaces']);
    const before = await writes();
    const drafted = await draft(chat, body);
    assert.equal(drafted.status, 200, drafted.text);
    assert.deepEqual(withoutTwins({ ...drafted.json, draftId: 'D' }), {
      status: 'draft', draftId: 'D', kind: 'rewrite', replayed: false,
      rewrites: [{ doc: 'sessions-runtime', key: 'leases', where: '1.1 §3', title: 'Leases' }],
    });
    const id = toUuid(drafted.json.draftId);
    rewriteCard = id;
    const replay = await draft(chat, body);
    assert.deepEqual([replay.json.replayed, toUuid(replay.json.draftId)], [true, id]);
    const applied = await press(id, 'apply');
    assert.equal(applied.status, 200, applied.text);
    assert.deepEqual([applied.json.draft.state, applied.json.draft.changesetId, applied.json.draft.undoable], ['applied', null, true]);
    assert.deepEqual(await writes(), before, 'a rewrite card writes no entry');
    const job = (await followJobs()).find((one) => one.state === 'queued' && one.input.facts.some((fact) => fact.draftId === id))!;
    assert.deepEqual([job.priority, job.input.facts.find((fact) => fact.draftId === id)!.sections], [1, [{ doc: 'sessions-runtime', key: 'leases' }]]);
    assert.equal(applied.json.draft.rewrite.result, 'waiting', 'held up: no wiki-worker runs here');
    assert.equal((await spaceRow()).chatWaiting, 1, 'a held-up rewrite waits on the owner');
    const early = await press(id, 'retry');
    assert.equal(early.status, 409, 'Try again is for a failed rewrite');
    // The job ends with the section left unwritten: the card's rewrite failed, and waits on the owner until seen.
    await sql.query(`UPDATE "wiki_job" SET "state" = 'failed', "ended_at" = now(), "report" = '{"kind":"docs_follow","sha":"","sections":[],"left":0}' WHERE "id" = $1::uuid`, [job.id]);
    const failed = await card(id);
    assert.deepEqual([failed.json.rewrite.result, failed.json.rewrite.seen], ['failed', false]);
    assert.equal((await spaceRow()).chatWaiting, 1, 'a failed rewrite the owner has not seen waits on them');
    const retried = await press(id, 'retry');
    assert.equal(retried.status, 200, retried.text);
    assert.notEqual(toUuid(retried.json.draft.rewrite.jobId), job.id, 'queued again, as a job of its own');
    assert.deepEqual([retried.json.draft.rewrite.result, retried.json.draft.rewrite.seen], ['waiting', false], 'held up as before, unseen');
    assert.equal((await spaceRow()).chatWaiting, 1);
    const again = (await followJobs()).find((one) => one.state === 'queued' && one.input.facts.some((fact) => fact.draftId === id))!;
    await sql.query(`UPDATE "wiki_job" SET "state" = 'failed', "ended_at" = now(), "report" = '{"kind":"docs_follow","sha":"","sections":[],"left":0}' WHERE "id" = $1::uuid`, [again.id]);
    assert.equal((await spaceRow()).chatWaiting, 1);
    const seen = await press(id, 'seen');
    assert.deepEqual([seen.status, seen.json.seen, seen.json.draft.rewrite.seen], [200, true, true]);
    assert.equal((await spaceRow()).chatWaiting, 0, 'seen, it waits no more');
    const unseenCard = await press(cards.tiered!, 'seen');
    assert.deepEqual([unseenCard.status, unseenCard.json.seen], [200, false], 'a card with no settled rewrite answers without writing');
  });

  // ── 10½ ───────────────────────────────────────────────────────────────────────────────────────────────────────
  await t.test("10½. a follow job that runs writes none of an undone card's sections it has not written yet", async () => {
    // The documents' writer, in this process, as the wiki-worker's follow job calls it (wiki-docs-follow-job.ts causeOf).
    const quiet = { publishWikiChanged: () => undefined } as unknown as RealtimeService;
    const push = { notifyWikiReviewModeTripped: async () => undefined, notifyWikiVerificationTripped: async () => undefined } as unknown as PushService;
    const docs = new WikiDocs(prisma as unknown as PrismaService, new WikiService(prisma as unknown as PrismaService, quiet, push), quiet);
    const writeLeases = (text: string, draftIds: string[]) => docs.write(wikiDocsBuildJobPrincipal(owner.id), spaceId, 'sessions-runtime', {
      planVersion: 1, repoSha: '2e'.repeat(20), model: 'spec-model',
      sections: [{ key: 'leases', materialSha256: randomUUID().replace(/-/gu, '').padEnd(64, 'a'), markdown: `- ${text}`, footnotes: [] }],
    }, { reason: 'chat', jobId: randomUUID(), title: 'a chat', draftIds });
    const versions = () => count(`SELECT count(*)::int AS n FROM "wiki_doc_section_version" WHERE "space_id" = $1::uuid AND "section_key" = 'leases'`, [spaceId]);
    const before = { text: await leasesText(), versions: await versions() };
    const skipped = await writeLeases('Written for an undone card.', [undoneCard]);
    assert.deepEqual(skipped.sections.map((one) => one.outcome), ['unchanged'], 'every card that asked for it was undone: nothing is written');
    assert.deepEqual({ text: await leasesText(), versions: await versions() }, before, 'and nothing kept');
    const written = await writeLeases('Written while one card that asked for it stands.', [undoneCard, rewriteCard]);
    assert.deepEqual(written.sections.map((one) => one.outcome), ['written'], 'a card that still stands asks for it');
    assert.deepEqual(await leasesText(), ['Written while one card that asked for it stands.']);
    assert.equal(await versions(), before.versions + 1, 'what it replaced is kept');
  });

  // ── 11 ────────────────────────────────────────────────────────────────────────────────────────────────────────
  await t.test('11. the next message tells the agent what the owner pressed, once', async () => {
    // What delivery appends, in a transaction of the delivery's own (runner-api.controller.ts dequeueTurn's).
    const notes = (sessionId: string) => prisma.$transaction(async (tx) => appendWikiChatNotes(tx as never, {
      ownerId: owner.id, spaceId, sessionId, turn: { seq: 99, kind: 'message', wikiContext: null },
    }, 'And what about the steer?'));
    const first = await notes(chats.manual!);
    assert.ok(first?.startsWith('And what about the steer?\n\n<orbit_wiki_drafts applied="1" edited="0" discarded="0" undone="0">'), String(first));
    assert.match(first!, new RegExp(`- ${pub(cards.manual!)} 6 changes: applied by the owner\\. It wrote entry `, 'u'));
    assert.match(first!, /\(challenge, challenged, waiting for the owner in Review\)|\(challenge, owner\)/u);
    assert.match(first!, /Rewrite: Wiki updated · 1\.1 §3 — reads the same · 1\.1 §2 — 1 sentence\./u);
    assert.notEqual((await draftRow(cards.manual!)).told_at, null);
    assert.equal(await notes(chats.manual!), 'And what about the steer?', 'told once: the next message carries nothing');
    // A delivery rolled back tells the next one: the Automatic chat's card was discarded (5) and nobody was told yet.
    const chat = chats.automatic!;
    await assert.rejects(prisma.$transaction(async (tx) => {
      await appendWikiChatNotes(tx as never, { ownerId: owner.id, spaceId, sessionId: chat, turn: { seq: 99, kind: 'message', wikiContext: null } }, 'x');
      throw new Error('the claim rolled back');
    }), /rolled back/u);
    const told = await notes(chat);
    assert.match(told ?? '', /<orbit_wiki_drafts applied="0" edited="0" discarded="1" undone="0">/u);
    assert.match(told ?? '', /discarded\. Nothing of it was written\./u);
  });

  // ── 12 ────────────────────────────────────────────────────────────────────────────────────────────────────────
  await t.test('12. a card of a chat that ended reads Not applied, and nothing presses it', async () => {
    const chat = await newChat(null);
    const drafted = await propose(chat, {
      ops: [{ op: 'challenge', entryId: pub(E_REIN), reason: 'The owner doubts it.' }], rationale: 'r', idempotencyKey: `ended-${RUN}`,
    });
    const id = toUuid(drafted.json.draftId);
    await sql.query(`UPDATE "session" SET "status" = 'SUCCEEDED' WHERE "id" = $1::uuid`, [chat]);
    assert.equal((await card(id)).json.state, 'not_applied');
    const applied = await press(id, 'apply');
    assert.equal(applied.status, 409, applied.text);
    assert.match(applied.json.message, /not_applied/u);
  });

  // ── 13 ────────────────────────────────────────────────────────────────────────────────────────────────────────
  await t.test('13. a press or a read with a session header is refused WIKI_OWNER_CHANNEL_ONLY; another account\'s card is the 404', async () => {
    const chat = await newChat(null);
    const drafted = await propose(chat, {
      ops: [{ op: 'add', entry: { kind: 'concept', title: 'Session header refusal', summary: 'A press is the owner channel\'s.', fields: { definition: 'd', boundaries: 'b' } }, sources: [source] }],
      rationale: 'r', idempotencyKey: `header-${RUN}`,
    });
    const id = toUuid(drafted.json.draftId);
    const before = await writes();
    for (const what of ['apply', 'edit', 'discard', 'undo', 'retry', 'seen']) {
      const refused = await press(id, what, what === 'edit' ? { ops: [{ seq: 0, changes: { title: 'x' } }] } : {}, ownerToken, asSession(chat));
      assert.deepEqual([refused.status, refused.json.code], [403, 'WIKI_OWNER_CHANNEL_ONLY'], `${what}: ${refused.text}`);
    }
    for (const route of [`/api/wiki/chat-drafts/${pub(id)}`, `/api/wiki/chats/${pub(chat)}/drafts`]) {
      const refused = await api('GET', route, ownerToken, undefined, asSession(chat));
      assert.deepEqual([refused.status, refused.json.code], [403, 'WIKI_OWNER_CHANNEL_ONLY'], route);
    }
    assert.deepEqual(await writes(), before);
    assert.equal((await draftRow(id)).decision, null, 'nothing pressed');
    for (const what of ['apply', 'discard', 'undo', 'retry', 'seen']) {
      const theirs = await press(id, what, {}, strangerToken);
      assert.equal(theirs.status, 404, `${what} by another account: ${theirs.text}`);
    }
    assert.equal((await card(id, strangerToken)).status, 404);
    assert.equal((await api('GET', `/api/wiki/chats/${pub(chat)}/drafts`, strangerToken)).status, 404);
    assert.equal((await draftRow(id)).decision, null);
  });

  // ── 14 ────────────────────────────────────────────────────────────────────────────────────────────────────────
  await t.test("14. the card read, a chat's cards oldest first, and the chats list's counts", async () => {
    const read = await card(cards.manual!);
    assert.deepEqual(Object.keys(withoutTwins(read.json) as object), [
      'id', 'sessionId', 'kind', 'state', 'label', 'rationale', 'ops', 'sections', 'rewrites', 'similar', 'tainted', 'replaces', 'replacedBy',
      'decision', 'decidedAt', 'undoneAt', 'undoable', 'changesetId', 'rewrite', 'change', 'createdAt',
    ], 'the contract\'s card, field for field');
    assert.equal(read.json.change, null, 'an entry card has no plan change');
    assert.deepEqual([read.json.label, read.json.kind, read.json.rewrites.map((r: { where: string }) => r.where)], [
      WIKI_CHAT_COPY.card.changes.replace('{n}', '6'), 'entry', ['1.1 §3', '1.1 §2'],
    ]);
    const listed = await api('GET', `/api/wiki/chats/${pub(chats.manual!)}/drafts`, ownerToken);
    assert.equal(listed.status, 200, listed.text);
    assert.deepEqual(listed.json.drafts.map((d: { id: string }) => toUuid(d.id)), [cards.manual]);
    const chatsList = await api('GET', `/api/wiki/spaces/${pub(spaceId)}/chats`, ownerToken);
    assert.equal(chatsList.status, 200, chatsList.text);
    const row = chatsList.json.chats.find((one: { sessionId: string }) => toUuid(one.sessionId) === chats.manual);
    assert.equal(row.drafts, 1, 'the chat holds one card');
    assert.ok(chatsList.json.fab.needsYou >= 1, 'open drafts of open chats need the owner');
  });
});
