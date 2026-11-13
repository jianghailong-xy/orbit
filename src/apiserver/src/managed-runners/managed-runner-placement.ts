import type { PrismaService } from '../prisma/prisma.service';
import type { ComputeAmounts, StorageAmounts } from './managed-runner-capacity';
import type { ManagedRunnerManager } from './managed-runner-manager';
import type { ManagedRunnerHostRuntime } from './managed-runner-runtime';

/**
 * Where a new mapping goes when the profile names several Docker channel hosts
 * (docs/managed-runner-remote-host-design.md, "Several channel hosts", D5 A): at creation, the host
 * whose pool has the most free room, skipping `draining` hosts; after that it stays there, because its
 * data volume is local to that host. Nothing here reserves anything: the pick only chooses which pool
 * the mapping's admission will ask, and admission stays the only guard of a pool.
 *
 * Free room is how many more runners the pool could take, every dimension counted (CPU, memory, /tmp,
 * slots, attachments, users, storage), read from the `managed_runner_capacity` rows the hosts' managers
 * keep. A host whose pool row does not exist yet (its channel never answered) ranks below every host
 * with one. Ties go to the earlier host in the profile.
 */

/** A pool's figures, as stored. */
export interface PlacementPool {
  cpuMillis: bigint | number;
  memoryBytes: bigint | number;
  ephemeralBytes: bigint | number;
  pods: number;
  attachments: number;
  activeUsers: number;
  storageUsableBytes: bigint | number;
  storageHeadroomBytes: bigint | number;
  cpuMillisReserved: bigint | number;
  memoryBytesReserved: bigint | number;
  ephemeralBytesReserved: bigint | number;
  podsReserved: number;
  attachmentsReserved: number;
  activeUsersReserved: number;
  durableBytesReserved: bigint | number;
}

/** How many more runners of `compute` and `storage` the pool could take now; 0 when it is full. */
export function freeRoom(pool: PlacementPool, compute: ComputeAmounts, storage: StorageAmounts): number {
  const fits = (total: bigint | number, reserved: bigint | number, need: number) =>
    need > 0 ? Math.max(0, Math.floor((Number(total) - Number(reserved)) / need)) : Infinity;
  const room = Math.min(
    fits(pool.cpuMillis, pool.cpuMillisReserved, compute.cpuMillis),
    fits(pool.memoryBytes, pool.memoryBytesReserved, compute.memoryBytes),
    fits(pool.ephemeralBytes, pool.ephemeralBytesReserved, compute.ephemeralBytes),
    fits(pool.pods, pool.podsReserved, compute.pods),
    fits(pool.attachments, pool.attachmentsReserved, compute.attachments),
    fits(pool.activeUsers, pool.activeUsersReserved, compute.activeUsers),
    fits(Number(pool.storageUsableBytes) - Number(pool.storageHeadroomBytes), pool.durableBytesReserved, storage.durableBytes),
  );
  return Number.isFinite(room) ? room : 0;
}

/**
 * The manager a new mapping is created under. One host (or none listed: Kubernetes, or a runtime built
 * by hand): that one, with nothing read. Several: the non-draining host with the most free room; null
 * when every host is draining.
 */
export async function placeNewMapping(
  prisma: Pick<PrismaService, 'managedRunnerCapacity'>,
  runtime: { manager: ManagedRunnerManager; hosts?: ManagedRunnerHostRuntime[] },
): Promise<ManagedRunnerManager | null> {
  const hosts = runtime.hosts;
  if (!hosts || hosts.length <= 1) return hosts?.[0]?.draining ? null : runtime.manager;
  const open = hosts.filter((host) => !host.draining);
  if (!open.length) return null;
  const pools = await prisma.managedRunnerCapacity.findMany({
    where: { OR: open.map(({ manager }) => ({ clusterKey: manager.backend.location.clusterKey, namespace: manager.backend.location.namespace })) },
  });
  let best: { manager: ManagedRunnerManager; room: number } | null = null;
  for (const { manager } of open) {
    const { clusterKey, namespace } = manager.backend.location;
    const pool = pools.find((row) => row.clusterKey === clusterKey && row.namespace === namespace);
    const room = pool ? freeRoom(pool, manager.backend.computeShare(), manager.backend.storageShare()) : -1;
    if (!best || room > best.room) best = { manager, room };
  }
  return best!.manager;
}
