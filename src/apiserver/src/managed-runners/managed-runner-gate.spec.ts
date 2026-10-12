import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Inject, Injectable, Module, type LoggerService } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import {
  MANAGED_RUNNER_GATE,
  MANAGED_RUNNERS_ENABLED_ENV,
  ManagedRunnerGateModule,
  managedRunnerGateFrom,
  readManagedRunnerGate,
  type ManagedRunnerGate,
} from './managed-runner-gate';

// ORBIT_MANAGED_RUNNERS_ENABLED, row by row (docs/managed-runner-design.md, "Default disabled
// gate"): after trimming and lowercasing, absent, empty and `false` are off without a word, `true`
// is on, and every other value — `1`, `yes`, `on` included — is off with one warning.

const TABLE: ReadonlyArray<{ said: string | undefined; enabled: boolean; warns: boolean }> = [
  { said: undefined, enabled: false, warns: false },
  { said: '', enabled: false, warns: false },
  { said: '   ', enabled: false, warns: false },
  { said: 'false', enabled: false, warns: false },
  { said: 'FALSE', enabled: false, warns: false },
  { said: ' False\n', enabled: false, warns: false },
  { said: 'true', enabled: true, warns: false },
  { said: 'TRUE', enabled: true, warns: false },
  { said: 'True', enabled: true, warns: false },
  { said: '  true  ', enabled: true, warns: false },
  { said: '\tTrUe\n', enabled: true, warns: false },
  { said: '1', enabled: false, warns: true },
  { said: 'yes', enabled: false, warns: true },
  { said: 'YES', enabled: false, warns: true },
  { said: 'on', enabled: false, warns: true },
  { said: ' On ', enabled: false, warns: true },
  { said: 'enabled', enabled: false, warns: true },
  { said: '0', enabled: false, warns: true },
  { said: 'no', enabled: false, warns: true },
  { said: 'off', enabled: false, warns: true },
  { said: 't', enabled: false, warns: true },
  { said: 'truee', enabled: false, warns: true },
  { said: '"true"', enabled: false, warns: true },
  { said: 'true,false', enabled: false, warns: true },
];

for (const row of TABLE) {
  test(`${MANAGED_RUNNERS_ENABLED_ENV}=${JSON.stringify(row.said)} is ${row.enabled ? 'enabled' : 'disabled'}${row.warns ? ', with one warning' : ''}`, () => {
    const gate = readManagedRunnerGate(row.said);
    assert.equal(gate.enabled, row.enabled);
    assert.equal(gate.problem !== null, row.warns);
    if (row.warns) assert.match(gate.problem!, /neither true nor false: managed runners are disabled/);

    const warnings: string[] = [];
    const read = managedRunnerGateFrom({ get: () => row.said as never }, { warn: (message: string) => void warnings.push(message) });
    assert.deepEqual(read, gate);
    assert.equal(warnings.length, row.warns ? 1 : 0, 'an unreadable value is logged exactly once, a readable one never');
  });
}

test('the gate is read once per process: every consumer shares one value, logged once, and a later change waits for a restart', async () => {
  @Injectable()
  class First {
    constructor(@Inject(MANAGED_RUNNER_GATE) readonly gate: ManagedRunnerGate) {}
  }
  @Injectable()
  class Second {
    constructor(@Inject(MANAGED_RUNNER_GATE) readonly gate: ManagedRunnerGate) {}
  }
  @Module({
    imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), ManagedRunnerGateModule],
    providers: [First, Second],
  })
  class Harness {}

  const warnings: string[] = [];
  const logger: LoggerService = { log: () => undefined, error: () => undefined, warn: (m: unknown) => void warnings.push(String(m)) };
  const previous = process.env[MANAGED_RUNNERS_ENABLED_ENV];
  process.env[MANAGED_RUNNERS_ENABLED_ENV] = 'on';
  const app = await NestFactory.createApplicationContext(Harness, { logger, abortOnError: false });
  try {
    const first = app.get(First).gate;
    const second = app.get(Second).gate;
    assert.equal(first, second, 'one effective value, shared');
    assert.equal(first.enabled, false);
    assert.equal(warnings.filter((w) => w.includes(MANAGED_RUNNERS_ENABLED_ENV)).length, 1, 'one warning for the process, not one per consumer');

    process.env[MANAGED_RUNNERS_ENABLED_ENV] = 'true';
    assert.equal(app.get(First).gate.enabled, false, 'changing the environment of a running process changes nothing');
    assert.equal(app.get(MANAGED_RUNNER_GATE), first);
  } finally {
    await app.close();
    if (previous === undefined) delete process.env[MANAGED_RUNNERS_ENABLED_ENV];
    else process.env[MANAGED_RUNNERS_ENABLED_ENV] = previous;
  }
});
