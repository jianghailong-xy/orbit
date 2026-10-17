// scripts/retain-runner-release.sh: which runner release a new web image keeps at /dl/previous/,
// from the /dl of the image it replaces — and how the web image and upgrade.sh hand it that /dl.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repo, 'scripts/retain-runner-release.sh');
const PLATFORMS = ['darwin-arm64', 'linux-x64'];

/**
 * A release in dir as scripts/build-binaries.sh leaves one: its .gz assets, and version.json on one
 * line naming each with its sha256 — or, for a build older than asset digests, naming none.
 */
function release(dir, version, { digests = true } = {}) {
  mkdirSync(dir, { recursive: true });
  const assets = {};
  for (const platform of PLATFORMS) {
    const file = `orbit-${platform}.gz`;
    const bytes = Buffer.from(`orbit ${version} for ${platform}\n`);
    writeFileSync(path.join(dir, file), bytes);
    assets[platform] = { file, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  const manifest = { version, capabilityRevision: 2, schemaRevision: 2, contractDigest: 'c0ffee' };
  if (digests) Object.assign(manifest, { assets, runsAssignedRelease: true });
  writeFileSync(path.join(dir, 'version.json'), `${JSON.stringify(manifest)}\n`);
  return dir;
}

/** Builds an image's /dl from `previous` (the replaced image's /dl, or null) and `current`'s release. */
function retain(previous, current) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'retain-runner-release-'));
  const previousDl = path.join(root, 'previous-image/usr/share/nginx/html/dl');
  if (previous) previous(previousDl);
  const dl = release(path.join(root, 'dl'), current);
  const run = spawnSync('sh', [script, previousDl, dl], { encoding: 'utf8' });
  return { run, dl, kept: path.join(dl, 'previous') };
}

/** The version /dl/previous publishes, after checking it holds exactly that release's files. */
function keptVersion(kept, from) {
  if (!existsSync(kept)) return null;
  assert.deepEqual(readdirSync(kept).sort(), readdirSync(from).filter((f) => f !== 'previous').sort());
  for (const file of readdirSync(kept)) {
    assert.ok(readFileSync(path.join(kept, file)).equals(readFileSync(path.join(from, file))), `${file} differs`);
  }
  return JSON.parse(readFileSync(path.join(kept, 'version.json'), 'utf8')).version;
}

test('a version bump keeps the release the replaced image published', () => {
  let from;
  const { run, kept } = retain((dl) => { from = release(dl, '0.1.215'); }, '0.1.216');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(keptVersion(kept, from), '0.1.215');
  assert.match(run.stdout, /publishes 0\.1\.216, and 0\.1\.215 at \/dl\/previous/);
});

test('versions are ordered as numbers, not as text', () => {
  let from;
  const { run, kept } = retain((dl) => { from = release(dl, '0.1.99'); }, '0.1.100');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(keptVersion(kept, from), '0.1.99');
});

test('rebuilding the same version keeps what the replaced image had kept', () => {
  let from;
  const { run, kept } = retain((dl) => {
    release(dl, '0.1.216');
    from = release(path.join(dl, 'previous'), '0.1.215');
  }, '0.1.216');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(keptVersion(kept, from), '0.1.215');
});

test('an older version built over a newer one keeps only a release older than itself', () => {
  let from;
  const older = retain((dl) => {
    release(dl, '0.1.217');
    from = release(path.join(dl, 'previous'), '0.1.215');
  }, '0.1.216');
  assert.equal(older.run.status, 0, older.run.stderr);
  assert.equal(keptVersion(older.kept, from), '0.1.215');

  const none = retain((dl) => {
    release(dl, '0.1.217');
    release(path.join(dl, 'previous'), '0.1.216');
  }, '0.1.216');
  assert.equal(none.run.status, 0, none.run.stderr);
  assert.equal(existsSync(none.kept), false);
});

test('with no image before it, an image keeps nothing and still builds', () => {
  const { run, kept } = retain(null, '0.1.216');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(existsSync(kept), false);
  assert.match(run.stdout, /no release older than 0\.1\.216 to keep/);
});

test('a release whose assets no longer match their sha256, or that names none, is not kept', () => {
  const tampered = retain((dl) => {
    release(dl, '0.1.215');
    writeFileSync(path.join(dl, 'orbit-linux-x64.gz'), 'not the build version.json names\n');
  }, '0.1.216');
  assert.equal(tampered.run.status, 0, tampered.run.stderr);
  assert.equal(existsSync(tampered.kept), false);
  assert.match(tampered.run.stderr, /0\.1\.215's assets do not match its version\.json/);

  const undigested = retain((dl) => { release(dl, '0.1.215', { digests: false }); }, '0.1.216');
  assert.equal(undigested.run.status, 0, undigested.run.stderr);
  assert.equal(existsSync(undigested.kept), false);
  assert.match(undigested.run.stdout, /0\.1\.215 predates asset digests/);
});

test('the web image runs it over the image it replaces, which upgrade.sh names', () => {
  const dockerfile = readFileSync(path.join(repo, 'src/web/Dockerfile'), 'utf8');
  const firstFrom = dockerfile.search(/^FROM /m);
  assert.ok(dockerfile.indexOf('\nARG PREVIOUS_RELEASE_IMAGE=scratch\n') < firstFrom,
    'PREVIOUS_RELEASE_IMAGE must be declared before the first FROM, defaulting to no image');
  assert.match(dockerfile, /^FROM \$\{PREVIOUS_RELEASE_IMAGE\} AS previous-release$/m);
  assert.match(dockerfile, /--mount=type=bind,from=previous-release,target=\/previous-release/);
  assert.match(dockerfile,
    /sh \/tmp\/retain-runner-release\.sh \/previous-release\/usr\/share\/nginx\/html\/dl \/usr\/share\/nginx\/html\/dl$/m);
  // After the release it is kept beside is in place.
  assert.ok(dockerfile.indexOf('COPY --from=binbuild /app/dist-bin /usr/share/nginx/html/dl')
    < dockerfile.indexOf('retain-runner-release.sh /previous-release'));

  const upgrade = readFileSync(path.join(repo, '.claude/skills/upgrade/upgrade.sh'), 'utf8');
  assert.match(upgrade, /docker tag "\$SERVING_WEB_IMAGE" orbit-web:previous-release/);
  const builds = upgrade.split('\n').filter((line) => /\$DC build\b/.test(line));
  assert.ok(builds.length >= 2, 'upgrade.sh no longer builds the images where this test looks');
  for (const line of builds) {
    assert.match(line, /\$\{PREVIOUS_RELEASE_ARG:\+--build-arg "\$PREVIOUS_RELEASE_ARG"\}/, line);
  }
});
