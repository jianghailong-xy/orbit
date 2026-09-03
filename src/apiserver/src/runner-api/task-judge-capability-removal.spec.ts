import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

/**
 * `task_judge` is gone from every door, and the two declaration flags beside it are not.
 *
 * The runner exposes one capability set across three surfaces — the MCP tool list, the `orbit`
 * CLI, and the capability document both are generated from — and a capability removed from one of
 * them and left in another is a tool an agent can see and cannot call. So all three are read here,
 * from the Go source, together with the HTTP routes they would have posted to.
 */

const ROOT = path.resolve(__dirname, '../../../..');

function read(relative: string): string {
  return readFileSync(path.join(ROOT, relative), 'utf8');
}

const MCP = read('src/runner-go/mcp.go');
const CLI = read('src/runner-go/task_cli.go');
const TRANSPORT = read('src/runner-go/transport.go');

test('no runner surface still advertises, dispatches or transports task_judge', () => {
  for (const [name, source] of [['mcp.go', MCP], ['task_cli.go', CLI],
    ['transport.go', TRANSPORT]] as const) {
    assert.doesNotMatch(source, /task_judge/u, `${name} still names task_judge`);
    assert.doesNotMatch(source, /judgeTask/u, `${name} still calls judgeTask`);
  }
  assert.doesNotMatch(CLI, /orbit task judge/u, 'the CLI usage still lists `orbit task judge`');
  assert.doesNotMatch(CLI, /case "judge":/u, 'the CLI still dispatches the judge subcommand');
  assert.equal(existsSync(path.join(ROOT, 'src/runner-go/task_judge_test.go')), false);
});

test('the two declaration flags are untouched on every door', () => {
  for (const flag of ['--acceptance-command', '--acceptance-expected-exit-code',
    '--clear-executable-acceptance']) {
    assert.ok(CLI.includes(flag), `the CLI lost ${flag}, which writes the declaration`);
  }
  for (const field of ['acceptanceCommand', 'acceptanceExpectedExitCode']) {
    assert.ok(MCP.includes(field), `the MCP tool schema lost ${field}`);
  }
  // The capability document is generated from the same table the CLI dispatches from, so a
  // surviving entry there would be a tool with no handler.
  const capabilities = CLI.slice(CLI.indexOf('{Tool: "task_create"'));
  assert.doesNotMatch(capabilities, /Tool: "task_judge"/u);
  assert.match(capabilities, /Tool: "task_update"/u);
});

test('the server routes it posted to are gone, and the declaration routes are not', () => {
  const tasksController = read('src/apiserver/src/tasks/tasks.controller.ts');
  const runnerTasks = read('src/apiserver/src/runner-api/runner-tasks.controller.ts');
  for (const [name, source] of [['tasks.controller.ts', tasksController],
    ['runner-tasks.controller.ts', runnerTasks]] as const) {
    assert.doesNotMatch(source, /judgment/u, `${name} still routes a judgment endpoint`);
    assert.doesNotMatch(source, /JudgeTaskDto/u);
  }
  assert.match(tasksController, /@Patch\(':id'\)/u, 'task_update is how a declaration is edited');
  assert.match(runnerTasks, /@Patch\('tasks\/:id'\)/u);

  // And the service method behind them is gone, with no replacement under another name.
  const service = read('src/apiserver/src/tasks/tasks.service.ts');
  assert.doesNotMatch(service, /async judge\(/u);
  assert.doesNotMatch(service, /async requestMoreEvidence\(/u);
  assert.doesNotMatch(service, /ensureJudgmentVerification|retireSupersededJudgmentVerifications/u);
});

test('the remedy an agent is given names the state, not a door that no longer exists', () => {
  const criterion = read('src/apiserver/src/tasks/task-completion-criterion.ts');
  const remedies = criterion.slice(criterion.indexOf('export function taskCompletionRequiredAction'));
  // EXECUTABLE regained an implementation on 2026-09-03, so its remedy names the action that
  // settles it. What this suite is answerable for is that the action is not the removed door:
  // running the declared acceptance command is a thing the run already does, and `task_judge` was
  // an endpoint an agent had to call.
  assert.match(remedies, /RUN_ACCEPTANCE_COMMAND/u);
  assert.match(remedies, /AWAIT_EVIDENCE_JUDGMENT_IMPLEMENTATION/u);
  assert.doesNotMatch(remedies, /task_judge/u);
  assert.doesNotMatch(remedies, /RUN_EXECUTABLE_CRITERION|DECIDE_THE_OPEN_EVIDENCE_JUDGMENT/u);
  // VERIFICATION's two remedies are unchanged: it is the one criterion that still works.
  assert.match(remedies, /RECORD_VERIFICATION_VERDICT/u);
  assert.match(remedies, /OBTAIN_INDEPENDENT_VERIFICATION_PASS/u);
});
