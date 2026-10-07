import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { Logger } from '@nestjs/common';

import type { PrismaService } from '../prisma/prisma.service';
import type { ManagedKubeClient } from './kube-client';
import { ManagedRunnerManager } from './managed-runner-manager';
import { loadManagedRunnerProfile, type ManagedRunnerProfile } from './managed-runner-profile';
import { ManagedRunnerWorker } from './managed-runner-worker';

/** The DI token of the enabled runtime: null when the feature is off. */
export const MANAGED_RUNNER_RUNTIME = Symbol('MANAGED_RUNNER_RUNTIME');

/**
 * The DI token of the Kubernetes client constructor. Production does not provide it, and the module
 * uses `kubeClientFromProfile`; a test provides a fake, or a constructor that fails if it is reached.
 */
export const MANAGED_RUNNER_KUBE_CLIENT_FACTORY = Symbol('MANAGED_RUNNER_KUBE_CLIENT_FACTORY');

export type KubeClientFactory = (profile: ManagedRunnerProfile) => ManagedKubeClient;

/** What an enabled process could build: a manager and its loop, or the reasons it could not. */
export type ManagedRunnerRuntime =
  | { available: true; profile: ManagedRunnerProfile; manager: ManagedRunnerManager; worker: ManagedRunnerWorker }
  | { available: false; problems: string[] };

/**
 * Build the enabled runtime: the profile from its explicit path, then the Kubernetes client for it.
 * Anything missing leaves the managed service unavailable — logged here, reported to owners as
 * MANAGED_RUNNER_UNAVAILABLE — and nothing is reconciled; the rest of the server is unaffected.
 * Called only when the gate is on.
 */
export function createManagedRunnerRuntime(deps: {
  profilePath: string | undefined;
  prisma: PrismaService;
  kubeClient: KubeClientFactory;
  log?: Pick<Logger, 'error' | 'log'>;
}): ManagedRunnerRuntime {
  const log = deps.log ?? new Logger('ManagedRunners');
  const loaded = loadManagedRunnerProfile(deps.profilePath);
  if (!loaded.ok) {
    for (const problem of loaded.problems) log.error(`managed runners are enabled but unavailable: ${problem}`);
    return { available: false, problems: loaded.problems };
  }
  let kube: ManagedKubeClient;
  try {
    kube = deps.kubeClient(loaded.profile);
  } catch (error) {
    const problem = (error as Error).message;
    log.error(`managed runners are enabled but unavailable: ${problem}`);
    return { available: false, problems: [problem] };
  }
  const manager = new ManagedRunnerManager(deps.prisma, kube, loaded.profile, {
    holder: `${hostname()}/${process.pid}/${randomUUID()}`,
  });
  const worker = new ManagedRunnerWorker(manager, loaded.profile.lifecycle.pollIntervalSeconds * 1000);
  log.log(`managed runners are enabled in ${loaded.profile.environmentId} (namespace ${loaded.profile.kubernetes.namespace})`);
  return { available: true, profile: loaded.profile, manager, worker };
}
