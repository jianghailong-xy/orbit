/**
 * FIX WITH AN AGENT, ON REAL POSTGRESQL.
 *
 * POST /runners/:id/attention/:kind/fix starts an ordinary session on that runner, in its most recently
 * used workspace, with the workspace's own defaults and a first message built from the warning; GET
 * /runners reports the same answer as `agentFix`, which every client draws the button from. Checked here,
 * through the production controller, RunnerAttentionFixService, SessionsService.create and RunnersService:
 *
 *   (1) `runner.attention_fixes` is a nullable JSONB. GET reports the most recently used workspace (by its
 *       newest session), the engine it runs on, nothing blocked and nobody fixing.
 *   (2) A press on an engine update warning starts a session pinned to that runner in that workspace, on
 *       the workspace's own engine and effort, titled "Fix: Codex update failed on <machine>", whose first
 *       message carries the engine, the versions, the update command and the runner's failure text.
 *   (3) While it is open, GET reports it under `fixing` and a second press is refused AGENT_FIX_RUNNING,
 *       creating nothing; once it ends, a press starts a new one.
 *   (4) Two presses at once start one session.
 *   (5) An Install failed panel's press: the message carries the engine, the machine's OS, the command
 *       Orbit ran and the runner's message, and asks for the install to be re-run through Orbit.
 *   (6) The runner's own update (cannotSelfUpdate) builds its message from its self-update report.
 *   (7) Refusals, each with the line the clients show and nothing written: offline, no workspace, the
 *       workspace's engine signed out there (GET says the same); a warning the runner no longer reports;
 *       somebody else's runner.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/runners/runner-attention-fix.pg.spec.ts
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to the rows it made.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma, PrismaClient, RunStatus, RunnerStatus } from '@prisma/client';
import type { RunnerEngineHealth } from '@orbit/shared';
import { Client } from 'pg';

import type { AuthUser } from '../common/current-user.decorator';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { SessionsService } from '../sessions/sessions.service';
import { RunnerAttentionFixController } from './runner-attention-fix.controller';
import { RunnerAttentionFixService } from './runner-attention-fix.service';
import { RunnersService } from './runners.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const quiet = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;

const CODEX_FAILURE = 'Error: No such file or directory (os error 2)';
const NPM_MISSING = 'exit status 127: sh: 1: npm: not found';

/** Codex 13 days behind 0.169.0, its update failing; Claude Code signed in (or not). */
function engines(claudeAuth: 'yes' | 'no' = 'yes'): RunnerEngineHealth[] {
  const behindSince = new Date(Date.now() - 13 * 86_400_000 - 3_600_000).toISOString();
  return [
    {
      engine: 'codex',
      installed: true,
      version: 'codex-cli 0.159.2',
      auth: 'yes',
      update: { status: 'failed', at: new Date().toISOString(), latest: '0.169.0', behindSince, message: CODEX_FAILURE },
    },
    { engine: 'claude', installed: true, version: '2.1.325 (Claude Code)', auth: claudeAuth },
  ];
}

function refusedWith(code: string, message?: string | RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof ConflictException, `expected a 409, got ${String(error)}`);
    const body = error.getResponse() as { code?: string; message?: string };
    assert.equal(body.code, code);
    if (typeof message === 'string') assert.equal(body.message, message);
    else if (message) assert.match(body.message ?? '', message);
    return true;
  };
}

test('Fix with an agent on PostgreSQL', { skip, concurrency: 1, timeout: 300_000 }, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db: PrismaClient = prismaClientFor(url);
  const prisma = db as unknown as PrismaService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, quiet);
  const runners = new RunnersService(prisma, quiet);
  const fixes = new RunnerAttentionFixService(prisma, sessions);
  const controller = new RunnerAttentionFixController(fixes);
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  type Machine = { ownerId: string; runnerId: string; user: AuthUser; name: string };
  async function machine(
    label: string,
    data: Partial<Prisma.RunnerUncheckedCreateInput> = {},
  ): Promise<Machine> {
    const ownerId = randomUUID();
    const runnerId = randomUUID();
    const name = `orbit@${label}`;
    await db.user.create({ data: { id: ownerId, email: `${label}-${ownerId}@attention-fix.invalid`, name: 'The owner', passwordHash: 'x' } });
    await db.runner.create({
      data: {
        id: runnerId,
        ownerId,
        name,
        tokenHash: `hash-${runnerId}`,
        status: RunnerStatus.ONLINE,
        lastHeartbeatAt: new Date(),
        capabilities: ['os:linux'],
        engines: engines() as unknown as Prisma.InputJsonValue,
        ...data,
      },
    });
    return { ownerId, runnerId, user: { userId: ownerId } as AuthUser, name };
  }
  async function workspace(m: Machine, name: string, extra: Partial<Prisma.WorkspaceUncheckedCreateInput> = {}) {
    const id = randomUUID();
    await db.workspace.create({ data: { id, ownerId: m.ownerId, runnerId: m.runnerId, name, enabled: true, ...extra } });
    return id;
  }
  /** A session the owner ran in that workspace at `at`, on Claude Code: what makes it "used". */
  async function usedAt(m: Machine, workspaceId: string, at: Date) {
    await db.session.create({
      data: {
        id: randomUUID(), ownerId: m.ownerId, creatorId: m.ownerId, workspaceId, assignedRunnerId: m.runnerId, title: 'earlier work',
        prompt: 'earlier work', status: RunStatus.AWAITING_INPUT, provider: 'claude', providerBuiltin: true, engine: 'claude',
        createdAt: at,
      },
    });
  }
  async function stored(runnerId: string): Promise<unknown> {
    return (await sql.query(`SELECT attention_fixes FROM "runner" WHERE id = $1::uuid`, [runnerId])).rows[0].attention_fixes;
  }
  async function fixSessions(m: Machine) {
    return db.session.findMany({ where: { ownerId: m.ownerId, title: { startsWith: 'Fix: ' } }, orderBy: { createdAt: 'asc' } });
  }
  async function firstMessage(sessionId: string): Promise<string> {
    const session = await db.session.findUniqueOrThrow({ where: { id: sessionId }, select: { prompt: true } });
    return session.prompt;
  }

  await t.test('(1) the column, and GET reports the most recently used workspace', async () => {
    const column = await sql.query(
      `SELECT a.attnotnull, format_type(a.atttypid, a.atttypmod) AS type
         FROM pg_attribute a
        WHERE a.attrelid = '"runner"'::regclass AND a.attname = 'attention_fixes' AND NOT a.attisdropped`,
    );
    assert.deepEqual(column.rows, [{ attnotnull: false, type: 'jsonb' }]);
    const m = await machine('austin');
    const older = await workspace(m, 'orbit-old');
    const recent = await workspace(m, 'orbit-dev');
    const never = await workspace(m, 'orbit-never-ran');
    await usedAt(m, older, new Date(Date.now() - 3_600_000));
    await usedAt(m, recent, new Date(Date.now() - 60_000));
    void never;
    assert.equal(await stored(m.runnerId), null);
    const view = await runners.getRunner(m.ownerId, m.runnerId);
    assert.deepEqual(view.agentFix, {
      workspaceId: recent,
      workspaceName: 'orbit-dev',
      engine: 'claude',
      engineName: 'Claude Code',
      blocked: null,
      fixing: [],
    });
    // attention_fixes itself is not part of the payload; only what it means is.
    assert.equal((view as Record<string, unknown>).attentionFixes, undefined);
  });

  await t.test('(2)(3) a press starts the session; a second is refused while it is open', async () => {
    const m = await machine('austin');
    const other = await workspace(m, 'orbit-old');
    const dev = await workspace(m, 'orbit-dev', { effort: 'high' });
    await usedAt(m, other, new Date(Date.now() - 3_600_000));
    await usedAt(m, dev, new Date(Date.now() - 60_000));

    const started = await controller.fix(m.user, m.runnerId, 'engineNotUpdating', { engine: 'codex' });
    assert.equal(started.workspaceId, dev);
    assert.equal(started.workspaceName, 'orbit-dev');
    assert.equal(started.title, `Fix: Codex update failed on ${m.name}`);
    const session = await db.session.findUniqueOrThrow({ where: { id: started.sessionId } });
    assert.equal(session.assignedRunnerId, m.runnerId);
    assert.equal(session.workspaceId, dev);
    assert.equal(session.title, `Fix: Codex update failed on ${m.name}`);
    // The workspace's own defaults: its engine (what it last ran), and its effort.
    assert.equal(session.engine, 'claude');
    assert.equal(session.provider, 'claude');
    assert.equal(session.effort, 'high');
    const prompt = await firstMessage(started.sessionId);
    assert.match(prompt, new RegExp(`^Codex on this machine \\(${m.name}\\) has not updated for 13 days\\.`));
    assert.ok(prompt.includes('Orbit runs `codex update` every 30 min; the last attempt, 0.159.2 → 0.169.0, failed with: "Error: No such file or directory (os error 2)".'), prompt);
    assert.ok(prompt.includes('Ask me before installing packages or changing system files.'), prompt);
    assert.ok(prompt.includes('run `orbit engine-update` and tell me what version Codex reports.'), prompt);

    // While it is open: GET reports it, and a second press is refused with nothing made.
    const view = await runners.getRunner(m.ownerId, m.runnerId);
    assert.deepEqual(view.agentFix?.fixing, [
      { kind: 'engineNotUpdating', engine: 'codex', sessionId: started.sessionId, workspaceId: dev, workspaceName: 'orbit-dev' },
    ]);
    await assert.rejects(
      controller.fix(m.user, m.runnerId, 'engineNotUpdating', { engine: 'codex' }),
      refusedWith('AGENT_FIX_RUNNING', 'An agent is already fixing this in orbit-dev.'),
    );
    assert.equal((await fixSessions(m)).length, 1);
    // Waiting on the owner (the agent asked before installing) is still open.
    await db.session.update({ where: { id: started.sessionId }, data: { status: RunStatus.AWAITING_INPUT } });
    await assert.rejects(controller.fix(m.user, m.runnerId, 'engineNotUpdating', { engine: 'codex' }), refusedWith('AGENT_FIX_RUNNING'));

    // Once it is over, the warning is free again.
    await db.session.update({ where: { id: started.sessionId }, data: { completedAt: new Date() } });
    assert.deepEqual((await runners.getRunner(m.ownerId, m.runnerId)).agentFix?.fixing, []);
    const again = await controller.fix(m.user, m.runnerId, 'engineNotUpdating', { engine: 'codex' });
    assert.notEqual(again.sessionId, started.sessionId);
    assert.equal((await fixSessions(m)).length, 2);
  });

  await t.test('(4) two presses at once start one session', async () => {
    const m = await machine('race');
    await usedAt(m, await workspace(m, 'orbit-dev'), new Date());
    const results = await Promise.allSettled([
      controller.fix(m.user, m.runnerId, 'engineNotUpdating', { engine: 'codex' }),
      controller.fix(m.user, m.runnerId, 'engineNotUpdating', { engine: 'codex' }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    assert.ok(refusedWith('AGENT_FIX_RUNNING')(refused.reason));
    assert.equal((await fixSessions(m)).length, 1);
  });

  await t.test('(5) an Install failed panel: the command Orbit ran and the runner\'s message', async () => {
    const m = await machine('vmi3753066', {
      installStatus: 'failed',
      installEngine: 'codex',
      installCommand: 'npm install -g @openai/codex',
      installMessage: NPM_MISSING,
      installMode: 'install',
      engines: [{ engine: 'claude', installed: true, version: '2.1.325', auth: 'yes' }] as unknown as Prisma.InputJsonValue,
    });
    await usedAt(m, await workspace(m, 'orbit-develop'), new Date());
    const started = await controller.fix(m.user, m.runnerId, 'installFailed', { engine: 'codex' });
    assert.equal(started.title, `Fix: Codex install failed on ${m.name}`);
    assert.equal(
      await firstMessage(started.sessionId),
      `Orbit tried to install Codex on this machine (${m.name}, Linux) by running \`npm install -g @openai/codex\`, ` +
        `and it failed with: "${NPM_MISSING}". Find out why and get Codex installed. Ask me before installing system ` +
        "packages or changing system files. When you're done, re-run Orbit's install for Codex on this machine (the " +
        'runner_engine_install tool) so the machine page shows the result, and tell me what `codex --version` reports.',
    );
    // A separate warning from the engine update one: both can be at work at once, each once.
    assert.deepEqual((await runners.getRunner(m.ownerId, m.runnerId)).agentFix?.fixing.map((f) => [f.kind, f.engine]), [['installFailed', 'codex']]);
    await assert.rejects(controller.fix(m.user, m.runnerId, 'installFailed', { engine: 'codex' }), refusedWith('AGENT_FIX_RUNNING'));
    // Another engine's install never failed here: nothing to fix.
    await assert.rejects(
      controller.fix(m.user, m.runnerId, 'installFailed', { engine: 'kimi' }),
      refusedWith('AGENT_FIX_NO_WARNING', 'This machine no longer reports that warning.'),
    );
  });

  await t.test('(6) the runner\'s own update, from its self-update report', async () => {
    const m = await machine('selfupdate', {
      version: '0.1.250',
      selfUpdate: { state: 'disabledByEnv', reason: 'ORBIT_NO_SELFUPDATE is set' } as Prisma.InputJsonValue,
    });
    await usedAt(m, await workspace(m, 'orbit-dev'), new Date());
    const started = await controller.fix(m.user, m.runnerId, 'cannotSelfUpdate', { latest: '0.1.256' });
    assert.equal(started.title, `Fix: Orbit runner updates are turned off on ${m.name}`);
    const prompt = await firstMessage(started.sessionId);
    assert.ok(
      prompt.startsWith(`Orbit's runner on this machine (${m.name}) is on 0.1.250, behind 0.1.256, and its updates are turned off: "ORBIT_NO_SELFUPDATE is set".`),
      prompt,
    );
    assert.ok(prompt.includes('tell me what `orbit --version` reports.'), prompt);
  });

  await t.test('(7) refusals carry the line the clients show, and write nothing', async () => {
    // Offline.
    const offline = await machine('offline', { status: RunnerStatus.OFFLINE, lastHeartbeatAt: new Date(Date.now() - 3_600_000) });
    await usedAt(offline, await workspace(offline, 'orbit-dev'), new Date());
    assert.deepEqual((await runners.getRunner(offline.ownerId, offline.runnerId)).agentFix?.blocked, {
      code: 'offline', message: 'This machine is offline.',
    });
    await assert.rejects(
      controller.fix(offline.user, offline.runnerId, 'engineNotUpdating', { engine: 'codex' }),
      refusedWith('AGENT_FIX_BLOCKED', 'This machine is offline.'),
    );
    // No workspace; one deleted or turned off does not count.
    const bare = await machine('bare');
    await workspace(bare, 'gone', { deletedAt: new Date() });
    await workspace(bare, 'off', { enabled: false });
    assert.deepEqual((await runners.getRunner(bare.ownerId, bare.runnerId)).agentFix?.blocked, {
      code: 'noWorkspace', message: 'No workspace runs on this machine yet.',
    });
    await assert.rejects(
      controller.fix(bare.user, bare.runnerId, 'engineNotUpdating', { engine: 'codex' }),
      refusedWith('AGENT_FIX_BLOCKED', 'No workspace runs on this machine yet.'),
    );
    // The workspace's engine signed out there: no other engine is tried.
    const signedOut = await machine('signedout', { engines: engines('no') as unknown as Prisma.InputJsonValue });
    await usedAt(signedOut, await workspace(signedOut, 'orbit-dev'), new Date());
    const line = "An agent can't run here: orbit-dev uses Claude Code, which is signed out on this machine.";
    assert.deepEqual((await runners.getRunner(signedOut.ownerId, signedOut.runnerId)).agentFix?.blocked, { code: 'engineSignedOut', message: line });
    await assert.rejects(
      controller.fix(signedOut.user, signedOut.runnerId, 'engineNotUpdating', { engine: 'codex' }),
      refusedWith('AGENT_FIX_BLOCKED', line),
    );
    for (const m of [offline, bare, signedOut]) {
      assert.equal(await stored(m.runnerId), null);
      assert.equal((await fixSessions(m)).length, 0);
    }
    // A warning the runner does not report: Claude Code is up to date here.
    const current = await machine('current');
    await usedAt(current, await workspace(current, 'orbit-dev'), new Date());
    await assert.rejects(
      controller.fix(current.user, current.runnerId, 'engineNotUpdating', { engine: 'claude' }),
      refusedWith('AGENT_FIX_NO_WARNING'),
    );
    assert.equal(await stored(current.runnerId), null);
    // Somebody else's runner, an unknown warning, a missing engine.
    const stranger = await machine('stranger');
    await assert.rejects(controller.fix(stranger.user, current.runnerId, 'engineNotUpdating', { engine: 'codex' }), NotFoundException);
    assert.throws(() => controller.fix(current.user, current.runnerId, 'offline', {}), BadRequestException);
    await assert.rejects(controller.fix(current.user, current.runnerId, 'installFailed', {}), BadRequestException);
  });
});
