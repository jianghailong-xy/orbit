import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readWorkflow = (name) => readFileSync(path.join(repo, '.github/workflows', name), 'utf8');
// An override lets the same behavior assertions demonstrate the old unsafe conditions failing.
const apple = process.env.RELEASE_WORKFLOW_PATH
  ? readFileSync(process.env.RELEASE_WORKFLOW_PATH, 'utf8') : readWorkflow('release.yml');
const android = readWorkflow('android-release.yml');
const ci = readWorkflow('android.yml');

// Extract the actual YAML scalars, not a second copy of the predicates. actionlint separately
// validates full YAML / GitHub expression syntax; these tests exercise the supported predicates.
function block(source, key, indent) {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line === `${' '.repeat(indent)}${key}:`);
  assert.notEqual(start, -1, `Missing ${key}`);
  const end = lines.findIndex((line, index) => index > start && line.trim()
    && !line.trimStart().startsWith('#') && line.search(/\S/) <= indent);
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}

function predicate(source, job) {
  const value = block(block(source, 'jobs', 0), job, 2).match(/^    if: (.+)$/m)?.[1];
  assert.ok(value, `Missing ${job} job guard`);
  return value;
}

function evaluate(expression, event, ref, platform = '') {
  // GitHub compares strings and startsWith without case sensitivity. All literals in these
  // guards are lowercase; normalize input strings to preserve that behavior in the test.
  return runInNewContext(expression, {
    github: {
      event_name: event.toLowerCase(), ref: ref.toLowerCase(),
      ref_type: ref.startsWith('refs/tags/') ? 'tag' : 'branch',
    },
    inputs: { platform: platform.toLowerCase() },
    startsWith: (value, prefix) => value.toLowerCase().startsWith(prefix.toLowerCase()),
  }, { timeout: 100 });
}

const scenarios = [
  ['workflow_dispatch', 'refs/heads/main'],
  ['workflow_dispatch', 'refs/tags/v0.1.0'],
  ['push', 'refs/tags/v0.1.0'],
  ['push', 'refs/tags/v0.1.0-beta.1'],
  ['push', 'refs/tags/android-0.1.0'],
  ['push', 'refs/heads/version-update'],
  ['pull_request', 'refs/pull/1/merge'],
  ['pull_request_target', 'refs/heads/main'],
  ['schedule', 'refs/heads/main'],
];
const platforms = ['both', 'macos', 'ios', 'android', 'unknown', '', 'MACOS'];
const dmg = predicate(apple, 'dmg');
const testflight = predicate(apple, 'testflight');
const apk = predicate(android, 'apk');
test('omitted dispatch platform resolves to the workflow default before job selection', () => {
  const defaultPlatform = apple.match(/^        default: (\w+)$/m)?.[1];
  assert.equal(defaultPlatform, 'both');
  assert.equal(evaluate(dmg, 'workflow_dispatch', 'refs/heads/main', defaultPlatform), true);
  assert.equal(evaluate(testflight, 'workflow_dispatch', 'refs/heads/main', defaultPlatform), true);
});
for (const [event, ref] of scenarios) {
  for (const platform of platforms) {
    test(`${event} ${ref} platform=${platform || '(missing)'}`, () => {
      const tagPush = event === 'push' && /^refs\/tags\/v/.test(ref);
      const manual = event === 'workflow_dispatch';
      assert.equal(evaluate(dmg, event, ref, platform), tagPush || (manual
        && ['both', 'macos'].includes(platform.toLowerCase())), 'macOS selection');
      assert.equal(evaluate(testflight, event, ref, platform), tagPush || (manual
        && ['both', 'ios'].includes(platform.toLowerCase())), 'iOS selection');
      assert.equal(evaluate(apk, event, ref, platform), manual, 'separate Android workflow');
    });
  }
}

test('macOS publishing steps require a v* tag push, including when dispatch selects a tag', () => {
  const guards = block(block(apple, 'jobs', 0), 'dmg', 2).matchAll(/^        if: (.+)$/gm);
  const expressions = [...guards].map((match) => match[1]);
  assert.equal(expressions.length, 3, 'Release, appcast generation, and Pages publishing');
  for (const expression of expressions) {
    for (const [event, ref] of scenarios) {
      assert.equal(evaluate(expression, event, ref), event === 'push' && /^refs\/tags\/v/.test(ref),
        `${event} ${ref}`);
    }
  }
});

test('workflow event declarations preserve Apple v* tags and make Android dispatch-only', () => {
  const eventNames = (source) => [...block(source, 'on', 0).matchAll(/^  ([\w_]+):/gm)]
    .map((match) => match[1]).sort();
  assert.deepEqual(eventNames(apple), ['push', 'workflow_dispatch']);
  assert.match(block(block(apple, 'on', 0), 'push', 2), /^    tags: \["v\*"\]$/m);
  assert.match(apple, /^        options: \[both, macos, ios\]$/m);
  assert.deepEqual(eventNames(android), ['workflow_dispatch']);
  assert.deepEqual(eventNames(ci), ['pull_request', 'push', 'workflow_dispatch']);
});

test('Android signing is protected, read-only, and scoped to the build step', () => {
  assert.match(android, /^    environment: android-internal$/m);
  assert.match(block(android, 'permissions', 0), /^  contents: read$/m);
  assert.match(android, /^          persist-credentials: false$/m);
  const signing = android.match(/^      - name: Build and verify signed APK\n([\s\S]*?)(?=^      - )/m)?.[1];
  assert.ok(signing);
  const references = (source) => source.match(/\$\{\{ secrets\.[A-Z_0-9]+ \}\}/g) ?? [];
  assert.equal(references(signing).length, 4);
  assert.deepEqual(references(android), references(signing));
  assert.match(signing, /^          ORBIT_ANDROID_SIGNING_PURPOSE: release$/m);
  assert.match(signing, /trap 'rm -f "\$ORBIT_ANDROID_KEYSTORE_PATH"' EXIT/);
  assert.match(android, /- name: Remove signing material\n        if: always\(\)/);
  assert.doesNotMatch(android, /contents: write|gh release|testflight|xcodebuild|fastlane|google-play/i);
  assert.match(android, /path: \$\{\{ runner.temp \}\}\/android-internal-apk/);
});

test('ordinary Android PR verification never receives release signing secrets', () => {
  assert.doesNotMatch(ci, /\$\{\{ secrets\.|environment:|build-release\.sh|assembleRelease|bundleRelease/);
  assert.match(ci, /bash src\/android\/scripts\/verify\.sh/);
  assert.match(ci, /node --test scripts\/ci\/release-workflows\.test\.mjs/);
});
