#!/usr/bin/env node
/**
 * One verifiable supply-chain bundle per release.
 *
 * The release workflow builds every artifact, then hands the build directory to `generate`: it writes
 * SHA256SUMS, a CycloneDX SBOM, an in-toto/SLSA provenance statement and a release manifest that ties
 * the tag, the source commit and the build identity to the bytes. `verify` re-reads all four and
 * refuses the release when any of them disagrees with the files it was given; release.yml runs it
 * before anything is published, and anyone can run it on the downloaded release assets.
 *
 *   node scripts/supply-chain.mjs generate --version 0.1.257-beta.1 --tag v0.1.257-beta.1 \
 *     --source-sha <40-hex> --repository jianghailong-xy/orbit --artifacts <dir> --out <dir> \
 *     --run-id <id> --run-attempt 1 --started-on <iso> --finished-on <iso> --tree .
 *   node scripts/supply-chain.mjs verify --dir <release-assets> --tag v0.1.257-beta.1 \
 *     --repository jianghailong-xy/orbit --tree .
 *   node scripts/supply-chain.mjs image-inspect --name orbit-apiserver \
 *     --image orbit-apiserver:release --dockerfile src/apiserver/Dockerfile --out <file>
 *
 * `generate` also checks the version evidence inside the artifacts it can read without the native
 * toolchain: the macOS name and the Info.plist inside the Sparkle zip, the Android update identity and
 * the runner version.json. A mismatch stops the release before it is published. `verify` reports every
 * problem it finds rather than the first one, and exits non-zero when there is any.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { notesProblems, parseReleaseVersion } from './release-identity.mjs';

export const SBOM_SPEC_VERSION = '1.6';
export const SBOM_FORMAT = 'CycloneDX';
export const PROVENANCE_PREDICATE_TYPE = 'https://slsa.dev/provenance/v1';
export const GITHUB_ACTIONS_BUILD_TYPE = 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1';
export const LOCAL_BUILD_TYPE = 'urn:orbit:supply-chain:local-dry-run';
export const MANIFEST_FILE = 'release-manifest.json';
export const SUMS_FILE = 'SHA256SUMS';
export const DEFAULT_WORKFLOW = '.github/workflows/release.yml';
/** Files the Android publishing job adds after this bundle, so a downloaded release can carry them. */
export const KNOWN_RELEASE_EXTRAS = ['android-update.json'];

const HEX64 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const RUN_ID = /^\d+$/;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha256File(file) {
  return sha256(readFileSync(file));
}

export function repositoryUrl(repository) {
  return `https://github.com/${repository}`;
}

export function bundleFileNames(version) {
  return {
    sbom: `orbit-v${version}-sbom.cdx.json`,
    provenance: `orbit-v${version}-provenance.intoto.jsonl`,
    manifest: MANIFEST_FILE,
    sums: SUMS_FILE,
  };
}

/** The release surface an artifact belongs to, from the name the build gives it. */
export function surfaceOf(name) {
  if (/^Orbit-v.+\.(?:dmg|zip)$/.test(name)) return 'macos';
  if (name === 'appcast.xml') return 'sparkle-appcast';
  if (/^orbit-(?:linux|darwin)-(?:x64|arm64)\.gz$/.test(name) || name === 'version.json') return 'runner';
  if (/^orbit-android-.+\.apk$/.test(name) || /^orbit-android-.+\.apk\.sha256$/.test(name)) return 'android';
  if (name === 'android-identity.json') return 'android-identity';
  return 'other';
}

export function isRunnerArchive(name) {
  return /^orbit-(?:linux|darwin)-(?:x64|arm64)\.gz$/.test(name);
}

/** The surfaces a release can promise; `--require-surface` refuses a bundle that silently omits one. */
export const SURFACES = new Set(['macos', 'sparkle-appcast', 'runner', 'android', 'android-identity', 'other']);

/** Every file under a directory, as posix paths relative to it, sorted. */
export function walkFiles(root) {
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(path.relative(root, absolute).split(path.sep).join('/'));
    }
  };
  visit(root);
  return files.sort();
}

/**
 * Copies the built artifacts into one flat directory. Nested build output is flattened and a duplicate
 * name is refused: two files called `version.json` are two different claims about one release.
 */
export function collectArtifacts(sources, out, reserved = new Set()) {
  if (!sources.length) throw new Error('no artifact directory was given');
  mkdirSync(out, { recursive: true });
  const seen = new Map();
  for (const source of sources) {
    if (!existsSync(source) || !statSync(source).isDirectory()) throw new Error(`${source} is not a directory`);
    for (const relative of walkFiles(source)) {
      const name = path.basename(relative);
      if (reserved.has(name)) throw new Error(`artifact ${source}/${relative} collides with a file this bundle generates`);
      if (seen.has(name)) throw new Error(`artifact ${name} appears in both ${seen.get(name)} and ${source}/${relative}`);
      seen.set(name, `${source}/${relative}`);
      copyFileSync(path.join(source, relative), path.join(out, name));
    }
  }
  return [...seen.keys()].sort();
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function readText(file) {
  return readFileSync(file, 'utf8');
}

/** One entry out of a ZIP archive, stored or deflated; null when it carries none. */
export function readZipEntry(file, wanted) {
  const buffer = readFileSync(file);
  let end = -1;
  for (let index = buffer.length - 22; index >= 0 && index >= buffer.length - 22 - 0xffff; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) { end = index; break; }
  }
  if (end < 0) return null;
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) return null;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (name === wanted) {
      if (buffer.readUInt32LE(localOffset) !== 0x04034b50) return null;
      const start = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
      const data = buffer.subarray(start, start + compressedSize);
      if (method === 0) return data;
      return method === 8 ? inflateRawSync(data) : null;
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

function plistValue(plist, key) {
  return new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(plist)?.[1];
}

/** Version evidence the artifact itself carries, checked without the native toolchain. */
export function artifactVersionProblems({ name, version, sourceSha, buildNumber, directory }) {
  const problems = [];
  const macos = /^Orbit-(v.+)-arm64\.(?:dmg|zip)$/.exec(name);
  if (macos && macos[1] !== `v${version}`) {
    problems.push(`${name} names ${macos[1]}, but the release is v${version}`);
  }
  if (/^Orbit-v.+\.zip$/.test(name)) {
    const plist = readZipEntry(path.join(directory, name), 'Orbit.app/Contents/Info.plist');
    if (!plist) {
      problems.push(`${name} is not a readable Sparkle payload with Orbit.app/Contents/Info.plist`);
    } else {
      const text = plist.toString('utf8');
      const shortVersion = plistValue(text, 'CFBundleShortVersionString');
      if (shortVersion !== version) problems.push(`${name} carries CFBundleShortVersionString ${JSON.stringify(shortVersion)}, not ${version}`);
      if (buildNumber !== undefined && plistValue(text, 'CFBundleVersion') !== buildNumber) {
        problems.push(`${name} carries CFBundleVersion ${JSON.stringify(plistValue(text, 'CFBundleVersion'))}, not ${buildNumber}`);
      }
    }
  }
  const android = /^orbit-android-(.+)\.apk$/.exec(name);
  if (android && android[1] !== version) {
    problems.push(`${name} names ${android[1]}, but the release is ${version}`);
  }
  if (name === 'version.json') {
    const manifest = readJson(path.join(directory, name));
    if (manifest.version !== version) problems.push(`version.json names ${JSON.stringify(manifest.version)}, not ${version}`);
    for (const [platform, asset] of Object.entries(manifest.assets ?? {})) {
      if (!asset || typeof asset.file !== 'string' || !HEX64.test(asset.sha256 ?? '')) {
        problems.push(`version.json asset ${platform} does not name a file and a SHA-256`);
        continue;
      }
      const assetPath = path.join(directory, asset.file);
      if (!existsSync(assetPath)) {
        problems.push(`version.json names ${asset.file}, which the release does not carry`);
        continue;
      }
      const actual = sha256File(assetPath);
      if (actual !== asset.sha256) problems.push(`version.json names ${asset.sha256} for ${asset.file}, but its bytes hash to ${actual}`);
    }
  }
  if (name === 'android-identity.json') {
    const identity = readJson(path.join(directory, name));
    if (identity.versionName !== version) problems.push(`android-identity.json names ${JSON.stringify(identity.versionName)}, not ${version}`);
    if (identity.sourceSha !== sourceSha) problems.push(`android-identity.json was built from ${identity.sourceSha}, not ${sourceSha}`);
    if (buildNumber !== undefined && String(identity.versionCode) !== buildNumber) {
      problems.push(`android-identity.json carries versionCode ${identity.versionCode}, not ${buildNumber}`);
    }
    if (identity.distributionSignature !== true) problems.push('android-identity.json is not a distribution signature');
    const apk = path.join(directory, `orbit-android-${version}.apk`);
    if (existsSync(apk) && identity.apkSha256 !== sha256File(apk)) problems.push('android-identity.json does not name the APK it was built with');
  }
  return problems;
}

/** The Go modules linked into each runner binary, from the binary's own build info. */
export function goModulesFor(archives, directory) {
  const modules = new Map();
  for (const name of archives) {
    let binary;
    try {
      binary = gunzipSync(readFileSync(path.join(directory, name)));
    } catch {
      continue;
    }
    const temporary = path.join(tmpdir(), `orbit-buildinfo-${process.pid}-${randomUUID()}`);
    writeFileSync(temporary, binary);
    try {
      const output = execFileSync('go', ['version', '-m', temporary], { encoding: 'utf8' });
      for (const line of output.split('\n')) {
        const match = /^\s*dep\t(\S+)\t(\S+)\t(h1:\S+)?\s*$/.exec(line);
        if (match) modules.set(`${match[1]}@${match[2]}`, { path: match[1], version: match[2], hash: match[3] });
      }
    } catch {
      // No Go toolchain on this host (a public verifier needs none): the binary's modules are then
      // absent from a regenerated SBOM, and `verify` uses the SBOM the release already carries.
    } finally {
      try { unlinkSync(temporary); } catch { /* already gone */ }
    }
  }
  return [...modules.values()].sort((a, b) => a.path.localeCompare(b.path) || a.version.localeCompare(b.version));
}

/** Production packages the service images are built from, from the lockfile both images install. */
export function npmProductionPackages(lockfile) {
  const packages = new Map();
  for (const [key, entry] of Object.entries(lockfile.packages ?? {})) {
    if (!key.startsWith('node_modules/') || entry.dev === true || entry.link === true) continue;
    const name = entry.name ?? key.slice('node_modules/'.length);
    if (typeof entry.version !== 'string' || !entry.version) continue;
    packages.set(`${name}@${entry.version}`, { name, version: entry.version });
  }
  return [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

export function npmPurl(name, version) {
  return `pkg:npm/${name.startsWith('@') ? `%40${name.slice(1)}` : name}@${version}`;
}

export function goPurl(name, version) {
  return `pkg:golang/${name}@${version}`;
}

export function sbomDocument({ version, tag, repository, sourceSha, artifacts, images, modules, packages, generatedOn }) {
  const components = [];
  for (const artifact of artifacts) {
    components.push({
      type: 'file',
      'bom-ref': `file:${artifact.name}`,
      name: artifact.name,
      hashes: [{ alg: 'SHA-256', content: artifact.sha256 }],
      properties: [
        { name: 'orbit:surface', value: artifact.surface },
        { name: 'orbit:size', value: String(artifact.size) },
      ],
    });
  }
  for (const image of images) {
    components.push({
      type: 'container',
      'bom-ref': `urn:orbit:image:${image.name}`,
      name: image.name,
      version: image.id,
      hashes: [{ alg: 'SHA-256', content: image.id.slice('sha256:'.length) }],
      properties: [
        { name: 'orbit:reference', value: image.reference },
        ...(image.baseImages ?? []).map((base) => ({ name: 'orbit:base-image', value: base })),
        ...image.layers.map((layer) => ({ name: 'orbit:layer', value: layer })),
      ],
    });
  }
  for (const module of modules) {
    components.push({
      type: 'library',
      'bom-ref': goPurl(module.path, module.version),
      name: module.path,
      version: module.version,
      purl: goPurl(module.path, module.version),
      scope: 'required',
      properties: [{ name: 'orbit:applies-to', value: 'runner' }, ...(module.hash ? [{ name: 'orbit:go-mod-hash', value: module.hash }] : [])],
    });
  }
  for (const pkg of packages) {
    components.push({
      type: 'library',
      'bom-ref': npmPurl(pkg.name, pkg.version),
      name: pkg.name,
      version: pkg.version,
      purl: npmPurl(pkg.name, pkg.version),
      scope: 'required',
      properties: [{ name: 'orbit:applies-to', value: 'service-image' }],
    });
  }
  components.sort((a, b) => a['bom-ref'].localeCompare(b['bom-ref']));
  return {
    bomFormat: SBOM_FORMAT,
    specVersion: SBOM_SPEC_VERSION,
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: generatedOn,
      tools: { components: [{ type: 'application', name: 'orbit-supply-chain', version: '1' }] },
      component: {
        type: 'application',
        'bom-ref': `pkg:github/${repository}@${version}`,
        name: 'orbit',
        version,
        purl: `pkg:github/${repository}@${version}`,
      },
      properties: [
        { name: 'orbit:tag', value: tag },
        { name: 'orbit:source-sha', value: sourceSha },
        { name: 'orbit:repository', value: repositoryUrl(repository) },
      ],
    },
    components,
  };
}

export function provenanceDocument({
  version, tag, repository, sourceSha, artifacts, build, startedOn, finishedOn,
}) {
  return {
    _type: 'https://in-toto.io/Statement/v1',
    subject: artifacts.map((artifact) => ({ name: artifact.name, digest: { sha256: artifact.sha256 } })),
    predicateType: PROVENANCE_PREDICATE_TYPE,
    predicate: {
      buildDefinition: {
        buildType: build.kind === 'github-actions' ? GITHUB_ACTIONS_BUILD_TYPE : LOCAL_BUILD_TYPE,
        externalParameters: build.kind === 'github-actions'
          ? {
            workflow: { ref: `refs/tags/${tag}`, repository: repositoryUrl(repository), path: build.workflow },
            inputs: { version, tag, sourceSha, repository },
          }
          : { inputs: { version, tag, sourceSha, repository, workflow: build.workflow } },
        internalParameters: build.kind === 'github-actions'
          ? { github: { runId: build.runId, runAttempt: build.runAttempt } }
          : { local: true },
        resolvedDependencies: [{
          uri: `git+${repositoryUrl(repository)}@refs/tags/${tag}`,
          digest: { gitCommit: sourceSha },
        }],
      },
      runDetails: {
        builder: {
          id: build.builder,
          version: { 'orbit-supply-chain': '1', workflow: build.workflow ?? '', runAttempt: build.runAttempt ?? '' },
        },
        metadata: {
          invocationId: build.kind === 'github-actions'
            ? `${build.builder}/attempts/${build.runAttempt}` : build.builder,
          startedOn,
          finishedOn,
        },
      },
    },
  };
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sumsText(entries) {
  return `${entries.slice().sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => `${entry.sha256}  ${entry.name}`).join('\n')}\n`;
}

function parseSums(text) {
  const entries = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!match) throw new Error(`SHA256SUMS has an unreadable line: ${JSON.stringify(line)}`);
    entries.set(match[2], match[1]);
  }
  return entries;
}

export function requireInputs({ version, tag, sourceSha, repository }) {
  const problems = [];
  if (typeof version !== 'string' || !parseReleaseVersion(version)) problems.push(`${JSON.stringify(version)} is not X.Y.Z or X.Y.Z-beta.N`);
  if (tag !== `v${version}`) problems.push(`tag ${JSON.stringify(tag)} is not v + the version`);
  if (typeof sourceSha !== 'string' || !GIT_SHA.test(sourceSha)) problems.push('source sha must be a full lowercase 40-character Git SHA');
  if (typeof repository !== 'string' || !REPOSITORY.test(repository)) problems.push('repository must be OWNER/REPO');
  if (problems.length) throw new Error(problems.join('; '));
}

/** `--tree .` ties the bundle to the checkout it is generated from. */
export function treeProblems({ tree, version }) {
  const problems = [];
  try {
    const packageVersion = readJson(path.join(tree, 'package.json')).version;
    if (packageVersion !== version) problems.push(`package.json names ${JSON.stringify(packageVersion)}, not ${version}`);
  } catch {
    problems.push(`${tree}/package.json cannot be read`);
  }
  const notes = path.join(tree, 'release-notes', `${version}.md`);
  if (!existsSync(notes)) {
    problems.push(`release-notes/${version}.md is missing`);
  } else {
    problems.push(...notesProblems(readText(notes), version));
  }
  return problems;
}

export function parseImageDescriptor(value, file) {
  const problems = [];
  if (!value || typeof value !== 'object') throw new Error(`${file} is not a JSON object`);
  if (typeof value.name !== 'string' || !value.name) problems.push('name is missing');
  if (typeof value.reference !== 'string' || !value.reference) problems.push('reference is missing');
  if (typeof value.id !== 'string' || !SHA256_DIGEST.test(value.id)) problems.push('id must be a sha256: config digest');
  if (!Array.isArray(value.layers) || value.layers.some((layer) => !SHA256_DIGEST.test(layer))) problems.push('layers must be sha256: digests');
  if (!Number.isInteger(value.size) || value.size <= 0) problems.push('size must be a positive whole number');
  if (value.baseImages !== undefined && (!Array.isArray(value.baseImages) || value.baseImages.some((base) => typeof base !== 'string'))) {
    problems.push('baseImages must be strings');
  }
  if (problems.length) throw new Error(`${file}: ${problems.join('; ')}`);
  return {
    name: value.name,
    reference: value.reference,
    id: value.id,
    layers: value.layers,
    size: value.size,
    baseImages: value.baseImages ?? [],
  };
}

function dockerfileBaseImages(dockerfile) {
  return readText(dockerfile).split('\n')
    .map((line) => /^\s*FROM\s+(\S+)/i.exec(line)?.[1])
    .filter((image) => image && !image.startsWith('${'))
    .filter((image, index, all) => all.indexOf(image) === index);
}

export function imageInspect({ name, image, dockerfile }) {
  const raw = execFileSync('docker', ['image', 'inspect', '--format', '{{json .}}', image], { encoding: 'utf8' });
  const inspected = JSON.parse(raw);
  return {
    name,
    reference: image,
    id: inspected.Id,
    layers: inspected.RootFS?.Layers ?? [],
    size: inspected.Size,
    baseImages: dockerfile ? dockerfileBaseImages(dockerfile) : [],
  };
}

export function generate(options) {
  requireInputs(options);
  const { version, tag, repository, sourceSha } = options;
  const out = options.out;
  mkdirSync(out, { recursive: true });
  const names = bundleFileNames(version);
  const reserved = new Set([SUMS_FILE, MANIFEST_FILE, names.sbom, names.provenance]);
  const artifactNames = collectArtifacts(options.artifactSources, out, reserved);
  if (!artifactNames.length) throw new Error('the artifact set is empty');
  if (options.tree) {
    const problems = treeProblems({ tree: options.tree, version });
    if (problems.length) throw new Error(`the checkout does not match the release: ${problems.join('; ')}`);
  }
  const generatedOn = options.generatedOn ?? new Date().toISOString();
  const images = (options.imageFiles ?? []).map((file) => parseImageDescriptor(readJson(file), file));
  const versionProblems = [];
  for (const name of artifactNames) {
    versionProblems.push(...artifactVersionProblems({ name, version, sourceSha, buildNumber: options.buildNumber, directory: out }));
  }
  if (versionProblems.length) throw new Error(`version evidence disagrees with the release: ${versionProblems.join('; ')}`);

  const artifacts = artifactNames.map((name) => ({
    name,
    surface: surfaceOf(name),
    size: statSync(path.join(out, name)).size,
    sha256: sha256File(path.join(out, name)),
  }));
  const requiredSurfaces = options.requiredSurfaces ?? [];
  const presentSurfaces = new Set(artifacts.map((artifact) => artifact.surface));
  const missingSurfaces = requiredSurfaces.filter((surface) => !presentSurfaces.has(surface));
  if (missingSurfaces.length) {
    throw new Error(`the artifact set has no ${missingSurfaces.join(', ')} surface, which the release requires`);
  }
  const modules = goModulesFor(artifacts.filter((a) => isRunnerArchive(a.name)).map((a) => a.name), out);
  const packages = options.lockfile
    ? npmProductionPackages(readJson(options.lockfile)) : [];

  const sbom = sbomDocument({ version, tag, repository, sourceSha, artifacts, images, modules, packages, generatedOn });
  writeJson(path.join(out, names.sbom), sbom);
  const provenance = provenanceDocument({
    version, tag, repository, sourceSha, artifacts,
    build: options.build,
    startedOn: options.startedOn ?? generatedOn,
    finishedOn: options.finishedOn ?? generatedOn,
  });
  writeFileSync(path.join(out, names.provenance), `${JSON.stringify(provenance)}\n`);
  const imagesDescriptor = images.map(({ name, reference, id, layers, size, baseImages }) => ({
    name, reference, id, layers, size, baseImages,
  }));
  // The manifest is the bundle's index, so it is written before the checksum list that covers it:
  // SHA256SUMS is the root a downloaded release verifies first (and the file GitHub attests), and it
  // covers the manifest, the SBOM, the provenance and every artifact. Nothing covers itself.
  const manifest = {
    schemaVersion: 1,
    version,
    tag,
    prerelease: parseReleaseVersion(version).prerelease !== null,
    source: { repository, url: repositoryUrl(repository), commit: sourceSha, ref: `refs/tags/${tag}` },
    ...(options.buildNumber ? { buildNumber: Number(options.buildNumber) } : {}),
    build: options.build,
    artifacts,
    ...(requiredSurfaces.length ? { requiredSurfaces } : {}),
    ...(imagesDescriptor.length ? { images: imagesDescriptor } : {}),
    checksums: { file: names.sums },
    sbom: { file: names.sbom, format: SBOM_FORMAT, specVersion: SBOM_SPEC_VERSION, sha256: sha256File(path.join(out, names.sbom)) },
    provenance: { file: names.provenance, predicateType: PROVENANCE_PREDICATE_TYPE, sha256: sha256File(path.join(out, names.provenance)) },
  };
  writeJson(path.join(out, names.manifest), manifest);
  const sums = [
    ...artifacts,
    { name: names.manifest, sha256: sha256File(path.join(out, names.manifest)) },
    { name: names.sbom, sha256: sha256File(path.join(out, names.sbom)) },
    { name: names.provenance, sha256: sha256File(path.join(out, names.provenance)) },
  ];
  writeFileSync(path.join(out, names.sums), sumsText(sums));
  return { manifest, artifacts, images: imagesDescriptor, modules: modules.length, packages: packages.length };
}

function artifactSetProblems({ directory, manifest }) {
  const problems = [];
  for (const artifact of manifest.artifacts) {
    const file = path.join(directory, artifact.name);
    if (!existsSync(file)) {
      problems.push(`${artifact.name} is listed but missing`);
      continue;
    }
    const actual = sha256File(file);
    const size = statSync(file).size;
    if (actual !== artifact.sha256) problems.push(`${artifact.name} hashes to ${actual}, the manifest says ${artifact.sha256}`);
    if (size !== artifact.size) problems.push(`${artifact.name} is ${size} bytes, the manifest says ${artifact.size}`);
    if (artifact.surface !== surfaceOf(artifact.name)) problems.push(`${artifact.name} is not the ${artifact.surface} surface its name names`);
  }
  return problems;
}

function sbomProblems({ sbom, manifest }) {
  const problems = [];
  if (sbom.bomFormat !== SBOM_FORMAT) problems.push(`the SBOM is ${JSON.stringify(sbom.bomFormat)}, not ${SBOM_FORMAT}`);
  if (sbom.specVersion !== SBOM_SPEC_VERSION) problems.push(`the SBOM names specVersion ${JSON.stringify(sbom.specVersion)}, not ${SBOM_SPEC_VERSION}`);
  if (!/^urn:uuid:[0-9a-f-]{36}$/i.test(sbom.serialNumber ?? '')) problems.push('the SBOM has no urn:uuid serialNumber');
  if (sbom.metadata?.component?.version !== manifest.version) problems.push('the SBOM component version is not the release version');
  const properties = new Map((sbom.metadata?.properties ?? []).map((p) => [p.name, p.value]));
  if (properties.get('orbit:source-sha') !== manifest.source.commit) problems.push('the SBOM source sha is not the release source');
  if (properties.get('orbit:tag') !== manifest.tag) problems.push('the SBOM tag is not the release tag');
  const components = new Map((sbom.components ?? []).map((component) => [component['bom-ref'], component]));
  for (const artifact of manifest.artifacts) {
    const component = components.get(`file:${artifact.name}`);
    if (!component) {
      problems.push(`the SBOM has no component for ${artifact.name}`);
      continue;
    }
    if (component.hashes?.[0]?.alg !== 'SHA-256') {
      problems.push(`the SBOM component for ${artifact.name} carries no SHA-256`);
    }
    const content = component.hashes?.[0]?.content;
    if (content !== artifact.sha256) problems.push(`the SBOM says ${artifact.name} is ${content}, the manifest says ${artifact.sha256}`);
  }
  for (const image of manifest.images ?? []) {
    const component = components.get(`urn:orbit:image:${image.name}`);
    if (!component) problems.push(`the SBOM has no component for image ${image.name}`);
    else if (component.version !== image.id) problems.push(`the SBOM image ${image.name} is ${component.version}, the manifest says ${image.id}`);
  }
  return problems;
}

function provenanceProblems({ provenance, manifest, requireCi }) {
  const problems = [];
  if (provenance._type !== 'https://in-toto.io/Statement/v1') problems.push('the provenance is not an in-toto v1 statement');
  if (provenance.predicateType !== PROVENANCE_PREDICATE_TYPE) problems.push('the provenance predicate is not SLSA v1');
  const subjects = new Map((provenance.subject ?? []).map((subject) => [subject.name, subject.digest?.sha256]));
  for (const artifact of manifest.artifacts) {
    if (subjects.get(artifact.name) !== artifact.sha256) problems.push(`the provenance subject ${artifact.name} is not the artifact`);
  }
  if (subjects.size !== manifest.artifacts.length) problems.push('the provenance names subjects the manifest does not');
  const definition = provenance.predicate?.buildDefinition;
  const run = provenance.predicate?.runDetails;
  const dependency = definition?.resolvedDependencies?.[0];
  if (dependency?.digest?.gitCommit !== manifest.source.commit) problems.push('the provenance source commit is not the release source');
  if (typeof dependency?.uri !== 'string' || !dependency.uri.includes(`@refs/tags/${manifest.tag}`)) {
    problems.push('the provenance does not name the release tag as its source');
  }
  const expectedRun = manifest.build?.kind === 'github-actions'
    ? `https://github.com/${manifest.source.repository}/actions/runs/${manifest.build.runId}` : null;
  if (requireCi || manifest.build?.kind === 'github-actions') {
    if (definition?.buildType !== GITHUB_ACTIONS_BUILD_TYPE) problems.push('the provenance buildType is not the GitHub Actions build type');
    if (definition?.externalParameters?.workflow?.repository !== manifest.source.url) problems.push('the provenance workflow repository is not the release repository');
    if (definition?.externalParameters?.workflow?.ref !== manifest.source.ref) problems.push('the provenance workflow ref is not the release tag');
    if (!definition?.externalParameters?.workflow?.path?.startsWith('.github/workflows/')) problems.push('the provenance names no public workflow');
    if (run?.builder?.id !== expectedRun) problems.push(`the provenance builder is ${JSON.stringify(run?.builder?.id)}, not this release's run`);
    if (run?.metadata?.invocationId !== `${expectedRun}/attempts/${manifest.build.runAttempt}`) {
      problems.push('the provenance invocation is not this run attempt');
    }
  } else if (manifest.build?.kind !== 'local-dry-run') {
    problems.push('the manifest names no builder this script understands');
  } else if (definition?.buildType !== LOCAL_BUILD_TYPE) {
    problems.push('a local build must say so in its provenance buildType');
  }
  if (!run?.metadata?.startedOn || !run?.metadata?.finishedOn) problems.push('the provenance carries no build interval');
  return problems;
}

export function verify(options) {
  const directory = options.dir;
  const problems = [];
  if (!existsSync(directory)) throw new Error(`${directory} does not exist`);
  if (!existsSync(path.join(directory, MANIFEST_FILE))) throw new Error(`${MANIFEST_FILE} is missing from ${directory}`);
  const manifest = readJson(path.join(directory, MANIFEST_FILE));
  const version = manifest.version;
  try {
    requireInputs({ version, tag: manifest.tag, sourceSha: manifest.source?.commit, repository: manifest.source?.repository });
  } catch (error) {
    problems.push(error.message);
  }
  if (options.tag && options.tag !== manifest.tag) problems.push(`the manifest names ${manifest.tag}, not ${options.tag}`);
  if (options.sourceSha && options.sourceSha !== manifest.source.commit) {
    problems.push(`the manifest names source ${manifest.source.commit}, not ${options.sourceSha}`);
  }
  if (options.repository && options.repository !== manifest.source.repository) problems.push('the manifest names another repository');
  if (options.tree) problems.push(...treeProblems({ tree: options.tree, version }));
  if (!Array.isArray(manifest.artifacts) || !manifest.artifacts.length) problems.push('the manifest lists no artifacts');
  for (const key of ['checksums', 'sbom', 'provenance']) {
    if (typeof manifest[key]?.file !== 'string') problems.push(`the manifest names no ${key} file`);
  }
  if (problems.length) return { problems, manifest };
  for (const key of ['sbom', 'provenance']) {
    const file = manifest[key].file;
    if (!existsSync(path.join(directory, file))) {
      problems.push(`the ${key} file ${JSON.stringify(file)} is missing`);
      continue;
    }
    if (manifest[key].sha256 !== sha256File(path.join(directory, file))) problems.push(`the ${key} file does not hash to what the manifest records`);
  }
  if (!existsSync(path.join(directory, SUMS_FILE))) {
    problems.push(`${SUMS_FILE} is missing`);
    return { problems, manifest };
  }

  const sums = parseSums(readText(path.join(directory, SUMS_FILE)));
  problems.push(...sumsProblems(sums, manifest));
  for (const artifact of manifest.artifacts) {
    if (sums.get(artifact.name) !== artifact.sha256) problems.push(`SHA256SUMS does not name ${artifact.name} with its manifest digest`);
  }
  if (sums.size !== manifest.artifacts.length + 3) problems.push('SHA256SUMS lists files the manifest does not');
  const requiredSurfaces = Array.isArray(manifest.requiredSurfaces) ? manifest.requiredSurfaces : [];
  const presentSurfaces = new Set(manifest.artifacts.map((artifact) => artifact.surface));
  for (const surface of requiredSurfaces) {
    if (!SURFACES.has(surface)) problems.push(`the manifest requires an unknown surface ${JSON.stringify(surface)}`);
    else if (!presentSurfaces.has(surface)) problems.push(`the release requires the ${surface} surface but carries no artifact for it`);
  }
  problems.push(...artifactSetProblems({ directory, manifest }));
  for (const artifact of manifest.artifacts) {
    if (!existsSync(path.join(directory, artifact.name))) continue;
    try {
      problems.push(...artifactVersionProblems({
        name: artifact.name,
        version: manifest.version,
        sourceSha: manifest.source.commit,
        buildNumber: manifest.buildNumber === undefined ? undefined : String(manifest.buildNumber),
        directory,
      }));
    } catch (error) {
      problems.push(`${artifact.name} cannot be read: ${error.message}`);
    }
  }
  // A missing file was already reported above; read only what exists so the rest is still checked.
  if (existsSync(path.join(directory, manifest.sbom.file))) {
    problems.push(...sbomProblems({ sbom: readJson(path.join(directory, manifest.sbom.file)), manifest }));
  }
  if (existsSync(path.join(directory, manifest.provenance.file))) {
    const provenance = JSON.parse(readText(path.join(directory, manifest.provenance.file)));
    problems.push(...provenanceProblems({ provenance, manifest, requireCi: Boolean(options.requireCi) }));
  }
  problems.push(...lateReleaseAssetProblems({ directory, manifest }));
  return { problems, manifest };
}

function sumsProblems(sums, manifest) {
  const problems = [];
  if (!sums.has(manifest.sbom.file)) problems.push('SHA256SUMS does not cover the SBOM');
  if (!sums.has(manifest.provenance.file)) problems.push('SHA256SUMS does not cover the provenance');
  if (!sums.has(MANIFEST_FILE)) problems.push('SHA256SUMS does not cover the manifest');
  if (sums.has(SUMS_FILE)) problems.push('SHA256SUMS lists itself');
  for (const artifact of manifest.artifacts) {
    if (!sums.has(artifact.name)) problems.push(`SHA256SUMS does not list ${artifact.name}`);
  }
  return problems;
}

/**
 * The Android publishing job attaches its update manifest (and the APK's .sha256) after this bundle is
 * built, so a downloaded release carries two files no manifest lists. Each one has to agree with the
 * APK the bundle does list; anything else unlisted is still refused.
 */
function lateReleaseAssetProblems({ directory, manifest }) {
  const problems = [];
  const apk = manifest.artifacts.find((artifact) => /^orbit-android-.+\.apk$/.test(artifact.name));
  const checksum = apk ? `${apk.name}.sha256` : null;
  for (const name of walkFiles(directory)) {
    const known = KNOWN_RELEASE_EXTRAS.includes(name) || name === checksum;
    if (known) continue;
    if ([SUMS_FILE, MANIFEST_FILE, manifest.sbom?.file, manifest.provenance?.file].includes(name)) continue;
    if (!manifest.artifacts.some((artifact) => artifact.name === name)) problems.push(`${name} is in the release directory but no manifest lists it`);
  }
  if (checksum && existsSync(path.join(directory, checksum))) {
    const line = readText(path.join(directory, checksum)).trim().split('\n')[0];
    if (line !== `${apk.sha256}  ${apk.name}`) problems.push(`${checksum} does not name the APK's digest`);
  }
  if (KNOWN_RELEASE_EXTRAS.includes('android-update.json') && apk && existsSync(path.join(directory, 'android-update.json'))) {
    const update = readJson(path.join(directory, 'android-update.json'));
    if (update.sha256 !== apk.sha256 || update.apkName !== apk.name) problems.push('android-update.json does not name the APK this release carries');
    if (update.versionName !== manifest.version || update.tag !== manifest.tag) problems.push('android-update.json names another release');
  }
  return problems;
}

function flag(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) {
      if (index + 1 >= args.length) throw new Error(`${name} needs a value`);
      values.push(args[index + 1]);
    }
  }
  return values;
}

function one(args, name, fallback) {
  const values = flag(args, name);
  if (values.length > 1) throw new Error(`${name} may be given once`);
  return values.length ? values[0] : fallback;
}

function bool(args, name) {
  return args.includes(name);
}

function requiredSurfaces(values) {
  const surfaces = [];
  for (const value of values) {
    for (const item of value.split(',')) {
      const surface = item.trim();
      if (!surface) continue;
      if (!SURFACES.has(surface)) throw new Error(`${surface} is not a release surface (${[...SURFACES].join(', ')})`);
      surfaces.push(surface);
    }
  }
  return [...new Set(surfaces)];
}

function buildIdentity(args, values) {
  const runId = one(args, '--run-id');
  const runAttempt = one(args, '--run-attempt', '1');
  const workflow = one(args, '--workflow', DEFAULT_WORKFLOW);
  if (runId !== undefined) {
    if (!RUN_ID.test(runId)) throw new Error('--run-id must be digits');
    if (!RUN_ID.test(runAttempt)) throw new Error('--run-attempt must be digits');
    const builder = one(args, '--builder-id', `https://github.com/${values.repository}/actions/runs/${runId}`);
    return { kind: 'github-actions', workflow, runId, runAttempt, builder };
  }
  return { kind: 'local-dry-run', workflow: one(args, '--workflow', 'local dry run'), runId: null, runAttempt: runAttempt, builder: 'urn:orbit:supply-chain:local' };
}

export function main(argv) {
  const [command, ...args] = argv;
  if (command === 'image-inspect') {
    const name = one(args, '--name');
    const image = one(args, '--image');
    const out = one(args, '--out');
    const dockerfile = one(args, '--dockerfile');
    if (!name || !image || !out) throw new Error('usage: image-inspect --name NAME --image REF --out FILE [--dockerfile PATH]');
    mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    writeJson(out, imageInspect({ name, image, dockerfile }));
    console.log(`✓ ${out}: ${name} ${image}`);
    return 0;
  }
  if (command === 'generate') {
    const version = one(args, '--version');
    const tag = one(args, '--tag');
    const sourceSha = one(args, '--source-sha');
    const repository = one(args, '--repository');
    const out = one(args, '--out');
    const sources = flag(args, '--artifacts');
    if (!version || !tag || !sourceSha || !repository || !out || !sources.length) {
      throw new Error('usage: generate --version V --tag vV --source-sha SHA --repository OWNER/REPO --artifacts DIR [-—artifacts DIR] --out DIR');
    }
    const build = buildIdentity(args, { repository });
    const result = generate({
      version, tag, sourceSha, repository, out, artifactSources: sources,
      build,
      tree: one(args, '--tree'),
      buildNumber: one(args, '--build-number'),
      lockfile: one(args, '--lockfile'),
      imageFiles: flag(args, '--image'),
      requiredSurfaces: requiredSurfaces(flag(args, '--require-surface')),
      generatedOn: one(args, '--generated-on'),
      startedOn: one(args, '--started-on'),
      finishedOn: one(args, '--finished-on'),
    });
    const surfaces = [...new Set(result.artifacts.map((a) => a.surface))].sort().join(', ');
    console.log(`✓ ${out}: ${result.artifacts.length} artifacts (${surfaces}), ${result.images.length} images, ` +
      `${result.modules} Go modules, ${result.packages} npm packages`);
    return 0;
  }
  if (command === 'verify') {
    const dir = one(args, '--dir');
    if (!dir) throw new Error('usage: verify --dir RELEASE_DIRECTORY [--tag vV] [--source-sha SHA] [--repository OWNER/REPO] [--tree DIR] [--require-ci]');
    const result = verify({
      dir,
      tag: one(args, '--tag'),
      sourceSha: one(args, '--source-sha'),
      repository: one(args, '--repository'),
      tree: one(args, '--tree'),
      requireCi: bool(args, '--require-ci'),
    });
    if (result.problems.length) {
      for (const problem of result.problems) console.error(`✗ ${problem}`);
      return 1;
    }
    const manifest = result.manifest;
    const surfaces = [...new Set(manifest.artifacts.map((a) => a.surface))].sort().join(', ');
    console.log(`✓ ${manifest.tag} from ${manifest.source.commit}`);
    console.log(`  ${manifest.artifacts.length} artifacts (${surfaces}), ${(manifest.images ?? []).length} images`);
    console.log(`  builder ${manifest.build.builder}`);
    console.log('  release identity, checksums, SBOM and provenance agree');
    return 0;
  }
  console.error('usage: supply-chain.mjs generate|verify|image-inspect ...');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exitCode = 1;
  }
}
