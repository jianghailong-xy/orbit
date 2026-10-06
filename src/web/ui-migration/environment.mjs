import { createHash } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
export default function environment() {
  const fontFiles = [...new Set(execFileSync('fc-list', ['--format', '%{file}\n'], { encoding: 'utf8' }).trim().split('\n'))].sort();
  const actual = {
    platform: process.platform, arch: process.arch,
    os: readFileSync('/etc/os-release', 'utf8'),
    playwright: require('@playwright/test/package.json').version,
    browsers: JSON.parse(readFileSync(require.resolve('playwright-core/package.json').replace('package.json', 'browsers.json'))).browsers,
    fonts: fontFiles.map((path) => ({ path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') })),
  };
  const output = fileURLToPath(new URL('../.ui-migration-results/', import.meta.url));
  mkdirSync(output, { recursive: true });
  writeFileSync(`${output}/environment.json`, JSON.stringify(actual, null, 2) + '\n');
  const reference = fileURLToPath(new URL('../../../docs/evidence/base-ui-migration/p0.2/environment.json', import.meta.url));
  if (existsSync(reference)) {
    assert.deepEqual(actual, JSON.parse(readFileSync(reference)), 'Browser/OS/fonts differ from the recorded baseline. Reproduce its environment; do not overwrite screenshots to hide a mismatch.');
  }
}
