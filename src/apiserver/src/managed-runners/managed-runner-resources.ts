import type { PersistentVolume, PersistentVolumeClaim, Pod, Secret } from './kube-client';
import type { ManagedRunnerProfile } from './managed-runner-profile';

/**
 * The Kubernetes objects of one managed runner, built exactly as deploy/managed-runner describes
 * them, and the identity checks the manager applies to whatever it finds under their names.
 *
 *   PVC     mr-data-<runner uuid>   deploy/managed-runner/storage/pvc.template.json
 *   Pod     mr-<runner uuid>        deploy/managed-runner/runner-pod.yaml.example
 *   Secret  mr-boot-<runner uuid>   the bootstrap credential of the Pod's generation
 *
 * Names come from the canonical runner UUID and nothing else (a CHECK on `managed_runner` holds the
 * PVC and Pod names to it), so a retried or concurrent create can only ever meet the same object.
 * The PVC has no owner reference: no Pod, Job or other disposable compute owns a data volume.
 *
 * A managed runner does not enroll: its row already exists, so the manager issues that row's
 * credential itself, for one generation, and hands it over in the bootstrap Secret — mounted at
 * /run/orbit-bootstrap, the credential named by ORBIT_RUNNER_CREDENTIAL_FILE and its generation
 * beside it. The control plane keeps only the credential's hash (docs/managed-runner-design.md,
 * "Identity and durable mapping"). The Pod tells the runner which instance it is through the
 * Downward API: its generation annotation and its own UID, as ORBIT_MANAGED_RUNNER_GENERATION and
 * ORBIT_MANAGED_RUNNER_POD_UID, which the image entrypoint checks against the Secret and the runner
 * sends with every request (managed-runner-instance.ts).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const OWNER_ANNOTATION = 'orbit.dev/owner-id';
export const RUNNER_ANNOTATION = 'orbit.dev/runner-id';
export const GENERATION_ANNOTATION = 'orbit.dev/generation';
export const PVC_UID_ANNOTATION = 'orbit.dev/pvc-uid';

/** The runner name every managed runner reports, and ORBIT_RUNNER_NAME in its Pod. */
export const MANAGED_RUNNER_NAME = 'orbit-managed';
/** Where the default workspace works: the image's fixed checkout (deploy/managed-runner/README.md). */
export const MANAGED_WORKSPACE_DIR = '/var/lib/orbit/home/orbit-repos/default';
export const MANAGED_WORKSPACE_NAME = 'Default';
/** The Pod example's grace: beyond the 170-second supervisor/lease/event envelope. */
export const MANAGED_POD_TERMINATION_GRACE_SECONDS = 240;
export const BOOTSTRAP_MOUNT = '/run/orbit-bootstrap';
export const BOOTSTRAP_KEY = 'token';
/** The bootstrap Secret's second key: the generation its credential was issued for. */
export const BOOTSTRAP_GENERATION_KEY = 'generation';
export const CREDENTIAL_FILE_ENV = 'ORBIT_RUNNER_CREDENTIAL_FILE';
/** The instance identity the runner sends (runner-go managed_instance.go), from the Downward API. */
export const GENERATION_ENV = 'ORBIT_MANAGED_RUNNER_GENERATION';
export const POD_UID_ENV = 'ORBIT_MANAGED_RUNNER_POD_UID';

function canonical(runnerId: string): string {
  const id = runnerId.toLowerCase();
  if (!UUID.test(id)) throw new Error(`managed runner names need a canonical runner UUID, got ${JSON.stringify(runnerId)}`);
  return id;
}

export const managedPodName = (runnerId: string): string => `mr-${canonical(runnerId)}`;
export const managedPvcName = (runnerId: string): string => `mr-data-${canonical(runnerId)}`;
export const managedSecretName = (runnerId: string): string => `mr-boot-${canonical(runnerId)}`;
/** The ConfigMap an operator writes a fencing receipt into (managed-runner-fencing.ts). */
export const managedFencingReceiptName = (runnerId: string): string => `mr-fence-${canonical(runnerId)}`;
/** A dry-run Pod the admission guard must refuse: proof the guard is in force before a real create. */
export const managedAdmissionProbeName = (runnerId: string): string => `mr-${canonical(runnerId)}-admission-probe`;

/** The runner UUID a managed PVC name was derived from, or null for any other name. */
export function runnerIdOfManagedPvc(claimName: string): string | null {
  const match = /^mr-data-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(claimName);
  return match ? match[1] : null;
}

/** What every builder and check needs to know about the mapping. */
export interface ManagedRunnerIdentity {
  ownerId: string;
  runnerId: string;
  generation: number;
  namespace: string;
}

export function buildManagedPvc(identity: ManagedRunnerIdentity, profile: ManagedRunnerProfile): PersistentVolumeClaim {
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: {
      name: managedPvcName(identity.runnerId),
      namespace: identity.namespace,
      annotations: {
        [OWNER_ANNOTATION]: identity.ownerId,
        [RUNNER_ANNOTATION]: identity.runnerId,
      },
    },
    spec: {
      storageClassName: profile.storage.className,
      accessModes: ['ReadWriteOnce'],
      volumeMode: 'Filesystem',
      resources: { requests: { storage: profile.storage.capacity } },
    },
  };
}

/** The bootstrap Secret: the runner credential of `identity.generation`, immutable once created. */
export function buildManagedSecret(identity: ManagedRunnerIdentity, credential: string): Secret {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    type: 'Opaque',
    immutable: true,
    metadata: {
      name: managedSecretName(identity.runnerId),
      namespace: identity.namespace,
      labels: { 'app.kubernetes.io/name': 'orbit-managed-runner' },
      annotations: {
        [OWNER_ANNOTATION]: identity.ownerId,
        [RUNNER_ANNOTATION]: identity.runnerId,
        [GENERATION_ANNOTATION]: String(identity.generation),
      },
    },
    data: {
      [BOOTSTRAP_KEY]: Buffer.from(credential, 'utf8').toString('base64'),
      [BOOTSTRAP_GENERATION_KEY]: Buffer.from(String(identity.generation), 'utf8').toString('base64'),
    },
  };
}

/** The generation a bootstrap Secret says it was issued for, or null when it says none. */
export function secretGeneration(secret: Secret): number | null {
  const said = secret.metadata.annotations?.[GENERATION_ANNOTATION];
  return said && /^[1-9][0-9]*$/.test(said) ? Number(said) : null;
}

/** The credential a bootstrap Secret carries, or null when it carries none. */
export function bootstrapCredentialOf(secret: Secret): string | null {
  const encoded = secret.data?.[BOOTSTRAP_KEY];
  if (!encoded) return null;
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  return decoded.length > 0 ? decoded : null;
}

/** The fixed-name bare Pod of `identity.generation`, as runner-pod.yaml.example lays it out. */
export function buildManagedPod(identity: ManagedRunnerIdentity, pvcUid: string, profile: ManagedRunnerProfile): Pod {
  const runner = profile.runner;
  const stateMounts = [
    { name: 'user-state', mountPath: '/var/lib/orbit' },
    { name: 'temporary', mountPath: '/tmp' },
  ];
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: managedPodName(identity.runnerId),
      namespace: identity.namespace,
      labels: {
        'app.kubernetes.io/name': 'orbit-managed-runner',
        'orbit-test-environment': profile.environmentId,
      },
      annotations: {
        [OWNER_ANNOTATION]: identity.ownerId,
        [RUNNER_ANNOTATION]: identity.runnerId,
        [GENERATION_ANNOTATION]: String(identity.generation),
        [PVC_UID_ANNOTATION]: pvcUid,
      },
    },
    spec: {
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      hostNetwork: false,
      hostPID: false,
      hostIPC: false,
      terminationGracePeriodSeconds: MANAGED_POD_TERMINATION_GRACE_SECONDS,
      securityContext: { seccompProfile: { type: 'RuntimeDefault' } },
      initContainers: [
        {
          name: 'private-volume-directories',
          image: runner.image,
          args: ['init-volume'],
          securityContext: {
            runAsUser: 0,
            runAsGroup: 0,
            runAsNonRoot: false,
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            capabilities: { drop: ['ALL'], add: ['CHOWN', 'FOWNER', 'DAC_OVERRIDE'] },
          },
          resources: runner.resources.init,
          volumeMounts: stateMounts,
        },
      ],
      containers: [
        {
          name: 'runner',
          image: runner.image,
          args: ['run'],
          securityContext: {
            runAsUser: 10001,
            runAsGroup: 10001,
            runAsNonRoot: true,
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            capabilities: { drop: ['ALL'] },
          },
          env: [
            { name: 'ORBIT_RUNNER_SERVER_URL', value: runner.serverUrl },
            { name: 'ORBIT_RUNNER_NAME', value: MANAGED_RUNNER_NAME },
            { name: 'ORBIT_RUNNER_MAX_CONCURRENT', value: String(runner.maxConcurrent) },
            { name: 'ORBIT_RUNNER_EXPECTED_ID', value: identity.runnerId },
            { name: CREDENTIAL_FILE_ENV, value: `${BOOTSTRAP_MOUNT}/${BOOTSTRAP_KEY}` },
            // Which instance this is, as the API server recorded it: never a value the manager or
            // the runner could get wrong for another Pod.
            { name: GENERATION_ENV, valueFrom: { fieldRef: { fieldPath: `metadata.annotations['${GENERATION_ANNOTATION}']` } } },
            { name: POD_UID_ENV, valueFrom: { fieldRef: { fieldPath: 'metadata.uid' } } },
          ],
          resources: runner.resources.runner,
          volumeMounts: [...stateMounts, { name: 'bootstrap', mountPath: BOOTSTRAP_MOUNT, readOnly: true }],
        },
      ],
      volumes: [
        { name: 'user-state', persistentVolumeClaim: { claimName: managedPvcName(identity.runnerId) } },
        { name: 'temporary', emptyDir: { sizeLimit: runner.tmpSizeLimit } },
        {
          name: 'bootstrap',
          // Readable by the runner's UID without fsGroup, whose recursive mode changes could widen
          // private ORBIT_HOME permissions — the example's reasoning for its enrollment Secret.
          secret: {
            secretName: managedSecretName(identity.runnerId),
            defaultMode: 0o444,
            items: [
              { key: BOOTSTRAP_KEY, path: BOOTSTRAP_KEY },
              { key: BOOTSTRAP_GENERATION_KEY, path: BOOTSTRAP_GENERATION_KEY },
            ],
          },
        },
      ],
    },
  };
}

const sameList = (a: readonly string[] | undefined, b: readonly string[]) =>
  !!a && a.length === b.length && a.every((value, i) => value === b[i]);

function annotationProblem(kind: string, meta: { annotations?: Record<string, string> }, identity: ManagedRunnerIdentity): string | null {
  const said = meta.annotations ?? {};
  if (said[OWNER_ANNOTATION] !== identity.ownerId) return `${kind} names another owner (or none)`;
  if (said[RUNNER_ANNOTATION] !== identity.runnerId) return `${kind} names another runner (or none)`;
  return null;
}

/**
 * Why the PVC found under the mapping's name is not the mapping's data volume, or null when it is.
 * A recorded UID must match exactly: a recreated claim under the same name is a different disk.
 */
export function pvcIdentityProblem(
  pvc: PersistentVolumeClaim,
  identity: ManagedRunnerIdentity,
  profile: ManagedRunnerProfile,
  recordedUid: string | null,
): string | null {
  if (recordedUid && pvc.metadata.uid !== recordedUid) return 'the PVC under this name has a different UID from the one recorded';
  const annotated = annotationProblem('the PVC', pvc.metadata, identity);
  if (annotated) return annotated;
  if ((pvc.metadata.ownerReferences ?? []).length > 0) return 'the PVC has an owner reference; a data volume is owned by no compute object';
  if (pvc.spec.storageClassName !== profile.storage.className) return 'the PVC uses another storage class';
  if (!sameList(pvc.spec.accessModes, ['ReadWriteOnce'])) return 'the PVC has other access modes than ReadWriteOnce';
  if ((pvc.spec.volumeMode ?? 'Filesystem') !== 'Filesystem') return 'the PVC is not a Filesystem volume';
  return null;
}

/** Why the PV a bound claim names is not that claim's recorded volume, or null when it is. */
export function pvIdentityProblem(
  pv: PersistentVolume,
  pvcUid: string,
  profile: ManagedRunnerProfile,
  recorded: { pvUid: string | null; volumeHandle: string | null },
): string | null {
  if (pv.spec.claimRef?.uid !== pvcUid) return 'the PV is bound to another claim';
  if (pv.spec.storageClassName !== profile.storage.className) return 'the PV belongs to another storage class';
  const handle = pv.spec.csi?.volumeHandle;
  if (!handle) return 'the PV has no CSI volume handle';
  if (recorded.pvUid && pv.metadata.uid !== recorded.pvUid) return 'the PV has a different UID from the one recorded';
  if (recorded.volumeHandle && handle !== recorded.volumeHandle) return 'the PV has a different volume handle from the one recorded';
  return null;
}

export function secretIdentityProblem(secret: Secret, identity: ManagedRunnerIdentity): string | null {
  const annotated = annotationProblem('the bootstrap Secret', secret.metadata, identity);
  if (annotated) return annotated;
  if (secret.metadata.annotations?.[GENERATION_ANNOTATION] !== String(identity.generation)) {
    return 'the bootstrap Secret is for another generation';
  }
  if (!bootstrapCredentialOf(secret)) return 'the bootstrap Secret carries no credential';
  return null;
}

export function podIdentityProblem(pod: Pod, identity: ManagedRunnerIdentity, pvcUid: string): string | null {
  const annotated = annotationProblem('the Pod', pod.metadata, identity);
  if (annotated) return annotated;
  const said = pod.metadata.annotations ?? {};
  if (said[GENERATION_ANNOTATION] !== String(identity.generation)) return 'the Pod is of another generation';
  if (said[PVC_UID_ANNOTATION] !== pvcUid) return 'the Pod was authorized for another PVC';
  const claims = (pod.spec.volumes ?? []).flatMap((v) => (v.persistentVolumeClaim ? [v.persistentVolumeClaim.claimName] : []));
  if (!sameList(claims, [managedPvcName(identity.runnerId)])) return "the Pod mounts another claim than the mapping's data volume";
  return null;
}

/** Whether a Pod has finished: its containers ran and stopped, and it will not start again. */
export function podTerminated(pod: Pod): boolean {
  return pod.status?.phase === 'Succeeded' || pod.status?.phase === 'Failed';
}

/**
 * The reasons of a DisruptionTarget condition the control plane writes for a node it cannot reach
 * or has been told is out of service — PodGC and the taint manager. A Pod they made terminal was
 * declared stopped on its node's behalf, which is exactly when its processes cannot be vouched for.
 */
const CONTROL_PLANE_DISRUPTIONS: ReadonlySet<string> = new Set(['DeletionByPodGC', 'DeletionByTaintManager']);

function declaredContainers(pod: Pod, key: 'initContainers' | 'containers'): string[] {
  const list = pod.spec[key];
  return Array.isArray(list) ? list.map((c) => (c as { name?: unknown }).name).filter((n): n is string => typeof n === 'string') : [];
}

/**
 * Whether the kubelet reported this Pod stopped (docs/managed-runner-design.md, "Single Pod and
 * single writer protection"): a terminal phase, a report for every container the Pod declares —
 * each terminated, or still waiting because it never started — at least one of them terminated, and
 * no sign that the control plane made the Pod terminal for an unreachable node. Container states
 * are written by the kubelet alone. This is half of a stop proof; the Pod object's deletion and the
 * volume's detachment are the rest.
 */
export function podStopConfirmed(pod: Pod): boolean {
  if (!podTerminated(pod)) return false;
  const status = pod.status ?? {};
  const markedByControlPlane = (status.conditions ?? []).some(
    (c) => c.type === 'DisruptionTarget' && c.status === 'True' && CONTROL_PLANE_DISRUPTIONS.has(c.reason ?? ''),
  );
  if (markedByControlPlane) return false;
  const declared = [...declaredContainers(pod, 'initContainers'), ...declaredContainers(pod, 'containers')];
  const reported = new Map([...(status.initContainerStatuses ?? []), ...(status.containerStatuses ?? [])].map((c) => [c.name, c.state]));
  if (declared.length === 0) return false;
  let terminated = 0;
  for (const name of declared) {
    const state = reported.get(name);
    if (!state || state.running) return false;
    if (state.terminated) terminated += 1;
    else if (!state.waiting) return false;
  }
  return terminated > 0;
}
