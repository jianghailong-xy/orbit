import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../prisma/prisma.service';
import { AdminRoleGuard } from '../users/admin-role.guard';
import { kubeClientFromProfile } from './kube-http-client';
import { MANAGED_RUNNER_GATE, ManagedRunnerEnabledGuard, type ManagedRunnerGate } from './managed-runner-gate';
import { MANAGED_RUNNERS_PROFILE_ENV } from './managed-runner-profile';
import {
  MANAGED_RUNNER_DOCKER_CHANNEL_FACTORY,
  MANAGED_RUNNER_KUBE_CLIENT_FACTORY,
  MANAGED_RUNNER_RUNTIME,
  createManagedRunnerRuntime,
  type DockerChannelFactory,
  type KubeClientFactory,
} from './managed-runner-runtime';
import { MANAGED_RUNNER_DEMAND, ManagedRunnerDemandService } from './managed-runner-demand';
import { MANAGED_RUNNER_SIGN_IN } from './managed-runner-sign-in';
import { ManagedRunnerAdminController } from './managed-runner-admin.controller';
import { ManagedRunnerAdmissionController, ManagedRunnerAdmissionGuard } from './managed-runner-admission.controller';
import { ManagedRunnerController } from './managed-runner.controller';
import { ManagedRunnerService } from './managed-runner.service';

/**
 * Managed runners (docs/managed-runner-design.md). The runtime — profile, run backend (the Kubernetes
 * client under KubernetesBackend, or the restricted Docker channel's client under DockerBackend),
 * manager and reconcile loop — is built only when the gate is on; off, the factory returns null
 * without reading a profile, a kubeconfig or a channel token, and the status facade and the refusing
 * guard are all there is.
 * The gate itself comes from the global ManagedRunnerGateModule.
 *
 * Global for two exports, so their callers' modules need no import of this one: the sign-in step
 * AuthService.completeLogin calls (MANAGED_RUNNER_SIGN_IN), and the demand hook the session paths
 * call where work for a runner is recorded (MANAGED_RUNNER_DEMAND, managed-runner-demand.ts).
 */
@Global()
@Module({
  controllers: [ManagedRunnerController, ManagedRunnerAdmissionController, ManagedRunnerAdminController],
  providers: [
    ManagedRunnerEnabledGuard,
    ManagedRunnerAdmissionGuard,
    // The administrator's volume switch. AdminRoleGuard depends only on the global PrismaService, so it is
    // provided here too, as the wiki and provider modules do (UsersModule does not export it).
    AdminRoleGuard,
    {
      provide: MANAGED_RUNNER_RUNTIME,
      inject: [
        MANAGED_RUNNER_GATE,
        ConfigService,
        PrismaService,
        { token: MANAGED_RUNNER_KUBE_CLIENT_FACTORY, optional: true },
        { token: MANAGED_RUNNER_DOCKER_CHANNEL_FACTORY, optional: true },
      ],
      useFactory: (gate: ManagedRunnerGate, config: ConfigService, prisma: PrismaService, kubeClient?: KubeClientFactory, dockerChannel?: DockerChannelFactory) =>
        gate.enabled
          ? createManagedRunnerRuntime({
            profilePath: config.get<string>(MANAGED_RUNNERS_PROFILE_ENV),
            prisma,
            kubeClient: kubeClient ?? ((profile) => kubeClientFromProfile(profile)),
            dockerChannel,
          })
          : null,
    },
    ManagedRunnerService,
    { provide: MANAGED_RUNNER_SIGN_IN, useExisting: ManagedRunnerService },
    ManagedRunnerDemandService,
    { provide: MANAGED_RUNNER_DEMAND, useExisting: ManagedRunnerDemandService },
  ],
  exports: [MANAGED_RUNNER_SIGN_IN, MANAGED_RUNNER_DEMAND],
})
export class ManagedRunnerModule {}
