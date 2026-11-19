/**
 * What settles a source a chat's card or a session's op cites (contracts/wiki.contract.json `sourceRules.quote`,
 * `sourceInput.toolUseId`, `sourceInput.pending`; docs/wiki-contract.md §5; wiki chat project tasks C14, from task C10's
 * findings 1 and 2, and C20), held against the production apiserver — `build/main.js`, the whole AppModule — over a real
 * PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/wiki/wiki-source-settle.pg.spec.ts
 *
 * Two accounts, one machine of the owner's, one space; chats and ordinary sessions in it. In order:
 *
 *   1. a quote the draft's redaction masked — a value beside a name with TOKEN in it, and a workspace.env value — is
 *      applied: the card's Apply finds it in the record redacted the same way, and so does Review's Accept of an ordinary
 *      session's op; what is stored is the redacted quote, unverified, on the call's row id;
 *   2. a fabricated quote is still refused: a value the record does not hold (both would read [redacted]), words it does
 *      not hold around a [redacted], and a [redacted] where the redactor took nothing out, at the draft; a card's or an
 *      op's stored quote that is not in the record, at the press and at the Accept; and a quote of a call cited before it
 *      was stored that the call does not hold, at the press — each with nothing written;
 *   3. a call made a moment before, not stored yet, is cited by a chat and by an ordinary session whose turn is running
 *      (the engine generating for it, as when it calls wiki_propose): the card is made, and
 *      the op waits for the owner in Manual, Tiered and Automatic alike, a reinforce too, with nothing stored for the
 *      source; a press or an Accept before the call is stored is refused; once it is, the press and the Accept resolve it
 *      to the call's row, its quote verified;
 *   4. another session's call or one never made is still refused: a tool_use_id no session ever carries, or that turns up
 *      in another of the owner's sessions or in another account's, at the press and at the Accept; one that two sessions
 *      carry, a row id that names no call, a challenge's call not stored yet, and any call no session carries cited by a
 *      session the engine is not generating for, at once. A call another session had stored before the card resolves, as
 *      it always did;
 *   5. a quote of the output of a call stored without its result — the runner stores a tool_use as a row with its input,
 *      and its tool_result fills output and finished_at a batch later — cited by a chat and by an ordinary session whose
 *      turn is running: the card is made, and the op waits for the owner in Manual, Tiered and Automatic alike, a
 *      reinforce too, with nothing stored for the source; the press, the card's Edit, Review's Accept and Edit read the
 *      whole record — refused while the result is not stored, verified once it holds the quote, and refused with nothing
 *      written when it does not. A quote of what is stored (the command) is verified at once and waits for nothing; a
 *      challenge's, another session's call, a call named by its row id and a session between turns are refused at once.
 *
 * Not destructive: every row belongs to accounts this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { toUuid, uuidToBase62 } from '@orbit/shared';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { hashPassword } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import '../test-support/daemon-routes-over-http';

const URL_ = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const REPO_URL = `https://github.com/example/settle-${RUN}`;
const ENGINES = [{ engine: 'claude', installed: true, auth: 'yes', version: '2.3.0' }];
const CAPABILITIES = 'source-pin/v1';
/** A workspace.env value of the owner's: the redactor takes it out wherever it appears. */
const DEPLOY_VALUE = `deploy-${RUN}-hunter2`;
/** What `cat src/runner/enroll.ts` printed (task C10's finding 1): a TTL beside a name with TOKEN in it. */
const ENROLL_OUTPUT = [
  'export const ENROLLMENT_TOKEN_TTL_MS = 900_000;',
  `the deploy value is ${DEPLOY_VALUE} on the build host`,
  'the lease is two minutes on main',
].join('\n');
const TTL_QUOTE = 'ENROLLMENT_TOKEN_TTL_MS = 900_000';
const TTL_STORED = 'ENROLLMENT_TOKEN_TTL_MS = [redacted]';
const DEPLOY_QUOTE = `the deploy value is ${DEPLOY_VALUE}`;
const DEPLOY_STORED = 'the deploy value is [redacted]';
const LEASE_OUTPUT = 'lease_seconds = 120\nreclaim_after = 1 lease';
const LEASE_QUOTE = 'lease_seconds = 120';
const MODES = ['manual', 'tiered', 'automatic'] as const;

test('a source is settled where its op is: a redacted quote applies, a call not stored yet is cited and verified, a fabricated one is not', { skip: !URL_, concurrency: 1, timeout: 900_000 }, async (t) => {
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
    const email = `${name}-${RUN}@wiki-settle.invalid`;
    await sql.query(`INSERT INTO "user" (id, email, name, password_hash, role) VALUES ($1, $2, $3, $4, 'MEMBER')`,
      [id, email, name, hashPassword(password)]);
    return { id, email, password };
  };
  const owner = await account('owner');
  const stranger = await account('stranger');
  server = await startApiserver(url, `wiki-settle-${randomUUID()}`);
  const api = (method: string, route: string, bearer?: string, body?: unknown, headers?: Record<string, string>): Promise<Reply> =>
    call(server!, method, route, bearer, body, headers);
  const signIn = async (who: { email: string; password: string }) => {
    const reply = await api('POST', '/api/auth/login', undefined, { email: who.email, password: who.password });
    assert.equal(reply.status, 201, reply.text);
    return reply.json.accessToken as string;
  };
  const ownerToken = await signIn(owner);
  const strangerToken = await signIn(stranger);
  const machine = async (bearer: string, name: string) => {
    const minted = await api('POST', '/api/runners/enrollment-tokens', bearer, { label: `wiki settle ${name} ${RUN}` });
    assert.equal(minted.status, 201, minted.text);
    const registered = await api('POST', '/api/runner/register', undefined, { enrollmentToken: minted.json.token, name: `${name}-${RUN}`, hostname: `${name}-${RUN}` });
    assert.equal(registered.status, 201, registered.text);
    const runner = { runnerId: toUuid(registered.json.runnerId), token: registered.json.runnerToken as string };
    const beat = await api('POST', '/api/runner/heartbeat', runner.token, { status: 'ONLINE', engines: ENGINES }, { 'x-orbit-runner-capabilities': CAPABILITIES });
    assert.equal(beat.status < 300, true, beat.text);
    return runner;
  };
  const hpc = await machine(ownerToken, 'hpc');
  const theirs = await machine(strangerToken, 'theirs');
  const workspace = async (ownerId: string, runnerId: string, name: string, env: Record<string, string> = {}) => {
    const id = randomUUID();
    await sql.query(
      `INSERT INTO "workspace" (id, name, owner_id, runner_id, work_dir, repo_url, enable_worktree, env) VALUES ($1, $2, $3, $4, $5, $6, true, $7::jsonb)`,
      [id, name, ownerId, runnerId, `/srv/${name}`, REPO_URL, JSON.stringify(env)],
    );
    return id;
  };
  const wsChat = await workspace(owner.id, hpc.runnerId, 'orbit-chat', { SPEC_DEPLOY_VALUE: DEPLOY_VALUE });
  const wsPlain = await workspace(owner.id, hpc.runnerId, 'orbit-plain');
  const wsTheirs = await workspace(stranger.id, theirs.runnerId, 'their-orbit');
  const pub = (id: string) => uuidToBase62(id);

  const made = await api('POST', '/api/wiki/spaces', ownerToken, { title: `Orbit ${RUN}`, repoUrl: REPO_URL });
  assert.equal(made.status, 201, made.text);
  const spaceId = toUuid(made.json.id);
  const setMode = async (mode: string) => {
    const reply = await api('PATCH', `/api/wiki/spaces/${pub(spaceId)}`, ownerToken, { reviewMode: mode });
    assert.equal(reply.status, 200, reply.text);
  };
  /**
   * The session's turn running on the machine, as its claim leaves it: what a session calling wiki_propose is. Claimed in a
   * transaction that says it reads the session's engine, as QueueService's claim does (migration 0414).
   */
  const running = async (sessionId: string) => {
    await sql.query('BEGIN');
    await sql.query(`SELECT set_config('orbit.claim_reads_session_engine', '1', true)`);
    await sql.query(`UPDATE "session" SET "status" = 'RUNNING', "run_claimed_at" = now() WHERE "id" = $1::uuid`, [sessionId]);
    await sql.query('COMMIT');
    assert.equal((await sql.query(`SELECT "status" FROM "session" WHERE "id" = $1::uuid`, [sessionId])).rows[0].status, 'RUNNING');
    return sessionId;
  };
  /** A chat, its turn running unless `between` says it waits between turns. */
  const newChat = async (between = false) => {
    const reply = await api('POST', `/api/wiki/spaces/${pub(spaceId)}/chats`, ownerToken,
      { workspaceId: pub(wsChat), content: 'Write down what the enrollment file says.', clientTurnId: randomUUID() });
    assert.equal(reply.status, 201, reply.text);
    const id = toUuid(reply.json.sessionId);
    return between ? id : running(id);
  };
  /** An ordinary session, its turn running unless `between` says it waits between turns. */
  const ordinarySession = async (bearer = ownerToken, ws = wsPlain, between = false) => {
    const reply = await api('POST', '/api/sessions', bearer, { prompt: 'An ordinary session reads the enrollment file.', workspaceId: pub(ws) });
    assert.equal(reply.status, 201, reply.text);
    const id = toUuid(reply.json.id);
    return between ? id : running(id);
  };
  const propose = (sessionId: string, ops: unknown[], key: string) => api('POST', '/api/runner/wiki/changesets', hpc.token,
    { ops, rationale: 'What the session read.', idempotencyKey: `${key}-${RUN}` }, { 'x-orbit-session-id': pub(sessionId) });
  const press = (draftId: string, what = 'apply', body: unknown = {}) =>
    api('POST', `/api/wiki/chat-drafts/${pub(draftId)}/${what}`, ownerToken, body);
  const accept = (changesetId: string, opId: string) => api('POST', `/api/wiki/changesets/${pub(changesetId)}/decide`, ownerToken,
    { decisions: [{ opId: pub(opId), action: 'accept' }] });
  /** A call the runner delivered: stored as the event ingestion stores one, a uuid(7) row of the session's, its result in. */
  const storeCall = (sessionId: string, toolUseId: string, output: string, command = 'cat src/runner/enroll.ts') =>
    prisma.toolCall.create({ data: { sessionId, name: 'Bash', toolUseId, input: { command }, output, isError: false, finishedAt: new Date() }, select: { id: true } });
  /** A call whose tool_use the runner delivered and whose tool_result it has not yet: the row with its input, no output. */
  const startCall = (sessionId: string, toolUseId: string, command = 'cat lease.conf') =>
    prisma.toolCall.create({ data: { sessionId, name: 'Bash', toolUseId, input: { command }, isError: false }, select: { id: true } });
  /** Its tool_result delivered, as writeToolCalls stores one: output, is_error and finished_at on the call's rows. */
  const finishCall = async (sessionId: string, toolUseId: string, output: string) => {
    const filled = await prisma.toolCall.updateMany({ where: { sessionId, toolUseId }, data: { output, isError: false, finishedAt: new Date() } });
    assert.equal(filled.count, 1, `${toolUseId}: its one row filled`);
  };
  const add = (title: string, sources: unknown[]) => ({
    op: 'add',
    entry: { kind: 'concept', title, summary: `${title}, as the session read it.`, fields: { definition: `${title}.`, boundaries: 'Enrollment only.' } },
    sources,
  });
  const ownerAdd = async (title: string) => {
    const reply = await api('POST', `/api/wiki/spaces/${pub(spaceId)}/changesets`, ownerToken, {
      ops: [{ op: 'add', entry: { kind: 'concept', title, summary: `${title}, as the owner wrote it.`, fields: { definition: `${title}.`, boundaries: 'Leases only.' } } }],
      rationale: 'the owner writes it', idempotencyKey: `owner-${randomUUID()}`,
    });
    assert.equal(reply.status, 200, reply.text);
    return toUuid(reply.json.ops[0].entryId);
  };
  const count = async (query: string, values: unknown[] = []) => Number((await sql.query(query, values)).rows[0].n);
  const writes = async () => ({
    changesets: await count(`SELECT count(*)::int AS n FROM "wiki_changeset" WHERE "space_id" = $1::uuid`, [spaceId]),
    ops: await count(`SELECT count(*)::int AS n FROM "wiki_changeset_op" o JOIN "wiki_changeset" c ON c."id" = o."changeset_id" WHERE c."space_id" = $1::uuid`, [spaceId]),
    entries: await count(`SELECT count(*)::int AS n FROM "wiki_entry" WHERE "space_id" = $1::uuid`, [spaceId]),
    revisions: await count(`SELECT count(*)::int AS n FROM "wiki_entry_revision" r JOIN "wiki_entry" e ON e."id" = r."entry_id" WHERE e."space_id" = $1::uuid`, [spaceId]),
    sources: await count(`SELECT count(*)::int AS n FROM "wiki_source" s JOIN "wiki_entry_revision" r ON r."id" = s."revision_id" JOIN "wiki_entry" e ON e."id" = r."entry_id" WHERE e."space_id" = $1::uuid`, [spaceId]),
    cards: await count(`SELECT count(*)::int AS n FROM "wiki_chat_draft" WHERE "space_id" = $1::uuid`, [spaceId]),
    pressed: await count(`SELECT count(*)::int AS n FROM "wiki_chat_draft" WHERE "space_id" = $1::uuid AND "decision" IS NOT NULL`, [spaceId]),
  });
  const entryRow = async (id: string) => (await sql.query(`SELECT * FROM "wiki_entry" WHERE "id" = $1::uuid`, [id])).rows[0];
  const opRow = async (id: string) => (await sql.query(`SELECT * FROM "wiki_changeset_op" WHERE "id" = $1::uuid`, [id])).rows[0];
  const draftRow = async (id: string) => (await sql.query(`SELECT * FROM "wiki_chat_draft" WHERE "id" = $1::uuid`, [id])).rows[0];
  /** The sources of one revision of an entry, oldest first. */
  const sourcesOf = async (entryId: string, revision = 1) => (await sql.query(
    `SELECT s."kind", s."ref", s."quote", s."quote_verified" AS "verified" FROM "wiki_source" s JOIN "wiki_entry_revision" r ON r."id" = s."revision_id"
      WHERE r."entry_id" = $1::uuid AND r."revision" = $2 ORDER BY s."created_at", s."id"`, [entryId, revision])).rows;
  /** The entries a card's Apply wrote, in its ops' order. */
  const appliedEntries = async (draftId: string) => (await sql.query(
    `SELECT o."result_entry_id" AS "id" FROM "wiki_changeset_op" o JOIN "wiki_chat_draft" d ON d."changeset_id" = o."changeset_id"
      WHERE d."id" = $1::uuid ORDER BY o."seq"`, [draftId])).rows.map((row) => row.id as string);
  /** A card made: its id, after asserting the propose answered with one. */
  const drafted = (reply: Reply, what: string) => {
    assert.equal(reply.status, 200, `${what}: ${reply.text}`);
    assert.equal(reply.json.status, 'draft', `${what}: a card`);
    return toUuid(reply.json.draftId);
  };
  /** A request none of whose ops passed: no card, no changeset, the op's own refusal. */
  const refusedAtOnce = (reply: Reply, code: string, what: string) => {
    assert.equal(reply.status, 422, `${what}: ${reply.text}`);
    assert.equal(reply.json.changesetId, null, `${what}: nothing recorded`);
    assert.equal(reply.json.draftId, undefined, `${what}: no card`);
    assert.equal(reply.json.ops[0].reasons[0].code, code, `${what}: ${reply.text}`);
  };
  const refused = (reply: Reply, code: string, what: string) => {
    assert.equal(reply.status, 422, `${what}: ${reply.text}`);
    assert.equal(reply.json.code, code, `${what}: ${reply.text}`);
  };

  // ── 1 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  await t.test('1. a quote the draft\'s redaction masked is applied: by the card\'s Apply, and by Review\'s Accept', async () => {
    await setMode('manual');
    const chat = await newChat();
    const call = await storeCall(chat, `toolu_enroll_chat_${RUN}`, ENROLL_OUTPUT);
    const sources = [
      { kind: 'tool_call', ref: `toolu_enroll_chat_${RUN}`, quote: TTL_QUOTE },
      { kind: 'tool_call', ref: `toolu_enroll_chat_${RUN}`, quote: DEPLOY_QUOTE },
    ];
    const draftId = drafted(await propose(chat, [add('Enrollment tokens last fifteen minutes', sources)], 'redacted-chat'), 'the card');
    // What the card keeps is the op redacted: neither value is in it, so Apply hands recordChangeset the masked quotes.
    const kept = JSON.stringify((await draftRow(draftId)).ops);
    assert.equal(kept.includes('900_000') || kept.includes(DEPLOY_VALUE), false, 'no value is kept on the card');
    assert.ok(kept.includes(TTL_STORED) && kept.includes(DEPLOY_STORED), kept);

    const applied = await press(draftId);
    assert.equal(applied.status, 200, `the masked quotes are found in the record redacted the same way: ${applied.text}`);
    assert.equal(applied.json.draft.state, 'applied');
    const [entryId] = await appliedEntries(draftId);
    assert.deepEqual([(await entryRow(entryId!)).status, (await entryRow(entryId!)).trust], ['active', 'confirmed']);
    assert.deepEqual(await sourcesOf(entryId!), [
      { kind: 'tool_call', ref: call.id, quote: TTL_STORED, verified: false },
      { kind: 'tool_call', ref: call.id, quote: DEPLOY_STORED, verified: false },
    ], "the call's row, each quote as stored — redacted, so not the record's words verbatim");

    // An ordinary session's op of the same quotes, in Review: its Accept reads the stored op back the same way.
    const plain = await ordinarySession(ownerToken, wsChat);
    const plainCall = await storeCall(plain, `toolu_enroll_plain_${RUN}`, ENROLL_OUTPUT);
    const proposed = await propose(plain, [add('Enrollment tokens expire', [
      { kind: 'tool_call', ref: `toolu_enroll_plain_${RUN}`, quote: TTL_QUOTE },
      { kind: 'tool_call', ref: `toolu_enroll_plain_${RUN}`, quote: DEPLOY_QUOTE },
    ])], 'redacted-plain');
    assert.equal(proposed.status, 200, proposed.text);
    assert.equal(proposed.json.ops[0].status, 'pending', 'Manual: it waits for the owner');
    const accepted = await accept(toUuid(proposed.json.changesetId), toUuid(proposed.json.ops[0].opId));
    assert.equal(accepted.status, 200, `Review's Accept finds them the same way: ${accepted.text}`);
    const plainEntry = toUuid(proposed.json.ops[0].entryId);
    assert.deepEqual([(await entryRow(plainEntry)).status, (await entryRow(plainEntry)).trust], ['active', 'confirmed']);
    assert.deepEqual(await sourcesOf(plainEntry), [
      { kind: 'tool_call', ref: plainCall.id, quote: TTL_STORED, verified: false },
      { kind: 'tool_call', ref: plainCall.id, quote: DEPLOY_STORED, verified: false },
    ], 'stored once, when it was proposed: the Accept adds nothing');
  });

  // ── 2 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  await t.test('2. a fabricated quote is still refused: at the draft, at the press and at the Accept, with nothing written', async () => {
    await setMode('manual');
    const chat = await newChat();
    const ref = `toolu_enroll_fab_${RUN}`;
    await storeCall(chat, ref, ENROLL_OUTPUT);
    const at = (quote: string, key: string) => propose(chat, [add('Enrollment tokens last ten minutes', [{ kind: 'tool_call', ref, quote }])], key);
    let before = await writes();
    // A value the record does not hold: redacted, it would read as the record does — so a quote with a value is held to
    // the record's own words.
    refusedAtOnce(await at('ENROLLMENT_TOKEN_TTL_MS = 600_000', 'fab-value'), 'WIKI_QUOTE_NOT_FOUND', 'a value the record does not hold');
    // In redacted form, but with words the record does not hold around the [redacted].
    refusedAtOnce(await at('ENROLLMENT_TOKEN_TTL_SECONDS = [redacted]', 'fab-name'), 'WIKI_QUOTE_NOT_FOUND', 'a name the record does not hold');
    // [redacted] where the redactor took nothing out: it stands for nothing of the record's.
    refusedAtOnce(await at('the lease is [redacted] on main', 'fab-mask'), 'WIKI_QUOTE_NOT_FOUND', 'a [redacted] the redactor never wrote');
    assert.deepEqual(await writes(), before, 'no card, nothing of the wiki');

    // A card whose kept quote is not in the record — as if it had been fabricated after the draft — is refused at Apply.
    const draftId = drafted(await at('the lease is two minutes on main', 'fab-card'), 'a card of a true quote');
    await sql.query(`UPDATE "wiki_chat_draft" SET "ops" = jsonb_set("ops", '{0,payload,sources,0,quote}', to_jsonb($2::text)) WHERE "id" = $1::uuid`,
      [draftId, 'the lease is [redacted] on main']);
    before = await writes();
    refused(await press(draftId), 'WIKI_QUOTE_NOT_FOUND', 'the press of a quote the record does not hold');
    assert.deepEqual(await writes(), before, 'nothing written');
    assert.equal((await draftRow(draftId)).decision, null, 'the card is still a draft');

    // The same for an op in Review: its stored quote is read back at the Accept.
    const plain = await ordinarySession();
    await storeCall(plain, `${ref}-plain`, ENROLL_OUTPUT);
    const proposed = await propose(plain, [add('Enrollment leases', [{ kind: 'tool_call', ref: `${ref}-plain`, quote: 'the lease is two minutes on main' }])], 'fab-op');
    assert.equal(proposed.status, 200, proposed.text);
    const opId = toUuid(proposed.json.ops[0].opId);
    await sql.query(`UPDATE "wiki_changeset_op" SET "payload" = jsonb_set("payload", '{sources,0,quote}', to_jsonb($2::text)) WHERE "id" = $1::uuid`,
      [opId, 'the lease is [redacted] on main']);
    before = await writes();
    refused(await accept(toUuid(proposed.json.changesetId), opId), 'WIKI_QUOTE_NOT_FOUND', 'the Accept of a quote the record does not hold');
    assert.deepEqual(await writes(), before, 'nothing written');
    assert.equal((await opRow(opId)).decision, 'pending', 'the op still waits');

    // A call cited before it was stored, with a quote the call turns out not to hold: refused once it is stored.
    const late = `toolu_fab_late_${RUN}`;
    const lateCard = drafted(await propose(chat, [add('Lease seconds', [{ kind: 'tool_call', ref: late, quote: 'lease_seconds = 999' }])], 'fab-late'), 'a card of a call not stored yet');
    await storeCall(chat, late, LEASE_OUTPUT, 'cat lease.conf');
    before = await writes();
    refused(await press(lateCard), 'WIKI_QUOTE_NOT_FOUND', 'the press of a quote the stored call does not hold');
    assert.deepEqual(await writes(), before, 'nothing written');
  });

  // ── 3 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  await t.test('3. a call made a moment before is cited before it is stored, and verified once it is: in a chat and in an ordinary session', async () => {
    // A chat: the card is made at once, and its press settles the call.
    await setMode('manual');
    const chat = await newChat();
    const late = `toolu_late_chat_${RUN}`;
    let before = await writes();
    const draftId = drafted(await propose(chat, [add('Turn leases last two minutes', [{ kind: 'tool_call', ref: late, quote: LEASE_QUOTE }])], 'late-chat'),
      'a call the runner has not delivered yet');
    assert.deepEqual(await writes(), { ...before, cards: before.cards + 1 }, 'a card, and nothing of the wiki');
    refused(await press(draftId), 'WIKI_SOURCE_UNRESOLVED', 'a press before the call is stored');
    assert.equal((await draftRow(draftId)).decision, null, 'the card is still a draft');
    const chatCall = await storeCall(chat, late, LEASE_OUTPUT, 'cat lease.conf');
    const applied = await press(draftId);
    assert.equal(applied.status, 200, `once it is stored, the press resolves it: ${applied.text}`);
    const [chatEntry] = await appliedEntries(draftId);
    assert.deepEqual(await sourcesOf(chatEntry!), [{ kind: 'tool_call', ref: chatCall.id, quote: LEASE_QUOTE, verified: true }],
      "the call's row id, not the tool_use_id it was cited by, and its quote verified");

    // An ordinary session in Manual: the op waits, nothing is stored for the source, and the Accept settles it.
    const plain = await ordinarySession();
    const plainLate = `toolu_late_plain_${RUN}`;
    const proposed = await propose(plain, [add('Reclaim waits a lease', [{ kind: 'tool_call', ref: plainLate, quote: LEASE_QUOTE }])], 'late-plain');
    assert.equal(proposed.status, 200, proposed.text);
    assert.deepEqual([proposed.json.ops[0].status, proposed.json.ops[0].waitsFor], ['pending', undefined], 'it waits for the owner');
    const plainEntry = toUuid(proposed.json.ops[0].entryId);
    const changesetId = toUuid(proposed.json.changesetId);
    const opId = toUuid(proposed.json.ops[0].opId);
    assert.deepEqual(await sourcesOf(plainEntry), [], 'nothing is stored for a source that names no row yet');
    before = await writes();
    refused(await accept(changesetId, opId), 'WIKI_SOURCE_UNRESOLVED', 'an Accept before the call is stored');
    assert.deepEqual(await writes(), before, 'nothing written');
    assert.equal((await opRow(opId)).decision, 'pending');
    const plainCall = await storeCall(plain, plainLate, LEASE_OUTPUT, 'cat lease.conf');
    const accepted = await accept(changesetId, opId);
    assert.equal(accepted.status, 200, `once it is stored, the Accept resolves it: ${accepted.text}`);
    const entry = await entryRow(plainEntry);
    assert.deepEqual([entry.status, entry.trust, entry.unsupported], ['active', 'confirmed', false], 'live, and resting on its source');
    assert.deepEqual(await sourcesOf(plainEntry), [{ kind: 'tool_call', ref: plainCall.id, quote: LEASE_QUOTE, verified: true }],
      'revision 1 holds it now: the row id, its quote verified');

    // A reinforce the effect policy applies at once waits too: what it would add rests on a call not stored yet.
    const leaseEntry = await ownerAdd('Turn lease');
    const reinforce = await propose(plain, [{ op: 'reinforce', entryId: pub(leaseEntry), sources: [{ kind: 'tool_call', ref: `${plainLate}-again`, quote: LEASE_QUOTE }] }], 'late-reinforce');
    assert.equal(reinforce.status, 200, reinforce.text);
    assert.equal(reinforce.json.ops[0].status, 'pending', 'held for the owner, where a reinforce otherwise applies at once');
    const reinforceCall = await storeCall(plain, `${plainLate}-again`, LEASE_OUTPUT, 'cat lease.conf');
    const reinforced = await accept(toUuid(reinforce.json.changesetId), toUuid(reinforce.json.ops[0].opId));
    assert.equal(reinforced.status, 200, reinforced.text);
    assert.deepEqual(await sourcesOf(leaseEntry), [{ kind: 'tool_call', ref: reinforceCall.id, quote: LEASE_QUOTE, verified: true }]);

    // Tiered and Automatic: what the mode takes of a stored call's op, and the owner's wait for one not stored yet.
    for (const mode of MODES.slice(1)) {
      await setMode(mode);
      const session = await ordinarySession();
      await storeCall(session, `toolu_stored_${mode}_${RUN}`, LEASE_OUTPUT, 'cat lease.conf');
      const asEver = await propose(session, [add(`Leases in ${mode}`, [{ kind: 'tool_call', ref: `toolu_stored_${mode}_${RUN}`, quote: LEASE_QUOTE }])], `stored-${mode}`);
      assert.equal(asEver.status, 200, asEver.text);
      assert.deepEqual([asEver.json.ops[0].status, asEver.json.ops[0].waitsFor], mode === 'tiered' ? ['applied', undefined] : ['pending', 'verification'],
        `${mode}: a stored call's op is the mode's`);
      const held = await propose(session, [add(`Reclaim in ${mode}`, [{ kind: 'tool_call', ref: `toolu_late_${mode}_${RUN}`, quote: LEASE_QUOTE }])], `late-${mode}`);
      assert.equal(held.status, 200, held.text);
      assert.deepEqual([held.json.ops[0].status, held.json.ops[0].waitsFor], ['pending', undefined], `${mode}: one not stored yet waits for the owner`);
      const heldOp = await opRow(toUuid(held.json.ops[0].opId));
      assert.deepEqual([heldOp.decision, heldOp.applied_by_mode], ['pending', null], `${mode}: nothing applied by the mode`);
      const heldCall = await storeCall(session, `toolu_late_${mode}_${RUN}`, LEASE_OUTPUT, 'cat lease.conf');
      const settled = await accept(toUuid(held.json.changesetId), toUuid(held.json.ops[0].opId));
      assert.equal(settled.status, 200, `${mode}: ${settled.text}`);
      assert.deepEqual(await sourcesOf(toUuid(held.json.ops[0].entryId)), [{ kind: 'tool_call', ref: heldCall.id, quote: LEASE_QUOTE, verified: true }]);
    }
  });

  // ── 4 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  await t.test("4. another session's call, or one never made, is still refused; a call another session had stored before resolves", async () => {
    await setMode('manual');
    const other = await ordinarySession();
    const theirSession = await ordinarySession(strangerToken, wsTheirs, true);
    await storeCall(theirSession, `toolu_theirs_${RUN}`, LEASE_OUTPUT, 'cat lease.conf');
    const cite = (ref: string) => [add(`Leases, as ${ref} said`, [{ kind: 'tool_call', ref, quote: LEASE_QUOTE }])];

    // At the press: a card of a call never made; of one that turns up in another of the owner's sessions; and of another
    // account's — which, at the draft, is a call this account does not hold, like any other not stored yet.
    const chat = await newChat();
    const never = drafted(await propose(chat, cite(`toolu_never_chat_${RUN}`), 'never-chat'), 'a call never made, at the draft');
    const elsewhere = drafted(await propose(chat, cite(`toolu_elsewhere_chat_${RUN}`), 'elsewhere-chat'), 'a call stored later elsewhere, at the draft');
    const foreign = drafted(await propose(chat, cite(`toolu_theirs_${RUN}`), 'theirs-chat'), "another account's call, at the draft");
    await storeCall(other, `toolu_elsewhere_chat_${RUN}`, LEASE_OUTPUT, 'cat lease.conf');
    let before = await writes();
    refused(await press(never), 'WIKI_SOURCE_UNRESOLVED', 'the press of a call never made');
    refused(await press(elsewhere), 'WIKI_SOURCE_UNRESOLVED', "the press of another session's call, not the chat's own");
    refused(await press(foreign), 'WIKI_SOURCE_UNRESOLVED', "the press of another account's call");
    assert.deepEqual(await writes(), before, 'nothing written');
    for (const id of [never, elsewhere, foreign]) assert.equal((await draftRow(id)).decision, null, 'each card still a draft');

    // At the Accept: the same three, proposed by an ordinary session.
    const plain = await ordinarySession();
    const pending: Array<{ changesetId: string; opId: string; what: string }> = [];
    for (const [ref, what] of [
      [`toolu_never_plain_${RUN}`, 'a call never made'],
      [`toolu_elsewhere_plain_${RUN}`, "another session's call"],
      [`toolu_theirs_${RUN}`, "another account's call"],
    ] as const) {
      const proposed = await propose(plain, cite(ref), `${ref}-plain`);
      assert.equal(proposed.status, 200, `${what}, proposed: ${proposed.text}`);
      assert.equal(proposed.json.ops[0].status, 'pending', `${what}: it waits for the owner`);
      pending.push({ changesetId: toUuid(proposed.json.changesetId), opId: toUuid(proposed.json.ops[0].opId), what });
    }
    await storeCall(other, `toolu_elsewhere_plain_${RUN}`, LEASE_OUTPUT, 'cat lease.conf');
    before = await writes();
    for (const one of pending) {
      refused(await accept(one.changesetId, one.opId), 'WIKI_SOURCE_UNRESOLVED', `the Accept of ${one.what}`);
      assert.equal((await opRow(one.opId)).decision, 'pending', `${one.what}: the op still waits`);
    }
    assert.deepEqual(await writes(), before, 'nothing written');

    // At once, with no card and no op: a tool_use_id two sessions carry, a row id that names no call, and a challenge's
    // call not stored yet — a challenge's flag is written at once, and nothing settles its sources afterwards.
    // And a call no session carries, cited by a session the engine is not generating for: no call of its can be on its
    // way, so it is refused at once as ever, a chat's and an ordinary session's alike.
    for (const [sessionId, what] of [[await newChat(true), 'a chat'], [await ordinarySession(ownerToken, wsPlain, true), 'an ordinary session']] as const) {
      refusedAtOnce(await propose(sessionId, cite(`toolu_idle_${RUN}`), `idle-${what}`), 'WIKI_SOURCE_UNRESOLVED', `${what} with no turn running`);
    }
    await storeCall(other, `toolu_twice_${RUN}`, LEASE_OUTPUT, 'cat lease.conf');
    await storeCall(plain, `toolu_twice_${RUN}`, LEASE_OUTPUT, 'cat lease.conf');
    refusedAtOnce(await propose(chat, cite(`toolu_twice_${RUN}`), 'twice'), 'WIKI_SOURCE_UNRESOLVED', 'a tool_use_id two sessions carry');
    refusedAtOnce(await propose(chat, cite(randomUUID()), 'no-row'), 'WIKI_SOURCE_UNRESOLVED', 'a row id that names no call');
    const challenged = await ownerAdd('Reclaim waits a lease, as the owner wrote it');
    refusedAtOnce(await propose(plain, [{ op: 'challenge', entryId: pub(challenged), reason: 'The session read otherwise.', sources: [{ kind: 'tool_call', ref: `toolu_challenge_${RUN}` }] }], 'challenge'),
      'WIKI_SOURCE_UNRESOLVED', "a challenge's call not stored yet");
    assert.equal((await entryRow(challenged)).challenged, false, 'no flag');

    // Another session's call stored before the card resolves, by its tool_use_id, as the contract always said.
    const stored = await storeCall(other, `toolu_stored_before_${RUN}`, LEASE_OUTPUT, 'cat lease.conf');
    const control = drafted(await propose(chat, cite(`toolu_stored_before_${RUN}`), 'stored-before'), "another session's stored call");
    const applied = await press(control);
    assert.equal(applied.status, 200, applied.text);
    const [entryId] = await appliedEntries(control);
    assert.deepEqual(await sourcesOf(entryId!), [{ kind: 'tool_call', ref: stored.id, quote: LEASE_QUOTE, verified: true }]);
  });

  // ── 5 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  await t.test('5. a quote of the output of a call stored without its result waits for the settle: in a chat and in an ordinary session', async () => {
    const cite = (title: string, ref: string, quote: string) => [add(title, [{ kind: 'tool_call', ref, quote }])];
    const decide = (changesetId: string, decision: Record<string, unknown>) =>
      api('POST', `/api/wiki/changesets/${pub(changesetId)}/decide`, ownerToken, { decisions: [decision] });
    const FABRICATED = 'lease_seconds = 999';
    /** What the ingestion's first batch left: a uuid(7) row with the call's input, and no result. */
    const started = async (sessionId: string, ref: string) => {
      const row = await startCall(sessionId, ref);
      assert.match(row.id, /^[0-9a-f]{8}-[0-9a-f]{4}-7/u, 'a uuid(7) id, as the ingestion writes one');
      const stored = (await sql.query(`SELECT "output", "finished_at" FROM "tool_call" WHERE "id" = $1::uuid`, [row.id])).rows[0];
      assert.deepEqual(stored, { output: null, finished_at: null }, 'no result stored yet');
      return row;
    };

    // A chat: the card is made; a press before the result is stored is refused, and the press after it verifies the quote.
    await setMode('manual');
    const chat = await newChat();
    const chatRef = `toolu_result_chat_${RUN}`;
    const chatCall = await started(chat, chatRef);
    let before = await writes();
    const draftId = drafted(await propose(chat, cite('Leases last two minutes', chatRef, LEASE_QUOTE), 'result-chat'),
      'a quote of a result not stored yet');
    assert.deepEqual(await writes(), { ...before, cards: before.cards + 1 }, 'a card, and nothing of the wiki');
    before = await writes();
    refused(await press(draftId), 'WIKI_QUOTE_NOT_FOUND', 'a press before the result is stored');
    assert.deepEqual(await writes(), before, 'nothing written');
    assert.equal((await draftRow(draftId)).decision, null, 'the card is still a draft');
    await finishCall(chat, chatRef, LEASE_OUTPUT);
    const applied = await press(draftId);
    assert.equal(applied.status, 200, `once the result is stored, the press verifies the quote: ${applied.text}`);
    const [chatEntry] = await appliedEntries(draftId);
    assert.deepEqual(await sourcesOf(chatEntry!), [{ kind: 'tool_call', ref: chatCall.id, quote: LEASE_QUOTE, verified: true }],
      "the call's row id, and its quote verified against the whole record");

    // The card's Edit settles it the same way: the owner's revision rests on the call, its quote verified.
    const editRef = `toolu_result_edit_${RUN}`;
    const editCall = await started(chat, editRef);
    const editCard = drafted(await propose(chat, cite('Reclaim waits a lease', editRef, LEASE_QUOTE), 'result-edit'), 'a card to edit');
    await finishCall(chat, editRef, LEASE_OUTPUT);
    const edited = await press(editCard, 'edit', { ops: [{ seq: 0, changes: { title: 'Reclaim waits one lease' } }] });
    assert.equal(edited.status, 200, edited.text);
    assert.deepEqual([edited.json.draft.state, edited.json.draft.decision], ['applied', 'edited']);
    const [editEntry] = await appliedEntries(editCard);
    assert.deepEqual(await sourcesOf(editEntry!, 2), [{ kind: 'tool_call', ref: editCall.id, quote: LEASE_QUOTE, verified: true }]);

    // A quote the result does not hold: the card is made, and its press and its Edit refuse it once the result is in.
    const fabRef = `toolu_result_fab_chat_${RUN}`;
    await started(chat, fabRef);
    const fabCard = drafted(await propose(chat, cite('Leases last a long time', fabRef, FABRICATED), 'result-fab-chat'),
      'a quote of a result not stored yet, which it will not hold');
    await finishCall(chat, fabRef, LEASE_OUTPUT);
    before = await writes();
    refused(await press(fabCard), 'WIKI_QUOTE_NOT_FOUND', 'the press of a quote the result does not hold');
    refused(await press(fabCard, 'edit', { ops: [{ seq: 0, changes: { title: 'Leases last long' } }] }), 'WIKI_QUOTE_NOT_FOUND',
      'its Edit');
    assert.deepEqual(await writes(), before, 'nothing written');
    assert.equal((await draftRow(fabCard)).decision, null, 'the card is still a draft');

    // An ordinary session in Manual: the op waits, nothing is stored for the source, and the Accept settles it.
    const plain = await ordinarySession();
    const plainRef = `toolu_result_plain_${RUN}`;
    const plainCall = await started(plain, plainRef);
    const proposed = await propose(plain, cite('A reclaim waits one lease', plainRef, LEASE_QUOTE), 'result-plain');
    assert.equal(proposed.status, 200, proposed.text);
    assert.deepEqual([proposed.json.ops[0].status, proposed.json.ops[0].waitsFor], ['pending', undefined], 'it waits for the owner');
    const plainEntry = toUuid(proposed.json.ops[0].entryId);
    const changesetId = toUuid(proposed.json.changesetId);
    const opId = toUuid(proposed.json.ops[0].opId);
    assert.deepEqual(await sourcesOf(plainEntry), [], 'nothing is stored for a quote not checked yet');
    before = await writes();
    refused(await accept(changesetId, opId), 'WIKI_QUOTE_NOT_FOUND', 'an Accept before the result is stored');
    assert.deepEqual(await writes(), before, 'nothing written');
    assert.equal((await opRow(opId)).decision, 'pending', 'the op still waits');
    await finishCall(plain, plainRef, LEASE_OUTPUT);
    const accepted = await accept(changesetId, opId);
    assert.equal(accepted.status, 200, `once the result is stored, the Accept verifies the quote: ${accepted.text}`);
    const entry = await entryRow(plainEntry);
    assert.deepEqual([entry.status, entry.trust, entry.unsupported], ['active', 'confirmed', false], 'live, and resting on its source');
    assert.deepEqual(await sourcesOf(plainEntry), [{ kind: 'tool_call', ref: plainCall.id, quote: LEASE_QUOTE, verified: true }],
      'revision 1 holds it now: the row id, its quote verified');

    // Review's Edit settles it as the Accept does.
    const reviewRef = `toolu_result_review_edit_${RUN}`;
    const reviewCall = await started(plain, reviewRef);
    const toEdit = await propose(plain, cite('Reclaim comes after a lease', reviewRef, LEASE_QUOTE), 'result-review-edit');
    assert.equal(toEdit.status, 200, toEdit.text);
    assert.equal(toEdit.json.ops[0].status, 'pending');
    await finishCall(plain, reviewRef, LEASE_OUTPUT);
    const reviewEdited = await decide(toUuid(toEdit.json.changesetId), { opId: toEdit.json.ops[0].opId, action: 'edit', edited: { title: 'Reclaim comes after one lease' } });
    assert.equal(reviewEdited.status, 200, reviewEdited.text);
    assert.deepEqual(await sourcesOf(toUuid(toEdit.json.ops[0].entryId), 2), [{ kind: 'tool_call', ref: reviewCall.id, quote: LEASE_QUOTE, verified: true }],
      "the owner's revision rests on the call, its quote verified");

    // A quote the result does not hold, in Review: refused at the Accept and at the Edit once the result is in.
    const fabPlainRef = `toolu_result_fab_plain_${RUN}`;
    await started(plain, fabPlainRef);
    const fab = await propose(plain, cite('Leases last a long while', fabPlainRef, FABRICATED), 'result-fab-plain');
    assert.equal(fab.status, 200, fab.text);
    assert.equal(fab.json.ops[0].status, 'pending');
    const fabOp = toUuid(fab.json.ops[0].opId);
    await finishCall(plain, fabPlainRef, LEASE_OUTPUT);
    before = await writes();
    refused(await accept(toUuid(fab.json.changesetId), fabOp), 'WIKI_QUOTE_NOT_FOUND', 'the Accept of a quote the result does not hold');
    refused(await decide(toUuid(fab.json.changesetId), { opId: pub(fabOp), action: 'edit', edited: { title: 'Leases last long' } }),
      'WIKI_QUOTE_NOT_FOUND', 'its Edit');
    assert.deepEqual(await writes(), before, 'nothing written');
    assert.equal((await opRow(fabOp)).decision, 'pending', 'the op still waits');

    // A reinforce the effect policy applies at once waits too.
    const leaseEntry = await ownerAdd('Lease length');
    const reinforceRef = `toolu_result_reinforce_${RUN}`;
    const reinforceCall = await started(plain, reinforceRef);
    const reinforce = await propose(plain, [{ op: 'reinforce', entryId: pub(leaseEntry), sources: [{ kind: 'tool_call', ref: reinforceRef, quote: LEASE_QUOTE }] }], 'result-reinforce');
    assert.equal(reinforce.status, 200, reinforce.text);
    assert.equal(reinforce.json.ops[0].status, 'pending', 'held for the owner, where a reinforce otherwise applies at once');
    assert.deepEqual(await sourcesOf(leaseEntry), [], 'nothing added yet');
    await finishCall(plain, reinforceRef, LEASE_OUTPUT);
    const reinforced = await accept(toUuid(reinforce.json.changesetId), toUuid(reinforce.json.ops[0].opId));
    assert.equal(reinforced.status, 200, reinforced.text);
    assert.deepEqual(await sourcesOf(leaseEntry), [{ kind: 'tool_call', ref: reinforceCall.id, quote: LEASE_QUOTE, verified: true }]);

    // Tiered and Automatic: a quote of what is stored — the command — is verified at once and the op is the mode's; one of
    // the output waits for the owner, with nothing applied by the mode, beside it or alone.
    for (const mode of MODES.slice(1)) {
      await setMode(mode);
      const session = await ordinarySession();
      const ref = `toolu_result_${mode}_${RUN}`;
      const call = await started(session, ref);
      const commandQuote = { kind: 'tool_call', ref, quote: 'cat lease.conf' };
      const asEver = await propose(session, [add(`The lease file in ${mode}`, [commandQuote])], `result-command-${mode}`);
      assert.equal(asEver.status, 200, asEver.text);
      assert.deepEqual([asEver.json.ops[0].status, asEver.json.ops[0].waitsFor], mode === 'tiered' ? ['applied', undefined] : ['pending', 'verification'],
        `${mode}: a quote of its command is the mode's, as a stored call's`);
      assert.deepEqual(await sourcesOf(toUuid(asEver.json.ops[0].entryId)), [{ kind: 'tool_call', ref: call.id, quote: 'cat lease.conf', verified: true }],
        `${mode}: verified and stored at once`);
      const held = await propose(session, [add(`Lease seconds in ${mode}`, [commandQuote, { kind: 'tool_call', ref, quote: LEASE_QUOTE }])], `result-output-${mode}`);
      assert.equal(held.status, 200, held.text);
      assert.deepEqual([held.json.ops[0].status, held.json.ops[0].waitsFor], ['pending', undefined], `${mode}: a quote of its output waits for the owner`);
      const heldOp = await opRow(toUuid(held.json.ops[0].opId));
      assert.deepEqual([heldOp.decision, heldOp.applied_by_mode], ['pending', null], `${mode}: nothing applied by the mode`);
      const heldEntry = toUuid(held.json.ops[0].entryId);
      assert.deepEqual(await sourcesOf(heldEntry), [{ kind: 'tool_call', ref: call.id, quote: 'cat lease.conf', verified: true }],
        `${mode}: the command's quote stored, the output's not yet`);
      await finishCall(session, ref, LEASE_OUTPUT);
      const settled = await accept(toUuid(held.json.changesetId), toUuid(held.json.ops[0].opId));
      assert.equal(settled.status, 200, `${mode}: ${settled.text}`);
      assert.deepEqual(await sourcesOf(heldEntry), [
        { kind: 'tool_call', ref: call.id, quote: 'cat lease.conf', verified: true },
        { kind: 'tool_call', ref: call.id, quote: LEASE_QUOTE, verified: true },
      ], `${mode}: the output's quote added at the Accept, verified`);
    }

    // At once, as ever: a challenge's quote of a result not stored yet — its flag is written at once, and nothing settles
    // its sources afterwards; another session's call; the session's own call named by its row id; and a session the
    // engine is not generating for, which has had every result delivered.
    await setMode('manual');
    const challenged = await ownerAdd('Lease length, as the owner put it');
    const challengeRef = `toolu_result_challenge_${RUN}`;
    await started(plain, challengeRef);
    refusedAtOnce(await propose(plain, [{ op: 'challenge', entryId: pub(challenged), reason: 'The session read otherwise.', sources: [{ kind: 'tool_call', ref: challengeRef, quote: LEASE_QUOTE }] }], 'result-challenge'),
      'WIKI_QUOTE_NOT_FOUND', "a challenge's quote of a result not stored yet");
    assert.equal((await entryRow(challenged)).challenged, false, 'no flag');
    const other = await ordinarySession();
    await started(other, `toolu_result_elsewhere_${RUN}`);
    refusedAtOnce(await propose(plain, cite('Leases, as another session read them', `toolu_result_elsewhere_${RUN}`, LEASE_QUOTE), 'result-elsewhere'),
      'WIKI_QUOTE_NOT_FOUND', "another session's call without its result");
    const byRow = await started(plain, `toolu_result_by_row_${RUN}`);
    refusedAtOnce(await propose(plain, cite('Leases, by the row', byRow.id, LEASE_QUOTE), 'result-by-row'),
      'WIKI_QUOTE_NOT_FOUND', 'its own call named by its row id');
    for (const [sessionId, what] of [[await newChat(true), 'chat'], [await ordinarySession(ownerToken, wsPlain, true), 'plain']] as const) {
      await started(sessionId, `toolu_result_idle_${what}_${RUN}`);
      refusedAtOnce(await propose(sessionId, cite(`Leases, idle ${what}`, `toolu_result_idle_${what}_${RUN}`, LEASE_QUOTE), `result-idle-${what}`),
        'WIKI_QUOTE_NOT_FOUND', `a ${what} session with no turn running`);
    }
  });
});
