import type { ManagedRunner, RunnerStatus } from '@prisma/client';
import {
  MANAGED_RUNNER_CONTRACT_VERSION,
  MANAGED_RUNNER_UNAVAILABLE,
  type ManagedRunnerReason,
  type ManagedRunnerStatus,
  type ManagedRunnerUpdate,
} from '@orbit/shared';

import { managedRunnerAccountDisabledReason, managedRunnerNotEligibleReason } from './managed-runner-eligibility';
import { managedRunnerDisabledReason } from './managed-runner-gate';
import { managedFirstSessionProvider, type ManagedEngine, type ManagedSupplyRunner } from './managed-runner-supply';
import { runnerLastBeatAt, type RunnerBeats } from '../runners/runner-presence';

/** How fresh a heartbeat must be to count, when no profile says otherwise: the reaper's threshold. */
export const DEFAULT_HEARTBEAT_FRESH_MS = 90_000;

export interface ManagedRunnerStatusInput {
  /** The process's switch. */
  enabled: boolean;
  /** Enabled, and this server has a valid environment to reconcile in. */
  available: boolean;
  /** ManagedRunnerEligibility's answer for an owner without a mapping. Absent: eligible. */
  eligible?: boolean;
  /** An administrator disabled the owner's account (asked only while the switch is on). Absent: no. */
  ownerDisabled?: boolean;
  mapping: ManagedRunner | null;
  /** The runner row: its heartbeat (read with RUNNER_BEATS), and what its last heartbeat reported of its
   *  engines (absent: nothing yet). */
  runner: ({ status: RunnerStatus; version?: string | null } & RunnerBeats & Partial<ManagedSupplyRunner>) | null;
  /** The owner's first own model key this managed runner can run (managedFirstSessionKeyOf), asked only
   *  before the runner has been READY. Absent: none. */
  firstSessionKey?: { slug: string; engine: ManagedEngine } | null;
  now: Date;
  heartbeatFreshMs: number;
  /** Whether the backend the mapping runs on can stop its instance (`stopInstance`: Docker and Kubernetes), so that the
   *  owner's Update Now of a busy runner interrupts its turns rather than waiting for idle. Absent: unknown, and nothing
   *  is said. */
  stopsInstances?: boolean;
}

export function managedRunnerUnavailableReason(): ManagedRunnerReason {
  return {
    code: MANAGED_RUNNER_UNAVAILABLE,
    message: "Managed runners are switched on, but this server's managed environment is not configured correctly. An operator has to fix it.",
    retryable: false,
  };
}

/** The stored cause, as clients may see it: code, sentence, retryable — never the operator detail. */
function storedReason(value: unknown): ManagedRunnerReason | null {
  if (!value || typeof value !== 'object') return null;
  const { code, message, retryable } = value as Record<string, unknown>;
  if (typeof code !== 'string' || typeof message !== 'string') return null;
  return { code, message, retryable: retryable === true };
}

/** The build a managed runner image's runner reports as its version (deploy/managed-runner/image/Dockerfile). */
const MANAGED_VERSION = /^managed-([0-9a-f]{7,40})$/;

/**
 * The owner's Update Now is in progress: asked for (`updateRequestedAt`) and not yet ended by the next generation
 * being READY (`updateCompletedAt`, written by the manager).
 */
export function ownerUpdatePending(mapping: Pick<ManagedRunner, 'updateRequestedAt' | 'updateCompletedAt'>): boolean {
  const asked = mapping.updateRequestedAt;
  return !!asked && (!mapping.updateCompletedAt || mapping.updateCompletedAt.getTime() < asked.getTime());
}

/**
 * A drain that is the owner's Update Now: an image roll (`imageRollTo`) while their request is in progress, which only
 * ManagedRunnerManager.ownerUpdate begins (the request is taken from READY alone, and ownerUpdate runs before an
 * automatic roll). Demand does not call it off: what comes meanwhile waits for the next generation, which wakes at once.
 * An automatic roll is still called off by demand.
 */
export function ownerUpdateDrain(mapping: Pick<ManagedRunner, 'imageRollTo' | 'updateRequestedAt' | 'updateCompletedAt'>): boolean {
  return mapping.imageRollTo !== null && ownerUpdatePending(mapping);
}

/** The states an owner's Update Now passes through on its way to the next generation's READY. */
const UPDATING_STATES: ReadonlySet<ManagedRunner['managementState']> = new Set(['READY', 'DRAINING', 'SLEEPING', 'REQUESTED', 'WAITING_CAPACITY', 'PROVISIONING', 'STARTING']);

/**
 * `update`: the manager found the READY instance made from an older image than the current one, whose build it
 * recorded (`currentImageSha`), and the runner reports the build it runs, another one. While an image roll drains
 * it, or the owner's Update Now is on its way to the next generation, `updating` — and `waitsForIdle` while a busy
 * runner's Update Now is still READY on a backend that cannot stop it (`stopsInstances` false). Nothing when it is
 * current, not running, or either build is unknown.
 */
function managedRunnerUpdate(mapping: ManagedRunner, version: string | null | undefined, stopsInstances?: boolean): ManagedRunnerUpdate | undefined {
  const phase = ownerUpdatePending(mapping) && UPDATING_STATES.has(mapping.managementState) ? 'updating'
    : mapping.managementState === 'READY' ? 'available'
    : mapping.managementState === 'DRAINING' && mapping.imageRollTo ? 'updating' : null;
  const current = mapping.currentImageSha;
  const running = MANAGED_VERSION.exec(version ?? '')?.[1];
  if (!phase || !mapping.imageOutdatedSince || !current || !running) return undefined;
  // One side may be abbreviated: the same commit is no update, whatever the record says of the image.
  if (current.startsWith(running) || running.startsWith(current)) return undefined;
  const waitsForIdle = phase === 'updating' && mapping.managementState === 'READY' && mapping.updateInterruptTurns && stopsInstances === false;
  return { running: { sha: running }, current: { sha: current }, phase, ...(waitsForIdle ? { waitsForIdle: true as const } : {}) };
}

/**
 * The owner's status, derived from what is stored. Pure: reading it allocates nothing and writes
 * nothing, which is what lets the capability and status reads be side-effect free.
 */
export function managedRunnerStatus(input: ManagedRunnerStatusInput): ManagedRunnerStatus {
  const { enabled, available, mapping, runner, now } = input;
  // A disabled account's managed runner is operated by nobody: no action is offered, and the account
  // is the reason given — before any stored cause, which is about the runner, not its owner.
  const disabled = enabled && input.ownerDisabled === true;
  const operable = enabled && available && !disabled;
  const actions = { canEnsure: false, canWake: false, canSleep: false, canRetry: false, canDelete: false };
  const switchReason = !enabled ? managedRunnerDisabledReason() : !available ? managedRunnerUnavailableReason() : null;
  const accountReason = disabled ? managedRunnerAccountDisabledReason() : null;

  if (!mapping) {
    const eligible = input.eligible !== false;
    return {
      contractVersion: MANAGED_RUNNER_CONTRACT_VERSION,
      enabled,
      revision: 0,
      managementState: 'NOT_PROVISIONED',
      desiredState: null,
      runnerId: null,
      workspaceId: null,
      heartbeatStatus: null,
      lastHeartbeatAt: null,
      usable: false,
      reason: accountReason ?? switchReason ?? (eligible ? null : managedRunnerNotEligibleReason()),
      retryAfter: null,
      initialProvider: null,
      firstSessionProvider: null,
      actions: { ...actions, canEnsure: operable && eligible },
    };
  }

  const reason = storedReason(mapping.lastError);
  const beat = runnerLastBeatAt(runner);
  const fresh = !!beat && now.getTime() - beat.getTime() <= input.heartbeatFreshMs;
  const update = disabled ? undefined : managedRunnerUpdate(mapping, runner?.version, input.stopsInstances);
  return {
    contractVersion: MANAGED_RUNNER_CONTRACT_VERSION,
    enabled,
    revision: mapping.revision,
    managementState: mapping.managementState,
    desiredState: mapping.desiredState,
    runnerId: mapping.runnerId,
    // Always null since 0930: a managed runner has no default workspace. Kept for clients that still read it.
    workspaceId: null,
    heartbeatStatus: runner?.status ?? null,
    lastHeartbeatAt: beat?.toISOString() ?? null,
    usable: mapping.managementState === 'READY' && fresh && runner?.status !== 'OFFLINE' && !disabled,
    reason: !enabled ? switchReason : (accountReason ?? reason ?? switchReason),
    retryAfter: mapping.nextAttemptAt && mapping.nextAttemptAt > now ? mapping.nextAttemptAt.toISOString() : null,
    initialProvider: mapping.initialProvider,
    firstSessionProvider: managedFirstSessionProvider(
      mapping.initialProvider,
      input.firstSessionKey ?? null,
      runner
        ? { engines: runner.engines ?? null, defaultRemoved: runner.defaultRemoved ?? null, capabilities: runner.capabilities ?? null }
        : null,
    ),
    ...(update ? { update } : {}),
    actions: {
      ...actions,
      canRetry: operable && mapping.managementState === 'FAILED' && reason?.retryable === true,
      // Asleep, or on its way there: demand from the owner starts it again.
      canWake: operable && (mapping.managementState === 'SLEEPING' || mapping.managementState === 'DRAINING'),
      // READY and wanted running: the request itself is refused while the runner has work.
      canSleep: operable && mapping.managementState === 'READY' && mapping.desiredState === 'RUNNING',
    },
  };
}
