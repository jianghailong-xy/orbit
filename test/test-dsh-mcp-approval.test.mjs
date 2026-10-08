import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertNamedTap, assertNamedVitest, goScenarios, guardNames, raceScenarios, realScenarios, unitScenarios,
} from '../scripts/test-dsh-mcp-approval.mjs';
import { assertGoResults, goTestPattern } from '../scripts/test-dsh-runtime-environment.mjs';

function goEvents(names) {
  return [{ Action: 'start', Package: 'orbit' },
    ...names.flatMap((Test) => [{ Action: 'run', Package: 'orbit', Test }, { Action: 'pass', Package: 'orbit', Test }]),
    { Action: 'pass', Package: 'orbit' }];
}

const json = (events) => `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;

test(guardNames[0], () => {
  for (const required of ['RealApprovalAllowOnce', 'RealApprovalReject', 'RealApprovalStop', 'RealApprovalDisconnect',
    'RealOrbitMCPAndAgentInstructions', 'RealDontAskRejectsUnasked', 'RealAutoWorkspaceBoundary', 'RealThirdPartyMCPAsksFirst']) {
    assert.ok(realScenarios.includes(`TestDsh${required}`), `missing mandatory real scenario ${required}`);
  }
  for (const required of ['PermissionBridge/late-allow-after-stop-is-never-sent', 'PermissionBridge/unknown-tool-call-is-rejected',
    'MCPServers/sse-entry-refused-before-launch', 'PermissionPolicy/unsupported-modes-refused-before-launch', 'EventsToolCallJoin',
    'ACPPermissionRoundTrip/allow-once', 'ToolPolicy', 'AgentOverlay']) {
    assert.ok(unitScenarios.includes(`TestDsh${required}`), `missing mandatory scenario ${required}`);
  }
  assert.equal(new Set(goScenarios).size, goScenarios.length);
  assertGoResults(json(goEvents(goScenarios)), goScenarios);
  const selector = new RegExp(goTestPattern(goScenarios));
  assert.ok(selector.test('TestDshRealApprovalStop'));
  assert.ok(!selector.test('TestDshRealApprovalStopExtra'));
  assert.ok(!selector.test('TestDshACPHelperProcess'), 'helper processes are not scenarios');
});

test(guardNames[1], () => {
  const events = goEvents(goScenarios);
  for (const name of ['TestDshRealApprovalDisconnect', 'TestDshPermissionBridge/late-allow-after-stop-is-never-sent', 'TestDshMCPServers']) {
    assert.throws(() => assertGoResults(json(events.filter((event) => event.Test !== name)), goScenarios), `missing ${name}`);
    assert.throws(() => assertGoResults(json(events.map((event) => event.Test === name && event.Action === 'pass' ? { ...event, Action: 'skip' } : event)), goScenarios));
    assert.throws(() => assertGoResults(json(events.map((event) => event.Test === name && event.Action === 'pass' ? { ...event, Action: 'fail' } : event)), goScenarios));
    assert.throws(() => assertGoResults(json(events.filter((event) => !(event.Test === name && event.Action === 'pass'))), goScenarios));
  }
  assert.throws(() => assertGoResults(json([...events, ...goEvents(['TestUnrelated']).slice(1, -1)]), goScenarios));
  for (const output of ['', 'not JSON\n', json(events.filter((event) => event.Test)), json(events.map((event) => ({ ...event, Package: 'another' })))]) {
    assert.throws(() => assertGoResults(output, goScenarios));
  }
});

test(guardNames[2], () => {
  const summary = (n, extra = {}) => Object.entries({ tests: n, pass: n, fail: 0, cancelled: 0, skipped: 0, todo: 0, ...extra })
    .map(([key, value]) => `# ${key} ${value}\n`).join('');
  const tap = `TAP version 13\nok 1 - required\nok 2 - other\n1..2\n${summary(2)}`;
  assertNamedTap(tap, ['required']);
  assert.throws(() => assertNamedTap(tap, ['missing']));
  assert.throws(() => assertNamedTap(tap.replace('ok 1 - required', 'ok 1 - required # SKIP'), ['required']));
  assert.throws(() => assertNamedTap(tap.replace('ok 2 - other', 'not ok 2 - other'), ['required']));
  assert.throws(() => assertNamedTap(`TAP version 13\nok 1 - required\n1..1\n${summary(1, { skipped: 1 })}`, ['required']));
  assert.throws(() => assertNamedTap('', ['required']));
  const vitest = { success: true, testResults: [{ assertionResults: [{ title: 'required', status: 'passed' }] }] };
  assertNamedVitest(vitest, ['required']);
  assert.throws(() => assertNamedVitest({ ...vitest, success: false }, ['required']));
  assert.throws(() => assertNamedVitest(vitest, ['missing']));
  assert.throws(() => assertNamedVitest({ success: true, testResults: [{ assertionResults: [{ title: 'required', status: 'skipped' }] }] }, ['required']));
  assert.throws(() => assertNamedVitest({ success: true, testResults: [] }, ['required']));
});

test(guardNames[3], () => {
  for (const name of unitScenarios) assert.ok(raceScenarios.includes(name), `race run misses ${name}`);
  assert.ok(!raceScenarios.some((name) => realScenarios.includes(name)), 'real CLI scenarios are not in-process race subjects');
});
