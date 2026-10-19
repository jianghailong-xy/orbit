import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workflowDir = path.join(repo, '.github/workflows');
const readWorkflow = (name) => readFileSync(path.join(workflowDir, name), 'utf8');
// An override lets the same behavior assertions demonstrate the old unsafe conditions failing.
const release = process.env.RELEASE_WORKFLOW_PATH
  ? readFileSync(process.env.RELEASE_WORKFLOW_PATH, 'utf8') : readWorkflow('release.yml');
const ci = readWorkflow('android.yml');
const workflows = Object.fromEntries(readdirSync(workflowDir).filter((name) => /\.ya?ml$/.test(name))
  .map((name) => [name, name === 'release.yml' ? release : readWorkflow(name)]));

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

const jobs = block(release, 'jobs', 0);
const job = (name) => block(jobs, name, 2);
const jobNames = [...jobs.matchAll(/^  ([\w-]+):$/gm)].map((match) => match[1]);

function predicate(name) {
  const value = job(name).match(/^    if: (.+)$/m)?.[1];
  assert.ok(value, `Missing ${name} job guard`);
  return value;
}

function needsOf(name) {
  const value = job(name).match(/^    needs: (.+)$/m)?.[1];
  if (!value) return [];
  return value.startsWith('[') ? value.slice(1, -1).split(',').map((item) => item.trim()) : [value.trim()];
}

/** A step of a job by its name, up to the next step. */
function step(jobName, stepName) {
  const source = job(jobName);
  const start = source.indexOf(`      - name: ${stepName}\n`);
  assert.notEqual(start, -1, `${jobName}: missing step ${stepName}`);
  const next = source.indexOf('\n      - ', start + 1);
  return source.slice(start, next < 0 ? undefined : next);
}

function evaluate(expression, event, ref, platform = '', outputs = {}) {
  // GitHub compares strings and startsWith without case sensitivity. All literals in these
  // guards are lowercase; normalize input strings to preserve that behavior in the test.
  // needs.<job>.outputs.<name> becomes a property read (job ids contain '-').
  // The timeout only stops a runaway expression; a loaded host can stall a call past 100 ms.
  const source = expression.replace(/\bneeds\.([\w-]+)\.outputs\.(\w+)/g,
    (_, jobName, name) => `needs[${JSON.stringify(jobName)}].outputs.${name}`);
  const needs = Object.fromEntries(Object.entries(outputs).map(([name, values]) => [name, { outputs: values }]));
  return runInNewContext(source, {
    github: {
      event_name: event.toLowerCase(), ref: ref.toLowerCase(),
      ref_type: ref.startsWith('refs/tags/') ? 'tag' : 'branch',
    },
    inputs: { platform: platform.toLowerCase() },
    needs,
    startsWith: (value, prefix) => value.toLowerCase().startsWith(prefix.toLowerCase()),
  }, { timeout: 5000 });
}

/**
 * Which jobs a run of release.yml performs: a job's guard holds and every job it needs ran and
 * succeeded (an `if` without a status function implies success()). `failed` jobs ran but failed.
 */
function selection(event, ref, platform, { skip = 'false', failed = [] } = {}) {
  const ran = new Map();
  const runs = (name) => {
    if (!ran.has(name)) {
      ran.set(name, needsOf(name).every((need) => runs(need) && !failed.includes(need))
        && evaluate(predicate(name), event, ref, platform, { 'android-build': { skip } }));
    }
    return ran.get(name);
  };
  return Object.fromEntries(jobNames.map((name) => [name, runs(name)]));
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

const started = (ref) => Object.entries(workflows).filter(([name, source]) => pushStarts(triggers(source, name), ref))
  .map(([name]) => name);

const appleTooling = /runs-on:\s*macos|xcodebuild|xcrun|notarytool|testflight|fastlane|altool|codesign|create-dmg|xcodegen|security |appcast/i;
const androidJobs = ['android-build', 'android-publish'];

const scenarios = [
  ['workflow_dispatch', 'refs/heads/main'],
  ['workflow_dispatch', 'refs/tags/v0.1.0'],
  ['workflow_dispatch', 'refs/tags/android-v0.1.0'],
  ['push', 'refs/tags/v0.1.0'],
  ['push', 'refs/tags/v0.1.2-beta.195'],
  ['push', 'refs/tags/android-0.1.0'],
  ['push', 'refs/tags/android-v0.1.0'],
  ['push', 'refs/tags/android-v0.1.2-beta.195'],
  ['push', 'refs/heads/main'],
  ['push', 'refs/heads/version-update'],
  ['push', 'refs/heads/v0.1.0'],
  ['push', 'refs/heads/android-v0.1.0'],
  ['pull_request', 'refs/pull/1/merge'],
  ['pull_request_target', 'refs/heads/main'],
  ['schedule', 'refs/heads/main'],
];
const platforms = ['both', 'macos', 'ios', 'android', 'unknown', '', 'MACOS'];

test('release.yml holds the two Apple jobs and the two Android jobs, publishing after both builds', () => {
  assert.deepEqual(jobNames, ['dmg', 'testflight', 'android-build', 'android-publish']);
  assert.deepEqual(needsOf('dmg'), []);
  assert.deepEqual(needsOf('testflight'), []);
  assert.deepEqual(needsOf('android-build'), []);
  assert.deepEqual(needsOf('android-publish').sort(), ['android-build', 'dmg']);
});

test('omitted dispatch platform resolves to the workflow default before job selection', () => {
  const defaultPlatform = release.match(/^        default: (\w+)$/m)?.[1];
  assert.equal(defaultPlatform, 'both');
  assert.deepEqual(selection('workflow_dispatch', 'refs/heads/main', defaultPlatform),
    { dmg: true, testflight: true, 'android-build': false, 'android-publish': false });
});

for (const [event, ref] of scenarios) {
  for (const platform of platforms) {
    test(`${event} ${ref} platform=${platform || '(missing)'}`, () => {
      const tagPush = event === 'push' && /^refs\/tags\/v/.test(ref);
      const manual = event === 'workflow_dispatch';
      assert.deepEqual(selection(event, ref, platform), {
        dmg: tagPush || (manual && ['both', 'macos'].includes(platform.toLowerCase())),
        testflight: tagPush || (manual && ['both', 'ios'].includes(platform.toLowerCase())),
        'android-build': tagPush,
        'android-publish': tagPush,
      });
    });
  }
}

test('a v* tag push runs all four jobs; Android publishing waits for dmg and the Android build', () => {
  for (const ref of ['refs/tags/v0.1.0', 'refs/tags/v0.1.2-beta.195']) {
    assert.deepEqual(selection('push', ref, ''),
      { dmg: true, testflight: true, 'android-build': true, 'android-publish': true }, ref);
    // A failed DMG leaves Android unpublished (Re-run failed jobs publishes it once dmg is fixed);
    // a failed TestFlight upload does not hold it back.
    assert.equal(selection('push', ref, '', { failed: ['dmg'] })['android-publish'], false);
    assert.equal(selection('push', ref, '', { failed: ['android-build'] })['android-publish'], false);
    assert.equal(selection('push', ref, '', { failed: ['testflight'] })['android-publish'], true);
    // A commit already published by another v* tag: android-build succeeds without building, publish is skipped.
    assert.equal(selection('push', ref, '', { skip: 'true' })['android-publish'], false);
    assert.equal(selection('push', ref, '', { skip: '' })['android-publish'], false, 'a missing output never publishes');
  }
});

test('macOS publishing steps require a v* tag push, including when dispatch selects a tag', () => {
  const guards = job('dmg').matchAll(/^        if: (.+)$/gm);
  const expressions = [...guards].map((match) => match[1]);
  assert.equal(expressions.length, 3, 'Release, appcast generation, and Pages publishing');
  for (const expression of expressions) {
    for (const [event, ref] of scenarios) {
      assert.equal(evaluate(expression, event, ref), event === 'push' && /^refs\/tags\/v/.test(ref),
        `${event} ${ref}`);
    }
  }
});

test('workflow event declarations: one v* tag filter, three dispatch choices, no Android release workflow', () => {
  const eventNames = (source) => [...block(source, 'on', 0).matchAll(/^  ([\w_]+):/gm)]
    .map((match) => match[1]).sort();
  assert.deepEqual(eventNames(release), ['push', 'workflow_dispatch']);
  assert.deepEqual(triggers(release, 'release.yml').push, { tags: ['v*'] });
  assert.match(release, /^        options: \[both, macos, ios\]$/m);
  assert.equal(existsSync(path.join(workflowDir, 'android-release.yml')), false, 'android-v* tags have no workflow');
  assert.deepEqual(eventNames(ci), ['pull_request', 'push', 'workflow_dispatch']);
  // The workflow-wide concurrency stays as it was: one run per ref, a newer push cancels the older.
  assert.match(release, /^concurrency:\n  group: release-\$\{\{ github\.ref \}\}\n  cancel-in-progress: true$/m);
});

test('the filter model matches GitHub for the patterns these workflows use', () => {
  assert.equal(matches(['v*'], 'v0.1.0'), true);
  assert.equal(matches(['v*'], 'android-v0.1.0'), false, 'patterns match the whole tag name');
  assert.equal(matches(['*'], 'feature/a'), false);
  assert.equal(matches(['**'], 'feature/a'), true);
  assert.equal(matches(['**', '!main'], 'main'), false);
  assert.equal(pushStarts({ push: {} }, 'refs/tags/android-v1.0.0'), true, 'an unfiltered push also runs for tags');
  assert.equal(pushStarts({ push: { branches: ['**'] } }, 'refs/tags/android-v1.0.0'), false);
  assert.equal(pushStarts({ push: { tags: ['v*'] } }, 'refs/heads/main'), false);
});

test('a v* tag starts only release.yml; android-v* tags and branch pushes start no release at all', () => {
  for (const ref of ['refs/tags/v0.1.0', 'refs/tags/v0.1.2-beta.195']) {
    assert.deepEqual(started(ref), ['release.yml'], ref);
  }
  for (const ref of ['refs/tags/android-v0.1.0', 'refs/tags/android-v0.1.2-beta.195', 'refs/tags/android-0.1.0']) {
    assert.deepEqual(started(ref), [], `${ref} starts no workflow`);
  }
  for (const ref of ['refs/heads/main', 'refs/heads/v0.1.0', 'refs/heads/android-v0.1.0', 'refs/heads/orbit/a14']) {
    assert.ok(!started(ref).includes('release.yml'), `branch ${ref}`);
  }
});

test('Android signing is confined to the android-build job and its one build step', () => {
  const build = job('android-build');
  const publish = job('android-publish');
  const signing = step('android-build', 'Build and verify signed APK');
  const secrets = (source) => source.match(/\$\{\{ secrets\.[A-Z_0-9]+ \}\}/g) ?? [];
  const androidRefs = /secrets\.ANDROID_|vars\.ANDROID_|environment:\s*android-internal/;
  assert.match(build, /^    environment: android-internal$/m);
  assert.equal([...release.matchAll(/^\s+environment:/gm)].length, 1, 'no other job names an environment');
  assert.deepEqual(secrets(signing).sort(), ['ANDROID_KEYSTORE_BASE64', 'ANDROID_STORE_PASSWORD', 'ANDROID_KEY_ALIAS',
    'ANDROID_KEY_PASSWORD'].map((name) => `\${{ secrets.${name} }}`).sort());
  assert.deepEqual(secrets(build), secrets(signing), 'secrets appear only in the signing step');
  for (const name of ['dmg', 'testflight', 'android-publish']) assert.doesNotMatch(job(name), androidRefs, name);
  assert.match(signing, /^          ORBIT_ANDROID_APPLICATION_ID: \$\{\{ vars\.ANDROID_APPLICATION_ID \}\}$/m);
  assert.match(signing, /^          ORBIT_ANDROID_CERT_SHA256: \$\{\{ vars\.ANDROID_CERT_SHA256 \}\}$/m);
  assert.match(signing, /^          ORBIT_ANDROID_SIGNING_PURPOSE: release$/m);
  // Firebase client values are public configuration: variables, never secrets, never a service account.
  for (const name of ['APP_ID', 'API_KEY', 'PROJECT_ID', 'SENDER_ID', 'ANDROID_PACKAGE']) {
    assert.match(signing, new RegExp(`^          ORBIT_ANDROID_FIREBASE_${name}: \\$\\{\\{ vars\\.ANDROID_FIREBASE_${name} \\}\\}$`, 'm'));
  }
  assert.doesNotMatch(build, /service[_-]?account|GOOGLE_APPLICATION_CREDENTIALS|FIREBASE_TOKEN|private_key/i);
  // The keystore exists only as a private temporary file, removed on exit and again in an always() step.
  assert.match(signing, /umask 077/);
  assert.match(signing, /trap 'rm -f "\$ORBIT_ANDROID_KEYSTORE_PATH"' EXIT/);
  assert.match(step('android-build', 'Remove signing material'), /^        if: always\(\)\n        run: rm -f "\$RUNNER_TEMP\/android-internal-signing\.jks"$/m);
  // Any option cluster with x (set -x, set -eux, set -euxo pipefail) traces commands and their expanded values.
  for (const source of [build, publish]) {
    assert.doesNotMatch(source, /\bset\s+-[A-Za-z]*x|set -o xtrace|bash -[A-Za-z]*x|ACTIONS_STEP_DEBUG|--debug|--info|--scan/,
      'no tracing, Gradle debug logs or build scans');
    assert.doesNotMatch(source, appleTooling);
    // Rehearsal-only knobs: a test signature, a stand-in for GitHub.
    assert.doesNotMatch(source, /--test-signature|SIGNING_PURPOSE: test|ORBIT_ANDROID_UPDATE_API|orbitUpdateApi/);
  }
  assert.equal([...build.matchAll(/^          persist-credentials: false$/gm)].length, 1);
  assert.equal([...publish.matchAll(/^          persist-credentials: false$/gm)].length, 1);
  assert.match(build, /^    permissions:\n      contents: read$/m);
  assert.doesNotMatch(build, /contents: write|gh release/);
  assert.match(build, /path: \$\{\{ runner\.temp \}\}\/android-internal-apk/);
});

test('Android versions come from the tag and the commit count, checked before any secret is read', () => {
  const build = job('android-build');
  const check = step('android-build', 'Check tag, version and release history');
  assert.match(build, /^          fetch-depth: 0 /m, 'the full history makes the commit count');
  assert.match(check, /github-release\.py validate --tag "\$GITHUB_REF_NAME"/);
  assert.match(check, /--version-code "\$\(git rev-list --count HEAD\)" --source-sha "\$\(git rev-parse HEAD\)"/);
  assert.ok(build.indexOf('github-release.py validate') < build.indexOf('secrets.'));
  assert.doesNotMatch(build, /orbitVersionName|orbitVersionCode|gradle\.properties/, 'gradle.properties only sets local defaults');
  const signing = step('android-build', 'Build and verify signed APK');
  assert.match(signing, /^          ORBIT_ANDROID_VERSION_NAME: \$\{\{ steps\.version\.outputs\.version_name \}\}$/m);
  assert.match(signing, /^          ORBIT_ANDROID_VERSION_CODE: \$\{\{ steps\.version\.outputs\.version_code \}\}$/m);
  // After the check, every step but the cleanup runs only when this commit still needs publishing.
  const guarded = build.split('\n      - ').slice(3); // after checkout and the check itself
  for (const source of guarded) {
    assert.match(source, /^        if: (steps\.version\.outputs\.skip == 'false'|always\(\))$/m, source.split('\n')[0]);
  }
  assert.match(build, /^    outputs:\n      skip: \$\{\{ steps\.version\.outputs\.skip \}\}$/m);
});

test('Android publishing attaches to the existing release and never creates, edits or overwrites', () => {
  const publish = job('android-publish');
  assert.match(publish, /^    permissions:\n      contents: write$/m);
  assert.doesNotMatch(publish, /environment:|secrets\./);
  assert.match(publish, /^          name: android-release-\$\{\{ github\.run_id \}\}$/m);
  assert.doesNotMatch(publish, /gh release (create|edit|delete)|--clobber|--prerelease|--latest|--draft/);
  const attach = step('android-publish', 'Attach to the GitHub Release');
  const uploads = [...attach.matchAll(/gh release upload "\$GITHUB_REF_NAME" --repo "\$GITHUB_REPOSITORY" (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(uploads, ['"${pending[@]/#/$out/}"', '"$out/android-update.json"'], 'the manifest goes up last, alone');
  assert.match(attach, /^        if: steps\.manifest\.outputs\.skip == 'false'$/m);
  assert.match(step('android-publish', 'Write update manifest'), /github-release\.py manifest --tag "\$GITHUB_REF_NAME"/);
  assert.match(step('android-publish', 'Verify published assets'), /github-release\.py verify-published/);
});

test('ordinary Android PR verification never receives release signing secrets', () => {
  assert.doesNotMatch(ci, /\$\{\{ secrets\.|environment:|build-release\.sh|assembleRelease|bundleRelease/);
  assert.match(ci, /bash src\/android\/scripts\/verify\.sh/);
  assert.match(ci, /node --test scripts\/ci\/release-workflows\.test\.mjs/);
  for (const [name, source] of Object.entries(workflows)) {
    if (name !== 'release.yml') {
      assert.doesNotMatch(source, /secrets\.ANDROID_|vars\.ANDROID_|environment:\s*android-internal/, name);
    }
  }
});

// ---- github-release.py: the release-history rules, against a stand-in for GitHub -------------------

const script = path.join(repo, 'src/android/scripts/github-release.py');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const commit = (n) => n.toString(16).padStart(40, '0');
const cert = 'ab'.repeat(32);

/** Releases with assets; files by URL path. Serves the list, tags/<tag> and release downloads. */
async function fakeGitHub(build) {
  const files = new Map();
  const list = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const tagged = url.pathname.match(/^\/repos\/o\/r\/releases\/tags\/(.+)$/);
    let body;
    if (url.pathname === '/repos/o/r/releases') body = JSON.stringify(list);
    else if (tagged) {
      const found = list.find((r) => r.tag_name === decodeURIComponent(tagged[1]));
      body = found && JSON.stringify(found);
    } else body = files.get(url.pathname);
    if (body === undefined) { response.writeHead(404).end('{}'); return; }
    response.writeHead(200).end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const github = {
    origin,
    list,
    add(tag, assets, { draft = false } = {}) {
      list.unshift({
        tag_name: tag, draft, prerelease: tag.includes('-'), html_url: `${origin}/o/r/releases/tag/${tag}`,
        assets: Object.entries(assets).map(([name, bytes]) => {
          const urlPath = `/o/r/releases/download/${tag}/${name}`;
          files.set(urlPath, bytes);
          return { name, size: Buffer.byteLength(bytes), browser_download_url: `${origin}${urlPath}`, digest: `sha256:${sha(bytes)}` };
        }),
      });
    },
    apple(tag) { this.add(tag, { [`Orbit-${tag}-arm64.dmg`]: `dmg ${tag}`, [`Orbit-${tag}-arm64.zip`]: `zip ${tag}` }); },
    android(tag, versionCode, sourceSha, options = {}) {
      const manifest = { schemaVersion: 1, tag, applicationId: options.applicationId ?? 'io.orbitd.android',
        versionName: tag.replace(/^(android-)?v/, ''), versionCode, sourceSha };
      this.add(tag, { [`Orbit-${tag}-arm64.dmg`]: 'dmg', 'android-update.json': JSON.stringify(manifest) }, options);
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
  build?.(github);
  return github;
}

function run(args, github, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn('python3', ['-I', script, ...args], {
      env: { PATH: process.env.PATH, GITHUB_API_URL: github.origin, GITHUB_SERVER_URL: github.origin, ...extraEnv },
    });
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    child.on('close', (code) => resolve({ code, output }));
  });
}

async function validate(github, tag, code, source) {
  const dir = mkdtempSync(path.join(tmpdir(), 'a14-validate-'));
  try {
    const result = await run(['validate', '--tag', tag, '--version-code', String(code), '--source-sha', source,
      '--application-id', 'io.orbitd.android', '--repository', 'o/r', '--output', path.join(dir, 'out')], github);
    const out = existsSync(path.join(dir, 'out')) ? readFileSync(path.join(dir, 'out'), 'utf8') : '';
    return { ...result, outputs: Object.fromEntries(out.trim().split('\n').filter(Boolean).map((line) => line.split('='))) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('validate: versionName is the tag without v; versionCode must exceed every published Android release', async () => {
  const github = await fakeGitHub((g) => {
    g.apple('v0.1.2-beta.190');
    g.android('v0.1.2-beta.191', 6100, commit(1));
    g.apple('v0.1.2-beta.192'); // a release whose Android jobs did not publish
    g.android('v0.1.2-beta.193', 9000, commit(2), { draft: true }); // drafts are not published
    g.android('android-v0.1.3', 9100, commit(3)); // the retired tag scheme is no history
    g.android('v0.1.2-beta.194', 9200, commit(4), { applicationId: 'io.orbitd.android.upgradetest' });
  });
  try {
    const ok = await validate(github, 'v0.1.2-beta.195', 6101, commit(5));
    assert.equal(ok.code, 0, ok.output);
    assert.deepEqual(ok.outputs, { skip: 'false', version_name: '0.1.2-beta.195', version_code: '6101' });
    for (const code of [6100, 6000]) {
      const low = await validate(github, 'v0.1.2-beta.195', code, commit(5));
      assert.equal(low.code, 1, `versionCode ${code}`);
      assert.match(low.output, /must be greater than 6100, published with v0\.1\.2-beta\.191/);
      assert.deepEqual(low.outputs, {});
    }
    for (const tag of ['android-v0.1.2', 'v0.1', 'v0.1.2-beta.195-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']) {
      assert.equal((await validate(github, tag, 7000, commit(5))).code, 1, tag);
    }
  } finally { await github.close(); }
});

test('validate: a second v* tag on a published commit skips quietly; any other reuse fails', async () => {
  const github = await fakeGitHub((g) => {
    g.android('v0.1.2-beta.87', 4321, commit(7));
    g.apple('v0.1.2-beta.88');
  });
  try {
    const again = await validate(github, 'v0.1.2-beta.88', 4321, commit(7));
    assert.equal(again.code, 0, again.output);
    assert.deepEqual(again.outputs, { skip: 'true' });
    assert.match(again.output, /already published for Android with v0\.1\.2-beta\.87/);
    // Re-running a published tag is the same commit: quiet as well.
    assert.deepEqual((await validate(github, 'v0.1.2-beta.87', 4321, commit(7))).outputs, { skip: 'true' });
    // A different commit on a tag that already carries Android, or an unreadable manifest, stops the release.
    const moved = await validate(github, 'v0.1.2-beta.87', 4400, commit(8));
    assert.equal(moved.code, 1);
    assert.match(moved.output, /already carries android-update\.json/);
    github.list[0].assets.push({ name: 'android-update.json', size: 2, browser_download_url: `${github.origin}/missing` });
    github.list[0].assets.shift();
    assert.equal((await validate(github, 'v0.1.2-beta.89', 4400, commit(8))).code, 1);
  } finally { await github.close(); }
});

test('manifest: attaches only to the release dmg created, never over android-update.json or a different file', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'a14-manifest-'));
  const apk = Buffer.from('not really an apk, but bytes with a SHA-256');
  writeFileSync(path.join(dir, 'app-release.apk'), apk);
  const identity = { applicationId: 'io.orbitd.android', versionName: '0.1.2-beta.195', versionCode: 6101, minSdk: 29,
    sourceSha: commit(5), apkSha256: sha(apk), certificateSha256: cert, distributionSignature: true };
  writeFileSync(path.join(dir, 'identity.json'), JSON.stringify(identity));
  writeFileSync(path.join(dir, 'notes.txt'), 'Release v0.1.2-beta.195\n\n');
  writeFileSync(path.join(dir, 'empty.txt'), '');
  const github = await fakeGitHub((g) => g.android('v0.1.2-beta.191', 6100, commit(1)));
  let attempt = 0;
  const manifest = (notes = 'notes.txt') => {
    attempt += 1;
    return run(['manifest', '--tag', 'v0.1.2-beta.195', '--repository', 'o/r', '--identity', path.join(dir, 'identity.json'),
      '--apk', path.join(dir, 'app-release.apk'), '--notes-file', path.join(dir, notes), '--output', path.join(dir, `out${attempt}`),
      '--github-output', path.join(dir, `github-output${attempt}`)], github);
  };
  const read = (name) => readFileSync(path.join(dir, `out${attempt}`, name), 'utf8');
  try {
    const missing = await manifest();
    assert.equal(missing.code, 1, 'the macOS job creates the release');
    assert.match(missing.output, /No published release v0\.1\.2-beta\.195/);

    github.apple('v0.1.2-beta.195');
    const first = await manifest();
    assert.equal(first.code, 0, first.output);
    const update = JSON.parse(read('android-update.json'));
    const apkName = 'orbit-android-0.1.2-beta.195.apk';
    assert.deepEqual({ ...update, publishedAt: undefined }, {
      schemaVersion: 1, tag: 'v0.1.2-beta.195', applicationId: 'io.orbitd.android', versionName: '0.1.2-beta.195',
      versionCode: 6101, minSdk: 29, apkName, apkUrl: `${github.origin}/o/r/releases/download/v0.1.2-beta.195/${apkName}`,
      apkSize: apk.length, sha256: sha(apk), certSha256: cert, sourceSha: commit(5), publishedAt: undefined,
      notes: 'Release v0.1.2-beta.195',
    });
    assert.match(update.publishedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.equal(read(`${apkName}.sha256`), `${sha(apk)}  ${apkName}\n`);
    assert.equal(read('pending-assets.txt'), `${apkName}\n${apkName}.sha256\n`);
    assert.equal(readFileSync(path.join(dir, 'github-output2'), 'utf8'), 'skip=false\n');

    // A lightweight tag has no message: the default sentence.
    assert.equal((await manifest('empty.txt')).code, 0);
    assert.equal(JSON.parse(read('android-update.json')).notes, 'Orbit 0.1.2-beta.195 for Android.');

    // An earlier attempt left the same APK and .sha256: nothing to upload again but the manifest.
    const release = github.list.find((r) => r.tag_name === 'v0.1.2-beta.195');
    const attachedApk = { name: apkName, size: apk.length, browser_download_url: `${github.origin}/x`, digest: `sha256:${sha(apk)}` };
    const shaText = `${sha(apk)}  ${apkName}\n`;
    release.assets.push(attachedApk, { name: `${apkName}.sha256`, size: shaText.length, browser_download_url: `${github.origin}/y`, digest: `sha256:${sha(shaText)}` });
    assert.equal((await manifest()).code, 0);
    assert.equal(read('pending-assets.txt'), '');

    // A different file under the APK's name is never overwritten.
    attachedApk.digest = `sha256:${'0'.repeat(64)}`;
    const different = await manifest();
    assert.equal(different.code, 1);
    assert.match(different.output, /already has a different orbit-android-0\.1\.2-beta\.195\.apk/);

    // A release that already carries android-update.json is never published to again.
    release.assets.push({ name: 'android-update.json', size: 2, browser_download_url: `${github.origin}/z`, digest: `sha256:${sha('{}')}` });
    const published = await manifest();
    assert.equal(published.code, 1);
    assert.match(published.output, /v0\.1\.2-beta\.195 already has android-update\.json/);
  } finally {
    await github.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('manifest: refuses a test signature and re-checks the history before attaching', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'a14-manifest-'));
  const apk = Buffer.from('apk bytes');
  writeFileSync(path.join(dir, 'app-release.apk'), apk);
  writeFileSync(path.join(dir, 'notes.txt'), '');
  const identity = { applicationId: 'io.orbitd.android', versionName: '0.1.2-beta.196', versionCode: 6102, minSdk: 29,
    sourceSha: commit(6), apkSha256: sha(apk), certificateSha256: cert, distributionSignature: false };
  const github = await fakeGitHub((g) => g.apple('v0.1.2-beta.196'));
  const manifest = (name) => run(['manifest', '--tag', 'v0.1.2-beta.196', '--repository', 'o/r', '--identity', path.join(dir, 'identity.json'),
    '--apk', path.join(dir, 'app-release.apk'), '--notes-file', path.join(dir, 'notes.txt'), '--output', path.join(dir, name),
    '--github-output', path.join(dir, `${name}.github`)], github);
  try {
    writeFileSync(path.join(dir, 'identity.json'), JSON.stringify(identity));
    const unsigned = await manifest('a');
    assert.equal(unsigned.code, 1);
    assert.match(unsigned.output, /Only a distribution-signed APK can be published/);
    writeFileSync(path.join(dir, 'identity.json'), JSON.stringify({ ...identity, distributionSignature: true }));
    // Another tag of this commit published while this run waited for dmg: skip quietly.
    github.android('v0.1.2-beta.197', 6102, commit(6));
    const raced = await manifest('b');
    assert.equal(raced.code, 0, raced.output);
    assert.equal(readFileSync(path.join(dir, 'b.github'), 'utf8'), 'skip=true\n');
    assert.equal(existsSync(path.join(dir, 'b')), false, 'nothing to upload');
    // A newer build published meanwhile: this one can no longer go out.
    github.list.shift();
    github.android('v0.1.2-beta.198', 6200, commit(9));
    assert.equal((await manifest('c')).code, 1);
  } finally {
    await github.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
