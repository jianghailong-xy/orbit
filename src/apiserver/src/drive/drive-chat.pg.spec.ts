/**
 * The Drive chat's server side (drive/drive-chat.ts, drive-chat-notes.ts; migrations 1680–1681; project "Drive chat:
 * manage files by talking to an agent", board docs/mocks/drive-chat/01-board.html), held against the production
 * apiserver — `build/main.js`, the whole AppModule — over a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from
 * empty:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/drive/drive-chat.pg.spec.ts
 *
 *   1. create: `POST /api/drive/chats` makes an ordinary session of the named workspace with `opened_by` DRIVE_CHAT, and
 *      files its first turn with it — the owner's words alone, under the client's UUID, with the folder and the
 *      selection as ids; the session reads `chatOrigin: DRIVE_CHAT` ("From Drive"); a malformed body, a session header,
 *      another account's workspace and a driveContext sent to a session that is no Drive chat are refused and make
 *      nothing;
 *   2. the delivered note: the first delivery appends `<orbit_drive_chat>` with the guidance, the folder's path and each
 *      selected file's path, kind, size and last writer, read at delivery, an item in Trash or not the owner's left out
 *      and said so; a later message carries its own folder and selection without the guidance; the guidance comes again
 *      when its text changes;
 *   3. default workspace (owner Q3 A): the workspace of the owner's most recent Drive chat that is still there, else the
 *      account's Orbit Cloud workspace, else a readable 400 that makes nothing; GET names it with where it came from;
 *   4. the delivered note on an Orbit Cloud runner: its guidance says ~/Files, and a claim rolled back leaves it to be
 *      sent again;
 *   5. list, search and paging: Open first — the ones that need the owner, then the ones working, then the one last
 *      spoken in — then Completed; 50 to a page with `more`; `?status=`, `?q=` and `?offset=`; the round button's counts
 *      over all; Trash and other accounts left out.
 *
 * Not destructive: every row belongs to accounts this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { DRIVE_CHAT_RULES, driveChatGuidance, sessionOriginTag, toUuid, uuidToBase62 } from '@orbit/shared';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { hashPassword } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { controlPlaneNoteOf } from '../runner-api/control-plane-note';
import { isOwnerTurn } from '../wiki/wiki.service';
import { appendDriveChatNotes, driveChatGuidanceDigest } from './drive-chat-notes';
import { DriveService } from './drive.service';
import '../test-support/daemon-routes-over-http';

const URL_ = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const ENGINES = [{ engine: 'claude', installed: true, auth: 'yes', version: '2.3.0' }];
const CAPABILITIES = 'source-pin/v1';
const pub = (id: string) => uuidToBase62(id);

interface Machine {
  runnerId: string;
  token: string;
}

test('the Drive chat: made as a session, run where the owner last chatted, listed Open then Completed, each turn with its folder and selection', {
  skip: !URL_, concurrency: 1, timeout: 900_000,
}, async (t) => {
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
    const email = `${name}-${RUN}@drive-chat.invalid`;
    await sql.query(`INSERT INTO "user" (id, email, name, password_hash, role) VALUES ($1, $2, $3, $4, 'MEMBER')`,
      [id, email, name, hashPassword(password)]);
    return { id, email, password };
  };
  const owner = await account('owner');
  const stranger = await account('stranger');
  const newcomer = await account('newcomer');
  const clouded = await account('clouded');

  // No model titles a chat here: the titles this spec sets are the ones it reads.
  server = await startApiserver(url, `drive-chat-${randomUUID()}`, { DEEPSEEK_API_KEY: '' });
  const api = (method: string, route: string, bearer?: string, body?: unknown, headers?: Record<string, string>): Promise<Reply> =>
    call(server!, method, route, bearer, body, headers);
  const signIn = async (who: { email: string; password: string }) => {
    const reply = await api('POST', '/api/auth/login', undefined, { email: who.email, password: who.password });
    assert.equal(reply.status, 201, reply.text);
    return reply.json.accessToken as string;
  };
  const ownerToken = await signIn(owner);
  const strangerToken = await signIn(stranger);
  const newcomerToken = await signIn(newcomer);
  const cloudedToken = await signIn(clouded);

  const register = async (bearer: string, name: string): Promise<Machine> => {
    const minted = await api('POST', '/api/runners/enrollment-tokens', bearer, { label: `drive chat ${RUN}` });
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
  const strangers = await register(strangerToken, `strangers-${RUN}`);
  const newcomers = await register(newcomerToken, `newcomers-${RUN}`);
  const cloudRunner = await register(cloudedToken, `cloud-${RUN}`);
  const laptop = await register(cloudedToken, `laptop-${RUN}`);
  for (const machine of [hpc, delivery, strangers, newcomers, cloudRunner, laptop]) await beat(machine);

  const workspace = async (ownerId: string, runnerId: string, name: string) => {
    const id = randomUUID();
    await sql.query(
      `INSERT INTO "workspace" (id, name, owner_id, runner_id, work_dir, enable_worktree) VALUES ($1, $2, $3, $4, $5, false)`,
      [id, name, ownerId, runnerId, `/srv/${name}`],
    );
    return id;
  };
  const wsA = await workspace(owner.id, hpc.runnerId, 'files-a');
  const wsB = await workspace(owner.id, hpc.runnerId, 'files-b');
  const wsDelivery = await workspace(owner.id, delivery.runnerId, 'files-delivery');
  const wsStranger = await workspace(stranger.id, strangers.runnerId, 'theirs');
  await workspace(newcomer.id, newcomers.runnerId, 'newcomer-only');
  const wsCloud = await workspace(clouded.id, cloudRunner.runnerId, 'Orbit Cloud');
  const wsLaptop = await workspace(clouded.id, laptop.runnerId, 'laptop');
  // The account's Orbit Cloud runner, and the workspace it was made with (managed_runner.default_workspace_id).
  await prisma.managedRunner.create({
    data: {
      ownerId: clouded.id, runnerId: cloudRunner.runnerId, defaultWorkspaceId: wsCloud, clusterKey: 'drive-chat-spec', namespace: 'orbit',
      pvcName: `mr-data-${cloudRunner.runnerId}`, desiredState: 'SLEEPING', managementState: 'SLEEPING', generation: 1, podUid: randomUUID(),
    },
  });

  // ── the owner's drive ───────────────────────────────────────────────────────────────────────────────────────
  const drive = new DriveService(prisma as never);
  const projects = await drive.createFolder(owner.id, { name: 'Projects' });
  const year = await drive.createFolder(owner.id, { parentId: projects.id, name: '2026' });
  const report = await drive.createFile(owner.id, { parentId: year.id, name: 'report "final".pdf' });
  const notes = await drive.createFile(owner.id, { parentId: projects.id, name: 'notes.txt' });
  const old = await drive.createFile(owner.id, { parentId: year.id, name: 'old.txt' });
  await drive.moveToTrash(owner.id, old.id);
  const theirs = await drive.createFile(stranger.id, { name: 'secret.txt' });
  const WRITER_SESSION = randomUUID();
  await sql.query(
    `UPDATE "drive_entry" SET "size_bytes" = 1234567, "last_writer_kind" = 'AGENT', "last_writer_session_id" = $2::uuid,
            "last_written_at" = '2026-11-20T09:30:00Z' WHERE "id" = $1::uuid`, [report.id, WRITER_SESSION]);
  await sql.query(
    `UPDATE "drive_entry" SET "size_bytes" = 512, "last_writer_kind" = 'OWNER', "last_writer_session_id" = NULL,
            "last_written_at" = '2026-11-21T14:05:00Z' WHERE "id" = $1::uuid`, [notes.id]);

  const chats = '/api/drive/chats';
  const create = (body: Record<string, unknown>, bearer = ownerToken, headers?: Record<string, string>) =>
    api('POST', chats, bearer, { clientTurnId: randomUUID(), text: 'Sort these into folders by year.', ...body }, headers);
  const list = (query = '', bearer = ownerToken, headers?: Record<string, string>) => api('GET', `${chats}${query}`, bearer, undefined, headers);
  const sessionRow = async (id: string) => (await sql.query(`SELECT * FROM "session" WHERE "id" = $1::uuid`, [id])).rows[0];
  const turnsOf = async (sessionId: string) =>
    (await sql.query(`SELECT * FROM "conversation_turn" WHERE "session_id" = $1::uuid ORDER BY "seq"`, [sessionId])).rows;
  const driveChatsOf = async (ownerId: string) =>
    Number((await sql.query(`SELECT count(*)::int AS n FROM "session" WHERE "owner_id" = $1::uuid AND "opened_by" = 'DRIVE_CHAT'`, [ownerId])).rows[0].n);

  const WORDS = 'Rename the report so it says the year, and tidy this folder.';
  const SELECTED = [pub(report.id), pub(notes.id), pub(old.id), pub(theirs.id), pub(report.id)];
  let deliveryChat = '';

  await t.test('1. create: a session of the named workspace, opened by DRIVE_CHAT, its first turn the owner\'s words with the folder and selection as ids', async () => {
    const clientTurnId = randomUUID();
    const answer = await create({ workspaceId: pub(wsDelivery), text: WORDS, clientTurnId, folderId: pub(year.id), entryIds: SELECTED });
    assert.equal(answer.status, 201, answer.text);
    deliveryChat = toUuid(answer.json.sessionId);
    const chat = answer.json.chat;
    assert.deepEqual(
      [toUuid(chat.sessionId), chat.status, chat.open, chat.completed, chat.working, chat.needsYou, toUuid(chat.workspaceId), typeof chat.title, typeof chat.lastActiveAt],
      [deliveryChat, 'PENDING', true, false, true, 0, wsDelivery, 'string', 'string'],
      'the answer is the chat as the list serves it',
    );
    assert.deepEqual([toUuid(answer.json.workspace.id), answer.json.workspace.name, answer.json.workspace.runner, answer.json.workspace.online],
      [wsDelivery, 'files-delivery', `delivery-${RUN}`, true], 'and where it runs');

    const row = await sessionRow(deliveryChat);
    assert.deepEqual([row.opened_by, row.workspace_id, row.assigned_runner_id, row.prompt, row.wiki_chat_space_id],
      ['DRIVE_CHAT', wsDelivery, delivery.runnerId, WORDS, null], 'an ordinary session of the workspace, opened by DRIVE_CHAT');
    const turns = await turnsOf(deliveryChat);
    assert.equal(turns.length, 1, 'one turn, the one the create filed');
    assert.deepEqual(
      [turns[0].seq, turns[0].kind, turns[0].content, turns[0].client_turn_id, turns[0].send_intent],
      [1, 'message', WORDS, clientTurnId, 'NEXT_TURN'],
      "the owner's words under the client's UUID, with an explicit routing intent",
    );
    assert.deepEqual(turns[0].drive_context, { folderId: year.id, entryIds: [report.id, notes.id, old.id, theirs.id] },
      'the folder and the selection as UUIDs, each item once; nothing read yet');
    assert.equal(isOwnerTurn({ kind: turns[0].kind, sendIntent: turns[0].send_intent, clientTurnId: turns[0].client_turn_id }), true,
      'first-hand: the owner\'s own words');
    const queued = await api('GET', `/api/sessions/${pub(deliveryChat)}/turns`, ownerToken);
    assert.deepEqual([queued.status, queued.json], [200, []], 'its opening turn is its prompt, no queued follow-up');

    const detail = await api('GET', `/api/sessions/${pub(deliveryChat)}`, ownerToken);
    assert.equal(detail.status, 200, detail.text);
    assert.equal(detail.json.chatOrigin, 'DRIVE_CHAT');
    assert.equal(sessionOriginTag(detail.json.chatOrigin), 'From Drive', 'the header tag reads From Drive');
    assert.equal(sessionOriginTag('WIKI_CHAT'), 'From Wiki', 'from the one table that reads From Wiki for a wiki chat');
    assert.equal(detail.json.openedBy, undefined, 'openedBy itself stays internal');

    const before = await driveChatsOf(owner.id);
    const refusals: Array<[string, Reply, number, string?]> = [
      ['no words', await create({ text: '   ', workspaceId: pub(wsA) }), 400],
      ['no client UUID', await create({ clientTurnId: 'turn-1', workspaceId: pub(wsA) }), 400],
      ['a selection that is not ids', await create({ workspaceId: pub(wsA), entryIds: 'all' }), 400, 'DRIVE_CHAT_CONTEXT_INVALID'],
      ['an id that names no row', await create({ workspaceId: pub(wsA), entryIds: ['not-an-id!'] }), 400, 'DRIVE_CHAT_CONTEXT_INVALID'],
      ['too many items', await create({ workspaceId: pub(wsA), entryIds: Array.from({ length: DRIVE_CHAT_RULES.selectionMax + 1 }, () => pub(randomUUID())) }), 400, 'DRIVE_CHAT_CONTEXT_INVALID'],
      ['a session header', await create({ workspaceId: pub(wsA) }, ownerToken, { 'x-orbit-session-id': pub(deliveryChat) }), 403, 'DRIVE_CHAT_OWNER_CHANNEL_ONLY'],
      ["another account's workspace", await create({ workspaceId: pub(wsStranger) }), 404],
      ['a blank workspaceId', await create({ workspaceId: '  ' }), 400],
      ['a blank attachmentIds', await create({ workspaceId: pub(wsA), attachmentIds: ' ' }), 400],
      ['a blank attachment id', await create({ workspaceId: pub(wsA), attachmentIds: [''] }), 400],
    ];
    for (const [what, reply, status, code] of refusals) {
      assert.equal(reply.status, status, `${what}: ${reply.text}`);
      if (code) assert.equal(reply.json.code, code, `${what}: ${reply.text}`);
    }
    const header = await list('', ownerToken, { 'x-orbit-session-id': pub(deliveryChat) });
    assert.deepEqual([header.status, header.json.code], [403, 'DRIVE_CHAT_OWNER_CHANNEL_ONLY'], 'the read is the owner\'s too');
    assert.equal(await driveChatsOf(owner.id), before, 'no refusal made a chat');

    // A later message of a session that is no Drive chat cannot carry a folder and a selection.
    const plain = await api('POST', '/api/sessions', ownerToken, { prompt: 'An ordinary session.', workspaceId: pub(wsA) });
    assert.equal(plain.status, 201, plain.text);
    const plainId = toUuid(plain.json.id);
    const turnsBefore = (await turnsOf(plainId)).length;
    const outside = await api('POST', `/api/sessions/${pub(plainId)}/turns`, ownerToken,
      { clientTurnId: randomUUID(), intent: 'NEXT_TURN', content: 'and this', driveContext: { folderId: null, entryIds: [] } });
    assert.equal(outside.status, 400, outside.text);
    assert.match(outside.text, /driveContext rides only on a message to a Drive chat/u);
    assert.equal((await turnsOf(plainId)).length, turnsBefore, 'and files no turn');
    assert.equal((await sessionRow(plainId)).opened_by, 'PERSON');
  });

  await t.test('2. delivered note: the first delivery appends <orbit_drive_chat>: the guidance, the folder and each selected file, read at delivery', async () => {
    // Read at delivery, not at the send: the report is renamed between the two.
    await sql.query(`UPDATE "drive_entry" SET "name" = 'report 2026.pdf' WHERE "id" = $1::uuid`, [report.id]);
    const claim = await api('GET', '/api/runner/sessions/claim', delivery.token, undefined, { 'x-orbit-runner-capabilities': CAPABILITIES });
    assert.equal(claim.status, 200, claim.text);
    assert.equal(toUuid(claim.json?.sessionId ?? '00000000-0000-0000-0000-000000000000'), deliveryChat, claim.text.slice(0, 400));
    assert.equal((await turnsOf(deliveryChat)).length, 1, 'the claim laid no second opening turn down');
    const leaseOwner = randomUUID();
    const taken = await api('POST', `/api/runner/sessions/${pub(deliveryChat)}/takeover-leases`, delivery.token,
      { leaseOwner, expectedLeaseOwner: null }, { 'x-orbit-runner-capabilities': CAPABILITIES });
    assert.equal(taken.status, 200, taken.text);
    const generation = randomUUID();
    const activated = await api('POST', `/api/runner/sessions/${pub(deliveryChat)}/activate-leases`, delivery.token,
      { leaseOwner, leaseGeneration: generation }, { 'x-orbit-runner-capabilities': CAPABILITIES });
    assert.equal(activated.status, 200, activated.text);
    const inbox = async () => {
      const answer = await api('GET', `/api/runner/sessions/${pub(deliveryChat)}/inbox?leaseGeneration=${generation}`, delivery.token,
        undefined, { 'x-orbit-runner-capabilities': CAPABILITIES });
      assert.equal(answer.status, 200, answer.text);
      assert.ok(answer.json?.turnId, `the inbox handed out no turn: ${answer.text}`);
      return { turnId: toUuid(answer.json.turnId), content: String(answer.json.content ?? '') };
    };
    const answered = (turnId: string) =>
      sql.query(`UPDATE "conversation_turn" SET "status" = 'ANSWERED', "answered_at" = now() WHERE "id" = $1::uuid`, [turnId]);
    const send = (body: Record<string, unknown>) =>
      api('POST', `/api/sessions/${pub(deliveryChat)}/turns`, ownerToken, { clientTurnId: randomUUID(), intent: 'NEXT_TURN', ...body });
    const guidance = (onCloud: boolean) => ['How to work in this chat:', ...driveChatGuidance(onCloud).map((line) => `- ${line}`)];

    const handed = await inbox();
    const [turn] = await turnsOf(deliveryChat);
    assert.equal(handed.turnId, turn.id);
    const NOTE = [
      '<orbit_drive_chat folder="/Projects/2026" selected="2">',
      ...guidance(false),
      '',
      `The owner has the folder /Projects/2026 open (id ${pub(year.id)}).`,
      'Selected (2):',
      `- /Projects/2026/report 2026.pdf · file · 1.2 MB (1,234,567 bytes) · last written by an agent, in session ${pub(WRITER_SESSION)}, 2026-11-20 09:30 UTC · id ${pub(report.id)}`,
      `- /Projects/notes.txt · file · 512 bytes · last written by the owner, 2026-11-21 14:05 UTC · id ${pub(notes.id)}`,
      'Left out: 2 selected items that are not in the drive any more.',
      '</orbit_drive_chat>',
    ].join('\n');
    assert.equal(handed.content, `${WORDS}\n\n${NOTE}`, 'the words, then the note: Trash and another account\'s file left out');
    assert.ok(handed.content.includes('drive_* tools') && !handed.content.includes('~/Files'), 'not an Orbit Cloud runner: the drive tools');
    assert.equal(turn.content, WORDS, "the turn's content is the owner's words alone");
    assert.equal(controlPlaneNoteOf(handed.content, turn.content), `\n\n${NOTE}`, 'the note recorded beside the echo is what delivery appended');
    assert.equal((await sessionRow(deliveryChat)).drive_chat_prompt_digest, driveChatGuidanceDigest(driveChatGuidance(false).join('\n')),
      'the guidance handed out is remembered');
    await answered(turn.id);

    // A later message: its own folder (the top level) and nothing selected; the guidance is not sent again.
    const top = await send({ content: 'What is at the top?', driveContext: { folderId: null, entryIds: [] } });
    assert.equal(top.status, 201, top.text);
    const second = await inbox();
    assert.equal(second.content, [
      'What is at the top?',
      '',
      '<orbit_drive_chat folder="/" selected="0">',
      "The owner has the drive's top level (/) open.",
      'Nothing is selected.',
      '</orbit_drive_chat>',
    ].join('\n'));
    const secondTurn = (await turnsOf(deliveryChat)).at(-1)!;
    assert.deepEqual([secondTurn.content, secondTurn.drive_context], ['What is at the top?', { folderId: null, entryIds: [] }]);
    await answered(second.turnId);

    // One that carries nothing goes as written.
    const bare = await send({ content: 'Thanks.' });
    assert.equal(bare.status, 201, bare.text);
    const third = await inbox();
    assert.equal(third.content, 'Thanks.', 'no folder, no selection, the guidance already sent: nothing appended');
    await answered(third.turnId);

    // A context of the wrong shape files nothing.
    const turnsBefore = (await turnsOf(deliveryChat)).length;
    const bad = await send({ content: 'and these', driveContext: { folderId: pub(year.id), entryIds: [42] } });
    assert.equal(bad.status, 400, bad.text);
    assert.equal(bad.json.code, 'DRIVE_CHAT_CONTEXT_INVALID');
    assert.equal((await turnsOf(deliveryChat)).length, turnsBefore, 'nothing filed');

    // The guidance's text changed since it was sent (a release, or the session's machine): it comes again, once.
    await sql.query(`UPDATE "session" SET "drive_chat_prompt_digest" = 'an older text' WHERE "id" = $1::uuid`, [deliveryChat]);
    const again = await send({ content: 'Now move the report into Archive.', driveContext: { folderId: pub(projects.id), entryIds: [pub(report.id)] } });
    assert.equal(again.status, 201, again.text);
    const fourth = await inbox();
    assert.equal(fourth.content, [
      'Now move the report into Archive.',
      '',
      '<orbit_drive_chat folder="/Projects" selected="1">',
      ...guidance(false),
      '',
      `The owner has the folder /Projects open (id ${pub(projects.id)}).`,
      'Selected (1):',
      `- /Projects/2026/report 2026.pdf · file · 1.2 MB (1,234,567 bytes) · last written by an agent, in session ${pub(WRITER_SESSION)}, 2026-11-20 09:30 UTC · id ${pub(report.id)}`,
      '</orbit_drive_chat>',
    ].join('\n'));
    await answered(fourth.turnId);
    const fifth = await send({ content: 'And again.' });
    assert.equal(fifth.status, 201, fifth.text);
    assert.equal((await inbox()).content, 'And again.', 'the same text is not sent twice');
  });

  await t.test('3. default workspace: the last Drive chat\'s, else the Orbit Cloud workspace, else a readable 400', async () => {
    // An account with neither: GET names none, and a create that names none is refused and makes nothing.
    const none = await list('', newcomerToken);
    assert.equal(none.status, 200, none.text);
    assert.deepEqual([none.json.workspace, none.json.workspaceFrom, none.json.chats, none.json.more], [null, null, [], false]);
    const refused = await create({}, newcomerToken);
    assert.equal(refused.status, 400, refused.text);
    assert.equal(refused.json.code, 'DRIVE_CHAT_WORKSPACE_REQUIRED');
    assert.match(refused.json.message, /^Choose where Drive chats run: .*name a workspaceId/u);
    assert.equal(await driveChatsOf(newcomer.id), 0, 'nothing made');

    // The Orbit Cloud account, with no Drive chat yet: its Orbit Cloud workspace is the default.
    const first = await list('', cloudedToken);
    assert.deepEqual([toUuid(first.json.workspace.id), first.json.workspace.name, first.json.workspace.runner, first.json.workspaceFrom],
      [wsCloud, 'Orbit Cloud', `cloud-${RUN}`, 'ORBIT_CLOUD'], 'no Drive chat yet: the account\'s Orbit Cloud workspace');
    const onCloud = await create({}, cloudedToken);
    assert.equal(onCloud.status, 201, onCloud.text);
    assert.equal((await sessionRow(toUuid(onCloud.json.sessionId))).workspace_id, wsCloud, 'a create naming none runs there');

    // Naming another moves the default there: the workspace of the most recent Drive chat.
    const named = await create({ workspaceId: pub(wsLaptop) }, cloudedToken);
    assert.equal(named.status, 201, named.text);
    const after = await list('', cloudedToken);
    assert.deepEqual([toUuid(after.json.workspace.id), after.json.workspaceFrom], [wsLaptop, 'LAST_CHAT'], 'Runs in: the last one');
    const follows = await create({}, cloudedToken);
    assert.equal(follows.status, 201, follows.text);
    assert.equal((await sessionRow(toUuid(follows.json.sessionId))).workspace_id, wsLaptop, 'and the next chat runs there');

    // A last workspace that was deleted is passed over for the chat before it.
    await sql.query(`UPDATE "workspace" SET "deleted_at" = now() WHERE "id" = $1::uuid`, [wsLaptop]);
    const fallback = await list('', cloudedToken);
    assert.deepEqual([toUuid(fallback.json.workspace.id), fallback.json.workspaceFrom], [wsCloud, 'LAST_CHAT'],
      'the most recent Drive chat whose workspace is still there');

    // The owner: no Orbit Cloud runner, and the last chat ran on the delivery workspace.
    const ownerDefault = await list();
    assert.deepEqual([toUuid(ownerDefault.json.workspace.id), ownerDefault.json.workspaceFrom], [wsDelivery, 'LAST_CHAT']);
    const onB = await create({ workspaceId: pub(wsB) });
    assert.equal(onB.status, 201, onB.text);
    const nowB = await create({});
    assert.equal(nowB.status, 201, nowB.text);
    assert.equal((await sessionRow(toUuid(nowB.json.sessionId))).workspace_id, wsB, 'the owner\'s default followed to files-b');
  });

  await t.test('4. delivered note on an Orbit Cloud runner: the guidance says ~/Files; a delivery rolled back leaves it to be sent again', async () => {
    const answer = await create({ workspaceId: pub(wsCloud), text: 'What is in my drive?' }, cloudedToken);
    assert.equal(answer.status, 201, answer.text);
    const chatId = toUuid(answer.json.sessionId);
    const [turn] = await turnsOf(chatId);
    assert.deepEqual(turn.drive_context, { folderId: null, entryIds: [] }, 'no folder named: the top level');
    const deliver = (fail: boolean) => prisma.$transaction(async (tx) => {
      const out = await appendDriveChatNotes(tx as never, {
        ownerId: clouded.id, sessionId: chatId, runnerId: cloudRunner.runnerId,
        turn: { seq: turn.seq, kind: 'message', driveContext: turn.drive_context },
      }, 'What is in my drive?');
      if (fail) throw new Error('claim rolled back');
      return out;
    });
    await assert.rejects(deliver(true), /claim rolled back/u);
    assert.equal((await sessionRow(chatId)).drive_chat_prompt_digest, null, 'nothing remembered from a claim rolled back');
    const out = await deliver(false);
    assert.ok(out!.includes(`- ${driveChatGuidance(true)[5]}`), out!);
    assert.match(out!, /mounted at ~\/Files/u);
    assert.ok(!out!.includes('drive_* tools'));
    assert.equal((await sessionRow(chatId)).drive_chat_prompt_digest, driveChatGuidanceDigest(driveChatGuidance(true).join('\n')));
  });

  await t.test('5. list/search/paging: Open (needs you, working, last spoken) then Completed, 50 to a page, ?status=, ?q=, ?offset=', async () => {
    for (let i = 0; i < 52; i += 1) {
      const made = await create({ workspaceId: pub(wsA), text: `Chat number ${i}` });
      assert.equal(made.status, 201, made.text);
    }
    const ids: string[] = (await sql.query(
      `SELECT "id"::text AS id FROM "session" WHERE "owner_id" = $1::uuid AND "opened_by" = 'DRIVE_CHAT' ORDER BY "created_at", "id"`, [owner.id],
    )).rows.map((row: { id: string }) => row.id);
    assert.ok(ids.length >= 55, `the owner's chats: ${ids.length}`);
    // Every chat parked and spoken in a minute apart, oldest first; then the facts the order reads. The facts, not the
    // stored word: since 1671 session.status is written from turn_state by its trigger.
    const base = Date.parse('2026-11-01T00:00:00.000Z');
    for (const [i, id] of ids.entries()) {
      await sql.query(
        `UPDATE "session" SET "turn_state" = NULL, "title" = $2, "last_turn_at" = $3, "completed_at" = NULL WHERE "id" = $1::uuid`,
        [id, `${i % 3 === 0 ? 'Invoices' : 'Photos'} chat ${i}`, new Date(base + i * 60_000).toISOString().replace('T', ' ').replace('Z', '')],
      );
    }
    const [needsYou, working, trashed, ...rest] = ids;
    const completed = rest.slice(0, 3);
    await sql.query(`UPDATE "session" SET "turn_state" = 'IN_FLIGHT' WHERE "id" = ANY($1::uuid[])`, [[needsYou, working]]);
    await prisma.approval.create({ data: { sessionId: needsYou, toolName: 'Bash', input: { command: 'mv a b' }, toolUseId: `tool-${RUN}` } });
    await sql.query(`UPDATE "session" SET "completed_at" = now() WHERE "id" = ANY($1::uuid[])`, [completed]);
    await sql.query(`UPDATE "session" SET "deleted_at" = now() WHERE "id" = $1::uuid`, [trashed]);
    const newestFirst = (list_: string[]) => [...list_].reverse();
    const open = rest.filter((id) => !completed.includes(id));
    const expected = [needsYou, working, ...newestFirst(open), ...newestFirst(completed)];
    const idsOf = (reply: Reply) => reply.json.chats.map((c: { sessionId: string }) => toUuid(c.sessionId));

    const page1 = await list();
    assert.equal(page1.status, 200, page1.text);
    assert.deepEqual(idsOf(page1), expected.slice(0, 50), 'needs you, then working, then the one last spoken in; 50 to a page');
    assert.equal(page1.json.more, true);
    assert.deepEqual(page1.json.fab, { needsYou: 1, working: true }, 'the round button\'s counts');
    const first = page1.json.chats[0];
    assert.deepEqual([first.needsYou, first.working, first.open, first.completed], [1, true, true, false]);
    const page2 = await list('?offset=50');
    assert.deepEqual([idsOf(page2), page2.json.more], [expected.slice(50), false], 'the rest, Completed last');
    assert.ok(!idsOf(page1).concat(idsOf(page2)).includes(trashed), 'a chat in Trash is not listed');

    const onlyCompleted = await list('?status=completed');
    assert.deepEqual([idsOf(onlyCompleted), onlyCompleted.json.more], [newestFirst(completed), false]);
    assert.ok(onlyCompleted.json.chats.every((c: { completed: boolean }) => c.completed));
    const onlyOpen = await list('?status=open&offset=2');
    assert.deepEqual(idsOf(onlyOpen), newestFirst(open).slice(0, 50), 'Open, passing over two');

    const invoices = expected.filter((id) => ids.indexOf(id) % 3 === 0);
    const found = await list(`?q=${encodeURIComponent('  INVOICES ')}`);
    assert.deepEqual([idsOf(found), found.json.more], [invoices, false], 'the chats whose title holds the words, without case, in the same order');
    assert.deepEqual(found.json.fab, page1.json.fab, 'the counts are over every chat whatever the page');
    const nothing = await list('?q=nothing-is-called-this');
    assert.deepEqual([nothing.status, nothing.json.chats, nothing.json.more], [200, [], false]);

    const others = await list('', strangerToken);
    assert.deepEqual([others.status, others.json.chats, others.json.workspace], [200, [], null], 'another account sees none of them');
    for (const bad of ['offset=-1', 'offset=one', 'status=done', `q=${'x'.repeat(DRIVE_CHAT_RULES.queryMax + 1)}`, 'offset=1&offset=2']) {
      const refused = await list(`?${bad}`);
      assert.equal(refused.status, 400, `${bad}: ${refused.text}`);
    }
  });
});
