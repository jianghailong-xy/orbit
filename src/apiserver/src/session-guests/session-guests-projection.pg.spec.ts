/**
 * Session guests, what the guest door and the owner's own reads say about a guest (docs/session-guests-design.md §4,
 * §5 step 5 and §7; docs/share-links-design.md §6; task G1c), held against the production apiserver — `build/main.js`,
 * the whole AppModule — over a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty:
 *
 *   (1) a guest's turn names the guest on the owner's session row — the detail, the list row and the `session.updated`
 *       summary — and on the queued turn, by source and name only: the guest's user id is in none of them;
 *   (2) the runner's inbox hands the turn over with the same sender, and without the guest's user id;
 *   (3) the runner's echo is stored with that sender, and the events the owner reads carry no guest user id either;
 *   (4) the red line, the negative assertions the public link is held to (test-support/share-red-line.ts, the same
 *       check share-links/public-task.pg.spec.ts and public-project.pg.spec.ts make): values planted in the owner's
 *       session, workspace and runner — shown in the owner's own read first — are absent, as values and as field
 *       names, from every read the public link to the session gives AND from every guest read route: Shared with me,
 *       the guest page, its events (tail, before, after) and one event whole. The guest's user id and email are absent
 *       from all of them; only the guest's name appears, and on the guest door, the owner's name.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/session-guests/session-guests-projection.pg.spec.ts
 *
 * Not destructive: every row belongs to users this run creates.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { JwtService } from '@nestjs/jwt';
import { ControlEventType, uuidToBase62 } from '@orbit/shared';
import { type PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { Client } from 'pg';
import { filter, firstValueFrom, timeout } from 'rxjs';

import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { sha256 } from '../common/crypto.util';
import { addTwins } from '../common/public-id-body';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { RealtimeService } from '../realtime/realtime.service';
import '../test-support/daemon-routes-over-http';
import { keysOf, redLineCrossings } from '../test-support/share-red-line';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const RUNNER_TOKEN = `guest-projection-runner-${randomUUID()}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

test('session guests: the guest door shows only what the public link may, and the guest user id reaches no client read and no runner', {
  skip: !URL, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const db: PrismaClient = prismaClientFor(url);
  // The real summary builder, outside the spawned server: its in-process stream needs no LISTEN connection to build
  // and route a `session.updated`, and it reads the same database the server writes.
  const realtime = new RealtimeService(db as unknown as PrismaService, { scheduleBadgeSync: () => undefined } as never);
  let server: Apiserver | undefined;
  t.after(async () => {
    realtime.onModuleDestroy();
    await server?.stop();
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  await verifyCoordinatorPgIdentity(sql);
  const pub = uuidToBase62;

  // ── what must never reach a guest or a visitor, planted where the owner reads it ───────────────
  const SECRET = {
    runner: `secret-runner-${RUN}`,
    path: `/root/.orbit/worktrees/secret-path-${RUN}`,
    branch: `orbit/secret-branch-${RUN}`,
    sha: `${RUN}${'b'.repeat(32)}`,
    worktreeBranch: `orbit/secret-worktree-${RUN}`,
    model: `secret-model-${RUN}`,
    account: `secret-account-${RUN}`,
    runtime: `secret-runtime-${RUN}`,
    ownerEmail: `owner.${RUN}@secret-mail.invalid`,
    guestEmail: `guest.${RUN}@secret-mail.invalid`,
  };
  const OWNER_NAME = `Olivia Owner ${RUN}`;
  const GUEST_NAME = `Alice Guest ${RUN}`;
  const ORBIT_GUEST = { source: 'ORBIT_GUEST', name: GUEST_NAME };

  // ── the world ──────────────────────────────────────────────────────────────────────────────
  const ownerId = randomUUID();
  const guestId = randomUUID();
  await db.user.create({ data: { id: ownerId, email: SECRET.ownerEmail, name: OWNER_NAME, passwordHash: 'x' } });
  await db.user.create({ data: { id: guestId, email: SECRET.guestEmail, name: GUEST_NAME, passwordHash: 'x' } });
  const runnerId = randomUUID();
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: SECRET.runner, tokenHash: sha256(RUNNER_TOKEN), maxConcurrent: 8,
      status: RunnerStatus.ONLINE, lastHeartbeatAt: new Date(), capabilities: [], capabilitiesReportedAt: new Date(),
    },
  });
  const beating = setInterval(() => void sql.query(
    `UPDATE "runner" SET "last_heartbeat_at" = clock_timestamp() WHERE "id" = $1::uuid`, [runnerId],
  ).catch(() => undefined), 3_000);
  t.after(() => clearInterval(beating));
  const workspaceId = randomUUID();
  const WORKSPACE = `guests ${RUN}`;
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: WORKSPACE, enabled: true, model: SECRET.model, workDir: SECRET.path },
  });
  const sessionId = randomUUID();
  const TITLE = `A conversation with a guest ${RUN}`;
  await db.session.create({
    data: {
      id: sessionId, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId, title: TITLE, prompt: TITLE,
      provider: 'claude', providerBuiltin: true, model: SECRET.model, permissionMode: 'acceptEdits',
      claudeAccount: SECRET.account, branch: SECRET.branch, baseSha: SECRET.sha, worktreeBranch: SECRET.worktreeBranch,
      costUsd: 1.25, contextTokens: 4321,
      dispatchOrigin: SessionDispatchOrigin.USER, status: RunStatus.AWAITING_INPUT, numTurns: 1, engineTurnActive: false,
      runtimeSessionId: SECRET.runtime, startedAt: new Date(),
    },
  });
  // The owner's own opening exchange, as the runner stored it.
  let eventSeq = 0;
  const event = async (type: string, payload: unknown) => {
    await sql.query(
      `INSERT INTO run_event (id, session_id, seq, type, payload) VALUES (gen_random_uuid(), $1::uuid, $2, $3, $4::jsonb)`,
      [sessionId, ++eventSeq, type, JSON.stringify(payload)],
    );
  };
  await event('user', { text: TITLE });
  await event('assistant', { text: `Here is the plan ${RUN}.` });
  // The public link to the same session, so the two doors are read side by side.
  const shareToken = randomBytes(24).toString('base64url');
  await sql.query(
    `INSERT INTO share_link (id, owner_id, token, session_id) VALUES (gen_random_uuid(), $1::uuid, $2, $3::uuid)`,
    [ownerId, shareToken, sessionId],
  );

  const jwtSecret = `guest-projection-${randomUUID()}`;
  const jwt = new JwtService({ secret: jwtSecret });
  const ownerLogin = await jwt.signAsync({ sub: ownerId, email: SECRET.ownerEmail });
  const guestLogin = await jwt.signAsync({ sub: guestId, email: SECRET.guestEmail });
  server = await startApiserver(url, jwtSecret);
  const api = (method: string, path: string, bearer: string | undefined, body?: unknown): Promise<Reply> =>
    call(server!, method, `/api${path}`, bearer, body);
  const ok = (reply: Reply, what: string) => {
    assert.ok(reply.status >= 200 && reply.status < 300, `${what} answered ${reply.status}: ${reply.text.slice(0, 500)}`);
    return reply;
  };
  const runner = (method: string, rest: string, body?: unknown) =>
    call(server!, method, `/api/runner/sessions/${pub(sessionId)}/${rest}`, RUNNER_TOKEN, body);

  /** The guest's user id in every spelling a read could carry it. */
  const guestIds = [guestId, pub(guestId)];
  const carriesGuestId = (text: string) => guestIds.filter((id) => text.includes(id));

  /** The `session.updated` summary the control-plane stream would send the owner, ids spelled as it spells them. */
  async function pushed(): Promise<Json> {
    const updated = firstValueFrom(realtime.streamForUser(ownerId).pipe(
      filter((e) => e.type === ControlEventType.SESSION_UPDATED && e.sessionId === sessionId),
      timeout(5_000),
    ));
    realtime.publishSessionUpdated(sessionId);
    return addTwins((await updated).data, true) as Json;
  }

  ok(await api('POST', `/sessions/${pub(sessionId)}/guests`, ownerLogin, { email: SECRET.guestEmail }), 'inviting');
  const GUEST_WORDS = `Could you also check the tests? ${RUN}`;
  let turnId = '';

  await t.test('(1) the guest turn names the guest on the session row, its summary and the queue — by name, never by user id', async () => {
    const sent = ok(await api('POST', `/guest-sessions/${pub(sessionId)}/turns`, guestLogin, { clientTurnId: randomUUID(), content: GUEST_WORDS }), 'the guest turn');
    assert.deepEqual(carriesGuestId(sent.text), [], "the guest's own answer");
    const row = await db.conversationTurn.findFirstOrThrow({
      where: { sessionId, externalSenderSource: 'ORBIT_GUEST' },
      select: { id: true, externalSenderId: true },
    });
    turnId = row.id;
    // The positive control: the id is stored — on the turn, where the door matches a guest's own turns — so its
    // absence below is the reads', not the fixture's.
    assert.equal(row.externalSenderId, guestId);

    const detail = ok(await api('GET', `/sessions/${pub(sessionId)}`, ownerLogin), "the owner's detail");
    assert.deepEqual(detail.json.lastUserFromExternal, ORBIT_GUEST, 'the detail names the guest');
    assert.equal(detail.json.lastUserText, GUEST_WORDS);
    assert.deepEqual(carriesGuestId(detail.text), [], 'the detail carries the guest user id');

    const list = ok(await api('GET', `/sessions?workspaceId=${pub(workspaceId)}`, ownerLogin), "the owner's list");
    const listed = Array.isArray(list.json) ? list.json : list.json.items ?? list.json.sessions;
    const listRow = listed.find((r: Json) => r.id === pub(sessionId));
    assert.ok(listRow, `the list has the session: ${list.text.slice(0, 300)}`);
    assert.deepEqual(listRow.lastUserFromExternal, ORBIT_GUEST, 'the list row names the guest');
    assert.deepEqual(carriesGuestId(list.text), [], 'the list carries the guest user id');

    const summary = await pushed();
    assert.deepEqual(summary.lastUserFromExternal, ORBIT_GUEST, 'the session.updated summary names the guest');
    assert.equal(summary.lastUserText, GUEST_WORDS);
    assert.deepEqual(carriesGuestId(JSON.stringify(summary)), [], 'the session.updated summary carries the guest user id');

    // The queue as installed clients read it, and as web reads it with the turn about to be dispatched in it.
    const queues: string[] = [];
    for (const view of ['', '?view=active']) {
      const queue = ok(await api('GET', `/sessions/${pub(sessionId)}/turns${view}`, ownerLogin), `the owner's queue${view}`);
      assert.deepEqual(carriesGuestId(queue.text), [], `the queue${view} carries the guest user id`);
      queues.push(queue.text);
    }
    assert.ok(queues.some((text) => text.includes(GUEST_WORDS)), `no queue view holds the guest's turn: ${queues.join(' | ').slice(0, 500)}`);
  });

  let lease = { owner: '', generation: '' };
  await t.test('(2) the runner inbox hands the guest turn over with source and name, never the user id', async () => {
    lease = { owner: randomUUID(), generation: randomUUID() };
    await sql.query(`INSERT INTO "inbox_lease_generation" ("generation", "session_id", "lease_owner") VALUES ($1::uuid, $2::uuid, $3::uuid)`,
      [lease.generation, sessionId, lease.owner]);
    await sql.query('BEGIN');
    await sql.query(`SELECT set_config('orbit.claim_reads_session_engine', '1', true)`);
    await sql.query(
      `UPDATE "session" SET "status" = 'RUNNING', "assigned_runner_id" = $2::uuid, "inbox_lease_owner" = $3::uuid,
              "inbox_lease_generation" = $4::uuid, "started_at" = coalesce("started_at", now())
        WHERE "id" = $1::uuid`, [sessionId, runnerId, lease.owner, lease.generation]);
    await sql.query('COMMIT');
    const fetched = await runner('GET', `inbox?acceptsSteer=1&leaseGeneration=${lease.generation}`);
    assert.equal(fetched.status, 200, fetched.text);
    assert.equal(fetched.json.turnId, turnId, `the inbox handed out the guest's turn: ${fetched.text.slice(0, 300)}`);
    assert.equal(fetched.json.content, GUEST_WORDS);
    assert.deepEqual(fetched.json.externalSender, ORBIT_GUEST, 'the inbox says who sent it, by name');
    assert.deepEqual(carriesGuestId(fetched.text), [], 'the inbox payload carries the guest user id');
    assert.equal(fetched.text.includes(SECRET.guestEmail), false, "the inbox payload carries the guest's email");
  });

  await t.test('(3) the echo is stored with the guest by name, and the events the owner reads carry no guest user id', async () => {
    const block = `\n\n<orbit-external-sender source="orbit-guest" name="${GUEST_NAME}">\nThis message is from someone the account owner invited to this conversation, not from the owner.\n</orbit-external-sender>`;
    const echoSeq = ++eventSeq;
    const echoed = await runner('POST', 'events', {
      leaseOwner: lease.owner,
      events: [{ seq: echoSeq, type: 'user', turnId, ts: new Date().toISOString(), payload: { text: `${GUEST_WORDS}${block}` } }],
    });
    assert.equal(echoed.status, 202, echoed.text);
    const stored = await db.runEvent.findFirstOrThrow({ where: { sessionId, seq: echoSeq } });
    const payload = stored.payload as Json;
    assert.deepEqual(payload.externalSender, ORBIT_GUEST, 'the echo is stored with its sender, by name');
    assert.deepEqual(carriesGuestId(JSON.stringify(payload)), [], 'the stored echo carries the guest user id');
    const replied = await runner('POST', 'events', {
      leaseOwner: lease.owner,
      events: [{ seq: ++eventSeq, type: 'assistant', turnId, ts: new Date().toISOString(), payload: { text: `Tests pass ${RUN}.` } }],
    });
    assert.equal(replied.status, 202, replied.text);

    for (const route of [`/sessions/${pub(sessionId)}/events/page?limit=50`, `/sessions/${pub(sessionId)}/events/${echoSeq}/full`]) {
      const read = ok(await api('GET', route, ownerLogin), `the owner's ${route}`);
      assert.ok(read.text.includes(GUEST_NAME), `${route} names the guest: ${read.text.slice(0, 300)}`);
      assert.deepEqual(carriesGuestId(read.text), [], `${route} carries the guest user id`);
    }
    const summary = await pushed();
    assert.deepEqual(carriesGuestId(JSON.stringify(summary)), [], 'the summary after the reply carries the guest user id');
  });

  await t.test('(4) the red line: planted in the owner\'s session, shown there first, absent from the public link and every guest read route', async () => {
    const ids = { owner: ownerId, guest: guestId, workspace: workspaceId, runner: runnerId };
    const neverShown = [...Object.values(SECRET), ...Object.values(ids).map(pub), ...Object.values(ids)];

    // The positive control: what the owner's own detail says of the session holds the planted session and account
    // values and the red-line fields — so their absence below is the projection's, not the fixture's.
    const mine = ok(await api('GET', `/sessions/${pub(sessionId)}`, ownerLogin), "the owner's detail");
    const inOwners = [SECRET.branch, SECRET.sha, SECRET.model, pub(ownerId), pub(workspaceId)];
    assert.deepEqual(inOwners.filter((value) => !mine.text.includes(value)), [], 'the fixture did not plant what (4) looks for');
    const ownerKeys = keysOf(mine.json);
    assert.deepEqual(
      ['ownerId', 'workspaceId', 'provider', 'model', 'branch', 'baseSha', 'costUsd'].filter((name) => !ownerKeys.has(name)),
      [],
      'the owner\'s read lost a field (4) proves absent from the projections',
    );
    // The machine-side values live under the workspace and the runner.
    const machine = (await sql.query(
      'SELECT w.work_dir, r.name AS runner FROM workspace w JOIN runner r ON r.id = w.runner_id WHERE w.id = $1', [workspaceId],
    )).rows[0];
    assert.deepEqual(machine, { work_dir: SECRET.path, runner: SECRET.runner });

    const s = pub(sessionId);
    const publicAnswers: [string, Reply][] = [
      ['public link, root', await api('GET', `/shared/${shareToken}`, undefined)],
      ['public link, events', await api('GET', `/shared/${shareToken}/events?limit=2`, undefined)],
      ['public link, events before a seq', await api('GET', `/shared/${shareToken}/events?before=${eventSeq}`, undefined)],
      ['public link, events after a seq', await api('GET', `/shared/${shareToken}/events?after=1`, undefined)],
      ['public link, one event', await api('GET', `/shared/${shareToken}/events/3`, undefined)],
    ];
    const guestAnswers: [string, Reply][] = [
      ['guest, Shared with me', await api('GET', '/guest-sessions', guestLogin)],
      ['guest, page', await api('GET', `/guest-sessions/${s}`, guestLogin)],
      ['guest, events', await api('GET', `/guest-sessions/${s}/events?limit=2`, guestLogin)],
      ['guest, events before a seq', await api('GET', `/guest-sessions/${s}/events?before=${eventSeq}`, guestLogin)],
      ['guest, events after a seq', await api('GET', `/guest-sessions/${s}/events?after=1`, guestLogin)],
      ['guest, one event (the echo)', await api('GET', `/guest-sessions/${s}/events/3`, guestLogin)],
      ['guest, one event', await api('GET', `/guest-sessions/${s}/events/2`, guestLogin)],
    ];
    // The public page is not the guest's: it does not say who shared it.
    for (const [what, answer, values] of [
      ...publicAnswers.map(([w, a]) => [w, a, [...neverShown, OWNER_NAME]] as const),
      ...guestAnswers.map(([w, a]) => [w, a, neverShown] as const),
    ]) {
      assert.equal(answer.status, 200, `${what}: ${answer.text.slice(0, 300)}`);
      // Shared with me is a list of the caller's own invitations under `sessions`: that name is its envelope, so its
      // entries are what the field check walks (on a task, `sessions` would be the runs, and is refused there).
      const crossed = redLineCrossings(what === 'guest, Shared with me' ? { text: answer.text, json: answer.json.sessions } : answer, values);
      assert.deepEqual(crossed.values, [], `${what} carries a red-line value`);
      assert.deepEqual(crossed.fields, [], `${what} carries a red-line field`);
    }

    // What the guest door does show: the guest's words under the guest's name, and who shared it.
    const [, page] = guestAnswers[1]!;
    assert.equal(page.json.ownerName, OWNER_NAME);
    const echo = (page.json.events as Json[]).find((e) => e.seq === 3);
    assert.deepEqual(echo?.payload?.externalSender, ORBIT_GUEST, 'the guest page names the guest on the echo');
    const [, shared] = guestAnswers[0]!;
    assert.deepEqual(shared.json.sessions.map((x: Json) => x.ownerName), [OWNER_NAME]);
    // The guest door's page is the public link's page, field for field, plus who shared it and whether the agent
    // waits on them — a bare boolean, since what the waiting card asks is the owner's alone.
    const [, publicRoot] = publicAnswers[0]!;
    const fieldsOf = (json: Json) => Object.keys(json).sort();
    const { ownerName: _ownerName, waitingOnOwner, ...guestPage } = page.json;
    assert.equal(typeof waitingOnOwner, 'boolean', 'the guest page says only whether the agent waits on the owner');
    assert.deepEqual(
      fieldsOf(guestPage).filter((f) => !fieldsOf(publicRoot.json).includes(f)),
      [],
      'the guest page carries a field the public page does not',
    );
  });
});
