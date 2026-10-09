import { Prisma, type ManagedRunner } from '@prisma/client';

import type { ManagedRunnerProfile } from './managed-runner-profile';

/**
 * Capacity admission (docs/managed-runner-design.md, "Resource admission model supply and
 * isolation"): the fixed budget of the one environment a profile names, and the share of it each
 * managed runner holds, both persisted in PostgreSQL and changed only together.
 *
 * The budget is `managed_runner_capacity`, one row per cluster key and namespace (migration 0413):
 * what the test owner says the environment may admit — CPU and memory requests, ephemeral storage,
 * Pod and volume-attach slots, managed users active at once, and the storage pool's safe usable
 * bytes less the headroom kept free — and how much of each is reserved now. A mapping's share is its
 * `reservation`: storage (its data volume's bytes, held from before the PVC is created for as long as
 * the volume exists, asleep or not) and compute (everything else, held from before its Pod is
 * created until its instance is proven stopped).
 *
 * A reservation is a conditional UPDATE of the budget row — every dimension's `reserved + need <=
 * total` in its WHERE — in the transaction that records the share on the mapping by compare-and-set:
 * two admissions racing for the last slot are serialized on the budget row, and the second finds it
 * spent. A release subtracts exactly what the mapping recorded, in the transaction that clears it.
 * Nothing here sums observed usage, and a runner's `maxConcurrent` (its session slots) is not
 * capacity of any kind.
 */

/** What one managed runner holds while it has compute: one Pod's requests, one attach slot, one user. */
export interface ComputeAmounts {
  cpuMillis: number;
  memoryBytes: number;
  ephemeralBytes: number;
  pods: number;
  attachments: number;
  activeUsers: number;
}

/** What one managed runner holds while its data volume exists. */
export interface StorageAmounts {
  durableBytes: number;
}

/** A mapping's recorded share (`managed_runner.reservation`). */
export interface ManagedRunnerReservation {
  version: 1;
  /** The budget row the share was taken from. */
  pool: string;
  storage: (StorageAmounts & { reservedAt: string }) | null;
  compute: (ComputeAmounts & { reservedAt: string; generation: number }) | null;
}

/** The dimensions a refusal names, in the order a reason lists them. */
export const CAPACITY_DIMENSIONS = ['cpu', 'memory', 'ephemeralStorage', 'pods', 'attachments', 'activeUsers', 'storage'] as const;
export type CapacityDimension = (typeof CAPACITY_DIMENSIONS)[number];

const DECIMAL = /^([0-9]+)(?:\.([0-9]+))?(m|k|M|G|T|P|E|Ki|Mi|Gi|Ti|Pi|Ei)?$/;
const SUFFIX: Record<string, bigint> = {
  '': 1n,
  k: 10n ** 3n,
  M: 10n ** 6n,
  G: 10n ** 9n,
  T: 10n ** 12n,
  P: 10n ** 15n,
  E: 10n ** 18n,
  Ki: 2n ** 10n,
  Mi: 2n ** 20n,
  Gi: 2n ** 30n,
  Ti: 2n ** 40n,
  Pi: 2n ** 50n,
  Ei: 2n ** 60n,
};

/**
 * A Kubernetes quantity in whole base units — or thousandths of one with `milli` (CPU) — rounded up,
 * as the API server rounds a request. Null for anything that is not a plain decimal quantity, or a
 * value too large to count exactly.
 */
export function quantityUnits(quantity: string, scale: 'unit' | 'milli' = 'unit'): number | null {
  const match = DECIMAL.exec(quantity);
  if (!match) return null;
  const [, whole, fraction = '', suffix = ''] = match;
  let numerator = BigInt(whole + fraction) * (scale === 'milli' ? 1000n : 1n);
  let denominator = 10n ** BigInt(fraction.length);
  if (suffix === 'm') denominator *= 1000n;
  else numerator *= SUFFIX[suffix];
  const units = (numerator + denominator - 1n) / denominator;
  return units <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(units) : null;
}

/** Units a profile field must convert to; the profile validator has already checked the shape. */
function units(quantity: string, scale: 'unit' | 'milli' = 'unit'): number {
  const value = quantityUnits(quantity, scale);
  if (value === null) throw new Error(`not a countable quantity: ${JSON.stringify(quantity)}`);
  return value;
}

/**
 * One managed runner's compute share, from the profile's Pod template: the larger of the runner and
 * the init container's requests (a Pod's init containers run before its containers, so the scheduler
 * reserves the larger of the two), the `/tmp` emptyDir bound as its ephemeral storage, one Pod, one
 * volume attachment and one active user.
 */
export function computeShare(profile: Pick<ManagedRunnerProfile, 'runner'>): ComputeAmounts {
  const { runner, init } = profile.runner.resources;
  return {
    cpuMillis: Math.max(units(runner.requests.cpu, 'milli'), units(init.requests.cpu, 'milli')),
    memoryBytes: Math.max(units(runner.requests.memory), units(init.requests.memory)),
    ephemeralBytes: units(profile.runner.tmpSizeLimit),
    pods: 1,
    attachments: 1,
    activeUsers: 1,
  };
}

/** One managed runner's storage share: its data volume's requested size. */
export function storageShare(profile: Pick<ManagedRunnerProfile, 'storage'>): StorageAmounts {
  return { durableBytes: units(profile.storage.capacity) };
}

/** The environment's budget, from the profile. */
export interface CapacityBudget {
  cpuMillis: number;
  memoryBytes: number;
  ephemeralBytes: number;
  pods: number;
  attachments: number;
  activeUsers: number;
  storageUsableBytes: number;
  storageHeadroomBytes: number;
}

export function capacityBudget(profile: Pick<ManagedRunnerProfile, 'capacity'>): CapacityBudget {
  const { compute, storage, maxActiveUsers } = profile.capacity;
  return {
    cpuMillis: units(compute.cpu, 'milli'),
    memoryBytes: units(compute.memory),
    ephemeralBytes: units(compute.ephemeralStorage),
    pods: compute.pods,
    attachments: compute.attachments,
    activeUsers: maxActiveUsers,
    storageUsableBytes: units(storage.usable),
    storageHeadroomBytes: units(storage.headroom),
  };
}

/** The stored share, or none. Anything unreadable is treated as no share: nothing is subtracted for it. */
export function readReservation(value: unknown): ManagedRunnerReservation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as Partial<ManagedRunnerReservation>;
  if (r.version !== 1 || typeof r.pool !== 'string') return null;
  return { version: 1, pool: r.pool, storage: r.storage ?? null, compute: r.compute ?? null };
}

/** The budget row as stored. */
export interface CapacityPool {
  id: string;
  revision: number;
  budget: CapacityBudget;
  reserved: Omit<CapacityBudget, 'storageUsableBytes' | 'storageHeadroomBytes'> & { durableBytes: number };
}

interface PoolRow {
  id: string;
  revision: number;
  cpu_millis: bigint;
  memory_bytes: bigint;
  ephemeral_bytes: bigint;
  pods: number;
  attachments: number;
  active_users: number;
  storage_usable_bytes: bigint;
  storage_headroom_bytes: bigint;
  cpu_millis_reserved: bigint;
  memory_bytes_reserved: bigint;
  ephemeral_bytes_reserved: bigint;
  pods_reserved: number;
  attachments_reserved: number;
  active_users_reserved: number;
  durable_bytes_reserved: bigint;
}

const POOL_COLUMNS = Prisma.sql`id::text AS id, revision, cpu_millis, memory_bytes, ephemeral_bytes, pods, attachments, active_users,
  storage_usable_bytes, storage_headroom_bytes, cpu_millis_reserved, memory_bytes_reserved, ephemeral_bytes_reserved,
  pods_reserved, attachments_reserved, active_users_reserved, durable_bytes_reserved`;

function poolOf(row: PoolRow): CapacityPool {
  return {
    id: row.id,
    revision: row.revision,
    budget: {
      cpuMillis: Number(row.cpu_millis),
      memoryBytes: Number(row.memory_bytes),
      ephemeralBytes: Number(row.ephemeral_bytes),
      pods: row.pods,
      attachments: row.attachments,
      activeUsers: row.active_users,
      storageUsableBytes: Number(row.storage_usable_bytes),
      storageHeadroomBytes: Number(row.storage_headroom_bytes),
    },
    reserved: {
      cpuMillis: Number(row.cpu_millis_reserved),
      memoryBytes: Number(row.memory_bytes_reserved),
      ephemeralBytes: Number(row.ephemeral_bytes_reserved),
      pods: row.pods_reserved,
      attachments: row.attachments_reserved,
      activeUsers: row.active_users_reserved,
      durableBytes: Number(row.durable_bytes_reserved),
    },
  };
}

/** The dimensions `pool` cannot give `compute` and `storage` now. Empty: it can. */
export function shortDimensions(pool: CapacityPool, compute: ComputeAmounts | null, storage: StorageAmounts | null): CapacityDimension[] {
  const short: CapacityDimension[] = [];
  const { budget, reserved } = pool;
  if (compute) {
    if (reserved.cpuMillis + compute.cpuMillis > budget.cpuMillis) short.push('cpu');
    if (reserved.memoryBytes + compute.memoryBytes > budget.memoryBytes) short.push('memory');
    if (reserved.ephemeralBytes + compute.ephemeralBytes > budget.ephemeralBytes) short.push('ephemeralStorage');
    if (reserved.pods + compute.pods > budget.pods) short.push('pods');
    if (reserved.attachments + compute.attachments > budget.attachments) short.push('attachments');
    if (reserved.activeUsers + compute.activeUsers > budget.activeUsers) short.push('activeUsers');
  }
  if (storage && reserved.durableBytes + storage.durableBytes > budget.storageUsableBytes - budget.storageHeadroomBytes) {
    short.push('storage');
  }
  return short;
}

/** A client to run on: a transaction's, or the service itself for a statement of its own. */
type Db = Prisma.TransactionClient;

/**
 * The budget row of `profile`'s environment, created on first use and brought to the profile's
 * totals when they differ (a restart with an edited profile). A change of totals moves the revision,
 * which is what tells intents waiting for capacity to look again. What is reserved is never touched
 * here, and totals below it simply admit nothing more until releases bring it under.
 */
export async function syncCapacityPool(client: Db, profile: Pick<ManagedRunnerProfile, 'clusterKey' | 'kubernetes' | 'capacity'>): Promise<CapacityPool> {
  const b = capacityBudget(profile);
  const [row] = await client.$queryRaw<PoolRow[]>`
    INSERT INTO managed_runner_capacity AS c (
      id, cluster_key, namespace, cpu_millis, memory_bytes, ephemeral_bytes, pods, attachments, active_users,
      storage_usable_bytes, storage_headroom_bytes, updated_at)
    VALUES (gen_random_uuid(), ${profile.clusterKey}, ${profile.kubernetes.namespace}, ${b.cpuMillis}, ${b.memoryBytes},
      ${b.ephemeralBytes}, ${b.pods}, ${b.attachments}, ${b.activeUsers}, ${b.storageUsableBytes}, ${b.storageHeadroomBytes}, now())
    ON CONFLICT (cluster_key, namespace) DO UPDATE SET
      cpu_millis = EXCLUDED.cpu_millis, memory_bytes = EXCLUDED.memory_bytes, ephemeral_bytes = EXCLUDED.ephemeral_bytes,
      pods = EXCLUDED.pods, attachments = EXCLUDED.attachments, active_users = EXCLUDED.active_users,
      storage_usable_bytes = EXCLUDED.storage_usable_bytes, storage_headroom_bytes = EXCLUDED.storage_headroom_bytes,
      revision = c.revision + 1, updated_at = now()
    WHERE (c.cpu_millis, c.memory_bytes, c.ephemeral_bytes, c.pods, c.attachments, c.active_users,
           c.storage_usable_bytes, c.storage_headroom_bytes)
      IS DISTINCT FROM (EXCLUDED.cpu_millis, EXCLUDED.memory_bytes, EXCLUDED.ephemeral_bytes, EXCLUDED.pods,
           EXCLUDED.attachments, EXCLUDED.active_users, EXCLUDED.storage_usable_bytes, EXCLUDED.storage_headroom_bytes)
    RETURNING ${POOL_COLUMNS}`;
  if (row) return poolOf(row);
  // Unchanged totals: the conflict updated nothing and returned nothing.
  const [current] = await client.$queryRaw<PoolRow[]>`
    SELECT ${POOL_COLUMNS} FROM managed_runner_capacity
     WHERE cluster_key = ${profile.clusterKey} AND namespace = ${profile.kubernetes.namespace}`;
  return poolOf(current);
}

export async function readCapacityPool(client: Db, poolId: string): Promise<CapacityPool | null> {
  const [row] = await client.$queryRaw<PoolRow[]>`SELECT ${POOL_COLUMNS} FROM managed_runner_capacity WHERE id = ${poolId}::uuid`;
  return row ? poolOf(row) : null;
}

/**
 * Take `compute` and `storage` from the pool in one statement, only if every dimension still fits.
 * True when taken; false, with nothing changed, when any does not. Run inside the transaction that
 * records the share on the mapping.
 */
export async function reserveCapacity(db: Db, poolId: string, compute: ComputeAmounts | null, storage: StorageAmounts | null): Promise<boolean> {
  const c = compute ?? { cpuMillis: 0, memoryBytes: 0, ephemeralBytes: 0, pods: 0, attachments: 0, activeUsers: 0 };
  const s = storage?.durableBytes ?? 0;
  const taken = await db.$executeRaw`
    UPDATE managed_runner_capacity SET
      cpu_millis_reserved = cpu_millis_reserved + ${c.cpuMillis},
      memory_bytes_reserved = memory_bytes_reserved + ${c.memoryBytes},
      ephemeral_bytes_reserved = ephemeral_bytes_reserved + ${c.ephemeralBytes},
      pods_reserved = pods_reserved + ${c.pods},
      attachments_reserved = attachments_reserved + ${c.attachments},
      active_users_reserved = active_users_reserved + ${c.activeUsers},
      durable_bytes_reserved = durable_bytes_reserved + ${s},
      revision = revision + 1,
      updated_at = now()
    WHERE id = ${poolId}::uuid
      AND cpu_millis_reserved + ${c.cpuMillis} <= cpu_millis
      AND memory_bytes_reserved + ${c.memoryBytes} <= memory_bytes
      AND ephemeral_bytes_reserved + ${c.ephemeralBytes} <= ephemeral_bytes
      AND pods_reserved + ${c.pods} <= pods
      AND attachments_reserved + ${c.attachments} <= attachments
      AND active_users_reserved + ${c.activeUsers} <= active_users
      AND durable_bytes_reserved + ${s} <= storage_usable_bytes - storage_headroom_bytes`;
  return taken === 1;
}

/**
 * Give back exactly what a mapping recorded. The CHECKs on the reserved columns refuse a release
 * that would take any of them below zero, so a share can never be returned twice.
 */
export async function releaseCapacity(db: Db, poolId: string, compute: ComputeAmounts | null, storage: StorageAmounts | null): Promise<void> {
  if (!compute && !storage) return;
  const c = compute ?? { cpuMillis: 0, memoryBytes: 0, ephemeralBytes: 0, pods: 0, attachments: 0, activeUsers: 0 };
  const s = storage?.durableBytes ?? 0;
  const released = await db.$executeRaw`
    UPDATE managed_runner_capacity SET
      cpu_millis_reserved = cpu_millis_reserved - ${c.cpuMillis},
      memory_bytes_reserved = memory_bytes_reserved - ${c.memoryBytes},
      ephemeral_bytes_reserved = ephemeral_bytes_reserved - ${c.ephemeralBytes},
      pods_reserved = pods_reserved - ${c.pods},
      attachments_reserved = attachments_reserved - ${c.attachments},
      active_users_reserved = active_users_reserved - ${c.activeUsers},
      durable_bytes_reserved = durable_bytes_reserved - ${s},
      revision = revision + 1,
      updated_at = now()
    WHERE id = ${poolId}::uuid`;
  if (released !== 1) throw new Error(`capacity pool ${poolId} is gone; a reservation cannot be released into it`);
}

/** The compute part of a stored share, as the amounts a release subtracts. */
export function computeOf(reservation: ManagedRunnerReservation | null): ComputeAmounts | null {
  const c = reservation?.compute;
  if (!c) return null;
  return { cpuMillis: c.cpuMillis, memoryBytes: c.memoryBytes, ephemeralBytes: c.ephemeralBytes, pods: c.pods, attachments: c.attachments, activeUsers: c.activeUsers };
}

/** Whether a mapping holds a compute share. */
export function holdsCompute(mapping: Pick<ManagedRunner, 'reservation'>): boolean {
  return !!readReservation(mapping.reservation)?.compute;
}

/** A client-safe sentence for what was short (nothing named: another admission took the room first). */
export function capacityShortMessage(short: readonly CapacityDimension[]): string {
  if (short.length === 0) {
    return 'The managed environment had no room for this runner when it was admitted. It starts by itself when room frees up; nothing was removed or resized to make room.';
  }
  const names: Record<CapacityDimension, string> = {
    cpu: 'CPU',
    memory: 'memory',
    ephemeralStorage: 'temporary storage',
    pods: 'runner slots',
    attachments: 'volume attachments',
    activeUsers: 'active managed users',
    storage: 'storage pool space',
  };
  return `The managed environment has no room for this runner right now (${short.map((d) => names[d]).join(', ')}). It starts by itself when room frees up; nothing was removed or resized to make room.`;
}
