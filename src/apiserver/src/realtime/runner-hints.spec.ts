import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { RunEventType } from '@orbit/shared';
import { QueueService } from '../queue/queue.service';
import { HELD_SUBJECT, RelayPeers, peerSubject } from '../runners/relay-peers';
import { SessionsService } from '../sessions/sessions.service';
import { MemoryNats } from '../test-support/memory-nats';
import { RealtimeService } from './realtime.service';
import {
  INSTANCE_HEADER,
  RunnerHints,
  runnerHintMessage,
  runnerHintSubject,
  turnPrefixRequestMessage,
  type HintBus,
  type RunnerHint,
} from './runner-hints';

/**
 * The runner link's hints (runner-hints.ts; docs/runner-link-design.md §5.5): each wake signal is published on
 * rnr.<runnerId> for the one runner it concerns, after the commit it announces, beside the in-process and NOTIFY
 * wakes the HTTP long polls park on, which do exactly what they did before.
 */

const RUNNER_A = '0190a0b0-0000-7000-8000-00000000000a';
const RUNNER_B = '0190a0b0-0000-7000-8000-00000000000b';
const SESSION_ON_A = '0190a0b0-0000-7000-8000-0000000000a1';
const SESSION_ON_B = '0190a0b0-0000-7000-8000-0000000000b1';
const SESSION_WITHOUT_RUNNER = '0190a0b0-0000-7000-8000-0000000000c1';
const APPROVAL = '0190a0b0-0000-7000-8000-0000000000e1';
const APPROVAL_ON_B = '0190a0b0-0000-7000-8000-0000000000e2';

// From build/realtime back to the repository root, as the compose specs read the repository.
const ROOT = path.resolve(__dirname, '../../../..');

/** A NATS stand-in that records what is published, up or down as the test says. */
function fakeBus(up = true): HintBus & { sent: Array<[string, string]>; up: boolean } {
  const sent: Array<[string, string]> = [];
  return {
    up,
    sent,
    publish: (subject, message) => void sent.push([subject, message]),
    subscribe: () => () => undefined,
    request: async () => null,
    close: async () => undefined,
  };
}

/** Sessions and the runners they are assigned to, and every lookup the hints make. */
function sessionsTable() {
  const assigned = new Map<string, string | null>([
    [SESSION_ON_A, RUNNER_A],
    [SESSION_ON_B, RUNNER_B],
    [SESSION_WITHOUT_RUNNER, null],
  ]);
  const lookups: string[] = [];
  const prisma = {
    session: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        lookups.push(where.id);
        return assigned.has(where.id) ? { assignedRunnerId: assigned.get(where.id) ?? null } : null;
      },
    },
  };
  return { prisma, assigned, lookups };
}

/** Hints over the stand-in, with a clock the test moves. */
function hintsOver(bus: HintBus, prisma = sessionsTable().prisma) {
  let now = 1_000_000;
  const hints = new RunnerHints(prisma as never, 'nats://nats.test:4222', () => bus, () => now);
  const warnings: string[] = [];
  (hints as unknown as { log: { log(): void; warn(line: string): void } }).log = {
    log: () => undefined,
    warn: (line: string) => void warnings.push(line),
  };
  hints.onModuleInit();
  return { hints, warnings, advance: (ms: number) => { now += ms; } };
}

/** Let the hints' own lookups settle. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

const message = (hint: RunnerHint) => runnerHintMessage(hint);

test('a hint is a link Frame carrying only that Hint, in protobuf JSON, on its runner\'s subject', () => {
  assert.equal(runnerHintSubject(RUNNER_A), `rnr.${RUNNER_A}`);
  assert.equal(message({ claim: {} }), '{"hint":{"claim":{}}}');
  assert.equal(message({ commands: {} }), '{"hint":{"commands":{}}}');
  assert.equal(message({ inbox: { sessionId: SESSION_ON_A } }), `{"hint":{"inbox":{"sessionId":"${SESSION_ON_A}"}}}`);
  assert.equal(message({ approval: { sessionId: SESSION_ON_A, approvalId: APPROVAL } }),
    `{"hint":{"approval":{"sessionId":"${SESSION_ON_A}","approvalId":"${APPROVAL}"}}}`);
});

test('the gateway\'s fixtures are what this encoder writes, case by case', () => {
  const fixture = JSON.parse(readFileSync(path.join(ROOT, 'src/link-gateway/testdata/b1-hints.json'), 'utf8')) as {
    cases: Array<{ name: string; runnerId: string; hint: RunnerHint; subject: string; message: string; headers?: Record<string, string> }>;
    requests: Array<{ name: string; runnerId: string; sessionId: string; requestId: string; subject: string; message: string }>;
  };
  assert.deepEqual(fixture.cases.map((c) => Object.keys(c.hint)[0]).sort(), ['approval', 'claim', 'commands', 'inbox', 'watchers'],
    'every kind of hint the apiserver publishes has a fixture the gateway decodes');
  for (const c of fixture.cases) {
    assert.equal(runnerHintSubject(c.runnerId), c.subject, c.name);
    assert.equal(runnerHintMessage(c.hint), c.message,
      `${c.name}: regenerate with node scripts/runner-link/gen-hint-fixtures.mjs`);
    // A watchers hint names the instance it counts for; no other hint carries a header.
    assert.deepEqual(Object.keys(c.headers ?? {}), 'watchers' in c.hint ? [INSTANCE_HEADER] : [], c.name);
  }
  assert.equal(fixture.requests.length, 1);
  for (const r of fixture.requests) {
    assert.equal(runnerHintSubject(r.runnerId), r.subject, r.name);
    assert.equal(turnPrefixRequestMessage(r.requestId, r.sessionId), r.message,
      `${r.name}: regenerate with node scripts/runner-link/gen-hint-fixtures.mjs`);
  }
});

test('off, nothing is opened, looked up or published', async () => {
  const table = sessionsTable();
  let opened = 0;
  const hints = new RunnerHints(table.prisma as never, null, () => {
    opened += 1;
    return fakeBus();
  });
  hints.onModuleInit();
  hints.claim(RUNNER_A);
  hints.commands(RUNNER_A);
  hints.inbox(SESSION_ON_A);
  hints.approval(SESSION_ON_A, APPROVAL);
  await settle();
  assert.equal(hints.enabled, false);
  assert.equal(opened, 0, 'no NATS connection is made');
  assert.deepEqual(table.lookups, [], 'no session is looked up');
  assert.deepEqual(hints.stats(), { published: 0, dropped: 0 });
  await hints.onModuleDestroy();
});

test('on only while the runner link is configured and RUNNER_LINK_NATS_URL names a server', () => {
  const signingKey = Buffer.from(generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }))
    .toString('base64');
  const link = {
    RUNNER_LINK_SIGNING_KEY: signingKey,
    RUNNER_LINK_URL: 'wss://link.example.invalid',
    RUNNER_LINK_GATEWAY_TOKEN: 'g'.repeat(32),
  };
  const config = (values: Record<string, string>) => ({ get: <T>(name: string) => values[name] as T });
  const prisma = sessionsTable().prisma as never;
  assert.equal(RunnerHints.fromConfig(prisma, config({ ...link, RUNNER_LINK_NATS_URL: 'nats://nats:4222' })).enabled, true);
  assert.equal(RunnerHints.fromConfig(prisma, config({ RUNNER_LINK_NATS_URL: 'nats://nats:4222' })).enabled, false,
    'a deployment without the link publishes nothing, whatever the URL says');
  assert.equal(RunnerHints.fromConfig(prisma, config({ ...link, RUNNER_LINK_NATS_URL: '  ' })).enabled, false);
  assert.equal(RunnerHints.fromConfig(prisma, config(link)).enabled, false);
});

test('each signal is published once, for the runner it concerns and no other', async () => {
  const bus = fakeBus();
  const { hints } = hintsOver(bus);
  hints.claim(RUNNER_A);
  hints.commands(RUNNER_B);
  hints.inbox(SESSION_ON_A);
  hints.inbox(SESSION_ON_B);
  hints.inbox(SESSION_WITHOUT_RUNNER);
  hints.inbox('0190a0b0-0000-7000-8000-0000000000ff'); // no such session
  await settle();
  assert.deepEqual(bus.sent, [
    [`rnr.${RUNNER_A}`, '{"hint":{"claim":{}}}'],
    [`rnr.${RUNNER_B}`, '{"hint":{"commands":{}}}'],
    [`rnr.${RUNNER_A}`, `{"hint":{"inbox":{"sessionId":"${SESSION_ON_A}"}}}`],
    [`rnr.${RUNNER_B}`, `{"hint":{"inbox":{"sessionId":"${SESSION_ON_B}"}}}`],
  ]);
  assert.deepEqual(hints.stats(), { published: 4, dropped: 0 });
  await hints.onModuleDestroy();
});

test('a session\'s runner is read once and remembered for 30 s, and forgotten when the session moves', async () => {
  const bus = fakeBus();
  const table = sessionsTable();
  const { hints, advance } = hintsOver(bus, table.prisma);
  hints.inbox(SESSION_ON_A);
  await settle();
  hints.inbox(SESSION_ON_A);
  await settle();
  assert.deepEqual(table.lookups, [SESSION_ON_A], 'the second hint is answered from memory');

  advance(30_000);
  hints.inbox(SESSION_ON_A);
  await settle();
  assert.deepEqual(table.lookups, [SESSION_ON_A, SESSION_ON_A], 'read again once 30 s have passed');

  // Moved to runner B: the replica that moved it forgets at once, and the next hint goes to B.
  table.assigned.set(SESSION_ON_A, RUNNER_B);
  hints.forgetSession(SESSION_ON_A);
  hints.inbox(SESSION_ON_A);
  await settle();
  assert.equal(table.lookups.length, 3);
  assert.deepEqual(bus.sent.map(([subject]) => subject), [`rnr.${RUNNER_A}`, `rnr.${RUNNER_A}`, `rnr.${RUNNER_A}`, `rnr.${RUNNER_B}`]);
  await hints.onModuleDestroy();
});

test('while NATS is down a hint is dropped and counted, nothing is looked up, and the count is logged once per report', async () => {
  const bus = fakeBus(false);
  const table = sessionsTable();
  const { hints, warnings } = hintsOver(bus, table.prisma);
  hints.claim(RUNNER_A);
  hints.commands(RUNNER_A);
  hints.inbox(SESSION_ON_A);
  for (let i = 0; i < 100; i += 1) hints.claim(RUNNER_B);
  await settle();
  assert.deepEqual(bus.sent, []);
  assert.deepEqual(table.lookups, [], 'an outage costs the database nothing');
  assert.deepEqual(hints.stats(), { published: 0, dropped: 103 });
  assert.deepEqual(warnings, [], 'nothing is logged per hint');
  hints.reportDrops();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^dropped 103 runner link hints since the last report/);
  hints.reportDrops();
  assert.equal(warnings.length, 1, 'a report with nothing dropped since says nothing');

  bus.up = true;
  hints.claim(RUNNER_A);
  assert.deepEqual(bus.sent, [[`rnr.${RUNNER_A}`, '{"hint":{"claim":{}}}']], 'published again once it is back');
  await hints.onModuleDestroy();
});

test('a publish or a lookup that fails is a dropped hint, never an error for the caller', async () => {
  const bus = fakeBus();
  bus.publish = () => {
    throw new Error('connection closed');
  };
  const failing = { session: { findUnique: async () => { throw new Error('the database is down'); } } };
  const { hints } = hintsOver(bus, failing as never);
  assert.doesNotThrow(() => hints.claim(RUNNER_A));
  assert.doesNotThrow(() => hints.inbox(SESSION_ON_A));
  await settle();
  assert.deepEqual(hints.stats(), { published: 0, dropped: 2 });
  await hints.onModuleDestroy();
});

/** RealtimeService over doubles: what it NOTIFYs, and its hints. */
function realtimeWithHints() {
  const bus = fakeBus();
  const table = sessionsTable();
  const { hints } = hintsOver(bus, table.prisma);
  const notified: Array<[string, string]> = [];
  // The runners whose change count markRunnerChanged moved (runner_presence, migration 0447), each when the bus had
  // published how many hints: the count moves first.
  const marked: Array<{ runners: string[]; hintsBefore: number }> = [];
  const prisma = {
    ...table.prisma,
    $executeRawUnsafe: async (_sql: string, channel: string, payload: string) => {
      notified.push([channel, payload]);
      return 0;
    },
    $executeRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      marked.push({ runners: values[0] as string[], hintsBefore: bus.sent.length });
      return 1;
    },
  };
  const realtime = new RealtimeService(prisma as never, {} as never, hints);
  const deliver = (channel: string, payload: unknown) =>
    (realtime as unknown as { onNotify(channel: string, payload: string): void }).onNotify(channel, JSON.stringify(payload));
  return { realtime, hints, bus, notified, marked, table, deliver };
}

test('notifyInbox still wakes the parked inbox poll and the other replicas, and hints the session\'s runner', async () => {
  const { realtime, hints, bus, notified } = realtimeWithHints();
  const parked = realtime.waitForInbox(SESSION_ON_A, 5_000);
  realtime.notifyInbox(SESSION_ON_A);
  await parked;
  await settle();
  assert.deepEqual(notified.map(([channel]) => channel), ['orbit_inbox']);
  assert.deepEqual(bus.sent, [[`rnr.${RUNNER_A}`, `{"hint":{"inbox":{"sessionId":"${SESSION_ON_A}"}}}`]]);
  await hints.onModuleDestroy();
});

test('notifyRunnerWake still wakes the parked wake poll and the other replicas, and hints that runner', async () => {
  const { realtime, hints, bus, notified, marked } = realtimeWithHints();
  const parked = realtime.waitForRunnerWake(RUNNER_B, 5_000);
  realtime.notifyRunnerWake(RUNNER_B);
  assert.equal(await parked, true);
  await settle();
  assert.deepEqual(notified.map(([channel]) => channel), ['orbit_runner_wake']);
  // Over the link the runner's change count moves first (markRunnerChanged), and then it is hinted.
  assert.deepEqual(marked, [{ runners: [RUNNER_B], hintsBefore: 0 }]);
  assert.deepEqual(bus.sent, [[`rnr.${RUNNER_B}`, '{"hint":{"commands":{}}}']]);
  await hints.onModuleDestroy();
});

test('a wake committed inside a transaction is hinted when its NOTIFY arrives; one another replica emitted is not hinted twice', async () => {
  const { realtime, hints, bus, marked, deliver } = realtimeWithHints();
  deliver('orbit_runner_wake', { r: RUNNER_A, c: true });
  deliver('orbit_runner_wake', { i: 'another-replica', r: RUNNER_B });
  deliver('orbit_inbox', { i: 'another-replica', r: SESSION_ON_B });
  await settle();
  assert.deepEqual(bus.sent, [[`rnr.${RUNNER_A}`, '{"hint":{"commands":{}}}']],
    'the replica that emitted a wake or an inbox notice hinted it already');
  assert.deepEqual(marked, [{ runners: [RUNNER_A], hintsBefore: 0 }], 'and marked it changed, before the hint');
  // The NOTIFY bridge still does what it did: B's wake is held for its next poll.
  assert.equal(await realtime.waitForRunnerWake(RUNNER_B, 5_000), true);
  await hints.onModuleDestroy();
});

test('a moved session is forgotten with its owner, so its next inbox hint goes to its new runner', async () => {
  const { realtime, hints, bus, table } = realtimeWithHints();
  realtime.notifyInbox(SESSION_ON_A);
  await settle();
  table.assigned.set(SESSION_ON_A, RUNNER_B);
  realtime.forgetSessionOwner(SESSION_ON_A);
  realtime.notifyInbox(SESSION_ON_A);
  await settle();
  assert.deepEqual(bus.sent.map(([subject]) => subject), [`rnr.${RUNNER_A}`, `rnr.${RUNNER_B}`]);
  await hints.onModuleDestroy();
});

test('a queued session still wakes every claim poll of this process once, and hints only the runner it is queued for', async () => {
  const bus = fakeBus();
  const { hints } = hintsOver(bus);
  const queue = new QueueService({} as never, {} as never, undefined, undefined, hints);
  const signal = (queue as unknown as { signal: import('node:events').EventEmitter }).signal;
  let emitted = 0;
  signal.on('queued', () => { emitted += 1; });
  const waitForSignal = (ms: number) =>
    (queue as unknown as { waitForSignal(ms: number): Promise<void> }).waitForSignal(ms);

  // A claim long poll of runner B parks too: the in-process signal wakes it as before (it re-reads the
  // queue and finds nothing of its own), while only runner A is hinted over the link.
  const parkedForB = waitForSignal(5_000);
  queue.notifySessionQueued(RUNNER_A);
  await parkedForB;
  assert.equal(emitted, 1);
  assert.deepEqual(bus.sent, [[`rnr.${RUNNER_A}`, '{"hint":{"claim":{}}}']]);

  queue.notifySessionQueued(null);
  assert.equal(emitted, 2, 'a session with no runner still wakes the polls');
  assert.equal(bus.sent.length, 1, 'and hints nobody');

  queue.notifySessionQueued([RUNNER_A, RUNNER_B]);
  assert.equal(emitted, 3, 'several runners, one wake of the polls');
  assert.deepEqual(bus.sent.slice(1).map(([subject]) => subject), [`rnr.${RUNNER_A}`, `rnr.${RUNNER_B}`]);
  await hints.onModuleDestroy();
});

const approvalHint = (sessionId: string, approvalId: string) =>
  `{"hint":{"approval":{"sessionId":"${sessionId}","approvalId":"${approvalId}"}}}`;

test('a decided approval is hinted to the runner its session is assigned to, and to no other', async () => {
  const bus = fakeBus();
  const { hints } = hintsOver(bus);
  hints.approval(SESSION_ON_A, APPROVAL);
  hints.approval(SESSION_ON_B, APPROVAL_ON_B);
  hints.approval(SESSION_WITHOUT_RUNNER, APPROVAL);
  hints.approval('0190a0b0-0000-7000-8000-0000000000ff', APPROVAL); // no such session
  await settle();
  assert.deepEqual(bus.sent, [
    [`rnr.${RUNNER_A}`, approvalHint(SESSION_ON_A, APPROVAL)],
    [`rnr.${RUNNER_B}`, approvalHint(SESSION_ON_B, APPROVAL_ON_B)],
  ]);
  await hints.onModuleDestroy();
});

/**
 * SessionsService.decideApproval over doubles of its rows, publishing through a RealtimeService whose hints go to the
 * stand-in, with what happened in order: the approval's write, and each hint published.
 */
function decisions(options: { landed?: boolean } = {}) {
  const bus = fakeBus();
  const table = sessionsTable();
  const { hints } = hintsOver(bus, table.prisma);
  const order: string[] = [];
  const publish = bus.publish;
  bus.publish = (subject, message) => {
    order.push(`hint on ${subject}`);
    publish(subject, message);
  };
  const prisma = {
    session: {
      findFirst: async ({ where }: { where: { id: string } }) => ({ id: where.id, workspaceId: null }),
      findUnique: async () => null,
    },
    approval: {
      // count 0: another decision landed first, so this click changed nothing.
      updateMany: async () => {
        order.push('the approval written');
        return { count: options.landed === false ? 0 : 1 };
      },
      findFirst: async ({ where }: { where: { id: string; sessionId: string } }) => ({
        id: where.id, sessionId: where.sessionId, toolName: 'Bash', input: {}, toolUseId: 'toolu_01', backgroundJobId: null,
        status: 'ALLOWED', message: null, createdAt: new Date(), decidedAt: new Date(),
      }),
    },
    $executeRawUnsafe: async () => 0,
  };
  const realtime = new RealtimeService(prisma as never, { scheduleBadgeSync: () => undefined } as never, hints);
  return { sessions: new SessionsService(prisma as never, {} as never, realtime), realtime, hints, bus, order };
}

test('a person\'s decision is hinted to its session\'s runner alone, after the write that records it', async () => {
  const { sessions, hints, bus, order } = decisions();
  await sessions.decideApproval('owner-1', SESSION_ON_A, APPROVAL, { behavior: 'allow' });
  await settle();
  assert.deepEqual(bus.sent, [[`rnr.${RUNNER_A}`, approvalHint(SESSION_ON_A, APPROVAL)]]);
  assert.deepEqual(order, ['the approval written', `hint on rnr.${RUNNER_A}`]);

  await sessions.decideApproval('owner-1', SESSION_ON_B, APPROVAL_ON_B, { behavior: 'deny' });
  await settle();
  assert.deepEqual(bus.sent.slice(1), [[`rnr.${RUNNER_B}`, approvalHint(SESSION_ON_B, APPROVAL_ON_B)]],
    'a deny is a decision too, hinted to its own session\'s runner');
  await hints.onModuleDestroy();
});

test('a click that lost to an earlier decision is not hinted', async () => {
  const { sessions, hints, bus } = decisions({ landed: false });
  await sessions.decideApproval('owner-1', SESSION_ON_A, APPROVAL, { behavior: 'allow' });
  await settle();
  assert.deepEqual(bus.sent, []);
  await hints.onModuleDestroy();
});

test('a card collected as ABANDONED is no decision: its APPROVAL_RESOLVED is not hinted', async () => {
  const { realtime, hints, bus } = decisions();
  // As a takeover and the events ingest publish the cards they collect (runner-api.controller.ts).
  realtime.publish(SESSION_ON_A, {
    seq: 0, type: RunEventType.APPROVAL_RESOLVED, payload: { id: APPROVAL, status: 'ABANDONED' }, ts: new Date().toISOString(),
  });
  await settle();
  assert.deepEqual(bus.sent, []);
  await hints.onModuleDestroy();
});

test('the apiserver processes reach each other on the hints\' connection, while hints are on, and a nudge is a commands hint', async () => {
  const nats = new MemoryNats();
  const conn = nats.connect('this');
  const peers = new RelayPeers();
  const hints = new RunnerHints(sessionsTable().prisma as never, 'nats://nats.test:4222', () => conn, Date.now, true, peers);
  hints.onModuleInit();
  assert.equal(nats.listeners(HELD_SUBJECT), 1, 'not listening for what the other processes hold');
  assert.equal(nats.listeners(peerSubject(hints.instanceId)), 1, 'not answering on its own instance');
  peers.nudge(RUNNER_A);
  assert.deepEqual(nats.sent.map((m) => [m.subject, m.message]), [[runnerHintSubject(RUNNER_A), runnerHintMessage({ commands: {} })]]);
  await hints.onModuleDestroy();
  assert.equal(nats.listeners(HELD_SUBJECT) + nats.listeners(peerSubject(hints.instanceId)), 0);

  // Off without NATS: nothing is connected, and holding something says nothing anywhere.
  const off = new RunnerHints(sessionsTable().prisma as never, null, () => nats.connect('never'), Date.now, true, peers);
  off.onModuleInit();
  peers.hold('login-code', RUNNER_A, 'attempt', 60_000);
  assert.equal(nats.listeners(HELD_SUBJECT), 0);
  assert.equal(nats.sent.length, 1);
  await off.onModuleDestroy();
});
