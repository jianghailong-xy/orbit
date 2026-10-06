import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, copyFileSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const results = join(root, 'src/web/.ui-migration-results');
const destination = resolve(process.argv[2] || '');
if (!process.argv[2] || existsSync(destination)) throw Error('Pass a NEW evidence directory; existing evidence is never overwritten.');
const report = JSON.parse(readFileSync(join(results, 'report.json')));
if (report.stats.unexpected || report.errors.length) throw Error('Unexpected browser failures must be resolved before collecting a passing run.');
mkdirSync(destination, { recursive: true });
copyFileSync(join(results, 'environment.json'), join(destination, 'environment.json'));
copyFileSync(join(results, 'report.json'), join(destination, 'report.json'));
const tests = [];
function visit(suite) {
  for (const spec of suite.specs || []) for (const test of spec.tests) {
    const name = `${test.projectName}--${spec.title}`.replace(/[^a-zA-Z0-9.-]+/g, '-');
    const artifacts = [];
    for (const attachment of test.results.flatMap((result) => result.attachments)) {
      if (!['application/json', 'text/markdown'].includes(attachment.contentType)) continue;
      const file = `${name}--${attachment.name}.${attachment.contentType === 'application/json' ? 'json' : 'md'}`;
      writeFileSync(join(destination, file), attachment.path ? readFileSync(attachment.path) : Buffer.from(attachment.body, 'base64'));
      artifacts.push(file);
    }
    tests.push({ name, expectedStatus: test.expectedStatus, status: test.status, results: test.results.map(({ status, duration }) => ({ status, duration })), artifacts });
  }
  for (const child of suite.suites || []) visit(child);
}
report.suites.forEach(visit);
const screenshots = join(root, 'docs/evidence/base-ui-migration/p0.2/screenshots');
const images = readdirSync(screenshots, { recursive: true }).filter((file) => file.endsWith('.png')).sort().map((file) => ({
  path: relative(root, join(screenshots, file)), sha256: createHash('sha256').update(readFileSync(join(screenshots, file))).digest('hex'),
}));
const summary = { stats: report.stats, normalPassed: tests.filter((test) => test.expectedStatus === 'passed' && test.status === 'expected').length,
  expectedFailures: tests.filter((test) => test.expectedStatus === 'failed').length, tests, images };
writeFileSync(join(destination, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ destination, normalPassed: summary.normalPassed, expectedFailures: summary.expectedFailures, screenshots: images.length, stats: summary.stats }, null, 2));
