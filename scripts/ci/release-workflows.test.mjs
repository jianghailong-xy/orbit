import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workflowDir = path.join(repo, '.github/workflows');
const readWorkflow = (name) => readFileSync(path.join(workflowDir, name), 'utf8');
// An override lets the same behavior assertions demonstrate the old unsafe conditions failing.
const apple = process.env.RELEASE_WORKFLOW_PATH
  ? readFileSync(process.env.RELEASE_WORKFLOW_PATH, 'utf8') : readWorkflow('release.yml');
const android = readWorkflow('android-release.yml');
const ci = readWorkflow('android.yml');
const workflows = Object.fromEntries(readdirSync(workflowDir).filter((name) => /\.ya?ml$/.test(name))
  .map((name) => [name, name === 'release.yml' ? apple : readWorkflow(name)]));

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

// GitHub's filter pattern cheat sheet: * excludes '/', ** matches anything, ? and + quantify the
// previous character, [] is a class. Patterns are matched against the branch or tag name.
function glob(pattern) {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') { source += '.*'; index += 1; } else source += '[^/]*';
    } else if (char === '?' || char === '+') source += char;
    else if (char === '[') {
      const end = pattern.indexOf(']', index);
      assert.ok(end > index, `Unclosed class in ${pattern}`);
      source += pattern.slice(index, end + 1);
      index = end;
    } else source += char.replace(/[.\\^$|(){}]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

function matches(patterns, name) {
  let selected = false;
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) { if (glob(pattern.slice(1)).test(name)) selected = false; } else if (glob(pattern).test(name)) selected = true;
  }
  return selected;
}

const scalar = (value) => value.replace(/\s+#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2');

/** The `on:` triggers of a workflow in this repository's block style; anything else fails loudly. */
function triggers(source, name) {
  const events = {};
  let event = null;
  let filter = null;
  for (const line of block(source, 'on', 0).split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const indent = line.search(/\S/);
    if (indent === 2) {
      event = line.match(/^  ([a-z_]+):\s*(?:#.*)?$/)?.[1];
      assert.ok(event, `${name}: unsupported event line ${line}`);
      events[event] = {};
      filter = null;
    } else if (indent === 4 && event) {
      const [, key, rest] = line.match(/^    ([a-z_-]+):\s*(.*)$/) ?? [];
      assert.ok(key, `${name}: unsupported filter line ${line}`);
      filter = key;
      const value = scalar(rest);
      events[event][key] = value.startsWith('[')
        ? value.slice(1, -1).split(',').map((item) => scalar(item)).filter(Boolean) : value ? value : [];
    } else if (event && filter && /^\s+- /.test(line)) {
      events[event][filter].push(scalar(line.replace(/^\s+- /, '')));
    } else {
      assert.ok(indent > 4, `${name}: unsupported trigger line ${line}`);
    }
  }
  return events;
}

/** Whether pushing `ref` starts the workflow. paths filters do not apply to tags; for branches the
 * answer is "may run", which is what an isolation check must assume. */
function pushStarts(events, ref) {
  if (!('push' in events)) return false;
  const push = events.push;
  const tag = ref.startsWith('refs/tags/');
  const name = ref.replace(/^refs\/(heads|tags)\//, '');
  const [include, ignore, otherInclude, otherIgnore] = tag
    ? ['tags', 'tags-ignore', 'branches', 'branches-ignore'] : ['branches', 'branches-ignore', 'tags', 'tags-ignore'];
  if (push[include]) return matches(push[include], name);
  if (push[ignore]) return !matches(push[ignore], name);
  return !(push[otherInclude] || push[otherIgnore]);
}

const appleTooling = /runs-on:\s*macos|xcodebuild|xcrun|notarytool|testflight|fastlane|altool|codesign|create-dmg|xcodegen/i;

const scenarios = [
  ['workflow_dispatch', 'refs/heads/main'],
  ['workflow_dispatch', 'refs/tags/v0.1.0'],
  ['workflow_dispatch', 'refs/tags/android-v0.1.0'],
  ['push', 'refs/tags/v0.1.0'],
  ['push', 'refs/tags/v0.1.0-beta.1'],
  ['push', 'refs/tags/android-0.1.0'],
  ['push', 'refs/tags/android-v0.1.0'],
  ['push', 'refs/tags/android-v0.1.0-internal.2'],
  ['push', 'refs/heads/version-update'],
  ['push', 'refs/heads/android-v0.1.0'],
  ['pull_request', 'refs/pull/1/merge'],
  ['pull_request_target', 'refs/heads/main'],
  ['schedule', 'refs/heads/main'],
];
const platforms = ['both', 'macos', 'ios', 'android', 'unknown', '', 'MACOS'];
const dmg = predicate(apple, 'dmg');
const testflight = predicate(apple, 'testflight');
const apk = predicate(android, 'apk');
const publish = predicate(android, 'publish');
const androidTagPush = (event, ref) => event === 'push' && /^refs\/tags\/android-v/.test(ref);
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
      assert.equal(evaluate(apk, event, ref, platform), androidTagPush(event, ref), 'Android signing job');
      assert.equal(evaluate(publish, event, ref, platform), androidTagPush(event, ref), 'Android publishing job');
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

test('workflow event declarations keep Apple on v* tags and Android releases on android-v* tags only', () => {
  const eventNames = (source) => [...block(source, 'on', 0).matchAll(/^  ([\w_]+):/gm)]
    .map((match) => match[1]).sort();
  assert.deepEqual(eventNames(apple), ['push', 'workflow_dispatch']);
  assert.match(block(block(apple, 'on', 0), 'push', 2), /^    tags: \["v\*"\]$/m);
  assert.match(apple, /^        options: \[both, macos, ios\]$/m);
  assert.deepEqual(triggers(android, 'android-release.yml'), { push: { tags: ['android-v*'] } });
  assert.deepEqual(eventNames(ci), ['pull_request', 'push', 'workflow_dispatch']);
});

test('the filter model matches GitHub for the patterns these workflows use', () => {
  assert.equal(matches(['v*'], 'v0.1.0'), true);
  assert.equal(matches(['v*'], 'android-v0.1.0'), false, 'patterns match the whole tag name');
  assert.equal(matches(['android-v*'], 'v0.1.0'), false);
  assert.equal(matches(['android-v*'], 'android-v0.1.0-internal.2'), true);
  assert.equal(matches(['*'], 'feature/a'), false);
  assert.equal(matches(['**'], 'feature/a'), true);
  assert.equal(matches(['**', '!main'], 'main'), false);
  assert.equal(pushStarts({ push: {} }, 'refs/tags/android-v1.0.0'), true, 'an unfiltered push also runs for tags');
  assert.equal(pushStarts({ push: { branches: ['**'] } }, 'refs/tags/android-v1.0.0'), false);
  assert.equal(pushStarts({ push: { tags: ['v*'] } }, 'refs/heads/main'), false);
});

test('an android-v* tag push starts only android-release.yml, and no Apple tooling at all', () => {
  for (const ref of ['refs/tags/android-v0.1.0', 'refs/tags/android-v0.1.0-internal.2', 'refs/tags/android-v1.2.3-rc.1']) {
    const started = Object.entries(workflows).filter(([name, source]) => pushStarts(triggers(source, name), ref))
      .map(([name]) => name);
    assert.deepEqual(started, ['android-release.yml'], ref);
    for (const name of started) assert.doesNotMatch(workflows[name], appleTooling, `${name} on ${ref}`);
  }
  for (const ref of ['refs/tags/v0.1.0', 'refs/tags/v0.1.0-beta.1']) {
    const started = Object.entries(workflows).filter(([name, source]) => pushStarts(triggers(source, name), ref))
      .map(([name]) => name);
    assert.deepEqual(started, ['release.yml'], `${ref} remains the Apple release only`);
  }
  for (const ref of ['refs/heads/main', 'refs/heads/android-v0.1.0', 'refs/heads/orbit/a14']) {
    assert.equal(pushStarts(triggers(android, 'android-release.yml'), ref), false, `branch ${ref}`);
  }
});

test('Android signing is protected, read-only, and scoped to the build step', () => {
  const jobs = block(android, 'jobs', 0);
  const signingJob = block(jobs, 'apk', 2);
  const publishJob = block(jobs, 'publish', 2);
  assert.match(signingJob, /^    environment: android-internal$/m);
  assert.doesNotMatch(signingJob, /^    permissions:/m, 'workflow-level contents: read applies');
  assert.match(block(android, 'permissions', 0), /^  contents: read$/m);
  assert.equal([...android.matchAll(/^          persist-credentials: false$/gm)].length, 2);
  const signing = android.match(/^      - name: Build and verify signed APK\n([\s\S]*?)(?=^      - )/m)?.[1];
  assert.ok(signing);
  const references = (source) => source.match(/\$\{\{ secrets\.[A-Z_0-9]+ \}\}/g) ?? [];
  assert.deepEqual(references(signing).sort(), ['ANDROID_KEYSTORE_BASE64', 'ANDROID_STORE_PASSWORD', 'ANDROID_KEY_ALIAS',
    'ANDROID_KEY_PASSWORD'].map((name) => `\${{ secrets.${name} }}`).sort());
  assert.deepEqual(references(android), references(signing), 'secrets appear only in the signing step');
  assert.match(signing, /^          ORBIT_ANDROID_APPLICATION_ID: \$\{\{ vars\.ANDROID_APPLICATION_ID \}\}$/m);
  assert.match(signing, /^          ORBIT_ANDROID_CERT_SHA256: \$\{\{ vars\.ANDROID_CERT_SHA256 \}\}$/m);
  assert.match(signing, /^          ORBIT_ANDROID_SIGNING_PURPOSE: release$/m);
  assert.match(signing, /umask 077/);
  assert.match(signing, /trap 'rm -f "\$ORBIT_ANDROID_KEYSTORE_PATH"' EXIT/);
  assert.match(android, /- name: Remove signing material\n        if: always\(\)/);
  assert.doesNotMatch(signingJob, /contents: write|gh release/);
  // Any option cluster with x (set -x, set -eux, set -euxo pipefail) traces commands and their expanded values.
  assert.doesNotMatch(android, /\bset\s+-[A-Za-z]*x|set -o xtrace|bash -[A-Za-z]*x|ACTIONS_STEP_DEBUG|--debug|--info|--scan|--test-signature/,
    'no tracing, Gradle debug logs, build scans or rehearsal signatures in the release workflow');
  assert.doesNotMatch(android, appleTooling);
  assert.match(android, /path: \$\{\{ runner.temp \}\}\/android-internal-apk/);
  // The version must come from the tagged commit and be checked before any secret is read.
  assert.ok(signingJob.indexOf('github-release.py validate') < signingJob.indexOf('secrets.'));
  assert.match(signingJob, /orbitVersionName=/);
  assert.match(signingJob, /orbitVersionCode=/);
  // Publishing holds contents: write without the environment or any secret.
  assert.match(publishJob, /^    needs: apk$/m);
  assert.match(publishJob, /^    permissions:\n      contents: write$/m);
  assert.doesNotMatch(publishJob, /environment:|secrets\./);
  assert.match(publishJob, /gh release create "\$RELEASE_TAG" .*--verify-tag --prerelease --latest=false/);
  assert.match(publishJob, /\.apk" "\$out\/orbit-android-\$name\.apk\.sha256" "\$out\/android-update\.json"/);
  assert.match(publishJob, /github-release\.py verify-published/);
});

test('ordinary Android PR verification never receives release signing secrets', () => {
  assert.doesNotMatch(ci, /\$\{\{ secrets\.|environment:|build-release\.sh|assembleRelease|bundleRelease/);
  assert.match(ci, /bash src\/android\/scripts\/verify\.sh/);
  assert.match(ci, /node --test scripts\/ci\/release-workflows\.test\.mjs/);
  for (const [name, source] of Object.entries(workflows)) {
    if (name !== 'android-release.yml') {
      assert.doesNotMatch(source, /secrets\.ANDROID_|vars\.ANDROID_|environment:\s*android-internal/, name);
    }
  }
});
