import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTapResults } from './test-dsh-routing.mjs';
import { assertGoResults, goTestPattern, runLogged } from './test-dsh-runtime-environment.mjs';

// D2 (a real DeepSeek 401 is an invalid key; rate limits, 5xx and network errors are not) and F1
// (dsh turns never report usage as a measured $0 / 0 tokens). Every scenario is named here,
// independent of test discovery: a missing, renamed, unmatched or skipped one fails the run, and so
// does a toolchain that cannot start.
const root = fileURLToPath(new URL('../', import.meta.url));

export const mandatoryGoCases = [
  'TestDshFailureSemanticsRequestValidation',
  ...['real-deepseek-401', 'masked-key-alone', 'authentication-fails', 'runner-code-roundtrip', 'structured-401',
    'structured-429-beats-wording', 'structured-503', 'rate-limit-text', 'rate-limit-429', 'server-error-5xx',
    'insufficient-balance-402', 'network-reset', 'transport-closed'].map((name) => `TestDshFailureSemanticsRequestValidation/${name}`),
  'TestDshFailureSemanticsDecodedReplyKeepsStatusAndRedacts',
  ...['status-401', 'nested-status-429', 'no-data'].map((name) => `TestDshFailureSemanticsDecodedReplyKeepsStatusAndRedacts/${name}`),
  'TestDshFailureSemanticsTurnCompletion',
  ...['real-401', 'structured-401', 'real-429', 'structured-503', 'server-error-500', 'network-dropped']
    .map((name) => `TestDshFailureSemanticsTurnCompletion/${name}`),
  'TestDshFailureSemanticsUsageUnknownOmitsCost',
  ...['claude-measured-cost', 'codex-measured-zero', 'with-worktree-snapshot']
    .map((name) => `TestDshFailureSemanticsUsageUnknownOmitsCost/${name}`),
  // The pre-existing classification table must still hold.
  'TestDshRequestValidationAndDiagnosticRedaction',
  ...['missing-key', 'invalid-key', 'revoked-key', 'unauthorized', 'rate-limit', 'server-error', 'permission-forbidden',
    'protocol-internal-error', 'success', 'ambiguous-success-with-error', 'incomplete-request']
    .map((name) => `TestDshRequestValidationAndDiagnosticRedaction/${name}`),
];

export const mandatoryApiCases = {
  'projects/attempt-budget-usage-unknown': [
    'F1 attempt budget reads an unknown cost as unmeasured, not as zero spent',
    'F1 attempt budget keeps a measured cost, zero included',
  ],
};

export const mandatoryPgCases = {
  'src/apiserver/src/tasks/dsh-usage-unknown.pg.spec.ts': [
    'F1 dsh usage is unknown in the routing report and attempt budget',
    'F1 routing report marks dsh usage unknown instead of $0 and 0 tokens',
    'F1 routing report keeps measured engines unchanged',
    'F1 attempt budget spend leaves dsh cost unmeasured',
    'F1 attempt budget spend keeps measured costs including zero',
  ],
  // Known-usage engines: the report's existing fixture, unchanged apart from the new count.
  'src/apiserver/src/tasks/task-model-routing-report.pg.spec.ts': [
    'model-routing report aggregates actual runs, first-run task cohorts and only the authenticated owner',
    'shadow uses actual models; first cohorts own later failures and all-run cost, without usage/judgment fan-out',
    'applied and shadow stay separate; quota failures do not count; even-sample p50 interpolates',
    'NULL level retains the control group, including Codex cached tokens and null-error failures',
    'unfinished runs with no usage, completion or finish time return defined counts and NULL ratios',
    'since is inclusive and never reclassifies a later run as the first',
    'agentId accepts public ids and UUIDs, uses the run Agent, and keeps later Agent costs in the original cohort',
    'another owner gets only their real decision, never mismatched owner/task/session associations',
    'HTTP authentication and filter validation are enforced and repeated GETs do not mutate data',
  ],
};

export const mandatoryWebCases = {
  file: 'src/lib/dshRuntime.test.ts',
  names: [
    'D2 the real DeepSeek 401 wording reads as an invalid key',
    'D2 rate limits server errors and dropped connections are not an invalid key',
    "D2 the runner's status verdict wins over key-like wording",
    'maps the runner codes and key-rejection evidence, and nothing vaguer',
  ],
};

export const mandatorySwiftCases = [
  'testRepairReadsTheRealDeepSeekKeyRejection',
  'testKeyRejectedPatternMatchesWebAndRunner',
  'testRepairMapsRunnerCodesAndKeyRejectionOnly',
  'testCopyMatchesWeb',
];

export function assertVitestNamed(report, names) {
  assert.equal(report.success, true, 'Vitest did not succeed');
  assert.ok(report.numTotalTests > 0, 'Vitest ran no tests');
  assert.equal(report.numFailedTests, 0, 'failed web scenario');
  assert.equal(report.numPendingTests + report.numTodoTests, 0, 'skipped or todo web scenario');
  const cases = report.testResults.flatMap((suite) => suite.assertionResults);
  for (const name of names) {
    const found = cases.filter((entry) => entry.title === name);
    assert.equal(found.length, 1, `missing or unmatched web scenario: ${name}`);
    assert.equal(found[0].status, 'passed', `web scenario did not pass: ${name}`);
  }
}

// XCTest on Linux: "Test Case 'DshRuntimeTests.testX' passed (0.001 seconds)".
export function assertXCTestNamed(output, names) {
  assert.doesNotMatch(output, /Test Case '[^']+' (?:failed|skipped)/, 'failed or skipped OrbitKit scenario');
  for (const name of names) {
    const passed = [...output.matchAll(new RegExp(`Test Case '(?:-\\[)?(?:OrbitKitTests\\.)?DshRuntimeTests[ .]${name}\\]?' passed`, 'g'))];
    assert.equal(passed.length, 1, `missing or unmatched OrbitKit scenario: ${name}`);
  }
  const summary = [...output.matchAll(/Executed (\d+) tests?, with (\d+) failures?/g)];
  assert.ok(summary.length > 0, 'missing XCTest summary');
  for (const [, executed, failures] of summary) {
    assert.ok(Number(executed) >= names.length, 'XCTest executed fewer tests than required');
    assert.equal(Number(failures), 0, 'XCTest reported failures');
  }
}

function runAcceptance() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'orbit-dsh-failure-semantics-'));
  let total = 0;
  try {
    // Go: runner classification, completion error and the costUsd wire.
    const goOutput = runLogged('go', ['test', '-json', '-count=1', '-timeout=300s', '-run', goTestPattern(mandatoryGoCases), '.'],
      path.join(scratch, 'runner.json'), { cwd: path.join(root, 'src/runner-go'), timeout: 600_000 });
    assertGoResults(goOutput, mandatoryGoCases);
    total += mandatoryGoCases.length;
    process.stdout.write(`PASS Go: ${mandatoryGoCases.length} named runner scenarios\n`);

    // apiserver on PostgreSQL: the routing report and attempt spend (compiles build/ as it goes).
    const pgLogs = path.join(scratch, 'pg');
    mkdirSync(pgLogs);
    const pgSources = Object.keys(mandatoryPgCases);
    for (const source of pgSources) assert.ok(existsSync(path.join(root, source)), `missing required test source: ${source}`);
    process.stdout.write(runLogged('bash', ['scripts/run-pg-spec.sh', ...pgSources], path.join(scratch, 'postgres.log'), {
      env: { ...process.env, RUN_PG_SPEC_LOG_DIR: pgLogs, RUN_PG_SPEC_TEST_ISOLATION: 'none' }, timeout: 1_200_000,
    }).split('\n').filter((line) => line.startsWith('====') || line.startsWith('==> OK')).join('\n') + '\n');
    pgSources.forEach((source, index) => {
      const log = path.join(pgLogs, `${index + 1}-${path.basename(source, '.ts')}.tap`);
      assert.ok(existsSync(log), `PostgreSQL runner produced no scenario log for ${source}`);
      assertTapResults(readFileSync(log, 'utf8'), mandatoryPgCases[source]);
      total += mandatoryPgCases[source].length;
    });
    process.stdout.write(`PASS apiserver PostgreSQL: ${pgSources.length} specs, every named scenario\n`);

    // apiserver unit: the budget reading.
    for (const [file, names] of Object.entries(mandatoryApiCases)) {
      assert.ok(existsSync(path.join(root, `src/apiserver/src/${file}.spec.ts`)), `missing required test source: ${file}`);
      const compiled = path.join(root, `src/apiserver/build/${file}.spec.js`);
      assert.ok(existsSync(compiled), `missing compiled API tests: ${file}`);
      const tap = runLogged(process.execPath, ['--test', '--test-isolation=none', '--test-reporter=tap', compiled], path.join(scratch, 'api.tap'));
      assertTapResults(tap, names);
      total += names.length;
    }
    process.stdout.write('PASS apiserver unit: attempt budget\n');

    // Web: the client's repair parser.
    const webReport = path.join(scratch, 'vitest.json');
    runLogged(path.join(root, 'node_modules/.bin/vitest'), ['run', mandatoryWebCases.file, '--reporter=json', `--outputFile=${webReport}`],
      path.join(scratch, 'vitest.log'), { cwd: path.join(root, 'src/web') });
    assert.ok(existsSync(webReport), 'Vitest wrote no report');
    assertVitestNamed(JSON.parse(readFileSync(webReport, 'utf8')), mandatoryWebCases.names);
    total += mandatoryWebCases.names.length;
    process.stdout.write(`PASS Web: ${mandatoryWebCases.names.length} named scenarios\n`);

    // OrbitKit in swift:6.1. Its parity tests read web and runner sources, so it gets the whole tree.
    const copy = path.join(scratch, 'tree');
    runLogged('rsync', ['-a', '--exclude', 'node_modules', '--exclude', '.git', '--exclude', 'build', '--exclude', 'dist', '--exclude', '.build',
      `${root}/`, `${copy}/`], path.join(scratch, 'rsync.log'));
    const cache = path.join(tmpdir(), 'orbit-dsh-failure-semantics-swift-build');
    mkdirSync(cache, { recursive: true });
    const swift = runLogged('docker', ['run', '--rm', '--memory=8g', '-v', `${copy}:/w`, '-v', `${cache}:/build`, '-w', '/w/src/macos/OrbitKit',
      'swift:6.1', 'swift', 'test', '--scratch-path', '/build', '--filter', 'DshRuntimeTests'], path.join(scratch, 'swift.log'), { timeout: 1_200_000 });
    assertXCTestNamed(swift, mandatorySwiftCases);
    total += mandatorySwiftCases.length;
    process.stdout.write(`PASS OrbitKit: ${mandatorySwiftCases.length} named scenarios\n`);

    process.stdout.write(`dsh failure-semantics acceptance passed: ${total} named scenarios, none missing or skipped.\n`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runAcceptance();
