import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';

import { MANAGED_RUNNER_BACKENDS } from './managed-runner-backend';
import { capacityBudget, computeShare, quantityUnits, storageShare } from './managed-runner-capacity';

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
 *
 * `backend` chooses the run backend (managed-runner-backend.ts). Absent, it is `kubernetes`, which
 * every profile written before the field existed means; ManagedRunnerProfile is that backend's shape.
 * `docker` is DockerRunnerProfile: one host's Docker, reached only through the restricted Docker
 * channel (deploy/managed-runner/docker-channel), with the same lifecycle budgets and a capacity
 * budget derived from the host unless the profile states it.
 */
export const MANAGED_RUNNERS_PROFILE_ENV = 'ORBIT_MANAGED_RUNNERS_PROFILE';

export interface ManagedRunnerResourceAmounts {
  requests: { cpu: string; memory: string };
  limits: { cpu: string; memory: string };
}

export interface ManagedRunnerProfile {
  schemaVersion: 1;
  valueKind: 'actual';
  /** The run backend. Absent: `kubernetes`; a profile states it only when its file does. */
  backend?: 'kubernetes';
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
  /**
   * The single-Pod admission guard (managed-runner-admission.ts). The manager creates nothing until a
   * dry run shows the guard refusing a Pod it must refuse.
   */
  admission: {
    /** The username the API server gives the manager's credential (request.userInfo.username):
     *  the only identity allowed to create a Pod that uses a managed runner volume. */
    managerUsername: string;
    /** SHA-256 (hex) of the bearer token the API server presents to the webhook. Never the token. */
    webhookTokenSha256: string;
  };
  /**
   * The fixed budget of this environment (managed-runner-capacity.ts): what every managed runner
   * holding compute may reserve together, and the storage pool every data volume is reserved from.
   * Supplied by the test owner; never derived from what the cluster reports or from session limits.
   */
  capacity: {
    compute: {
      /** CPU requests, summed over every runner Pod admitted at once. */
      cpu: string;
      /** Memory requests, likewise. */
      memory: string;
      /** Ephemeral storage: each Pod reserves its `/tmp` bound (`runner.tmpSizeLimit`). */
      ephemeralStorage: string;
      /** Runner Pods admitted at once. */
      pods: number;
      /** Data volumes attached at once: one per admitted Pod. */
      attachments: number;
    };
    storage: {
      /** The pool's safe usable capacity: after replication and near-full thresholds, not raw disk. */
      usable: string;
      /** Kept free of data volumes: snapshots, backups and recovery. */
      headroom: string;
    };
    /** Managed users whose runner holds compute at once. */
    maxActiveUsers: number;
  };
  lifecycle: {
    /** Attempts in a row — failed tries on the way up, and restarts after an instance stopped — before the mapping is FAILED. */
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
    /** How long a READY runner with no work and no demand stays up before it drains to sleep. */
    idleSeconds: number;
    /** How often an intent waiting for capacity tries again when no release told it to. */
    capacityRetrySeconds: number;
    /** How long a runner asked to stop for sleep may take before the delay is reported. It is
     *  never forced: only its own exit, as the kubelet reports it, ends the instance. */
    drainSeconds: number;
  };
}

/**
 * The Docker backend's environment (docker-backend.ts): one host's Docker, reached only through the
 * restricted Docker channel, never its socket. Every amount a runner reserves is stated here; the
 * pool's budget is derived from the host the channel reports (CPU, memory, the disk Docker's
 * volumes live on) less a reserve, unless `capacity` states a dimension outright.
 */
export interface DockerRunnerProfile {
  schemaVersion: 1;
  valueKind: 'actual';
  backend: 'docker';
  environmentId: string;
  /** Recorded on every mapping as its cluster; with the instance (the mapping's namespace), the pool's key. */
  clusterKey: string;
  resourceProfileId: string;
  docker: {
    /** The label value every managed resource carries (`orbit.managed-runner.instance`); the channel's own. */
    instanceId: string;
    /** Where the channel listens: a unix socket, or a loopback HTTP address. */
    channel: { socketPath: string } | { url: string };
    /** Absolute path of the file holding the channel's bearer token. */
    tokenFile: string;
  };
  /** One data volume's disk limit, and its storage share of the pool. */
  storage: { capacity: string };
  runner: {
    /** The locally built managed runner image, by its image ID: `sha256:<64 hex>`. */
    image: string;
    /** The Orbit server the runner reports to: HTTPS, or HTTP to a loopback or private address of the host's container network. */
    serverUrl: string;
    maxConcurrent: number;
    /** `/tmp`, a tmpfs counted in the container's memory. */
    tmpSizeLimit: string;
    /** The container's limits, which are also its compute share: Docker reserves nothing below them. */
    resources: { cpu: string; memory: string; pids: number };
  };
  /** The pool's budget, dimension by dimension; anything not stated is derived from the host. */
  capacity?: {
    compute?: { cpu?: string; memory?: string; ephemeralStorage?: string; pods?: number; attachments?: number };
    storage?: { usable?: string; headroom?: string };
    maxActiveUsers?: number;
    /** What a derived budget leaves to everything else on the host, as fractions: CPU, memory, and disk kept free. */
    reserve?: { cpu?: number; memory?: number; disk?: number };
  };
  lifecycle: ManagedRunnerProfile['lifecycle'];
}

/** Either backend's profile: the runtime holds whichever its file names. */
export type AnyManagedRunnerProfile = ManagedRunnerProfile | DockerRunnerProfile;

export type ManagedRunnerProfileResult =
  | { ok: true; profile: AnyManagedRunnerProfile }
  | { ok: false; problems: string[] };

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const DNS_SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
const QUANTITY = /^[0-9]+(\.[0-9]+)?(m|k|M|G|T|P|E|Ki|Mi|Gi|Ti|Pi|Ei)?$/;
const PINNED_IMAGE = /^[^\s@]+@sha256:[0-9a-f]{64}$/;
const LOCAL_IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
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
  // The backend decides the shape of everything else, so it is settled first, and alone.
  const backend = at('backend');
  if (backend === 'docker') return parseDockerRunnerProfile(value as Record<string, unknown>);
  if (backend !== undefined && backend !== 'kubernetes') {
    return { ok: false, problems: [`backend must be one of ${MANAGED_RUNNER_BACKENDS.map((name) => JSON.stringify(name)).join(', ')}, or absent for "kubernetes"`] };
  }
  if (at('schemaVersion') !== 1) problems.push('schemaVersion must be 1');
  if (at('valueKind') !== 'actual') problems.push('valueKind must be "actual": an example profile authorizes nothing');

  const kubeconfig = text('kubernetes.kubeconfig');
  if (kubeconfig && !isAbsolute(kubeconfig)) problems.push('kubernetes.kubeconfig must be an absolute path');
  const backoff = backoffOf(count, problems);

  const profile: ManagedRunnerProfile = {
    schemaVersion: 1,
    valueKind: 'actual',
    ...(backend === 'kubernetes' ? { backend } : {}),
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
    admission: {
      managerUsername: text('admission.managerUsername'),
      webhookTokenSha256: text('admission.webhookTokenSha256', SHA256_HEX, 'must be the 64 lowercase hex digits of a SHA-256'),
    },
    capacity: {
      compute: {
        cpu: text('capacity.compute.cpu', QUANTITY, 'is not a quantity'),
        memory: text('capacity.compute.memory', QUANTITY, 'is not a quantity'),
        ephemeralStorage: text('capacity.compute.ephemeralStorage', QUANTITY, 'is not a quantity'),
        pods: count('capacity.compute.pods', 1, 100_000),
        attachments: count('capacity.compute.attachments', 1, 100_000),
      },
      storage: {
        usable: text('capacity.storage.usable', QUANTITY, 'is not a quantity'),
        headroom: text('capacity.storage.headroom', QUANTITY, 'is not a quantity'),
      },
      maxActiveUsers: count('capacity.maxActiveUsers', 1, 100_000),
    },
    lifecycle: lifecycleOf(count, backoff),
  };
  if (!problems.length) problems.push(...capacityProblems(profile));
  return problems.length ? { ok: false, problems } : { ok: true, profile };
}

type Count = (path: string, min: number, max: number) => number;

/** The retry backoff of the lifecycle, read first: its two bounds are compared before the rest. */
function backoffOf(count: Count, problems: string[]): { backoffBaseSeconds: number; backoffMaxSeconds: number } {
  const backoffBaseSeconds = count('lifecycle.backoffBaseSeconds', 1, 3600);
  const backoffMaxSeconds = count('lifecycle.backoffMaxSeconds', 1, 86_400);
  if (backoffMaxSeconds < backoffBaseSeconds) problems.push('lifecycle.backoffMaxSeconds must not be below lifecycle.backoffBaseSeconds');
  return { backoffBaseSeconds, backoffMaxSeconds };
}

/** Every lifecycle budget, with the same bounds for every backend. */
function lifecycleOf(count: Count, { backoffBaseSeconds, backoffMaxSeconds }: ReturnType<typeof backoffOf>): ManagedRunnerProfile['lifecycle'] {
  return {
    maxAttempts: count('lifecycle.maxAttempts', 1, 100),
    backoffBaseSeconds,
    backoffMaxSeconds,
    startupDeadlineSeconds: count('lifecycle.startupDeadlineSeconds', 30, 86_400),
    requestTimeoutSeconds: count('lifecycle.requestTimeoutSeconds', 1, 300),
    leaseSeconds: count('lifecycle.leaseSeconds', 5, 3600),
    pollIntervalSeconds: count('lifecycle.pollIntervalSeconds', 1, 3600),
    heartbeatFreshSeconds: count('lifecycle.heartbeatFreshSeconds', 30, 3600),
    idleSeconds: count('lifecycle.idleSeconds', 60, 604_800),
    capacityRetrySeconds: count('lifecycle.capacityRetrySeconds', 5, 3600),
    drainSeconds: count('lifecycle.drainSeconds', 60, 86_400),
  };
}

/** A host name that never leaves the host's container network: a private, loopback or link-local IP literal, or a single label. */
function privateHost(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, '');
  const kind = isIP(bare);
  if (kind === 0) return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(bare);
  if (kind === 4) {
    const [a, b] = bare.split('.').map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  const lower = bare.toLowerCase();
  return lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
}

/**
 * The Docker backend's profile (DockerRunnerProfile). Every problem is reported, not just the first.
 * The lifecycle is the Kubernetes profile's, with the same bounds; the capacity budget is optional
 * dimension by dimension, and what it does not state is derived from the host (docker-backend.ts).
 */
function parseDockerRunnerProfile(value: Record<string, unknown>): ManagedRunnerProfileResult {
  const problems: string[] = [];
  const at = (path: string): unknown =>
    path.split('.').reduce<unknown>((node, key) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined), value);
  const has = (path: string) => at(path) !== undefined;
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
  const fraction = (path: string): number | undefined => {
    if (!has(path)) return undefined;
    const v = at(path);
    if (typeof v !== 'number' || !(v >= 0 && v <= 0.9)) {
      problems.push(`${path} must be a fraction from 0 to 0.9`);
      return undefined;
    }
    return v;
  };
  const absolute = (path: string): string => {
    const v = text(path);
    if (v && !PLACEHOLDER.test(v) && !isAbsolute(v)) problems.push(`${path} must be an absolute path`);
    return v;
  };

  if (at('schemaVersion') !== 1) problems.push('schemaVersion must be 1');
  if (at('valueKind') !== 'actual') problems.push('valueKind must be "actual": an example profile authorizes nothing');
  for (const section of ['kubernetes', 'admission']) {
    if (has(section)) problems.push(`${section} belongs to the kubernetes backend; a docker profile does not name it`);
  }

  // The channel: a unix socket, or HTTP on a loopback address. Never Docker's own socket.
  let channel: DockerRunnerProfile['docker']['channel'] = { socketPath: '' };
  const socketPath = at('docker.channel.socketPath');
  const channelUrl = at('docker.channel.url');
  if ((socketPath === undefined) === (channelUrl === undefined)) {
    problems.push('docker.channel must name exactly one of socketPath or url');
  } else if (socketPath !== undefined) {
    const path = absolute('docker.channel.socketPath');
    if (/docker\.sock$/.test(path)) problems.push("docker.channel.socketPath must be the channel's socket, never Docker's own");
    channel = { socketPath: path };
  } else {
    const url = text('docker.channel.url');
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(parsed.hostname) || !parsed.port
        || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== '/' && parsed.pathname !== '')) {
        problems.push('docker.channel.url must be http://127.0.0.1:<port> or http://[::1]:<port>: the channel listens on loopback only');
      }
    } catch {
      if (url) problems.push('docker.channel.url is not a URL');
    }
    channel = { url: url.replace(/\/+$/, '') };
  }

  const serverUrl = text('runner.serverUrl');
  if (serverUrl && !PLACEHOLDER.test(serverUrl)) {
    try {
      const url = new URL(serverUrl);
      const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (loopback || privateHost(url.hostname)))) {
        problems.push('runner.serverUrl must be an https URL, or http to a loopback or private address of the host\'s container network');
      }
      if (url.username || url.password || url.search || url.hash) problems.push('runner.serverUrl must not carry credentials, a query or a fragment');
    } catch {
      problems.push('runner.serverUrl is not a URL');
    }
  }

  const optionalText = (path: string): string | undefined => (has(path) ? text(path, QUANTITY, 'is not a quantity') : undefined);
  const optionalCount = (path: string, max: number): number | undefined => (has(path) ? count(path, 1, max) : undefined);
  const stated = <T extends object>(object: T): T | undefined => {
    const kept = Object.fromEntries(Object.entries(object).filter(([, v]) => v !== undefined)) as T;
    return Object.keys(kept).length ? kept : undefined;
  };
  const compute = stated({
    cpu: optionalText('capacity.compute.cpu'),
    memory: optionalText('capacity.compute.memory'),
    ephemeralStorage: optionalText('capacity.compute.ephemeralStorage'),
    pods: optionalCount('capacity.compute.pods', 100_000),
    attachments: optionalCount('capacity.compute.attachments', 100_000),
  });
  const storage = stated({ usable: optionalText('capacity.storage.usable'), headroom: optionalText('capacity.storage.headroom') });
  const reserve = stated({ cpu: fraction('capacity.reserve.cpu'), memory: fraction('capacity.reserve.memory'), disk: fraction('capacity.reserve.disk') });
  const backoff = backoffOf(count, problems);
  const capacity = stated({ compute, storage, maxActiveUsers: optionalCount('capacity.maxActiveUsers', 100_000), reserve });

  const profile: DockerRunnerProfile = {
    schemaVersion: 1,
    valueKind: 'actual',
    backend: 'docker',
    environmentId: text('environmentId', DNS_LABEL, 'must be a DNS label'),
    clusterKey: text('clusterKey'),
    resourceProfileId: text('resourceProfileId'),
    docker: {
      instanceId: text('docker.instanceId', DNS_LABEL, 'must be a DNS label (the label value every managed resource carries)'),
      channel,
      tokenFile: absolute('docker.tokenFile'),
    },
    storage: { capacity: text('storage.capacity', QUANTITY, 'is not a quantity') },
    runner: {
      image: text('runner.image', LOCAL_IMAGE_ID, 'must be the local image ID of the managed runner image (sha256:<64 hex>)'),
      serverUrl: serverUrl.replace(/\/+$/, ''),
      maxConcurrent: count('runner.maxConcurrent', 1, 64),
      tmpSizeLimit: text('runner.tmpSizeLimit', QUANTITY, 'is not a quantity'),
      resources: {
        cpu: text('runner.resources.cpu', QUANTITY, 'is not a quantity'),
        memory: text('runner.resources.memory', QUANTITY, 'is not a quantity'),
        pids: count('runner.resources.pids', 16, 1_000_000),
      },
    },
    ...(capacity ? { capacity } : {}),
    lifecycle: lifecycleOf(count, backoff),
  };
  if (!problems.length) problems.push(...dockerAmountProblems(profile));
  return problems.length ? { ok: false, problems } : { ok: true, profile };
}

/** The Docker profile's amounts: countable, and one runner's /tmp held within its memory. */
function dockerAmountProblems(profile: DockerRunnerProfile): string[] {
  const problems: string[] = [];
  const quantities: Array<[string, string | undefined, 'unit' | 'milli']> = [
    ['runner.resources.cpu', profile.runner.resources.cpu, 'milli'],
    ['runner.resources.memory', profile.runner.resources.memory, 'unit'],
    ['runner.tmpSizeLimit', profile.runner.tmpSizeLimit, 'unit'],
    ['storage.capacity', profile.storage.capacity, 'unit'],
    ['capacity.compute.cpu', profile.capacity?.compute?.cpu, 'milli'],
    ['capacity.compute.memory', profile.capacity?.compute?.memory, 'unit'],
    ['capacity.compute.ephemeralStorage', profile.capacity?.compute?.ephemeralStorage, 'unit'],
    ['capacity.storage.usable', profile.capacity?.storage?.usable, 'unit'],
    ['capacity.storage.headroom', profile.capacity?.storage?.headroom, 'unit'],
  ];
  for (const [path, quantity, scale] of quantities) {
    if (quantity !== undefined && !quantityUnits(quantity, scale)) problems.push(`${path} must be a positive quantity small enough to count exactly`);
  }
  if (problems.length) return problems;
  if (quantityUnits(profile.runner.tmpSizeLimit)! > quantityUnits(profile.runner.resources.memory)!) {
    problems.push('runner.tmpSizeLimit is a tmpfs held in memory and cannot exceed runner.resources.memory');
  }
  return problems;
}

/**
 * A budget no runner fits in admits nobody, and a headroom as large as the pool leaves no room for
 * any volume: both are configuration errors, reported rather than discovered as an endless wait.
 */
function capacityProblems(profile: ManagedRunnerProfile): string[] {
  const problems: string[] = [];
  for (const [path, quantity] of [
    ['capacity.compute.cpu', profile.capacity.compute.cpu],
    ['capacity.compute.memory', profile.capacity.compute.memory],
    ['capacity.compute.ephemeralStorage', profile.capacity.compute.ephemeralStorage],
    ['capacity.storage.usable', profile.capacity.storage.usable],
    ['capacity.storage.headroom', profile.capacity.storage.headroom],
    ['storage.capacity', profile.storage.capacity],
    ['runner.tmpSizeLimit', profile.runner.tmpSizeLimit],
  ] as const) {
    if (quantityUnits(quantity, path === 'capacity.compute.cpu' ? 'milli' : 'unit') === null) problems.push(`${path} is too large to count exactly`);
  }
  for (const [path, quantity] of [
    ['runner.resources.runner.requests.cpu', profile.runner.resources.runner.requests.cpu],
    ['runner.resources.init.requests.cpu', profile.runner.resources.init.requests.cpu],
  ] as const) {
    if (quantityUnits(quantity, 'milli') === null) problems.push(`${path} is too large to count exactly`);
  }
  for (const [path, quantity] of [
    ['runner.resources.runner.requests.memory', profile.runner.resources.runner.requests.memory],
    ['runner.resources.init.requests.memory', profile.runner.resources.init.requests.memory],
  ] as const) {
    if (quantityUnits(quantity) === null) problems.push(`${path} is too large to count exactly`);
  }
  if (problems.length) return problems;
  const budget = capacityBudget(profile);
  const compute = computeShare(profile);
  const storage = storageShare(profile);
  if (budget.storageHeadroomBytes >= budget.storageUsableBytes) problems.push('capacity.storage.headroom must be below capacity.storage.usable');
  if (compute.cpuMillis > budget.cpuMillis) problems.push('capacity.compute.cpu is below one runner Pod\'s CPU request');
  if (compute.memoryBytes > budget.memoryBytes) problems.push('capacity.compute.memory is below one runner Pod\'s memory request');
  if (compute.ephemeralBytes > budget.ephemeralBytes) problems.push('capacity.compute.ephemeralStorage is below one runner Pod\'s runner.tmpSizeLimit');
  if (storage.durableBytes > budget.storageUsableBytes - budget.storageHeadroomBytes) {
    problems.push('capacity.storage.usable less capacity.storage.headroom is below one data volume (storage.capacity)');
  }
  return problems;
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
