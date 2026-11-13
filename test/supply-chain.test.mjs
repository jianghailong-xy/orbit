import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import {
  GITHUB_ACTIONS_BUILD_TYPE, readZipEntry, surfaceOf,
} from '../scripts/supply-chain.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repo, 'scripts/supply-chain.mjs');
const VERSION = '0.1.257-beta.1';
const TAG = `v${VERSION}`;
const SOURCE = '0123456789abcdef0123456789abcdef01234567';
const REPOSITORY = 'jianghailong-xy/orbit';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// A stored (uncompressed) ZIP writer, so the macOS payload tests need no zip tool on the host.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function storedZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(content);
    const nameBytes = Buffer.from(name);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt32LE(0, 10);
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28);
    local.push(header, nameBytes, data);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0, 8);
    directory.writeUInt16LE(0, 10);
    directory.writeUInt32LE(crc32(data), 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(nameBytes.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function infoPlist(version, build) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${build}</string>
</dict></plist>
`;
}

function run(args, options = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: options.cwd ?? repo, encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function writeTree(root, version = VERSION) {
  mkdirSync(path.join(root, 'release-notes'), { recursive: true });
  writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({ name: 'orbit', version })}\n`);
  writeFileSync(path.join(root, 'release-notes', `${version}.md`), `# Orbit ${version}

## Summary

A release.

## Upgrade impact

None.

## Security fixes

None in this release.

## Known limitations

None known.

## Artifacts and verification

The checksums, SBOM and provenance.

## Rollback

The previous tag.
`);
}

/** One representative artifact set, as the release workflow stages it. */
function writeArtifacts(root, { version = VERSION, build = 10729, source = SOURCE } = {}) {
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, `Orbit-v${version}-arm64.dmg`), 'dmg bytes\n');
  writeFileSync(path.join(root, `Orbit-v${version}-arm64.zip`),
    storedZip({ 'Orbit.app/Contents/Info.plist': infoPlist(version, build) }));
  writeFileSync(path.join(root, 'appcast.xml'), '<rss/>\n');
  const apk = Buffer.from('apk bytes\n');
  writeFileSync(path.join(root, `orbit-android-${version}.apk`), apk);
  writeFileSync(path.join(root, 'android-identity.json'), `${JSON.stringify({
    applicationId: 'io.orbitd.app',
    versionName: version,
    versionCode: build,
    apkSha256: sha256(apk),
    certificateSha256: '0'.repeat(64),
    sourceSha: source,
    distributionSignature: true,
  })}\n`);
  const archive = gzipSync(Buffer.from('not really a Go binary, but its bytes are the artifact'));
  writeFileSync(path.join(root, 'orbit-linux-x64.gz'), archive);
  writeFileSync(path.join(root, 'version.json'), `${JSON.stringify({
    version,
    assets: { 'linux-x64': { file: 'orbit-linux-x64.gz', sha256: sha256(archive) } },
    runsAssignedRelease: true,
  })}\n`);
  return root;
}

function fixture(options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'orbit-supply-chain-'));
  const artifacts = writeArtifacts(path.join(root, 'artifacts'), options);
  const tree = path.join(root, 'tree');
  writeTree(tree, options.version ?? VERSION);
  const out = path.join(root, 'out');
  const image = path.join(root, 'apiserver.json');
  writeFileSync(image, `${JSON.stringify({
    name: 'orbit-apiserver',
    reference: 'orbit-apiserver:release',
    id: `sha256:${'a'.repeat(64)}`,
    layers: [`sha256:${'b'.repeat(64)}`],
    size: 123456,
    baseImages: ['node:26-slim'],
  })}\n`);
  return { root, artifacts, tree, out, image, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const generateArgs = (f, extra = []) => [
  'generate', '--version', VERSION, '--tag', TAG, '--source-sha', SOURCE,
  '--repository', REPOSITORY, '--artifacts', f.artifacts, '--out', f.out,
  '--build-number', '10729', '--tree', f.tree,
  '--require-surface', 'macos', '--require-surface', 'runner', ...extra,
];

test('generate writes a bundle that ties version, checksums, SBOM and provenance to one commit', () => {
  const f = fixture();
  try {
    const result = run(generateArgs(f, ['--image', f.image, '--run-id', '4242', '--run-attempt', '1',
      '--started-on', '2026-11-13T10:00:00Z', '--finished-on', '2026-11-13T10:20:00Z']));
    assert.equal(result.status, 0, result.stderr);
    for (const file of ['SHA256SUMS', 'release-manifest.json',
      `orbit-v${VERSION}-sbom.cdx.json`, `orbit-v${VERSION}-provenance.intoto.jsonl`]) {
      assert.ok(existsSync(path.join(f.out, file)), file);
    }
    const manifest = JSON.parse(readFileSync(path.join(f.out, 'release-manifest.json'), 'utf8'));
    assert.equal(manifest.version, VERSION);
    assert.equal(manifest.tag, TAG);
    assert.equal(manifest.prerelease, true);
    assert.equal(manifest.source.commit, SOURCE);
    assert.equal(manifest.source.ref, `refs/tags/${TAG}`);
    assert.equal(manifest.build.kind, 'github-actions');
    assert.equal(manifest.build.builder, `https://github.com/${REPOSITORY}/actions/runs/4242`);
    assert.deepEqual(manifest.artifacts.map((artifact) => artifact.name).sort(), [
      `Orbit-v${VERSION}-arm64.dmg`, `Orbit-v${VERSION}-arm64.zip`, 'android-identity.json',
      'appcast.xml', 'orbit-linux-x64.gz', `orbit-android-${VERSION}.apk`, 'version.json',
    ].sort());
    for (const artifact of manifest.artifacts) {
      const bytes = readFileSync(path.join(f.out, artifact.name));
      assert.equal(artifact.sha256, sha256(bytes), artifact.name);
      assert.equal(artifact.size, bytes.length, artifact.name);
    }
    assert.equal(manifest.images.length, 1);
    assert.equal(manifest.images[0].id, `sha256:${'a'.repeat(64)}`);

    // SHA256SUMS is the release's own statement: every artifact plus the SBOM and provenance.
    const sums = readFileSync(path.join(f.out, 'SHA256SUMS'), 'utf8').trim().split('\n');
    const parsed = new Map(sums.map((line) => {
      const [digest, name] = line.split('  ');
      assert.match(digest, /^[0-9a-f]{64}$/);
      return [name, digest];
    }));
    // SHA256SUMS is the root: it covers the manifest, the SBOM, the provenance and every artifact,
    // and nothing covers SHA256SUMS itself (GitHub's attestation does).
    assert.equal(parsed.size, manifest.artifacts.length + 3);
    for (const artifact of manifest.artifacts) assert.equal(parsed.get(artifact.name), artifact.sha256);
    assert.equal(parsed.get('release-manifest.json'), sha256(readFileSync(path.join(f.out, 'release-manifest.json'))));
    assert.equal(parsed.get(`orbit-v${VERSION}-sbom.cdx.json`), manifest.sbom.sha256);
    assert.equal(parsed.get(`orbit-v${VERSION}-provenance.intoto.jsonl`), manifest.provenance.sha256);

    const sbom = JSON.parse(readFileSync(path.join(f.out, `orbit-v${VERSION}-sbom.cdx.json`), 'utf8'));
    assert.equal(sbom.bomFormat, 'CycloneDX');
    assert.equal(sbom.specVersion, '1.6');
    assert.match(sbom.serialNumber, /^urn:uuid:/);
    assert.equal(sbom.metadata.component.version, VERSION);
    const components = new Map(sbom.components.map((component) => [component['bom-ref'], component]));
    assert.equal(components.get(`file:Orbit-v${VERSION}-arm64.zip`).hashes[0].content,
      manifest.artifacts.find((artifact) => artifact.name === `Orbit-v${VERSION}-arm64.zip`).sha256);
    assert.equal(components.get('urn:orbit:image:orbit-apiserver').properties
      .find((property) => property.name === 'orbit:base-image').value, 'node:26-slim');

    const provenance = JSON.parse(readFileSync(path.join(f.out, `orbit-v${VERSION}-provenance.intoto.jsonl`), 'utf8'));
    assert.equal(provenance._type, 'https://in-toto.io/Statement/v1');
    assert.equal(provenance.predicateType, 'https://slsa.dev/provenance/v1');
    assert.equal(provenance.predicate.buildDefinition.buildType, GITHUB_ACTIONS_BUILD_TYPE);
    assert.equal(provenance.predicate.buildDefinition.externalParameters.workflow.ref, `refs/tags/${TAG}`);
    assert.equal(provenance.predicate.buildDefinition.externalParameters.workflow
      .repository, `https://github.com/${REPOSITORY}`);
    assert.equal(provenance.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit, SOURCE);
    assert.equal(provenance.subject.length, manifest.artifacts.length);
    for (const subject of provenance.subject) {
      assert.equal(subject.digest.sha256, manifest.artifacts.find((artifact) => artifact.name === subject.name).sha256);
    }

    const verified = run(['verify', '--dir', f.out, '--tag', TAG, '--repository', REPOSITORY,
      '--source-sha', SOURCE, '--tree', f.tree, '--require-ci']);
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /release identity, checksums, SBOM and provenance agree/);
  } finally {
    f.cleanup();
  }
});

test('verify refuses a byte that changed after the bundle was written', () => {
  const f = fixture();
  try {
    assert.equal(run(generateArgs(f)).status, 0);
    writeFileSync(path.join(f.out, `Orbit-v${VERSION}-arm64.dmg`), 'other bytes\n');
    const verified = run(['verify', '--dir', f.out]);
    assert.equal(verified.status, 1);
    assert.match(verified.stderr, /hashes to .*, the manifest says/);
  } finally {
    f.cleanup();
  }
});

test('verify refuses a file the release carries but the manifest does not claim', () => {
  const f = fixture();
  try {
    assert.equal(run(generateArgs(f)).status, 0);
    writeFileSync(path.join(f.out, 'unclaimed.bin'), 'extra');
    const verified = run(['verify', '--dir', f.out]);
    assert.equal(verified.status, 1);
    assert.match(verified.stderr, /unclaimed\.bin is in the release directory but no manifest lists it/);
  } finally {
    f.cleanup();
  }
});

test('verify refuses a missing SBOM and a rewritten SBOM', () => {
  const f = fixture();
  try {
    assert.equal(run(generateArgs(f)).status, 0);
    const sbomFile = path.join(f.out, `orbit-v${VERSION}-sbom.cdx.json`);
    const sbom = JSON.parse(readFileSync(sbomFile, 'utf8'));
    sbom.components.find((component) => component['bom-ref'] === `file:Orbit-v${VERSION}-arm64.dmg`)
      .hashes[0].content = '0'.repeat(64);
    writeFileSync(sbomFile, `${JSON.stringify(sbom)}\n`);
    const verified = run(['verify', '--dir', f.out]);
    assert.equal(verified.status, 1);
    assert.match(verified.stderr, /the sbom file does not hash to what the manifest records/);
  } finally {
    f.cleanup();
  }
});

test('verify refuses a tag or source commit other than the ones the bundle names', () => {
  const f = fixture();
  try {
    assert.equal(run(generateArgs(f)).status, 0);
    const wrongTag = run(['verify', '--dir', f.out, '--tag', 'v0.1.256']);
    assert.equal(wrongTag.status, 1);
    assert.match(wrongTag.stderr, /the manifest names v0\.1\.257-beta\.1, not v0\.1\.256/);
    const wrongSource = run(['verify', '--dir', f.out, '--source-sha', 'f'.repeat(40)]);
    assert.equal(wrongSource.status, 1);
    assert.match(wrongSource.stderr, /the manifest names source/);
  } finally {
    f.cleanup();
  }
});

test('a local dry-run says it is one, and a CI-required verification refuses it', () => {
  const f = fixture();
  try {
    const generated = run([
      'generate', '--version', VERSION, '--tag', TAG, '--source-sha', SOURCE,
      '--repository', REPOSITORY, '--artifacts', f.artifacts, '--out', f.out, '--tree', f.tree,
    ]);
    assert.equal(generated.status, 0, generated.stderr);
    const manifest = JSON.parse(readFileSync(path.join(f.out, 'release-manifest.json'), 'utf8'));
    assert.equal(manifest.build.kind, 'local-dry-run');
    assert.equal(run(['verify', '--dir', f.out]).status, 0);
    const ci = run(['verify', '--dir', f.out, '--require-ci']);
    assert.equal(ci.status, 1);
    assert.match(ci.stderr, /the provenance builder is .* not this release's run/);
  } finally {
    f.cleanup();
  }
});

test('generation refuses version evidence that disagrees with the tag', () => {
  {
    const root = mkdtempSync(path.join(tmpdir(), 'orbit-supply-chain-'));
    try {
      const artifacts = writeArtifacts(path.join(root, 'artifacts'));
      writeFileSync(path.join(artifacts, `Orbit-v${VERSION}-arm64.zip`),
        storedZip({ 'Orbit.app/Contents/Info.plist': infoPlist('0.1.256', '10729') }));
      const result = run(['generate', '--version', VERSION, '--tag', TAG, '--source-sha', SOURCE,
        '--repository', REPOSITORY, '--artifacts', artifacts, '--out', path.join(root, 'out')]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /CFBundleShortVersionString "0\.1\.256", not 0\.1\.257-beta\.1/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  {
    const f = fixture();
    try {
      writeFileSync(path.join(f.artifacts, 'version.json'), `${JSON.stringify({
        version: VERSION,
        assets: { 'linux-x64': { file: 'orbit-linux-x64.gz', sha256: '1'.repeat(64) } },
      })}\n`);
      const result = run(generateArgs(f));
      assert.equal(result.status, 1);
      assert.match(result.stderr, /version\.json names .* for orbit-linux-x64\.gz, but its bytes hash to/);
    } finally {
      f.cleanup();
    }
  }
  {
    const f = fixture();
    try {
      const identity = JSON.parse(readFileSync(path.join(f.artifacts, 'android-identity.json'), 'utf8'));
      identity.apkSha256 = '2'.repeat(64);
      writeFileSync(path.join(f.artifacts, 'android-identity.json'), `${JSON.stringify(identity)}\n`);
      const result = run(generateArgs(f));
      assert.equal(result.status, 1);
      assert.match(result.stderr, /android-identity\.json does not name the APK it was built with/);
    } finally {
      f.cleanup();
    }
  }
  {
    const f = fixture();
    try {
      const identity = JSON.parse(readFileSync(path.join(f.artifacts, 'android-identity.json'), 'utf8'));
      identity.versionCode = 10728;
      writeFileSync(path.join(f.artifacts, 'android-identity.json'), `${JSON.stringify(identity)}\n`);
      const result = run(generateArgs(f));
      assert.equal(result.status, 1);
      assert.match(result.stderr, /versionCode 10728, not 10729/);
    } finally {
      f.cleanup();
    }
  }
});

test('generation refuses a checkout whose package version or notes are another release', () => {
  const f = fixture();
  try {
    writeTree(f.tree, '0.1.256');
    const result = run(generateArgs(f));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /package\.json names "0\.1\.256", not 0\.1\.257-beta\.1/);
  } finally {
    f.cleanup();
  }
  const g = fixture();
  try {
    writeFileSync(path.join(g.tree, 'release-notes', `${VERSION}.md`), `# Orbit ${VERSION}\n\n## Summary\n\nTODO\n`);
    const result = run(generateArgs(g));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /the section "## Upgrade impact" is missing/);
  } finally {
    g.cleanup();
  }
});

test('generation refuses to publish a bundle that omits a surface the release requires', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'orbit-supply-chain-'));
  try {
    const artifacts = path.join(root, 'artifacts');
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(path.join(artifacts, `Orbit-v${VERSION}-arm64.dmg`), 'dmg bytes\n');
    const result = run(['generate', '--version', VERSION, '--tag', TAG, '--source-sha', SOURCE,
      '--repository', REPOSITORY, '--artifacts', artifacts, '--out', path.join(root, 'out'),
      '--require-surface', 'macos', '--require-surface', 'runner']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /the artifact set has no runner surface, which the release requires/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an image descriptor has to name a sha256 config digest', () => {
  const f = fixture();
  try {
    writeFileSync(f.image, `${JSON.stringify({
      name: 'orbit-apiserver', reference: 'orbit-apiserver:release', id: 'not-a-digest', layers: [], size: 12,
    })}\n`);
    const result = run(generateArgs(f, ['--image', f.image]));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /id must be a sha256: config digest/);
  } finally {
    f.cleanup();
  }
});

test('known late release assets are checked against the APK, and nothing else is excused', () => {
  const f = fixture();
  try {
    assert.equal(run(generateArgs(f)).status, 0);
    const apk = path.join(f.out, `orbit-android-${VERSION}.apk`);
    const apkSha = sha256(readFileSync(apk));
    writeFileSync(path.join(f.out, `orbit-android-${VERSION}.apk.sha256`), `${apkSha}  orbit-android-${VERSION}.apk\n`);
    writeFileSync(path.join(f.out, 'android-update.json'), `${JSON.stringify({
      tag: TAG, versionName: VERSION, apkName: `orbit-android-${VERSION}.apk`, sha256: apkSha,
    })}\n`);
    assert.equal(run(['verify', '--dir', f.out]).status, 0);
    writeFileSync(path.join(f.out, 'android-update.json'), `${JSON.stringify({
      tag: TAG, versionName: VERSION, apkName: `orbit-android-${VERSION}.apk`, sha256: '3'.repeat(64),
    })}\n`);
    const result = run(['verify', '--dir', f.out]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /android-update\.json does not name the APK this release carries/);
  } finally {
    f.cleanup();
  }
});

test('surface names follow the artifact names the release publishes', () => {
  assert.equal(surfaceOf(`Orbit-v${VERSION}-arm64.dmg`), 'macos');
  assert.equal(surfaceOf(`Orbit-v${VERSION}-arm64.zip`), 'macos');
  assert.equal(surfaceOf('orbit-darwin-arm64.gz'), 'runner');
  assert.equal(surfaceOf('version.json'), 'runner');
  assert.equal(surfaceOf(`orbit-android-${VERSION}.apk`), 'android');
  assert.equal(surfaceOf(`orbit-android-${VERSION}.apk.sha256`), 'android');
  assert.equal(surfaceOf('appcast.xml'), 'sparkle-appcast');
  assert.equal(surfaceOf('notes.txt'), 'other');
});

test('readZipEntry reads a stored entry and reports a missing one as null', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'orbit-zip-'));
  try {
    const file = path.join(root, 'payload.zip');
    writeFileSync(file, storedZip({ 'Orbit.app/Contents/Info.plist': infoPlist(VERSION, '1'), 'other.txt': 'x' }));
    assert.equal(readZipEntry(file, 'Orbit.app/Contents/Info.plist').toString(), infoPlist(VERSION, '1'));
    assert.equal(readZipEntry(file, 'missing.txt'), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
