import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../prisma/prisma.service';
import { kubeClientFromProfile } from './kube-http-client';
import { MANAGED_RUNNER_GATE, ManagedRunnerEnabledGuard, type ManagedRunnerGate } from './managed-runner-gate';
import { MANAGED_RUNNERS_PROFILE_ENV } from './managed-runner-profile';
import {
  MANAGED_RUNNER_KUBE_CLIENT_FACTORY,
  MANAGED_RUNNER_RUNTIME,
  createManagedRunnerRuntime,
  type KubeClientFactory,
} from './managed-runner-runtime';
import { ManagedRunnerController } from './managed-runner.controller';
import { ManagedRunnerService } from './managed-runner.service';

/**
 * Managed runners (docs/managed-runner-design.md). The runtime — profile, Kubernetes client, manager
 * and reconcile loop — is built only when the gate is on; off, the factory returns null without
 * reading a profile or a kubeconfig, and the status facade and the refusing guard are all there is.
 * The gate itself comes from the global ManagedRunnerGateModule.
 */
@Module({
  controllers: [ManagedRunnerController],
  providers: [
    ManagedRunnerEnabledGuard,
    {
      provide: MANAGED_RUNNER_RUNTIME,
      inject: [MANAGED_RUNNER_GATE, ConfigService, PrismaService, { token: MANAGED_RUNNER_KUBE_CLIENT_FACTORY, optional: true }],
      useFactory: (gate: ManagedRunnerGate, config: ConfigService, prisma: PrismaService, kubeClient?: KubeClientFactory) =>
        gate.enabled
          ? createManagedRunnerRuntime({
            profilePath: config.get<string>(MANAGED_RUNNERS_PROFILE_ENV),
            prisma,
            kubeClient: kubeClient ?? ((profile) => kubeClientFromProfile(profile)),
          })
          : null,
    },
    ManagedRunnerService,
  ],
})
export class ManagedRunnerModule {}
