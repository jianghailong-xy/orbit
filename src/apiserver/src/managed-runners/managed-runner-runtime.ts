import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { Logger } from '@nestjs/common';

import type { PrismaService } from '../prisma/prisma.service';
import { DockerBackend } from './docker-backend';
import { dockerChannelFromProfile, type DockerChannel } from './docker-channel-client';
import type { ManagedKubeClient } from './kube-client';
import { KubernetesBackend } from './kubernetes-backend';
import type { ManagedRunnerBackend } from './managed-runner-backend';
import { ManagedRunnerManager } from './managed-runner-manager';
import { loadManagedRunnerProfile, type AnyManagedRunnerProfile, type DockerRunnerProfile, type ManagedRunnerProfile } from './managed-runner-profile';
import { ManagedRunnerWorker } from './managed-runner-worker';

/** The DI token of the enabled runtime: null when the feature is off. */
export const MANAGED_RUNNER_RUNTIME = Symbol('MANAGED_RUNNER_RUNTIME');

/**
 * The DI token of the Kubernetes client constructor. Production does not provide it, and the module
 * uses `kubeClientFromProfile`; a test provides a fake, or a constructor that fails if it is reached.
 */
export const MANAGED_RUNNER_KUBE_CLIENT_FACTORY = Symbol('MANAGED_RUNNER_KUBE_CLIENT_FACTORY');

export type KubeClientFactory = (profile: ManagedRunnerProfile) => ManagedKubeClient;

/**
 * The DI token of the Docker channel client constructor. Production does not provide it, and the
 * module uses `dockerChannelFromProfile`; a test provides a fake, or a constructor that fails if reached.
 */
export const MANAGED_RUNNER_DOCKER_CHANNEL_FACTORY = Symbol('MANAGED_RUNNER_DOCKER_CHANNEL_FACTORY');

export type DockerChannelFactory = (profile: DockerRunnerProfile) => DockerChannel;

/** What an enabled process could build: a manager and its loop, or the reasons it could not. */
export type ManagedRunnerRuntime =
  | { available: true; profile: AnyManagedRunnerProfile; manager: ManagedRunnerManager; worker: ManagedRunnerWorker }
  | { available: false; problems: string[] };

/**
 * Build the enabled runtime: the profile from its explicit path, then its run backend — the
 * Kubernetes client under KubernetesBackend, or the restricted Docker channel's client under
 * DockerBackend. Anything missing leaves the managed service unavailable — logged here, reported to
 * owners as MANAGED_RUNNER_UNAVAILABLE — and nothing is reconciled; the rest of the server is
 * unaffected. A Docker profile builds nothing for Kubernetes, and a Kubernetes one nothing for
 * Docker. Called only when the gate is on.
 */
export function createManagedRunnerRuntime(deps: {
  profilePath: string | undefined;
  prisma: PrismaService;
  kubeClient: KubeClientFactory;
  dockerChannel?: DockerChannelFactory;
  log?: Pick<Logger, 'error' | 'log'>;
}): ManagedRunnerRuntime {
  const log = deps.log ?? new Logger('ManagedRunners');
  const loaded = loadManagedRunnerProfile(deps.profilePath);
  if (!loaded.ok) {
    for (const problem of loaded.problems) log.error(`managed runners are enabled but unavailable: ${problem}`);
    return { available: false, problems: loaded.problems };
  }
  const profile = loaded.profile;
  let backend: ManagedRunnerBackend;
  try {
    backend = profile.backend === 'docker'
      ? new DockerBackend((deps.dockerChannel ?? dockerChannelFromProfile)(profile), profile)
      : new KubernetesBackend(deps.kubeClient(profile), profile);
  } catch (error) {
    const problem = (error as Error).message;
    log.error(`managed runners are enabled but unavailable: ${problem}`);
    return { available: false, problems: [problem] };
  }
  const manager = new ManagedRunnerManager(deps.prisma, backend, profile, {
    holder: `${hostname()}/${process.pid}/${randomUUID()}`,
  });
  const worker = new ManagedRunnerWorker(manager, profile.lifecycle.pollIntervalSeconds * 1000);
  const where = profile.backend === 'docker' ? `Docker instance ${profile.docker.instanceId}` : `namespace ${profile.kubernetes.namespace}`;
  log.log(`managed runners are enabled in ${profile.environmentId} (${where})`);
  return { available: true, profile, manager, worker };
}
