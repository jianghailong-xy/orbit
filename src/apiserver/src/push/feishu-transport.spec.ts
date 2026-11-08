/**
 * The Feishu channel of PushService (docs/feishu-bot-design.md §6.1–§6.3; task F1-4), without a database: every kind of
 * §6.1 reaches the owner's Feishu app as the card the renderer draws for it, on PushService's own decisions, with no
 * device registered and no APNs or FCM configured; and FeishuTransport's bounded retries. The two-apiserver merge of one
 * stretch's approvals is feishu-alerts.pg.spec.ts's.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { ConfigService } from '@nestjs/config';
import { RunStatus } from '@prisma/client';
import { renderFeishuCard, type FeishuAlert, type FeishuCard } from '../feishu/cards/feishu-cards';
import type { FeishuSendResult } from '../feishu/feishu-outbound';
import {
  approvalOutcome,
  FEISHU_ALERT_ATTEMPTS,
  FeishuTransport,
  ownerItemOutcome,
  type FeishuCardSpec,
  type FeishuTarget,
} from './feishu-transport';
import { renderRawQuery } from '../test-support/prisma-transaction-double';
import { PushService } from './push.service';

/** Neither APNs nor FCM: Feishu is the only channel. */
const NO_DEVICES = { get: () => undefined } as unknown as ConfigService;

const OWNER = randomUUID();
const TARGET: FeishuTarget = {
  ownerId: OWNER,
  appId: 'cli_unit',
  credentials: { platform: 'FEISHU', appId: 'cli_unit', appSecret: 'not-a-secret' },
  openId: 'ou_owner',
  detail: 'TITLES_ONLY',
  approvalsInFeishu: true,
};

interface Posted { spec: FeishuCardSpec; alert: FeishuAlert | null; card: FeishuCard | null }

/** A FeishuTransport that records each card PushService hands it, drawn as it would be drawn. */
function fakeFeishu(prisma: unknown, target: FeishuTarget | null = TARGET) {
  const posted: Posted[] = [];
  const joined: { sessionId: string; approvalId: string }[] = [];
  const transport = {
    target: async () => target,
    post: async (t: FeishuTarget, spec: FeishuCardSpec) => {
      const alert = await spec.render();
      posted.push({ spec, alert, card: alert ? renderFeishuCard(alert, { detail: t.detail, approvalsInFeishu: t.approvalsInFeishu, openUrl: spec.openUrl }) : null });
      return alert !== null;
    },
    joinApprovalStretch: async (_t: FeishuTarget, sessionId: string, approvalId: string) => {
      joined.push({ sessionId, approvalId });
    },
    approvalCard: (t: FeishuTarget, sessionId: string, first: string | null) =>
      FeishuTransport.prototype.approvalCard.call({ prisma } as unknown as FeishuTransport, t, sessionId, first),
  };
  return { transport: transport as unknown as FeishuTransport, posted, joined };
}

const texts = (card: FeishuCard | null): string => JSON.stringify(card);

test('an approval reaches Feishu with no device: one card for the stretch, its approvals listed with their buttons', async () => {
  const sessionId = randomUUID();
  const first = randomUUID();
  const second = randomUUID();
  let claims = 0;
  const prisma = {
    session: {
      findFirst: async () => ({ title: 'Fix the build', ownerId: OWNER }),
      findMany: async () => [{ id: sessionId }],
    },
    projectOpenItem: { findMany: async () => [] },
    $queryRaw: async () => [],
    approval: {
      findMany: async () => [
        { id: first, toolName: 'Bash', input: { command: 'rm -rf build' } },
        { id: second, toolName: 'Write', input: { file_path: '/tmp/x' } },
      ],
    },
  };
  const { transport, posted, joined } = fakeFeishu(prisma);
  const push = new PushService(prisma as never, NO_DEVICES, transport);
  // The session row's edge, as claimApprovalAlert decides it: the first approval of the stretch claims it.
  (push as unknown as { claimApprovalAlert: () => Promise<boolean> }).claimApprovalAlert = async () => ++claims === 1;

  await push.notifyApprovalRequest(sessionId, first, 'Bash');

  await push.feishuIdle();
  await push.notifyApprovalRequest(sessionId, second, 'Write');
  await push.feishuIdle();

  assert.equal(posted.length, 1, 'one card for the stretch');
  assert.equal(posted[0].spec.collapseKey, `approval-${first}`);
  assert.equal(posted[0].spec.kind, 'approval');
  assert.equal(posted[0].spec.approvalId, first);
  assert.deepEqual(joined, [{ sessionId, approvalId: second }], 'the second joins the card rather than sending one');
  const card = texts(posted[0].card);
  assert.match(card, /Fix the build/);
  assert.match(card, /2 approvals need your reply/);
  assert.match(card, /Needs your reply · Bash/);
  assert.match(card, /Needs your reply · Write/);
  assert.equal((card.match(/approval\.allow/g) ?? []).length, 2, 'each approval its own Allow once');
  assert.doesNotMatch(card, /rm -rf build/, 'TITLES_ONLY: no tool input');
});

test('a settlement reaches Feishu: Finished / Failed, one card per settlement, and the account\'s switch is honoured', async () => {
  for (const [status, kind, word] of [[RunStatus.SUCCEEDED, 'finished', 'Finished'], [RunStatus.FAILED, 'failed', 'Failed']] as const) {
    const sessionId = randomUUID();
    let prefs: Record<string, unknown> = {};
    const prisma: { session: { findUnique: () => Promise<unknown> }; conversationTurn: unknown } = {
      session: {
        findUnique: async () => ({
          title: 'Ship the release', ownerId: OWNER, status, retryAt: null, completedAt: null, deletedAt: null,
          error: 'provider error: overloaded', recapText: 'Tagged v1.2.3', owner: { preferences: prefs },
        }),
      },
      conversationTurn: { findFirst: async () => ({ seq: 7 }) },
    };
    const { transport, posted } = fakeFeishu(prisma);
    const push = new PushService(prisma as never, NO_DEVICES, transport);
    await push.notifySessionSettled(sessionId);
    await push.feishuIdle();
    assert.equal(posted.length, 1, kind);
    assert.equal(posted[0].spec.kind, kind);
    assert.equal(posted[0].spec.collapseKey, `settled-${sessionId}-7`);
    assert.equal(posted[0].spec.sessionId, sessionId);
    const card = texts(posted[0].card);
    assert.match(card, /Ship the release/);
    assert.match(card, new RegExp(`"subtitle":\\{"tag":"plain_text","content":"${word}"`));
    assert.doesNotMatch(card, /Tagged v1\.2\.3/, 'TITLES_ONLY: no recap');

    prefs = { notifySessionFinished: false };
    prisma.session.findUnique = async () => ({
      title: 'Ship the release', ownerId: OWNER, status, retryAt: null, completedAt: null, deletedAt: null,
      error: null, recapText: null, owner: { preferences: prefs },
    });
    await push.notifySessionSettled(sessionId);
    await push.feishuIdle();
    assert.equal(posted.length, 1, 'notifySessionFinished off: no card either');
  }
});

test('an agent message reaches Feishu with no device, and is answered delivered', async () => {
  const sessionId = randomUUID();
  let prefs: Record<string, unknown> = {};
  const prisma = {
    session: {
      findFirst: async () => ({ title: 'Migrate the data', agentNotifiedAt: null }),
      updateMany: async () => ({ count: 1 }),
    },
    user: { findUnique: async () => ({ preferences: prefs, agentNotifiedAt: null }) },
  };
  const { transport, posted } = fakeFeishu(prisma);
  const push = new PushService(prisma as never, NO_DEVICES, transport);
  const result = await push.notifyAgentMessage({ ownerId: OWNER, sessionId, fallbackTitle: 'runner', message: 'Need the staging password' });
  assert.deepEqual(result, { delivered: true, devices: 0, feishu: true });
  assert.equal(posted[0].spec.kind, 'agent-message');
  assert.equal(posted[0].spec.sessionId, sessionId);
  const card = texts(posted[0].card);
  assert.match(card, /Migrate the data/);
  assert.match(card, /The agent sent you a message/);
  assert.doesNotMatch(card, /staging password/, 'TITLES_ONLY: not the agent\'s words');

  prefs = { notifyAgentMessage: false };
  const off = await push.notifyAgentMessage({ ownerId: OWNER, sessionId, fallbackTitle: 'runner', message: 'again' });
  assert.equal(off.delivered, false);
  assert.equal(posted.length, 1, 'notifyAgentMessage off: no card either');
});

test('an agent message with nowhere to go says whose answer it is: the server\'s without device push, the account\'s with it', async () => {
  const APNS = { get: (key: string) => ({ APNS_KEY_ID: 'key-id', APNS_TEAM_ID: 'team-id', APNS_KEY: Buffer.from('k').toString('base64') } as Record<string, string>)[key] } as unknown as ConfigService;
  const prisma = {
    session: {
      findFirst: async () => ({ title: 'Migrate the data', agentNotifiedAt: null }),
      updateMany: async () => ({ count: 1 }),
    },
    user: { findUnique: async () => ({ preferences: {}, agentNotifiedAt: null }) },
    deviceToken: { findMany: async () => [] },
  };
  const input = { ownerId: OWNER, sessionId: randomUUID(), fallbackTitle: 'runner', message: 'Need the staging password' };

  // Neither APNs nor FCM, and the account has no Feishu target: nothing on this server could reach anyone.
  const bare = new PushService(prisma as never, NO_DEVICES, fakeFeishu(prisma, null).transport);
  assert.deepEqual(await bare.notifyAgentMessage(input), { delivered: false, reason: 'push is not configured on this server' });

  // APNs configured, no device and no Feishu target: registering a device is what is missing.
  const apns = new PushService(prisma as never, APNS, fakeFeishu(prisma, null).transport);
  assert.deepEqual(await apns.notifyAgentMessage(input), { delivered: false, reason: 'no devices are registered for this account' });

  // Neither APNs nor FCM, but the account has a Feishu target: its card goes out.
  const { transport, posted } = fakeFeishu(prisma);
  const carded = new PushService(prisma as never, NO_DEVICES, transport);
  assert.deepEqual(await carded.notifyAgentMessage(input), { delivered: true, devices: 0, feishu: true });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].spec.kind, 'agent-message');
});

test('an owner item reaches Feishu: one card per item, announced again into the same card', async () => {
  const itemId = randomUUID();
  const projectId = randomUUID();
  const coordinator = randomUUID();
  const prisma = {
    projectOpenItem: {
      findUnique: async () => ({
        kind: 'COORDINATOR_QUESTION', state: 'OPEN', assignee: 'OWNER', assigneeReason: 'DEFAULT',
        title: 'Coordinator asks: Take the slower fix?',
        payload: { question: 'Take the slower fix?', options: [], recommendedOption: null, blocksTaskIds: [], ifUnanswered: null },
        waitingSince: new Date('2026-11-07T10:00:00Z'), escalatedAt: null, ownerId: OWNER, projectId, promotionId: null,
        project: { title: 'Integration line', coordinatorSessionId: coordinator },
      }),
    },
    $queryRaw: async () => [],
  };
  const { transport, posted } = fakeFeishu(prisma);
  const push = new PushService(prisma as never, NO_DEVICES, transport);
  await push.notifyOwnerItem(itemId);
  await push.feishuIdle();
  await push.notifyOwnerItem(itemId);
  await push.feishuIdle();
  assert.equal(posted.length, 2);
  assert.deepEqual(posted.map((p) => p.spec.collapseKey), [`owner-item-${itemId}`, `owner-item-${itemId}`], 'one card: the second updates it');
  assert.equal(posted[0].spec.openItemId, itemId);
  const card = texts(posted[0].card);
  assert.match(card, /Integration line/);
  assert.match(card, /The coordinator has a question/);
  assert.doesNotMatch(card, /Take the slower fix/, 'TITLES_ONLY: not the item\'s body');
  assert.doesNotMatch(card, /approval\.allow|approval\.deny/, 'only Open in Orbit');
});

test('every other kind reaches Feishu as its kind in words and its title', async () => {
  const sessionId = randomUUID();
  const runner = { name: 'mac-mini', displayName: 'Mac mini', ownerId: OWNER };
  const prisma = {
    runner: { findUnique: async () => runner },
    taskOwnerConfirmationReviewRecord: {
      findUnique: async () => ({
        kind: 'PROBLEMS', ownerId: OWNER, taskId: randomUUID(), body: { problems: [{}, {}] },
        task: { title: 'Add the receipt' }, review: { request: { sessionId } },
      }),
    },
  };
  const { transport, posted } = fakeFeishu(prisma);
  const push = new PushService(prisma as never, NO_DEVICES, transport);
  await push.notifyEngineSignedOut(randomUUID(), 'claude');
  await push.feishuIdle();
  await push.notifyClaudeRegionBlocked(randomUUID(), 'HK');
  await push.feishuIdle();
  await push.notifyConfirmationProblems(randomUUID());
  await push.feishuIdle();
  await push.notifyWatchMatched({ ownerId: OWNER, watchId: 'w1', generation: 2, reason: 'TASK_DONE' });
  await push.feishuIdle();
  await push.notifyLoopMissed({ ownerId: OWNER, sessionId, title: 'Nightly', missed: { loopId: 'l1', ticks: 2, alertedAt: new Date(0) }, reason: 'RUNNER_OFFLINE' });
  await push.feishuIdle();
  await push.notifyLoopMissed({ ownerId: OWNER, sessionId, title: 'Nightly', missed: { wakeupId: 'k1' }, reason: 'SESSION_FAILED' });
  await push.feishuIdle();
  await push.notifyWikiReviewModeTripped({ ownerId: OWNER, spaceId: 's1', title: 'Docs', rejected: 3, window: 5 });
  await push.feishuIdle();
  await push.notifyWikiVerificationTripped({ ownerId: OWNER, spaceId: 's1', title: 'Docs', unsupported: 3, window: 5 });
  await push.feishuIdle();
  await push.notifyWikiMemoryWritesQuiet({ ownerId: OWNER, spaceId: 's1', title: 'Docs', runs: 4 });
  await push.feishuIdle();
  await push.notifyWikiMaintenanceFailing({ ownerId: OWNER, spaceId: 's1', title: 'Docs', failures: 3, lastError: 'boom' });
  await push.feishuIdle();

  const seen = posted.map((p) => [p.card!.header.title.content, p.card!.header.subtitle.content]);
  assert.deepEqual(seen, [
    ['Mac mini', 'Engine signed out'],
    ['Mac mini', 'Claude is not available on this runner'],
    ['Add the receipt', 'Problems found after you confirmed'],
    ['Watch matched', 'Watch matched'],
    ['Nightly', 'Wakeup loop missed'],
    ['Nightly', 'Scheduled wakeup dropped'],
    ['Wiki switched to Manual', 'Wiki switched to Manual'],
    ['Wiki switched to Tiered', 'Wiki switched to Tiered'],
    ['Wiki maintenance saw no memory writes in 4 runs', 'Wiki maintenance needs attention'],
    ['Wiki maintenance failed 3 times', 'Wiki maintenance needs attention'],
  ]);
  assert.ok(posted.every((p) => p.spec.kind === 'other'));
  // Collapsed as their banners are; the one-off ones each a card of their own.
  assert.equal(posted[3].spec.collapseKey, 'watch-w1-2');
  assert.equal(posted[4].spec.collapseKey, 'loop-l1-0');
  assert.equal(posted[5].spec.collapseKey, 'wakeup-k1');
  assert.equal(new Set(posted.map((p) => p.spec.collapseKey)).size, posted.length);
  assert.ok(posted.every((p) => !texts(p.card).includes('boom')), 'TITLES_ONLY: not the body');
});

test('no Feishu target and no device: nothing is drawn, as before', async () => {
  const prisma = { runner: { findUnique: async () => ({ name: 'r', displayName: null, ownerId: OWNER }) } };
  const { transport, posted } = fakeFeishu(prisma, null);
  const push = new PushService(prisma as never, NO_DEVICES, transport);
  await push.notifyEngineSignedOut(randomUUID(), 'codex');
  await push.feishuIdle();
  assert.equal(posted.length, 0);
});

// ── FeishuTransport: a bounded number of attempts, then given up on (§6.3) ─────────────────────────────────────────

/** A FeishuTransport over a database of one feishu_message row, kept in memory, and an outbound that answers `answers`. */
function transportWith(answers: FeishuSendResult[]) {
  const row = { id: randomUUID(), revision: 0, rendered: 0, messageId: null as string | null, leased: false, lastError: null as string | null, attempts: 0 };
  const appErrors: string[] = [];
  const prisma = {
    $queryRaw: async (...args: unknown[]) => {
      const sql = renderRawQuery(args).text;
      if (sql.includes('INSERT INTO "feishu_message"')) {
        row.revision += 1;
        return [{ id: row.id }];
      }
      if (sql.includes('SET "lease_token"')) {
        if (row.leased || row.rendered === row.revision) return [];
        row.leased = true;
        return [{ revision: row.revision, message_id: row.messageId }];
      }
      throw new Error(`unexpected query ${sql}`);
    },
    $executeRaw: async (...args: unknown[]) => {
      const { text: sql, values } = renderRawQuery(args);
      row.rendered = values[0] as number;
      row.leased = false;
      if (sql.includes('"message_id" =')) {
        row.messageId = values[1] as string | null;
        row.attempts += values[4] as number;
        row.lastError = values[5] as string | null;
      }
      return 1;
    },
    feishuMessage: { findUnique: async () => ({ messageId: row.messageId, leaseUntil: null }) },
    feishuApp: { updateMany: async (args: { data: { lastError: string } }) => { appErrors.push(args.data.lastError); return { count: 1 }; } },
  };
  const calls: string[] = [];
  const outbound = {
    send: async () => { calls.push('send'); return answers.shift() ?? { ok: true, messageId: 'om_1' }; },
    updateCard: async () => { calls.push('update'); return answers.shift() ?? { ok: true, messageId: null }; },
  };
  const transport = new FeishuTransport(prisma as never, {} as never, outbound as never);
  const waits: number[] = [];
  transport.wait = async (ms) => { waits.push(ms); };
  const spec: FeishuCardSpec = {
    collapseKey: 'k', kind: 'other', openUrl: 'https://orbit.example/',
    render: async () => ({ kind: 'other', eventKind: 'Watch matched', title: 'Watch matched', body: '' }),
  };
  return { transport, row, calls, waits, appErrors, spec };
}

const down: FeishuSendResult = { ok: false, status: 500, feishuCode: null, feishuMsg: 'internal error' };

test('a card Feishu failed on is tried again, and sent', async () => {
  const t = transportWith([down, down]);
  assert.equal(await t.transport.post(TARGET, t.spec), true);
  assert.deepEqual(t.calls, ['send', 'send', 'send']);
  assert.equal(t.waits.length, 2);
  assert.ok(t.waits[1] > t.waits[0], 'backing off');
  assert.equal(t.row.messageId, 'om_1');
  assert.equal(t.row.attempts, 3);
  assert.equal(t.row.lastError, null);
});

test(`a card Feishu keeps failing on is given up on after ${FEISHU_ALERT_ATTEMPTS} attempts, the reason kept`, async () => {
  const t = transportWith([down, down, down, down]);
  assert.equal(await t.transport.post(TARGET, t.spec), false);
  assert.equal(t.calls.length, FEISHU_ALERT_ATTEMPTS);
  assert.equal(t.row.messageId, null);
  assert.equal(t.row.lastError, 'Feishu error 500: internal error');
  assert.deepEqual(t.appErrors, ['Feishu error 500: internal error'], 'and on the app, for the settings page');
});

test('a card Feishu refused is not tried again', async () => {
  const t = transportWith([{ ok: false, status: 400, feishuCode: 230013, feishuMsg: 'Bot has NO availability to this user.' }]);
  assert.equal(await t.transport.post(TARGET, t.spec), false);
  assert.deepEqual(t.calls, ['send']);
  assert.equal(t.row.lastError, 'Feishu error 230013: Bot has NO availability to this user.');
});

test('a card announced again is updated in place, not sent a second time', async () => {
  const t = transportWith([]);
  assert.equal(await t.transport.post(TARGET, t.spec), true);
  assert.equal(await t.transport.post(TARGET, t.spec), true);
  assert.deepEqual(t.calls, ['send', 'update']);
});

test('a transport that throws costs the devices nothing', async () => {
  const sessionId = randomUUID();
  const sent: string[] = [];
  const prisma = {
    session: { findUnique: async () => ({ title: 'T', ownerId: OWNER, status: RunStatus.SUCCEEDED, retryAt: null, completedAt: null, deletedAt: null, error: null, recapText: null, owner: { preferences: {} } }) },
    conversationTurn: { findFirst: async () => { throw new Error('database gone'); } },
    deviceToken: { findMany: async () => [{ id: 'd', token: 'device', platform: 'ios', bundleId: 'io.orbitd.app', environment: 'sandbox', loginSessionId: null }] },
  };
  const config = { get: (key: string) => ({ APNS_KEY_ID: 'k', APNS_TEAM_ID: 't', APNS_KEY: Buffer.from('x').toString('base64') })[key] } as unknown as ConfigService;
  const { transport } = fakeFeishu(prisma);
  const push = new PushService(prisma as never, config, transport);
  (push as unknown as { deliver: (t: unknown, body: string) => Promise<number> }).deliver = async (_t, body) => { sent.push(body); return 1; };
  await push.notifySessionSettled(sessionId);
  await push.feishuIdle();
  assert.equal(sent.length, 1, 'the banner went out');
});

test('an alert whose caller awaits it is not held by Feishu: the devices are, Feishu is not', async () => {
  const sent: string[] = [];
  const prisma = {
    deviceToken: { findMany: async () => [{ id: 'd', token: 'device', platform: 'ios', bundleId: 'io.orbitd.app', environment: 'sandbox', loginSessionId: null }] },
  };
  const config = { get: (key: string) => ({ APNS_KEY_ID: 'k', APNS_TEAM_ID: 't', APNS_KEY: Buffer.from('x').toString('base64') })[key] } as unknown as ConfigService;
  // An outbound that never answers, as Feishu does in an outage until every attempt has timed out.
  let started = 0;
  const never = new Promise<FeishuSendResult>(() => undefined);
  const transport = {
    target: async () => TARGET,
    post: async () => { started += 1; await never; return true; },
  } as unknown as FeishuTransport;
  const push = new PushService(prisma as never, config, transport);
  (push as unknown as { deliver: (t: unknown, body: string) => Promise<number> }).deliver = async (_t, body) => { sent.push(body); return 1; };
  const outcome = await Promise.race([
    push.notifyWatchMatched({ ownerId: OWNER, watchId: 'w', generation: 1, reason: 'TASK_DONE' }).then(() => 'resolved'),
    new Promise((resolve) => setTimeout(() => resolve('held'), 1_000)),
  ]);
  assert.equal(outcome, 'resolved', 'the watch delivery drain is not held by Feishu');
  assert.equal(sent.length, 1, 'the device was alerted');
  assert.equal(started, 1, 'and the Feishu card was started');
});

// ── F1-5: a card whose matter was settled elsewhere (§6.2) ───────────────────────────────────────────────────────────

test('an approval card says how its approvals were settled, at the time they were (UTC)', () => {
  const now = new Date('2026-11-08T12:00:00Z');
  const at = new Date('2026-11-08T10:32:10Z');
  const later = new Date('2026-11-08T10:40:00Z');
  assert.equal(approvalOutcome([{ toolName: 'Bash', status: 'ALLOWED', decidedAt: at }], now), 'Allowed in Orbit · 10:32 UTC');
  assert.equal(approvalOutcome([
    { toolName: 'Bash', status: 'DENIED', decidedAt: at }, { toolName: 'Edit', status: 'DENIED', decidedAt: later },
  ], now), 'Denied in Orbit · 10:40 UTC', 'the last answer');
  assert.equal(approvalOutcome([
    { toolName: 'Bash', status: 'ALLOWED', decidedAt: at }, { toolName: 'Edit', status: 'DENIED', decidedAt: at },
  ], now), 'Answered in Orbit · 10:32 UTC');
  assert.equal(approvalOutcome([{ toolName: 'AskUserQuestion', status: 'ALLOWED', decidedAt: at }], now), 'Answered in Orbit · 10:32 UTC');
  assert.equal(approvalOutcome([{ toolName: 'Bash', status: 'ABANDONED', decidedAt: null }], now), 'No longer waiting in Orbit · 12:00 UTC');
  assert.equal(approvalOutcome([{ toolName: 'Bash', status: 'PENDING', decidedAt: null }], now), 'No longer waiting in Orbit · 12:00 UTC',
    'a session that left needs-you with the approval unanswered');
  assert.equal(ownerItemOutcome({ resolution: 'ANSWERED', resolvedAt: at }, now), 'Answered in Orbit · 10:32 UTC');
  assert.equal(ownerItemOutcome({ resolution: 'LANDED', resolvedAt: at }, now), 'Resolved in Orbit · 10:32 UTC');
  assert.equal(ownerItemOutcome(null, now), 'No longer waiting in Orbit · 12:00 UTC');
});

test('the badge reconcile runs with Feishu as the only channel, and hands the transport its needs-you', async () => {
  const sessionId = randomUUID();
  const prisma = { deviceToken: { findMany: async () => [] } };
  const calls: { target: FeishuTarget; needsYou: string[] }[] = [];
  const transport = {
    target: async () => TARGET,
    closeSettled: async (target: FeishuTarget, needsYou: ReadonlySet<string>) => {
      calls.push({ target, needsYou: [...needsYou] });
      return { closed: 0, busy: false };
    },
  } as unknown as FeishuTransport;
  const push = new PushService(prisma as never, NO_DEVICES, transport);
  push.needsYouSessions = async () => [sessionId]; // its query is owner-item-badge.pg.spec.ts's
  push.scheduleBadgeSync(OWNER);
  for (let i = 0; i < 50 && calls.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
  await push.feishuIdle();
  assert.equal(calls.length, 1, 'one reconcile, with no APNs or FCM configured');
  assert.equal(calls[0]!.target, TARGET);
  assert.deepEqual(calls[0]!.needsYou, [sessionId]);

  // Without Feishu and without a device transport there is still nothing to reconcile.
  const quiet = new PushService(prisma as never, NO_DEVICES);
  quiet.scheduleBadgeSync(OWNER);
  await new Promise((r) => setTimeout(r, 400));
});
