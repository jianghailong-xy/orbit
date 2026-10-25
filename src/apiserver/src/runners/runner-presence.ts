import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { classifyTransactionFault } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Whether a runner is there, and when it was last heard from — the one place this control plane
 * answers either (docs/runner-link-design.md §5.7, §6.5).
 *
 * A runner's beats are kept in two places. `runner_presence` (migration 0444, UNLOGGED) holds the
 * latest one: every heartbeat upserts the runner's row there. `runner.last_heartbeat_at` is the
 * runner's own low-frequency record, written at registration and by a heartbeat at most every
 * RUNNER_DURABLE_BEAT_EVERY_MS. A reading takes the later of the two, so it never goes back in time:
 * a presence row PostgreSQL emptied in a crash or a failover leaves the runner's own record to answer,
 * and a runner that has not beaten since it registered is read from the record registration wrote.
 *
 * Every reader of liveness goes through here: a Prisma read selects RUNNER_BEATS beside the runner's
 * other fields and asks runnerIsOnline / runnerLastBeatAt; raw SQL splices runnerLastBeatSql or
 * runnerOfflineSql; a payload that shows a runner to a client carries runnerLastBeatAt as its
 * `lastHeartbeatAt`, which is what every client has always read it from.
 */

/** Runners heartbeat every 30 s; three missed beats and a runner reads as offline. */
export const RUNNER_OFFLINE_AFTER_MS = 90_000;

/**
 * How often a heartbeat also rewrites the runner row's own record of it (`last_heartbeat_at`). Every
 * beat lands in runner_presence; this record is only what a lost presence row falls back to.
 */
export const RUNNER_DURABLE_BEAT_EVERY_MS = 5 * 60_000;

/** What carried a beat (`runner_presence.link_state`, whose CHECK names the same two). */
export type RunnerLinkState = 'HTTP' | 'LINK';

/** Selected beside a runner's other fields wherever its liveness is read: both records of its beats. */
export const RUNNER_BEATS = {
  lastHeartbeatAt: true,
  presence: { select: { lastBeatAt: true } },
} as const satisfies Prisma.RunnerSelect;

type Instant = Date | string | null | undefined;

/**
 * A runner as its liveness is read: a row read with RUNNER_BEATS — its own record and its presence
 * row — or a payload whose `lastHeartbeatAt` already carries a reading (the session list's rows,
 * which runnerLastBeatSql filled). Either way the later beat is the one that counts.
 */
export interface RunnerBeats {
  lastHeartbeatAt?: Instant;
  presence?: { lastBeatAt: Instant } | null;
}

function epochMs(at: Instant): number {
  if (at instanceof Date) return at.getTime();
  return at ? Date.parse(at) : NaN;
}

/** When the runner was last heard from; null when it never was. */
export function runnerLastBeatAt(runner: RunnerBeats | null | undefined): Date | null {
  const live = epochMs(runner?.presence?.lastBeatAt);
  const recorded = epochMs(runner?.lastHeartbeatAt);
  if (Number.isFinite(live) && Number.isFinite(recorded)) return new Date(Math.max(live, recorded));
  if (Number.isFinite(live)) return new Date(live);
  return Number.isFinite(recorded) ? new Date(recorded) : null;
}

/**
 * The rule every reader decides "online" by: not signed off — OFFLINE is what a runner reports about
 * itself on its way out — and heard from within RUNNER_OFFLINE_AFTER_MS.
 */
export function runnerIsOnline(
  runner: ({ status: string } & RunnerBeats) | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!runner || runner.status === 'OFFLINE') return false;
  const beat = runnerLastBeatAt(runner);
  return beat !== null && beat.getTime() >= now - RUNNER_OFFLINE_AFTER_MS;
}

/**
 * A runner row read with RUNNER_BEATS as a client is shown it: `lastHeartbeatAt` is its last beat
 * (runnerLastBeatAt), and the presence row it was read from stays behind.
 */
export function withRunnerLastBeat<T extends RunnerBeats>(
  runner: T,
): Omit<T, 'presence' | 'lastHeartbeatAt'> & { lastHeartbeatAt: Date | null } {
  const { presence: _presence, lastHeartbeatAt: _recorded, ...rest } = runner;
  return { ...rest, lastHeartbeatAt: runnerLastBeatAt(runner) };
}

/**
 * The runner aliased `runner` in the enclosing SQL, its last beat: the later of its presence row and
 * its own record, as runnerLastBeatAt reads them. NULL when it was never heard from.
 */
export function runnerLastBeatSql(runner: string): Prisma.Sql {
  const r = Prisma.raw(runner);
  return Prisma.sql`GREATEST((SELECT presence."last_beat_at" FROM "runner_presence" presence WHERE presence."runner_id" = ${r}."id"), ${r}."last_heartbeat_at")`;
}

/**
 * runnerIsOnline's negation in SQL, on Postgres' clock, for the runner aliased `runner`: signed off,
 * never heard from, or silent for longer than RUNNER_OFFLINE_AFTER_MS.
 */
export function runnerOfflineSql(runner: string): Prisma.Sql {
  const r = Prisma.raw(runner);
  return Prisma.sql`(${r}."status" = 'OFFLINE' OR COALESCE(${runnerLastBeatSql(runner)}, '-infinity'::timestamp) < now() - (${RUNNER_OFFLINE_AFTER_MS} * interval '1 millisecond'))`;
}

/**
 * Whether this beat also rewrites the runner row's own record of it: when that record is missing or
 * at least RUNNER_DURABLE_BEAT_EVERY_MS old.
 */
export function durableBeatDue(recorded: Date | null | undefined, at: Date): boolean {
  return !recorded || at.getTime() - recorded.getTime() >= RUNNER_DURABLE_BEAT_EVERY_MS;
}

/** One heartbeat, as presence records it. */
export interface RunnerBeat {
  runnerId: string;
  /** The beating process's lease owner (the heartbeat's `leaseOwner`); null for a runner too old to send one. */
  processId: string | null;
  /** The link gateway node the beat came through; null over HTTP. */
  gatewayId: string | null;
  linkState: RunnerLinkState;
  /** Absent over HTTP, which sends the facts themselves on every beat. */
  factsHash?: string | null;
  /** Absent over HTTP, which reconciles in full on every beat. */
  reconcileHash?: string | null;
  at: Date;
}

/** Write this beat into the runner's presence row: one upsert on its primary key. */
export async function recordRunnerBeat(prisma: PrismaService, beat: RunnerBeat): Promise<void> {
  const row = {
    processId: beat.processId,
    gatewayId: beat.gatewayId,
    lastBeatAt: beat.at,
    linkState: beat.linkState,
    factsHash: beat.factsHash ?? null,
    reconcileHash: beat.reconcileHash ?? null,
  };
  await prisma.runnerPresence.upsert({
    where: { runnerId: beat.runnerId },
    create: { runnerId: beat.runnerId, ...row },
    update: row,
  });
}

/** The cell's runners heard from lately (`heard`), and how many of those have since gone quiet (`silent`). */
export interface FleetSilence {
  heard: number;
  silent: number;
}

/**
 * What this process knows about presence beyond any one runner: whether the heartbeats it took could
 * be written, and how much of the cell has gone quiet at once. The reaper asks both before it takes a
 * runner's silence for its death (realtime/reaper.service.ts).
 *
 * The write half is this process's own: a heartbeat another replica failed to write is not seen here.
 * v1 runs the reaper on a single replica, where that is every heartbeat; the fleet half reads the
 * database and sees every runner, whichever replica took its beats.
 */
@Injectable()
export class RunnerPresenceService {
  private lastBeatLostAt: number | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * A heartbeat whose writes failed: the runner reached this process and nothing recorded it. A
   * refusal the data made — the runner deleted under the beat — says nothing about the database, and
   * is not counted.
   */
  beatNotRecorded(error: unknown, at: number = Date.now()): void {
    if (classifyTransactionFault(error).family === 'PERMANENT') return;
    this.lastBeatLostAt = at;
  }

  /** When this process last failed to record a heartbeat; null when it never has. */
  lastBeatNotRecordedAt(): number | null {
    return this.lastBeatLostAt;
  }

  /**
   * The cell's runners last heard from within `windowMs` before the offline line — at most
   * RUNNER_OFFLINE_AFTER_MS + windowMs ago — and how many of those are past the line now: silent for
   * longer than RUNNER_OFFLINE_AFTER_MS. Read on Postgres' clock, like every SQL liveness reading.
   *
   * Only runners that can LOSE contact are counted, in either number. Not one marked OFFLINE: that is
   * written when a managed runner's row is created, before it has beaten, or reported by a runner about
   * itself as it leaves — never by a runner cut off. And not a managed runner its manager is putting to
   * sleep or has put to sleep (`managed_runner.management_state` DRAINING or SLEEPING): its silence is
   * the manager's own doing. A fleet of those going quiet together is no outage.
   */
  async fleetSilence(windowMs: number): Promise<FleetSilence> {
    const [row] = await this.prisma.$queryRaw<Array<{ heard: number; silent: number }>>(Prisma.sql`
      SELECT count(*)::int AS "heard",
             (count(*) FILTER (
               WHERE beats."at" < now() - (${RUNNER_OFFLINE_AFTER_MS} * interval '1 millisecond')
             ))::int AS "silent"
        FROM (
          SELECT ${runnerLastBeatSql('r')} AS "at"
            FROM "runner" r
           WHERE r."status" <> 'OFFLINE'
             AND NOT EXISTS (
               SELECT 1 FROM "managed_runner" mr
                WHERE mr."runner_id" = r."id" AND mr."management_state" IN ('DRAINING', 'SLEEPING')
             )
        ) beats
       WHERE beats."at" >= now() - (${RUNNER_OFFLINE_AFTER_MS + windowMs} * interval '1 millisecond')
    `);
    return { heard: row?.heard ?? 0, silent: row?.silent ?? 0 };
  }
}
