/**
 * AN APPROVAL RAISED OUTSIDE A DISPATCHED TURN RINGS AND IS COUNTED, OVER A REAL POSTGRESQL
 * (docs/session-three-state-design.md §11.3 item 2, docs/session-three-state-plan.md step 1.2).
 *
 * A session's `status` moves only when a turn is dispatched and when it completes, so a card raised by a runner-hosted
 * background job, or during a turn the engine started for itself, sits on a session whose status is AWAITING_INPUT.
 * `notifyApprovalRequest` and `needsYouSessions` used to read the status (or a running SubAgent) alone, so such a card
 * was live and nobody was told.
 *
 *   1. A card a live background job raised, on an AWAITING_INPUT session: an alert, and the session needs you.
 *   2. A card raised during the engine's own turn, on an AWAITING_INPUT session: an alert, and the session needs you.
 *   3. A card whose background job has ended (no longer in the session's sets): no alert, not counted — the card is
 *      one `reapApprovalsOfEndedTurns` collects as abandoned.
 *   4. A plain card on an AWAITING_INPUT session with nothing executing: no alert, not counted, as before.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/push/approval-outside-turn.pg.spec.ts
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to the rows it made.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import type { ConfigService } from '@nestjs/config';
import { RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { PushService } from './push.service';

const URL_ = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);

const CONFIG = {
  get: (key: string) => ({ APNS_KEY_ID: 'outside-turn', APNS_TEAM_ID: 'outside-turn', APNS_KEY: Buffer.from('unused').toString('base64') })[key],
} as unknown as ConfigService;

test('an approval raised outside a dispatched turn alerts the owner and is counted in needs-you', {
  skip: !URL_, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL_!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db = prismaClientFor(url);
  const push = new PushService(db as unknown as PrismaService, CONFIG);
  const sent: Array<{ kind: string; sessionId?: string }> = [];
  (push as unknown as { deliver: (tokens: unknown[], body: string) => Promise<number> }).deliver = async (tokens, body) => {
    const payload = JSON.parse(body) as { kind: string; sessionID?: string };
    sent.push({ kind: payload.kind, sessionId: payload.sessionID });
    return tokens.length;
  };
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  const ownerId = randomUUID();
  await db.user.create({ data: { id: ownerId, email: `owner-${RUN}@outside-turn.invalid`, name: 'The owner', passwordHash: 'x' } });
  await db.deviceToken.create({
    data: { userId: ownerId, token: `apns-${RUN}`, platform: 'ios', bundleId: 'io.orbitd.app', environment: 'sandbox' },
  });
  const runnerId = randomUUID();
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `runner-${RUN}`, tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
      capabilities: [], capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
    },
  });
  const workspaceId = randomUUID();
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: `workspace-${RUN}`, enabled: true } });

  /** A conversation whose last dispatched turn has completed: stored status AWAITING_INPUT. */
  const session = async (label: string, over: { engineTurnActive?: boolean; runningBgShells?: string[]; runningBgJobs?: string[] } = {}) => {
    const id = randomUUID();
    await db.session.create({
      data: {
        id, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId, title: label, prompt: 'the work',
        provider: 'claude', turnState: null, dispatchOrigin: SessionDispatchOrigin.USER,
        startedAt: new Date(), runtimeSessionId: randomUUID(), ...over,
      },
    });
    return id;
  };
  const ask = async (sessionId: string, backgroundJobId: string | null = null) =>
    (await db.approval.create({
      data: { sessionId, toolName: 'Bash', input: { command: 'true' }, toolUseId: `tu-${randomUUID()}`, backgroundJobId },
      select: { id: true },
    })).id;
  const alertsFor = (sessionId: string) => sent.filter((s) => s.kind === 'approval' && s.sessionId === sessionId).length;

  await t.test('(1) a live background job\'s card on an AWAITING_INPUT session alerts and needs you', async () => {
    const job = `bgj_${randomUUID()}`;
    const s = await session('a job asking', { runningBgShells: [job], runningBgJobs: [job] });
    const a = await ask(s, job);
    await push.notifyApprovalRequest(s, a, 'Bash');
    assert.equal(alertsFor(s), 1, 'the owner is alerted');
    assert.ok((await push.needsYouSessions(ownerId)).includes(s), 'the session is in needs-you');
  });

  await t.test('(2) a card raised in the engine\'s own turn on an AWAITING_INPUT session alerts and needs you', async () => {
    const s = await session('a self-started turn asking', { engineTurnActive: true });
    const a = await ask(s);
    await push.notifyApprovalRequest(s, a, 'Bash');
    assert.equal(alertsFor(s), 1, 'the owner is alerted');
    assert.ok((await push.needsYouSessions(ownerId)).includes(s), 'the session is in needs-you');
  });

  await t.test('(3) a card whose background job has ended is neither alerted nor counted', async () => {
    const other = `bgj_${randomUUID()}`;
    // Another job is still up, so the session is executing: only the card's own job decides it.
    const s = await session('a job that ended', { runningBgShells: [other], runningBgJobs: [other], engineTurnActive: true });
    const a = await ask(s, `bgj_${randomUUID()}`);
    await push.notifyApprovalRequest(s, a, 'Bash');
    assert.equal(alertsFor(s), 0, 'no alert for a card nobody reads any more');
    assert.ok(!(await push.needsYouSessions(ownerId)).includes(s), 'not in needs-you');
  });

  await t.test('(4) a plain card on an idle AWAITING_INPUT session is neither alerted nor counted, as before', async () => {
    const s = await session('idle');
    const a = await ask(s);
    await push.notifyApprovalRequest(s, a, 'Bash');
    assert.equal(alertsFor(s), 0);
    assert.ok(!(await push.needsYouSessions(ownerId)).includes(s));
  });
});
