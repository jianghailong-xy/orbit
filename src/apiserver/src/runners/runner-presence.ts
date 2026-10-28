import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { classifyTransactionFault } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { APISERVER_PROCESS_LOCK_PREFIX, ControlPlaneLeader } from '../realtime/control-plane-leader';

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

/**
 * How often a runner heartbeats: runner-go's `heartbeatInterval`, and the link gateway's
 * Welcome.heartbeat_interval_ms.
 */
export const RUNNER_HEARTBEAT_EVERY_MS = 30_000;

/** Runners heartbeat every 30 s; three missed beats and a runner reads as offline. */
export const RUNNER_OFFLINE_AFTER_MS = 90_000;

/**
 * A beat missed: no beat for a heartbeat period and a half. Not a verdict on any one runner (that is
 * RUNNER_OFFLINE_AFTER_MS); what RunnerPresenceService.cellLosses counts a runner silent by.
 */
export const RUNNER_SILENT_AFTER_MS = 1.5 * RUNNER_HEARTBEAT_EVERY_MS;

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

/**
 * Something a heartbeat delivers to these runners changed and has committed: a command queued for one, a cancellation,
 * its settings, its workspaces (migration 0447). One more on each one's `changes`, so its next link heartbeat
 * reconciles in full (runner-api/link-heartbeat.ts). One statement on the primary key. A runner with no presence row
 * has nothing to mark: its next beat finds no row, and a beat that finds none reconciles in full anyway.
 */
export async function markRunnersChanged(
  prisma: Pick<PrismaService, '$executeRaw'>,
  runnerIds: readonly string[],
): Promise<number> {
  const ids = [...new Set(runnerIds)];
  if (ids.length === 0) return 0;
  return prisma.$executeRaw`
    UPDATE "runner_presence" SET "changes" = "changes" + 1 WHERE "runner_id" = ANY(${ids}::uuid[])
  `;
}

/**
 * The link gateway is opening a new connection for this runner (the welcome route, which it calls for each one before
 * Welcome, and so before the connection's first beat): the runner's last beat is the last it was heard with before it
 * connected again — before it lost contact, if it did — and is kept as such (`lost_at`, migration 0450). A connection
 * opened while the one before is still up, for a token's renewal or a process just started, is kept alike: what the
 * reaper reads off these is many runners losing contact at once, which renewals spread over the hour are not. One
 * statement on the primary key, which writes nothing when it would change nothing; nothing for a runner with no presence
 * row.
 */
export async function recordRunnerLinkOpened(prisma: Pick<PrismaService, '$executeRaw'>, runnerId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "runner_presence" SET "lost_at" = "last_beat_at"
     WHERE "runner_id" = ${runnerId}::uuid AND "lost_at" IS DISTINCT FROM "last_beat_at"
  `;
}

/** The cell as the reaper reads a mass disconnection off it (RunnerPresenceService.cellLosses). */
export interface CellLosses {
  /** The runners heard from lately: within the window past the silence line. */
  heard: number;
  /** How many of those are past the silence line now: a beat missed. */
  silent: number;
  /** The earliest and the latest of those silent runners' last beats, epoch ms; null when none is silent. */
  silentFrom: number | null;
  silentTo: number | null;
  /**
   * When each runner heard from lost contact, where that was within the window past the silence line: a silent runner
   * at its last beat, any other at the last beat it was heard with before it last lost contact (`lost_at`). Counted by
   * the second, in order: [epoch seconds, runners].
   */
  losses: Array<[number, number]>;
}

/** How often each apiserver process writes its row in `apiserver_process` (migration 0449). */
export const APISERVER_PROCESS_REPORT_EVERY_MS = 10_000;

/** A process whose row has not been written for three reports has gone quiet. */
export const APISERVER_PROCESS_QUIET_AFTER_MS = 3 * APISERVER_PROCESS_REPORT_EVERY_MS;

/**
 * The least time between two of one process's writes of its row when beats fail in a burst: the reaper holds for
 * RUNNER_OFFLINE_AFTER_MS past the last one, so a second a write is all the precision it needs, and a thousand
 * failed beats are not a thousand writes of one row.
 */
const APISERVER_PROCESS_REPORT_SPACING_MS = 1_000;

/** Another apiserver process as the reaper reads it (RunnerPresenceService.otherProcesses). */
export interface ApiserverProcessReport {
  id: string;
  /** How long ago it last reported a heartbeat it took failing to be written, or coming back from quiet. */
  beatLostAgoMs: number | null;
  /** How long ago it last wrote its row. */
  seenAgoMs: number;
  /** Whether it still holds the lock it holds while connected (realtime/control-plane-leader.ts). */
  connected: boolean;
}

/**
 * What this control plane knows about presence beyond any one runner: whether the heartbeats its
 * processes took could be written, and how much of the cell has lost contact at once. The reaper asks
 * both before it takes a runner's silence for its death (realtime/reaper.service.ts).
 *
 * The write half has two readers. This process's own failures are kept here, in memory, as they always
 * were (`lastBeatNotRecordedAt`), for the reaper beside it. Every other process reads them from
 * `apiserver_process` (migration 0449): with several apiservers the link gateway spreads beats over all
 * of them, the reaper runs on one (control-plane-leader.ts), and a beat another process failed to write
 * is a silence that reaper must not read as a runner gone. So each process writes its row every
 * APISERVER_PROCESS_REPORT_EVERY_MS and the moment a beat fails (`report`), and the reaper reads the
 * others' rows (`otherProcesses`). The rows go through the same pool the heartbeats do: a process whose
 * pool cannot write a beat cannot write its row either, and goes quiet there, which the reaper reads too.
 * The fleet half reads the database and sees every runner, whichever process took its beats.
 *
 * Only a process that runs beside a ControlPlaneLeader reports or reads other processes; one built
 * without (the specs that build the reaper by hand) is the only process there is, as v1 was.
 */
@Injectable()
export class RunnerPresenceService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('RunnerPresence');
  private lastBeatLostAt: number | null = null;
  /** A lost beat, or a quiet spell, that this process's row does not say yet. */
  private lostUnreported = false;
  /** When this process last wrote its row; null before it first has. */
  private reportedAt: number | null = null;
  private reporting: Promise<void> | null = null;
  private reportAgain = false;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly prisma: PrismaService,
    /** This process's id, and the sign that there may be others (realtime/control-plane-leader.ts). */
    @Optional() private readonly leader?: ControlPlaneLeader,
  ) {}

  onModuleInit(): void {
    if (!this.leader) return;
    void this.report();
    this.timer = setInterval(() => void this.report(), APISERVER_PROCESS_REPORT_EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * A heartbeat whose writes failed: the runner reached this process and nothing recorded it. A
   * refusal the data made — the runner deleted under the beat — says nothing about the database, and
   * is not counted. Reported at once, for a reaper on another process to read before its next sweep.
   */
  beatNotRecorded(error: unknown, at: number = Date.now()): void {
    if (classifyTransactionFault(error).family === 'PERMANENT') return;
    this.lastBeatLostAt = at;
    this.lostUnreported = true;
    void this.report();
  }

  /**
   * Write this process's row in `apiserver_process`: seen now, and a beat lost now when one has been
   * since the row last said so — a heartbeat that failed to be written, or a spell longer than
   * APISERVER_PROCESS_QUIET_AFTER_MS in which the row could not be written at all, whose beats may have
   * been lost without any error reaching this process (a pool so busy they waited out their callers).
   * Both at the database's clock. One write at a time: a call while one is out makes one more after it.
   * Never throws; a write that fails leaves what it was to say for the next.
   */
  report(): Promise<void> {
    if (!this.leader) return Promise.resolve();
    if (this.reporting) {
      this.reportAgain = true;
      return this.reporting;
    }
    const processId = this.leader.processId;
    this.reporting = (async () => {
      for (;;) {
        this.reportAgain = false;
        const startedAt = Date.now();
        // A write that failed leaves what it had to say to the timer's next report, rather than asking a
        // database that just refused it again at once.
        if (!(await this.writeReport(processId)) || !this.reportAgain) return;
        await new Promise((resolve) => setTimeout(resolve, startedAt + APISERVER_PROCESS_REPORT_SPACING_MS - Date.now()));
      }
    })().finally(() => {
      this.reporting = null;
    });
    return this.reporting;
  }

  /** One write of this process's row (`report`); whether it landed. */
  private async writeReport(processId: string): Promise<boolean> {
    const wasQuiet = this.reportedAt !== null && Date.now() - this.reportedAt > APISERVER_PROCESS_QUIET_AFTER_MS;
    const lost = this.lostUnreported || wasQuiet;
    this.lostUnreported = false;
    try {
      await this.prisma.$executeRaw`
        INSERT INTO "apiserver_process" ("id", "started_at", "seen_at", "beat_lost_at")
        VALUES (${processId}::uuid, now(), now(), CASE WHEN ${lost}::boolean THEN now() END)
        ON CONFLICT ("id") DO UPDATE
          SET "seen_at" = now(),
              "beat_lost_at" = CASE WHEN ${lost}::boolean THEN now() ELSE "apiserver_process"."beat_lost_at" END`;
      this.reportedAt = Date.now();
      return true;
    } catch (error) {
      if (lost) this.lostUnreported = true;
      this.log.warn(`apiserver process ${processId.slice(0, 8)} could not report itself: ${(error as Error).message}`);
      return false;
    }
  }

  /**
   * The other apiserver processes the reaper has to hear about before it reads a runner's silence for its
   * death: each that reported a lost beat within `windowMs`, and each that went quiet — has not written its
   * row for APISERVER_PROCESS_QUIET_AFTER_MS — less than `windowMs` ago, with whether it still holds the
   * lock a process holds while connected. Read on Postgres' clock, the clock the rows are written on. Empty
   * for a process built without a leader, which knows of no other.
   */
  async otherProcesses(windowMs: number): Promise<ApiserverProcessReport[]> {
    if (!this.leader) return [];
    const rows = await this.prisma.$queryRaw<Array<{
      id: string; beatLostAgoMs: number | null; seenAgoMs: number; connected: boolean;
    }>>(Prisma.sql`
      WITH held AS MATERIALIZED (
        -- The session-level advisory locks held now, by key: pg_locks read once, however many processes there are.
        SELECT ((l."classid"::bigint << 32) | l."objid"::bigint) AS "key"
          FROM pg_locks l
         WHERE l."locktype" = 'advisory' AND l."granted" AND l."objsubid" = 1
      )
      SELECT p."id",
             (extract(epoch FROM (now() - p."beat_lost_at")) * 1000)::float8 AS "beatLostAgoMs",
             (extract(epoch FROM (now() - p."seen_at")) * 1000)::float8 AS "seenAgoMs",
             EXISTS (
               SELECT 1 FROM held
                WHERE held."key" = hashtextextended(${APISERVER_PROCESS_LOCK_PREFIX}::text || p."id"::text, 0)
             ) AS "connected"
        FROM "apiserver_process" p
       WHERE p."id" <> ${this.leader.processId}::uuid
         AND (p."beat_lost_at" >= now() - (${windowMs} * interval '1 millisecond')
              OR (p."seen_at" < now() - (${APISERVER_PROCESS_QUIET_AFTER_MS} * interval '1 millisecond')
                  AND p."seen_at" >= now() - (${APISERVER_PROCESS_QUIET_AFTER_MS + windowMs} * interval '1 millisecond')))
    `);
    return rows.map((row) => ({
      id: row.id,
      beatLostAgoMs: row.beatLostAgoMs === null ? null : Number(row.beatLostAgoMs),
      seenAgoMs: Number(row.seenAgoMs),
      connected: row.connected,
    }));
  }

  /** When this process last failed to record a heartbeat; null when it never has. */
  lastBeatNotRecordedAt(): number | null {
    return this.lastBeatLostAt;
  }

  /**
   * The cell as the reaper reads a mass disconnection off it (realtime/reaper.service.ts), in one statement, on
   * Postgres' clock like every SQL liveness reading:
   *
   *  - the runners last heard from within `windowMs` before the silence line — at most RUNNER_SILENT_AFTER_MS + windowMs
   *    ago — and how many of those are past the line now, silent for longer than RUNNER_SILENT_AFTER_MS: a beat missed;
   *    with the span of those silent runners' last beats;
   *  - when each of the runners heard lost contact, where that falls inside the same window: a silent runner at its last
   *    beat, any other at the last beat it was heard with before it last lost contact (`lost_at`, kept as the gateway
   *    opens a new connection for it or a link beat comes after a missed one). This is what a runner that is already back
   *    leaves of its loss: a disconnection most runners come back from within seconds is silent at no sweep's moment.
   *    Counted by the second.
   *
   * The line is a missed beat, not the RUNNER_OFFLINE_AFTER_MS that calls one runner offline. Runners
   * cut off at the same moment had their last beats spread across a heartbeat period, so they cross
   * the offline line one by one over a whole period, and a count taken at that line reads an outage as
   * a machine or two until the last of them is across (the C1b drill, 2026-10-26: a sweep between two
   * such crossings saw a tenth of the cell and reaped a run). When the first of them is across, it and
   * every runner cut off with it have been silent for at least RUNNER_OFFLINE_AFTER_MS less a period —
   * two periods — while a runner still beating is about a period from its last beat at most: a period
   * and a half leaves half a period of room on either side.
   *
   * Only runners that can LOSE contact are counted, in any number. Not one marked OFFLINE: that is
   * written when a managed runner's row is created, before it has beaten, or reported by a runner about
   * itself as it leaves — never by a runner cut off. And not a managed runner its manager is putting to
   * sleep or has put to sleep (`managed_runner.management_state` DRAINING or SLEEPING): its silence is
   * the manager's own doing. A fleet of those going quiet together is no outage.
   */
  async cellLosses(windowMs: number): Promise<CellLosses> {
    const silentLine = Prisma.sql`now() - (${RUNNER_SILENT_AFTER_MS} * interval '1 millisecond')`;
    const windowLine = Prisma.sql`now() - (${RUNNER_SILENT_AFTER_MS + windowMs} * interval '1 millisecond')`;
    const [row] = await this.prisma.$queryRaw<Array<CellLosses>>(Prisma.sql`
      WITH heard AS MATERIALIZED (
        SELECT beats."at", beats."at" < ${silentLine} AS "silent",
               CASE WHEN beats."at" < ${silentLine} THEN beats."at" ELSE beats."lostAt" END AS "lost"
          FROM (
            SELECT ${runnerLastBeatSql('r')} AS "at",
                   (SELECT presence."lost_at" FROM "runner_presence" presence WHERE presence."runner_id" = r."id") AS "lostAt"
              FROM "runner" r
             WHERE r."status" <> 'OFFLINE'
               AND NOT EXISTS (
                 SELECT 1 FROM "managed_runner" mr
                  WHERE mr."runner_id" = r."id" AND mr."management_state" IN ('DRAINING', 'SLEEPING')
               )
          ) beats
         WHERE beats."at" >= ${windowLine}
      )
      SELECT (SELECT count(*)::int FROM heard) AS "heard",
             (SELECT count(*)::int FROM heard WHERE heard."silent") AS "silent",
             (SELECT (extract(epoch FROM min(heard."at")) * 1000)::float8 FROM heard WHERE heard."silent") AS "silentFrom",
             (SELECT (extract(epoch FROM max(heard."at")) * 1000)::float8 FROM heard WHERE heard."silent") AS "silentTo",
             COALESCE((
               SELECT json_agg(json_build_array(losses."second", losses."runners") ORDER BY losses."second")
                 FROM (
                   SELECT floor(extract(epoch FROM heard."lost"))::bigint AS "second", count(*)::int AS "runners"
                     FROM heard
                    WHERE heard."lost" >= ${windowLine}
                    GROUP BY 1
                 ) losses
             ), '[]'::json) AS "losses"
    `);
    return {
      heard: row?.heard ?? 0,
      silent: row?.silent ?? 0,
      silentFrom: row?.silentFrom == null ? null : Number(row.silentFrom),
      silentTo: row?.silentTo == null ? null : Number(row.silentTo),
      losses: (row?.losses ?? []).map(([second, runners]) => [Number(second), Number(runners)]),
    };
  }
}
