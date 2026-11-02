/**
 * What `file_upload --as test-report` keeps of a test report (docs/orbit-files-design.md §2.5): the numbers a judge
 * needs, as metadata on the file's row, so that they are still there when the report's bytes have expired (§2.8).
 *
 * Two formats are read, told apart by what the file holds and never by its name: Playwright's JSON reporter, and JUnit
 * XML, which vitest, Gradle, Playwright and most other runners write. Anything else is no report here, and the upload
 * goes on as a plain file.
 *
 * Both are counted from their test cases, not from the totals a report states beside them. Those differ by tool (the
 * `<testsuites>` vitest writes says nothing of skipped tests), and a count read off the cases cannot disagree with the
 * names listed under it.
 *
 * A run that failed outside any test has to read as failed. vitest and Gradle report a suite that could not run as a
 * failed test case. Playwright keeps it in the report's top-level `errors`, beside counts that can be all green, so
 * each of those counts here as a failed case too: both formats mean the same thing, and no client has a field to learn.
 *
 * The text is an upload, so it is at most MAX_UPLOAD_BYTES, read whole, on the event loop, and only when a caller asks
 * for it. Measured under load: a real report of that size takes about 150 ms, and 25 MiB built to be the worst case for
 * JSON.parse about 2 s, against 0.4 s for the 10 MB JSON body every route accepts. Nothing here trusts a report's shape:
 * it is the uploader's to write, and whatever it says ends up on a card.
 */

/** The `as` of an upload that asks for this. */
export const TEST_REPORT_UPLOAD = 'test-report';

/** How many names of each kind a summary keeps. It rides on every read of the evidence that cites the file. */
export const MAX_LISTED_CASES = 20;

/** How long a kept name may be. */
export const MAX_CASE_NAME_CHARS = 300;

/** How deep the elements of a JUnit document may nest. Real ones are about five deep. */
const MAX_XML_DEPTH = 64;

export interface TestReportSummary {
  format: 'playwright' | 'junit';
  /** passed + failed + skipped. */
  total: number;
  /** A Playwright test that passed on a retry (`flaky`) passed: the run does not fail for it. */
  passed: number;
  failed: number;
  skipped: number;
  /** How long the run took, as the report says; null when it does not. */
  durationMs: number | null;
  /** In report order and at most MAX_LISTED_CASES, so `failed` may be more. */
  failedNames: string[];
  /** The same for `skipped`: the Evidence files page lists both (§2.6), and has only this once the file has expired. */
  skippedNames: string[];
}

type CaseOutcome = 'passed' | 'failed' | 'skipped';

type CaseCounts = Omit<TestReportSummary, 'format' | 'total' | 'durationMs'>;

function noCases(): CaseCounts {
  return { passed: 0, failed: 0, skipped: 0, failedNames: [], skippedNames: [] };
}

/**
 * A name as a card can show it and Postgres can keep it: one line, without a NUL or a lone surrogate, either of which
 * jsonb refuses, and which would otherwise fail the upload after its bytes were stored. The replacing comes last
 * because cutting can itself split a surrogate pair.
 */
function caseName(raw: string): string {
  const cut = raw.length > MAX_CASE_NAME_CHARS ? `${raw.slice(0, MAX_CASE_NAME_CHARS - 1)}…` : raw;
  return cut.replace(/[\s\p{Cc}\p{Cs}]+/gu, ' ').trim();
}

function count(cases: CaseCounts, outcome: CaseOutcome, name: string): void {
  cases[outcome] += 1;
  if (outcome === 'passed') return;
  const names = outcome === 'failed' ? cases.failedNames : cases.skippedNames;
  if (names.length < MAX_LISTED_CASES) names.push(caseName(name));
}

function summaryOf(format: TestReportSummary['format'], cases: CaseCounts, durationMs: number | null): TestReportSummary {
  return { format, total: cases.passed + cases.failed + cases.skipped, ...cases, durationMs };
}

// ── Playwright's JSON reporter ───────────────────────────────────────────────────────────────────

const PLAYWRIGHT_OUTCOMES = new Map<unknown, CaseOutcome>([
  ['expected', 'passed'],
  ['flaky', 'passed'],
  ['unexpected', 'failed'],
  ['skipped', 'skipped'],
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordsIn(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** The first line of a run error, without the colour codes Playwright writes into it. */
function firstLine(message: unknown): string {
  // eslint-disable-next-line no-control-regex
  return String(message).replace(/\x1b\[[\d;]*m/g, '').trim().split('\n', 1)[0];
}

function readPlaywright(text: string): TestReportSummary | null {
  let report: unknown;
  try {
    report = JSON.parse(text);
  } catch {
    return null;
  }
  const stats = isRecord(report) ? report.stats : null;
  // `expected` and `unexpected` are Playwright's own words: Mocha's report has `stats` too, and no `suites`.
  if (!isRecord(report) || !Array.isArray(report.suites) || !isRecord(stats)) return null;
  if (!['expected', 'unexpected', 'skipped'].every((key) => typeof stats[key] === 'number')) return null;
  const cases = noCases();
  // A stack rather than a recursion, because how deep a report nests is the file's to say. The paths are built by
  // concatenation for the same reason: an array per level costs the square of a depth nothing bounds.
  const suites = recordsIn(report.suites).reverse().map((suite) => ({ suite, path: String(suite.title) }));
  for (let next = suites.pop(); next; next = suites.pop()) {
    const { suite, path } = next;
    for (const spec of recordsIn(suite.specs)) {
      for (const test of recordsIn(spec.tests)) {
        const outcome = PLAYWRIGHT_OUTCOMES.get(test.status);
        if (!outcome) return null;
        count(cases, outcome, `${test.projectName ? `[${String(test.projectName)}] › ` : ''}${path} › ${String(spec.title)}`);
      }
    }
    for (const child of recordsIn(suite.suites).reverse()) {
      suites.push({ suite: child, path: `${path} › ${String(child.title)}` });
    }
  }
  for (const error of recordsIn(report.errors)) count(cases, 'failed', `Run error: ${firstLine(error.message)}`);
  return summaryOf('playwright', cases, typeof stats.duration === 'number' ? Math.round(stats.duration) : null);
}

// ── JUnit XML ────────────────────────────────────────────────────────────────────────────────────

const NO_ATTRIBUTES: ReadonlyMap<string, string> = new Map();

interface XmlTag {
  name: string;
  /** A start tag, or an end tag. An element that closes itself is both, one after the other. */
  opening: boolean;
  /** How many elements are open around this one. */
  depth: number;
  /** The element this one is in, when it is opening. */
  parent: string | undefined;
  attributes: ReadonlyMap<string, string>;
}

/**
 * The tags of an XML document in order, with a null in place of the rest of it once it stops being well formed, which
 * is what a report cut short looks like: the cases it does hold would read as the whole run.
 *
 * Only as much of XML as a report uses. Comments, processing instructions and CDATA are stepped over, so a failure's
 * text that quotes `<testcase>` stays text. A document type is refused rather than skipped: no runner writes one, and
 * refusing it means no entity is ever defined, let alone expanded.
 */
function* xmlTags(xml: string): Generator<XmlTag | null> {
  const elementName = /[^\s/>]+/y;
  const attribute = /\s*([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
  const tagEnd = /\s*(\/?)>/y;
  const open: string[] = [];
  let rootClosed = false;
  let pos = 0;
  for (let lt = xml.indexOf('<'); lt >= 0; lt = xml.indexOf('<', pos)) {
    const next = xml[lt + 1];
    if (next === '?' || xml.startsWith('!--', lt + 1) || xml.startsWith('![CDATA[', lt + 1)) {
      const terminator = next === '?' ? '?>' : xml[lt + 2] === '-' ? '-->' : ']]>';
      const end = xml.indexOf(terminator, lt + 2);
      if (end < 0) break;
      pos = end + terminator.length;
    } else if (next === '!') {
      yield null;
      return;
    } else if (next === '/') {
      const end = xml.indexOf('>', lt);
      const name = open.pop();
      if (end < 0 || name === undefined || xml.slice(lt + 2, end).trimEnd() !== name) {
        yield null;
        return;
      }
      yield { name, opening: false, depth: open.length, parent: undefined, attributes: NO_ATTRIBUTES };
      rootClosed = open.length === 0;
      pos = end + 1;
    } else {
      elementName.lastIndex = lt + 1;
      const name = elementName.exec(xml)?.[0];
      if (name === undefined || rootClosed || open.length === MAX_XML_DEPTH) {
        yield null;
        return;
      }
      const attributes = new Map<string, string>();
      let at = elementName.lastIndex;
      for (;;) {
        attribute.lastIndex = at;
        const found = attribute.exec(xml);
        if (!found) break;
        attributes.set(found[1], found[2] ?? found[3]);
        at = attribute.lastIndex;
      }
      tagEnd.lastIndex = at;
      const end = tagEnd.exec(xml);
      if (!end) {
        yield null;
        return;
      }
      yield { name, opening: true, depth: open.length, parent: open.at(-1), attributes };
      if (end[1]) {
        yield { name, opening: false, depth: open.length, parent: undefined, attributes: NO_ATTRIBUTES };
        rootClosed = open.length === 0;
      } else {
        open.push(name);
      }
      pos = tagEnd.lastIndex;
    }
  }
  if (open.length > 0) yield null;
}

const XML_ENTITIES = new Map([['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"]]);

function decodeXml(value: string): string {
  return value.replace(/&(?:#(\d+)|#x([\dA-Fa-f]+)|(amp|lt|gt|quot|apos));/g, (entity, decimal, hex, name) => {
    if (name) return XML_ENTITIES.get(name as string) as string;
    const code = decimal ? Number(decimal) : parseInt(hex as string, 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

/**
 * `classname › name`, or just `name` where a runner already puts the one in the other. Only as much of each as a kept
 * name can hold is decoded: an entity is at most a few characters long, and an attribute can be the whole upload.
 */
function junitCaseName(attributes: ReadonlyMap<string, string>): string {
  const decoded = (key: string) => decodeXml((attributes.get(key) ?? '').slice(0, MAX_CASE_NAME_CHARS * 10));
  const name = decoded('name');
  const suite = decoded('classname');
  return !suite || name.includes(suite) ? name : `${suite} › ${name}`;
}

function secondsIn(value: string | undefined): number | null {
  const seconds = value?.trim() ? Number(value) : NaN;
  return Number.isFinite(seconds) ? seconds : null;
}

function readJunit(xml: string): TestReportSummary | null {
  const cases = noCases();
  let isReport = false;
  let rootSeconds: number | null = null;
  let suiteSeconds: number | null = null;
  let testCase: { name: string; outcome: CaseOutcome } | null = null;
  for (const tag of xmlTags(xml)) {
    if (!tag) return null;
    if (!tag.opening) {
      if (tag.name === 'testcase' && testCase) {
        count(cases, testCase.outcome, testCase.name);
        testCase = null;
      }
    } else if (tag.depth === 0) {
      if (tag.name !== 'testsuites' && tag.name !== 'testsuite') return null;
      isReport = true;
      rootSeconds = secondsIn(tag.attributes.get('time'));
    } else if (tag.name === 'testcase') {
      testCase = { name: junitCaseName(tag.attributes), outcome: 'passed' };
    } else if (tag.parent === 'testcase' && testCase) {
      if (tag.name === 'failure' || tag.name === 'error') testCase.outcome = 'failed';
      else if (tag.name === 'skipped' && testCase.outcome === 'passed') testCase.outcome = 'skipped';
    } else if (tag.name === 'testsuite' && tag.depth === 1) {
      const seconds = secondsIn(tag.attributes.get('time'));
      if (seconds !== null) suiteSeconds = (suiteSeconds ?? 0) + seconds;
    }
  }
  if (!isReport) return null;
  const seconds = rootSeconds ?? suiteSeconds;
  return summaryOf('junit', cases, seconds === null ? null : Math.round(seconds * 1000));
}

/** A summary as one line: `Playwright · 46 passed · 0 failed · 2 skipped`. */
export function testReportLine(summary: TestReportSummary): string {
  const format = summary.format === 'playwright' ? 'Playwright' : 'JUnit';
  return `${format} · ${summary.passed} passed · ${summary.failed} failed · ${summary.skipped} skipped`;
}

/** What this text says about a test run, or null when it is neither report, or not a whole one. */
export function parseTestReport(text: string): TestReportSummary | null {
  // A byte order mark is whitespace to trimStart.
  const body = text.trimStart();
  if (body.startsWith('{')) return readPlaywright(body);
  if (body.startsWith('<')) return readJunit(body);
  return null;
}
