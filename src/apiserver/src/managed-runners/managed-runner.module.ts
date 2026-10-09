import { Global, Module } from '@nestjs/common';
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
import { MANAGED_RUNNER_DEMAND, ManagedRunnerDemandService } from './managed-runner-demand';
import { MANAGED_RUNNER_SIGN_IN } from './managed-runner-sign-in';
import { ManagedRunnerAdmissionController, ManagedRunnerAdmissionGuard } from './managed-runner-admission.controller';
import { ManagedRunnerController } from './managed-runner.controller';
import { ManagedRunnerService } from './managed-runner.service';

/**
 * Managed runners (docs/managed-runner-design.md). The runtime — profile, Kubernetes client, manager
 * and reconcile loop — is built only when the gate is on; off, the factory returns null without
 * reading a profile or a kubeconfig, and the status facade and the refusing guard are all there is.
 * The gate itself comes from the global ManagedRunnerGateModule.
 *
 * Global for two exports, so their callers' modules need no import of this one: the sign-in step
 * AuthService.completeLogin calls (MANAGED_RUNNER_SIGN_IN), and the demand hook the session paths
 * call where work for a runner is recorded (MANAGED_RUNNER_DEMAND, managed-runner-demand.ts).
 */
@Global()
@Module({
  controllers: [ManagedRunnerController, ManagedRunnerAdmissionController],
  providers: [
    ManagedRunnerEnabledGuard,
    ManagedRunnerAdmissionGuard,
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
    { provide: MANAGED_RUNNER_SIGN_IN, useExisting: ManagedRunnerService },
    ManagedRunnerDemandService,
    { provide: MANAGED_RUNNER_DEMAND, useExisting: ManagedRunnerDemandService },
  ],
  exports: [MANAGED_RUNNER_SIGN_IN, MANAGED_RUNNER_DEMAND],
})
export class ManagedRunnerModule {}
