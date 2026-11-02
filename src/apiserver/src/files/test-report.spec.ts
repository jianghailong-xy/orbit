/**
 * The two report readers of `file_upload --as test-report` (docs/orbit-files-design.md §2.5), against reports real runs
 * wrote. Each file in test-report-samples is one run's output with bodies taken out and nothing else changed: no case
 * was removed and no count edited.
 *
 *   playwright-orbit-web.json  Orbit's own browser suite, 2026-10-03: Playwright 1.63.0, eight projects, 96 tests. Cut
 *                              down from docs/evidence/base-ui-migration/p0.2/diagnostics/initial-browser-report.json.
 *   playwright-retries.json    A menu suite in real Chromium with retries on: failed, flaky, skipped and fixme tests.
 *   playwright-run-error.json  One passing test and a global teardown that threw: the run exited 1.
 *   junit-playwright.xml       The same menu run, from Playwright's JUnit reporter.
 *   junit-vitest.xml           vitest 5: a failed `beforeAll`, a file that does not load, skip and todo.
 *   junit-gradle.xml           Gradle 8.13 on JUnit 4, one `TEST-*.xml`: `@Ignore` and a failed assumption. The JDK's
 *                              stack frames are dropped.
 *
 * The expected numbers were read off these files with Python's json and xml.etree, not with the code under test.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { MAX_CASE_NAME_CHARS, MAX_LISTED_CASES, parseTestReport, testReportLine, type TestReportSummary } from './test-report';

const SAMPLES = path.resolve(__dirname, '../../src/files/test-report-samples');
const sample = (name: string) => readFileSync(path.join(SAMPLES, name), 'utf8');

/** A Playwright report holding `tests`, each `[title, status]`, in one file suite. */
function playwright(tests: [string, string][], rest: Record<string, unknown> = {}): string {
  return JSON.stringify({
    suites: [{ title: 'a.spec.ts', specs: tests.map(([title, status]) => ({ title, tests: [{ projectName: 'p', status }] })) }],
    errors: [],
    stats: { expected: 0, unexpected: 0, skipped: 0 },
    ...rest,
  });
}

test('every sample is small enough to keep in the repository', () => {
  const names = readdirSync(SAMPLES);
  assert.equal(names.length, 6);
  for (const name of names) {
    assert.ok(statSync(path.join(SAMPLES, name)).size <= 50 * 1024, `${name} is over 50 KB`);
  }
});

test("Orbit's own Playwright report reads as the run went", () => {
  const summary = parseTestReport(sample('playwright-orbit-web.json')) as TestReportSummary;
  const { failedNames, skippedNames, ...numbers } = summary;
  assert.deepEqual(numbers, { format: 'playwright', total: 96, passed: 83, failed: 9, skipped: 4, durationMs: 379027 });
  assert.equal(failedNames.length, 9);
  assert.deepEqual(failedNames.slice(0, 2), [
    '[chromium-dark-phone] › pages.browser.mjs › profile',
    '[chromium-light-desktop] › states.browser.mjs › controlled loading › projects loading and release',
  ]);
  assert.equal(failedNames[8], '[webkit-dark-phone] › states.browser.mjs › controlled loading › projects loading and release');
  assert.deepEqual(skippedNames, [
    '[chromium-light-phone] › breakpoints.browser.mjs › both sides of existing 600, 640 and 960px rules',
    '[chromium-dark-phone] › breakpoints.browser.mjs › both sides of existing 600, 640 and 960px rules',
    '[webkit-light-phone] › breakpoints.browser.mjs › both sides of existing 600, 640 and 960px rules',
    '[webkit-dark-phone] › breakpoints.browser.mjs › both sides of existing 600, 640 and 960px rules',
  ]);
});

test('a test that passed on a retry passed, and fixme is skipped', () => {
  assert.deepEqual(parseTestReport(sample('playwright-retries.json')), {
    format: 'playwright',
    total: 14,
    passed: 6,
    failed: 2,
    skipped: 6,
    durationMs: 3121,
    failedNames: [
      '[chromium-light] › menu-keyboard.spec.ts › Menu › keyboard › arrow down moves focus to the next item',
      '[chromium-dark] › menu-keyboard.spec.ts › Menu › keyboard › arrow down moves focus to the next item',
    ],
    skippedNames: [
      '[chromium-light] › menu-keyboard.spec.ts › skipped on this engine',
      '[chromium-dark] › menu-keyboard.spec.ts › skipped on this engine',
      '[chromium-light] › menu-keyboard.spec.ts › Menu › keyboard › type-ahead jumps to a matching item',
      '[chromium-light] › menu-keyboard.spec.ts › Menu › keyboard › home and end jump to the ends of the list',
      '[chromium-dark] › menu-keyboard.spec.ts › Menu › keyboard › type-ahead jumps to a matching item',
      '[chromium-dark] › menu-keyboard.spec.ts › Menu › keyboard › home and end jump to the ends of the list',
    ],
  });
});

test('a Playwright run that failed outside any test does not read as green', () => {
  // Its `stats` say 1 expected and 0 unexpected, and the process exited 1.
  assert.deepEqual(parseTestReport(sample('playwright-run-error.json')), {
    format: 'playwright',
    total: 2,
    passed: 1,
    failed: 1,
    skipped: 0,
    durationMs: 367,
    failedNames: ['Run error: Error: global teardown blew up after the tests'],
    skippedNames: [],
  });
});

test("a run error's colour codes are not part of its name, and only its first line is", () => {
  const message = '\x1b[31mError: no tests found\x1b[39m\n\nsee the config\n';
  const summary = parseTestReport(playwright([], { errors: [{ message }] })) as TestReportSummary;
  assert.deepEqual(summary.failedNames, ['Run error: Error: no tests found']);
});

test("vitest's JUnit report: a suite that could not run counts as failed, and its root says nothing of skipped", () => {
  assert.deepEqual(parseTestReport(sample('junit-vitest.xml')), {
    format: 'junit',
    total: 10,
    passed: 3,
    failed: 3,
    skipped: 4,
    durationMs: 18,
    failedNames: [
      'src/broken-setup.test.mjs › needs a database',
      'src/does-not-load.test.mjs',
      'src/usage.test.mjs › formatting sizes > uses "MB" & <no> space for sizes > 1 MiB',
    ],
    skippedNames: [
      'src/broken-setup.test.mjs › needs a database > reads a row',
      'src/broken-setup.test.mjs › needs a database > writes a row',
      'src/usage.test.mjs › formatting sizes > groups thousands the way 中文 locales do',
      'src/usage.test.mjs › formatting sizes > renders GiB',
    ],
  });
});

test("Playwright's JUnit report: text in CDATA stays text", () => {
  const summary = parseTestReport(sample('junit-playwright.xml')) as TestReportSummary;
  const { failedNames, skippedNames, ...numbers } = summary;
  assert.deepEqual(numbers, { format: 'junit', total: 14, passed: 6, failed: 2, skipped: 6, durationMs: 3121 });
  const failed = 'menu-keyboard.spec.ts › Menu › keyboard › arrow down moves focus to the next item';
  assert.deepEqual(failedNames, [failed, failed]);
  assert.equal(skippedNames.length, 6);
});

test("Gradle's JUnit report: one suite at the root, and a skip however it was asked for", () => {
  assert.deepEqual(parseTestReport(sample('junit-gradle.xml')), {
    format: 'junit',
    total: 6,
    passed: 2,
    failed: 2,
    skipped: 2,
    durationMs: 27,
    failedNames: [
      'io.orbitd.sample.PendingQueueTest › aDecidedRevisionLeavesTheQueue',
      'io.orbitd.sample.PendingQueueTest › anUnexpectedExceptionIsAnError',
    ],
    skippedNames: [
      'io.orbitd.sample.PendingQueueTest › onlyOnTheBigEndian',
      'io.orbitd.sample.PendingQueueTest › theCardShowsTheCount',
    ],
  });
});

test('an <error> is a failure, a failure outranks a skip, and a case with neither passed', () => {
  const summary = parseTestReport(`<testsuite><testcase name="a"><error/></testcase>
    <testcase name="b"><skipped/><failure/></testcase><testcase name="c"><failure/><skipped/></testcase>
    <testcase name="d"/></testsuite>`) as TestReportSummary;
  assert.deepEqual(
    [summary.total, summary.passed, summary.failed, summary.skipped, summary.failedNames],
    [4, 1, 3, 0, ['a', 'b', 'c']],
  );
});

test("only a case's own children decide it, and text that quotes XML stays text", () => {
  const summary = parseTestReport(`<?xml version="1.0"?>
    <!-- <testcase name="in a comment"><failure/></testcase> -->
    <testsuites>
      <testsuite>
        <testcase name='single > quotes'>
          <system-out><failure/></system-out>
          <system-err><![CDATA[</testcase><testcase name="ghost"><failure/></testcase>]]></system-err>
        </testcase>
      </testsuite>
    </testsuites>`) as TestReportSummary;
  assert.deepEqual([summary.total, summary.passed, summary.failed], [1, 1, 0]);
});

test('entities in a name are decoded, and one that means nothing stays as it was written', () => {
  const summary = parseTestReport(`<testsuite>
    <testcase name="a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos; &#20013;&#x6587; &unknown; &#x110000;"><failure/></testcase>
  </testsuite>`) as TestReportSummary;
  assert.deepEqual(summary.failedNames, ['a & b <c> "d" \'e\' 中文 &unknown; &#x110000;']);
});

test('a report with no time has no duration; without a time on the root, its suites add up', () => {
  assert.equal(parseTestReport('<testsuites><testsuite/></testsuites>')?.durationMs, null);
  assert.equal(parseTestReport('<testsuite time="1,234.5"/>')?.durationMs, null);
  assert.equal(parseTestReport(playwright([]))?.durationMs, null);
  const nested = `<testsuites>
    <testsuite time="1.5"><testsuite time="1.5"/></testsuite><testsuite time="0.25"/><testsuite/>
  </testsuites>`;
  assert.equal(parseTestReport(nested)?.durationMs, 1750);
  assert.equal(parseTestReport('<testsuites time="2"><testsuite time="9"/></testsuites>')?.durationMs, 2000);
});

test('a report that ran nothing is a report that says so', () => {
  for (const report of ['<testsuites/>', '<testsuites></testsuites>', playwright([])]) {
    const summary = parseTestReport(report) as TestReportSummary;
    assert.deepEqual([summary.total, summary.passed, summary.failed, summary.skipped], [0, 0, 0, 0]);
  }
});

test('a byte order mark and leading blank lines change nothing', () => {
  const bom = String.fromCharCode(0xfeff);
  assert.equal(parseTestReport(`${bom}\n  <testsuite/>`)?.format, 'junit');
  assert.equal(parseTestReport(`${bom}\n  ${playwright([])}`)?.format, 'playwright');
});

test('what is not one of the two is not a report', () => {
  const others: Record<string, string> = {
    'empty': '',
    'plain text': 'all tests passed\n',
    'a log with a tag in it': 'see <testsuite> below',
    'a JSON list': '[1, 2]',
    'JSON of another shape': '{"a": 1}',
    "vitest's JSON": '{"numTotalTests": 3, "testResults": [], "success": true}',
    "Mocha's JSON, which has stats too": '{"stats": {"tests": 1, "passes": 1}, "tests": [], "failures": []}',
    'stats without Playwright words': '{"suites": [], "stats": {"tests": 1}}',
    'Playwright words without suites': '{"stats": {"expected": 1, "unexpected": 0, "skipped": 0}}',
    'a count that is not a number': '{"suites": [], "stats": {"expected": "1", "unexpected": 0, "skipped": 0}}',
    'an SVG': '<svg xmlns="http://www.w3.org/2000/svg"><testcase name="x"/></svg>',
    'an HTML page': '<!DOCTYPE html><html><body><testsuite/></body></html>',
    'binary bytes': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]).toString('utf8'),
  };
  for (const [what, text] of Object.entries(others)) assert.equal(parseTestReport(text), null, what);
});

test('a report cut short is not read as a whole run', () => {
  for (const name of readdirSync(SAMPLES)) {
    const text = sample(name).trimEnd();
    assert.equal(parseTestReport(text.slice(0, -1)), null, `${name}, one character short`);
    assert.equal(parseTestReport(text.slice(0, Math.floor(text.length / 2))), null, `${name}, half of it`);
  }
  for (const broken of [
    '<testsuite><testcase name="a">',
    '<testsuite><testcase name="a',
    '<testsuite><testcase></testsuite></testcase>',
    '<testsuite><!-- never closed',
    '<testsuite><![CDATA[ never closed',
    '<?xml never closed',
    '<testsuite></testsuite',
    '</testsuite>',
    '<testsuite a=b/>',
    '<testsuite/><testsuite/>',
  ]) {
    assert.equal(parseTestReport(broken), null, broken);
  }
});

test('a status Playwright does not have is no Playwright report', () => {
  assert.equal(parseTestReport(playwright([['a', 'mystery']])), null);
  assert.equal(parseTestReport(playwright([['a', '__proto__']])), null);
});

test('a document type is refused, so no entity is ever expanded', () => {
  const bomb = `<?xml version="1.0"?>
    <!DOCTYPE testsuite [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]>
    <testsuite><testcase name="&b;"/></testsuite>`;
  assert.equal(parseTestReport(bomb), null);
});

test('a kept name is one line of text Postgres can store', () => {
  const nul = String.fromCharCode(0);
  const loneSurrogate = String.fromCharCode(0xd800);
  const summary = parseTestReport(playwright([
    [`a${nul}b`, 'unexpected'],
    [`c${loneSurrogate}d`, 'skipped'],
    ['e\n  f\tg', 'unexpected'],
    ['😀 emoji stays', 'unexpected'],
  ])) as TestReportSummary;
  assert.deepEqual(summary.failedNames, ['[p] › a.spec.ts › a b', '[p] › a.spec.ts › e f g', '[p] › a.spec.ts › 😀 emoji stays']);
  assert.deepEqual(summary.skippedNames, ['[p] › a.spec.ts › c d']);
  assert.equal(parseTestReport('<testsuite><testcase name="a&#0;b&#xD800;c"><failure/></testcase></testsuite>')?.failedNames[0], 'a b c');
});

test('a summary stays small however much the report holds', () => {
  const each = MAX_LISTED_CASES + 5;
  const tests = Array.from({ length: each * 2 }, (_, i): [string, string] => [`case ${i}`, i < each ? 'unexpected' : 'skipped']);
  const summary = parseTestReport(playwright(tests)) as TestReportSummary;
  assert.deepEqual([summary.total, summary.failed, summary.skipped], [each * 2, each, each]);
  assert.equal(summary.failedNames.length, MAX_LISTED_CASES);
  assert.equal(summary.skippedNames.length, MAX_LISTED_CASES);

  const long = parseTestReport(`<testsuite><testcase name="${'x'.repeat(10_000)}"><failure/></testcase></testsuite>`);
  assert.equal(long?.failedNames[0].length, MAX_CASE_NAME_CHARS);
  assert.ok(long?.failedNames[0].endsWith('…'));
  // Cutting inside a surrogate pair leaves half of one, which is as unstorable as any other.
  const cut = parseTestReport(`<testsuite><testcase name="${'x'.repeat(MAX_CASE_NAME_CHARS - 2)}😀"><failure/></testcase></testsuite>`);
  assert.doesNotMatch(cut?.failedNames[0] ?? '', /\p{Cs}/u);
});

test('a summary reads as one line', () => {
  assert.equal(testReportLine(parseTestReport(sample('playwright-orbit-web.json')) as TestReportSummary), 'Playwright · 83 passed · 9 failed · 4 skipped');
  assert.equal(testReportLine(parseTestReport(sample('junit-gradle.xml')) as TestReportSummary), 'JUnit · 2 passed · 2 failed · 2 skipped');
});

test('how deep a report nests cannot overflow the stack', () => {
  const depth = 200_000;
  const deep = `{"suites":${'[{"title":"s","suites":'.repeat(depth)}[]${'}]'.repeat(depth)},"stats":{"expected":0,"unexpected":0,"skipped":0}}`;
  assert.equal(parseTestReport(deep)?.total, 0);
  assert.equal(parseTestReport(`<testsuites>${'<a>'.repeat(depth)}${'</a>'.repeat(depth)}</testsuites>`), null);
});
