import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { MANAGED_RUNNER_GATE, type ManagedRunnerGate } from './managed-runner-gate';

/**
 * The managed runner browser switch (docs/runner-browser-design.md §2), read by the managed runner gate's table:
 *
 *   ORBIT_MANAGED_RUNNER_BROWSER_ENABLED absent, empty or `false`   off
 *   ORBIT_MANAGED_RUNNER_BROWSER_ENABLED=true                        on, if ORBIT_MANAGED_RUNNERS_ENABLED is on too
 *   anything else, `1`, `yes` and `on` included                     off, and one warning in the log
 *
 * Compared after trimming and lowercasing, and read once, when the module graph is built, through the global
 * ConfigModule; a change takes effect on restart. With managed runners off there is no browser, whatever this says.
 * Even on, it is offered only to a managed runner whose instance the manager authorized (Welcome.browser,
 * runner-link-welcome.controller.ts).
 */
export const MANAGED_RUNNER_BROWSER_ENABLED_ENV = 'ORBIT_MANAGED_RUNNER_BROWSER_ENABLED';

export interface ManagedRunnerBrowserGate {
  /** On: the variable said `true` and managed runners are enabled. */
  readonly enabled: boolean;
  /** What the environment said that could not be taken as written, or null. */
  readonly problem: string | null;
}

/** The DI token of the process's one effective browser gate. */
export const MANAGED_RUNNER_BROWSER_GATE = Symbol('MANAGED_RUNNER_BROWSER_GATE');

/** The gate a process without the provider has: off. */
export const MANAGED_RUNNER_BROWSER_OFF: ManagedRunnerBrowserGate = Object.freeze({ enabled: false, problem: null });

/** The design's table, as a pure function of the variable's value and the managed runner gate. */
export function readManagedRunnerBrowserGate(value: string | undefined, managed: Pick<ManagedRunnerGate, 'enabled'>): ManagedRunnerBrowserGate {
  const said = (value ?? '').trim().toLowerCase();
  if (said === 'true') return managed.enabled ? Object.freeze({ enabled: true, problem: null }) : MANAGED_RUNNER_BROWSER_OFF;
  if (said === '' || said === 'false') return MANAGED_RUNNER_BROWSER_OFF;
  return Object.freeze({
    enabled: false,
    problem: `${MANAGED_RUNNER_BROWSER_ENABLED_ENV}=${JSON.stringify(value)} is neither true nor false: the managed runner browser is off`,
  });
}

/** The effective browser gate of this process: read from configuration once, and its problem logged once. */
export function managedRunnerBrowserGateFrom(
  config: Pick<ConfigService, 'get'>,
  managed: Pick<ManagedRunnerGate, 'enabled'>,
  log: Pick<Logger, 'warn'> = new Logger('ManagedRunners'),
): ManagedRunnerBrowserGate {
  const gate = readManagedRunnerBrowserGate(config.get<string>(MANAGED_RUNNER_BROWSER_ENABLED_ENV), managed);
  if (gate.problem) log.warn(gate.problem);
  return gate;
}

/** Provides the one browser gate to every module, over the global managed runner gate (ManagedRunnerGateModule). */
@Global()
@Module({
  providers: [
    {
      provide: MANAGED_RUNNER_BROWSER_GATE,
      inject: [ConfigService, MANAGED_RUNNER_GATE],
      useFactory: (config: ConfigService, managed: ManagedRunnerGate) => managedRunnerBrowserGateFrom(config, managed),
    },
  ],
  exports: [MANAGED_RUNNER_BROWSER_GATE],
})
export class ManagedRunnerBrowserGateModule {}

/**
 * What a claim says of the browser switch (ClaimedSession.browserEnabled): `browserEnabled` only while it is on. The
 * runner writes it into the engine's environment as ORBIT_BROWSER=on, and `orbit mcp` and the CLI offer the browser
 * tools (browser_status and the ones after it) only then: off, they are absent rather than refused. The one place a
 * session learns whether the browser tools exist; their routes answer 404 by ManagedRunnerBrowserEnabledGuard.
 */
export function browserClaimFields(gate: Pick<ManagedRunnerBrowserGate, 'enabled'> | undefined): { browserEnabled?: true } {
  return gate?.enabled ? { browserEnabled: true } : {};
}
