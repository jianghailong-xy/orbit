// node docs/evidence/infrastructure-page/p1/compare.mjs <main.json> <branch.json>
// Compares two vitest JSON reports: which tests fail on each, and which fail on the branch only.
// Exits 1 when the branch has a failure main does not.
import { readFileSync } from 'node:fs';

const [mainPath, branchPath] = process.argv.slice(2);
const load = (p) => JSON.parse(readFileSync(p, 'utf8'));
const rel = (name) => name.replace(/^.*\/src\/web\//, '');
const failing = (report) => [
  ...report.testResults.flatMap((file) =>
    file.assertionResults.filter((a) => a.status === 'failed').map((a) => `${rel(file.name)} > ${a.fullName}`),
  ),
  // A file that failed without a failing test (it did not load, or an error escaped every test).
  ...report.testResults
    .filter((file) => file.status === 'failed' && !file.assertionResults.some((a) => a.status === 'failed'))
    .map((file) => `${rel(file.name)} (file: ${(file.message ?? '').split('\n')[0]})`),
];
const files = (report) => new Set(report.testResults.map((file) => rel(file.name)));

const main = load(mainPath);
const branch = load(branchPath);
for (const [label, r] of [['main  ', main], ['branch', branch]]) {
  console.log(`${label}: ${r.numTotalTestSuites} suites, ${r.numTotalTests} tests, ${r.numPassedTests} passed, ${r.numFailedTests} failed, ${r.numPendingTests} skipped; ${r.testResults.length} files, ${r.numFailedTestSuites} failed suites`);
}
const mainFailing = new Set(failing(main));
const branchFailing = failing(branch);
const onlyBranch = branchFailing.filter((name) => !mainFailing.has(name));
console.log('\nfailing on main:', mainFailing.size ? '' : 'none');
for (const name of mainFailing) console.log('  ' + name);
console.log('failing on branch:', branchFailing.length ? '' : 'none');
for (const name of branchFailing) console.log('  ' + name);
console.log('failing on the branch only (new failures):', onlyBranch.length ? '' : 'none');
for (const name of onlyBranch) console.log('  ' + name);

const mainFiles = files(main);
const branchFiles = files(branch);
console.log('\ntest files only on main:', [...mainFiles].filter((f) => !branchFiles.has(f)).sort());
console.log('test files only on the branch:', [...branchFiles].filter((f) => !mainFiles.has(f)).sort());
process.exit(onlyBranch.length ? 1 : 0);
