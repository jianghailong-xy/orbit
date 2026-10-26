/**
 * Runner presence against a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty
 * (migration 0444, docs/runner-link-design.md §5.7 and §6.5), through the production apiserver —
 * `build/main.js`, the whole AppModule — where a route is what is being held to. What it is held to:
 *
 *   (1) 0444 made what it describes: `runner_presence` is UNLOGGED, with its columns, nullability,
 *       primary key, link_state CHECK and a foreign key to `runner` that cascades; 0447 added the two
 *       columns a link heartbeat's fast path reads (`changes`, `reconciled_at`);
 *   (2) RunnerPresenceService.fleetSilence counts the cell's runners heard from within the window and
 *       those of them now past the offline line, leaving out a runner that signed off and managed
 *       runners their manager is putting to sleep or has — read before anything else here makes
 *       runners, so no other runner of the cell can cross a line between its two reads;
 *   (3) the reaper, sweeping this database through its real SQL and transactions: a RUNNING session
 *       whose runner went quiet is reaped `runner offline` in a cell where nearly every runner is heard,
 *       and still when a fifth or more of the runners signed off or were put to sleep by their manager
 *       (their own runs are reaped too); it is held while a fifth or more of the cell has lost contact
 *       at once — though the run of a runner that signed off is still reaped then — and by a reaper
 *       inside its startup grace; and reaped once neither holds. Run before the apiserver starts, so no
 *       second reaper sweeps the same rows;
 *   (4) POST /api/runner/heartbeat upserts the runner's one presence row with every beat — the
 *       process, HTTP, no gateway — and rewrites the runner row's own record only once it is five
 *       minutes old;
 *   (5) every reading answers from presence: with the runner row's own record ten minutes old and a
 *       presence row ten seconds old, the runners list, the runner's own detail, `orbit status`, the
 *       session list (its row and its queue gate) and the session detail all read the runner as
 *       online and show the presence beat as `lastHeartbeatAt`; after a TRUNCATE — what a crash or a
 *       failover does to an UNLOGGED table — the same readings fall back to the ten-minute-old record
 *       and read it offline;
 *   (6) the SQL reading (runnerLastBeatSql, runnerOfflineSql) and the JS reading (runnerLastBeatAt,
 *       runnerIsOnline) give the same answer, runner by runner.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/runners/runner-presence.pg.spec.ts
 *
 * Not destructive: every row belongs to users this run creates, except (5)'s TRUNCATE, which empties
 * a table every heartbeat refills — on the disposable database the script creates.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { JwtService } from '@nestjs/jwt';
import { Prisma, RunStatus, SessionDispatchOrigin, type PrismaClient } from '@prisma/client';
import { toUuid } from '@orbit/shared';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver } from '../auth/pat-test-apiserver';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { ReaperService } from '../realtime/reaper.service';
import {
  RUNNER_BEATS,
  RUNNER_DURABLE_BEAT_EVERY_MS,
  RunnerPresenceService,
  runnerIsOnline,
  runnerLastBeatAt,
  runnerLastBeatSql,
  runnerOfflineSql,
} from './runner-presence';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const MINUTE = 60_000;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const ms = (value: unknown) => new Date(value as string).getTime();

test('runner presence: an UNLOGGED table every heartbeat upserts, and the one source of every liveness reading', {
  skip: !URL, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const db: PrismaClient = prismaClientFor(url);
  const jwtSecret = `runner-presence-spec-${randomUUID()}`;
  const jwt = new JwtService({ secret: jwtSecret, signOptions: { expiresIn: '1h' } });
  let server: Apiserver | null = null;
  t.after(async () => {
    await server?.stop().catch(() => undefined);
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  await verifyCoordinatorPgIdentity(sql);

  async function owner(name: string) {
    const id = randomUUID();
    const email = `${name}-${RUN}@runner-presence.test`;
    await db.user.create({ data: { id, email, name, passwordHash: 'x' } });
    return { id, login: () => jwt.signAsync({ sub: id, email }) };
  }
  async function runner(ownerId: string, name: string, data: Partial<Prisma.RunnerUncheckedCreateInput> = {}) {
    const id = randomUUID();
    const token = randomBytes(32).toString('base64url');
    await db.runner.create({
      data: { id, ownerId, name: `${name}-${RUN}`, tokenHash: sha256(token), status: 'ONLINE', ...data },
    });
    return { id, token };
  }
  /**
   * A managed runner whose manager is putting it to sleep (DRAINING) or has (SLEEPING), last heard
   * `agoMs` ago: its own owner, runner, default workspace and mapping, as the manager keeps one per owner.
   */
  async function managedRunner(state: 'DRAINING' | 'SLEEPING', agoMs: number) {
    const o = await owner(`managed-${randomUUID().slice(0, 8)}`);
    const r = await runner(o.id, `managed-${state.toLowerCase()}`, { lastHeartbeatAt: new Date(Date.now() - 40 * MINUTE) });
    await db.runnerPresence.create({ data: { runnerId: r.id, lastBeatAt: new Date(Date.now() - agoMs), linkState: 'HTTP' } });
    const workspaceId = randomUUID();
    await db.workspace.create({ data: { id: workspaceId, ownerId: o.id, runnerId: r.id, name: `managed-${RUN}`, enabled: true } });
    await db.managedRunner.create({
      data: {
        ownerId: o.id, runnerId: r.id, defaultWorkspaceId: workspaceId, clusterKey: 'presence-spec', namespace: 'orbit',
        pvcName: `mr-data-${r.id}`, desiredState: 'SLEEPING', managementState: state,
      },
    });
    return { runnerId: r.id, ownerId: o.id, workspaceId };
  }

  await t.test('(1) 0444 made an UNLOGGED runner_presence with the columns it describes', async () => {
    const { rows: [table] } = await sql.query(
      `SELECT relpersistence FROM pg_class WHERE oid = 'public.runner_presence'::regclass`,
    );
    assert.equal(table.relpersistence, 'u', 'runner_presence is UNLOGGED: never in the WAL, emptied by a crash');
    const { rows: columns } = await sql.query(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'runner_presence' ORDER BY ordinal_position`,
    );
    assert.deepEqual(columns.map((c) => [c.column_name, c.data_type, c.is_nullable]), [
      ['runner_id', 'uuid', 'NO'],
      ['process_id', 'uuid', 'YES'],
      ['gateway_id', 'text', 'YES'],
      ['last_beat_at', 'timestamp without time zone', 'NO'],
      ['link_state', 'text', 'NO'],
      ['facts_hash', 'text', 'YES'],
      ['reconcile_hash', 'text', 'YES'],
      // 0447: what a link heartbeat answers from this row alone needs (runner-api/link-heartbeat.ts).
      ['changes', 'bigint', 'NO'],
      ['reconciled_at', 'timestamp without time zone', 'YES'],
    ]);
    const { rows: [pk] } = await sql.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'runner_presence_pkey'`,
    );
    assert.equal(pk.def, 'PRIMARY KEY (runner_id)');
    const { rows: [fk] } = await sql.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'runner_presence_runner_id_fkey'`,
    );
    assert.match(fk.def, /FOREIGN KEY \(runner_id\) REFERENCES runner\(id\) ON UPDATE CASCADE ON DELETE CASCADE/);
    const { rows: triggers } = await sql.query(
      `SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.runner_presence'::regclass AND NOT tgisinternal`,
    );
    assert.deepEqual(triggers, [], 'no trigger hangs off it');

    const alice = await owner('alice');
    const r = await runner(alice.id, 'schema');
    await assert.rejects(
      db.runnerPresence.create({ data: { runnerId: r.id, lastBeatAt: new Date(), linkState: 'CARRIER PIGEON' } }),
      /runner_presence_link_state_chk|check constraint/i,
      'link_state is HTTP or LINK',
    );
    await db.runnerPresence.create({ data: { runnerId: r.id, lastBeatAt: new Date(), linkState: 'LINK', gatewayId: 'gw-1' } });
    await db.runner.delete({ where: { id: r.id } });
    assert.equal(await db.runnerPresence.count({ where: { runnerId: r.id } }), 0, 'the row goes with its runner');
  });

  await t.test('(2) fleetSilence counts the runners heard from within the window, and those since gone quiet', async () => {
    const erin = await owner('erin');
    const presence = new RunnerPresenceService(db as unknown as PrismaService);
    const window = 10 * MINUTE;
    const before = await presence.fleetSilence(window);
    const now = Date.now();
    const lastHeard = [20_000, 3 * MINUTE, 6 * MINUTE, 30 * MINUTE];
    for (const [i, ago] of lastHeard.entries()) {
      const r = await runner(erin.id, `fleet-${i}`, { lastHeartbeatAt: new Date(now - 40 * MINUTE) });
      await db.runnerPresence.create({ data: { runnerId: r.id, lastBeatAt: new Date(now - ago), linkState: 'HTTP' } });
    }
    // Heard from only through its own record, five minutes ago: a row the table lost still counts.
    await runner(erin.id, 'fleet-record', { lastHeartbeatAt: new Date(now - 5 * MINUTE) });
    // Quiet on purpose, and counted in neither number: a runner that signed off, and managed runners
    // their manager has put to sleep or is putting to sleep — heard as lately as the counted ones.
    const signedOff = await runner(erin.id, 'fleet-signed-off', { status: 'OFFLINE', lastHeartbeatAt: new Date(now - 40 * MINUTE) });
    await db.runnerPresence.create({ data: { runnerId: signedOff.id, lastBeatAt: new Date(now - 3 * MINUTE), linkState: 'HTTP' } });
    await managedRunner('SLEEPING', 3 * MINUTE);
    await managedRunner('DRAINING', 20_000);
    const after = await presence.fleetSilence(window);
    assert.deepEqual(
      { heard: after.heard - before.heard, silent: after.silent - before.silent },
      { heard: 4, silent: 3 },
      'heard within 90 s + 10 min: 20 s, 3 min, 5 min (record) and 6 min ago; past the line: all but the 20 s one; '
        + 'the runner that signed off and the two managed runners put to sleep are not counted',
    );
  });

  await t.test('(3) the reaper on this database: a silent runner’s run is reaped in a quiet cell and among runners quiet on purpose, and held while a fifth of the cell is silent or the reaper has just started', async () => {
    const fay = await owner('fay');
    const presence = new RunnerPresenceService(db as unknown as PrismaService);
    const realtime = {
      requestCancel: () => undefined,
      publish: () => undefined,
      publishTaskChanged: () => undefined,
      publishQueuedTurnsChanged: () => undefined,
    } as never;
    // A new reaper each time, so no hold one sweep saw is carried into the next case.
    const reaperOf = () => new ReaperService(db as unknown as PrismaService, realtime, undefined, presence);
    const sweep = (reaper: ReaperService) => (reaper as unknown as { sweep(): Promise<void> }).sweep();
    const now = Date.now();
    // The runner that went quiet: its presence row four minutes old, its own record ten.
    const silent = await runner(fay.id, 'silent', { lastHeartbeatAt: new Date(now - 10 * MINUTE) });
    await db.runnerPresence.create({ data: { runnerId: silent.id, lastBeatAt: new Date(now - 4 * MINUTE), linkState: 'HTTP' } });
    const workspaceId = randomUUID();
    await db.workspace.create({ data: { id: workspaceId, ownerId: fay.id, runnerId: silent.id, name: `reaper-${RUN}`, enabled: true } });
    const running = async (
      title: string,
      on: { runnerId: string; ownerId: string; workspaceId: string } = { runnerId: silent.id, ownerId: fay.id, workspaceId },
    ) => {
      const id = randomUUID();
      await db.session.create({
        data: {
          id, ownerId: on.ownerId, creatorId: on.ownerId, workspaceId: on.workspaceId, assignedRunnerId: on.runnerId, title, prompt: title,
          provider: 'claude', providerBuiltin: true, status: RunStatus.RUNNING, runtimeSessionId: randomUUID(),
          startedAt: new Date(now - 10 * MINUTE), runClaimedAt: new Date(now - 10 * MINUTE),
          dispatchOrigin: SessionDispatchOrigin.USER,
        },
      });
      return id;
    };
    const stateOf = (id: string) => db.session.findUniqueOrThrow({ where: { id }, select: { status: true, error: true } });
    // Thirty runners heard five seconds ago: one silent runner among them is a machine, not an outage.
    const crowd: string[] = [];
    for (let i = 0; i < 30; i += 1) {
      const r = await runner(fay.id, `crowd-${i}`, { lastHeartbeatAt: new Date(now - 10 * MINUTE) });
      await db.runnerPresence.create({ data: { runnerId: r.id, lastBeatAt: new Date(now - 5_000), linkState: 'HTTP' } });
      crowd.push(r.id);
    }
    const quiet = await presence.fleetSilence(10 * MINUTE);
    assert.ok(quiet.silent / quiet.heard < 0.2, `the cell is quiet: ${JSON.stringify(quiet)}`);
    const reaped = await running('reaped in a quiet cell');
    await sweep(reaperOf());
    assert.deepEqual(await stateOf(reaped), { status: RunStatus.FAILED, error: 'runner offline' });

    // Fifteen runners sign off: a third of every runner here went quiet together, on purpose. That is
    // no outage — the cell's count leaves them out — and their runs are reaped as they always were.
    const beforeSignOff = await presence.fleetSilence(10 * MINUTE);
    const signedOff: string[] = [];
    for (let i = 0; i < 15; i += 1) {
      const r = await runner(fay.id, `signed-off-${i}`, { status: 'OFFLINE', lastHeartbeatAt: new Date(now - 10 * MINUTE) });
      await db.runnerPresence.create({ data: { runnerId: r.id, lastBeatAt: new Date(Date.now() - 2 * MINUTE), linkState: 'HTTP' } });
      signedOff.push(r.id);
    }
    assert.deepEqual(await presence.fleetSilence(10 * MINUTE), beforeSignOff, 'runners that signed off are not counted');
    const amongSignedOff = await running('reaped while a third of the runners have signed off');
    const ofSignedOff = await running('run of a runner that signed off', { runnerId: signedOff[0], ownerId: fay.id, workspaceId });
    await sweep(reaperOf());
    assert.deepEqual(await stateOf(amongSignedOff), { status: RunStatus.FAILED, error: 'runner offline' });
    assert.deepEqual(await stateOf(ofSignedOff), { status: RunStatus.FAILED, error: 'runner offline' });

    // Twelve managed runners put to sleep, or being put to sleep, by their manager: quiet on purpose too.
    const beforeSleep = await presence.fleetSilence(10 * MINUTE);
    const asleep = [];
    for (let i = 0; i < 12; i += 1) asleep.push(await managedRunner(i % 2 === 0 ? 'SLEEPING' : 'DRAINING', 2 * MINUTE));
    assert.deepEqual(await presence.fleetSilence(10 * MINUTE), beforeSleep, 'managed runners put to sleep are not counted');
    const amongAsleep = await running('reaped while a fifth of the runners are asleep');
    const ofAsleep = await running('run of a managed runner put to sleep', asleep[0]);
    await sweep(reaperOf());
    assert.deepEqual(await stateOf(amongAsleep), { status: RunStatus.FAILED, error: 'runner offline' });
    assert.deepEqual(await stateOf(ofAsleep), { status: RunStatus.FAILED, error: 'runner offline' });

    // The crowd goes quiet together — a gateway, the network, this control plane: contact lost.
    await db.runnerPresence.updateMany({ where: { runnerId: { in: crowd } }, data: { lastBeatAt: new Date(Date.now() - 2 * MINUTE) } });
    const loud = await presence.fleetSilence(10 * MINUTE);
    assert.ok(loud.silent / loud.heard >= 0.2, `a fifth of the cell is silent: ${JSON.stringify(loud)}`);
    const held = await running('held through a mass silence');
    const signedOffMeanwhile = await running('run of a runner that signed off, during the mass silence', {
      runnerId: signedOff[1], ownerId: fay.id, workspaceId,
    });
    await sweep(reaperOf());
    assert.equal((await stateOf(held)).status, RunStatus.RUNNING, 'nothing silent is reaped while a fifth of the cell is silent');
    assert.deepEqual(await stateOf(signedOffMeanwhile), { status: RunStatus.FAILED, error: 'runner offline' },
      'a runner that signed off said so itself: the hold is over silence, and does not keep its run');

    // The crowd is heard again; a reaper that has only just started still holds.
    await db.runnerPresence.updateMany({ where: { runnerId: { in: crowd } }, data: { lastBeatAt: new Date() } });
    const started = reaperOf();
    started.onModuleInit();
    try {
      await sweep(started);
      assert.equal((await stateOf(held)).status, RunStatus.RUNNING, 'nor inside the startup grace');
    } finally {
      started.onModuleDestroy();
    }
    // A reaper past its grace, in a cell heard again: the silent runner's run is reaped.
    await sweep(reaperOf());
    assert.deepEqual(await stateOf(held), { status: RunStatus.FAILED, error: 'runner offline' });
  });

  server = await startApiserver(url, jwtSecret);

  await t.test('(4) every heartbeat upserts the presence row; the runner row’s own record moves every five minutes', async () => {
    const bob = await owner('bob');
    const recordedAt = new Date(Date.now() - MINUTE);
    const r = await runner(bob.id, 'beats', { lastHeartbeatAt: recordedAt });
    const leaseOwner = randomUUID();
    const before = Date.now();
    const first = await call(server!, 'POST', '/api/runner/heartbeat', r.token, { status: 'ONLINE', idleCapacity: 1, leaseOwner });
    assert.equal(first.status, 201, first.text);
    const row = await db.runnerPresence.findUniqueOrThrow({ where: { runnerId: r.id } });
    assert.equal(row.processId, leaseOwner);
    assert.equal(row.linkState, 'HTTP');
    assert.equal(row.gatewayId, null);
    assert.equal(row.factsHash, null);
    assert.equal(row.reconcileHash, null);
    assert.ok(row.lastBeatAt.getTime() >= before - 1_000 && row.lastBeatAt.getTime() <= Date.now() + 1_000);
    const own = await db.runner.findUniqueOrThrow({ where: { id: r.id }, select: { lastHeartbeatAt: true } });
    assert.equal(own.lastHeartbeatAt?.getTime(), recordedAt.getTime(), 'a record a minute old is left as it is');

    // A process without a lease owner (an older runner) still beats; the row records that it named none.
    const second = await call(server!, 'POST', '/api/runner/heartbeat', r.token, { status: 'ONLINE', idleCapacity: 1 });
    assert.equal(second.status, 201, second.text);
    const again = await db.runnerPresence.findMany({ where: { runnerId: r.id } });
    assert.equal(again.length, 1, 'one row per runner');
    assert.ok(again[0].lastBeatAt.getTime() >= row.lastBeatAt.getTime());
    assert.equal(again[0].processId, null);

    const stale = await runner(bob.id, 'stale', { lastHeartbeatAt: new Date(Date.now() - RUNNER_DURABLE_BEAT_EVERY_MS - 1_000) });
    const beat = await call(server!, 'POST', '/api/runner/heartbeat', stale.token, { status: 'ONLINE', idleCapacity: 1, leaseOwner });
    assert.equal(beat.status, 201, beat.text);
    const staleRow = await db.runnerPresence.findUniqueOrThrow({ where: { runnerId: stale.id } });
    const staleOwn = await db.runner.findUniqueOrThrow({ where: { id: stale.id }, select: { lastHeartbeatAt: true } });
    assert.equal(staleOwn.lastHeartbeatAt?.getTime(), staleRow.lastBeatAt.getTime(), 'a five-minute-old record takes the beat');
  });

  await t.test('(5) every reading answers from presence, and falls back to the runner’s own record when the table is emptied', async () => {
    const carol = await owner('carol');
    const jwtToken = await carol.login();
    const recordedAt = new Date(Date.now() - 10 * MINUTE);
    const r = await runner(carol.id, 'readings', { lastHeartbeatAt: recordedAt, maxConcurrent: 4 });
    const beatAt = new Date(Date.now() - 10_000);
    await db.runnerPresence.create({ data: { runnerId: r.id, lastBeatAt: beatAt, linkState: 'HTTP' } });
    const workspaceId = randomUUID();
    await db.workspace.create({ data: { id: workspaceId, ownerId: carol.id, runnerId: r.id, name: `presence-${RUN}`, enabled: true } });
    const queuedId = randomUUID();
    const endedId = randomUUID();
    await db.session.create({
      data: {
        id: queuedId, ownerId: carol.id, creatorId: carol.id, workspaceId, assignedRunnerId: r.id, title: 'queued',
        prompt: 'queued', provider: 'claude', providerBuiltin: true, status: RunStatus.PENDING,
        dispatchOrigin: SessionDispatchOrigin.USER,
      },
    });
    await db.session.create({
      data: {
        id: endedId, ownerId: carol.id, creatorId: carol.id, workspaceId, assignedRunnerId: r.id, title: 'ended',
        prompt: 'ended', provider: 'claude', providerBuiltin: true, status: RunStatus.SUCCEEDED,
        startedAt: new Date(Date.now() - 20 * MINUTE), finishedAt: new Date(Date.now() - 15 * MINUTE),
        numTurns: 1, runtimeSessionId: randomUUID(), dispatchOrigin: SessionDispatchOrigin.USER,
      },
    });

    async function readings() {
      const runners = await call(server!, 'GET', '/api/runners', jwtToken);
      assert.equal(runners.status, 200, runners.text);
      const listed = (runners.json as Array<Record<string, unknown>>).find((x) => toUuid(String(x.id)) === r.id)!;
      const detail = await call(server!, 'GET', `/api/runners/${r.id}`, jwtToken);
      assert.equal(detail.status, 200, detail.text);
      const me = await call(server!, 'GET', '/api/runner/me', r.token);
      assert.equal(me.status, 200, me.text);
      const sessions = await call(server!, 'GET', '/api/sessions?view=open', jwtToken);
      assert.equal(sessions.status, 200, sessions.text);
      const row = (sessions.json as Array<Record<string, any>>).find((x) => toUuid(String(x.id)) === queuedId)!;
      const ended = await call(server!, 'GET', `/api/sessions/${endedId}`, jwtToken);
      assert.equal(ended.status, 200, ended.text);
      return { listed, detail: detail.json, me: me.json, row, ended: ended.json };
    }

    const live = await readings();
    assert.equal(live.listed.online, true, 'the runners list reads the presence row');
    assert.equal(ms(live.listed.lastHeartbeatAt), beatAt.getTime(), 'and shows its beat, not the ten-minute-old record');
    assert.equal('presence' in live.listed, false);
    assert.equal(live.detail.online, true);
    assert.equal(ms(live.detail.lastHeartbeatAt), beatAt.getTime());
    assert.equal(live.me.online, true, '`orbit status` too');
    assert.equal(ms(live.me.lastHeartbeatAt), beatAt.getTime());
    assert.equal(ms(live.row.assignedRunner.lastHeartbeatAt), beatAt.getTime(), 'the session list row');
    assert.notEqual(live.row.queuedReason, 'runner_offline', 'and its queue gate');
    assert.equal(ms(live.ended.assignedRunner.lastHeartbeatAt), beatAt.getTime(), 'the session detail');
    assert.equal('presence' in live.ended.assignedRunner, false);
    assert.equal(live.ended.capabilities.canResume, true, 'whose resume gate reads it online');

    // What a crash or a failover of the primary does to an UNLOGGED table.
    await sql.query('TRUNCATE runner_presence');
    const fallen = await readings();
    assert.equal(fallen.listed.online, false, 'the record alone is ten minutes old');
    assert.equal(ms(fallen.listed.lastHeartbeatAt), recordedAt.getTime(), 'and is what every reading falls back to');
    assert.equal(fallen.me.online, false);
    assert.equal(ms(fallen.me.lastHeartbeatAt), recordedAt.getTime());
    assert.equal(fallen.row.queuedReason, 'runner_offline');
    assert.equal(ms(fallen.row.assignedRunner.lastHeartbeatAt), recordedAt.getTime());
    assert.equal(fallen.ended.capabilities.canResume, false);
    assert.equal(fallen.ended.capabilities.resumeBlockedReason, 'RUNNER_OFFLINE');

    // The runner's next beat is all it takes to be read as present again.
    const beat = await call(server!, 'POST', '/api/runner/heartbeat', r.token, { status: 'ONLINE', idleCapacity: 1 });
    assert.equal(beat.status, 201, beat.text);
    const back = await readings();
    assert.equal(back.listed.online, true);
    assert.notEqual(back.row.queuedReason, 'runner_offline');
  });

  await t.test('(6) the SQL reading and the JS reading agree, runner by runner', async () => {
    const dave = await owner('dave');
    const now = Date.now();
    const cases: Array<{ status: 'ONLINE' | 'OFFLINE'; recordAgo: number | null; beatAgo: number | null }> = [];
    for (const status of ['ONLINE', 'OFFLINE'] as const) {
      for (const recordAgo of [null, 20_000, 10 * MINUTE]) {
        for (const beatAgo of [null, 20_000, 3 * MINUTE]) cases.push({ status, recordAgo, beatAgo });
      }
    }
    const ids: string[] = [];
    for (const [i, c] of cases.entries()) {
      const r = await runner(dave.id, `parity-${i}`, {
        status: c.status,
        lastHeartbeatAt: c.recordAgo === null ? null : new Date(now - c.recordAgo),
      });
      if (c.beatAgo !== null) {
        await db.runnerPresence.create({ data: { runnerId: r.id, lastBeatAt: new Date(now - c.beatAgo), linkState: 'HTTP' } });
      }
      ids.push(r.id);
    }
    const rows = await db.runner.findMany({ where: { id: { in: ids } }, select: { id: true, status: true, ...RUNNER_BEATS } });
    const read = await db.$queryRaw<Array<{ id: string; beat: Date | null; online: boolean }>>(Prisma.sql`
      SELECT r.id, ${runnerLastBeatSql('r')} AS beat, NOT ${runnerOfflineSql('r')} AS online
        FROM runner r WHERE r.id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
    `);
    const bySql = new Map(read.map((x) => [x.id, x]));
    for (const [i, id] of ids.entries()) {
      const row = rows.find((x) => x.id === id)!;
      const fromSql = bySql.get(id)!;
      const label = JSON.stringify(cases[i]);
      assert.equal(fromSql.beat?.getTime() ?? null, runnerLastBeatAt(row)?.getTime() ?? null, `beat: ${label}`);
      assert.equal(fromSql.online, runnerIsOnline(row), `online: ${label}`);
    }
    // And the cases say what they should: a fresh presence row makes a runner whose record is stale
    // online; a stale or missing one leaves it to the record; OFFLINE is offline whatever beat it has.
    const verdict = (status: string, recordAgo: number | null, beatAgo: number | null) =>
      bySql.get(ids[cases.findIndex((c) => c.status === status && c.recordAgo === recordAgo && c.beatAgo === beatAgo)])!.online;
    assert.equal(verdict('ONLINE', 10 * MINUTE, 20_000), true);
    assert.equal(verdict('ONLINE', 10 * MINUTE, 3 * MINUTE), false);
    assert.equal(verdict('ONLINE', 20_000, null), true);
    assert.equal(verdict('ONLINE', null, null), false);
    assert.equal(verdict('OFFLINE', 20_000, 20_000), false);
  });

});
