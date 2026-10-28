/**
 * Mass disconnections injected into a cell of two production apiservers over one database (docs/runner-link-design.md
 * §6.5). Two `node build/main.js` processes, the whole AppModule each, with the runner link on; the reaper sweeps on
 * whichever of them holds the singleton sweeps' lock (realtime/control-plane-leader.ts), on its own timer, as it does
 * in production. The runners are what the link gateway makes of them: each connection's Welcome and each heartbeat is a
 * call on one of the two processes' link listeners, the process picked at random for every call, as the gateway spreads
 * its calls over every apiserver it is given (src/link-gateway/backend.go).
 *
 * The cell: FLEET runners beating every 30 s from phases spread across the period, each supervising one RUNNING session
 * leased to its process, and two runners more for the cases about a runner lost on its own. A runner cut off stops
 * beating. One that comes back connects through the other gateway node — a Welcome — beats at once, and every 30 s from
 * there. Each case runs on the clock, after the reaper's startup grace:
 *
 *   (1) one runner lost in a cell otherwise heard: its run is reaped `runner offline` at the first sweep after it is past
 *       the 90 s line, as it always was;
 *   (2) every runner cut off at once, more than eight in ten back within 60 s and the rest between 95 and 150 s: no run is
 *       reaped, though the reaper reads the late runners as offline and says so (`not reaping`);
 *   (3) every runner cut off at once, nine in ten back within 30 s and the rest between 95 and 150 s: the same;
 *   (4) a runner lost on its own a minute into (3), inside the window (3)'s runners are held for: reaped as in (1);
 *   (5) every runner cut off at once and none of them back: no run is reaped while its runner has been silent for no
 *       longer than RUNNER_SILENT_AFTER_MS + MASS_SILENCE_WINDOW_MS, and each is reaped at the first sweep after that.
 *
 * Throughout, the lock stays with the process that took it, and the other process's reaper says nothing.
 *
 *   RUN_PG_SPEC_TIMEOUT=2700 bash scripts/run-pg-spec.sh src/apiserver/src/realtime/reaper-mass-disconnect.pg.spec.ts
 *
 * About 25 minutes on the clock. REAPER_MASS_DISCONNECT_CASES names the cases to run (default 1,2,3,4,5): `2,3` is the
 * control against a reaper that reaps the late runners of a reconnection. Not destructive: every row belongs to the user
 * this run creates, on the disposable database the script creates.
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Prisma, RunStatus, SessionDispatchOrigin, type PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { startApiserver, type Apiserver } from '../auth/pat-test-apiserver';
import { sha256 } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { readRunnerLink, runnerLinkCredential, signRunnerLinkToken } from '../runner-api/runner-link-token';
import { RUNNER_HEARTBEAT_EVERY_MS, RUNNER_OFFLINE_AFTER_MS, RUNNER_SILENT_AFTER_MS } from '../runners/runner-presence';
import { SINGLETON_SWEEPS_LOCK } from './control-plane-leader';
import { MASS_SILENCE_WINDOW_MS, STARTUP_GRACE_MS } from './reaper.service';

const URL = process.env.COORDINATOR_PG_URL;
const SECOND = 1_000;
/** The reaper's REAP_INTERVAL_MS: how far apart its sweeps are. */
const SWEEP_EVERY = 30 * SECOND;
/** How late after the sweep it is due a reaping may land: the sweep's own reads and writes. */
const SWEEP_SLACK = 5 * SECOND;
/** Runners in the cell the mass cases cut off. */
const FLEET = 24;
const GATEWAY_TOKEN = `reaper-mass-disconnect-gateway:${randomBytes(24).toString('hex')}`;
const PROVIDERS = 'claude';
const CASES = new Set((process.env.REAPER_MASS_DISCONNECT_CASES ?? '1,2,3,4,5').split(',').map((c) => c.trim()));
/** The schedule's seed, printed, so that a run can be repeated. */
const SEED = Number(process.env.REAPER_MASS_DISCONNECT_SEED ?? Date.now() % 1_000_000);

/** mulberry32: the same return times for the same seed. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

interface Answer {
  status: number;
  body: unknown;
}

/** One call on a link listener, on a connection of its own, as the gateway's backend client makes it. */
function send(port: number, pathname: string, headers: Record<string, string>, body: unknown): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = httpRequest(
      {
        host: '127.0.0.1', port, method: 'POST', path: pathname, agent: false,
        headers: { 'content-type': 'application/json', 'content-length': String(payload.length), ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = text;
          try {
            parsed = text === '' ? null : JSON.parse(text);
          } catch {
            /* not JSON: kept as text */
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

/** An apiserver process as the runners reach it: its link listener, and what it wrote, line by line, as it came. */
interface Door {
  name: string;
  server: Apiserver;
  linkPort: number;
  lines: Array<{ at: number; text: string }>;
}

/** A simulated runner: its process, the link token that process connects with, and the session it supervises. */
interface Sim {
  name: string;
  runnerId: string;
  process: string;
  link: string;
  sessionId: string;
  gateway: string;
  connected: boolean;
  nextBeatAt: number;
  inFlight: boolean;
  /** Beats answered so far. */
  beats: number;
}

test('a mass disconnection reaps no run whose runner comes back, on a cell of two apiservers', {
  skip: !URL, concurrency: 1, timeout: 45 * 60 * SECOND,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db: PrismaClient = prismaClientFor(url);
  const random = prng(SEED);
  t.diagnostic(`seed ${SEED}`);

  // ── the cell's two apiservers, the runner link on in both ───────────────────────────────────────────────────────
  const { privateKey } = generateKeyPairSync('ed25519');
  const linkEnv = {
    RUNNER_LINK_SIGNING_KEY: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'utf8').toString('base64'),
    RUNNER_LINK_URL: 'wss://link.mass-disconnect.invalid',
    RUNNER_LINK_GATEWAY_TOKEN: GATEWAY_TOKEN,
  };
  const link = readRunnerLink({ signingKey: linkEnv.RUNNER_LINK_SIGNING_KEY, linkUrl: linkEnv.RUNNER_LINK_URL, gatewayToken: GATEWAY_TOKEN });
  assert.ok(link.config, `the test link did not configure: ${link.problems.join('; ')}`);
  const jwtSecret = `reaper-mass-disconnect-${randomUUID()}`;
  const doors: Door[] = [];
  let driving = true;
  let driver: Promise<void> | undefined;
  t.after(async () => {
    driving = false;
    await driver?.catch(() => undefined);
    for (const door of doors) await door.server.stop().catch(() => undefined);
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  for (const name of ['apiserver-a', 'apiserver-b']) {
    const linkPort = await freePort();
    const server = await startApiserver(url, jwtSecret, { ...linkEnv, RUNNER_LINK_INTERNAL_PORT: String(linkPort) });
    const lines: Door['lines'] = [];
    let rest = '';
    const take = (chunk: Buffer) => {
      const parts = (rest + chunk.toString('utf8')).split('\n');
      rest = parts.pop() ?? '';
      const at = Date.now();
      for (const text of parts) lines.push({ at, text });
    };
    server.child.stdout!.on('data', take);
    server.child.stderr!.on('data', take);
    doors.push({ name, server, linkPort, lines });
  }
  const bootedAt = Date.now();

  /** The process holding the singleton sweeps' lock now, by the name its coordination connection carries. */
  const holderOfTheLock = async (): Promise<string | null> => {
    const { rows } = await sql.query<{ name: string }>(
      `SELECT a.application_name AS "name"
         FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
          AND ((l.classid::bigint << 32) | l.objid::bigint) = hashtextextended($1, 0)`,
      [SINGLETON_SWEEPS_LOCK],
    );
    assert.ok(rows.length <= 1, `one holder at most: ${JSON.stringify(rows)}`);
    return rows[0]?.name.replace(/^orbit-apiserver /, '') ?? null;
  };
  let holder: string | null = null;
  for (let i = 0; i < 200 && holder === null; i += 1) {
    holder = await holderOfTheLock();
    if (holder === null) await sleep(50);
  }
  assert.ok(holder, 'one of the two processes holds the singleton sweeps\' lock');
  const ledBy = (door: Door) =>
    door.server.output().includes(`apiserver process ${holder!.slice(0, 8)} now runs the reaper, the task sweep and the auto-retry sweep`);
  const leaders = doors.filter(ledBy);
  assert.equal(leaders.length, 1, 'exactly one of the two says it runs the reaper');
  const leader = leaders[0]!;
  const follower = doors.find((door) => door !== leader)!;
  t.diagnostic(`${leader.name} holds the lock (process ${holder.slice(0, 8)}); ${follower.name} waits`);

  // ── the cell: one account, its runners, a session each ───────────────────────────────────────────────────────────
  const ownerId = randomUUID();
  await db.user.create({ data: { id: ownerId, email: `mass-disconnect-${ownerId}@runner-link.invalid`, name: 'cell', passwordHash: 'x' } });
  const workspaceId = randomUUID();
  const everyone: Sim[] = [];
  const startedSession = async (runnerId: string, process: string, title: string): Promise<string> => {
    const sessionId = randomUUID();
    const generation = randomUUID();
    await db.session.create({
      data: {
        id: sessionId, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId, title, prompt: title,
        provider: 'claude', providerBuiltin: true, status: RunStatus.RUNNING, runtimeSessionId: randomUUID(),
        startedAt: new Date(Date.now() - 10 * 60 * SECOND), runClaimedAt: new Date(Date.now() - 10 * 60 * SECOND),
        dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: false,
        inboxLeaseOwner: process, inboxLeaseGeneration: generation,
      },
    });
    await db.inboxLeaseGeneration.create({ data: { generation, sessionId, leaseOwner: process } });
    return sessionId;
  };
  const total = FLEET + 2;
  for (let i = 0; i < total; i += 1) {
    const runnerId = randomUUID();
    const runnerToken = `mass-disconnect-runner-${i}:${randomUUID()}`;
    const process = randomUUID();
    await db.runner.create({
      data: {
        id: runnerId, ownerId, name: `runner-${i}`, tokenHash: sha256(runnerToken), status: 'ONLINE', maxConcurrent: 4,
        lastHeartbeatAt: new Date(Date.now() - 10 * 60 * SECOND),
      },
    });
    if (i === 0) await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: 'cell', enabled: true } });
    const name = i < FLEET ? `fleet-${i}` : `alone-${i - FLEET + 1}`;
    everyone.push({
      name, runnerId, process,
      link: signRunnerLinkToken(
        link.config, { runnerId, ownerId, cellId: 'cell-1', leaseOwner: process, credential: runnerLinkCredential(sha256(runnerToken)) }, new Date(),
      ).token,
      sessionId: await startedSession(runnerId, process, name),
      gateway: i % 2 === 0 ? 'link-gateway-1' : 'link-gateway-2',
      connected: true,
      // The fleet's beats spread across the period, as runners started at different times beat.
      nextBeatAt: Date.now() + Math.floor((i * RUNNER_HEARTBEAT_EVERY_MS) / total),
      inFlight: false,
      beats: 0,
    });
  }
  const fleet = everyone.slice(0, FLEET);
  const [alone1, alone2] = everyone.slice(FLEET) as [Sim, Sim];

  // ── the runners, as the link gateway carries them ────────────────────────────────────────────────────────────────
  const failures: string[] = [];
  const viaGateway = (r: Sim): Record<string, string> => ({
    authorization: `Bearer ${GATEWAY_TOKEN}`,
    'x-orbit-runner-link-token': r.link,
    'x-orbit-link-gateway-id': r.gateway,
    'x-orbit-supported-providers': PROVIDERS,
  });
  /** The process a call goes to: any of the two, as the gateway picks a backend. */
  const anyDoor = () => doors[Math.floor(Math.random() * doors.length)]!;
  const beat = async (r: Sim) => {
    const door = anyDoor();
    const answer = await send(door.linkPort, '/api/runner/heartbeat', viaGateway(r), {
      status: 'ONLINE', idleCapacity: 1, leaseOwner: r.process, supervisedSessionIds: [r.sessionId],
    });
    if (answer.status !== 201) failures.push(`${r.name}'s beat through ${door.name}: ${answer.status} ${JSON.stringify(answer.body)}`);
    else r.beats += 1;
  };
  const welcome = async (r: Sim) => {
    const door = anyDoor();
    const answer = await send(door.linkPort, '/api/runner/link/welcome', viaGateway(r), { sessionIds: [r.sessionId] });
    const sessions = (answer.body as { sessions?: Array<{ leaseHeld?: boolean }> } | null)?.sessions;
    if (answer.status !== 200 || sessions?.[0]?.leaseHeld !== true) {
      failures.push(`${r.name}'s welcome through ${door.name}: ${answer.status} ${JSON.stringify(answer.body)}`);
    }
  };
  driver = (async () => {
    while (driving) {
      const now = Date.now();
      for (const r of everyone) {
        if (!r.connected || r.inFlight || now < r.nextBeatAt) continue;
        r.inFlight = true;
        r.nextBeatAt += RUNNER_HEARTBEAT_EVERY_MS;
        void beat(r)
          .catch((error: unknown) => failures.push(`${r.name}'s beat: ${(error as Error).message}`))
          .finally(() => { r.inFlight = false; });
      }
      await sleep(100);
    }
  })();
  /** Until no beat of `r` is on its way: what it sent before it was cut off lands, as a frame already sent does. */
  const settled = async (r: Sim) => { while (r.inFlight) await sleep(20); };
  /** Cut off: no more beats. */
  const cut = async (r: Sim) => {
    r.connected = false;
    await settled(r);
  };
  /** Back: a new connection, through the other gateway node, its Welcome, a beat at once and every period from there. */
  const comeBack = async (r: Sim) => {
    r.gateway = r.gateway === 'link-gateway-1' ? 'link-gateway-2' : 'link-gateway-1';
    await welcome(r);
    r.nextBeatAt = Date.now();
    r.connected = true;
  };
  /** Cut off just after its next beat landed, so that its silence starts from a beat this run saw: that beat's instant. */
  const cutAfterItsNextBeat = async (r: Sim): Promise<number> => {
    const answered = r.beats;
    while (r.beats === answered) await sleep(20);
    await cut(r);
    return lastBeatAt(r);
  };
  const lastBeatAt = async (r: Sim): Promise<number> => {
    const [row] = await db.$queryRaw<Array<{ at: Date }>>(Prisma.sql`
      SELECT GREATEST(p."last_beat_at", r."last_heartbeat_at") AS "at"
        FROM "runner" r LEFT JOIN "runner_presence" p ON p."runner_id" = r."id"
       WHERE r."id" = ${r.runnerId}::uuid`);
    return row!.at.getTime();
  };
  const sessionOf = (r: Sim) =>
    db.session.findUniqueOrThrow({ where: { id: r.sessionId }, select: { status: true, error: true, finishedAt: true } });
  const signOff = (r: Sim) => db.runner.update({ where: { id: r.runnerId }, data: { status: 'OFFLINE' } });
  /** What the leader's reaper said from `since` on. */
  const reaperSaid = (door: Door, since: number) =>
    door.lines.filter((line) => line.at >= since && line.text.includes('[Reaper]')).map((line) => line.text);
  const stillLeads = async () => {
    assert.equal(await holderOfTheLock(), holder, `${leader.name} still holds the lock`);
    assert.deepEqual(reaperSaid(follower, bootedAt), [], `${follower.name}, which does not hold the lock, sweeps nothing`);
  };
  /** A reaping of `r`'s run: when its session was finalized `runner offline`, or null while it runs. */
  const reapedAt = async (r: Sim): Promise<number | null> => {
    const s = await sessionOf(r);
    if (s.status === RunStatus.RUNNING) return null;
    assert.deepEqual({ status: s.status, error: s.error }, { status: RunStatus.FAILED, error: 'runner offline' }, r.name);
    return s.finishedAt!.getTime();
  };
  /**
   * A reaping one runner lost on its own gets, as it always did: past the offline line, at the first sweep after it —
   * no sooner than RUNNER_OFFLINE_AFTER_MS after its last beat and no later than a sweep interval past that.
   */
  const reapedAsAlone = async (r: Sim, lastBeat: number) => {
    const deadline = lastBeat + RUNNER_OFFLINE_AFTER_MS + SWEEP_EVERY + SWEEP_SLACK;
    let at: number | null = null;
    while (at === null && Date.now() < deadline + SECOND) {
      at = await reapedAt(r);
      if (at === null) await sleep(250);
    }
    assert.ok(at !== null, `${r.name}'s run was not reaped within ${Math.round((deadline - lastBeat) / SECOND)} s of its last beat`);
    const after = at - lastBeat;
    t.diagnostic(`${r.name}: reaped ${(after / SECOND).toFixed(1)} s after its last beat`);
    assert.ok(after > RUNNER_OFFLINE_AFTER_MS, `${r.name} is reaped past the offline line, not ${after} ms after its last beat`);
    assert.ok(after <= RUNNER_OFFLINE_AFTER_MS + SWEEP_EVERY + SWEEP_SLACK, `${r.name} is reaped at the first sweep past the line: ${after} ms`);
  };
  /**
   * Every runner of the fleet cut off at once, each back `backAfter[i]` ms after the cut; then the fleet beats on. No run
   * is reaped, and the reaper said it held the run of every runner that was past the offline line for a whole sweep
   * interval — one past it for less may have come back between two sweeps, unseen.
   */
  const reconnection = async (label: string, backAfter: number[], meanwhile?: (cutAt: number) => Promise<void>) => {
    const cutAt = Date.now();
    await Promise.all(fleet.map(cut));
    const lastBeats = await Promise.all(fleet.map(lastBeatAt));
    t.diagnostic(`${label}: cut off ${new Date(cutAt).toISOString()}; back after (s) ${backAfter.map((ms) => (ms / SECOND).toFixed(1)).join(' ')}`);
    const returns = fleet.map(async (r, i) => {
      await sleep(cutAt + backAfter[i]! - Date.now());
      await comeBack(r);
      return { r, silentMs: Date.now() - lastBeats[i]! };
    });
    // What runs meanwhile is waited for once every runner is back, its failure with it: the returns run their course
    // whatever it found, so that no runner of this case comes back in the next.
    const during = meanwhile?.(cutAt).then(() => null, (error: unknown) => error);
    const back = await Promise.all(returns);
    const failedMeanwhile = await during;
    if (failedMeanwhile) throw failedMeanwhile;
    const longest = back.reduce((most, b) => (b.silentMs > most.silentMs ? b : most));
    t.diagnostic(`${label}: every runner back; the longest silence ${(longest.silentMs / SECOND).toFixed(1)} s (${longest.r.name})`);
    // Two sweeps after the last runner came back, and its first beats: whatever the reaper was to do, it has done.
    await sleep(2 * SWEEP_EVERY + SWEEP_SLACK);
    const said = reaperSaid(leader, cutAt);
    t.diagnostic(`${label}: the reaper said\n${said.join('\n')}`);
    // A run reaped and then resumed at once by auto-retry, its runner being back, is RUNNING no more for a moment only:
    // the reaper's own word for it is what is read, and the row besides.
    const reaped = [];
    for (const r of fleet) {
      const word = said.find((line) => line.includes(`reaped session ${r.sessionId} `));
      const row = await sessionOf(r);
      if (word || row.status !== RunStatus.RUNNING) reaped.push(`${r.name} (${word ?? row.status})`);
    }
    assert.deepEqual(reaped, [], `${label}: no run is reaped`);
    const seen = back.filter((b) => b.silentMs - RUNNER_OFFLINE_AFTER_MS > SWEEP_EVERY + SWEEP_SLACK).map((b) => b.r);
    assert.ok(seen.length > 0, `${label}: some runner was past the offline line for a whole sweep interval`);
    const held = seen.filter((r) => said.some((line) => line.includes('not reaping') && line.includes(r.sessionId)));
    assert.deepEqual(held.map((r) => r.name), seen.map((r) => r.name),
      `${label}: the reaper read each of them as offline, and held its run`);
    assert.deepEqual(failures, [], 'every call the runners made was answered');
    await stillLeads();
  };
  /** `n` return times, in ms after the cut, spread at random across [fromS, toS] seconds. */
  const spread = (n: number, fromS: number, toS: number) =>
    Array.from({ length: n }, (_, k) => Math.round((fromS + ((toS - fromS) * (k + random())) / n) * SECOND));
  /**
   * The fleet's return times: `early` of them within `withinS`, the rest between 95 and 150 s, the last of those after
   * 140 s, past the offline line for longer than a sweep interval whatever its last beat; shuffled over the fleet.
   */
  const schedule = (early: number, withinS: number) => {
    const times = [...spread(early, 1, withinS), ...spread(FLEET - early - 1, 95, 140), ...spread(1, 140, 150)];
    for (let i = times.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [times[i], times[j]] = [times[j]!, times[i]!];
    }
    return times;
  };

  // The leader's reaper reaps nothing for silence inside its startup grace, counted from when it took the lock.
  await sleep(bootedAt + STARTUP_GRACE_MS + SECOND - Date.now());
  assert.deepEqual(failures, [], 'every call the runners made was answered');

  if (CASES.has('1')) {
    await t.test('(1) one runner lost in a cell otherwise heard is reaped at the first sweep past the 90 s line', async () => {
      const lastBeat = await cutAfterItsNextBeat(alone1);
      await reapedAsAlone(alone1, lastBeat);
      await stillLeads();
    });
  }
  // Out of the cell from here: a runner that signed off counts neither as heard nor as silent.
  await cut(alone1);
  await signOff(alone1);

  if (CASES.has('2')) {
    await t.test('(2) every runner cut off at once, more than eight in ten back within 60 s, the rest in 95–150 s: no run is reaped', async () => {
      // 20 of 24: the four late ones are a sixth of the cell, under the fifth "silent at once" ever counted.
      const early = 20;
      assert.ok(early / FLEET > 0.8);
      await reconnection('(2)', schedule(early, 60));
    });
  }

  if (CASES.has('3')) {
    await t.test('(3) nine in ten back within 30 s, the rest in 95–150 s: no run is reaped; (4) one lost alone meanwhile is', async () => {
      const early = Math.ceil(FLEET * 0.9);
      assert.ok(early / FLEET >= 0.9);
      await reconnection('(3)', schedule(early, 30), CASES.has('4') ? async (cutAt) => {
        // A minute into it, with the late runners still out: a runner of its own, past every window of the
        // reconnection's losses, goes quiet and stays so.
        await sleep(cutAt + 60 * SECOND - Date.now());
        const lastBeat = await cutAfterItsNextBeat(alone2);
        assert.ok(lastBeat - cutAt > RUNNER_SILENT_AFTER_MS, 'its silence starts well after every runner the reconnection cut off');
        await reapedAsAlone(alone2, lastBeat);
      } : undefined);
    });
  }
  await cut(alone2);
  await signOff(alone2);

  if (CASES.has('5')) {
    await t.test('(5) every runner cut off at once and none back: held for the window, then each reaped at the first sweep after it', async () => {
      const cutAt = Date.now();
      await Promise.all(fleet.map(cut));
      const lastBeats = await Promise.all(fleet.map(lastBeatAt));
      const window = RUNNER_SILENT_AFTER_MS + MASS_SILENCE_WINDOW_MS;
      t.diagnostic(`(5): cut off ${new Date(cutAt).toISOString()}; held until each runner has been silent for ${window / SECOND} s`);
      const deadline = Math.max(...lastBeats) + window + SWEEP_EVERY + SWEEP_SLACK;
      const reaped = new Map<string, number>();
      while (reaped.size < FLEET && Date.now() < deadline + SECOND) {
        for (const [i, r] of fleet.entries()) {
          if (reaped.has(r.name)) continue;
          const at = await reapedAt(r);
          if (at === null) continue;
          reaped.set(r.name, at - lastBeats[i]!);
        }
        await sleep(SECOND);
      }
      const silences = [...reaped.values()];
      t.diagnostic(`(5): reaped after a silence of ${silences.map((ms) => (ms / SECOND).toFixed(1)).sort().join(' ')} s`);
      assert.equal(reaped.size, FLEET, 'every run is reaped once the window is over');
      for (const [name, silentMs] of reaped) {
        assert.ok(silentMs > window, `${name} is not reaped inside the window: ${silentMs} ms`);
        assert.ok(silentMs <= window + SWEEP_EVERY + SWEEP_SLACK, `${name} is reaped at the first sweep after the window: ${silentMs} ms`);
      }
      await stillLeads();
    });
  }
  assert.deepEqual(failures, [], 'every call the runners made was answered');
});
