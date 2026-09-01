#!/usr/bin/env node
// Ownership of the Release DAG's disposable containers.
//
// Every disposable container an attempt provisions carries
// `orbit.release-dag.binding=<bindingDigest>`. That label is the only selector cleanup, leak
// detection and remediation are allowed to use: this host runs concurrent sessions and other
// products whose containers share the same name shape, so a name prefix is never a safe handle.
//
// Cleanup runs from a process guard rather than from a trailing statement, because the exit paths
// that leak are precisely the ones that never reach the end of the script: a failing node exiting
// non-zero, an uncaught exception, and SIGTERM. What cleanup observed is returned as a typed
// document so a survivor is reported instead of being swallowed by an ignored exit code.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export const DISPOSABLE_BINDING_LABEL = 'orbit.release-dag.binding';
export const DISPOSABLE_CLEANUP_KIND = 'orbit.outcome-reconciler.release-dag-disposable-cleanup';
export const DISPOSABLE_LEAK_KIND =
  'orbit.outcome-reconciler.release-dag-disposable-leak-remediation';
// A disposable container older than this is no longer explainable by the attempt that owns it.
// The leak that starved the host on 2026-08-31 survived its attempt by 82 minutes.
export const DISPOSABLE_LEAK_THRESHOLD_SECONDS = 900;

const DIGEST = /^[0-9a-f]{64}$/u;
const SEPARATOR = '\t';
const SIGNAL_NUMBERS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };

function requireBindingDigest(bindingDigest) {
  if (!DIGEST.test(bindingDigest ?? '')) {
    throw new Error('disposable resource ownership requires a full binding digest');
  }
  return bindingDigest;
}

export function dockerAdapter(args, { timeoutMilliseconds = 60_000 } = {}) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMilliseconds,
    killSignal: 'SIGKILL',
  });
  return {
    status: typeof result.status === 'number' ? result.status : 125,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim() || (result.error?.message ?? ''),
  };
}

export function disposableSelector(bindingDigest) {
  return `label=${DISPOSABLE_BINDING_LABEL}=${requireBindingDigest(bindingDigest)}`;
}

function ageSeconds(createdAt, observedAtMilliseconds) {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return null;
  return Math.max(0, Math.round((observedAtMilliseconds - created) / 1000));
}

// The inventory of containers this binding owns. Listing is a label filter and every listed
// container is re-inspected for the same label before it is ever named as removable, so a
// container that stops matching between the two observations is refused rather than removed.
export function observeDisposableContainers({
  bindingDigest,
  docker = dockerAdapter,
  now = Date.now,
}) {
  requireBindingDigest(bindingDigest);
  const observedAtMilliseconds = now();
  const observedAt = new Date(observedAtMilliseconds).toISOString();
  const listed = docker(['ps', '--all', '--no-trunc', '--quiet',
    '--filter', disposableSelector(bindingDigest)]);
  if (listed.status !== 0) {
    return {
      observedAt,
      inventoryAvailable: false,
      containers: [],
      failures: [{
        kind: 'DISPOSABLE_INVENTORY_UNAVAILABLE',
        selector: disposableSelector(bindingDigest),
        exitCode: listed.status,
        message: listed.stderr || listed.stdout,
      }],
    };
  }
  const containers = [];
  const failures = [];
  for (const id of listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean)) {
    const inspected = docker(['inspect', '--format', [
      '{{.Id}}', '{{.Name}}', '{{.Created}}', '{{.State.Running}}',
      `{{ index .Config.Labels "${DISPOSABLE_BINDING_LABEL}" }}`,
    ].join(SEPARATOR), id]);
    if (inspected.status !== 0) {
      failures.push({
        kind: 'DISPOSABLE_INSPECT_FAILED',
        containerId: id,
        exitCode: inspected.status,
        message: inspected.stderr || inspected.stdout,
      });
      continue;
    }
    const [observedId, name, createdAt, running, observedBinding] = inspected.stdout
      .split(SEPARATOR);
    if (observedBinding !== bindingDigest) {
      failures.push({
        kind: 'FOREIGN_LABEL_REFUSED',
        containerId: id,
        container: (name ?? '').replace(/^\//u, ''),
        observedBinding: observedBinding ?? null,
      });
      continue;
    }
    containers.push({
      id: observedId,
      container: (name ?? '').replace(/^\//u, ''),
      createdAt,
      running: running === 'true',
      ageSeconds: ageSeconds(createdAt, observedAtMilliseconds),
    });
  }
  return { observedAt, inventoryAvailable: true, containers, failures };
}

// Removes every container this binding owns and reports what is still there afterwards.
// `resourcesRemaining` is a re-observation, not an assumption: when the inventory itself cannot be
// read it is null and the outcome is UNVERIFIED, because reporting 0 would be the silent lie.
export function cleanupDisposableResources({
  bindingDigest,
  contextPath = null,
  reason = 'ATTEMPT_EXIT',
  docker = dockerAdapter,
  declaredContextCleanup = null,
  now = Date.now,
}) {
  requireBindingDigest(bindingDigest);
  const startedAt = new Date(now()).toISOString();
  const failures = [];
  const declaredContextPresent = Boolean(contextPath) && existsSync(contextPath);
  if (declaredContextPresent && declaredContextCleanup) {
    const declared = declaredContextCleanup(contextPath);
    if (declared.status !== 0) {
      failures.push({
        kind: 'DECLARED_CONTEXT_CLEANUP_FAILED',
        contextPath,
        exitCode: declared.status,
        message: declared.stderr || declared.stdout,
      });
    }
  }
  const before = observeDisposableContainers({ bindingDigest, docker, now });
  failures.push(...before.failures);
  const removed = [];
  for (const container of before.containers) {
    const removal = docker(['rm', '--force', '--volumes', container.id]);
    if (removal.status === 0) {
      removed.push({ id: container.id, container: container.container });
      continue;
    }
    failures.push({
      kind: 'CONTAINER_REMOVE_FAILED',
      containerId: container.id,
      container: container.container,
      exitCode: removal.status,
      message: removal.stderr || removal.stdout,
    });
  }
  const after = observeDisposableContainers({ bindingDigest, docker, now });
  failures.push(...after.failures.filter((failure) => (
    failure.kind === 'DISPOSABLE_INVENTORY_UNAVAILABLE'
  )));
  for (const survivor of after.containers) {
    failures.push({
      kind: 'CONTAINER_SURVIVED_REMOVAL',
      containerId: survivor.id,
      container: survivor.container,
      ageSeconds: survivor.ageSeconds,
    });
  }
  const resourcesRemaining = after.inventoryAvailable ? after.containers.length : null;
  return {
    schemaVersion: 1,
    kind: DISPOSABLE_CLEANUP_KIND,
    bindingDigest,
    reason,
    strategy: declaredContextPresent
      ? 'DECLARED_CONTEXT_THEN_BINDING_LABEL_SWEEP'
      : 'BINDING_LABEL_SWEEP',
    selector: disposableSelector(bindingDigest),
    declaredContext: contextPath ? { path: contextPath, present: declaredContextPresent } : null,
    startedAt,
    finishedAt: new Date(now()).toISOString(),
    observed: before.containers.map((container) => container.container),
    removed,
    failures,
    resourcesRemaining,
    outcome: resourcesRemaining === null
      ? 'UNVERIFIED'
      : resourcesRemaining === 0 && failures.length === 0 ? 'CLEAN' : 'RESOURCES_REMAINING',
  };
}

// After the fact: a container that still carries this binding label and has outlived the declared
// threshold is a leak, and a leak is a typed conclusion carrying the remediation that resolves it.
export function detectDisposableLeaks({
  bindingDigest,
  thresholdSeconds = DISPOSABLE_LEAK_THRESHOLD_SECONDS,
  docker = dockerAdapter,
  now = Date.now,
}) {
  requireBindingDigest(bindingDigest);
  const observation = observeDisposableContainers({ bindingDigest, docker, now });
  const leaks = observation.containers.filter((container) => (
    typeof container.ageSeconds === 'number' && container.ageSeconds >= thresholdSeconds
  ));
  return {
    schemaVersion: 1,
    kind: DISPOSABLE_LEAK_KIND,
    bindingDigest,
    thresholdSeconds,
    observedAt: observation.observedAt,
    selector: disposableSelector(bindingDigest),
    survivors: observation.containers,
    leaks,
    failures: observation.failures,
    outcome: leaks.length > 0 ? 'LEAK_DETECTED' : 'NO_LEAK',
    failureMode: leaks.length > 0 ? 'DISPOSABLE_POSTGRES_LEAK_STARVES_HOST' : null,
    remediation: leaks.length > 0 ? {
      action: 'REMOVE_BINDING_LABELLED_DISPOSABLE_CONTAINERS',
      scope: 'EXACT_BINDING_LABEL_MATCH_ONLY',
      selector: disposableSelector(bindingDigest),
      containers: leaks.map((container) => container.container),
    } : null,
  };
}

export function remediateDisposableLeaks({
  bindingDigest,
  thresholdSeconds = DISPOSABLE_LEAK_THRESHOLD_SECONDS,
  docker = dockerAdapter,
  now = Date.now,
}) {
  const conclusion = detectDisposableLeaks({ bindingDigest, thresholdSeconds, docker, now });
  if (conclusion.outcome !== 'LEAK_DETECTED') return { ...conclusion, applied: null };
  return {
    ...conclusion,
    applied: cleanupDisposableResources({
      bindingDigest, reason: 'LEAK_REMEDIATION', docker, now,
    }),
  };
}

// The one wiring both the release DAG and its exit-path regression use. Cleanup runs at most once,
// from whichever exit path is reached first: normal completion, `process.exit`, an uncaught
// exception, an unhandled rejection (all of which emit `exit`) or a termination signal (which does
// not, and therefore needs its own handler).
export function guardDisposableResources({
  bindingDigest,
  contextPath = null,
  docker = dockerAdapter,
  declaredContextCleanup = null,
  onManifest = null,
  now = Date.now,
  target = process,
  signals = ['SIGTERM', 'SIGINT', 'SIGHUP'],
}) {
  requireBindingDigest(bindingDigest);
  let manifest = null;
  const sweep = (reason) => {
    if (manifest) return manifest;
    try {
      manifest = cleanupDisposableResources({
        bindingDigest, contextPath, reason, docker, declaredContextCleanup, now,
      });
    } catch (error) {
      manifest = {
        schemaVersion: 1,
        kind: DISPOSABLE_CLEANUP_KIND,
        bindingDigest,
        reason,
        strategy: 'BINDING_LABEL_SWEEP',
        selector: `label=${DISPOSABLE_BINDING_LABEL}=${bindingDigest}`,
        declaredContext: contextPath ? { path: contextPath, present: null } : null,
        observed: [],
        removed: [],
        failures: [{
          kind: 'DISPOSABLE_CLEANUP_THREW',
          message: error instanceof Error ? error.message : String(error),
        }],
        resourcesRemaining: null,
        outcome: 'UNVERIFIED',
      };
    }
    try {
      onManifest?.(manifest);
    } catch (error) {
      process.stderr.write(`!! release-dag: disposable cleanup manifest unwritable: ${error}\n`);
    }
    return manifest;
  };
  target.on('exit', () => { sweep('PROCESS_EXIT'); });
  for (const signal of signals) {
    target.on(signal, () => {
      sweep(`SIGNAL_${signal}`);
      target.exit(128 + (SIGNAL_NUMBERS[signal] ?? 0));
    });
  }
  return { sweep, manifest: () => manifest };
}
