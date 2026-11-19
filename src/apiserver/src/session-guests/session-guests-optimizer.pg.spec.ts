/**
 * A guest's ✦ Optimize (project 3504qZwKVUy7ccEQYo3HR, D3–D4), held against the production apiserver — `build/main.js`,
 * the whole AppModule behind JwtAuthGuard — over a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty,
 * with the server's DeepSeek pointed at a stub this spec serves:
 *
 *   (1) a live guest gets an optimization built from the shared transcript's user and assistant turns alone:
 *       `contextUsed` is TURNS, and what DeepSeek is sent carries none of the session's recap, workspace name or
 *       tool output, nor a project or wiki heading;
 *   (2) a stranger, a removed guest, a guest who left and a guest of a session in the Trash get the door's one 404;
 *   (3) a guest whose own switch is off gets 409 PROMPT_OPTIMIZER_OFF;
 *   (4) the 101st use in a UTC day is 429 PROMPT_OPTIMIZER_DAILY_LIMIT, counted on the guest's own row, apart from
 *       the 50-messages cap;
 *   (5) the guest page's head and its following read carry the session's permission mode, and no model.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/session-guests/session-guests-optimizer.pg.spec.ts
 *
 * Not destructive: every row belongs to users this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

import { JwtService } from '@nestjs/jwt';
import { GUEST_PROMPT_OPTIMIZER_DAILY_USES, RunEventType } from '@orbit/shared';
import { type PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';

import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated } from '../projects/coordinator-pg-test-safety';
import { GUEST_SESSION_NOT_SHARED } from './session-guests.service';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);

test('guest ✦ Optimize: shared turns only, the door\'s 404, the guest\'s switch, the daily cap, and the permission mode on the head', {
  skip: !URL, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const db: PrismaClient = prismaClientFor(url);
  let server: Apiserver | undefined;

  // DeepSeek, as the apiserver reaches it: every request recorded, each answered with one short prompt.
  const asked: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const deepSeek: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      asked.push(JSON.parse(body));
      const content = JSON.stringify({ segments: [{ text: 'Please retry only the flaky tests.', added: false }], language: 'en' });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }));
    });
  });
  await new Promise<void>((resolve) => deepSeek.listen(0, '127.0.0.1', resolve));
  const deepSeekUrl = `http://127.0.0.1:${(deepSeek.address() as AddressInfo).port}`;

  t.after(async () => {
    await server?.stop();
    await new Promise<void>((resolve) => deepSeek.close(() => resolve()));
    await db.$disconnect().catch(() => undefined);
  });

  const person = async (label: string) => {
    const id = randomUUID();
    const email = `guest-optimizer-${label}-${RUN}-${id}@session-guests.invalid`;
    await db.user.create({ data: { id, email, name: `${label} ${RUN}`, passwordHash: 'x' } });
    return { id, email };
  };
  const owner = await person('owner');
  const guest = await person('alice');
  const stranger = await person('stranger');
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const WORKSPACE_NAME = `workspace-secret-${RUN}`;
  const RECAP = `recap-secret-${RUN}`;
  const TOOL_OUTPUT = `tool-output-secret-${RUN}`;
  await db.runner.create({
    data: {
      id: runnerId, ownerId: owner.id, name: 'guest-optimizer-runner', tokenHash: `guest-optimizer-${runnerId}`,
      status: RunnerStatus.ONLINE, lastHeartbeatAt: new Date(), capabilities: [], capabilitiesReportedAt: new Date(),
    },
  });
  await db.workspace.create({ data: { id: workspaceId, ownerId: owner.id, runnerId, name: WORKSPACE_NAME, enabled: true } });

  /** An owner's session with a recap and a transcript: two turns a guest reads, and a tool call between them. */
  const session = async (title: string) => {
    const id = randomUUID();
    await db.session.create({
      data: {
        id, ownerId: owner.id, creatorId: owner.id, workspaceId, assignedRunnerId: runnerId, title, prompt: title,
        provider: 'claude', providerBuiltin: true, model: 'claude-opus-4-1', permissionMode: 'acceptEdits',
        dispatchOrigin: SessionDispatchOrigin.USER, status: RunStatus.AWAITING_INPUT, numTurns: 1, engineTurnActive: false,
        runtimeSessionId: randomUUID(), startedAt: new Date(), recapText: RECAP,
      },
    });
    await db.runEvent.createMany({
      data: [
        { sessionId: id, seq: 1, type: RunEventType.USER, payload: { text: `Which tests are flaky in ${title}?` } },
        { sessionId: id, seq: 2, type: RunEventType.TOOL_USE, payload: { name: 'Bash', input: { command: TOOL_OUTPUT } } },
        { sessionId: id, seq: 3, type: RunEventType.ASSISTANT, payload: { text: 'Three tests tagged @flaky fail one run in five.' } },
      ],
    });
    return id;
  };
  const invite = (sessionId: string) =>
    db.sessionGuest.create({ data: { sessionId, ownerId: owner.id, userId: guest.id }, select: { id: true } });

  const jwtSecret = `guest-optimizer-${randomUUID()}`;
  const jwt = new JwtService({ secret: jwtSecret });
  const loginOf = (p: { id: string; email: string }) => jwt.signAsync({ sub: p.id, email: p.email });
  const [ownerLogin, guestLogin, strangerLogin] = await Promise.all([loginOf(owner), loginOf(guest), loginOf(stranger)]);
  server = await startApiserver(url, jwtSecret, { DEEPSEEK_API_KEY: 'stub-key', DEEPSEEK_BASE_URL: deepSeekUrl });
  const api = (method: string, path: string, bearer: string, body?: unknown): Promise<Reply> =>
    call(server!, method, `/api${path}`, bearer, body);
  const optimize = (sessionId: string, bearer: string, draft = 'retry the flaky ones') =>
    api('POST', `/guest-sessions/${sessionId}/prompt-optimizations`, bearer, { draft });

  await t.test('(1) a live guest is optimized from the shared turns alone; contextUsed is TURNS', async () => {
    const sessionId = await session('the live one');
    await invite(sessionId);
    const before = asked.length;
    const answer = await optimize(sessionId, guestLogin);
    assert.equal(answer.status, 200, answer.text);
    assert.equal(answer.json.text, 'Please retry only the flaky tests.');
    assert.deepEqual(answer.json.contextUsed, [{ kind: 'TURNS', count: 2 }]);
    assert.equal(asked.length, before + 1);
    const sent = asked.at(-1)!.messages.map((m) => m.content).join('\n');
    assert.match(sent, /USER: Which tests are flaky in the live one\?/);
    assert.match(sent, /ASSISTANT: Three tests tagged @flaky fail one run in five\./);
    assert.match(sent, /collaborator/);
    for (const secret of [RECAP, WORKSPACE_NAME, TOOL_OUTPUT, 'Session recap', 'Workspace:', 'Project:', 'Wiki entries']) {
      assert.ok(!sent.includes(secret), `DeepSeek is sent no "${secret}"`);
    }
  });

  await t.test('(2) a stranger, a removed guest, a guest who left and a guest of a Trash session get the door\'s one 404', async () => {
    const sessionId = await session('the refused one');
    await invite(sessionId);
    const before = asked.length;

    const strangers = await optimize(sessionId, strangerLogin);
    assert.equal(strangers.status, 404, strangers.text);
    assert.equal(strangers.json.message, GUEST_SESSION_NOT_SHARED);
    const owners = await optimize(sessionId, ownerLogin);
    assert.equal(owners.status, 404, 'the owner is no guest of their own session');

    // Removed by the owner.
    const removed = await api('DELETE', `/sessions/${sessionId}/guests/${guest.id}`, ownerLogin);
    assert.equal(removed.status, 200, removed.text);
    const afterRemoval = await optimize(sessionId, guestLogin);
    assert.equal(afterRemoval.status, 404, afterRemoval.text);
    assert.equal(afterRemoval.json.message, GUEST_SESSION_NOT_SHARED);

    // Left.
    const leftSession = await session('the one left');
    await invite(leftSession);
    assert.equal((await api('POST', `/guest-sessions/${leftSession}/leave`, guestLogin)).status, 201);
    const afterLeaving = await optimize(leftSession, guestLogin);
    assert.equal(afterLeaving.status, 404, afterLeaving.text);
    assert.equal(afterLeaving.json.message, GUEST_SESSION_NOT_SHARED);

    // The session in the Trash.
    const trashed = await session('the trashed one');
    await invite(trashed);
    await db.session.update({ where: { id: trashed }, data: { deletedAt: new Date() } });
    const inTrash = await optimize(trashed, guestLogin);
    assert.equal(inTrash.status, 404, inTrash.text);
    assert.equal(inTrash.json.message, GUEST_SESSION_NOT_SHARED);

    assert.equal(asked.length, before, 'DeepSeek is asked nothing for any of them');
  });

  await t.test('(3) a guest whose own switch is off gets 409 PROMPT_OPTIMIZER_OFF', async () => {
    const sessionId = await session('the switched-off one');
    await invite(sessionId);
    await db.user.update({ where: { id: guest.id }, data: { preferences: { promptOptimizer: false } } });
    try {
      const off = await optimize(sessionId, guestLogin);
      assert.equal(off.status, 409, off.text);
      assert.equal(off.json.code, 'PROMPT_OPTIMIZER_OFF');
    } finally {
      await db.user.update({ where: { id: guest.id }, data: { preferences: {} } });
    }
  });

  await t.test('(4) the 101st use in a day is 429 PROMPT_OPTIMIZER_DAILY_LIMIT, counted apart from messages', async () => {
    const sessionId = await session('the busy one');
    const row = await invite(sessionId);
    for (let i = 1; i <= GUEST_PROMPT_OPTIMIZER_DAILY_USES; i++) {
      const used = await optimize(sessionId, guestLogin, `draft ${i}`);
      assert.equal(used.status, 200, `use ${i}: ${used.text}`);
    }
    const before = asked.length;
    const limited = await optimize(sessionId, guestLogin, 'one more');
    assert.equal(limited.status, 429, limited.text);
    assert.equal(limited.json.code, 'PROMPT_OPTIMIZER_DAILY_LIMIT');
    assert.match(limited.json.message, /100 drafts in this conversation today/);
    assert.equal(asked.length, before, 'DeepSeek is not asked past the cap');
    const counted = await db.sessionGuest.findUniqueOrThrow({
      where: { id: row.id }, select: { optimizerUsesOnDay: true, turnsOnDay: true },
    });
    assert.equal(counted.optimizerUsesOnDay, GUEST_PROMPT_OPTIMIZER_DAILY_USES);
    assert.equal(counted.turnsOnDay, 0, 'the 50-messages count is untouched');

    // Another session's invitation has its own count.
    const other = await session('another one');
    await invite(other);
    assert.equal((await optimize(other, guestLogin)).status, 200);
  });

  await t.test('(5) the guest page\'s head and its following read carry the permission mode, and no model', async () => {
    const sessionId = await session('the limits one');
    await invite(sessionId);
    const head = await api('GET', `/guest-sessions/${sessionId}`, guestLogin);
    assert.equal(head.status, 200, head.text);
    assert.equal(head.json.permissionMode, 'acceptEdits');
    const following = await api('GET', `/guest-sessions/${sessionId}/events?after=0`, guestLogin);
    assert.equal(following.status, 200, following.text);
    assert.equal(following.json.permissionMode, 'acceptEdits');
    for (const body of [head.json, following.json]) {
      assert.ok(!JSON.stringify(body).includes('claude-opus-4-1'), 'no model');
      assert.ok(!('model' in body) && !('provider' in body));
    }
  });
});
