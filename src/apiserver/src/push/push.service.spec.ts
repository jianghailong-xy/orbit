import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigService } from '@nestjs/config';
import { RunStatus } from '@prisma/client';
import { PushService } from './push.service';

function enabledConfig(): ConfigService {
  const values: Record<string, string> = {
    APNS_KEY_ID: 'key-id',
    APNS_TEAM_ID: 'team-id',
    APNS_KEY: Buffer.from('test-key').toString('base64'),
  };
  return { get: (key: string) => values[key] } as ConfigService;
}

test('needs-you includes only canonical Open, non-ending sessions', async () => {
  const calls: any[] = [];
  const prisma = {
    session: {
      findMany: async (args: any) => {
        calls.push(args);
        return [{ id: 's-open' }];
      },
    },
    // The owner-item half of the count reads its own rows (see the two tests below); none here.
    projectOpenItem: { findMany: async () => [] },
  };
  const service = new PushService(prisma as any, enabledConfig());

  assert.deepEqual(await service.needsYouSessions('owner-1'), ['s-open']);
  assert.deepEqual(calls[0].where, {
    ownerId: 'owner-1',
    status: RunStatus.RUNNING,
    completedAt: null,
    archivedAt: null,
    deletedAt: null,
    cancelRequestedAt: null,
    approvals: { some: { status: 'PENDING' } },
  });
});

// ── the four in the badge count (§7.6 V13) ─────────────────────────────────
//
// The badge is one of the places the four have to be counted, and it is the one that cannot read
// them off a session summary: it is computed server-side for a phone that is not running the app.

/** The badge's other half: one RUNNING session stopped on a tool call. */
function approvalPrisma() {
  return {
    session: { findMany: async (): Promise<Array<{ id: string }>> => [{ id: 's-blocked' }] },
    // Overridden per test with the rows that half should or should not count.
    projectOpenItem: { findMany: async (): Promise<any[]> => [] },
  };
}

/** One `project_open_item` row, as `readOwnerItemSignals` selects it: which of the four it is is
 *  decided by `ownerItemKind` from exactly these three columns. */
function ownerItemRow(id: string, coordinatorSessionId: string, over: Record<string, unknown> = {}) {
  return {
    id,
    kind: 'COORDINATOR_QUESTION',
    assignee: 'OWNER',
    assigneeReason: 'DEFAULT',
    title: 'Coordinator asks: Take the slower fix?',
    waitingSince: new Date('2026-09-13T10:00:00Z'),
    projectId: 'project-1',
    project: { coordinatorSessionId },
    ...over,
  };
}

test('needs-you counts the coordinator conversation carrying one of the four', async () => {
  const prisma = approvalPrisma();
  const service = new PushService(prisma as any, enabledConfig());
  // A project stopped on a person, in the conversation its card is drawn in. PARKED, which is the
  // normal state of a coordinator waiting for an answer — so the approval query above can never
  // reach it, and this is the half that has to.
  prisma.projectOpenItem.findMany = async () => [ownerItemRow('item-1', 'c-coordinator')];

  assert.deepEqual(await service.needsYouSessions('owner-1'), ['s-blocked', 'c-coordinator']);
});

test('needs-you does not count an item the coordinator is still working on', async () => {
  const prisma = approvalPrisma();
  const service = new PushService(prisma as any, enabledConfig());
  // Owner-assigned rows that are NOT one of the four: the ownerItemKind predicate rejects them, so
  // pushing or badging them would interrupt somebody about work already being done (decision 10).
  prisma.projectOpenItem.findMany = async () => [
    ownerItemRow('item-2', 'c-coordinator', { kind: 'INTEGRATION_CONFLICT' }),
  ];

  assert.deepEqual(await service.needsYouSessions('owner-1'), ['s-blocked']);
});

test('approval push is suppressed when completion wins the race', async () => {
  let tokenQueries = 0;
  let deliveries = 0;
  const prisma = {
    session: {
      findFirst: async () => ({ title: 'Session', ownerId: 'owner-1' }),
    },
    deviceToken: {
      findMany: async () => {
        tokenQueries += 1;
        return [{ token: 'device', environment: 'sandbox' }];
      },
    },
  };
  const service = new PushService(prisma as any, enabledConfig());
  (service as any).needsYouSessions = async () => [];
  (service as any).deliver = async () => {
    deliveries += 1;
  };

  await service.notifyApprovalRequest('s-completed', 'Bash');

  assert.equal(tokenQueries, 0);
  assert.equal(deliveries, 0);
});

test('a second approval on an already-flagged session does not alert again', async () => {
  const bodies: string[] = [];
  const prisma = {
    session: {
      findFirst: async () => ({ title: 'Session', ownerId: 'owner-1' }),
    },
    deviceToken: {
      findMany: async () => [{ token: 'device', environment: 'sandbox' }],
    },
  };
  const service = new PushService(prisma as any, enabledConfig());
  (service as any).needsYouSessions = async () => ['s-1'];
  // The fixture key isn't a real ES256 key, so signing a provider JWT would throw.
  (service as any).authToken = () => 'auth-token';
  (service as any).deliver = async (_t: unknown, body: string) => {
    bodies.push(body);
  };

  // Parallel tool calls in one turn: an approval apiece, all on the same session.
  await service.notifyApprovalRequest('s-1', 'Bash');
  await service.notifyApprovalRequest('s-1', 'Write');
  await service.notifyApprovalRequest('s-1', 'Edit');

  assert.equal(bodies.length, 1);
  assert.match(bodies[0], /Needs your reply · Bash/);

  // A different session needing you is its own interruption and still alerts.
  (service as any).needsYouSessions = async () => ['s-1', 's-2'];
  await service.notifyApprovalRequest('s-2', 'Bash');
  assert.equal(bodies.length, 2);
  assert.equal(JSON.parse(bodies[1]).aps.badge, 2);
});

function settledSession(over: Record<string, unknown> = {}) {
  return {
    title: 'Fix the login bug',
    ownerId: 'owner-1',
    status: RunStatus.SUCCEEDED,
    retryAt: null,
    completedAt: null,
    deletedAt: null,
    error: null,
    owner: { preferences: {} },
    ...over,
  };
}

function settleHarness(session: Record<string, unknown> | null) {
  const sent: { body: string; collapseId?: string }[] = [];
  const prisma = {
    session: { findUnique: async () => session },
    deviceToken: { findMany: async () => [{ token: 'device', environment: 'sandbox' }] },
  };
  const service = new PushService(prisma as any, enabledConfig());
  (service as any).authToken = () => 'auth-token';
  (service as any).deliver = async (
    _t: unknown,
    body: string,
    _p: unknown,
    _pr: unknown,
    _a: unknown,
    collapseId?: string,
  ) => {
    sent.push({ body, collapseId });
  };
  return { service, sent };
}

test('a settled session alerts its owner, collapsing on the session', async () => {
  const { service, sent } = settleHarness(settledSession());

  await service.notifySessionSettled('s-1');

  assert.equal(sent.length, 1);
  const payload = JSON.parse(sent[0].body);
  assert.equal(payload.aps.alert.title, 'Fix the login bug');
  assert.equal(payload.aps.alert.body, 'Finished');
  assert.equal(payload.aps.category, 'ORBIT_SESSION');
  assert.equal(payload.sessionID, 's-1');
  assert.equal(payload.kind, 'finished');
  // A settled session is not one "needing your reply", so it must not move that count.
  assert.equal(payload.aps.badge, undefined);
  assert.equal(sent[0].collapseId, 'settled-s-1');
});

test('a failure carries its first error line', async () => {
  const { service, sent } = settleHarness(
    settledSession({ status: RunStatus.FAILED, error: 'API Error: 529 overloaded_error' }),
  );

  await service.notifySessionSettled('s-1');

  const payload = JSON.parse(sent[0].body);
  assert.equal(payload.kind, 'failed');
  assert.equal(payload.aps.alert.body, 'Failed · API Error: 529 overloaded_error');
});

test('an ending not worth an interruption sends nothing', async () => {
  const { service, sent } = settleHarness(settledSession({ status: RunStatus.CANCELLED }));
  await service.notifySessionSettled('s-1');
  assert.equal(sent.length, 0);
});

test('the owner can turn settle alerts off', async () => {
  const off = settleHarness(settledSession({ owner: { preferences: { notifySessionFinished: false } } }));
  await off.service.notifySessionSettled('s-1');
  assert.equal(off.sent.length, 0);

  // Absent (and explicit true) means on — the switch only has to be written to opt out.
  const on = settleHarness(settledSession({ owner: { preferences: { notifySessionFinished: true } } }));
  await on.service.notifySessionSettled('s-1');
  assert.equal(on.sent.length, 1);
});

test('a vanished session is not an error', async () => {
  const { service, sent } = settleHarness(null);
  await service.notifySessionSettled('s-gone');
  assert.equal(sent.length, 0);
});

test('approval push initially requires a canonical Open, non-ending RUNNING session', async () => {
  const calls: any[] = [];
  const prisma = {
    session: {
      findFirst: async (args: any) => {
        calls.push(args);
        return null;
      },
    },
  };
  const service = new PushService(prisma as any, enabledConfig());

  await service.notifyApprovalRequest('s-completed', 'Bash');

  assert.deepEqual(calls[0].where, {
    id: 's-completed',
    status: RunStatus.RUNNING,
    completedAt: null,
    archivedAt: null,
    deletedAt: null,
    cancelRequestedAt: null,
  });
});

// ── notifyAgentMessage ─────────────────────────────────────────────────────

/** A PushService whose delivery is captured, wired to one session with one registered device. */
function agentNotifyHarness(opts: {
  session?: Record<string, unknown> | null;
  preferences?: Record<string, unknown>;
  tokens?: { token: string; environment: string }[];
  devices?: number;
} = {}) {
  const sent: string[] = [];
  const prisma = {
    session: { findFirst: async () => (opts.session === undefined ? { title: 'Fix the login bug' } : opts.session) },
    user: { findUnique: async () => ({ preferences: opts.preferences ?? {} }) },
    deviceToken: {
      findMany: async () => opts.tokens ?? [{ token: 'device', environment: 'sandbox' }],
    },
  };
  const service = new PushService(prisma as any, enabledConfig());
  (service as any).authToken = () => 'auth-token';
  (service as any).deliver = async (_t: unknown, body: string) => {
    sent.push(body);
    return opts.devices ?? 1;
  };
  return { service, sent };
}

const agentInput = { ownerId: 'owner-1', sessionId: 's-1', fallbackTitle: 'runner-a', message: 'x' };

test("an agent's message is titled with its session and replyable from the banner", async () => {
  const { service, sent } = agentNotifyHarness();

  const result = await service.notifyAgentMessage({
    ...agentInput,
    message: 'Need the staging DB password to continue',
  });

  assert.deepEqual(result, { delivered: true, devices: 1 });
  const payload = JSON.parse(sent[0]);
  assert.equal(payload.aps.alert.title, 'Fix the login bug');
  assert.equal(payload.aps.alert.body, 'Need the staging DB password to continue');
  // The category the clients register a Reply action on: an agent's question is answerable
  // without opening the app, which is most of the reason to ask this way at all.
  assert.equal(payload.aps.category, 'ORBIT_SESSION');
  assert.equal(payload.sessionID, 's-1');
  assert.equal(payload.kind, 'agent-message');
  // "Needs your reply" is what the badge counts, and an agent talking is not that.
  assert.equal(payload.aps.badge, undefined);
});

test('a headless notify is titled with the runner and routes nowhere', async () => {
  const { service, sent } = agentNotifyHarness();

  const result = await service.notifyAgentMessage({
    ownerId: 'owner-1',
    fallbackTitle: 'runner-a',
    message: 'Nightly backup finished',
  });

  assert.equal(result.delivered, true);
  const payload = JSON.parse(sent[0]);
  assert.equal(payload.aps.alert.title, 'runner-a');
  // No session to reply into, so no category and no route — the clients ignore a payload
  // that names no session, which is exactly right for an alert about the machine.
  assert.equal(payload.aps.category, undefined);
  assert.equal(payload.sessionID, undefined);
});

test('one session cannot ring the same phone twice in a minute', async () => {
  const { service, sent } = agentNotifyHarness();

  assert.equal((await service.notifyAgentMessage(agentInput)).delivered, true);
  const second = await service.notifyAgentMessage(agentInput);

  assert.equal(second.delivered, false);
  assert.match(second.reason ?? '', /rate limited/);
  assert.equal(sent.length, 1);
});

test('a different session is not blocked by another session having just alerted', async () => {
  const { service, sent } = agentNotifyHarness();

  await service.notifyAgentMessage(agentInput);
  const other = await service.notifyAgentMessage({ ...agentInput, sessionId: 's-2' });

  // The limit protects the person from one runaway run, not from having several runs.
  assert.equal(other.delivered, true);
  assert.equal(sent.length, 2);
});

test('the owner can turn agent notifications off on their own', async () => {
  const off = agentNotifyHarness({ preferences: { notifyAgentMessage: false } });
  const refused = await off.service.notifyAgentMessage(agentInput);
  assert.equal(refused.delivered, false);
  assert.equal(off.sent.length, 0);

  // Its own switch: someone who wants Orbit's settle alert does not necessarily want a model
  // deciding to interrupt them, so turning that one off must not turn this one off.
  const on = agentNotifyHarness({ preferences: { notifySessionFinished: false } });
  assert.equal((await on.service.notifyAgentMessage(agentInput)).delivered, true);
});

test('a session belonging to another account is not found', async () => {
  const { service, sent } = agentNotifyHarness({ session: null });

  const result = await service.notifyAgentMessage(agentInput);

  assert.deepEqual(result, { delivered: false, reason: 'session not found' });
  assert.equal(sent.length, 0);
});

test('nothing to deliver to is reported, not swallowed', async () => {
  const { service } = agentNotifyHarness({ tokens: [] });
  const result = await service.notifyAgentMessage(agentInput);
  // The agent has to be able to tell "they were told" from "nobody was told" — otherwise it
  // waits for a reply that was never going to come.
  assert.equal(result.delivered, false);
  assert.match(result.reason ?? '', /no devices/);
});

test('a message APNs accepted for nobody is not reported as delivered', async () => {
  const { service } = agentNotifyHarness({ devices: 0 });
  const result = await service.notifyAgentMessage(agentInput);
  assert.equal(result.delivered, false);
});

test('an over-long message is delivered cut, and says so', async () => {
  const { service, sent } = agentNotifyHarness();

  const result = await service.notifyAgentMessage({ ...agentInput, message: 'y'.repeat(400) });

  assert.equal(result.delivered, true);
  assert.equal(result.truncated, true);
  assert.equal(JSON.parse(sent[0]).aps.alert.body.length, 200);
});

test('an empty message is refused before anything is looked up', async () => {
  const { service, sent } = agentNotifyHarness();
  const result = await service.notifyAgentMessage({ ...agentInput, message: '  \n ' });
  assert.equal(result.delivered, false);
  assert.equal(sent.length, 0);
});

// ── notifyOwnerItem ────────────────────────────────────────────────────────
//
// Contract §7.6 V12: four owner items ring a phone, and an exception the coordinator is still
// working on does not. The cases below are the two that section names, plus the one that keeps the
// five "now yours" headings agreeing with the card the banner opens.

/** One `project_open_item` row, as the push's own select reads it. */
function openItem(over: Record<string, unknown> = {}) {
  return {
    kind: 'COORDINATOR_QUESTION',
    state: 'OPEN',
    assignee: 'OWNER',
    assigneeReason: 'DEFAULT',
    title: 'Coordinator asks: Take the slower fix?',
    payload: {
      question: 'Take the slower fix?',
      options: [],
      recommendedOption: null,
      blocksTaskIds: [],
      ifUnanswered: null,
    },
    waitingSince: new Date('2026-09-13T10:00:00Z'),
    escalatedAt: null,
    ownerId: 'owner-1',
    projectId: 'project-1',
    promotionId: null,
    project: {
      title: 'Integration line',
      coordinatorEnabled: true,
      coordinatorSessionId: 'coordinator',
    },
    ...over,
  };
}

function ownerItemHarness(
  item: Record<string, unknown> | null,
  promotion: Record<string, unknown> | null = null,
) {
  const sent: { body: string; collapseId?: string }[] = [];
  const prisma = {
    projectOpenItem: { findUnique: async () => item },
    projectPromotion: { findUnique: async () => promotion },
    deviceToken: { findMany: async () => [{ token: 'device', environment: 'sandbox' }] },
  };
  const service = new PushService(prisma as any, enabledConfig());
  (service as any).authToken = () => 'auth-token';
  (service as any).deliver = async (
    _t: unknown,
    body: string,
    _p: unknown,
    _pr: unknown,
    _a: unknown,
    collapseId?: string,
  ) => {
    sent.push({ body, collapseId });
  };
  return { service, sent };
}

test('the four owner item kinds push', async () => {
  const cases: Array<{
    what: string;
    item: Record<string, unknown>;
    promotion?: Record<string, unknown>;
    kind: string;
    title: string;
    body: string;
  }> = [
    {
      what: 'a merge waiting to be confirmed',
      item: openItem({ kind: 'PROMOTION_APPROVAL', title: 'Merge 3 tasks into main?', payload: {}, promotionId: 'promotion-1' }),
      promotion: {
        sourceRef: 'refs/heads/orbit/project-integration',
        upstreamRef: 'refs/heads/main',
        includedTaskIds: ['t1', 't2', 't3'],
      },
      kind: 'approve-merge-to-main',
      title: 'Merge orbit/project-integration into main?',
      body: '3 tasks passed checks on the combined tree · Integration line',
    },
    {
      what: 'a question the coordinator asked',
      item: openItem(),
      kind: 'coordinator-question',
      title: 'The coordinator has a question',
      body: 'Take the slower fix? · Integration line',
    },
    {
      what: 'an exception nobody acted on',
      item: openItem({
        kind: 'TASK_FAILED',
        assigneeReason: 'ESCALATED',
        title: 'Task failed: Add the landing receipt',
        payload: {},
        escalatedAt: new Date('2026-09-13T12:00:00Z'),
      }),
      kind: 'escalated-to-you',
      title: 'Now yours — no one acted on this for 2h',
      body: 'Task failed: Add the landing receipt · Integration line',
    },
    {
      what: 'a coordinator that paused itself',
      item: openItem({
        kind: 'FUSE_PAUSED',
        title: 'The coordinator paused itself',
        payload: {
          dimension: 'SELF_STARTED_TURNS',
          observed: 41,
          limit: 40,
          spendToday: { selfStartedTurns: 41, sessionsOpened: 2, successorRetries: 0 },
          heldCount: 1,
        },
      }),
      kind: 'fuse-paused',
      title: 'The coordinator paused itself',
      body: 'It started 41 turns on its own today — the limit is 40 · Integration line',
    },
  ];

  for (const c of cases) {
    const { service, sent } = ownerItemHarness(c.item, c.promotion ?? null);
    await service.notifyOwnerItem('item-1');

    assert.equal(sent.length, 1, c.what);
    const payload = JSON.parse(sent[0].body);
    assert.equal(payload.kind, c.kind, c.what);
    assert.equal(payload.aps.alert.title, c.title, c.what);
    assert.equal(payload.aps.alert.body, c.body, c.what);
    // Its own category, and the coordinator conversation the card is drawn in: a tap has to land on
    // the card itself, which the item id in the payload names.
    assert.equal(payload.aps.category, 'ORBIT_OWNER_ITEM', c.what);
    assert.equal(payload.sessionID, 'coordinator', c.what);
    assert.equal(payload.projectID, 'project-1', c.what);
    assert.equal(payload.openItemID, 'item-1', c.what);
    assert.equal(payload.aps['thread-id'], 'project-1', c.what);
    assert.equal(sent[0].collapseId, 'owner-item-item-1', c.what);
    // The badge counts conversations needing a reply; these are counted there by the coordinator's
    // own row, so an item's push must not set a second opinion of it.
    assert.equal(payload.aps.badge, undefined, c.what);
  }
});

test('a switched-off coordinator still routes the tap to the conversation the card is drawn in', async () => {
  // The account owner's report, 2026-09-22: a project confirmed but never started — a bound
  // coordinator conversation, `coordinatorEnabled` false, and its exceptions handed to the owner
  // because `deliver()` had nowhere to put them. The card is drawn in that conversation (the
  // client's read is the binding, never the switch), so the tap has to land on it.
  const off = ownerItemHarness(
    openItem({
      kind: 'TASK_FAILED',
      assigneeReason: 'NO_COORDINATOR',
      title: 'Task failed: [WARC] 000_00022 的 WARC 依赖',
      payload: {},
      project: {
        title: 'FineWeb × Common Crawl → RocksDB 语料库',
        coordinatorEnabled: false,
        coordinatorSessionId: 'coordinator',
      },
    }),
  );
  await off.service.notifyOwnerItem('item-1');
  assert.equal(JSON.parse(off.sent[0].body).sessionID, 'coordinator');

  // And a project that genuinely has no conversation to open still routes nowhere: the card lives
  // on its page, and the clients ignore a payload naming no session.
  const unbound = ownerItemHarness(
    openItem({
      kind: 'TASK_FAILED',
      assigneeReason: 'NO_COORDINATOR',
      title: 'Task failed: [WARC] 000_00022 的 WARC 依赖',
      payload: {},
      project: { title: 'FineWeb × Common Crawl → RocksDB 语料库', coordinatorSessionId: null },
    }),
  );
  await unbound.service.notifyOwnerItem('item-1');
  assert.equal(JSON.parse(unbound.sent[0].body).sessionID, undefined);
});

test('an item still with the coordinator does not push', async () => {
  // A merge conflict on its way to the coordinator: somebody is on it, and the owner is not them.
  const conflict = openItem({
    kind: 'INTEGRATION_CONFLICT',
    assignee: 'COORDINATOR',
    assigneeReason: 'DEFAULT',
    title: 'Merge conflict — needs a fix on the task branch',
    payload: {},
  });
  const withCoordinator = ownerItemHarness(conflict);
  await withCoordinator.service.notifyOwnerItem('item-1');
  assert.equal(withCoordinator.sent.length, 0);

  // The same item once the clock hands it over IS the owner's, so the fixture is witnessing the
  // assignee and not the kind.
  const escalated = ownerItemHarness({
    ...conflict,
    assignee: 'OWNER',
    assigneeReason: 'ESCALATED',
    escalatedAt: new Date('2026-09-13T12:00:00Z'),
  });
  await escalated.service.notifyOwnerItem('item-1');
  assert.equal(escalated.sent.length, 1);

  // And an item that was answered while this call was on its way is nobody's to be told about.
  const answered = ownerItemHarness(openItem({ state: 'RESOLVED' }));
  await answered.service.notifyOwnerItem('item-1');
  assert.equal(answered.sent.length, 0);
});

test('an escalated item says which way it became yours', async () => {
  const headings: Array<[string, string]> = [
    ['COORDINATOR_ENDED', 'Now yours — the coordinator conversation ended'],
    ['CHAIN_LIMIT', 'Now yours — the 3rd failure in this chain'],
    ['HANDED_OVER', 'Now yours — the coordinator handed it over'],
    ['NO_COORDINATOR', 'Now yours — this project has no coordinator'],
  ];
  for (const [reason, title] of headings) {
    const { service, sent } = ownerItemHarness(
      openItem({ kind: 'TASK_FAILED', assigneeReason: reason, title: 'Task failed: Add the receipt', payload: {} }),
    );
    await service.notifyOwnerItem('item-1');
    assert.equal(JSON.parse(sent[0].body).aps.alert.title, title, reason);
  }
});
