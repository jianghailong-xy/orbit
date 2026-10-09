import type { ManagedRunnerManagementState } from '@prisma/client';

import type { Pod } from './kube-client';
import {
  GENERATION_ANNOTATION,
  OWNER_ANNOTATION,
  PVC_UID_ANNOTATION,
  RUNNER_ANNOTATION,
  managedPodName,
  managedSecretName,
  runnerIdOfManagedPvc,
} from './managed-runner-resources';

/**
 * The single-Pod admission guard (docs/managed-runner-design.md, "Single Pod and single writer
 * protection"): which Pod may use a managed runner's data volume. The optional environment installs
 * it as a validating admission webhook with `failurePolicy: Fail`
 * (deploy/managed-runner/admission/pod-admission-webhook.template.json), served by the Orbit
 * apiserver at POST /api/managed-runner/admission (managed-runner-admission.controller.ts).
 *
 * Why a webhook and not a ValidatingAdmissionPolicy: the authority is the database. The mapping
 * owns the PVC, and the generation the manager reserved — under the mapping row's compare-and-set,
 * with the one create it is about to send recorded as a pending CREATE_POD operation — is a row in
 * PostgreSQL. A policy's CEL sees only the request and a params object, so it would need a copy of
 * that reservation kept in the cluster, a second source of truth that can lag or move backwards.
 * Here the decision reads the row itself, and when Orbit, its database or the network is
 * unavailable the API server's `failurePolicy: Fail` refuses the Pod: closed, not open.
 *
 * Every Pod create or update in the managed namespace comes here, whatever its labels, its node,
 * its controller (a Job's Pods are created by the Job controller) or its mounts (read-only and init
 * containers included). A Pod that refers to no managed claim is not this guard's business. One that
 * refers to a managed claim — by a `mr-data-<uuid>` name, or one a mapping records — is admitted on
 * CREATE only if all of this holds:
 *
 *   - a mapping owns the claim (resolved from the database, never from the Pod's own labels);
 *   - the request comes from the manager's Kubernetes identity;
 *   - the Pod has the mapping's fixed name `mr-<runner uuid>`, and refers to that one claim;
 *   - its owner, runner, PVC UID and generation annotations are the mapping's, and that generation
 *     is reserved: the mapping is STARTING with no Pod recorded and a CREATE_POD pending;
 *   - every container runs the profile's pinned image, it has no ephemeral containers, and its
 *     volumes are only that claim, emptyDirs and its own bootstrap Secret — no host namespaces,
 *     host paths or privileged containers.
 *
 * Concurrent creates under the fixed name are left to the API server, which stores one object per
 * name; a create under any other name, or by anyone else, or for a generation that is not reserved,
 * is refused — on the same node or another, with or without labels. An UPDATE may not change the
 * Pod's volumes, images or identity annotations, and no ephemeral container may be added.
 *
 * Not an exclusive lock on the disk: a ReadWriteOnce claim lets two Pods on one node share it, and
 * RBD exclusive-lock passes between clients. This guard, the generation-bound runner credential and
 * the stop or fencing proof the manager needs before another generation (managed-runner-manager.ts)
 * are the protection together; none of them alone is.
 */

/** Every refusal message starts with this, so the manager's dry-run probe can recognise the guard. */
export const MANAGED_ADMISSION_DENIAL_MARKER = 'orbit-managed-runner-admission';

/** The parts of an AdmissionReview v1 request the decision reads. */
export interface PodAdmissionRequest {
  uid: string;
  kind?: { group?: string; version?: string; kind?: string };
  resource?: { group?: string; version?: string; resource?: string };
  subResource?: string;
  operation: string;
  namespace?: string;
  name?: string;
  userInfo?: { username?: string };
  object?: Pod | null;
  oldObject?: Pod | null;
  dryRun?: boolean;
}

/** What the decision needs of the mapping that owns a claim. */
export interface PodAdmissionMapping {
  ownerId: string;
  runnerId: string;
  generation: number;
  pvcName: string;
  pvcUid: string | null;
  podUid: string | null;
  managementState: ManagedRunnerManagementState;
  resourceOperationKind: string | null;
  resourceOperationState: string | null;
}

/** The profile's side: where managed Pods live, who creates them, and what they run. */
export interface PodAdmissionPolicy {
  namespace: string;
  managerUsername: string;
  image: string;
}

export type PodAdmissionDecision =
  | { allowed: true; reason: 'NOT_MANAGED' | 'AUTHORIZED' | 'UNCHANGED' }
  | { allowed: false; code: string; message: string };

const deny = (code: string, message: string): PodAdmissionDecision => ({ allowed: false, code, message });

type PodVolume = NonNullable<Pod['spec']['volumes']>[number];

function volumesOf(pod: Pod | null | undefined): PodVolume[] {
  return Array.isArray(pod?.spec?.volumes) ? pod!.spec.volumes! : [];
}

function containersOf(pod: Pod | null | undefined, key: 'initContainers' | 'containers' | 'ephemeralContainers'): Array<Record<string, unknown>> {
  const list = pod?.spec?.[key];
  return Array.isArray(list) ? (list as Array<Record<string, unknown>>) : [];
}

/**
 * Every claim name a Pod refers to: its persistentVolumeClaim volumes, and the claim each generic
 * ephemeral volume would create (`<pod name>-<volume name>`), which could otherwise be made to
 * collide with a managed claim's name.
 */
export function claimNamesOf(pod: Pod | null | undefined): string[] {
  const names = new Set<string>();
  for (const volume of volumesOf(pod)) {
    if (volume.persistentVolumeClaim?.claimName) names.add(volume.persistentVolumeClaim.claimName);
    if (volume.ephemeral && pod?.metadata?.name) names.add(`${pod.metadata.name}-${volume.name}`);
  }
  return [...names];
}

/** The claims of a request that look managed by name; the caller adds what a mapping records. */
export function managedLookingClaims(request: PodAdmissionRequest): string[] {
  const names = new Set([...claimNamesOf(request.object), ...claimNamesOf(request.oldObject)]);
  return [...names].filter((name) => runnerIdOfManagedPvc(name) !== null);
}

const ORBIT_ANNOTATIONS = [OWNER_ANNOTATION, RUNNER_ANNOTATION, GENERATION_ANNOTATION, PVC_UID_ANNOTATION];

function images(pod: Pod | null | undefined): string[] {
  return [...containersOf(pod, 'initContainers'), ...containersOf(pod, 'containers')].map((c) => String(c.image ?? ''));
}

/** Why the Pod is not the manager's runner template, or null when it is. */
function templateProblem(pod: Pod, mapping: PodAdmissionMapping, policy: PodAdmissionPolicy): string | null {
  const spec = pod.spec as Record<string, unknown>;
  if (spec.hostNetwork === true || spec.hostPID === true || spec.hostIPC === true) return 'it uses a host namespace';
  if (spec.automountServiceAccountToken !== false) return 'it mounts a service account token';
  if (containersOf(pod, 'ephemeralContainers').length > 0) return 'it has ephemeral containers';
  const all = [...containersOf(pod, 'initContainers'), ...containersOf(pod, 'containers')];
  if (all.length === 0 || all.some((c) => c.image !== policy.image)) return 'a container does not run the pinned runner image';
  if (all.some((c) => (c.securityContext as Record<string, unknown> | undefined)?.privileged === true)) return 'a container is privileged';
  for (const volume of volumesOf(pod)) {
    const kinds = Object.keys(volume).filter((key) => key !== 'name');
    const kind = kinds.length === 1 ? kinds[0] : null;
    if (kind === 'persistentVolumeClaim' && volume.persistentVolumeClaim?.claimName === mapping.pvcName) continue;
    if (kind === 'emptyDir') continue;
    if (kind === 'secret' && (volume.secret as { secretName?: unknown } | undefined)?.secretName === managedSecretName(mapping.runnerId)) continue;
    return `volume ${JSON.stringify(volume.name)} is not one a managed runner Pod may have`;
  }
  return null;
}

/** Same identity, same volumes, same images, before and after an update. */
function identityChanged(before: Pod, after: Pod): string | null {
  if (before.metadata?.name !== after.metadata?.name) return 'its name';
  for (const key of ORBIT_ANNOTATIONS) {
    if (before.metadata?.annotations?.[key] !== after.metadata?.annotations?.[key]) return `annotation ${key}`;
  }
  if (JSON.stringify(volumesOf(before)) !== JSON.stringify(volumesOf(after))) return 'its volumes';
  if (JSON.stringify(images(before)) !== JSON.stringify(images(after))) return 'its images';
  if (containersOf(after, 'ephemeralContainers').length > containersOf(before, 'ephemeralContainers').length) return 'its ephemeral containers';
  return null;
}

/**
 * The decision for one request. `mappings` holds, for each managed-looking claim and each claim a
 * mapping records, the mapping that owns it — null where none does.
 */
export function decidePodAdmission(
  request: PodAdmissionRequest,
  mappings: ReadonlyMap<string, PodAdmissionMapping | null>,
  policy: PodAdmissionPolicy,
): PodAdmissionDecision {
  if (request.resource?.resource !== undefined && request.resource.resource !== 'pods') {
    return deny('UNEXPECTED_RESOURCE', `this guard reviews Pods, not ${request.resource.resource}`);
  }
  // Claims resolve inside their own namespace: another namespace's Pod cannot name these volumes.
  if (request.namespace !== policy.namespace) return { allowed: true, reason: 'NOT_MANAGED' };
  const claims = [...new Set([...claimNamesOf(request.object), ...claimNamesOf(request.oldObject)])];
  const managed = claims.filter((name) => runnerIdOfManagedPvc(name) !== null || mappings.get(name));
  if (managed.length === 0) return { allowed: true, reason: 'NOT_MANAGED' };
  if (managed.length > 1) return deny('MULTIPLE_MANAGED_CLAIMS', 'a Pod may use at most one managed runner volume');
  const mapping = mappings.get(managed[0]) ?? null;
  if (!mapping) return deny('UNMAPPED_MANAGED_CLAIM', `no managed runner owns claim ${managed[0]}`);

  if (request.operation === 'UPDATE') {
    const before = request.oldObject;
    const after = request.object;
    if (!before || !after) return deny('MALFORMED_REQUEST', 'an update needs the Pod before and after');
    if (request.subResource === 'ephemeralcontainers' && containersOf(after, 'ephemeralContainers').length > 0) {
      return deny('EPHEMERAL_CONTAINER', 'no container may be added to a managed runner Pod');
    }
    const changed = identityChanged(before, after);
    return changed ? deny('IMMUTABLE_IDENTITY', `an update may not change ${changed}`) : { allowed: true, reason: 'UNCHANGED' };
  }
  if (request.operation !== 'CREATE' || request.subResource) {
    return deny('UNEXPECTED_OPERATION', `${request.operation}${request.subResource ? ` ${request.subResource}` : ''} on a Pod using a managed runner volume`);
  }

  const pod = request.object;
  if (!pod?.metadata) return deny('MALFORMED_REQUEST', 'a create needs the Pod');
  if (request.userInfo?.username !== policy.managerUsername) {
    return deny('NOT_THE_MANAGER', 'only the managed runner manager may create a Pod that uses a managed runner volume');
  }
  // The name a create carries; the API server fills it in for generateName only after mutation.
  const name = pod.metadata.name ?? request.name;
  if (name !== managedPodName(mapping.runnerId)) {
    return deny('NOT_THE_FIXED_NAME', `the one Pod of this volume is ${managedPodName(mapping.runnerId)}`);
  }
  const said = pod.metadata.annotations ?? {};
  if (said[OWNER_ANNOTATION] !== mapping.ownerId || said[RUNNER_ANNOTATION] !== mapping.runnerId) {
    return deny('NOT_THE_OWNER', 'the Pod does not name the owner and runner of this volume');
  }
  if (!mapping.pvcUid || said[PVC_UID_ANNOTATION] !== mapping.pvcUid) {
    return deny('NOT_THE_VOLUME', 'the Pod was not authorized for this volume');
  }
  if (said[GENERATION_ANNOTATION] !== String(mapping.generation)) {
    return deny('NOT_THE_RESERVED_GENERATION', `the reserved generation is ${mapping.generation}`);
  }
  const reserved = mapping.managementState === 'STARTING'
    && mapping.podUid === null
    && mapping.resourceOperationKind === 'CREATE_POD'
    && mapping.resourceOperationState === 'PENDING';
  if (!reserved) {
    return deny('NOT_RESERVED', `generation ${mapping.generation} has no Pod creation reserved (${mapping.managementState})`);
  }
  const problem = templateProblem(pod, mapping, policy);
  if (problem) return deny('NOT_THE_TEMPLATE', `the Pod is not the managed runner template: ${problem}`);
  return { allowed: true, reason: 'AUTHORIZED' };
}

/** The AdmissionReview v1 answer to `request`. */
export function admissionReviewResponse(uid: string, decision: PodAdmissionDecision) {
  return {
    apiVersion: 'admission.k8s.io/v1',
    kind: 'AdmissionReview',
    response: decision.allowed
      ? { uid, allowed: true }
      : {
        uid,
        allowed: false,
        status: { code: 403, reason: 'Forbidden', message: `${MANAGED_ADMISSION_DENIAL_MARKER}: ${decision.code}: ${decision.message}` },
      },
  };
}
