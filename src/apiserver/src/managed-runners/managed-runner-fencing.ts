import type { ConfigMap, PersistentVolume, Pod } from './kube-client';

/**
 * Proof that a managed runner's recorded instance has stopped, which is what the manager needs
 * before it authorizes another generation against the same volume (docs/managed-runner-design.md,
 * "Single Pod and single writer protection"). There are exactly two kinds, and the mapping's
 * `fencingReceipt` column holds the one that retired the current predecessor:
 *
 *   OBSERVED_STOP    the manager saw the kubelet report every container of that Pod UID stopped
 *                    (managed-runner-resources.ts, podStopConfirmed);
 *   FENCING_RECEIPT  an infrastructure operator fenced the node or its storage clients and left a
 *                    receipt, bound to that instance and volume, for the manager to read.
 *
 * Either one is half the gate: the Pod object must also be gone and no VolumeAttachment may hold
 * the volume before the generation advances. A heartbeat that stopped, a lease that expired, a Pod
 * object that disappeared without the kubelet's report, a cordon or a lock break prove nothing.
 *
 * The manager has no power over nodes or Ceph and never performs a fencing action. The receipt is
 * the operator's record of one, delivered as ConfigMap `mr-fence-<runner-uuid>` in the managed
 * namespace, key `receipt.json` — a kind of object the manager may read and may not write. The
 * format below follows the design's fault procedure: who did what to which predecessor, and an
 * independent observation that it took effect.
 */

export const FENCING_RECEIPT_KEY = 'receipt.json';
export const FENCING_RECEIPT_KIND = 'orbit.managed-runner.fencing-receipt';

/** The instance a proof is about: what the mapping recorded for the generation being retired. */
export interface ManagedRunnerPredecessor {
  runnerId: string;
  generation: number;
  podName: string;
  podUid: string;
  nodeName: string | null;
  pvcUid: string;
  volumeHandle: string;
}

/** A fencing receipt, schema version 1. Every field is required unless marked. */
export interface FencingReceiptV1 {
  schemaVersion: 1;
  kind: typeof FENCING_RECEIPT_KIND;
  /** NODE_POWER_OFF: the old node powered off through its BMC or hypervisor and kept off.
   *  STORAGE_FENCE: every client of the old node persistently blocklisted by a tested procedure. */
  method: 'NODE_POWER_OFF' | 'STORAGE_FENCE';
  predecessor: {
    runnerId: string;
    generation: number;
    podName: string;
    podUid: string;
    nodeName: string;
    nodeUid: string;
    pvcUid: string;
    volumeHandle: string;
    /** The RBD image behind the volume, compared with the PV when the PV states it. */
    rbdImage: { pool: string; image: string };
  };
  /** The fencing action, as the operator performed it. */
  action: { performedBy: string; performedAt: string; description: string; reference: string };
  /** The independent observation that the action took effect. */
  verification: { observedBy: string; observedAt: string; result: 'POWERED_OFF' | 'CLIENTS_BLOCKLISTED'; evidenceReference: string };
  /** NODE_POWER_OFF only. */
  nodePowerOff?: { mechanism: 'BMC' | 'HYPERVISOR'; quarantined: true; quarantineReference: string };
  /** STORAGE_FENCE only. A temporary blocklist, one lock break or a token rotation is not a fence. */
  storageFence?: {
    procedureReference: string;
    blocklistedClients: Array<{ address: string; nonce: string }>;
    osdMapEpoch: number;
    propagationVerifiedAt: string;
    persistent: true;
    expiresAt: null;
    rejoinPolicy: string;
  };
}

export interface ObservedStopProof {
  kind: 'OBSERVED_STOP';
  predecessor: ManagedRunnerPredecessor;
  recordedAt: string;
  observation: {
    phase: string;
    containers: Array<{ name: string; state: 'terminated' | 'waiting'; exitCode?: number; finishedAt?: string }>;
  };
  /** Set when the generation advanced on this proof. */
  retiredAt?: string;
}

export interface FencingReceiptProof {
  kind: 'FENCING_RECEIPT';
  predecessor: ManagedRunnerPredecessor;
  recordedAt: string;
  source: { configMap: string; uid: string | null; resourceVersion: string | null };
  receipt: FencingReceiptV1;
  retiredAt?: string;
}

export type ManagedRunnerStopProof = ObservedStopProof | FencingReceiptProof;

/** How far a receipt's clocks may run ahead of the manager's. */
const CLOCK_SKEW_MS = 5 * 60_000;

/** The stored proof, if it is about exactly this predecessor and has not retired it already. */
export function stopProofFor(stored: unknown, predecessor: ManagedRunnerPredecessor): ManagedRunnerStopProof | null {
  if (!stored || typeof stored !== 'object') return null;
  const proof = stored as Partial<ManagedRunnerStopProof>;
  if ((proof.kind !== 'OBSERVED_STOP' && proof.kind !== 'FENCING_RECEIPT') || proof.retiredAt) return null;
  const p = proof.predecessor as Partial<ManagedRunnerPredecessor> | undefined;
  if (!p || p.runnerId !== predecessor.runnerId || p.generation !== predecessor.generation || p.podUid !== predecessor.podUid) return null;
  if (p.pvcUid !== predecessor.pvcUid || p.volumeHandle !== predecessor.volumeHandle) return null;
  return proof as ManagedRunnerStopProof;
}

/** The kubelet's report of a stopped Pod, as recorded. The caller has checked podStopConfirmed. */
export function observedStop(predecessor: ManagedRunnerPredecessor, pod: Pod, now: Date): ObservedStopProof {
  const statuses = [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])];
  return {
    kind: 'OBSERVED_STOP',
    predecessor,
    recordedAt: now.toISOString(),
    observation: {
      phase: pod.status?.phase ?? '',
      containers: statuses.map((c) =>
        c.state?.terminated
          ? {
            name: c.name,
            state: 'terminated' as const,
            ...(c.state.terminated.exitCode !== undefined ? { exitCode: c.state.terminated.exitCode } : {}),
            ...(c.state.terminated.finishedAt ? { finishedAt: c.state.terminated.finishedAt } : {}),
          }
          : { name: c.name, state: 'waiting' as const },
      ),
    },
  };
}

export type FencingReceiptVerdict =
  | { ok: true; proof: FencingReceiptProof }
  | { ok: false; problems: string[] };

/**
 * Read the receipt in `configMap` and accept it only if it is complete and bound to `predecessor`:
 * the same runner, generation, Pod name and UID, node, PVC UID and volume handle, and the RBD image
 * the PV names, when it names one. Every problem is reported, not just the first.
 */
export function readFencingReceipt(
  configMap: ConfigMap,
  predecessor: ManagedRunnerPredecessor,
  pv: PersistentVolume | null,
  now: Date,
): FencingReceiptVerdict {
  const problems: string[] = [];
  const raw = configMap.data?.[FENCING_RECEIPT_KEY];
  if (typeof raw !== 'string') return { ok: false, problems: [`ConfigMap ${configMap.metadata.name} has no ${FENCING_RECEIPT_KEY}`] };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, problems: [`${FENCING_RECEIPT_KEY} is not JSON`] };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, problems: [`${FENCING_RECEIPT_KEY} is not an object`] };

  const at = (path: string): unknown =>
    path.split('.').reduce<unknown>((node, key) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined), value);
  const text = (path: string): string => {
    const v = at(path);
    if (typeof v !== 'string' || !v.trim()) {
      problems.push(`${path} must be a non-empty string`);
      return '';
    }
    return v;
  };
  const time = (path: string): number => {
    const v = text(path);
    const ms = v ? Date.parse(v) : NaN;
    if (v && (!/^\d{4}-\d{2}-\d{2}T/.test(v) || Number.isNaN(ms))) problems.push(`${path} must be an ISO 8601 time`);
    else if (v && ms > now.getTime() + CLOCK_SKEW_MS) problems.push(`${path} is in the future`);
    return ms;
  };
  const same = (path: string, expected: string | number) => {
    const v = at(path);
    if (v !== expected) problems.push(`${path} is ${JSON.stringify(v)}, not the recorded ${JSON.stringify(expected)}`);
  };

  if (at('schemaVersion') !== 1) problems.push('schemaVersion must be 1');
  if (at('kind') !== FENCING_RECEIPT_KIND) problems.push(`kind must be ${FENCING_RECEIPT_KIND}`);
  const method = at('method');
  if (method !== 'NODE_POWER_OFF' && method !== 'STORAGE_FENCE') problems.push('method must be NODE_POWER_OFF or STORAGE_FENCE');

  // Bound to this predecessor and this volume, field by field.
  same('predecessor.runnerId', predecessor.runnerId);
  same('predecessor.generation', predecessor.generation);
  same('predecessor.podName', predecessor.podName);
  same('predecessor.podUid', predecessor.podUid);
  same('predecessor.pvcUid', predecessor.pvcUid);
  same('predecessor.volumeHandle', predecessor.volumeHandle);
  const nodeName = text('predecessor.nodeName');
  if (predecessor.nodeName && nodeName && nodeName !== predecessor.nodeName) {
    problems.push(`predecessor.nodeName is ${JSON.stringify(nodeName)}, not the recorded ${JSON.stringify(predecessor.nodeName)}`);
  }
  text('predecessor.nodeUid');
  const pool = text('predecessor.rbdImage.pool');
  const image = text('predecessor.rbdImage.image');
  const attributes = pv?.spec.csi?.volumeAttributes ?? {};
  if (attributes.pool && pool && attributes.pool !== pool) problems.push(`predecessor.rbdImage.pool is ${JSON.stringify(pool)}, not the PV's ${JSON.stringify(attributes.pool)}`);
  if (attributes.imageName && image && attributes.imageName !== image) {
    problems.push(`predecessor.rbdImage.image is ${JSON.stringify(image)}, not the PV's ${JSON.stringify(attributes.imageName)}`);
  }

  text('action.performedBy');
  text('action.description');
  text('action.reference');
  const performedAt = time('action.performedAt');
  text('verification.observedBy');
  text('verification.evidenceReference');
  const observedAt = time('verification.observedAt');
  if (observedAt < performedAt) problems.push('verification.observedAt is before action.performedAt');

  if (method === 'NODE_POWER_OFF') {
    if (at('verification.result') !== 'POWERED_OFF') problems.push('verification.result must be POWERED_OFF for NODE_POWER_OFF');
    const mechanism = at('nodePowerOff.mechanism');
    if (mechanism !== 'BMC' && mechanism !== 'HYPERVISOR') problems.push('nodePowerOff.mechanism must be BMC or HYPERVISOR');
    if (at('nodePowerOff.quarantined') !== true) problems.push('nodePowerOff.quarantined must be true: the node stays out until its stale Pods and mounts are gone');
    text('nodePowerOff.quarantineReference');
  }
  if (method === 'STORAGE_FENCE') {
    if (at('verification.result') !== 'CLIENTS_BLOCKLISTED') problems.push('verification.result must be CLIENTS_BLOCKLISTED for STORAGE_FENCE');
    text('storageFence.procedureReference');
    const clients = at('storageFence.blocklistedClients');
    if (!Array.isArray(clients) || clients.length === 0) problems.push('storageFence.blocklistedClients must list every blocklisted client');
    else if (clients.some((c) => !c || typeof c.address !== 'string' || !c.address || typeof c.nonce !== 'string' || !c.nonce)) {
      problems.push('storageFence.blocklistedClients entries need an address and a nonce');
    }
    const epoch = at('storageFence.osdMapEpoch');
    if (typeof epoch !== 'number' || !Number.isInteger(epoch) || epoch < 1) problems.push('storageFence.osdMapEpoch must be a positive integer');
    const propagated = time('storageFence.propagationVerifiedAt');
    if (propagated < performedAt) problems.push('storageFence.propagationVerifiedAt is before action.performedAt');
    if (at('storageFence.persistent') !== true) problems.push('storageFence.persistent must be true: a temporary blocklist is not a fence');
    if (at('storageFence.expiresAt') !== null) problems.push('storageFence.expiresAt must be null: an expiring blocklist is not a fence');
    text('storageFence.rejoinPolicy');
  }

  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    proof: {
      kind: 'FENCING_RECEIPT',
      predecessor,
      recordedAt: now.toISOString(),
      source: {
        configMap: configMap.metadata.name,
        uid: configMap.metadata.uid ?? null,
        resourceVersion: configMap.metadata.resourceVersion ?? null,
      },
      receipt: value as FencingReceiptV1,
    },
  };
}
