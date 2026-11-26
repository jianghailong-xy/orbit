import { MANAGED_RUNNER_SLEEP_CAPABILITY, type ManagedRunnerSleepRequest, type ManagedRunnerWorkload } from '@orbit/shared';

import type { PrismaService } from '../prisma/prisma.service';
import type { ManagedRunnerInstance } from './managed-runner-instance';
import { ownerUpdateDrain } from './managed-runner-status';
import { managedRunnerWork } from './managed-runner-work';

/**
 * The runner's half of idle sleep, as the heartbeat route serves it (docs/managed-runner-design.md,
 * "Provisioning retry wake and sleep" 7 and 8; the manager's half is ManagedRunnerManager's READY and
 * DRAINING steps).
 *
 * Every heartbeat of a managed runner's authorized instance that declares
 * MANAGED_RUNNER_SLEEP_CAPABILITY carries its workload: turns, background jobs, operations and
 * unflushed events, and how long all of them have been zero. The route stores it on the runner row
 * with the instance that said it, and the manager reads it fresh, from the current instance, or not
 * at all: a missing or stale report never lets anything sleep.
 *
 * While the mapping drains, the route hands that instance no new heartbeat work, and its answer
 * carries the sleep request. The instance accepts by echoing the request's time in `sleepReady`,
 * while it is still idle by its own account; the route then records the acceptance — only if the
 * drain still stands, the request is the same, no demand has come since the drain began and the
 * records show nothing for the runner — and answers `confirmed`. Only a confirmed instance exits.
 * The owner's Update Now drains the same way, and demand does not call it off (`ownerUpdateDrain`):
 * its acceptance asks only that the drain and the owner's request still stand, whatever came since;
 * what came waits for the next generation, which wakes at once.
 * The acceptance and the manager calling the drain off are each a conditional write on the same row
 * (`stop_acknowledged_at IS NULL` on the manager's side), so an instance can never stop for a drain
 * the manager has abandoned, and a drain it accepted is never abandoned under it.
 */

/** The report as stored: the runner's figures, with the instance that sent them and when. */
export interface StoredManagedWorkload extends ManagedRunnerWorkload {
  generation: number;
  podUid: string;
  /** When the control plane received it, ISO 8601: freshness is judged on the server's clock. */
  receivedAt: string;
  /** The heartbeat's own `draining` flag: the instance has begun its drain. */
  draining: boolean;
}

/** The figures one report may carry; anything outside them is not a report. */
const MAX_COUNT = 1_000_000;
const MAX_IDLE_SECONDS = 10 * 365 * 24 * 3600;

function count(value: unknown, max = MAX_COUNT): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max ? value : null;
}

/** A runner's report, if it is one: four counts and an idle duration, all whole and non-negative. */
export function sanitizeManagedWorkload(value: unknown): (ManagedRunnerWorkload & { sleepReady?: string }) | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const activeTurns = count(v.activeTurns);
  const backgroundJobs = count(v.backgroundJobs);
  const operations = count(v.operations);
  const unflushedEvents = count(v.unflushedEvents);
  const idleSeconds = count(v.idleSeconds, MAX_IDLE_SECONDS);
  const driveWrites = v.driveWrites === undefined ? 0 : count(v.driveWrites);
  if (activeTurns === null || backgroundJobs === null || operations === null || unflushedEvents === null || idleSeconds === null || driveWrites === null) return null;
  const sleepReady = typeof v.sleepReady === 'string' && v.sleepReady.length <= 64 ? v.sleepReady : undefined;
  return { activeTurns, backgroundJobs, operations, unflushedEvents, idleSeconds, ...(driveWrites ? { driveWrites } : {}), ...(sleepReady ? { sleepReady } : {}) };
}

/** What the heartbeat route writes for the instance that sent `workload`. */
export function storedWorkloadFor(
  workload: ManagedRunnerWorkload,
  instance: ManagedRunnerInstance,
  draining: boolean,
  now: Date,
): StoredManagedWorkload {
  const { activeTurns, backgroundJobs, operations, unflushedEvents, idleSeconds, driveWrites } = workload;
  return {
    activeTurns, backgroundJobs, operations, unflushedEvents, idleSeconds,
    ...(driveWrites ? { driveWrites } : {}),
    generation: instance.generation,
    podUid: instance.podUid,
    receivedAt: now.toISOString(),
    draining,
  };
}

/** The stored report, if it is one. */
export function readStoredWorkload(value: unknown): StoredManagedWorkload | null {
  const figures = sanitizeManagedWorkload(value);
  if (!figures) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.generation !== 'number' || typeof v.podUid !== 'string' || typeof v.receivedAt !== 'string') return null;
  if (Number.isNaN(Date.parse(v.receivedAt))) return null;
  return { ...figures, generation: v.generation, podUid: v.podUid, receivedAt: v.receivedAt, draining: v.draining === true };
}

/**
 * What the authorized instance last reported, if it may be believed: it declares it can sleep, it heartbeated within
 * `freshMs`, and the report is that fresh and comes from the generation and instance recorded now. Null otherwise —
 * missing or stale telemetry never lets anything sleep or roll. `lastBeatAt` is the runner's last beat
 * (runnerLastBeatAt).
 */
export function freshInstanceReport(
  runner: { capabilities: readonly string[]; managedWorkload: unknown } | null,
  lastBeatAt: Date | null,
  mapping: { generation: number; podUid: string | null },
  now: Date,
  freshMs: number,
): StoredManagedWorkload | null {
  if (!runner?.capabilities.includes(MANAGED_RUNNER_SLEEP_CAPABILITY)) return null;
  if (!lastBeatAt || now.getTime() - lastBeatAt.getTime() > freshMs) return null;
  const report = readStoredWorkload(runner.managedWorkload);
  if (!report || report.generation !== mapping.generation || report.podUid !== mapping.podUid) return null;
  return now.getTime() - Date.parse(report.receivedAt) <= freshMs ? report : null;
}

/** Nothing in flight, by the runner's own account. */
export function workloadIdle(workload: ManagedRunnerWorkload): boolean {
  return workload.activeTurns === 0 && workload.backgroundJobs === 0 && workload.operations === 0 && workload.unflushedEvents === 0 && !workload.driveWrites;
}

export interface ManagedHeartbeatAnswer {
  /** The mapping drains: this heartbeat hands its instance no new work (landings, repository
   *  operations, merges, commits, rate-limit resets). */
  draining: boolean;
  concurrencyCap?: number;
  /** The sleep request to answer with, confirmed once the instance's acceptance is recorded. */
  sleep?: ManagedRunnerSleepRequest;
  /** The mapping is STARTING and this beat may be the one READY waits for: the route kicks the manager rather than
   *  leave it to the next poll. */
  starting?: boolean;
}

/**
 * The heartbeat route's question about a managed instance: is its mapping draining, and what does
 * the instance get told. Records the instance's acceptance as described above. Reads one row, and
 * while an acceptance is offered, the runner's recorded work; writes at most that one column.
 */
export async function managedRunnerHeartbeat(
  prisma: Pick<PrismaService, 'managedRunner' | '$queryRaw'>,
  instance: ManagedRunnerInstance,
  workload: (ManagedRunnerWorkload & { sleepReady?: string }) | null,
  now: Date,
): Promise<ManagedHeartbeatAnswer> {
  const mapping = await prisma.managedRunner.findUnique({
    where: { id: instance.mappingId },
    select: {
      id: true, runnerId: true, generation: true, podUid: true, managementState: true, desiredState: true, concurrencyCap: true,
      demandRevision: true, drainDemandRevision: true, stopRequestedAt: true, stopAcknowledgedAt: true,
      imageRollTo: true, updateRequestedAt: true, updateCompletedAt: true,
    },
  });
  if (!mapping) return { draining: false };
  const cap = mapping.concurrencyCap == null ? {} : { concurrencyCap: mapping.concurrencyCap };
  if (mapping.managementState === 'STARTING') return { draining: false, ...cap, starting: true };
  if (mapping.managementState !== 'DRAINING') return { draining: false, ...cap };
  // Only the instance being drained is asked anything.
  if (mapping.generation !== instance.generation || mapping.podUid !== instance.podUid || !mapping.stopRequestedAt) {
    return { draining: true, ...cap };
  }
  const requestedAt = mapping.stopRequestedAt.toISOString();
  if (mapping.stopAcknowledgedAt) return { draining: true, ...cap, sleep: { requestedAt, confirmed: true } };
  if (workload?.sleepReady === requestedAt && workloadIdle(workload) && mapping.drainDemandRevision !== null) {
    const owners = ownerUpdateDrain(mapping);
    const work = owners ? [] : await managedRunnerWork(prisma, mapping.runnerId);
    if (work.length === 0) {
      const { count: accepted } = await prisma.managedRunner.updateMany({
        where: {
          id: mapping.id,
          managementState: 'DRAINING',
          generation: instance.generation,
          podUid: instance.podUid,
          stopRequestedAt: mapping.stopRequestedAt,
          stopAcknowledgedAt: null,
          ...(owners
            ? { imageRollTo: mapping.imageRollTo, updateRequestedAt: mapping.updateRequestedAt }
            : { desiredState: 'SLEEPING' as const, demandRevision: mapping.drainDemandRevision }),
        },
        data: { stopAcknowledgedAt: now },
      });
      if (accepted === 1) return { draining: true, ...cap, sleep: { requestedAt, confirmed: true } };
    }
  }
  return { draining: true, ...cap, sleep: { requestedAt } };
}
