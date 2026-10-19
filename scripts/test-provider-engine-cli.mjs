import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTapResults } from './test-dsh-routing.mjs';
import { assertGoResults, goTestPattern, runLogged } from './test-dsh-runtime-environment.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const runnerGo = path.join(root, 'src/runner-go');

// T5 of the provider/engine split (docs/provider-engine-contract.md §6, §8.2, §9): the CLI and the MCP
// tools take an engine beside the provider, `orbit provider list` hands on each provider's engines,
// `orbit resume` follows the session's engine to a dsh branch, and a Harness session's missing key is
// asked for as a DeepSeek key. Exact names, independent of Go's discovery: a renamed, missing,
// skipped or failed test is red, and so is any test the selector matched that is not on this list.
export const namedGoTests = {
  'session_cli_test.go': [
    'TestSessionCLICreateSendsTheEngineOnlyWhenNamed',
    'TestSessionCLICreateSendsTheEngineOnlyWhenNamed/engine_and_provider',
    'TestSessionCLICreateSendsTheEngineOnlyWhenNamed/engine_alone',
    'TestSessionCLICreateSendsTheEngineOnlyWhenNamed/provider_alone_keeps_the_engine_it_ran_on',
  ],
  'task_cli_test.go': [
    'TestTaskCLICreateSendsTheEnginePinOnlyWhenNamed',
    'TestTaskCLICreateSendsTheEnginePinOnlyWhenNamed/provider_alone_keeps_the_engine_it_ran_on',
    'TestTaskCLIUpdateSetsClearsOrLeavesTheEnginePin',
    'TestTaskCLIUpdateSetsClearsOrLeavesTheEnginePin/set',
    'TestTaskCLIUpdateSetsClearsOrLeavesTheEnginePin/clear',
    'TestTaskCLIUpdateSetsClearsOrLeavesTheEnginePin/provider_alone',
    'TestTaskCLICreateBatchCarriesEachItemsEngine',
  ],
  'task_batch_pin_cli_test.go': [
    'TestTaskCLIBatchPinSetsClearsOrLeavesTheEnginePin',
    'TestTaskCLIBatchPinSetsClearsOrLeavesTheEnginePin/engine_alone',
    'TestTaskCLIBatchPinSetsClearsOrLeavesTheEnginePin/clear',
    'TestTaskCLIBatchPinSetsClearsOrLeavesTheEnginePin/provider_alone_keeps_the_engine_it_ran_on',
    'TestTaskCLIBatchPinSendsTheSelectionAndPrintsWhatChanged',
    'TestTaskCLIBatchPinRefusesNoSelectorAndNoPin',
  ],
  'mcp_test.go': [
    'TestMCPEngineReachesEveryDoorThatTakesIt',
    'TestMCPEngineReachesEveryDoorThatTakesIt/session_create',
    'TestMCPEngineReachesEveryDoorThatTakesIt/task_create',
    'TestMCPEngineReachesEveryDoorThatTakesIt/task_create_batch',
    'TestMCPEngineReachesEveryDoorThatTakesIt/task_update',
    'TestMCPEngineReachesEveryDoorThatTakesIt/task_batch_pin',
    'TestMCPEngineReachesEveryDoorThatTakesIt/task_update_clears',
    'TestMCPEngineReachesEveryDoorThatTakesIt/task_batch_pin_clears',
    'TestMCPProviderAloneSendsNoEngine',
    'TestMCPProviderAloneSendsNoEngine/session_create',
    'TestMCPProviderAloneSendsNoEngine/task_create',
    'TestMCPProviderAloneSendsNoEngine/task_create_batch',
    'TestMCPProviderAloneSendsNoEngine/task_update',
    'TestMCPProviderAloneSendsNoEngine/task_batch_pin',
    'TestMCPEngineSchemasNameTheSixEngines',
    'TestMCPProviderAndAgentDescriptionsFollowTheDecoupledModel',
  ],
  'cli_mcp_parity_test.go': [
    'TestEngineParameterStaysInParityAcrossCLIAndMCP',
    'TestCLICapabilitiesCoverEveryMCPToolAndParameter',
  ],
  'cli_help_flag_coverage_test.go': [
    'TestEngineFlagsAreInTheHelpOfEveryCommandThatTakesThem',
    'TestPerActionHelpDocumentsEveryAdvertisedFlag',
  ],
  'provider_cli_test.go': [
    'TestProviderCLIListPrintsTheEnginesEachProviderRuns',
    'TestProviderCLIHelpSpeaksOfProtocolsAndEngines',
    'TestProviderListReadsTheRunnerRouteWithoutOrchestration',
  ],
  'resume_engine_test.go': [
    'TestResumeMetaTakesTheSessionEngineFromTheServer',
    'TestResumeOnADshSessionTakesTheDshBranch',
    'TestOrbitResumeOfADshSessionStartsNoCLI',
    'TestOrbitResumeOfADshSessionStartsNoCLI/from_the_local_record',
    'TestOrbitResumeOfADshSessionStartsNoCLI/from_the_server_meta',
  ],
  'dsh_environment_test.go': [
    'TestDshMissingKeyAsksForADeepSeekKey',
  ],
};

export const goTestNames = Object.values(namedGoTests).flat();

/** Each acceptance criterion of the task, and the named Go tests that prove it. */
export const criteria = {
  'orbit session create --engine and MCP session_create engine': [
    'TestSessionCLICreateSendsTheEngineOnlyWhenNamed', 'TestMCPEngineReachesEveryDoorThatTakesIt/session_create',
  ],
  'orbit task create, create-batch, update and batch-pin engine, and the MCP task tools engine': [
    'TestTaskCLICreateSendsTheEnginePinOnlyWhenNamed', 'TestTaskCLICreateBatchCarriesEachItemsEngine',
    'TestTaskCLIUpdateSetsClearsOrLeavesTheEnginePin', 'TestTaskCLIBatchPinSetsClearsOrLeavesTheEnginePin',
    'TestTaskCLIBatchPinSendsTheSelectionAndPrintsWhatChanged', 'TestTaskCLIBatchPinRefusesNoSelectorAndNoPin',
    'TestMCPEngineReachesEveryDoorThatTakesIt', 'TestMCPEngineSchemasNameTheSixEngines',
  ],
  'CLI and MCP parameters stay in parity': [
    'TestEngineParameterStaysInParityAcrossCLIAndMCP', 'TestCLICapabilitiesCoverEveryMCPToolAndParameter',
    'TestEngineFlagsAreInTheHelpOfEveryCommandThatTakesThem', 'TestPerActionHelpDocumentsEveryAdvertisedFlag',
  ],
  'orbit provider list and provider_list output engines, with the copy of the new model': [
    'TestProviderCLIListPrintsTheEnginesEachProviderRuns', 'TestProviderListReadsTheRunnerRouteWithoutOrchestration',
    'TestProviderCLIHelpSpeaksOfProtocolsAndEngines', 'TestMCPProviderAndAgentDescriptionsFollowTheDecoupledModel',
  ],
  'a call naming only a provider keeps its engine (no engine is sent)': [
    'TestMCPProviderAloneSendsNoEngine',
    'TestSessionCLICreateSendsTheEngineOnlyWhenNamed/provider_alone_keeps_the_engine_it_ran_on',
    'TestTaskCLICreateSendsTheEnginePinOnlyWhenNamed/provider_alone_keeps_the_engine_it_ran_on',
    'TestTaskCLIUpdateSetsClearsOrLeavesTheEnginePin/provider_alone',
    'TestTaskCLIBatchPinSetsClearsOrLeavesTheEnginePin/provider_alone_keeps_the_engine_it_ran_on',
    'TestTaskCLICreateBatchCarriesEachItemsEngine',
  ],
  'orbit resume follows the session engine from the server meta and takes the dsh branch': [
    'TestResumeMetaTakesTheSessionEngineFromTheServer', 'TestResumeOnADshSessionTakesTheDshBranch',
    'TestOrbitResumeOfADshSessionStartsNoCLI',
  ],
  'the missing-key hint asks for a DeepSeek key': ['TestDshMissingKeyAsksForADeepSeekKey'],
};

export const guardNames = [
  'T5 acceptance guard requires every named Go test to run and pass exactly once',
  'T5 acceptance guard rejects skipped, failed and unmatched Go tests and a package that never passed',
  'T5 acceptance guard finds every named Go test declared in its source file',
  'T5 acceptance guard maps every acceptance criterion to named Go tests it runs',
  'T5 acceptance guard rejects missing executables and startup failures',
  'T5 acceptance runs Go without the calling session or engine credentials, keeping HOME, PATH and TMPDIR',
];

/** Every top-level named test is declared, once, in the file it is listed under. */
export function assertDeclared(tests, directory = runnerGo) {
  for (const [file, names] of Object.entries(tests)) {
    const source = path.join(directory, file);
    assert.ok(existsSync(source), `missing required Go test source: ${file}`);
    const text = readFileSync(source, 'utf8');
    for (const name of new Set(names.map((entry) => entry.split('/')[0]))) {
      const declarations = text.match(new RegExp(`^func ${name}\\(t \\*testing\\.T\\)`, 'gm')) ?? [];
      assert.equal(declarations.length, 1, `missing or duplicate Go test ${name} in ${file}`);
    }
  }
}

/**
 * The environment the Go tests run in: what a plain shell gives them. The calling Orbit session's
 * context, the Claude Code session around it and every engine credential are dropped, so no test
 * acts for this session or spends a key. HOME, PATH and TMPDIR stay as they are: a scratch TMPDIR
 * lengthens the runner's background-socket path past the limit and denies its fork tests.
 */
export function goEnvironment(original) {
  const dropped = /^(ORBIT_|CLAUDE_CODE_|ANTHROPIC_|OPENAI_|GEMINI_|GOOGLE_GEMINI_|KIMI_|DSH_|DEEPSEEK_|OPENCODE_)/;
  const env = {};
  for (const [key, value] of Object.entries(original)) {
    if (dropped.test(key) || ['CLAUDECODE', 'CLAUDE_CONFIG_DIR', 'CLAUDE_EFFORT', 'CLAUDE_PID'].includes(key)) continue;
    env[key] = value;
  }
  return env;
}

function runAcceptance() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'orbit-provider-engine-cli-'));
  const summary = [];
  try {
    const guard = path.join(root, 'test/test-provider-engine-cli.test.mjs');
    assert.ok(existsSync(guard), `missing required test file: ${guard}`);
    const tap = runLogged(process.execPath, ['--test', '--test-isolation=none', '--test-reporter=tap', guard], path.join(scratch, 'guard.tap'));
    process.stdout.write(tap);
    assertTapResults(tap, guardNames);
    summary.push(['acceptance guard', guardNames.length]);

    // The named tests, selected by exact top-level name. Every engine CLI on PATH is blocked first: a
    // test that started a real one would leave its mark in the output and exit 97.
    assertDeclared(namedGoTests);
    const blocked = path.join(scratch, 'blocked-bin');
    mkdirSync(blocked, { mode: 0o700 });
    for (const engine of ['claude', 'codex', 'kimi', 'opencode', 'agy', 'dsh']) {
      writeFileSync(path.join(blocked, engine), '#!/bin/sh\nprintf "T5 tests started a real engine CLI\\n" >&2\nexit 97\n', { mode: 0o700 });
    }
    const env = goEnvironment(process.env);
    const named = runLogged('go', ['test', '-json', '-count=1', '-timeout=600s', '-run', goTestPattern(goTestNames), '.'], path.join(scratch, 'named.json'), {
      cwd: runnerGo,
      env: { ...env, PATH: `${blocked}${path.delimiter}${env.PATH ?? ''}` },
      timeout: 900_000,
    });
    assertGoResults(named, goTestNames);
    for (const name of goTestNames) process.stdout.write(`PASS ${name}\n`);
    summary.push(['named Go tests and subtests', goTestNames.length]);

    // The whole runner suite, as the merge check runs it.
    const full = runLogged('go', ['test', './...'], path.join(scratch, 'full.log'), { cwd: runnerGo, env, timeout: 4_200_000 });
    process.stdout.write(full);
    assert.match(full, /^ok\s+orbit\s/m, 'the runner package did not report ok');
    assert.doesNotMatch(full, /^(?:FAIL|--- FAIL)/m, 'a Go test failed');
    summary.push(['(cd src/runner-go && go test ./...) exit 0', 1]);

    for (const [label, count] of summary) process.stdout.write(`PASS ${label}: ${count}\n`);
    for (const [criterion, names] of Object.entries(criteria)) process.stdout.write(`COVERED ${criterion}: ${names.length} named test(s)\n`);
    process.stdout.write('T5 provider-engine CLI acceptance passed: every named Go test ran and passed, none missing, unmatched or skipped, and go test ./... passed in full.\n');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runAcceptance();
