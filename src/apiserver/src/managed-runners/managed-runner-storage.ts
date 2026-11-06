import type { StorageBudget } from '@orbit/shared';

import type { PrismaService } from '../prisma/prisma.service';
import { readReservation } from './managed-runner-capacity';
import type { ManagedRunnerInstance } from './managed-runner-instance';

/**
 * What a managed runner's heartbeat says about its storage (docs/session-checkout-storage-design.md §5): the
 * floor its worktree sweep reclaims checkouts at and, where statfs cannot see the volume's limit, the budget it
 * judges free space against.
 *
 *   Docker       a local volume is a directory on the host's disk, so statfs inside the container reports the
 *                host, while the channel stops the container once the volume holds more than its limit
 *                (VOLUME_OVER_LIMIT). The answer carries `storageBudget`: the channel's latest measurement of
 *                the volume, which the manager reads on its passes and keeps on the mapping
 *                (`volume_measurement`), and the floor. No measurement, no budget: the runner keeps the rule
 *                it had.
 *   Kubernetes   the PVC is the filesystem the checkouts are on, so statfs already reports the budget, and the
 *                answer's `minFreeDiskMb` is all it needs.
 *
 * The floor is the owner's (Runner.minFreeDiskMb) when the owner set one, and otherwise a quarter of the volume
 * (D5): of the limit on Docker, of the PVC's size on Kubernetes. The default is worked out when the answer is made
 * and never stored, so the owner's setting stays what the owner set, and the auto-run disk gate reads it unchanged.
 */

const MiB = 1024 * 1024;

/** D5: the share of its volume a managed runner keeps free when its owner has set no floor. */
export const DEFAULT_FLOOR_SHARE = 0.25;

/** A volume as its backend measured it: the most it may hold, and what it held. */
export interface VolumeFigures {
  limitBytes: number;
  usageBytes: number;
}

/** `managed_runner.volume_measurement`: the figures, and when the manager first read them (ISO 8601). */
export interface VolumeMeasurement extends VolumeFigures {
  measuredAt: string;
}

/** A byte count as JSON can carry it exactly. */
export function isByteCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** The stored measurement read back: anything but what the manager writes reads as none. */
export function readVolumeMeasurement(value: unknown): VolumeMeasurement | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { limitBytes, usageBytes, measuredAt } = value as Record<string, unknown>;
  if (!isByteCount(limitBytes) || limitBytes === 0 || !isByteCount(usageBytes)) return null;
  if (typeof measuredAt !== 'string' || Number.isNaN(Date.parse(measuredAt))) return null;
  return { limitBytes, usageBytes, measuredAt };
}

/** What a managed runner's heartbeat answers about its storage. */
export interface ManagedRunnerStorage {
  /** The floor in MB, as the answer's `minFreeDiskMb` states it. */
  minFreeDiskMb: number | null;
  /** Docker only, and only once the volume has been measured. */
  storageBudget?: StorageBudget;
}

/** The mapping's columns the answer is made from. */
export interface ManagedStorageMapping {
  backend: string;
  reservation: unknown;
  volumeMeasurement: unknown;
}

/** The answer for a managed runner with this mapping, whose owner set `ownerFloorMb` (null: no floor set). */
export function managedRunnerStorage(mapping: ManagedStorageMapping, ownerFloorMb: number | null | undefined): ManagedRunnerStorage {
  const owner = ownerFloorMb ?? null;
  if (mapping.backend === 'docker') {
    const measured = readVolumeMeasurement(mapping.volumeMeasurement);
    if (!measured) return { minFreeDiskMb: owner };
    const floorBytes = owner === null ? Math.floor(measured.limitBytes * DEFAULT_FLOOR_SHARE) : Math.max(0, owner) * MiB;
    return { minFreeDiskMb: owner, storageBudget: { ...measured, floorBytes } };
  }
  if (mapping.backend === 'kubernetes' && owner === null) {
    // The PVC's size as admission reserved it, for as long as the volume exists: the size it was created with.
    const pvcBytes = readReservation(mapping.reservation)?.storage?.durableBytes;
    const floorMb = isByteCount(pvcBytes) ? Math.floor((pvcBytes * DEFAULT_FLOOR_SHARE) / MiB) : 0;
    return { minFreeDiskMb: floorMb > 0 ? floorMb : null };
  }
  return { minFreeDiskMb: owner };
}

/** The answer for an authorized managed instance: its mapping, read by id. Null when the mapping is gone. */
export async function readManagedRunnerStorage(
  prisma: Pick<PrismaService, 'managedRunner'>,
  instance: ManagedRunnerInstance,
  ownerFloorMb: number | null | undefined,
): Promise<ManagedRunnerStorage | null> {
  const mapping = await prisma.managedRunner.findUnique({
    where: { id: instance.mappingId },
    select: { backend: true, reservation: true, volumeMeasurement: true },
  });
  return mapping ? managedRunnerStorage(mapping, ownerFloorMb) : null;
}
