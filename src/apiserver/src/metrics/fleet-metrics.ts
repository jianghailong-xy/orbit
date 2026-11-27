import { Logger } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';

import { LINK_RECONCILE_EVERY_MS } from '../runner-api/link-heartbeat';
import { RUNNER_OFFLINE_AFTER_MS, RUNNER_SILENT_AFTER_MS, runnerPresenceSql } from '../runners/runner-presence';
import { sessionHeldSql } from '../common/session-release';
import { sessionTurnStateSql } from '../sessions/session-turn-state';
import { sessionCarriesTaskSql } from '../sessions/task-work-carrier';

/**
 * The runners, and the work waiting for and running on them, as gauges (docs/self-hosting.md, "Monitoring").
 *
 * WHAT EACH NUMBER IS
 * - `orbit_runners{state}`: every runner, by the rule every reader of liveness uses (runners/runner-presence.ts).
 *   `online` and `draining` were heard from within RUNNER_OFFLINE_AFTER_MS and are reachable, `draining` taking no new
 *   work; `silent` did not sign off and has not been heard from for that long, or ever; `offline` signed off.
 * - `orbit_runner_oldest_heartbeat_age_seconds`: how long ago the least recently heard of the reachable runners
 *   (`online` and `draining`) was last present — a beat, or a link Welcome (runnerPresenceSql) — 0 with none.
 *   Runners beat every 30 s, so it sits near 30 when beats arrive and climbs to 90 as they stop; one past that has gone
 *   `silent` and is counted there. Over the reachable ones only, because the server never moves a runner that went away
 *   without signing off: one closed laptop would hold any wider maximum at weeks.
 * - `orbit_runner_reconcile_stale`: the reachable runners on the link whose last full reconcile
 *   (`runner_presence.reconciled_at`) is older than RECONCILE_STALE_AFTER_MS: the five-minute period a link beat
 *   reconciles in full at least once in (LINK_RECONCILE_EVERY_MS), and a missed beat past it, since the beat that does is
 *   the first after the runner's period turns over — a line at five minutes flat would count every healthy runner for
 *   up to a beat in each period. A null `reconciled_at` is a reconcile owed, not a stale one, and is not counted; nor is
 *   a runner on HTTPS, which reconciles in full on every beat and never writes one. Counted only: a runner that stops reconciling stops beating its full beats too,
 *   and presence's five-minute cap on being heard takes it offline by itself (docs/runner-link-design.md §15.16).
 * - `orbit_sessions{state}`: sessions not in the Trash with a turn `queued` (PENDING) or `running` (RUNNING).
 * - `orbit_tasks{state}`: tasks a work session is carrying (sessions/task-work-carrier.ts), as the task list draws them:
 *   `queued` while that session's turn waits for a runner, `running` otherwise, which includes a session parked to wait
 *   for something that will wake it.
 *
 * Labels come from the closed sets below, never from a row: no runner, owner, session or task is named.
 *
 * READ ONCE PER {@link FLEET_GAUGES_TTL_MS} PER PROCESS
 * Every apiserver reads the same rows, so a scrape of each, every 15 s, and an operator's `GET /api/metrics` on top,
 * would each be a pass over the session table. One read is kept for FLEET_GAUGES_TTL_MS and every scrape in that time
 * is answered from it; scrapes that arrive while it is being read wait for that read. Across apiservers the numbers
 * are the same rows read at slightly different moments, so a dashboard takes their `max`, never their `sum`.
 * A read that fails is not kept: that scrape says `orbit_fleet_gauges_up 0`, and the next one reads again.
 */

export const FLEET_GAUGES_TTL_MS = 30_000;

/** How old a reachable link runner's last full reconcile is before orbit_runner_reconcile_stale counts it. */
export const RECONCILE_STALE_AFTER_MS = LINK_RECONCILE_EVERY_MS + RUNNER_SILENT_AFTER_MS;

export const RUNNER_STATES = ['online', 'draining', 'silent', 'offline'] as const;
export const WORK_STATES = ['queued', 'running'] as const;

export type RunnerState = (typeof RUNNER_STATES)[number];
export type WorkState = (typeof WORK_STATES)[number];

export interface FleetGauges {
  runners: Record<RunnerState, number>;
  oldestHeartbeatAgeSeconds: number;
  reconcileStale: number;
  sessions: Record<WorkState, number>;
  tasks: Record<WorkState, number>;
}

type GaugeReader = Pick<PrismaClient, '$queryRaw'>;

interface Row {
  runners_online: number;
  runners_draining: number;
  runners_silent: number;
  runners_offline: number;
  oldest_beat_age_seconds: number | null;
  runners_reconcile_stale: number;
  sessions_queued: number;
  sessions_running: number;
  tasks_queued: number;
  tasks_running: number;
}

/** Every gauge, in one read-only statement, on Postgres' clock. */
export async function readFleetGauges(db: GaugeReader): Promise<FleetGauges> {
  const [row] = await db.$queryRaw<Row[]>(Prisma.sql`
    WITH runner_state AS (
      SELECT CASE
               WHEN r."status" = 'OFFLINE' THEN 'offline'
               WHEN beat."at" IS NULL OR beat."at" < now() - (${RUNNER_OFFLINE_AFTER_MS} * interval '1 millisecond') THEN 'silent'
               WHEN r."status" = 'DRAINING' THEN 'draining'
               ELSE 'online'
             END AS "state",
             beat."at",
             (SELECT p."reconciled_at" FROM "runner_presence" p WHERE p."runner_id" = r."id" AND p."link_state" = 'LINK') AS "reconciledAt"
        FROM "runner" r
        CROSS JOIN LATERAL (SELECT ${runnerPresenceSql('r')} AS "at") beat
    )
    SELECT
      (SELECT count(*) FROM runner_state WHERE "state" = 'online')::int AS runners_online,
      (SELECT count(*) FROM runner_state WHERE "state" = 'draining')::int AS runners_draining,
      (SELECT count(*) FROM runner_state WHERE "state" = 'silent')::int AS runners_silent,
      (SELECT count(*) FROM runner_state WHERE "state" = 'offline')::int AS runners_offline,
      (SELECT EXTRACT(EPOCH FROM now() - min("at"))::float8 FROM runner_state
        WHERE "state" IN ('online', 'draining')) AS oldest_beat_age_seconds,
      (SELECT count(*) FROM runner_state
        WHERE "state" IN ('online', 'draining')
          AND "reconciledAt" < now() - (${RECONCILE_STALE_AFTER_MS} * interval '1 millisecond'))::int AS runners_reconcile_stale,
      -- Queued and running are the turn states QUEUED and IN_FLIGHT (sessions/session-turn-state.ts), of held rows.
      (SELECT count(*) FROM "session" s
        WHERE s."deleted_at" IS NULL AND ${sessionHeldSql('s')}
          AND ${sessionTurnStateSql('s')} = 'QUEUED')::int AS sessions_queued,
      (SELECT count(*) FROM "session" s
        WHERE s."deleted_at" IS NULL AND ${sessionHeldSql('s')}
          AND ${sessionTurnStateSql('s')} = 'IN_FLIGHT')::int AS sessions_running,
      (SELECT count(*) FROM "session" carrier
        WHERE carrier."task_id" IS NOT NULL AND ${Prisma.raw(sessionCarriesTaskSql('carrier'))}
          AND ${sessionTurnStateSql('carrier')} IS NOT DISTINCT FROM 'QUEUED')::int AS tasks_queued,
      (SELECT count(*) FROM "session" carrier
        WHERE carrier."task_id" IS NOT NULL AND ${Prisma.raw(sessionCarriesTaskSql('carrier'))}
          AND ${sessionTurnStateSql('carrier')} IS DISTINCT FROM 'QUEUED')::int AS tasks_running`);
  return {
    runners: {
      online: Number(row?.runners_online ?? 0),
      draining: Number(row?.runners_draining ?? 0),
      silent: Number(row?.runners_silent ?? 0),
      offline: Number(row?.runners_offline ?? 0),
    },
    // A clock a second apart from another apiserver's can make a fresh beat read as a little in the future.
    oldestHeartbeatAgeSeconds: Math.max(0, Number(row?.oldest_beat_age_seconds ?? 0)),
    reconcileStale: Number(row?.runners_reconcile_stale ?? 0),
    sessions: { queued: Number(row?.sessions_queued ?? 0), running: Number(row?.sessions_running ?? 0) },
    tasks: { queued: Number(row?.tasks_queued ?? 0), running: Number(row?.tasks_running ?? 0) },
  };
}

const log = new Logger('FleetMetrics');

let kept: { gauges: FleetGauges; readAt: number } | null = null;
let reading: Promise<FleetGauges> | null = null;

/** The gauges as of at most FLEET_GAUGES_TTL_MS ago, reading them when they are older; one read at a time. */
export async function cachedFleetGauges(db: GaugeReader, now: () => number = Date.now): Promise<FleetGauges> {
  if (kept && now() - kept.readAt < FLEET_GAUGES_TTL_MS) return kept.gauges;
  if (!reading) {
    reading = readFleetGauges(db).then(
      (gauges) => {
        kept = { gauges, readAt: now() };
        reading = null;
        return gauges;
      },
      (error: unknown) => {
        reading = null;
        throw error;
      },
    );
  }
  return reading;
}

/** Forget the kept read. For tests; nothing in the server calls it. */
export function resetFleetGauges(): void {
  kept = null;
  reading = null;
}

function gauge(lines: string[], name: string, help: string, samples: Array<[string, number]>): void {
  lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
  for (const [labels, value] of samples) lines.push(`${name}${labels} ${value}`);
}

/**
 * The gauges in Prometheus text exposition format, or only `orbit_fleet_gauges_up 0` when they could not be read.
 * Nothing at all without a database (a module booted without one).
 */
export async function renderFleetMetrics(db?: GaugeReader, now: () => number = Date.now): Promise<string> {
  if (!db) return '';
  const lines: string[] = [];
  const up = 'Whether the runner, session and task gauges could be read from the database, as of the read this scrape was answered from.';
  let gauges: FleetGauges;
  try {
    gauges = await cachedFleetGauges(db, now);
  } catch (error) {
    log.warn(`runner, session and task gauges could not be read: ${error instanceof Error ? error.message : error}`);
    gauge(lines, 'orbit_fleet_gauges_up', up, [['', 0]]);
    return `${lines.join('\n')}\n`;
  }
  gauge(lines, 'orbit_fleet_gauges_up', up, [['', 1]]);
  gauge(
    lines,
    'orbit_runners',
    'Runners by state: online and draining were heard from in the last 90 s, silent were not and did not sign off, offline signed off.',
    RUNNER_STATES.map((state) => [`{state="${state}"}`, gauges.runners[state]]),
  );
  gauge(
    lines,
    'orbit_runner_oldest_heartbeat_age_seconds',
    'Seconds since the least recently heard of the online and draining runners last beat; 0 with none.',
    [['', gauges.oldestHeartbeatAgeSeconds]],
  );
  gauge(
    lines,
    'orbit_runner_reconcile_stale',
    'Online and draining link runners whose last full reconcile is more than 5 minutes and a missed beat old; a reconcile still owed is not counted.',
    [['', gauges.reconcileStale]],
  );
  gauge(
    lines,
    'orbit_sessions',
    'Sessions not in the Trash whose turn is queued for a runner or running on one.',
    WORK_STATES.map((state) => [`{state="${state}"}`, gauges.sessions[state]]),
  );
  gauge(
    lines,
    'orbit_tasks',
    'Tasks a work session is carrying: queued while its turn waits for a runner, running otherwise.',
    WORK_STATES.map((state) => [`{state="${state}"}`, gauges.tasks[state]]),
  );
  return `${lines.join('\n')}\n`;
}
