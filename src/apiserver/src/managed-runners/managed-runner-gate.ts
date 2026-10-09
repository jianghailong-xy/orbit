import { CanActivate, Global, Inject, Injectable, Logger, Module, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MANAGED_RUNNER_DISABLED, type ManagedRunnerReason } from '@orbit/shared';

/**
 * The managed runner switch (docs/managed-runner-design.md, "Default disabled gate").
 *
 *   ORBIT_MANAGED_RUNNERS_ENABLED absent, empty or `false`   disabled
 *   ORBIT_MANAGED_RUNNERS_ENABLED=true                        enabled
 *   anything else, `1`, `yes` and `on` included               disabled, and one warning in the log
 *
 * Compared after trimming and lowercasing. Read once, when the module graph is built, through the
 * global ConfigModule; every controller, guard and background service shares that one value, and a
 * change takes effect on restart. Stricter than the wiki rollout it is shaped after: an unreadable
 * value can only ever mean off.
 *
 * Disabled, the only managed runner object this process constructs is this value and the read-only
 * status facade over it: no Kubernetes client, no profile or kubeconfig read, no reconcile timer.
 */
export const MANAGED_RUNNERS_ENABLED_ENV = 'ORBIT_MANAGED_RUNNERS_ENABLED';

export interface ManagedRunnerGate {
  readonly enabled: boolean;
  /** What the environment said that could not be taken as written, or null. */
  readonly problem: string | null;
}

/** The DI token of the process's one effective gate. */
export const MANAGED_RUNNER_GATE = Symbol('MANAGED_RUNNER_GATE');

/** The gate a process without the provider has: off. */
export const MANAGED_RUNNERS_OFF: ManagedRunnerGate = Object.freeze({ enabled: false, problem: null });

/** The design's table, as a pure function of the variable's value. */
export function readManagedRunnerGate(value: string | undefined): ManagedRunnerGate {
  const said = (value ?? '').trim().toLowerCase();
  if (said === 'true') return Object.freeze({ enabled: true, problem: null });
  if (said === '' || said === 'false') return MANAGED_RUNNERS_OFF;
  return Object.freeze({
    enabled: false,
    problem: `${MANAGED_RUNNERS_ENABLED_ENV}=${JSON.stringify(value)} is neither true nor false: managed runners are disabled`,
  });
}

/** The effective gate of this process: read from configuration once, and its problem logged once. */
export function managedRunnerGateFrom(config: Pick<ConfigService, 'get'>, log: Pick<Logger, 'warn'> = new Logger('ManagedRunners')): ManagedRunnerGate {
  const gate = readManagedRunnerGate(config.get<string>(MANAGED_RUNNERS_ENABLED_ENV));
  if (gate.problem) log.warn(gate.problem);
  return gate;
}

/** What a managed runner write is answered with while the feature is off: the 404 of a server without it. */
export function managedRunnerDisabledError(): NotFoundException {
  return new NotFoundException(managedRunnerDisabledReason());
}

export function managedRunnerDisabledReason(): ManagedRunnerReason {
  return {
    code: MANAGED_RUNNER_DISABLED,
    message: `Managed runners are not enabled on this Orbit server (${MANAGED_RUNNERS_ENABLED_ENV}), so nothing was written.`,
    retryable: false,
  };
}

/**
 * The managed runner writes, closed while the feature is off. Listed after JwtAuthGuard, so an
 * unauthenticated request is still that guard's 401 and says nothing about the switch, and an
 * authenticated one is refused here — before its body is read and before anything is written.
 */
@Injectable()
export class ManagedRunnerEnabledGuard implements CanActivate {
  constructor(@Inject(MANAGED_RUNNER_GATE) private readonly gate: ManagedRunnerGate) {}

  canActivate(): boolean {
    if (this.gate.enabled) return true;
    throw managedRunnerDisabledError();
  }
}

/** Provides the one gate to every module: the auth controller's capability read, and the managed runner module. */
@Global()
@Module({
  providers: [
    {
      provide: MANAGED_RUNNER_GATE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => managedRunnerGateFrom(config),
    },
  ],
  exports: [MANAGED_RUNNER_GATE],
})
export class ManagedRunnerGateModule {}
