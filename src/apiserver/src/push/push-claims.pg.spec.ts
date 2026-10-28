/**
 * THE APPROVAL ALERT'S EDGE AND THE AGENT NOTIFICATION LIMIT, HELD ON THE ROWS, OVER A REAL POSTGRESQL.
 *
 * Both used to be kept in each apiserver's memory (PushService.badgeState, lastAgentNotify), so with several apiservers
 * on one database each rang on its own: the approvals of one turn that reached two apiservers rang the phone twice, an
 * apiserver that had rung for an earlier stretch did not ring for the next one, and an agent's once-a-minute limit was
 * once a minute per apiserver. Here each apiserver is a PushService of its own over a connection pool of its own, which
 * is all of an apiserver these two paths have: everything they keep between calls is now on the session row (and, for
 * a `notify` naming no session, on the account's), which both read.
 *
 *   Approvals (claimApprovalAlert):
 *     1. Four approvals of one turn, notified through two apiservers at once: one alert.
 *     2. The approval asked first commits last: the one decided first rings, the other finds its stretch rung.
 *     3. One asked while another was pending, whose alert is decided after that one was answered: no second ring.
 *     4. Answered through one apiserver (which reconciles its badge, as the one an answer reaches does), the next
 *        approval rings once through the other.
 *     5. One apiserver, as before: a turn's approvals ring once, and the next stretch once again.
 *     6. An approval of another session claims no edge.
 *   The agent notification limit (claimAgentNotify):
 *     7. A ring on one apiserver refuses the same session on the other for the rest of the minute, and only that session.
 *     8. Both at the same moment, five times: one rings each time.
 *     9. A `notify` naming no session: one turn per account, apart from every session's.
 *    10. One apiserver alone, as before.
 *    11. A minute later the other apiserver rings.
 *
 * Cases 5 and 10 are what one apiserver did before, and pass against the code before this change as well. Against
 * that code the others fail: 6 and 11 because it took no approval id and had no column to set, the rest because
 * each apiserver answered from its own memory.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/push/push-claims.pg.spec.ts
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to the rows it made.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import type { ConfigService } from '@nestjs/config';
import { type PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { PushService } from './push.service';

const URL_ = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);

/** APNs configured, so nothing is refused for want of a channel; delivery itself is this file's. */
const CONFIG = {
  get: (key: string) => ({ APNS_KEY_ID: 'push-claims', APNS_TEAM_ID: 'push-claims', APNS_KEY: Buffer.from('unused').toString('base64') })[key],
} as unknown as ConfigService;

interface Sent {
  by: string;
  kind: string;
  sessionId?: string;
}

/** One apiserver's PushService: its own pool on the shared database, its delivery recorded instead of sent. */
function apiserver(url: string, by: string, sent: Sent[]) {
  const db = prismaClientFor(url);
  const push = new PushService(db as unknown as PrismaService, CONFIG);
  (push as unknown as { deliver: (tokens: unknown[], body: string) => Promise<number> }).deliver = async (tokens, body) => {
    const payload = JSON.parse(body) as { kind: string; sessionID?: string };
    sent.push({ by, kind: payload.kind, sessionId: payload.sessionID });
    return tokens.length;
  };
  return { db, push };
}

/**
 * `notifyApprovalRequest(sessionId, approvalId, toolName)`, read through a cast so that this file also compiles against
 * the code before the edge moved to the session row, which took no approval id: that is how the same cases are run
 * against it to show what each apiserver's memory did.
 */
const alert = (server: { push: PushService }, sessionId: string, approvalId: string, tool: string) =>
  (server.push as unknown as { notifyApprovalRequest(...args: string[]): Promise<void> })
    .notifyApprovalRequest(sessionId, approvalId, tool);

test('the approval alert and the agent notification limit hold across two apiservers on one database', {
  skip: !URL_, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL_!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const sent: Sent[] = [];
  const one = apiserver(url, 'one', sent);
  const two = apiserver(url, 'two', sent);
  const db: PrismaClient = one.db;
  t.after(async () => {
    await one.db.$disconnect().catch(() => undefined);
    await two.db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  // ── an owner with one registered iPhone, and the machine their sessions run on ─────────────────────────────────────
  const ownerId = randomUUID();
  await db.user.create({ data: { id: ownerId, email: `owner-${RUN}@push-claims.invalid`, name: 'The owner', passwordHash: 'x' } });
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

  /** A conversation running a turn on that machine, as one whose agent asks for permission is. */
  const session = async (label: string) => {
    const id = randomUUID();
    await db.session.create({
      data: {
        id, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId, title: label, prompt: 'the work',
        provider: 'claude', status: RunStatus.RUNNING, engineTurnActive: true, dispatchOrigin: SessionDispatchOrigin.USER,
        startedAt: new Date(), runtimeSessionId: randomUUID(),
      },
    });
    return id;
  };
  /** An approval the agent asks for, committed as the approvals route commits it. */
  const ask = async (sessionId: string, tool = 'Bash') =>
    (await db.approval.create({
      data: { sessionId, toolName: tool, input: { command: 'true' }, toolUseId: `tu-${randomUUID()}` },
      select: { id: true },
    })).id;
  /**
   * The owner's answer to every pending approval of the session, as the apiserver that took the answer records it: the
   * rows answered, then that apiserver's badge reconciled, which RealtimeService.publish has done on the replica the
   * answer reached (scheduleBadgeSync, debounced there and called straight here).
   */
  const answerOn = async (server: { push: PushService }, sessionId: string) => {
    await sql.query(
      `UPDATE "approval" SET "status" = 'ALLOWED', "decided_at" = now() WHERE "session_id" = $1::uuid AND "status" = 'PENDING'`,
      [sessionId],
    );
    await (server.push as unknown as { reconcileBadge(ownerId: string): Promise<void> }).reconcileBadge(ownerId);
    // Strictly after, so the next approval is asked once the stretch is over and not within its last millisecond.
    await sleep(20);
  };
  const alertsFor = (sessionId: string) => sent.filter((s) => s.kind === 'approval' && s.sessionId === sessionId);
  const ringsOf = (kind: string) => sent.filter((s) => s.kind === kind).length;

  await t.test('(1) four approvals of one turn, notified through two apiservers at once: one alert', async () => {
    const s = await session('parallel tool calls');
    const ids = await Promise.all(['Bash', 'Write', 'Edit', 'Read'].map((tool) => ask(s, tool)));
    // The runner's four calls, spread over the two apiservers as the link gateway spreads them.
    await Promise.all(ids.map((id, i) => alert(i % 2 === 0 ? one : two, s, id, 'Bash')));
    assert.equal(alertsFor(s).length, 1, `one alert between both apiservers: ${JSON.stringify(alertsFor(s))}`);
    const marked = await sql.query(
      `SELECT s."alerted_approval_at" = a."created_at" AS "first"
         FROM "session" s JOIN "approval" a ON a."session_id" = s."id"
        WHERE s."id" = $1::uuid ORDER BY a."created_at", a."id" LIMIT 1`,
      [s],
    );
    assert.equal(marked.rows[0].first, true, 'the mark is the first approval of the stretch');
  });

  await t.test('(2) the approval asked first commits last: the one decided first rings, the other finds its stretch rung', async () => {
    const s = await session('a slow commit');
    // The first approval, asked a second earlier, is still inside its transaction on another connection.
    const side = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    await side.connect();
    const first = randomUUID();
    try {
      await side.query('BEGIN');
      await side.query(
        `INSERT INTO "approval" ("id", "session_id", "tool_name", "input", "created_at")
         VALUES ($1::uuid, $2::uuid, 'Bash', '{}', now() - interval '1 second')`,
        [first, s],
      );
      const second = await ask(s, 'Write');
      await alert(two, s, second, 'Write');
      assert.equal(alertsFor(s).length, 1, 'the approval decided first rings: the other is not there to see');
      await side.query('COMMIT');
    } finally {
      await side.end().catch(() => undefined);
    }
    await alert(one, s, first, 'Bash');
    assert.equal(alertsFor(s).length, 1, 'the first approval of the stretch finds the stretch already rung');
  });

  await t.test('(3) asked while another was pending, its alert decided after that one was answered: no second ring', async () => {
    const s = await session('one stretch');
    const a1 = await ask(s);
    await alert(one, s, a1, 'Bash');
    assert.equal(alertsFor(s).length, 1);
    const a2 = await ask(s, 'Write');
    await sleep(20);
    await sql.query(`UPDATE "approval" SET "status" = 'ALLOWED', "decided_at" = now() WHERE "id" = $1::uuid`, [a1]);
    await alert(two, s, a2, 'Write');
    assert.equal(alertsFor(s).length, 1, 'the session never stopped needing a reply: no new edge');
  });

  await t.test('(4) answered through one apiserver, the next approval rings once through the other', async () => {
    const s = await session('two stretches');
    // A turn whose approvals reached both apiservers (case 1 counts its alerts).
    const a1 = await ask(s);
    const a2 = await ask(s, 'Write');
    await alert(one, s, a1, 'Bash');
    await alert(two, s, a2, 'Write');
    await answerOn(one, s);
    const before = alertsFor(s).length;
    const a3 = await ask(s, 'Edit');
    await alert(two, s, a3, 'Edit');
    assert.equal(alertsFor(s).length - before, 1, 'the next stretch rings on the apiserver that had seen the last one');
    const a4 = await ask(s, 'Read');
    await alert(one, s, a4, 'Read');
    assert.equal(alertsFor(s).length - before, 1, 'and once');
  });

  await t.test('(5) one apiserver, as before: a turn\'s approvals ring once, and the next stretch once again', async () => {
    const s = await session('one apiserver');
    for (const tool of ['Bash', 'Write', 'Edit']) await alert(one, s, await ask(s, tool), tool);
    assert.equal(alertsFor(s).length, 1);
    await answerOn(one, s);
    for (const tool of ['Bash', 'Write']) await alert(one, s, await ask(s, tool), tool);
    assert.equal(alertsFor(s).length, 2);
  });

  await t.test('(6) an approval of another session claims no edge here', async () => {
    const theirs = await ask(await session('another session'));
    const mine = await session('this session');
    await ask(mine);
    await alert(one, mine, theirs, 'Bash');
    assert.equal(alertsFor(mine).length, 0);
  });

  // ── the agent notification limit ──────────────────────────────────────────────────────────────────────────────────
  const notify = (server: { push: PushService }, sessionId?: string) =>
    server.push.notifyAgentMessage({ ownerId, sessionId, fallbackTitle: `runner-${RUN}`, message: 'Need the staging password' });

  await t.test('(7) a ring on one apiserver refuses the same session on the other for the rest of the minute', async () => {
    const s = await session('an agent that asks');
    const before = ringsOf('agent-message');
    assert.deepEqual(await notify(one, s), { delivered: true, devices: 1 });
    const refused = await notify(two, s);
    assert.equal(refused.delivered, false);
    assert.match(refused.reason ?? '', /^rate limited — try again in (59|60)s$/);
    const kept = await sql.query(`SELECT "agent_notified_at" IS NOT NULL AS "kept" FROM "session" WHERE "id" = $1::uuid`, [s]);
    assert.equal(kept.rows[0].kept, true, 'kept on the session row');
    const another = await session('another agent');
    assert.deepEqual(await notify(two, another), { delivered: true, devices: 1 }, 'another session is not held by it');
    assert.equal(ringsOf('agent-message') - before, 2);
  });

  await t.test('(8) both apiservers at the same moment, five times: one rings each time', async () => {
    for (let round = 0; round < 5; round += 1) {
      const s = await session(`a race ${round}`);
      const results = await Promise.all([notify(one, s), notify(two, s)]);
      assert.equal(results.filter((r) => r.delivered).length, 1, `round ${round}: ${JSON.stringify(results)}`);
      assert.match(results.find((r) => !r.delivered)?.reason ?? '', /^rate limited — try again in \d+s$/);
    }
  });

  await t.test('(9) a notify naming no session: one turn per account, apart from every session\'s', async () => {
    assert.deepEqual(await notify(one), { delivered: true, devices: 1 });
    const refused = await notify(two);
    assert.equal(refused.delivered, false);
    assert.match(refused.reason ?? '', /^rate limited/);
    const kept = await sql.query(`SELECT "agent_notified_at" IS NOT NULL AS "kept" FROM "user" WHERE "id" = $1::uuid`, [ownerId]);
    assert.equal(kept.rows[0].kept, true, 'kept on the account row');
    assert.equal((await notify(two, await session('a session meanwhile'))).delivered, true);
  });

  await t.test('(10) one apiserver alone, as before: the same session again within the minute is refused', async () => {
    const alone = await session('one apiserver');
    assert.equal((await notify(one, alone)).delivered, true);
    const again = await notify(one, alone);
    assert.equal(again.delivered, false);
    assert.match(again.reason ?? '', /^rate limited — try again in (59|60)s$/);
  });

  await t.test('(11) a minute later the other apiserver rings', async () => {
    const s = await session('a minute later');
    assert.equal((await notify(one, s)).delivered, true);
    await sql.query(`UPDATE "session" SET "agent_notified_at" = "agent_notified_at" - interval '60 seconds' WHERE "id" = $1::uuid`, [s]);
    assert.equal((await notify(two, s)).delivered, true, 'a ring a minute old holds nothing');
  });
});
