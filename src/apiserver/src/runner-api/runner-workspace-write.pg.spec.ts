/**
 * PATCH /api/runner/workspaces/:id and POST /api/runner/workspaces — a session writing what decides a
 * workspace's next session (`agent_create`, `agent_update`, `orbit agent create`, `orbit agent update`) —
 * against a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty, through the production apiserver
 * (`build/main.js`: RunnerAuthGuard, the orchestration gate, the approvals route and the owner's decision route
 * in front of it). What it is held to:
 *
 *   (1) with no card nothing is written, field by field, door by door, in every permission mode;
 *   (2) the card is filed with the server's reading of the workspace, and what the caller says about it is not;
 *   (3) nothing is written on that card while it waits, nor after the owner declines it;
 *   (4) the owner's yes writes exactly what the card said, once;
 *   (5) a card covers nothing but its own write, in its own session, answered by a person;
 *   (6) the rest of a workspace, a request with no session and the owner's own client are as they were;
 *   (7) a variable's value is off the card once it is answered, reaches no session and no log.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/runner-api/runner-workspace-write.pg.spec.ts
 *
 * Not destructive: every row belongs to users this run creates.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { JwtService } from '@nestjs/jwt';
import { Prisma, RunStatus, SessionDispatchOrigin, type PrismaClient } from '@prisma/client';
import { toUuid, uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver } from '../auth/pat-test-apiserver';
import { prismaClientFor } from '../prisma/prisma-client';
import { canonicalJson } from '../projects/canonical-json';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const REFUSED = 'WORKSPACE_WRITE_APPROVAL_REQUIRED';
const MODES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'] as const;
/** A value a test can look for anywhere: on a row, in a read, in the server's own output. */
const SECRET = `value-of-a-key-${RUN}`;

test('a session writes what decides a workspace\'s next session only on the owner\'s card', {
  skip: !URL, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const db: PrismaClient = prismaClientFor(url);
  const jwtSecret = `runner-workspace-write-spec-${randomUUID()}`;
  const jwt = new JwtService({ secret: jwtSecret, signOptions: { expiresIn: '1h' } });
  let server: Apiserver | null = null;
  t.after(async () => {
    await server?.stop().catch(() => undefined);
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  await verifyCoordinatorPgIdentity(sql);
  server = await startApiserver(url, jwtSecret);

  async function owner(name: string) {
    const id = randomUUID();
    const email = `${name}-${RUN}@workspace-write.test`;
    await db.user.create({ data: { id, email, name, passwordHash: 'x' } });
    return { id, login: () => jwt.signAsync({ sub: id, email }) };
  }
  async function runner(ownerId: string, name: string) {
    const id = randomUUID();
    const token = randomBytes(32).toString('base64url');
    await db.runner.create({
      data: { id, ownerId, name: `${name}-${RUN}`, displayName: `${name} display`, tokenHash: sha256(token), status: 'ONLINE', lastHeartbeatAt: new Date(Date.now() + 2 * 3_600_000) },
    });
    return { id, token };
  }
  async function workspace(ownerId: string, runnerId: string, name: string, data: Partial<Prisma.WorkspaceUncheckedCreateInput> = {}) {
    const id = randomUUID();
    await db.workspace.create({ data: { id, ownerId, runnerId, name: `${name}-${RUN}`, enabled: true, ...data } });
    return id;
  }
  /** A session on a machine, holding the credential its runner asks for, as `orbit mcp` does. */
  async function caller(ownerId: string, machine: { id: string; token: string }, workspaceId: string, mode: string) {
    const sessionId = randomUUID();
    await db.session.create({
      data: {
        id: sessionId, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: machine.id, title: `${mode} session`,
        prompt: 'configure the workspace', provider: 'claude', providerBuiltin: true, status: RunStatus.AWAITING_INPUT,
        runtimeSessionId: randomUUID(), startedAt: new Date(), runClaimedAt: new Date(), dispatchOrigin: SessionDispatchOrigin.USER,
        permissionMode: mode as never,
      },
    });
    const issued = await call(server!, 'POST', `/api/runner/sessions/${sessionId}/orchestration-credential`, machine.token);
    assert.equal(issued.status, 200, issued.text);
    return {
      ...machine,
      workspaceId,
      sessionId,
      headers: { 'x-orbit-session-id': sessionId, 'x-orbit-session-token': issued.json.orchestrationToken as string },
    };
  }

  const alice = await owner('alice');
  const bob = await owner('bob');
  const machine = await runner(alice.id, 'machine');
  const other = await runner(alice.id, 'other-machine');
  const home = await workspace(alice.id, machine.id, 'home');
  const asker = await caller(alice.id, machine, home, 'plan');
  const bobMachine = await runner(bob.id, 'bob-machine');
  const bobHome = await workspace(bob.id, bobMachine.id, 'bob-home');
  const stranger = await caller(bob.id, bobMachine, bobHome, 'plan');

  type Asker = typeof asker;
  const fresh = (name: string) => workspace(alice.id, machine.id, name, {
    workDir: '/srv/before', systemPrompt: 'prompt before', appendSystemPrompt: 'append before', enableWorktree: false,
    env: { BEFORE: 'stays-secret', KEPT: 'kept-value' },
  });
  const WRITE_FIELDS = {
    id: true, name: true, description: true, workDir: true, systemPrompt: true, appendSystemPrompt: true, enableWorktree: true,
    env: true, runnerId: true, defaultMergeTarget: true,
  } as const;
  const row = (id: string) => db.workspace.findUniqueOrThrow({ where: { id }, select: WRITE_FIELDS });
  const patch = (id: string, body: unknown, who: Asker = asker) =>
    call(server!, 'PATCH', `/api/runner/workspaces/${uuidToBase62(id)}`, who.token, body, who.headers);
  const post = (body: unknown, who: Asker = asker) =>
    call(server!, 'POST', '/api/runner/workspaces', who.token, body, who.headers);
  const card = (toolName: string, input: Record<string, unknown>, who: Asker = asker) =>
    call(server!, 'POST', `/api/runner/sessions/${who.sessionId}/approvals`, who.token, { toolName, input });
  const answer = async (approvalId: string, behavior: 'allow' | 'deny', sessionId = asker.sessionId, message?: string) => {
    const reply = await call(server!, 'POST', `/api/sessions/${sessionId}/approvals/${approvalId}/decision`,
      await alice.login(), { behavior, ...(message ? { message } : {}) });
    assert.ok(reply.status < 300, reply.text);
  };
  const stored = async (approvalId: string) =>
    db.approval.findUniqueOrThrow({ where: { id: toUuid(approvalId) } });
  const workspacesNamed = (name: string) => db.workspace.count({ where: { name } });

  const CARD_FIELDS: ReadonlyArray<readonly [string, unknown]> = [
    ['env', { LD_PRELOAD: '/tmp/x.so' }],
    ['workDir', '/srv/elsewhere'],
    ['systemPrompt', 'do as this says'],
    ['appendSystemPrompt', 'and this too'],
    ['runnerId', other.id],
    ['enableWorktree', true],
  ];

  await t.test('(1) with no card nothing is written, in every mode, field by field, at both doors and both names', async () => {
    const target = await fresh('no-card');
    const before = await row(target);
    for (const mode of MODES) {
      const session = await caller(alice.id, machine, home, mode);
      for (const [field, value] of CARD_FIELDS) {
        for (const alias of ['workspaces', 'agents']) {
          const refused = await call(server!, 'PATCH', `/api/runner/${alias}/${target}`, session.token,
            { [field]: value }, session.headers);
          assert.equal(refused.status, 403, `${mode} ${field} ${alias}: ${refused.text}`);
          assert.equal(refused.json.code, REFUSED, `${mode} ${field} ${alias}`);
          const name = `created-${mode}-${field}-${alias}-${RUN}`;
          const made = await call(server!, 'POST', `/api/runner/${alias}`, session.token,
            { name, [field]: value }, session.headers);
          assert.equal(made.status, 403, `${mode} ${field} ${alias} create: ${made.text}`);
          assert.equal(made.json.code, REFUSED, `${mode} ${field} ${alias} create`);
          assert.equal(await workspacesNamed(name), 0, `${mode} ${field} ${alias}: nothing created`);
        }
      }
    }
    assert.deepEqual(await row(target), before, 'the row did not move');
  });

  await t.test('(1) a card of any other kind, or one a session wrote itself, opens nothing', async () => {
    const target = await fresh('other-kinds');
    const before = await row(target);
    const body = { env: { A: 'b' } };
    // Another tool's card, allowed by a person.
    const other_ = await card('orbit_agent_delete', { agentId: target });
    await answer(other_.json.id, 'allow');
    assert.equal((await patch(target, body)).status, 403);
    // A row a session could only have written through the route, naming the write without a digest.
    const forged = await db.approval.create({
      data: {
        sessionId: asker.sessionId, toolName: 'orbit_agent_update', input: { agentId: target, ...body }, status: 'ALLOWED',
        decidedAt: new Date(), decidedById: alice.id,
      },
    });
    assert.equal((await patch(target, body)).status, 403);
    await db.approval.delete({ where: { id: forged.id } });
    assert.deepEqual(await row(target), before);
  });

  await t.test('(2) the card says what the server reads, whatever the asker sends beside the write', async () => {
    const target = await fresh('reading');
    const filed = await card('orbit_agent_update', {
      agentId: uuidToBase62(target),
      name: undefined,
      env: { KEPT: 'kept-value', API_KEY: SECRET },
      workDir: '/srv/after',
      appendSystemPrompt: 'append after',
      runnerId: uuidToBase62(other.id),
      enableWorktree: true,
      // None of this is the asker's to say.
      runner: { name: 'a harmless scratch box' },
      writeDigest: 'forged',
      envRemoved: [],
      enabled: false,
    });
    assert.ok(filed.status < 300, filed.text);
    assert.equal(filed.json.status, 'PENDING');
    const input = (await stored(filed.json.id)).input as Record<string, any>;
    assert.equal(input.agentId, target);
    assert.equal(input.name, `reading-${RUN}`);
    assert.equal(input.workDir, '/srv/before');
    assert.deepEqual(input.runner, { id: machine.id, name: `machine-${RUN}`, displayName: 'machine display' });
    assert.deepEqual(input.changes, {
      env: { KEPT: 'kept-value', API_KEY: SECRET },
      workDir: '/srv/after',
      appendSystemPrompt: 'append after',
      runner: { id: other.id, name: `other-machine-${RUN}`, displayName: 'other-machine display' },
      enableWorktree: true,
    });
    assert.deepEqual(input.envRemoved, ['BEFORE'], 'a write of env replaces the map, so the card names what goes');
    assert.notEqual(input.writeDigest, 'forged');
    // The owner reads the values; nobody else is handed them.
    const owners = await call(server!, 'GET', `/api/sessions/${asker.sessionId}/approvals`, await alice.login());
    assert.equal(owners.status, 200);
    const read = owners.json.find((a: { id: string }) => toUuid(a.id) === toUuid(filed.json.id));
    assert.equal(read?.input?.changes?.env?.API_KEY, SECRET);
    assert.equal((await call(server!, 'GET', `/api/sessions/${asker.sessionId}/approvals`, await bob.login())).status, 404);
    await answer(filed.json.id, 'deny');
  });

  await t.test('(2) no card about what no answer could write, or about what needs none', async () => {
    const before = await db.approval.count({ where: { sessionId: { in: [asker.sessionId, stranger.sessionId] } } });
    const target = await fresh('no-card-filed');
    assert.equal((await card('orbit_agent_update', { agentId: target, env: { A: 'b' } }, stranger)).status, 404, 'another account\'s workspace');
    assert.equal((await card('orbit_agent_update', { agentId: randomUUID(), env: { A: 'b' } })).status, 404, 'no such workspace');
    assert.equal((await card('orbit_agent_update', { env: { A: 'b' } })).status, 404, 'no workspace named');
    assert.equal((await card('orbit_agent_update', { agentId: target, runnerId: stranger.id })).status, 403, 'another account\'s runner');
    assert.equal((await card('orbit_agent_create', { name: 'x', runnerId: stranger.id })).status, 403, 'another account\'s runner');
    assert.equal((await card('orbit_agent_create', { env: { A: 'b' } })).status, 400, 'a create with no name');
    assert.equal((await card('orbit_agent_update', { agentId: target, env: { A: 1 } })).status, 400, 'a malformed value');
    assert.equal((await card('orbit_agent_update', { agentId: target, name: 'renamed' })).status, 400, 'a rename asks nobody');
    assert.equal((await card('orbit_agent_create', { name: 'x', description: 'y' })).status, 400, 'nor a bare create');
    assert.equal(await db.approval.count({ where: { sessionId: { in: [asker.sessionId, stranger.sessionId] } } }), before);
  });

  await t.test('(3) waiting, then declined: nothing is written', async () => {
    const target = await fresh('declined');
    const before = await row(target);
    const write = { env: { A: 'b' }, workDir: '/srv/after' };
    const filed = await card('orbit_agent_update', { agentId: target, ...write });
    const refused = await patch(target, write);
    assert.equal(refused.status, 403, refused.text);
    await answer(filed.json.id, 'deny');
    assert.equal((await patch(target, write)).status, 403);
    assert.deepEqual(await row(target), before);

    const name = `declined-create-${RUN}`;
    const made = await card('orbit_agent_create', { name, systemPrompt: 'x' });
    assert.equal((await post({ name, systemPrompt: 'x' })).status, 403);
    await answer(made.json.id, 'deny');
    assert.equal((await post({ name, systemPrompt: 'x' })).status, 403);
    assert.equal(await workspacesNamed(name), 0);
  });

  await t.test('(4) the owner\'s yes writes exactly what the card said, once', async () => {
    const target = await fresh('allowed');
    const write = {
      env: { NEW_VAR: SECRET }, workDir: '/srv/after', systemPrompt: 'prompt after', appendSystemPrompt: 'append after',
      enableWorktree: true, runnerId: uuidToBase62(other.id),
    };
    const filed = await card('orbit_agent_update', { agentId: uuidToBase62(target), ...write });
    assert.ok(filed.status < 300, filed.text);
    await answer(filed.json.id, 'allow');
    const reply = await patch(target, write);
    assert.equal(reply.status, 200, reply.text);
    assert.equal(reply.text.includes(SECRET), false, 'the answer holds no value');
    const after = await row(target);
    assert.deepEqual(after.env, { NEW_VAR: SECRET });
    assert.equal(after.workDir, '/srv/after');
    assert.equal(after.systemPrompt, 'prompt after');
    assert.equal(after.appendSystemPrompt, 'append after');
    assert.equal(after.enableWorktree, true);
    assert.equal(after.runnerId, other.id);
    // Spent. The owner has since changed it back in the app, and the same write finds no card.
    await db.workspace.update({ where: { id: target }, data: { env: { BACK: 'again' } } });
    const replay = await patch(target, write);
    assert.equal(replay.status, 403, replay.text);
    assert.equal(replay.json.code, REFUSED);
    assert.deepEqual((await row(target)).env, { BACK: 'again' });

    // Two copies of one write: one yes, one write.
    const twice = await fresh('twice');
    const same = { env: { ONE: 'yes' } };
    const once = await card('orbit_agent_update', { agentId: twice, ...same });
    await answer(once.json.id, 'allow');
    const both = await Promise.all([patch(twice, same), patch(twice, same)]);
    assert.deepEqual(both.map((r) => r.status).sort(), [200, 403]);

    // A create the same way, on the calling runner when it names none.
    const name = `allowed-create-${RUN}`;
    const create = { name, env: { CREATED: 'yes' }, workDir: '/srv/new' };
    const made = await card('orbit_agent_create', create);
    assert.ok(made.status < 300, made.text);
    const madeInput = (await stored(made.json.id)).input as Record<string, any>;
    assert.equal(madeInput.agentId, null);
    assert.equal(madeInput.name, name);
    assert.equal(madeInput.runner.id, machine.id);
    await answer(made.json.id, 'allow');
    const created = await post(create);
    assert.ok(created.status < 300, created.text);
    const newRow = await db.workspace.findFirstOrThrow({ where: { name }, select: { env: true, workDir: true, runnerId: true } });
    assert.deepEqual(newRow, { env: { CREATED: 'yes' }, workDir: '/srv/new', runnerId: machine.id });
    assert.equal((await post(create)).status, 403, 'and it is spent too');
  });

  await t.test('(5) what a card is matched on is the server\'s, whatever the asker sends', async () => {
    const target = await fresh('forged');
    const shown = { env: { A: 'what the owner read' } };
    const meant = { env: { A: 'what the session wants' } };
    // A digest a session could have worked out for the write it wants, put beside the write the owner will read.
    const digestOf = (salt: string, write: unknown) => createHash('sha256').update(salt).update(canonicalJson({ workspaceId: target, write })).digest('hex');
    const filed = await card('orbit_agent_update', { agentId: target, ...shown, writeSalt: 's', writeDigest: digestOf('s', meant) });
    assert.ok(filed.status < 300, filed.text);
    await answer(filed.json.id, 'allow');
    assert.equal((await patch(target, meant)).status, 403, 'the digest it sent is not on the card');
    assert.equal((await patch(target, shown)).status, 200, 'the write the owner read still goes through');
    // Nor can it bring a card that asks about nothing, holding a digest of its own.
    const empty = await card('orbit_agent_update', { agentId: target, name: 'harmless', writeSalt: 's', writeDigest: digestOf('s', meant) });
    assert.equal(empty.status, 400, empty.text);
    assert.equal((await patch(target, meant)).status, 403);
  });

  await t.test('(5) a card covers nothing but its own write', async () => {
    const target = await fresh('mismatch');
    const spare = await fresh('mismatch-spare');
    const write = { env: { A: 'one', B: 'two' }, workDir: '/srv/after' };
    const filed = await card('orbit_agent_update', { agentId: target, ...write });
    await answer(filed.json.id, 'allow');
    const before = await row(target);
    for (const [why, id, body] of [
      ['another value', target, { env: { A: 'one', B: 'other' }, workDir: '/srv/after' }],
      ['one variable fewer', target, { env: { A: 'one' }, workDir: '/srv/after' }],
      ['one variable more', target, { env: { A: 'one', B: 'two', C: 'three' }, workDir: '/srv/after' }],
      ['a field left out', target, { env: write.env }],
      ['another field added', target, { ...write, systemPrompt: 'x' }],
      ['a free field added', target, { ...write, description: 'x' }],
      ['another workspace', spare, write],
    ] as const) {
      const refused = await patch(id, body);
      assert.equal(refused.status, 403, `${why}: ${refused.text}`);
      assert.equal(refused.json.code, REFUSED, why);
    }
    assert.deepEqual(await row(target), before);
    // Another session of the same account, on the same machine.
    const sibling = await caller(alice.id, machine, home, 'bypassPermissions');
    assert.equal((await patch(target, write, sibling)).status, 403, 'another session holds no yes');
    // A create's yes writes no update, and an update's yes creates nothing.
    const name = `kinds-${RUN}`;
    const made = await card('orbit_agent_create', { name, env: { A: 'b' } });
    await answer(made.json.id, 'allow');
    assert.equal((await patch(target, { name, env: { A: 'b' } })).status, 403);
    assert.equal((await post({ name: `${name}-2`, env: { A: 'b' } })).status, 403, 'nor a create of another name');
    // The key order of a body is not part of what was asked.
    const reply = await patch(target, { workDir: '/srv/after', env: { B: 'two', A: 'one' } });
    assert.equal(reply.status, 200, reply.text);

    // A standing rule answers no such card, and a card no person answered writes nothing.
    const ruled = await fresh('ruled');
    await db.workspacePermissionRule.create({
      data: { workspaceId: home, toolName: 'orbit_agent_update', createdById: alice.id },
    });
    const asked = await card('orbit_agent_update', { agentId: ruled, env: { R: 's' } });
    assert.equal(asked.json.status, 'PENDING', 'a standing rule is not a yes to this');
    await db.approval.update({ where: { id: toUuid(asked.json.id) }, data: { status: 'ALLOWED', decidedAt: new Date() } });
    assert.equal((await patch(ruled, { env: { R: 's' } })).status, 403);
    await db.workspacePermissionRule.deleteMany({ where: { workspaceId: home, toolName: 'orbit_agent_update' } });
  });

  await t.test('(6) the rest of a workspace, a request with no session and the owner\'s client are as they were', async () => {
    const target = await fresh('rest');
    for (const body of [{ name: `renamed-${RUN}` }, { description: 'says what it is' }, { defaultMergeTarget: 'develop' }]) {
      const reply = await patch(target, body);
      assert.equal(reply.status, 200, reply.text);
    }
    const after = await row(target);
    assert.equal(after.name, `renamed-${RUN}`);
    assert.equal(after.description, 'says what it is');
    assert.equal(after.defaultMergeTarget, 'develop');
    // Fields that once were on the tools write nothing and ask nothing.
    const retired = await patch(target, { permissionMode: 'bypassPermissions', provider: 'codex', model: 'x', enabled: false });
    assert.equal(retired.status, 200, retired.text);
    assert.deepEqual(await row(target), after);
    const named = `name-only-${RUN}`;
    const made = await post({ name: named, description: 'no card', defaultMergeTarget: 'main', permissionMode: 'plan' });
    assert.ok(made.status < 300, made.text);
    assert.equal(await workspacesNamed(named), 1);

    // No session: refused before any of this, as it always was.
    const headless = await call(server!, 'PATCH', `/api/runner/workspaces/${target}`, machine.token, { env: { A: 'b' } });
    assert.equal(headless.status, 400, headless.text);
    assert.equal((await call(server!, 'PATCH', `/api/runner/workspaces/${target}`, machine.token, { description: 'x' })).status, 400);

    // The owner's own client: nobody to ask, no session to ask in.
    const login = await alice.login();
    const owners = await call(server!, 'PATCH', `/api/workspaces/${target}`, login, {
      env: { OWNER: 'set' }, workDir: '/srv/owner', systemPrompt: 'owner prompt',
    });
    assert.equal(owners.status, 200, owners.text);
    const asOwner = await row(target);
    assert.deepEqual(asOwner.env, { OWNER: 'set' });
    assert.equal(asOwner.workDir, '/srv/owner');
    assert.equal((await call(server!, 'POST', '/api/workspaces', login, { name: `owner-made-${RUN}`, env: { OWNER: 'set' }, runnerId: machine.id })).status < 300, true);

    // Across accounts the answer is not found, card field or not, before anything is said about a card.
    assert.equal((await patch(target, { env: { A: 'b' } }, stranger)).status, 404);
    assert.equal((await patch(target, { description: 'x' }, stranger)).status, 404);
  });

  await t.test('(7) a value is off the card once it is answered, reaches no session and no log', async () => {
    const target = await fresh('values');
    const asked = await card('orbit_agent_update', { agentId: target, env: { TOKEN_A: `${SECRET}-allowed`, TOKEN_B: `${SECRET}-allowed-b` } });
    const refused = await card('orbit_agent_update', { agentId: target, env: { TOKEN_C: `${SECRET}-denied` } });
    // A session's own read of its card says how it stands, and nothing of what it says.
    const poll = await call(server!, 'GET', `/api/runner/sessions/${asker.sessionId}/approvals/${asked.json.id}`, asker.token);
    assert.equal(poll.status, 200, poll.text);
    assert.equal(poll.text.includes(SECRET), false);
    const read = await call(server!, 'GET', `/api/runner/sessions/${asker.sessionId}`, asker.token, undefined, asker.headers);
    assert.equal(read.text.includes(SECRET), false, 'session_get reads no card');

    await answer(asked.json.id, 'allow');
    await answer(refused.json.id, 'deny', asker.sessionId, 'not that key');
    for (const [id, names] of [[asked.json.id, ['TOKEN_A', 'TOKEN_B']], [refused.json.id, ['TOKEN_C']]] as const) {
      const row_ = await stored(id);
      assert.equal(JSON.stringify(row_.input).includes(SECRET), false, 'the value is gone from the row');
      assert.deepEqual((row_.input as Record<string, any>).changes.envNames, names, 'the names stay');
    }
    // And the yes still opens its write, on the digest that stayed.
    const reply = await patch(target, { env: { TOKEN_A: `${SECRET}-allowed`, TOKEN_B: `${SECRET}-allowed-b` } });
    assert.equal(reply.status, 200, reply.text);
    // A write refused with a value in it says nothing of the value.
    const again = await patch(target, { env: { TOKEN_D: `${SECRET}-refused` } });
    assert.equal(again.status, 403);
    assert.equal(again.text.includes(SECRET), false);
    // The body of a write is the one place a NUL can reach: it stays refused, and quoted nowhere.
    const nul = await patch(target, { env: { TOKEN_E: `${SECRET}\u0000-nul` } });
    assert.equal(nul.status, 403, nul.text);
    assert.equal(nul.text.includes(SECRET), false);

    // An engine's own permission prompt for the same call files the raw arguments under the tool's name.
    const prompted = await call(server!, 'POST', `/api/runner/sessions/${asker.sessionId}/approvals`, asker.token, {
      toolName: 'mcp__orbit__agent_update', toolUseId: `prompt-${RUN}`, input: { agentId: target, env: { TOKEN_F: `${SECRET}-prompted` } },
    });
    assert.ok(prompted.status < 300, prompted.text);
    assert.equal(JSON.stringify((await stored(prompted.json.id)).input).includes(SECRET), true, 'while it asks, the owner reads it');
    await answer(prompted.json.id, 'allow');
    const answered = (await stored(prompted.json.id)).input as Record<string, unknown>;
    assert.equal(JSON.stringify(answered).includes(SECRET), false);
    assert.deepEqual(answered.envNames, ['TOKEN_F']);
    assert.equal((await patch(target, { env: { TOKEN_F: `${SECRET}-prompted` } })).status, 403, 'and that is no yes to the write');

    // The model's own call, as the runner records it: the transcript keeps the names and no value.
    const seq = 9_000 + Math.floor(Math.random() * 1_000);
    const leaseOwner = randomUUID();
    await db.session.update({ where: { id: asker.sessionId }, data: { inboxLeaseGeneration: leaseOwner, inboxLeaseOwner: leaseOwner } });
    const recorded = await call(server!, 'POST', `/api/runner/sessions/${asker.sessionId}/events`, asker.token, {
      leaseOwner,
      events: [{
        seq, type: 'tool_use', ts: new Date().toISOString(),
        payload: { id: `call-${RUN}`, name: 'mcp__orbit__agent_update', input: { agentId: target, env: { TOKEN_G: `${SECRET}-called` } } },
      }, {
        seq: seq + 1, type: 'tool_use', ts: new Date().toISOString(),
        payload: { id: `other-${RUN}`, name: 'Bash', input: { command: 'echo kept as it was said', env: { NOT_A_WRITE: 'kept' } } },
      }],
    });
    if (recorded.status < 300) {
      const rows = await db.toolCall.findMany({ where: { sessionId: asker.sessionId, toolUseId: { in: [`call-${RUN}`, `other-${RUN}`] } }, select: { toolUseId: true, input: true } });
      const inputs = Object.fromEntries(rows.map((r) => [r.toolUseId, r.input as Record<string, any>]));
      assert.equal(inputs[`call-${RUN}`]?.env?.TOKEN_G, '(set — not shown)');
      assert.equal(inputs[`other-${RUN}`]?.env?.NOT_A_WRITE, 'kept');
      const event = await db.runEvent.findFirst({ where: { sessionId: asker.sessionId, seq } });
      assert.equal(JSON.stringify(event?.payload).includes(SECRET), false, 'nor the event');
    } else {
      assert.fail(`the batch was refused: ${recorded.text}`);
    }

    assert.equal(server!.output().includes(SECRET), false, 'the server\'s own output names no value');
  });
});
