import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Inject, Injectable, Module, type LoggerService } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { RunnerLinkWelcomeController } from '../runner-api/runner-link-welcome.controller';
import {
  browserClaimFields,
  MANAGED_RUNNER_BROWSER_ENABLED_ENV,
  MANAGED_RUNNER_BROWSER_GATE,
  ManagedRunnerBrowserGateModule,
  managedRunnerBrowserGateFrom,
  readManagedRunnerBrowserGate,
  type ManagedRunnerBrowserGate,
} from './managed-runner-browser-gate';
import { MANAGED_RUNNERS_ENABLED_ENV, ManagedRunnerGateModule } from './managed-runner-gate';
import type { ManagedRunnerInstance } from './managed-runner-instance';

// ORBIT_MANAGED_RUNNER_BROWSER_ENABLED, row by row (docs/runner-browser-design.md §2): after trimming and
// lowercasing, absent, empty and `false` are off without a word, `true` is on if managed runners are on, and every
// other value — `1`, `yes`, `on` included — is off with one warning.

const ON = { enabled: true };
const OFF = { enabled: false };

const TABLE: ReadonlyArray<{ said: string | undefined; managed: { enabled: boolean }; enabled: boolean; warns: boolean }> = [
  { said: undefined, managed: ON, enabled: false, warns: false },
  { said: '', managed: ON, enabled: false, warns: false },
  { said: '   ', managed: ON, enabled: false, warns: false },
  { said: 'false', managed: ON, enabled: false, warns: false },
  { said: ' FALSE ', managed: ON, enabled: false, warns: false },
  { said: 'true', managed: ON, enabled: true, warns: false },
  { said: ' TRUE ', managed: ON, enabled: true, warns: false },
  { said: '\tTrUe\n', managed: ON, enabled: true, warns: false },
  { said: '1', managed: ON, enabled: false, warns: true },
  { said: 'yes', managed: ON, enabled: false, warns: true },
  { said: 'on', managed: ON, enabled: false, warns: true },
  { said: 'truee', managed: ON, enabled: false, warns: true },
  { said: '"true"', managed: ON, enabled: false, warns: true },
  // Managed runners off: no browser, whatever the switch says.
  { said: 'true', managed: OFF, enabled: false, warns: false },
  { said: ' TRUE ', managed: OFF, enabled: false, warns: false },
  { said: undefined, managed: OFF, enabled: false, warns: false },
  { said: 'yes', managed: OFF, enabled: false, warns: true },
];

for (const row of TABLE) {
  const name = `${MANAGED_RUNNER_BROWSER_ENABLED_ENV}=${JSON.stringify(row.said)} with managed runners ${row.managed.enabled ? 'on' : 'off'}`
    + ` is ${row.enabled ? 'on' : 'off'}${row.warns ? ', with one warning' : ''}`;
  test(name, () => {
    const gate = readManagedRunnerBrowserGate(row.said, row.managed);
    assert.equal(gate.enabled, row.enabled);
    assert.equal(gate.problem !== null, row.warns);
    if (row.warns) assert.match(gate.problem!, /neither true nor false: the managed runner browser is off/);

    const warnings: string[] = [];
    const read = managedRunnerBrowserGateFrom({ get: () => row.said as never }, row.managed,
      { warn: (message: string) => void warnings.push(message) });
    assert.deepEqual(read, gate);
    assert.equal(warnings.length, row.warns ? 1 : 0, 'an unreadable value is logged exactly once, a readable one never');
  });
}

async function withEnv<T>(env: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await run();
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

@Injectable()
class Consumer {
  constructor(@Inject(MANAGED_RUNNER_BROWSER_GATE) readonly gate: ManagedRunnerBrowserGate) {}
}

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), ManagedRunnerGateModule, ManagedRunnerBrowserGateModule],
  providers: [Consumer],
})
class Harness {}

async function effective(env: Record<string, string | undefined>): Promise<{ gate: ManagedRunnerBrowserGate; warnings: string[] }> {
  const warnings: string[] = [];
  const logger: LoggerService = { log: () => undefined, error: () => undefined, warn: (m: unknown) => void warnings.push(String(m)) };
  return withEnv(env, async () => {
    const app = await NestFactory.createApplicationContext(Harness, { logger, abortOnError: false });
    try {
      const gate = app.get(Consumer).gate;
      assert.equal(app.get(MANAGED_RUNNER_BROWSER_GATE), gate, 'one effective value, shared');
      return { gate, warnings: warnings.filter((w) => w.includes(MANAGED_RUNNER_BROWSER_ENABLED_ENV)) };
    } finally {
      await app.close();
    }
  });
}

test('through DI the browser gate reads both switches from configuration, once', async () => {
  const on = await effective({ [MANAGED_RUNNERS_ENABLED_ENV]: 'true', [MANAGED_RUNNER_BROWSER_ENABLED_ENV]: ' TRUE ' });
  assert.equal(on.gate.enabled, true);
  assert.equal(on.warnings.length, 0);

  const managedOff = await effective({ [MANAGED_RUNNERS_ENABLED_ENV]: undefined, [MANAGED_RUNNER_BROWSER_ENABLED_ENV]: 'true' });
  assert.equal(managedOff.gate.enabled, false, 'no browser without managed runners');

  const absent = await effective({ [MANAGED_RUNNERS_ENABLED_ENV]: 'true', [MANAGED_RUNNER_BROWSER_ENABLED_ENV]: undefined });
  assert.equal(absent.gate.enabled, false, 'off by default');
  assert.equal(absent.warnings.length, 0);

  const unreadable = await effective({ [MANAGED_RUNNERS_ENABLED_ENV]: 'true', [MANAGED_RUNNER_BROWSER_ENABLED_ENV]: 'on' });
  assert.equal(unreadable.gate.enabled, false);
  assert.equal(unreadable.warnings.length, 1, 'one warning for the process');
});

test('the welcome route offers the browser only with the gate on and an authorized managed instance', async () => {
  const instance: ManagedRunnerInstance = { mappingId: 'm-1', generation: 1, podUid: '00000000-0000-4000-8000-000000000001' };
  const body = { leaseOwner: '00000000-0000-4000-8000-0000000000aa', sessionIds: [] };
  const answer = (gate: ManagedRunnerBrowserGate | undefined, managed?: ManagedRunnerInstance) =>
    new RunnerLinkWelcomeController({} as never, undefined, gate).welcome({ id: 'r-1' }, body, undefined, managed);

  assert.equal((await answer({ enabled: true, problem: null }, instance)).browser, true);
  assert.equal((await answer({ enabled: true, problem: null }, undefined)).browser, false, 'never to a self-managed runner');
  assert.equal((await answer({ enabled: false, problem: null }, instance)).browser, false);
  assert.equal((await answer(undefined, instance)).browser, false, 'no gate provided: off');
});

test('a claim says browserEnabled only with the gate on, so the browser tools are absent otherwise', () => {
  assert.deepEqual(browserClaimFields({ enabled: true }), { browserEnabled: true });
  assert.deepEqual(browserClaimFields({ enabled: false }), {}, 'off: nothing said, so the runner spawns without the tools');
  assert.deepEqual(browserClaimFields(undefined), {}, 'no gate provided: off');
});
