import { Prisma } from '@prisma/client';
import type { RunnerResources, RunnerResourceSample, RunnerResourcesAnswer } from '@orbit/shared';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * A machine's CPU, memory and disk (RunnerHeartbeatRequest.resources), kept beside its presence: runner_presence.resources,
 * migration 0720. Written by the statement that writes the beat — the link beat statement (runner-api/link-heartbeat.ts
 * readLinkBeat) — or, for a beat over HTTPS or a managed runner's, by one more statement after the beat's own upsert
 * (recordRunnerResources). Read by the machine page (GET /api/runners/:id/resources).
 *
 * The column holds {at, latest, samples}: the last reading, when it came (the database's clock, epoch ms), and the last
 * hour as [ms, cpu %, memory %, disk %] tuples, oldest first. A beat without a reading leaves the column as it is.
 */

/** How far back the samples go. */
export const RUNNER_RESOURCES_WINDOW_MS = 60 * 60_000;

const FIELDS = ['cpuPercent', 'cpuCores', 'load1', 'memTotalBytes', 'memAvailableBytes', 'diskTotalBytes', 'diskFreeBytes'] as const;
const BYTES = new Set<string>(['memTotalBytes', 'memAvailableBytes', 'diskTotalBytes', 'diskFreeBytes']);

/** The reading as it may be stored: finite non-negative numbers only, bytes whole, CPU at most 100. Null for none. */
export function sanitizeRunnerResources(value: unknown): RunnerResources | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: RunnerResources = {};
  for (const key of FIELDS) {
    const v = (value as Record<string, unknown>)[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) continue;
    out[key] = BYTES.has(key) || key === 'cpuCores' ? Math.floor(v) : v;
  }
  if (out.cpuPercent !== undefined) out.cpuPercent = Math.min(100, out.cpuPercent);
  if (out.memAvailableBytes !== undefined && out.memTotalBytes !== undefined && out.memAvailableBytes > out.memTotalBytes) {
    delete out.memAvailableBytes;
  }
  if (out.diskFreeBytes !== undefined && out.diskTotalBytes !== undefined && out.diskFreeBytes > out.diskTotalBytes) {
    delete out.diskFreeBytes;
  }
  return out;
}

function usedPercent(total: number | undefined, free: number | undefined): number | null {
  if (total === undefined || free === undefined || total <= 0) return null;
  return Math.round(((total - free) / total) * 1000) / 10;
}

/** One reading as the point its hour keeps: CPU, memory and disk in use, percent. */
export function resourceSampleOf(r: RunnerResources): [number | null, number | null, number | null] {
  return [
    r.cpuPercent === undefined ? null : Math.round(r.cpuPercent * 10) / 10,
    usedPercent(r.memTotalBytes, r.memAvailableBytes),
    usedPercent(r.diskTotalBytes, r.diskFreeBytes),
  ];
}

/**
 * The column after a beat, as an expression over what it held (`existing`): unchanged for a beat without a reading,
 * else the reading, now, and the samples within the hour with this one added. Its text does not depend on the
 * reading, so a statement that carries it keeps one prepared text (prisma-client.ts PREPARED_STATEMENT).
 */
export function resourcesAfterBeatSql(existing: Prisma.Sql, reading: RunnerResources | null): Prisma.Sql {
  const [cpu, mem, disk] = reading ? resourceSampleOf(reading) : [null, null, null];
  const latest = reading ? JSON.stringify(reading) : null;
  const nowMs = Prisma.sql`(extract(epoch FROM now()) * 1000)::float8`;
  return Prisma.sql`CASE WHEN ${latest}::jsonb IS NULL THEN ${existing}
    ELSE jsonb_build_object('at', ${nowMs}, 'latest', ${latest}::jsonb, 'samples', COALESCE((
      SELECT jsonb_agg(s.value ORDER BY (s.value->>0)::float8)
        FROM jsonb_array_elements(
               COALESCE(${existing}->'samples', '[]'::jsonb)
               || jsonb_build_array(jsonb_build_array(${nowMs}, ${cpu}::float8, ${mem}::float8, ${disk}::float8))
             ) s
       WHERE (s.value->>0)::float8 > ${nowMs} - ${RUNNER_RESOURCES_WINDOW_MS}::float8), '[]'::jsonb))
    END`;
}

/** A beat's reading, written after the beat's own upsert wrote the row (HTTPS, and a managed runner's link beat). */
export async function recordRunnerResources(
  prisma: Pick<PrismaService, '$executeRaw'>,
  runnerId: string,
  reading: RunnerResources,
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "runner_presence" SET "resources" = ${resourcesAfterBeatSql(Prisma.sql`"resources"`, reading)}
     WHERE "runner_id" = ${runnerId}::uuid
  `;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The column as the page reads it; anything that is not what resourcesAfterBeatSql writes reads as nothing kept. */
export function runnerResourcesAnswerOf(stored: unknown): RunnerResourcesAnswer {
  const empty: RunnerResourcesAnswer = { at: null, latest: null, samples: [] };
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return empty;
  const { at, latest, samples } = stored as { at?: unknown; latest?: unknown; samples?: unknown };
  const atMs = num(at);
  if (atMs === null) return empty;
  const points: RunnerResourceSample[] = [];
  if (Array.isArray(samples)) {
    for (const s of samples) {
      if (!Array.isArray(s) || num(s[0]) === null) continue;
      points.push({ at: new Date(num(s[0])!).toISOString(), cpu: num(s[1]), mem: num(s[2]), disk: num(s[3]) });
    }
  }
  return { at: new Date(atMs).toISOString(), latest: sanitizeRunnerResources(latest), samples: points };
}
