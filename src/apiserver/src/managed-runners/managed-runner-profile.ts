import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

/**
 * The environment a managed runner manager may act in: one authorized test environment, named in a
 * JSON file whose path is ORBIT_MANAGED_RUNNERS_PROFILE (docs/managed-runner-design.md, "Optional
 * test deployment boundary"; example in deploy/managed-runner/manager-profile.example.json).
 *
 * Read only when ORBIT_MANAGED_RUNNERS_ENABLED=true, and only from that explicit path. It names the
 * exact kubeconfig file, context, API server and namespace — the manager never falls back to a
 * current context, a default namespace, KUBECONFIG, ~/.kube or in-cluster credentials — and states
 * every lifecycle budget, because none of them is a fact this repository can supply. A profile
 * that is missing anything leaves the feature unavailable; ordinary login is unaffected.
 */
export const MANAGED_RUNNERS_PROFILE_ENV = 'ORBIT_MANAGED_RUNNERS_PROFILE';

export interface ManagedRunnerResourceAmounts {
  requests: { cpu: string; memory: string };
  limits: { cpu: string; memory: string };
}

export interface ManagedRunnerProfile {
  schemaVersion: 1;
  valueKind: 'actual';
  /** The authorized environment's name: the Pod's `orbit-test-environment` label. */
  environmentId: string;
  /** Recorded on every mapping as its cluster; with namespace and PVC name, the location key. */
  clusterKey: string;
  /** Recorded on every mapping as `resourceProfileId`. */
  resourceProfileId: string;
  kubernetes: {
    /** Absolute path of a JSON kubeconfig. Only the context named below is read from it. */
    kubeconfig: string;
    context: string;
    /** The API server the context must point at, compared before the first request. */
    apiServer: string;
    namespace: string;
  };
  storage: { className: string; capacity: string };
  runner: {
    /** Pinned by digest: `<repository>@sha256:<64 hex>`. */
    image: string;
    /** The Orbit server the runner reports to: HTTPS, or HTTP to a loopback address. */
    serverUrl: string;
    maxConcurrent: number;
    tmpSizeLimit: string;
    resources: { runner: ManagedRunnerResourceAmounts; init: ManagedRunnerResourceAmounts };
  };
  lifecycle: {
    /** Attempts a transient failure may spend before the mapping is FAILED. */
    maxAttempts: number;
    backoffBaseSeconds: number;
    backoffMaxSeconds: number;
    /** From the first provisioning step to a fresh heartbeat. */
    startupDeadlineSeconds: number;
    requestTimeoutSeconds: number;
    leaseSeconds: number;
    pollIntervalSeconds: number;
    /** A heartbeat older than this does not make or keep a runner usable. */
    heartbeatFreshSeconds: number;
  };
}

export type ManagedRunnerProfileResult =
  | { ok: true; profile: ManagedRunnerProfile }
  | { ok: false; problems: string[] };

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const DNS_SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
const QUANTITY = /^[0-9]+(\.[0-9]+)?(m|k|M|G|T|P|E|Ki|Mi|Gi|Ti|Pi|Ei)?$/;
const PINNED_IMAGE = /^[^\s@]+@sha256:[0-9a-f]{64}$/;
/** What the example files and templates use for a value nobody has supplied yet. */
const PLACEHOLDER = /REPLACE_ME|__[A-Z0-9_]+__|\$\{/;

/** Validate a parsed profile. Every problem is reported, not just the first. */
export function parseManagedRunnerProfile(value: unknown): ManagedRunnerProfileResult {
  const problems: string[] = [];
  const at = (path: string): unknown =>
    path.split('.').reduce<unknown>((node, key) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined), value);
  const text = (path: string, shape?: RegExp, why?: string): string => {
    const v = at(path);
    if (typeof v !== 'string' || v.trim() === '' || v !== v.trim()) {
      problems.push(`${path} must be a non-empty string without surrounding whitespace`);
      return '';
    }
    if (PLACEHOLDER.test(v)) problems.push(`${path} is still a placeholder`);
    else if (shape && !shape.test(v)) problems.push(`${path} ${why ?? 'is malformed'}`);
    return v;
  };
  const count = (path: string, min: number, max: number): number => {
    const v = at(path);
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
      problems.push(`${path} must be an integer from ${min} to ${max}`);
      return min;
    }
    return v;
  };
  const https = (path: string, allowLoopbackHttp: boolean): string => {
    const v = text(path);
    if (!v || PLACEHOLDER.test(v)) return v;
    let url: URL;
    try {
      url = new URL(v);
    } catch {
      problems.push(`${path} is not a URL`);
      return v;
    }
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(allowLoopbackHttp && url.protocol === 'http:' && loopback)) {
      problems.push(`${path} must be an https URL`);
    }
    if (url.username || url.password || url.search || url.hash) problems.push(`${path} must not carry credentials, a query or a fragment`);
    return v.replace(/\/+$/, '');
  };
  const amounts = (path: string): ManagedRunnerResourceAmounts => ({
    requests: { cpu: text(`${path}.requests.cpu`, QUANTITY, 'is not a quantity'), memory: text(`${path}.requests.memory`, QUANTITY, 'is not a quantity') },
    limits: { cpu: text(`${path}.limits.cpu`, QUANTITY, 'is not a quantity'), memory: text(`${path}.limits.memory`, QUANTITY, 'is not a quantity') },
  });

  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, problems: ['the profile must be a JSON object'] };
  if (at('schemaVersion') !== 1) problems.push('schemaVersion must be 1');
  if (at('valueKind') !== 'actual') problems.push('valueKind must be "actual": an example profile authorizes nothing');

  const kubeconfig = text('kubernetes.kubeconfig');
  if (kubeconfig && !isAbsolute(kubeconfig)) problems.push('kubernetes.kubeconfig must be an absolute path');
  const backoffBaseSeconds = count('lifecycle.backoffBaseSeconds', 1, 3600);
  const backoffMaxSeconds = count('lifecycle.backoffMaxSeconds', 1, 86_400);
  if (backoffMaxSeconds < backoffBaseSeconds) problems.push('lifecycle.backoffMaxSeconds must not be below lifecycle.backoffBaseSeconds');

  const profile: ManagedRunnerProfile = {
    schemaVersion: 1,
    valueKind: 'actual',
    environmentId: text('environmentId', DNS_LABEL, 'must be a DNS label (a Kubernetes label value)'),
    clusterKey: text('clusterKey'),
    resourceProfileId: text('resourceProfileId'),
    kubernetes: {
      kubeconfig,
      context: text('kubernetes.context'),
      apiServer: https('kubernetes.apiServer', false),
      namespace: text('kubernetes.namespace', DNS_LABEL, 'must be a DNS label'),
    },
    storage: {
      className: text('storage.className', DNS_SUBDOMAIN, 'must be a DNS subdomain'),
      capacity: text('storage.capacity', QUANTITY, 'is not a quantity'),
    },
    runner: {
      image: text('runner.image', PINNED_IMAGE, 'must be pinned by digest (<repository>@sha256:<64 hex>)'),
      serverUrl: https('runner.serverUrl', true),
      maxConcurrent: count('runner.maxConcurrent', 1, 64),
      tmpSizeLimit: text('runner.tmpSizeLimit', QUANTITY, 'is not a quantity'),
      resources: { runner: amounts('runner.resources.runner'), init: amounts('runner.resources.init') },
    },
    lifecycle: {
      maxAttempts: count('lifecycle.maxAttempts', 1, 100),
      backoffBaseSeconds,
      backoffMaxSeconds,
      startupDeadlineSeconds: count('lifecycle.startupDeadlineSeconds', 30, 86_400),
      requestTimeoutSeconds: count('lifecycle.requestTimeoutSeconds', 1, 300),
      leaseSeconds: count('lifecycle.leaseSeconds', 5, 3600),
      pollIntervalSeconds: count('lifecycle.pollIntervalSeconds', 1, 3600),
      heartbeatFreshSeconds: count('lifecycle.heartbeatFreshSeconds', 30, 3600),
    },
  };
  return problems.length ? { ok: false, problems } : { ok: true, profile };
}

/** Read and validate the profile at `path`. Nothing is read when no path is configured. */
export function loadManagedRunnerProfile(
  path: string | undefined,
  readFile: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): ManagedRunnerProfileResult {
  if (!path || !path.trim()) return { ok: false, problems: [`${MANAGED_RUNNERS_PROFILE_ENV} names no profile file`] };
  if (!isAbsolute(path)) return { ok: false, problems: [`${MANAGED_RUNNERS_PROFILE_ENV} must be an absolute path`] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFile(path));
  } catch (error) {
    return { ok: false, problems: [`the profile at ${path} could not be read as JSON: ${(error as Error).message}`] };
  }
  return parseManagedRunnerProfile(parsed);
}
