import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptanceScenarios, guardNames, lifecycleScenarios, raceScenarios, realScenarios } from '../scripts/test-dsh-session-lifecycle.mjs';
import { assertGoResults, goTestPattern } from '../scripts/test-dsh-runtime-environment.mjs';

function goEvents(names) {
  return [{ Action: 'start', Package: 'orbit' },
    ...names.flatMap((Test) => [{ Action: 'run', Package: 'orbit', Test }, { Action: 'pass', Package: 'orbit', Test }]),
    { Action: 'pass', Package: 'orbit' }];
}

const json = (events) => `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;

test(guardNames[0], () => {
  for (const required of ['MultiTurnQueue/orbit-queue-and-redelivery', 'MultiTurnQueue/runner-local-queue', 'Interrupt/cancel-active-turn',
    'Interrupt/cancel-beats-racing-end_turn', 'Interrupt/approval-stop', 'SettlementPriority/precedence-table',
    'SettlementPriority/stop-beats-exit', 'CrashRestartRecovery/runner-killed-mid-tool', 'LeaseLoss', 'LateEvents/settled-turn-stragglers',
    'LateEvents/lost-completion-is-reported-again', 'ShutdownAndResume', 'CredentialReload', 'Redaction']) {
    assert.ok(lifecycleScenarios.includes(`TestDshLifecycle${required}`), `missing mandatory scenario ${required}`);
  }
  assert.ok(acceptanceScenarios.includes('TestDshLifecycleRealRestartCancelAndLeaseRecovery'));
  assert.equal(new Set(acceptanceScenarios).size, acceptanceScenarios.length);
  assertGoResults(json(goEvents(acceptanceScenarios)), acceptanceScenarios);
  const selector = new RegExp(goTestPattern(acceptanceScenarios));
  assert.ok(selector.test('TestDshLifecycleLeaseLoss'));
  assert.ok(!selector.test('TestDshLifecycleHelperProcess'), 'helper processes are not scenarios');
  assert.ok(!selector.test('TestDshLifecycleLeaseLossExtra'));
});

test(guardNames[1], () => {
  const events = goEvents(acceptanceScenarios);
  for (const name of ['TestDshLifecycleLeaseLoss', 'TestDshLifecycleInterrupt/approval-stop', realScenarios[0]]) {
    assert.throws(() => assertGoResults(json(events.filter((event) => event.Test !== name)), acceptanceScenarios), `missing ${name}`);
    assert.throws(() => assertGoResults(json(events.map((event) => event.Test === name && event.Action === 'pass' ? { ...event, Action: 'skip' } : event)), acceptanceScenarios));
    assert.throws(() => assertGoResults(json(events.map((event) => event.Test === name && event.Action === 'pass' ? { ...event, Action: 'fail' } : event)), acceptanceScenarios));
    assert.throws(() => assertGoResults(json(events.filter((event) => !(event.Test === name && event.Action === 'pass'))), acceptanceScenarios));
    assert.throws(() => assertGoResults(json([...events, ...goEvents([name]).slice(1, -1)]), acceptanceScenarios), `duplicate ${name}`);
  }
  assert.throws(() => assertGoResults(json([...events, ...goEvents(['TestUnrelated']).slice(1, -1)]), acceptanceScenarios));
  assert.throws(() => assertGoResults(json([...events, { Action: 'skip', Package: 'orbit', Test: 'TestDshLifecycleWiring/extra' }]), acceptanceScenarios));
});

test(guardNames[2], () => {
  const events = goEvents(acceptanceScenarios);
  for (const output of ['', 'not JSON\n', json(events.filter((event) => event.Test)), json(events.filter((event) => event.Action !== 'start')),
    json(events.map((event) => ({ ...event, Package: 'another' }))), json(events.map((event) => !event.Test && event.Action === 'pass' ? { ...event, Action: 'fail' } : event))]) {
    assert.throws(() => assertGoResults(output, acceptanceScenarios));
  }
});

test(guardNames[3], () => {
  for (const name of lifecycleScenarios) assert.ok(raceScenarios.includes(name), `race run misses ${name}`);
  assert.ok(!raceScenarios.some((name) => realScenarios.includes(name)), 'the real CLI scenario is not an in-process race subject');
});
