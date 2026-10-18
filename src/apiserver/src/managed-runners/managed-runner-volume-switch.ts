import type { ManagedRunner } from '@prisma/client';

/**
 * An administrator's switch of a managed runner's data volume to a restored one (docs/managed-runner-design.md,
 * "Retention explicit deletion and backup" and "Implementation record: a restored volume back under its runner";
 * the operator's side is docs/managed-runner-kubernetes-operations.md, "Put a restored volume back under its
 * runner"). The manager accepts a runner's data volume only as recorded — its UID, its storage's UID and handle —
 * and a volume under the runner's name with another identity is a conflict for an operator to review, never a
 * replacement it makes by itself. A Kubernetes claim's UID cannot be recreated, so a runner whose volume was lost
 * or damaged would never run again: this is the operator's way back, verified and recorded.
 *
 * The rules of the mapping's own state are here; the checks of the volume, which need the backend, and the
 * switch itself are the manager's (managed-runner-manager.ts, `switchVolume`), under the mapping's lease.
 */

/** The answer to a refused switch: 409, or 503 while the cluster cannot be asked. */
export const MANAGED_RUNNER_VOLUME_SWITCH_REFUSED = 'MANAGED_RUNNER_VOLUME_SWITCH_REFUSED';

/** The `activity` row a switch writes: who switched which mapping, when, from which volume to which. */
export const MANAGED_RUNNER_VOLUME_SWITCHED_ACTIVITY = 'managed_runner.volume_switched';

/** Which check refused a switch, and the sentence the administrator reads for it. */
export const VOLUME_SWITCH_CHECKS = {
  NOT_APPLICABLE:
    "This server's managed runners keep a restored volume's recorded identity, so there is nothing to switch: once the volume is back, the runner is retried (PVC_RESTORED).",
  MAPPING_BUSY: 'The manager is working on this runner right now, so nothing was switched. Try again in a few seconds.',
  NOT_SWITCHABLE: 'Only a runner that is asleep, or failed, can have its data volume switched, and only once its recorded volume and instance are settled.',
  CONFIRMATION_REQUIRED:
    "The manager has not found this runner's recorded data volume missing, so the switch needs the confirmation that it is to be replaced (confirmReplacement).",
  VOLUME_NOT_FOUND: "No usable volume is under this runner's data volume name in the managed namespace.",
  VOLUME_NOT_VERIFIED: "The volume under this runner's name is not the one the request names, so nothing was switched. Check it again and name it.",
  VOLUME_ALREADY_RECORDED: "The volume under this runner's name is still its recorded data volume. A restore goes into a new volume under that name.",
  VOLUME_NOT_BOUND: 'The restored volume is not bound to its storage yet.',
  VOLUME_NOT_THIS_RUNNERS: "The restored volume does not carry the marks of this runner's data volume, as the manager's own volumes do.",
  VOLUME_OF_ANOTHER_ACCOUNT: "The restored volume's storage is recorded for another runner, or was made for another volume first.",
  VOLUME_IN_USE: 'Something holds the restored volume, so the runner cannot be given it yet.',
  RECORDED_VOLUME_IN_USE: "Nothing shows that this runner's recorded data volume and its last instance are no longer in use.",
  ADMISSION_GUARD_MISSING: 'The single-Pod admission guard is not shown to be in force, so nothing would keep another Pod off the restored volume.',
  BACKEND_UNAVAILABLE: 'The cluster could not be asked about the volumes, so nothing was switched. Try again.',
} as const;

export type VolumeSwitchCheck = keyof typeof VOLUME_SWITCH_CHECKS;

/** A switch refused by one of its checks. Nothing was written. `detail` is for the operator: names, UIDs, nodes. */
export class ManagedVolumeSwitchRefused extends Error {
  constructor(
    readonly check: VolumeSwitchCheck,
    readonly detail: string,
  ) {
    super(`${check}: ${detail}`);
    this.name = 'ManagedVolumeSwitchRefused';
  }
}

/** The mapping is no longer at the revision the administrator read: read it again and decide again. */
export class ManagedVolumeSwitchRevisionMoved extends Error {
  constructor(readonly revision: number) {
    super(`the mapping is at revision ${revision}`);
    this.name = 'ManagedVolumeSwitchRevisionMoved';
  }
}

export interface ManagedVolumeSwitchRequest {
  mappingId: string;
  /** The administrator: the audit record's actor. */
  actorId: string;
  /** The mapping's revision as the administrator read it. */
  revision: number;
  /** The UID of the restored volume the administrator verified, under the runner's data volume name. */
  volumeUid: string;
  /** That the recorded volume is to be replaced although the manager has not found it missing. */
  confirmReplacement: boolean;
  /** Why, in the administrator's words: kept in the audit record. */
  reason: string;
  idempotencyKey: string;
}

/** A data volume as the mapping records it, in the mapping's own column names (the backend's terms say what they are). */
export interface SwitchedVolume {
  pvcName: string;
  pvcUid: string;
  /** The storage's name, where it was read; not recorded on the mapping. */
  pvName?: string;
  pvUid: string;
  volumeHandle: string;
}

export interface ManagedVolumeSwitchOutcome {
  /** The same request, already applied: answered from the mapping, nothing written. */
  replayed: boolean;
  mapping: ManagedRunner;
  /** What was recorded before; null for a replay. */
  from: SwitchedVolume | null;
  to: SwitchedVolume;
  /** When it was switched; null for a replay. */
  at: Date | null;
}

/** The answer to an administrator's switch (200): the mapping as it now stands, and what was switched. */
export interface ManagedRunnerVolumeSwitchAnswer {
  runnerId: string;
  replayed: boolean;
  managementState: ManagedRunner['managementState'];
  desiredState: ManagedRunner['desiredState'];
  revision: number;
  generation: number;
  from: SwitchedVolume | null;
  to: SwitchedVolume;
  switchedAt: string | null;
}

/** The data volume a mapping records, or null before it records one. */
export function recordedVolume(mapping: ManagedRunner): SwitchedVolume | null {
  if (!mapping.pvcUid || !mapping.pvUid || !mapping.volumeHandle) return null;
  return { pvcName: mapping.pvcName, pvcUid: mapping.pvcUid, pvUid: mapping.pvUid, volumeHandle: mapping.volumeHandle };
}

/**
 * Why the mapping's own state does not allow a switch, or null when it does. Nothing may be running or on its way
 * up: the mapping is SLEEPING, or FAILED, and not deleted; no resource operation is in flight (a create that may
 * still commit); a volume is recorded to be replaced. The manager must have found that volume missing
 * (FAILED PVC_MISSING), or the administrator confirms it is to be replaced — a damaged volume, a runner that failed
 * or was put to sleep before anything looked. A recorded instance (FAILED with its stopped Pod still recorded) is
 * the manager's next check: it has to be proven stopped and gone.
 */
export function volumeSwitchStateProblem(
  mapping: ManagedRunner,
  confirmReplacement: boolean,
): { check: VolumeSwitchCheck; detail: string } | null {
  if (mapping.desiredState === 'DELETED') return { check: 'NOT_SWITCHABLE', detail: 'its deletion was asked' };
  if (mapping.managementState !== 'SLEEPING' && mapping.managementState !== 'FAILED') {
    return { check: 'NOT_SWITCHABLE', detail: `it is ${mapping.managementState}` };
  }
  if (mapping.resourceOperationState === 'PENDING') {
    return { check: 'NOT_SWITCHABLE', detail: `a ${mapping.resourceOperationKind} it asked for may still take effect` };
  }
  if (!recordedVolume(mapping)) return { check: 'NOT_SWITCHABLE', detail: 'it records no data volume yet: the manager makes its first one itself' };
  const missing = mapping.managementState === 'FAILED' && (mapping.lastError as { code?: unknown } | null)?.code === 'PVC_MISSING';
  if (!missing && !confirmReplacement) {
    const reason = (mapping.lastError as { code?: unknown } | null)?.code;
    return { check: 'CONFIRMATION_REQUIRED', detail: `it is ${mapping.managementState}${typeof reason === 'string' ? ` (${reason})` : ''}, not FAILED PVC_MISSING` };
  }
  return null;
}
