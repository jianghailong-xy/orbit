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
import {
  dockerHostProfile,
  dockerRunnerHosts,
  loadManagedRunnerProfile,
  type AnyManagedRunnerProfile,
  type DockerRunnerProfile,
  type ManagedRunnerProfile,
} from './managed-runner-profile';
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

/** Called once per channel host, with that host's profile (`dockerHostProfile`): its instance, channel and token file. */
export type DockerChannelFactory = (profile: DockerRunnerProfile) => DockerChannel;

/** One Docker channel host's manager: it drives only the mappings of its location. */
export interface ManagedRunnerHostRuntime {
  instanceId: string;
  /** No new mapping is placed here (managed-runner-placement.ts). */
  draining: boolean;
  manager: ManagedRunnerManager;
}

/**
 * What an enabled process could build: a manager and its loop, or the reasons it could not. `manager` is the
 * first (on Kubernetes, or a single Docker host, the only) one; `hosts`, when present, every Docker host's in
 * the profile's order, and the loop drives them all.
 */
export type ManagedRunnerRuntime =
  | { available: true; profile: AnyManagedRunnerProfile; manager: ManagedRunnerManager; worker: ManagedRunnerWorker; hosts?: ManagedRunnerHostRuntime[] }
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
  const holder = `${hostname()}/${process.pid}/${randomUUID()}`;
  if (profile.backend === 'docker') {
    // One backend and one manager per channel host. With several, each drives only its own location's
    // mappings; a single host drives every Docker mapping, as before the list existed.
    const listed = dockerRunnerHosts(profile);
    const hosts: ManagedRunnerHostRuntime[] = [];
    try {
      for (const host of listed) {
        const hostProfile = dockerHostProfile(profile, host);
        const backend = new DockerBackend((deps.dockerChannel ?? dockerChannelFromProfile)(hostProfile), hostProfile);
        const manager = new ManagedRunnerManager(deps.prisma, backend, profile, { holder, ownLocationOnly: listed.length > 1 });
        hosts.push({ instanceId: host.instanceId, draining: host.draining, manager });
      }
    } catch (error) {
      const problem = (error as Error).message;
      log.error(`managed runners are enabled but unavailable: ${problem}`);
      return { available: false, problems: [problem] };
    }
    const worker = new ManagedRunnerWorker(hosts.map((host) => host.manager), profile.lifecycle.pollIntervalSeconds * 1000);
    const where = listed.map((host) => `Docker instance ${host.instanceId}${host.remote ? ' (remote)' : ''}${host.draining ? ' (draining)' : ''}`).join(', ');
    log.log(`managed runners are enabled in ${profile.environmentId} (${where})`);
    return { available: true, profile, manager: hosts[0].manager, worker, hosts };
  }
  let backend: ManagedRunnerBackend;
  try {
    backend = new KubernetesBackend(deps.kubeClient(profile), profile);
  } catch (error) {
    const problem = (error as Error).message;
    log.error(`managed runners are enabled but unavailable: ${problem}`);
    return { available: false, problems: [problem] };
  }
  const manager = new ManagedRunnerManager(deps.prisma, backend, profile, { holder });
  const worker = new ManagedRunnerWorker(manager, profile.lifecycle.pollIntervalSeconds * 1000);
  log.log(`managed runners are enabled in ${profile.environmentId} (namespace ${profile.kubernetes.namespace})`);
  return { available: true, profile, manager, worker };
}
