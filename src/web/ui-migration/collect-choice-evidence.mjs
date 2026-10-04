import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const source = process.argv.find((arg) => arg.startsWith('--from='))?.slice('--from='.length);
const results = source ? resolve(source) : join(root, 'src/web/.choices-results');
const destination = resolve(process.argv[2] || '');
if (!process.argv[2] || existsSync(destination)) throw Error('Pass a new evidence directory; existing evidence is never overwritten.');
const report = JSON.parse(readFileSync(join(results, 'report.json')));
if ((report.stats.unexpected || report.errors.length) && !process.argv.includes('--diagnostic')) throw Error('Resolve unexpected failures before collecting a passing run.');
mkdirSync(destination, { recursive: true });
copyFileSync(join(results, 'report.json'), join(destination, 'report.json'));
copyFileSync(source ? join(results, 'environment.json') : join(root, 'src/web/.ui-migration-results/environment.json'), join(destination, 'environment.json'));
const tests = [];
const occurrences = new Map();
function visit(suite) {
  for (const spec of suite.specs || []) for (const test of spec.tests) {
    const base = `${test.projectName}--${spec.title}`.replace(/[^a-zA-Z0-9.-]+/g, '-');
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    const name = `${base}${occurrence ? `--repeat-${occurrence}` : ''}`;
    const artifacts = [];
    for (const attachment of test.results.flatMap((result) => result.attachments)) {
      const extension = { 'application/json': 'json', 'image/png': 'png', 'text/markdown': 'md', 'application/zip': 'zip' }[attachment.contentType];
      if (!extension) continue;
      const file = `${name}--${attachment.name.replace(/[^a-zA-Z0-9.-]+/g, '-')}.${extension}`;
      const content = attachment.path ? readFileSync(attachment.path) : Buffer.from(attachment.body, 'base64');
      writeFileSync(join(destination, file), content);
      artifacts.push({ file, sha256: createHash('sha256').update(content).digest('hex') });
    }
    tests.push({ name, expectedStatus: test.expectedStatus, status: test.status,
      results: test.results.map(({ status, duration }) => ({ status, duration })), artifacts });
  }
  for (const child of suite.suites || []) visit(child);
}
report.suites.forEach(visit);
const summary = { stats: report.stats, tests };
writeFileSync(join(destination, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ destination, stats: report.stats, artifacts: tests.flatMap((test) => test.artifacts).length }));
