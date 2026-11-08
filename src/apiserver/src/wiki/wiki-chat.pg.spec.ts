/**
 * The wiki chat's session (contracts/wiki.contract.json `chat`; docs/wiki-contract.md §28.1–§28.4;
 * docs/project-source-contract.md SR54; wiki chat project task C5), held against the production apiserver —
 * `build/main.js`, the whole AppModule — over a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/wiki/wiki-chat.pg.spec.ts
 *
 * Two accounts, three machines (two that beat, one that never does), one space on a repository with a confirmed plan
 * and a written document. Against one server:
 *
 *   1. making and listing chats: the create answers `{ sessionId, chat }`; the session is an ordinary session of the
 *      workspace with `wiki_chat_space_id`, a branch (a worktree of its own) and its first turn filed as the owner's —
 *      the words alone, the client's UUID, an explicit routing intent; the list names the remembered workspace, the
 *      eligible ones by name and the button's counts; `GET /api/sessions/:id` carries `wikiChatSpaceId`;
 *   2. choosing the workspace once and remembering it: the first create names one and the space remembers it; a later
 *      create without one uses it, one naming another replaces it (Runs in), and the settings PATCH sets and forgets it;
 *      a workspace that runs no worktrees, one left out and one on another repository are refused 400 and never
 *      stored, another account's is a 404; a remembered workspace that stops being eligible is shown, not used; a
 *      machine that is offline keeps its chat, which waits for it;
 *   3. a workspace with worktrees off is refused 409 by `SessionsService.create` — also when it was turned off between
 *      the door's look and the transaction — and nothing is made;
 *   4. the SOURCE: the selector frozen with the row (SELECTED, CHAT_UPSTREAM, refs/heads/main, REMOTE, no codebase, no
 *      configRevision, nothing it must contain, the workspace's repository and the space's root commit); the claim hands
 *      it to a runner that pins; the runner's own resolution against a real repository reads origin's main, not the
 *      checkout's HEAD; the pin freezes and a second one is refused; the reclaim reads it back; the chat column and the
 *      selector refuse every later write;
 *   5. the notes: the first delivery appends `<orbit_wiki_chat>`, the page and the selection, read from the document at
 *      delivery; a later message carries its selection alone, and a sentence the document no longer holds is left out
 *      and said so; an entry page and a plan page carry what wiki_get and the plan read hold;
 *   6. every turn's content is the owner's words, the note is exactly what delivery appended, and each turn reads as
 *      the owner's own (`isOwnerTurn`); a wikiContext of the wrong shape is refused WIKI_SCHEMA, one sent to a session
 *      that is no chat is a 400, and neither files a turn;
 *   7. a request with a session header is refused WIKI_OWNER_CHANNEL_ONLY by both chat routes and by the settings PATCH;
 *   8. another account's space, chat, session and workspace are the plain 404;
 *   9. the first message's pictures and files ride the create (board 43): scoped to the chat and linked to its first turn
 *      in the transaction that files it, and handed to the runner with the words; another account's upload, or one a
 *      session already took, is a 400 and makes nothing; the toolbar's mode, effort and speed are the session's.
 *
 * The dossier's half (a chat's drafting calls are left out) is in wiki-dossier.pg.spec.ts, beside the wiki reads it
 * mirrors, and the runner's half (the checkout forks from the pin; an empty branch is dropped) in
 * src/runner-go/chat_branch_test.go.
 *
 * Not destructive: every row belongs to accounts this run creates, and the one repository lives in a directory of its own
 * that the run removes.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { toUuid, uuidToBase62, WIKI_CHAT_COPY, WIKI_CHAT_PROMPT } from '@orbit/shared';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { hashPassword } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { controlPlaneNoteOf } from '../runner-api/control-plane-note';
import { SessionsService } from '../sessions/sessions.service';
import { isOwnerTurn } from './wiki.service';
import '../test-support/daemon-routes-over-http';

const URL_ = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const REPO_URL = `https://github.com/example/chat-${RUN}`;
const ELSEWHERE_URL = `https://github.com/example/elsewhere-${RUN}`;
const SHA = '1f'.repeat(20);
const ROOT = 'b2'.repeat(20);
const ENGINES = [{ engine: 'claude', installed: true, auth: 'yes', version: '2.3.0' }];
/** What a runner of today declares: the one this file needs is SR35's. */
const CAPABILITIES = 'source-pin/v1';

interface Machine {
  runnerId: string;
  token: string;
}

/** A body as its fields read, without the public-id twins every response carries beside them (`sessionPublicId`). */
const withoutTwins = (value: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !/(?:^p|P)ublicIds?$/u.test(key)));

/** What a Nest exception answers with. */
const statusOf = (error: unknown): number | undefined => (error as { getStatus?: () => number }).getStatus?.();

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'spec', GIT_AUTHOR_EMAIL: 'spec@chat.invalid', GIT_COMMITTER_NAME: 'spec', GIT_COMMITTER_EMAIL: 'spec@chat.invalid' },
  }).trim();

test('the wiki chat is an ordinary session of the workspace the space chose, started from origin/main', {
  skip: !URL_, concurrency: 1, timeout: 900_000,
}, async (t) => {
  const url = URL_!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma: PrismaClient = prismaClientFor(url);
  const scratch = mkdtempSync(path.join(tmpdir(), `wiki-chat-${RUN}-`));
  let server: Apiserver | undefined;
  t.after(async () => {
    await server?.stop();
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
    rmSync(scratch, { recursive: true, force: true });
  });

  const account = async (name: string) => {
    const id = randomUUID();
    const password = `pw-${name}-${RUN}`;
    const email = `${name}-${RUN}@wiki-chat.invalid`;
    await sql.query(`INSERT INTO "user" (id, email, name, password_hash, role) VALUES ($1, $2, $3, $4, 'MEMBER')`,
      [id, email, name, hashPassword(password)]);
    return { id, email, password };
  };
  const owner = await account('owner');
  const stranger = await account('stranger');

  server = await startApiserver(url, `wiki-chat-${randomUUID()}`);
  const api = (method: string, route: string, bearer?: string, body?: unknown, headers?: Record<string, string>): Promise<Reply> =>
    call(server!, method, route, bearer, body, headers);
  const signIn = async (who: { email: string; password: string }) => {
    const reply = await api('POST', '/api/auth/login', undefined, { email: who.email, password: who.password });
    assert.equal(reply.status, 201, reply.text);
    return reply.json.accessToken as string;
  };
  const ownerToken = await signIn(owner);
  const strangerToken = await signIn(stranger);

  /** `orbit register --token`: an enrollment token the owner minted. */
  const register = async (bearer: string, name: string): Promise<Machine> => {
    const minted = await api('POST', '/api/runners/enrollment-tokens', bearer, { label: `wiki chat ${RUN}` });
    assert.equal(minted.status, 201, minted.text);
    const registered = await api('POST', '/api/runner/register', undefined, { enrollmentToken: minted.json.token, name, hostname: name });
    assert.equal(registered.status, 201, registered.text);
    return { runnerId: toUuid(registered.json.runnerId), token: registered.json.runnerToken };
  };
  const beat = async (machine: Machine) => {
    const reply = await api('POST', '/api/runner/heartbeat', machine.token, { status: 'ONLINE', engines: ENGINES },
      { 'x-orbit-runner-capabilities': CAPABILITIES });
    assert.equal(reply.status < 300, true, reply.text);
  };
  const hpc = await register(ownerToken, `hpc-${RUN}`);
  const delivery = await register(ownerToken, `delivery-${RUN}`);
  const asleep = await register(ownerToken, `asleep-${RUN}`);
  const strangers = await register(strangerToken, `strangers-${RUN}`);
  await beat(hpc);
  await beat(delivery);
  await beat(strangers);

  const workspace = async (ownerId: string, runnerId: string, name: string, shape: { repoUrl?: string | null; worktree?: boolean } = {}) => {
    const id = randomUUID();
    await sql.query(
      `INSERT INTO "workspace" (id, name, owner_id, runner_id, work_dir, repo_url, enable_worktree)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, name, ownerId, runnerId, `/srv/${name}`, shape.repoUrl === undefined ? REPO_URL : shape.repoUrl, shape.worktree ?? true],
    );
    return id;
  };
  const wsDev = await workspace(owner.id, hpc.runnerId, 'orbit-develop');
  const wsOther = await workspace(owner.id, hpc.runnerId, 'orbit-other');
  const wsShared = await workspace(owner.id, hpc.runnerId, 'orbit-shared', { worktree: false });
  const wsLeftOut = await workspace(owner.id, hpc.runnerId, 'orbit-left-out');
  const wsElsewhere = await workspace(owner.id, hpc.runnerId, 'orbit-elsewhere', { repoUrl: ELSEWHERE_URL });
  const wsOffline = await workspace(owner.id, asleep.runnerId, 'orbit-asleep');
  const wsDelivery = await workspace(owner.id, delivery.runnerId, 'orbit-delivery');
  const wsStranger = await workspace(stranger.id, strangers.runnerId, 'theirs');
  const pub = (id: string) => uuidToBase62(id);

  // ── the space: on the repository, with a confirmed plan and one written document ──────────────────────────────
  const made = await api('POST', '/api/wiki/spaces', ownerToken, { title: `Orbit ${RUN}`, repoUrl: REPO_URL });
  assert.equal(made.status, 201, made.text);
  const spaceId = toUuid(made.json.id);
  await sql.query(`UPDATE "wiki_space" SET "root_commit_sha" = $2 WHERE "id" = $1::uuid`, [spaceId, ROOT]);
  const leftOut = await api('DELETE', `/api/wiki/spaces/${pub(spaceId)}/workspaces/${pub(wsLeftOut)}`, ownerToken);
  assert.equal(leftOut.status, 200, leftOut.text);

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
  const planSections = [
    { key: 'overview', title: 'Overview', covers: 'what a session is' },
    { key: 'turn-delivery', title: 'Turn delivery', covers: 'how a turn reaches the engine' },
    { key: 'leases', title: 'Leases', covers: 'how long a runner holds a turn' },
  ];
  for (const [position, section] of planSections.entries()) {
    await prisma.wikiPlanSection.create({
      data: { docId: planDoc.id, ownerId: owner.id, position, key: section.key, title: section.title, kind: 'flow', covers: section.covers, length: 200, sources: {} },
    });
  }
  const doc = await prisma.wikiDoc.create({
    data: { spaceId, ownerId: owner.id, slug: 'sessions-runtime', planId, planVersion: 1, planDocId: planDoc.id, status: 'ok', repoSha: SHA },
  });
  const TURN_RECORD = randomUUID();
  const RECORD_SESSION = randomUUID();
  const VIA = randomUUID();
  // A verified footnote carries its quote (wiki_doc_footnote_quote_chk); the notes name where, never what it quotes.
  const footnote = (ref: string, lines: [number, number]) => ({
    kind: 'code', ref, sha: SHA, lineStart: lines[0], lineEnd: lines[1], locator: {}, quote: 'lease', verdict: 'verified', checkedBy: 'runner',
  });
  const section = async (key: string, sentences: Array<{ text: string; footnotes: Array<Record<string, unknown>> }>) => {
    const row = await prisma.wikiDocSection.create({
      data: {
        docId: doc.id, ownerId: owner.id, key, planSectionId: randomUUID(), materialSha256: 'f'.repeat(64),
        blocks: [{ kind: 'paragraph' }] as never, repoSha: SHA, model: 'spec-model',
      },
    });
    const ids: string[] = [];
    for (const [position, sentence] of sentences.entries()) {
      const stored = await prisma.wikiDocSentence.create({
        data: { sectionId: row.id, ownerId: owner.id, position, block: 0, text: sentence.text, status: 'sourced' },
      });
      for (const [p, note] of sentence.footnotes.entries()) {
        await prisma.wikiDocFootnote.create({ data: { sentenceId: stored.id, ownerId: owner.id, position: p, ...note } as never });
      }
      ids.push(stored.id);
    }
    return { id: row.id, sentences: ids };
  };
  const delivered = await section('turn-delivery', [
    {
      text: 'The runner leases one turn at a time.',
      footnotes: [
        footnote('src/runner-go/inbox.go', [10, 40]),
        {
          kind: 'turn', ref: TURN_RECORD, sha: null, charStart: 0, charEnd: 10, locator: { sessionId: RECORD_SESSION },
          quote: 'one turn', verdict: 'verified', checkedBy: 'server', viaEntryId: VIA,
        },
      ],
    },
    { text: 'A steer joins the turn already running.', footnotes: [footnote('src/apiserver/src/runner-api/runner-api.controller.ts', [5200, 5260])] },
  ]);
  const leases = await section('leases', [
    { text: 'A lease expires after ninety seconds.', footnotes: [footnote('src/runner-go/inbox.go', [90, 95])] },
  ]);
  const [S1, S2] = delivered.sentences;
  const [S3] = leases.sentences;

  const chats = `/api/wiki/spaces/${pub(spaceId)}/chats`;
  const create = (body: Record<string, unknown>, bearer = ownerToken, headers?: Record<string, string>) =>
    api('POST', chats, bearer, { clientTurnId: randomUUID(), content: 'Is the lease really ninety seconds?', ...body }, headers);
  const list = (bearer = ownerToken, headers?: Record<string, string>) => api('GET', chats, bearer, undefined, headers);
  const sessionRow = async (id: string) => (await sql.query(`SELECT * FROM "session" WHERE "id" = $1::uuid`, [id])).rows[0];
  const turnsOf = async (sessionId: string) =>
    (await sql.query(`SELECT * FROM "conversation_turn" WHERE "session_id" = $1::uuid ORDER BY "seq"`, [sessionId])).rows;
  const sessionsIn = async (workspaceId: string) =>
    Number((await sql.query(`SELECT count(*)::int AS n FROM "session" WHERE "workspace_id" = $1::uuid`, [workspaceId])).rows[0].n);
  const remembered = async () => (await api('GET', `/api/wiki/spaces/${pub(spaceId)}`, ownerToken)).json.settings.chat.workspaceId as string | null;

  const WORDS = 'Is the lease really ninety seconds? The runner code reads differently.';
  const firstContext = {
    page: { kind: 'doc', docSlug: 'sessions-runtime', sectionKey: 'turn-delivery' },
    selection: { docSlug: 'sessions-runtime', sectionKey: 'turn-delivery', sentenceIds: [pub(S1), pub(S3)] },
  };
  let firstChat = '';
  let firstClientTurnId = '';

  await t.test('1. a chat is made through the session create and listed with where it runs', async () => {
    await beat(hpc);
    await beat(delivery);
    firstClientTurnId = randomUUID();
    const answer = await create({ workspaceId: pub(wsDev), content: WORDS, clientTurnId: firstClientTurnId, wikiContext: firstContext });
    assert.equal(answer.status, 201, answer.text);
    firstChat = toUuid(answer.json.sessionId);
    assert.deepEqual(
      { ...withoutTwins(answer.json.chat), sessionId: toUuid(answer.json.chat.sessionId), createdAt: typeof answer.json.chat.createdAt, updatedAt: typeof answer.json.chat.updatedAt, title: typeof answer.json.chat.title },
      { sessionId: firstChat, title: 'string', status: 'PENDING', open: true, createdAt: 'string', updatedAt: 'string', drafts: 0, needsYou: 0 },
      'the answer is the chat as the list serves it',
    );

    const row = await sessionRow(firstChat);
    assert.equal(row.wiki_chat_space_id, spaceId, 'a chat of this space');
    assert.equal(row.workspace_id, wsDev);
    assert.equal(row.assigned_runner_id, hpc.runnerId, 'on the machine the workspace is on');
    assert.ok(row.branch, 'a worktree of its own: the session has a branch');
    assert.equal(row.prompt, WORDS);
    assert.equal(row.status, 'PENDING');

    const turns = await turnsOf(firstChat);
    assert.equal(turns.length, 1, 'one turn, the one the create filed');
    assert.deepEqual(
      [turns[0].seq, turns[0].kind, turns[0].content, turns[0].client_turn_id, turns[0].send_intent],
      [1, 'message', WORDS, firstClientTurnId, 'NEXT_TURN'],
      "the owner's words under the client's UUID, with an explicit routing intent",
    );
    assert.deepEqual(turns[0].wiki_context, firstContext, 'the page and the selection, as ids');
    assert.equal(isOwnerTurn({ kind: turns[0].kind, sendIntent: turns[0].send_intent, clientTurnId: turns[0].client_turn_id }), true,
      'first-hand: reviewModes.tiered.auto.ownerWords');
    // It is the chat's prompt, as the seeded opening turn is any other session's: no queued follow-up, and not withdrawable.
    const queued = await api('GET', `/api/sessions/${pub(firstChat)}/turns`, ownerToken);
    assert.equal(queued.status, 200, queued.text);
    assert.deepEqual(queued.json, [], 'its opening turn is no queued follow-up');
    const withdrawn = await api('DELETE', `/api/sessions/${pub(firstChat)}/turns/${pub(turns[0].id)}`, ownerToken);
    assert.equal(withdrawn.status, 409, withdrawn.text);
    assert.equal((await turnsOf(firstChat)).length, 1, 'and it stays');

    const listed = await list();
    assert.equal(listed.status, 200, listed.text);
    assert.equal(toUuid(listed.json.spaceId), spaceId);
    assert.deepEqual({ ...withoutTwins(listed.json.workspace), id: toUuid(listed.json.workspace.id) },
      { id: wsDev, name: 'orbit-develop', runner: `hpc-${RUN}`, online: true, eligible: true }, 'the first choice is remembered');
    assert.deepEqual(
      listed.json.choices.map((c: { id: string; name: string; online: boolean }) => [c.name, toUuid(c.id), c.online]),
      [['orbit-asleep', wsOffline, false], ['orbit-delivery', wsDelivery, true], ['orbit-develop', wsDev, true], ['orbit-other', wsOther, true]],
      'only the workspaces of the space that run worktrees, by name, each saying whether its machine is there',
    );
    assert.deepEqual(listed.json.fab, { needsYou: 0, working: true, updated: 0 }, 'a turn is queued');
    assert.deepEqual(listed.json.chats.map((c: { sessionId: string }) => toUuid(c.sessionId)), [firstChat]);
    assert.equal(toUuid(await remembered() as string), wsDev, "and the space's settings say so");

    const read = await api('GET', `/api/sessions/${pub(firstChat)}`, ownerToken);
    assert.equal(read.status, 200, read.text);
    assert.equal(toUuid(read.json.wikiChatSpaceId), spaceId, 'the session read says where it came from');
    const plain = await api('POST', '/api/sessions', ownerToken, { prompt: 'an ordinary session', workspaceId: pub(wsDev) });
    assert.equal(plain.status, 201, plain.text);
    const plainRead = await api('GET', `/api/sessions/${plain.json.id}`, ownerToken);
    assert.equal(plainRead.json.wikiChatSpaceId, null, 'and an ordinary one is no chat');
    assert.equal((await sessionRow(toUuid(plain.json.id))).source_state, 'UNBOUND', 'whose SOURCE is what it always was');
  });

  await t.test('2. the workspace is chosen once and remembered; Runs in changes it; only an eligible one is taken', async () => {
    const again = await create({});
    assert.equal(again.status, 201, again.text);
    assert.equal((await sessionRow(toUuid(again.json.sessionId))).workspace_id, wsDev, 'without a workspace, the remembered one');

    const moved = await create({ workspaceId: pub(wsOther) });
    assert.equal(moved.status, 201, moved.text);
    assert.equal((await sessionRow(toUuid(moved.json.sessionId))).workspace_id, wsOther);
    assert.equal(toUuid(await remembered() as string), wsOther, 'a create naming another replaces it');

    for (const [ineligible, why] of [[wsShared, 'runs no worktrees'], [wsLeftOut, 'is left out'], [wsElsewhere, 'is on another repository']] as const) {
      const before = await sessionsIn(ineligible);
      const refused = await create({ workspaceId: pub(ineligible) });
      assert.equal(refused.status, 400, `${why}: ${refused.text}`);
      assert.equal(await sessionsIn(ineligible), before, `${why}: nothing is made`);
      assert.equal(toUuid(await remembered() as string), wsOther, `${why}: nothing is remembered`);
      const patched = await api('PATCH', `/api/wiki/spaces/${pub(spaceId)}`, ownerToken, { chat: { workspaceId: pub(ineligible) } });
      assert.equal(patched.status, 400, `${why}: the settings take it no more than the create does: ${patched.text}`);
    }
    const theirs = await create({ workspaceId: pub(wsStranger) });
    assert.equal(theirs.status, 404, theirs.text);
    assert.equal(await sessionsIn(wsStranger), 0);
    const blank = await create({ workspaceId: '   ' });
    assert.equal(blank.status, 400, `a blank workspaceId is refused, never read as an id: ${blank.text}`);
    assert.equal(toUuid(await remembered() as string), wsOther, 'and nothing is remembered');

    // The settings PATCH sets it — to a machine that is offline, which is no reason to move anywhere else.
    const set = await api('PATCH', `/api/wiki/spaces/${pub(spaceId)}`, ownerToken, { chat: { workspaceId: pub(wsOffline) } });
    assert.equal(set.status, 200, set.text);
    assert.equal(toUuid(set.json.settings.chat.workspaceId), wsOffline);
    const waiting = await create({});
    assert.equal(waiting.status, 201, waiting.text);
    const waitingRow = await sessionRow(toUuid(waiting.json.sessionId));
    assert.deepEqual([waitingRow.workspace_id, waitingRow.assigned_runner_id, waitingRow.status], [wsOffline, asleep.runnerId, 'PENDING'],
      'made, and waiting for its own machine');
    const offline = await list();
    assert.deepEqual({ ...withoutTwins(offline.json.workspace), id: toUuid(offline.json.workspace.id) },
      { id: wsOffline, name: 'orbit-asleep', runner: `asleep-${RUN}`, online: false, eligible: true }, 'the list says the machine is offline');

    // A remembered workspace that stops being eligible is shown and not used: the panel asks again.
    await sql.query(`UPDATE "workspace" SET "enable_worktree" = false WHERE "id" = $1::uuid`, [wsOffline]);
    const stale = await list();
    assert.equal(stale.json.workspace.eligible, false);
    assert.equal(stale.json.choices.some((c: { id: string }) => toUuid(c.id) === wsOffline), false);
    const asks = await create({});
    assert.equal(asks.status, 400, asks.text);
    assert.match(asks.text, new RegExp(WIKI_CHAT_COPY.panel.chooseWorkspace.replace(/'/gu, '.')), 'it asks to choose');
    await sql.query(`UPDATE "workspace" SET "enable_worktree" = true WHERE "id" = $1::uuid`, [wsOffline]);

    const forgot = await api('PATCH', `/api/wiki/spaces/${pub(spaceId)}`, ownerToken, { chat: { workspaceId: null } });
    assert.equal(forgot.status, 200, forgot.text);
    assert.equal(forgot.json.settings.chat.workspaceId, null, 'null forgets it');
    assert.equal((await list()).json.workspace, null);
    const none = await create({});
    assert.equal(none.status, 400, `nothing remembered and nothing named: ${none.text}`);
  });

  await t.test('3. a workspace with worktrees off is refused 409 by the create, the race included, and nothing is made', async () => {
    let flip: string | null = null;
    const racing = prisma.$extends({
      query: {
        workspace: {
          async findFirst({ args, query }) {
            const found = await query(args);
            // The create's first read of its workspace, then a person turning worktrees off before its transaction.
            if (flip && (args as unknown as { select?: { enableWorktree?: boolean } }).select?.enableWorktree) {
              await sql.query(`UPDATE "workspace" SET "enable_worktree" = false WHERE "id" = $1::uuid`, [flip]);
              flip = null;
            }
            return found;
          },
        },
      },
    });
    const sessions = new SessionsService(
      racing as never,
      { notifySessionQueued: () => undefined } as never,
      { publishSessionCreated: () => undefined, publishWorkspaceChanged: () => undefined } as never,
    );
    const asChat = (workspaceId: string) => sessions.create(owner.id, { prompt: WORDS, workspaceId } as never, {
      wikiChat: { spaceId, clientTurnId: randomUUID(), wikiContext: null, repository: { repoUrl: REPO_URL, rootCommitSha: null } },
    });

    const before = await sessionsIn(wsShared);
    await assert.rejects(asChat(wsShared), (error: { message?: string }) => {
      assert.equal(statusOf(error), 409);
      assert.match(String(error.message), /worktrees of their own/u);
      return true;
    });
    assert.equal(await sessionsIn(wsShared), before, 'nothing is made');

    const raced = await workspace(owner.id, hpc.runnerId, 'orbit-raced');
    flip = raced;
    await assert.rejects(asChat(raced), (error: unknown) => {
      assert.equal(statusOf(error), 409, 'the transaction reads it again, under its lock');
      return true;
    });
    assert.equal(flip, null, 'it was turned off between the two reads');
    assert.equal(await sessionsIn(raced), 0, 'no session, and so no turn');
  });

  // ── the repository the delivery machine's checkout is on: origin's main is ahead of the checkout's HEAD ────────
  const origin = path.join(scratch, 'origin.git');
  const checkout = path.join(scratch, 'checkout');
  const seed = path.join(scratch, 'seed');
  git(scratch, 'init', '--bare', '--initial-branch=main', origin);
  git(scratch, 'clone', origin, seed);
  writeFileSync(path.join(seed, 'README.md'), 'one\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', 'one');
  git(seed, 'push', 'origin', 'HEAD:main');
  git(scratch, 'clone', origin, checkout);
  writeFileSync(path.join(seed, 'README.md'), 'two\n');
  git(seed, 'commit', '-am', 'two');
  git(seed, 'push', 'origin', 'HEAD:main');
  const checkoutHead = git(checkout, 'rev-parse', 'HEAD');
  const mainTip = git(seed, 'rev-parse', 'HEAD');
  assert.notEqual(checkoutHead, mainTip, 'the checkout is behind origin/main, as in design §5.2');

  let deliveryChat = '';
  let leaseGeneration = '';
  const inbox = async () => {
    const answer = await api('GET', `/api/runner/sessions/${pub(deliveryChat)}/inbox?leaseGeneration=${leaseGeneration}`, delivery.token,
      undefined, { 'x-orbit-runner-capabilities': CAPABILITIES });
    assert.equal(answer.status, 200, answer.text);
    assert.ok(answer.json?.turnId, `the inbox handed out no turn: ${answer.text}`);
    return { turnId: toUuid(answer.json.turnId), content: String(answer.json.content ?? '') };
  };

  await t.test('4. the SOURCE is origin/main, frozen at create and pinned at the first claim', async () => {
    await beat(delivery);
    const answer = await create({ workspaceId: pub(wsDelivery), content: WORDS, wikiContext: firstContext });
    assert.equal(answer.status, 201, answer.text);
    deliveryChat = toUuid(answer.json.sessionId);
    const row = await sessionRow(deliveryChat);
    assert.deepEqual(
      [row.source_state, row.source_kind, row.source_ref, row.source_revision_sha, row.source_ref_authority, row.source_codebase_id,
        row.source_config_revision, row.source_required_contains, row.source_repo_url, row.source_root_commit_sha, row.source_base_sha],
      ['SELECTED', 'CHAT_UPSTREAM', 'refs/heads/main', null, 'REMOTE', null, null, [], REPO_URL, ROOT, null],
      'SR54: the selector, written with the row',
    );

    const claim = await api('GET', '/api/runner/sessions/claim', delivery.token, undefined, { 'x-orbit-runner-capabilities': CAPABILITIES });
    assert.equal(claim.status, 200, claim.text);
    assert.equal(toUuid(claim.json?.sessionId ?? '00000000-0000-0000-0000-000000000000'), deliveryChat, claim.text.slice(0, 400));
    assert.equal(claim.json.branch, row.branch, 'the claim carries the branch the worktree is made on');
    const source = claim.json.source as Record<string, unknown>;
    assert.deepEqual(
      [source.state, source.kind, source.ref, source.revisionSha, source.refAuthority, source.remoteName, source.codebaseId, source.requiredContains, source.repoUrl],
      ['SELECTED', 'CHAT_UPSTREAM', 'refs/heads/main', undefined, 'REMOTE', 'origin', undefined, [], REPO_URL],
      'what the runner is handed: a ref asked of origin, and no codebase',
    );
    const turns = await turnsOf(deliveryChat);
    assert.deepEqual(turns.map((turn) => turn.client_turn_id).filter((key) => String(key).startsWith('initial-')), [],
      'the claim laid no second opening turn down');

    // What the runner does with it (resolveSourceSha, src/runner-go/source.go): fetch the ref into a ref of the
    // session's own, and read that — never the checkout's HEAD.
    const pinRef = `refs/orbit-source-pin/${deliveryChat}`;
    git(checkout, 'fetch', '--no-tags', String(source.remoteName), `+${String(source.ref)}:${pinRef}`);
    const resolved = git(checkout, 'rev-parse', '--verify', `${pinRef}^{commit}`);
    assert.equal(resolved, mainTip, "origin's main, not the checkout's HEAD");
    const pinned = await api('POST', `/api/runner/sessions/${pub(deliveryChat)}/source/pin`, delivery.token, { baseSha: resolved });
    assert.equal(pinned.status, 200, pinned.text);
    assert.deepEqual([pinned.json.state, pinned.json.baseSha, pinned.json.wonRace], ['PINNED', mainTip, true]);
    const again = await api('POST', `/api/runner/sessions/${pub(deliveryChat)}/source/pin`, delivery.token, { baseSha: checkoutHead });
    assert.equal(again.status, 200, again.text);
    assert.deepEqual([again.json.state, again.json.baseSha, again.json.wonRace], ['PINNED', mainTip, false], 'the pin is frozen');
    const pinnedRow = await sessionRow(deliveryChat);
    assert.deepEqual([pinnedRow.source_state, pinnedRow.source_base_sha], ['PINNED', mainTip]);
    const reclaimed = await api('GET', '/api/runner/sessions/reclaim', delivery.token, undefined, { 'x-orbit-runner-capabilities': CAPABILITIES });
    assert.equal(reclaimed.status, 200, reclaimed.text);
    const held = (reclaimed.json.sessions as Array<{ sessionId: string; source?: { state: string; baseSha?: string } }>)
      .find((s) => toUuid(s.sessionId) === deliveryChat);
    assert.deepEqual([held?.source?.state, held?.source?.baseSha], ['PINNED', mainTip], 'a reclaim reads the pin and resolves nothing');

    await assert.rejects(sql.query(`UPDATE "session" SET "wiki_chat_space_id" = NULL WHERE "id" = $1::uuid`, [deliveryChat]),
      /WIKI_CHAT_SPACE_IMMUTABLE/u, 'a chat for its whole life');
    await assert.rejects(sql.query(`UPDATE "session" SET "source_ref" = 'refs/heads/other' WHERE "id" = $1::uuid`, [deliveryChat]),
      /SOURCE_PIN_IMMUTABLE/u, 'and its selector is frozen like every other');
    // The CHECKs: the chat's is the one SOURCE shape with no codebase, and it is a ref.
    const insert = (columns: Record<string, unknown>) => sql.query(
      `INSERT INTO "session" (id, title, prompt, owner_id, creator_id, workspace_id, status, dispatch_origin, updated_at, source_state,
         source_kind, source_codebase_id, source_repo_url, source_ref, source_revision_sha, source_config_revision, source_ref_authority)
       VALUES ($1, 'shape', 'p', $2, $2, $3, 'PENDING', 'USER', now(), 'SELECTED', 'CHAT_UPSTREAM', $4, $5, $6, $7, $8, 'REMOTE')`,
      [randomUUID(), owner.id, wsDelivery, columns.codebase ?? null, REPO_URL, columns.ref === undefined ? 'refs/heads/main' : columns.ref,
        columns.revision ?? null, columns.config ?? null],
    );
    await assert.rejects(insert({ codebase: randomUUID() }), /session_source_snapshot_chk/u, 'a chat resolves against no codebase');
    await assert.rejects(insert({ config: 1 }), /session_source_snapshot_chk/u, 'and freezes no configuration');
    await assert.rejects(insert({ ref: null, revision: SHA }), /session_source_(snapshot|kind_selector)_chk/u, 'and is a ref, not a SHA');
  });

  const sentence = (text: string, notes: string[]) => [text, ...notes.map((note) => `  - ${note}`)];
  const inboxNote = `src/runner-go/inbox.go@${SHA}#L10-40`;
  const recordNote = `turn ${pub(TURN_RECORD)} in session ${pub(RECORD_SESSION)}, via entry ${pub(VIA)}`;
  const steerNote = `src/apiserver/src/runner-api/runner-api.controller.ts@${SHA}#L5200-5260`;
  const leaseNote = `src/runner-go/inbox.go@${SHA}#L90-95`;
  const PAGE = [
    `<orbit_wiki_page of="doc" doc="1.1" slug="sessions-runtime" section="2" key="turn-delivery" repoSha="${SHA}">`,
    '1.1 Sessions runtime · §2 Turn delivery',
    ...sentence('The runner leases one turn at a time.', [inboxNote, recordNote]),
    ...sentence('A steer joins the turn already running.', [steerNote]),
    '</orbit_wiki_page>',
  ].join('\n');
  const SELECTION = [
    `<orbit_wiki_selection doc="1.1" slug="sessions-runtime" section="2" key="turn-delivery" to="3" sentences="2" sources="3" repoSha="${SHA}">`,
    '§2 Turn delivery',
    ...sentence('The runner leases one turn at a time.', [inboxNote, recordNote]),
    '§3 Leases',
    ...sentence('A lease expires after ninety seconds.', [leaseNote]),
    '</orbit_wiki_selection>',
  ].join('\n');

  const answered = (turnId: string) =>
    sql.query(`UPDATE "conversation_turn" SET "status" = 'ANSWERED', "answered_at" = now() WHERE "id" = $1::uuid`, [turnId]);
  const send = (body: Record<string, unknown>, sessionId = deliveryChat, bearer = ownerToken) =>
    api('POST', `/api/sessions/${pub(sessionId)}/turns`, bearer, { clientTurnId: randomUUID(), intent: 'NEXT_TURN', ...body });

  let firstTurn = '';
  await t.test("5–6. the first delivery appends the chat's rules, the page and the selection after the words, read now", async () => {
    // What a runner does with the session it claimed: take the inbox over, then activate a generation of its own.
    const { rows: [current] } = await sql.query<{ owner: string | null }>(
      `SELECT "inbox_lease_owner"::text AS "owner" FROM "session" WHERE "id" = $1::uuid`, [deliveryChat]);
    const leaseOwner = randomUUID();
    const taken = await api('POST', `/api/runner/sessions/${pub(deliveryChat)}/takeover-leases`, delivery.token,
      { leaseOwner, expectedLeaseOwner: current.owner }, { 'x-orbit-runner-capabilities': CAPABILITIES });
    assert.equal(taken.status, 200, taken.text);
    leaseGeneration = randomUUID();
    const activated = await api('POST', `/api/runner/sessions/${pub(deliveryChat)}/activate-leases`, delivery.token,
      { leaseOwner, leaseGeneration }, { 'x-orbit-runner-capabilities': CAPABILITIES });
    assert.equal(activated.status, 200, activated.text);

    const handed = await inbox();
    const [turn] = await turnsOf(deliveryChat);
    firstTurn = turn.id;
    assert.equal(handed.turnId, turn.id);
    assert.equal(handed.content, `${WORDS}\n\n${WIKI_CHAT_PROMPT}\n\n${PAGE}\n\n${SELECTION}`, 'the words, then the three blocks');
    assert.equal(turn.content, WORDS, "the turn's content is the owner's words alone");
    assert.equal(controlPlaneNoteOf(handed.content, turn.content), `\n\n${WIKI_CHAT_PROMPT}\n\n${PAGE}\n\n${SELECTION}`,
      'and the note recorded beside the echo is exactly what delivery appended');
  });

  await t.test('5–6. a later message carries its own selection, read at its delivery: a sentence written away is left out and said so', async () => {
    await answered(firstTurn);
    const later = 'And the steer, does it wait for the lease?';
    const sent = await send({ content: later, wikiContext: { selection: { docSlug: 'sessions-runtime', sectionKey: 'turn-delivery', sentenceIds: [pub(S2), pub(S3)] } } });
    assert.equal(sent.status, 201, sent.text);
    // The leases section is written again between the send and the delivery: its sentence is a new row now.
    await sql.query(`DELETE FROM "wiki_doc_sentence" WHERE "id" = $1::uuid`, [S3]);
    await prisma.wikiDocSentence.create({ data: { sectionId: leases.id, ownerId: owner.id, position: 0, block: 0, text: 'A lease expires after two minutes.', status: 'sourced' } });

    const handed = await inbox();
    const turns = await turnsOf(deliveryChat);
    const turn = turns[turns.length - 1];
    assert.equal(handed.turnId, turn.id);
    const selection = [
      `<orbit_wiki_selection doc="1.1" slug="sessions-runtime" section="2" key="turn-delivery" sentences="1" sources="1" repoSha="${SHA}">`,
      '§2 Turn delivery',
      ...sentence('A steer joins the turn already running.', [steerNote]),
      `Left out: a selected sentence the document no longer holds (${pub(S3)}): the section was written again after the owner selected it.`,
      '</orbit_wiki_selection>',
    ].join('\n');
    assert.equal(handed.content, `${later}\n\n${selection}`, 'no second <orbit_wiki_chat>, and the selection as the document holds it now');
    assert.deepEqual([turn.content, turn.send_intent, isOwnerTurn({ kind: turn.kind, sendIntent: turn.send_intent, clientTurnId: turn.client_turn_id })],
      [later, 'NEXT_TURN', true], "the words alone, and the owner's own");
    await answered(turn.id);
  });

  await t.test('5. an entry page carries the entry as wiki_get holds it, and a plan page the document\'s definition', async () => {
    const recorded = await api('POST', `/api/wiki/spaces/${pub(spaceId)}/changesets`, ownerToken, {
      rationale: 'the owner records what this codebase knows',
      ops: [{ op: 'add', entry: {
        kind: 'principle', title: 'Completion is adjudicated, not claimed',
        summary: 'A run is not done because it says so; the declared criterion decides.',
        fields: { statement: 'Completion is adjudicated, not claimed.', rationale: 'Self-reported done is how failures pass.' },
      } }],
    });
    assert.equal(recorded.status, 200, recorded.text);
    const entryId = toUuid(recorded.json.ops[0].entryId);

    const entrySent = await send({ content: 'Does this still hold?', wikiContext: { page: { kind: 'entry', entryId: pub(entryId) } } });
    assert.equal(entrySent.status, 201, entrySent.text);
    const entry = await inbox();
    const [, block] = entry.content.split('Does this still hold?\n\n');
    assert.match(block, new RegExp(`^<orbit_wiki_page of="entry" entry="${pub(entryId)}" title="Completion is adjudicated, not claimed">\\n`, 'u'));
    assert.match(block, /"kind": "principle"/u, 'the entry as wiki_get answers it');
    assert.match(block, new RegExp(`"id": "${pub(entryId)}"`, 'u'), 'with its public id');
    assert.match(block, /\n<\/orbit_wiki_page>$/u);
    await answered(entry.turnId);

    const planSent = await send({ content: 'Split this page.', wikiContext: { page: { kind: 'plan', docSlug: 'sessions-runtime' } } });
    assert.equal(planSent.status, 201, planSent.text);
    const plan = await inbox();
    const [, planBlock] = plan.content.split('Split this page.\n\n');
    assert.match(planBlock, /^<orbit_wiki_page of="plan" doc="1.1" slug="sessions-runtime">\n/u);
    const definition = JSON.parse(planBlock.split('\n').slice(1, -1).join('\n'));
    assert.deepEqual(definition.doc.sections.map((s: { key: string; covers: string }) => [s.key, s.covers]),
      planSections.map((s) => [s.key, s.covers]), 'what each section covers: the page brings the plan, which a session cannot read');
    assert.equal(definition.doc.slug, 'sessions-runtime', 'the document as a plan card\'s change takes it (C12)');
    await answered(plan.turnId);
  });

  await t.test('6. a wikiContext of the wrong shape, or one sent to a session that is no chat, files nothing', async () => {
    const before = (await turnsOf(deliveryChat)).length;
    const wrong = await send({ content: 'x', wikiContext: { selection: { docSlug: 'sessions-runtime', sectionKey: 'turn-delivery', sentenceIds: [] } } });
    assert.equal(wrong.status, 400, wrong.text);
    assert.equal(wrong.json.code, 'WIKI_SCHEMA');
    assert.deepEqual(wrong.json.errors.map((e: { path: string }) => e.path), ['wikiContext.selection.sentenceIds']);
    assert.equal((await turnsOf(deliveryChat)).length, before, 'refused before anything is filed');

    const plain = await api('POST', '/api/sessions', ownerToken, { prompt: 'an ordinary session', workspaceId: pub(wsOther) });
    assert.equal(plain.status, 201, plain.text);
    const plainId = toUuid(plain.json.id);
    const outside = await send({ content: 'x', wikiContext: { page: { kind: 'plan', docSlug: 'sessions-runtime' } } }, plainId);
    assert.equal(outside.status, 400, outside.text);
    assert.match(outside.text, /not one/u);
    assert.equal((await turnsOf(plainId)).filter((turn) => turn.content === 'x').length, 0);
  });

  await t.test('7. a request with a session header is refused WIKI_OWNER_CHANNEL_ONLY by every chat door, and writes nothing', async () => {
    const header = { 'x-orbit-session-id': pub(firstChat) };
    const rememberedBefore = await remembered();
    const before = Number((await sql.query(`SELECT count(*)::int AS n FROM "session" WHERE "wiki_chat_space_id" = $1::uuid`, [spaceId])).rows[0].n);
    const made = await create({ workspaceId: pub(wsDev) }, ownerToken, header);
    assert.equal(made.status, 403, made.text);
    assert.equal(made.json.code, 'WIKI_OWNER_CHANNEL_ONLY');
    const read = await list(ownerToken, header);
    assert.equal(read.status, 403, read.text);
    assert.equal(read.json.code, 'WIKI_OWNER_CHANNEL_ONLY');
    const patched = await api('PATCH', `/api/wiki/spaces/${pub(spaceId)}`, ownerToken, { chat: { workspaceId: pub(wsDev) } }, header);
    assert.equal(patched.status, 403, patched.text);
    assert.equal(patched.json.code, 'WIKI_OWNER_CHANNEL_ONLY');
    assert.equal(Number((await sql.query(`SELECT count(*)::int AS n FROM "session" WHERE "wiki_chat_space_id" = $1::uuid`, [spaceId])).rows[0].n), before);
    assert.equal(await remembered(), rememberedBefore, 'and the remembered workspace is as it was');
  });

  await t.test("8. another account's space, chat, session and workspace are the plain 404", async () => {
    assert.equal((await create({ workspaceId: pub(wsDev) }, strangerToken)).status, 404);
    assert.equal((await list(strangerToken)).status, 404);
    assert.equal((await api('GET', `/api/sessions/${pub(firstChat)}`, strangerToken)).status, 404);
    assert.equal((await send({ content: 'x' }, firstChat, strangerToken)).status, 404);
    const theirs = await api('POST', '/api/wiki/spaces', strangerToken, { title: `Theirs ${RUN}`, repoUrl: ELSEWHERE_URL });
    assert.equal(theirs.status, 201, theirs.text);
    const named = await api('POST', `/api/wiki/spaces/${theirs.json.id}/chats`, strangerToken,
      { workspaceId: pub(wsDev), content: 'x', clientTurnId: randomUUID() });
    assert.equal(named.status, 404, `the owner's workspace, named in the stranger's own space: ${named.text}`);
    const empty = await api('GET', `/api/wiki/spaces/${theirs.json.id}/chats`, strangerToken);
    assert.equal(empty.status, 200, empty.text);
    assert.deepEqual([empty.json.workspace, empty.json.choices, empty.json.chats], [null, [], []], 'a space with nothing to choose');
  });

  await t.test("9. the first message's pictures and files ride the create, linked to its first turn and handed over with it; another's or a used one makes nothing (board 43)", async () => {
    /** An upload of `who`'s as the composer makes one before any session exists: no session, turn or task. */
    const upload = async (who: string, fileName: string, mime: string, sessionId: string | null = null) =>
      (await sql.query<{ id: string }>(
        `INSERT INTO "attachment" (id, owner_id, session_id, mime_type, size_bytes, file_name, data)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, 3, $4, '\\x89504e'::bytea) RETURNING id`,
        [who, sessionId, mime, fileName],
      )).rows[0].id;
    const attachment = async (id: string) =>
      (await sql.query(`SELECT "session_id", "turn_id" FROM "attachment" WHERE "id" = $1::uuid`, [id])).rows[0];
    const picture = await upload(owner.id, 'lease-timeline.png', 'image/png');
    const log = await upload(owner.id, 'runner.log', 'text/plain');

    // Refused before anything is made: an upload of another account's, and one a session already took.
    const theirs = await upload(stranger.id, 'theirs.png', 'image/png');
    const used = await upload(owner.id, 'used.png', 'image/png', firstChat);
    for (const [ids, why] of [[[picture, theirs], "another account's"], [[used], 'one a session already took']] as const) {
      const before = await sessionsIn(wsDelivery);
      const refused = await create({ workspaceId: pub(wsDelivery), attachmentIds: ids.map((id) => pub(id)) });
      assert.equal(refused.status, 400, `${why}: ${refused.text}`);
      assert.match(refused.text, /one or more attachments are unknown, not yours, or already used/u, why);
      assert.equal(await sessionsIn(wsDelivery), before, `${why}: no session, and so no turn`);
    }
    // A blank id names no file, in the list (the pipe cannot decode it) or as the list itself (refused at the door).
    for (const [attachmentIds, said] of [[[pub(picture), '   '], /invalid attachmentIds/u], ['   ', /a blank one names none/u]] as const) {
      const before = await sessionsIn(wsDelivery);
      const blank = await create({ workspaceId: pub(wsDelivery), attachmentIds });
      assert.equal(blank.status, 400, `a blank attachment id: ${blank.text}`);
      assert.match(blank.text, said);
      assert.equal(await sessionsIn(wsDelivery), before, 'a blank attachment id: nothing is made');
    }
    assert.deepEqual(await attachment(picture), { session_id: null, turn_id: null }, 'the refused create took nothing of the owner\'s');
    assert.deepEqual(await attachment(theirs), { session_id: null, turn_id: null }, "nor of the stranger's");

    // Made with both, and with the toolbar's mode, effort and speed (board 43 ②).
    await beat(delivery);
    const words = 'Here is the timeline I see, and the runner log.';
    const answer = await create({
      workspaceId: pub(wsDelivery), content: words, attachmentIds: [pub(picture), pub(log)],
      permissionMode: 'default', effort: 'high', fastMode: true,
    });
    assert.equal(answer.status, 201, answer.text);
    const chatId = toUuid(answer.json.sessionId);
    const row = await sessionRow(chatId);
    assert.deepEqual([row.permission_mode, row.effort, row.fast_mode], ['default', 'high', true], 'the session starts as the toolbar showed it');
    const turns = await turnsOf(chatId);
    assert.equal(turns.length, 1, 'one turn, the one the create filed');
    assert.equal(turns[0].content, words, "its content is the owner's words alone, whatever rides along");
    for (const id of [picture, log]) {
      assert.deepEqual(await attachment(id), { session_id: chatId, turn_id: turns[0].id }, 'scoped to the chat and linked to its first turn');
    }

    // The runner that claims it is handed the files with the words, as it is a later message's.
    const claim = await api('GET', '/api/runner/sessions/claim', delivery.token, undefined, { 'x-orbit-runner-capabilities': CAPABILITIES });
    assert.equal(claim.status, 200, claim.text);
    assert.equal(toUuid(claim.json?.sessionId ?? '00000000-0000-0000-0000-000000000000'), chatId, claim.text.slice(0, 400));
    assert.equal((await turnsOf(chatId)).length, 1, 'the claim laid no second opening turn down');
    const leaseOwner = randomUUID();
    const taken = await api('POST', `/api/runner/sessions/${pub(chatId)}/takeover-leases`, delivery.token,
      { leaseOwner, expectedLeaseOwner: null }, { 'x-orbit-runner-capabilities': CAPABILITIES });
    assert.equal(taken.status, 200, taken.text);
    const generation = randomUUID();
    const activated = await api('POST', `/api/runner/sessions/${pub(chatId)}/activate-leases`, delivery.token,
      { leaseOwner, leaseGeneration: generation }, { 'x-orbit-runner-capabilities': CAPABILITIES });
    assert.equal(activated.status, 200, activated.text);
    const handed = await api('GET', `/api/runner/sessions/${pub(chatId)}/inbox?leaseGeneration=${generation}`, delivery.token,
      undefined, { 'x-orbit-runner-capabilities': CAPABILITIES });
    assert.equal(handed.status, 200, handed.text);
    assert.equal(toUuid(handed.json.turnId), turns[0].id);
    assert.equal(handed.json.content, `${words}\n\n${WIKI_CHAT_PROMPT}`, 'the words, then the chat\'s rules');
    assert.deepEqual(
      (handed.json.attachments as Array<{ id: string; mimeType: string; fileName?: string }>).map((a) => [toUuid(a.id), a.mimeType, a.fileName]),
      [[picture, 'image/png', 'lease-timeline.png'], [log, 'text/plain', 'runner.log']],
      'both files, in the order they were uploaded',
    );
  });
});
