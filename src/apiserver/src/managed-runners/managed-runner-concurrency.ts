import { quantityUnits } from './managed-runner-capacity';
import type { AnyManagedRunnerProfile } from './managed-runner-profile';
import type { ManagedRunnerRuntime } from './managed-runner-runtime';

/**
 * How many sessions a managed runner may run at once, from its memory limit: one turn needs about 1 GiB (an engine
 * and the tools of one turn), and the daemon keeps 1 GiB for itself and the rest of the container. So
 * floor((limit − 1 GiB) / 1 GiB), and never less than 1: a 4 GiB runner runs at most 3.
 *
 * A runner's `maxConcurrent` is otherwise the owner's to set, with no ceiling, and the daemon adopts it from every
 * heartbeat answer. On 2026-11-20 the owner raised Orbit Cloud's from 2 to 4 on a 4 GiB pod, which was OOM-killed three
 * minutes later. So for a managed runner the value is clamped to this ceiling where the row is written (its seed, and
 * the owner's update) and in the heartbeat answer, which also covers a row stored before the ceiling existed. A
 * runner somebody runs themselves is never clamped: its machine is theirs to judge.
 *
 * The limit is the profile's: every managed runner of this server is made from the one profile it loaded (per-mapping
 * sizes do not exist), Kubernetes' runner container limit or the Docker container's. No profile (the switch off, or
 * one that did not load): no ceiling, and the daemon's own memory reserve (runner-go memory_reserve.go) still holds.
 */

const GiB = 2 ** 30;

/** What a managed runner keeps for its daemon and the rest of its container. */
export const MANAGED_RUNNER_BASE_MEMORY_BYTES = GiB;
/** What one turn needs: its engine and the tools it runs. */
export const MANAGED_RUNNER_TURN_MEMORY_BYTES = GiB;

/** The memory limit of the container every managed runner of this profile runs in, in bytes; null if unreadable. */
export function managedRunnerMemoryLimitBytes(profile: AnyManagedRunnerProfile): number | null {
  const quantity = profile.backend === 'docker' ? profile.runner.resources.memory : profile.runner.resources.runner.limits.memory;
  return quantityUnits(quantity);
}

/** The most sessions a runner with `limitBytes` of memory runs at once: at least 1. */
export function concurrencyCeilingForMemory(limitBytes: number): number {
  return Math.max(1, Math.floor((limitBytes - MANAGED_RUNNER_BASE_MEMORY_BYTES) / MANAGED_RUNNER_TURN_MEMORY_BYTES));
}

/** A managed runner's concurrency ceiling, and the memory limit it comes from. */
export interface ManagedConcurrencyCeiling {
  ceiling: number;
  limitBytes: number;
}

/** The ceiling of every managed runner this server runs, or null when it has no profile to read it from. */
export function managedConcurrencyCeiling(runtime: ManagedRunnerRuntime | null | undefined): ManagedConcurrencyCeiling | null {
  if (!runtime?.available) return null;
  const limitBytes = managedRunnerMemoryLimitBytes(runtime.profile);
  if (limitBytes === null) return null;
  return { ceiling: concurrencyCeilingForMemory(limitBytes), limitBytes };
}

/** `asked`, clamped to the ceiling when there is one. */
export function clampManagedConcurrency(asked: number, limit: ManagedConcurrencyCeiling | null): number {
  return limit ? Math.min(asked, limit.ceiling) : asked;
}

/** What the owner is told when the Max Concurrent they set was lowered to the ceiling. */
export function managedConcurrencyClampNotice(asked: number, limit: ManagedConcurrencyCeiling): string {
  const memory = Number.isInteger(limit.limitBytes / GiB) ? `${limit.limitBytes / GiB} GiB` : `${Math.round(limit.limitBytes / 2 ** 20)} MiB`;
  const sessions = limit.ceiling === 1 ? '1 session' : `${limit.ceiling} sessions`;
  return `This managed runner has ${memory} of memory, enough for ${sessions} at once, so Max Concurrent was set to ${limit.ceiling} instead of ${asked}.`;
}
