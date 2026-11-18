/**
 * A condition evaluated from runner samples (docs/condition-triggers-design.md §3, §4.2, §5), against a real
 * PostgreSQL migrated from empty, on a clock the spec moves. One named case each for:
 *
 *   crossing-fires-once      fires on the crossing, once: staying above the line fires nothing more;
 *   hold                     fires only once the comparison held across samples for holdSeconds; a false sample restarts it;
 *   re-arm                   a WHEN condition fires again only after its re-arm comparison held (or, with none, once the
 *                            comparison was false); a startWhen condition never does;
 *   three-failures-unknown   three failed checks in a row are UNKNOWN: one CANT_READ, one Waiting on you item with the
 *                            last reading, its age and why, one push; a sample that reads again closes the item;
 *   silence-unknown          three intervals with no sample are UNKNOWN (RUNNER_OFFLINE, notified once); a managed runner
 *                            asleep, which its active condition wakes, is RUNNER_ASLEEP while it comes up, shown and not
 *                            notified (managed-runner-condition.pg.spec.ts covers the states);
 *   unknown-restarts-hold    UNKNOWN never fires and clears trueSince: the hold starts over from the sample that reads again;
 *   heartbeat-stores-samples a heartbeat from the runner that serves the condition's workspace is handed its probe (only
 *                            with condition-probe/v1) and its conditionSamples are stored and evaluated;
 *   heartbeat-refuses-foreign the same samples from a runner that does not serve that workspace are refused: nothing stored,
 *                            nothing moved;
 *   no-capability-no-probes  a runner that does not declare condition-probe/v1 is sent no conditionProbes;
 *   heartbeat-wire-fixture   the server's answer for a condition equals src/runner-go/testdata/condition-probe/
 *                            heartbeat-answer.json, which runner-go's TestConditionProbeWireFixture decodes;
 * and the limit (20 not ENDED per account), the owner's read, and the schema's attach CHECK.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/conditions/conditions.pg.spec.ts
 *
 * Not destructive: every row belongs to a user this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';

import { CONDITION_PROBE_CAPABILITY, type ConditionSampleReport, type RunnerHeartbeatRequest, type RunnerHeartbeatResponse } from '@orbit/shared';
import { CreatorType, PrismaClient, RunnerStatus } from '@prisma/client';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

import { sha256 } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { OwnerRequestsService } from '../owner-requests/owner-requests.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerHints, type HintBus } from '../realtime/runner-hints';
import { RunnerPresenceService } from '../runners/runner-presence';
import { IntegrationJobRelay } from '../runner-api/integration-job-relay';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { WikiRepoOps } from '../wiki-worker/wiki-repo-ops';
import type { ConditionAlert } from './condition-attention';
import {
  CONDITION_LIMIT_PER_ACCOUNT,
  CONDITION_LIMIT_REACHED,
  ConditionsService,
  conditionCommandHash,
  type ConditionCreateInput,
  type ConditionFiring,
} from './conditions.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const RUN = randomUUID().slice(0, 8);
const SECOND = 1000;

let db: PrismaClient;
let pg: Client;
let clockNow = new Date('2026-11-17T08:00:00Z');
const clock = () => clockNow;
let conditions: ConditionsService;
let alerts: ConditionAlert[] = [];
let fired: ConditionFiring[] = [];
let door: RunnerApiController;
let realtime: RealtimeService;
let hints: RunnerHints;

before(async () => {
  if (skip) return;
  assertCoordinatorPgUrlIsIsolated(URL!);
  process.env.DATABASE_URL ??= URL!;
  pg = new Client({ connectionString: URL!, connectionTimeoutMillis: 5_000 });
  await pg.connect();
  await verifyCoordinatorPgIdentity(pg);
  db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  // The managed-runner switch on, as a server with Orbit Cloud runs it: RUNNER_ASLEEP is read only then.
  conditions = new ConditionsService(prisma, { notify: async (alert) => void alerts.push(alert) }, clock, { enabled: true, problem: null });
  // The hook C3 and C4 implement; here it only records that the firing transaction called it.
  conditions.registerFireHook({ onFired: async (_tx, firing) => void fired.push(firing) });

  const bus: HintBus = {
    up: true,
    publish: () => undefined,
    subscribe: () => () => undefined,
    request: async () => null,
    close: async () => undefined,
  };
  hints = new RunnerHints(db as never, 'nats://nats.invalid:4222', () => bus, Date.now, true);
  hints.onModuleInit();
  const push = { notifyEngineSignedOut: () => undefined, notifyRunnerDrainWaiting: async () => undefined };
  realtime = new RealtimeService(prisma, push as never, hints);
  await realtime.onModuleInit();
  // RunnerApiController's positional constructor, as the Nest module builds it: what this spec does not exercise is
  // left out, and ConditionsService is its last parameter.
  const args: unknown[] = new Array(31).fill(undefined);
  args[0] = prisma;
  args[1] = { notifySessionQueued: () => undefined };
  args[2] = realtime;
  args[3] = push;
  args[4] = {};
  args[5] = {};
  args[13] = new IntegrationJobRelay(prisma);
  args[18] = new WikiRepoOps(prisma);
  args[21] = new RunnerPresenceService(prisma);
  args[30] = conditions;
  door = new (RunnerApiController as unknown as new (...a: unknown[]) => RunnerApiController)(...args);
});

after(async () => {
  if (skip) return;
  realtime.onModuleDestroy();
  await hints.onModuleDestroy();
  await db.$disconnect();
  await pg.end();
});

interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  token: string;
  /** The conversation conditions are created from: where their items are shown. */
  sessionId: string;
}

async function world(label: string, env?: Record<string, string>): Promise<World> {
  const ownerId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${RUN}-${ownerId}@conditions.invalid`, name: label, passwordHash: 'x' },
  });
  return { ownerId, ...(await machine(ownerId, label, env)), sessionId: randomUUID() };
}

async function machine(
  ownerId: string,
  label: string,
  env?: Record<string, string>,
): Promise<{ runnerId: string; workspaceId: string; token: string }> {
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const token = `cond-${randomUUID()}`;
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner-${runnerId.slice(0, 4)}`, tokenHash: sha256(token),
      status: RunnerStatus.ONLINE, lastHeartbeatAt: new Date(), capabilities: [], capabilitiesReportedAt: new Date(),
    },
  });
  await db.workspace.create({
    data: {
      id: workspaceId, ownerId, runnerId, name: `${label}-ws-${workspaceId.slice(0, 4)}`, workDir: `/srv/${label}`,
      ...(env ? { env } : {}),
    },
  });
  return { runnerId, workspaceId, token };
}

async function taskOf(w: World): Promise<string> {
  const id = randomUUID();
  await db.task.create({
    data: {
      id, ownerId: w.ownerId, title: 'Set the pool to 3 copies', creatorType: CreatorType.USER, creatorId: w.ownerId,
      completionCriterion: 'EVIDENCE_JUDGMENT',
    },
  });
  return id;
}

async function scheduleOf(w: World): Promise<string> {
  const row = await db.schedule.create({
    data: {
      ownerId: w.ownerId, workspaceId: w.workspaceId, intent: 'When Ceph is above 90%, look at what can be cleared',
      title: 'Ceph capacity guard', prompt: 'Look at what can be cleared.', rule: { kind: 'WHEN' }, timezone: 'UTC',
      startAt: clockNow, accessLevel: 'CHECK_ONLY', envelopeWorkspaceId: w.workspaceId, envelopeAccessLevel: 'CHECK_ONLY',
      envelopeRunsPerWeek: 7, envelopeRunLimitMinutes: 30,
    },
  });
  return row.id;
}

/** A condition as C3 and C4 will create one: on a schedule (WHEN) unless `task` is set. */
async function conditionOf(w: World, over: Partial<ConditionCreateInput> & { task?: boolean } = {}) {
  const { task, ...rest } = over;
  const attach = task ? { taskId: await taskOf(w) } : { scheduleId: await scheduleOf(w) };
  return db.$transaction((tx) => conditions.createCondition(tx, {
    ownerId: w.ownerId,
    workspaceId: w.workspaceId,
    command: "ceph df -f json | jq '.stats.total_used_raw_ratio * 100'",
    compare: { op: 'GT', value: 90 },
    intervalSeconds: 300,
    text: 'Raw used is above 90%',
    unit: '%',
    createdFromSessionId: w.sessionId,
    approvedAt: clockNow,
    ...attach,
    ...rest,
  }));
}

const T0 = new Date('2026-11-17T08:00:00Z').getTime();
/** The time `seconds` after the spec's origin, as the runner writes a sample's `at`. */
const t = (seconds: number) => new Date(T0 + seconds * SECOND);

function reading(conditionId: string, seconds: number, value: number): ConditionSampleReport {
  return { conditionId, at: t(seconds).toISOString(), outcome: 'VALUE', value };
}

function failure(conditionId: string, seconds: number, outcome: 'TIMEOUT' | 'ERROR' = 'TIMEOUT'): ConditionSampleReport {
  return { conditionId, at: t(seconds).toISOString(), outcome, stderrTail: outcome === 'ERROR' ? 'ceph: command not found' : null };
}

async function feed(w: World, ...samples: ConditionSampleReport[]) {
  for (const s of samples) {
    clockNow = new Date(s.at);
    const result = await conditions.intake({ id: w.runnerId, ownerId: w.ownerId }, [s]);
    assert.equal(result.refused, 0, 'a sample from the runner that serves the workspace is taken');
  }
}

const stateOf = async (id: string) => db.condition.findUniqueOrThrow({ where: { id } });
const eventsOf = async (id: string) =>
  (await db.conditionEvent.findMany({ where: { conditionId: id }, orderBy: [{ at: 'asc' }, { id: 'asc' }] })).map((e) => e.kind);
const firedFor = (id: string) => fired.filter((f) => f.condition.id === id).length;
const itemsOf = (id: string) => db.ownerRequest.findMany({ where: { conditionId: id }, orderBy: { createdAt: 'asc' } });

test('crossing-fires-once', { skip }, async () => {
  const w = await world('crossing');
  const c = await conditionOf(w);
  await feed(w, reading(c.id, 0, 80));
  assert.equal((await stateOf(c.id)).state, 'WAITING');
  await feed(w, reading(c.id, 300, 95));
  const after = await stateOf(c.id);
  assert.equal(after.state, 'FIRED', 'the crossing fires at once with no hold');
  assert.equal(after.firedAt?.toISOString(), t(300).toISOString());
  assert.equal(firedFor(c.id), 1, 'the fire hook is called in the firing transaction');
  await feed(w, reading(c.id, 600, 96), reading(c.id, 900, 99), reading(c.id, 1200, 92));
  assert.equal((await stateOf(c.id)).state, 'FIRED');
  assert.deepEqual(await eventsOf(c.id), ['FIRED'], 'staying above the line fires nothing more');
  assert.equal(firedFor(c.id), 1);
  // A replayed beat (the same samples again) stores nothing twice and moves nothing.
  const replay = await conditions.intake({ id: w.runnerId, ownerId: w.ownerId }, [reading(c.id, 300, 95), reading(c.id, 600, 96)]);
  assert.equal(replay.stored, 0);
  assert.equal(await db.conditionSample.count({ where: { conditionId: c.id } }), 5);
  assert.deepEqual(await eventsOf(c.id), ['FIRED']);

  // Already true on its first reading: it fires at once (the design's baseline that already holds).
  const already = await conditionOf(w);
  await feed(w, reading(already.id, 0, 97));
  assert.equal((await stateOf(already.id)).state, 'FIRED');
});

test('hold', { skip }, async () => {
  const w = await world('hold');
  const c = await conditionOf(w, { holdSeconds: 600 });
  await feed(w, reading(c.id, 0, 95));
  let row = await stateOf(c.id);
  assert.equal(row.state, 'HOLDING');
  assert.equal(row.trueSince?.toISOString(), t(0).toISOString());
  await feed(w, reading(c.id, 300, 95));
  assert.equal((await stateOf(c.id)).state, 'HOLDING', '300 s of a 600 s hold does not fire');
  assert.equal(firedFor(c.id), 0);
  await feed(w, reading(c.id, 600, 94));
  row = await stateOf(c.id);
  assert.equal(row.state, 'FIRED', 'true in every sample across 600 s fires');
  assert.equal(row.firedAt?.toISOString(), t(600).toISOString());
  assert.deepEqual(await eventsOf(c.id), ['FIRED']);

  // A false sample inside the span: back to WAITING, and the hold is measured again from the next true sample.
  const broken = await conditionOf(w, { holdSeconds: 600 });
  await feed(w, reading(broken.id, 0, 95), reading(broken.id, 300, 80));
  row = await stateOf(broken.id);
  assert.equal(row.state, 'WAITING');
  assert.equal(row.trueSince, null);
  await feed(w, reading(broken.id, 600, 95), reading(broken.id, 900, 95));
  row = await stateOf(broken.id);
  assert.equal(row.state, 'HOLDING', '600 s after the first true sample is not 600 s of holding');
  assert.equal(row.trueSince?.toISOString(), t(600).toISOString());
  await feed(w, reading(broken.id, 1200, 95));
  assert.equal((await stateOf(broken.id)).state, 'FIRED');
  assert.equal(firedFor(broken.id), 1);
});

test('re-arm', { skip }, async () => {
  const w = await world('rearm');
  // Above 90%, ready again below 85%.
  const c = await conditionOf(w, { rearm: { op: 'LT', value: 85 } });
  await feed(w, reading(c.id, 0, 95));
  assert.equal((await stateOf(c.id)).state, 'FIRED');
  await feed(w, reading(c.id, 300, 88));
  assert.equal((await stateOf(c.id)).state, 'FIRED', 'below the line but not below the re-arm line: not ready');
  await feed(w, reading(c.id, 600, 93));
  assert.equal(firedFor(c.id), 1, 'hovering at the line fires nothing again');
  await feed(w, reading(c.id, 900, 84));
  let row = await stateOf(c.id);
  assert.equal(row.state, 'WAITING');
  assert.equal(row.armed, true);
  await feed(w, reading(c.id, 1200, 95));
  assert.equal((await stateOf(c.id)).state, 'FIRED');
  assert.deepEqual(await eventsOf(c.id), ['FIRED', 'READY_AGAIN', 'FIRED']);
  assert.equal(firedFor(c.id), 2);

  // With no rearm, a WHEN condition is ready again as soon as the comparison is false.
  const plain = await conditionOf(w);
  await feed(w, reading(plain.id, 0, 95), reading(plain.id, 300, 89), reading(plain.id, 600, 95));
  assert.deepEqual(await eventsOf(plain.id), ['FIRED', 'READY_AGAIN', 'FIRED']);

  // A startWhen (a task's) condition fires once and stays FIRED: its task's start ends it (C4).
  const once = await conditionOf(w, { task: true, compare: { op: 'GTE', value: 3 }, text: '3 or more OSDs are in', unit: 'in' });
  await feed(w, reading(once.id, 0, 2), reading(once.id, 300, 3), reading(once.id, 600, 2), reading(once.id, 900, 3));
  row = await stateOf(once.id);
  assert.equal(row.state, 'FIRED');
  assert.deepEqual(await eventsOf(once.id), ['FIRED']);
});

test('three-failures-unknown', { skip }, async () => {
  alerts = [];
  const w = await world('failures');
  const c = await conditionOf(w);
  await feed(w, reading(c.id, 0, 80), failure(c.id, 300), failure(c.id, 600));
  let row = await stateOf(c.id);
  assert.equal(row.state, 'WAITING', 'two failed checks are not UNKNOWN');
  assert.equal(row.failedChecks, 2);
  assert.equal((await itemsOf(c.id)).length, 0);
  await feed(w, failure(c.id, 900));
  row = await stateOf(c.id);
  assert.equal(row.state, 'UNKNOWN');
  assert.equal(row.unknownReason, 'TIMEOUT');
  assert.equal(row.unknownSince?.toISOString(), t(900).toISOString());
  assert.equal(row.lastValue, 80, 'the last reading is kept');
  let items = await itemsOf(c.id);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'CONDITION_UNKNOWN');
  assert.equal(items[0].state, 'PENDING');
  assert.equal(items[0].askedBySessionId, w.sessionId);
  assert.equal(items[0].title, "Can't read: Raw used is above 90%");
  assert.match(items[0].why, /The check timed out 3 times in a row\./);
  assert.match(items[0].why, /The last reading was 80%, 15 minutes ago\./, 'the last reading and its age');
  assert.equal(alerts.filter((a) => a.conditionId === c.id).length, 1);
  assert.equal(alerts[0].ownerRequestId, items[0].id);
  // The owner's read of the item names its condition: what a client opens to offer Pause and Look into it (C6).
  const listed = (await new OwnerRequestsService(db as unknown as PrismaService, {} as never).list(w.ownerId, 'open'))
    .requests.find((r) => r.id === items[0].id) as { conditionId?: string | null } | undefined;
  assert.equal(listed?.conditionId, c.id, 'a CONDITION_UNKNOWN item carries its conditionId');

  // A fourth failure, and the silence sweep, tell nobody again.
  await feed(w, failure(c.id, 1200));
  clockNow = t(1200 + 3600);
  await conditions.sweep();
  assert.equal(alerts.filter((a) => a.conditionId === c.id).length, 1, 'entering UNKNOWN notifies once');
  assert.equal((await itemsOf(c.id)).length, 1);
  assert.deepEqual(await eventsOf(c.id), ['CANT_READ']);

  // A sample that reads again leaves UNKNOWN by that sample and closes the card by itself.
  await feed(w, reading(c.id, 1500, 82));
  row = await stateOf(c.id);
  assert.equal(row.state, 'WAITING');
  assert.equal(row.unknownReason, null);
  assert.equal(row.failedChecks, 0);
  items = await itemsOf(c.id);
  assert.equal(items[0].state, 'WITHDRAWN');
  assert.deepEqual(await eventsOf(c.id), ['CANT_READ', 'READ_AGAIN']);

  // Errors are ERROR; a VALUE outcome with no number is one too.
  const broken = await conditionOf(w);
  await feed(w, failure(broken.id, 0, 'ERROR'), { conditionId: broken.id, at: t(300).toISOString(), outcome: 'VALUE' }, failure(broken.id, 600, 'ERROR'));
  row = await stateOf(broken.id);
  assert.equal(row.state, 'UNKNOWN');
  assert.equal(row.unknownReason, 'ERROR');
  assert.match((await itemsOf(broken.id))[0].why, /The check failed 3 times in a row\. It has not been read yet\./);
});

test('silence-unknown', { skip }, async () => {
  alerts = [];
  const w = await world('silence');
  const c = await conditionOf(w, { intervalSeconds: 60 });
  await feed(w, reading(c.id, 0, 70));
  clockNow = t(179);
  await conditions.sweep();
  assert.equal((await stateOf(c.id)).state, 'WAITING', 'under three intervals of silence is not UNKNOWN');
  clockNow = t(180);
  await conditions.sweep();
  const row = await stateOf(c.id);
  assert.equal(row.state, 'UNKNOWN');
  assert.equal(row.unknownReason, 'RUNNER_OFFLINE');
  const items = await itemsOf(c.id);
  assert.equal(items.length, 1);
  assert.match(items[0].why, /No reading has arrived for 3 minutes: its runner may be offline\./);
  assert.match(items[0].why, /The last reading was 70%, 3 minutes ago\./);
  clockNow = t(900);
  await conditions.sweep();
  assert.equal(alerts.filter((a) => a.conditionId === c.id).length, 1, 'notified once');

  // A condition never sampled is silent from its approval.
  clockNow = t(0);
  const never = await conditionOf(w, { intervalSeconds: 60 });
  clockNow = t(180);
  await conditions.sweep();
  assert.equal((await stateOf(never.id)).state, 'UNKNOWN');
  assert.match((await itemsOf(never.id))[0].why, /It has not been read yet\./);

  // A managed runner asleep, woken by its condition and still coming up: RUNNER_ASLEEP, shown on the condition, neither
  // filed nor pushed.
  const sleepy = await world('asleep');
  await db.managedRunner.create({
    data: {
      ownerId: sleepy.ownerId, runnerId: sleepy.runnerId, clusterKey: 'lab', namespace: `ns-${RUN}`,
      pvcName: `mr-data-${sleepy.runnerId}`, desiredState: 'SLEEPING', managementState: 'SLEEPING',
    },
  });
  clockNow = t(0);
  const asleep = await conditionOf(sleepy, { intervalSeconds: 60 });
  await feed(sleepy, reading(asleep.id, 0, 70));
  clockNow = t(200);
  await conditions.sweep();
  const sleeping = await stateOf(asleep.id);
  assert.equal(sleeping.state, 'UNKNOWN');
  assert.equal(sleeping.unknownReason, 'RUNNER_ASLEEP');
  assert.equal((await itemsOf(asleep.id)).length, 0, 'not filed');
  assert.equal(alerts.filter((a) => a.conditionId === asleep.id).length, 0, 'not notified');
  assert.deepEqual(await eventsOf(asleep.id), ['CANT_READ']);
});

test('unknown-restarts-hold', { skip }, async () => {
  const w = await world('restart');
  const c = await conditionOf(w, { holdSeconds: 600 });
  await feed(w, reading(c.id, 0, 95), reading(c.id, 300, 95));
  assert.equal((await stateOf(c.id)).state, 'HOLDING');
  await feed(w, failure(c.id, 400), failure(c.id, 500), failure(c.id, 550));
  let row = await stateOf(c.id);
  assert.equal(row.state, 'UNKNOWN');
  assert.equal(row.trueSince, null, 'UNKNOWN clears trueSince');
  assert.equal(firedFor(c.id), 0, 'UNKNOWN never fires, though the hold would have ended at 600 s');
  // The sample that reads again starts the hold over: 650 s after the first true sample is not a completed hold.
  await feed(w, reading(c.id, 650, 95));
  row = await stateOf(c.id);
  assert.equal(row.state, 'HOLDING');
  assert.equal(row.trueSince?.toISOString(), t(650).toISOString());
  await feed(w, reading(c.id, 950, 95));
  assert.equal((await stateOf(c.id)).state, 'HOLDING');
  assert.equal(firedFor(c.id), 0);
  await feed(w, reading(c.id, 1250, 95));
  assert.equal((await stateOf(c.id)).state, 'FIRED', '600 s from the sample that read again');
  assert.deepEqual(await eventsOf(c.id), ['CANT_READ', 'READ_AGAIN', 'FIRED']);

  // Silence restarts it too.
  clockNow = t(0);
  const quiet = await conditionOf(w, { holdSeconds: 600, intervalSeconds: 60 });
  await feed(w, reading(quiet.id, 0, 95), reading(quiet.id, 60, 95));
  clockNow = t(240);
  await conditions.sweep();
  assert.equal((await stateOf(quiet.id)).trueSince, null);
  await feed(w, reading(quiet.id, 700, 95));
  row = await stateOf(quiet.id);
  assert.equal(row.state, 'HOLDING');
  assert.equal(row.trueSince?.toISOString(), t(700).toISOString());
});

type Answer = RunnerHeartbeatResponse & { linkHints?: unknown };

async function beat(runnerId: string, capabilities: string, body: Partial<RunnerHeartbeatRequest> = {}): Promise<Answer> {
  const row = await db.runner.findUniqueOrThrow({ where: { id: runnerId } });
  const dto = { status: 'ONLINE', idleCapacity: 1, version: '0.1.261', leaseOwner: randomUUID(), supervisedSessionIds: [], ...body };
  return await door.heartbeat(row as never, dto as unknown as RunnerHeartbeatRequest, capabilities, 'claude', 'linux') as Answer;
}

test('heartbeat-stores-samples', { skip }, async () => {
  const w = await world('beat');
  const c = await conditionOf(w);
  // Probes go only to a runner that declares condition-probe/v1.
  const without = await beat(w.runnerId, 'source-pin/v1');
  assert.equal('conditionProbes' in without, false);
  const answer = await beat(w.runnerId, `source-pin/v1,${CONDITION_PROBE_CAPABILITY}`);
  assert.deepEqual(answer.conditionProbes, [{
    id: c.id,
    command: c.probeCommand,
    commandHash: conditionCommandHash(c.probeCommand),
    timeoutSeconds: 20,
    intervalSeconds: 300,
    workDir: '/srv/beat',
    env: {},
  }]);
  assert.equal(c.approvedCommandHash, conditionCommandHash(c.probeCommand));

  clockNow = t(300);
  await beat(w.runnerId, CONDITION_PROBE_CAPABILITY, { conditionSamples: [reading(c.id, 0, 80), reading(c.id, 300, 95)] });
  const samples = await db.conditionSample.findMany({ where: { conditionId: c.id }, orderBy: { at: 'asc' } });
  assert.deepEqual(samples.map((s) => [s.at.toISOString(), s.outcome, s.value]), [
    [t(0).toISOString(), 'VALUE', 80],
    [t(300).toISOString(), 'VALUE', 95],
  ]);
  const row = await stateOf(c.id);
  assert.equal(row.state, 'FIRED', 'stored and evaluated, oldest first');
  assert.equal(row.lastValue, 95);

  // A condition of another workspace of the same runner is handed out too; an ENDED one is not.
  const ended = await conditionOf(w);
  await db.condition.update({ where: { id: ended.id }, data: { state: 'ENDED', endedAt: clockNow } });
  const listed = (await beat(w.runnerId, CONDITION_PROBE_CAPABILITY)).conditionProbes!.map((p) => p.id);
  assert.deepEqual(listed, [c.id]);
});

test('no-capability-no-probes', { skip }, async () => {
  const w = await world('nocap');
  await conditionOf(w);
  // A runner that does not declare condition-probe/v1 is sent no conditionProbes at all, not even an empty list:
  // absent is the statement "nothing stated", which an older runner never reads.
  for (const capabilities of ['', 'source-pin/v1,integration-job/v1', 'condition-probe/v2']) {
    const answer = await beat(w.runnerId, capabilities);
    assert.equal('conditionProbes' in answer, false, `no conditionProbes for capabilities "${capabilities}"`);
  }
  assert.equal((await beat(w.runnerId, CONDITION_PROBE_CAPABILITY)).conditionProbes?.length, 1);
});

/** The answer the runner-go side decodes (src/runner-go/condition_probe_wire_test.go). */
const WIRE_FIXTURE = path.resolve(__dirname, '../../../runner-go/testdata/condition-probe/heartbeat-answer.json');

test('heartbeat-wire-fixture', { skip }, async () => {
  const fixture = JSON.parse(readFileSync(WIRE_FIXTURE, 'utf8')) as { conditionProbes: Array<{ id: string; command: string }> };
  const w = await world('wire', { CEPH_CONF: '/etc/ceph/ceph.conf' });
  const c = await conditionOf(w, { command: fixture.conditionProbes[0].command });
  const answer = await beat(w.runnerId, CONDITION_PROBE_CAPABILITY);
  // The answer as it goes on the wire, with the condition's id made the fixture's: every other byte is the server's.
  const wire = JSON.parse(JSON.stringify({ conditionProbes: answer.conditionProbes })) as typeof fixture;
  assert.equal(wire.conditionProbes[0].id, c.id);
  wire.conditionProbes[0].id = fixture.conditionProbes[0].id;
  assert.equal(
    `${JSON.stringify(wire, null, 2)}\n`,
    readFileSync(WIRE_FIXTURE, 'utf8'),
    'the server writes exactly the answer runner-go decodes in TestConditionProbeWireFixture',
  );
});

test('heartbeat-refuses-foreign', { skip }, async () => {
  const w = await world('foreign');
  const c = await conditionOf(w);
  // Another machine of the same owner, and a stranger's machine: neither serves the condition's workspace.
  const other = await machine(w.ownerId, 'other');
  const stranger = await world('stranger');
  for (const runnerId of [other.runnerId, stranger.runnerId]) {
    const answer = await beat(runnerId, CONDITION_PROBE_CAPABILITY, { conditionSamples: [reading(c.id, 0, 95)] });
    assert.deepEqual(answer.conditionProbes, [], 'neither is handed the probe');
  }
  assert.equal(await db.conditionSample.count({ where: { conditionId: c.id } }), 0, 'nothing stored');
  const row = await stateOf(c.id);
  assert.equal(row.state, 'WAITING', 'nothing moved');
  assert.equal(row.lastSampleAt, null);
  assert.equal(await db.conditionEvent.count({ where: { conditionId: c.id } }), 0);
  // The service says so, sample by sample.
  const refused = await conditions.intake({ id: other.runnerId, ownerId: w.ownerId }, [reading(c.id, 0, 95), reading(randomUUID(), 0, 1)]);
  assert.deepEqual(refused, { stored: 0, refused: 2, malformed: 0 });
  // A workspace moved to the other machine moves its condition with it.
  await db.workspace.update({ where: { id: w.workspaceId }, data: { runnerId: other.runnerId } });
  const moved = await conditions.intake({ id: other.runnerId, ownerId: w.ownerId }, [reading(c.id, 0, 95)]);
  assert.equal(moved.stored, 1);
  const old = await conditions.intake({ id: w.runnerId, ownerId: w.ownerId }, [reading(c.id, 300, 95)]);
  assert.equal(old.refused, 1);
});

test('limit, read and attach check', { skip }, async () => {
  const w = await world('limit');
  const made = [];
  for (let i = 0; i < CONDITION_LIMIT_PER_ACCOUNT; i++) made.push(await conditionOf(w));
  await assert.rejects(conditionOf(w), (error: { response?: { code?: string } }) => error.response?.code === CONDITION_LIMIT_REACHED);
  await db.condition.update({ where: { id: made[0].id }, data: { state: 'ENDED', endedAt: clockNow } });
  await conditionOf(w);

  await feed(w, reading(made[1].id, 0, 80), reading(made[1].id, 300, 95));
  const view = await conditions.get(w.ownerId, made[1].id);
  assert.equal(view.state, 'FIRED');
  assert.deepEqual(view.samples.map((s) => s.value), [95, 80], 'newest first');
  assert.deepEqual(view.events.map((e) => e.kind), ['FIRED']);
  assert.deepEqual(view.compare, { op: 'GT', value: 90 });
  const stranger = await world('reader');
  await assert.rejects(conditions.get(stranger.ownerId, made[1].id), { status: 404 });

  // Exactly one of task or schedule.
  await assert.rejects(
    db.condition.create({
      data: {
        ownerId: w.ownerId, workspaceId: w.workspaceId, probeCommand: 'true', compareOp: 'EXIT_ZERO', text: 'x',
        approvedCommandHash: conditionCommandHash('true'), approvedAt: clockNow,
      },
    }),
    /condition_one_attach_chk/,
  );
});
