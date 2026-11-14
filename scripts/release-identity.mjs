#!/usr/bin/env node
/**
 * One release identity, derived from one version of record.
 *
 * The root package.json version is the version of record. A release tag is `v` + that version, and every
 * other surface derives from them (docs/release-process.md, "One version of record"):
 *
 *   package.json · git tag · GitHub Release · macOS DMG and Sparkle payload · TestFlight · Android APK and
 *   android-update.json · runner binaries and /dl/version.json · Sparkle appcast · release notes
 *
 * `check-tag` is the gate release.yml runs before anything is built, and the preflight release.sh runs before
 * it tags. It refuses a tag whose name and package version disagree, a release without human-written notes,
 * and a tag that is lightweight or does not point at the commit being released.
 *
 *   node scripts/release-identity.mjs check-tag v0.1.257-beta.1
 *   node scripts/release-identity.mjs check-notes release-notes/0.1.257-beta.1.md
 *   node scripts/release-identity.mjs derive [--version 0.1.257-beta.1] [--build 10729]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** X.Y.Z, or the beta channel's X.Y.Z-beta.N. SemVer, restricted to the one prerelease channel Orbit ships. */
export const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(beta)\.(0|[1-9]\d*))?$/;

/** The headings a release note must carry, in the order docs/release-notes-template.md presents them. */
export const NOTES_SECTIONS = [
  'Summary',
  'Upgrade impact',
  'Security fixes',
  'Known limitations',
  'Artifacts and verification',
  'Rollback',
];

export function parseReleaseVersion(version) {
  const match = RELEASE_VERSION.exec(version ?? '');
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? { channel: match[4], number: Number(match[5]) } : null,
  };
}

/** Every surface's version for one release, as the pipeline derives it. */
export function releaseIdentity(version, build) {
  const parsed = parseReleaseVersion(version);
  if (!parsed) throw new Error(`${JSON.stringify(version)} is not X.Y.Z or X.Y.Z-beta.N`);
  if (!Number.isInteger(build) || build < 0) throw new Error(`build must be a whole number, not ${JSON.stringify(build)}`);
  const tag = `v${version}`;
  const prerelease = parsed.prerelease !== null;
  const channel = prerelease ? parsed.prerelease.channel : 'stable';
  const core = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  return {
    version,
    tag,
    prerelease,
    channel,
    package: { name: 'orbit', version },
    githubRelease: { tag, title: `Orbit ${version}`, prerelease },
    notes: `release-notes/${version}.md`,
    macos: {
      // release.yml passes the tag verbatim to build-dmg.sh; its Info.plist carries it as
      // CFBundleShortVersionString and the commit count as the monotonic CFBundleVersion.
      channel: prerelease ? 'beta' : 'stable',
      shortVersionString: version,
      build,
      dmg: `Orbit-${tag}-arm64.dmg`,
      zip: `Orbit-${tag}-arm64.zip`,
    },
    ios: {
      // CFBundleShortVersionString must be numeric, so the suffix is stripped; the commit count carries
      // the beta iteration to TestFlight.
      marketingVersion: core,
      build,
    },
    android: {
      versionName: version,
      versionCode: build,
      apk: `orbit-android-${version}.apk`,
      apkSha256: `orbit-android-${version}.apk.sha256`,
    },
    runner: { version, manifest: 'version.json' },
    appcast: { shortVersionString: version, build, channel: prerelease ? 'beta' : 'stable' },
    androidUpdate: { tag, versionName: version, versionCode: build },
    server: { dlVersion: version, webClient: `web/${version}` },
  };
}

const PLACEHOLDER = /^(?:TODO|TBD)\b/i;

/** Everything wrong with one release-notes file, or []. */
export function notesProblems(source, version) {
  const problems = [];
  const text = typeof source === 'string' ? source : null;
  if (text === null) return ['the release notes are missing'];
  const lines = text.split('\n');
  const title = lines.find((line) => line.startsWith('# '));
  if (title !== `# Orbit ${version}`) problems.push(`the first heading must be "# Orbit ${version}", not ${JSON.stringify(title ?? '')}`);
  for (const section of NOTES_SECTIONS) {
    const start = lines.findIndex((line) => line.trim() === `## ${section}`);
    if (start < 0) {
      problems.push(`the section "## ${section}" is missing`);
      continue;
    }
    const body = [];
    for (const line of lines.slice(start + 1)) {
      if (/^#{1,2} /.test(line)) break;
      body.push(line);
    }
    const meaningful = body.map((line) => line.trim()).filter(Boolean);
    if (meaningful.length === 0) problems.push(`the section "## ${section}" is empty`);
    else if (meaningful.every((line) => PLACEHOLDER.test(line))) problems.push(`the section "## ${section}" is still a placeholder`);
  }
  return problems;
}

/**
 * Everything wrong with one release identity, or [].
 *
 * `tagObject` is what git says the tag is — "tag" (annotated), "commit" (lightweight) — or null when it has
 * not been created yet. When it exists, it has to point at `head`: a release is cut from the release commit.
 */
export function identityProblems({ tag, packageVersion, notes, tagObject = null, tagCommit = null, head = null }) {
  const problems = [];
  const version = typeof tag === 'string' && tag.startsWith('v') ? tag.slice(1) : null;
  const parsed = version === null ? null : parseReleaseVersion(version);
  if (!parsed) {
    problems.push(`tag ${JSON.stringify(tag)} is not vX.Y.Z or vX.Y.Z-beta.N`);
    return problems;
  }
  if (typeof packageVersion !== 'string' || packageVersion !== version) {
    problems.push(`tag ${tag} names ${version}, but root package.json names ${JSON.stringify(packageVersion)}`);
  }
  problems.push(...notesProblems(notes, version));
  if (tagObject !== null && tagObject !== 'tag') {
    problems.push(`tag ${tag} is lightweight; release tags are annotated (git tag -a)`);
  }
  if (tagCommit !== null && head !== null && tagCommit !== head) {
    problems.push(`tag ${tag} points at ${tagCommit}, but HEAD is ${head}: cut the release from the release commit`);
  }
  return problems;
}

function git(args, cwd = repoRoot) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function packageVersionAt(root) {
  try {
    return JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
}

function readOrNull(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function table(identity, { packageVersion, tagObject, tagCommit, head, notesState }) {
  const expected = identity.version;
  const check = (value) => (value === expected ? '' : `  ← expected ${expected}`);
  const rows = [
    ['package.json', `${identity.package.version}${check(identity.package.version)}`],
    ['git tag', `${identity.tag}${tagObject === null ? ' (not created yet)' : tagObject === 'tag' ? ` (annotated, ${tagCommit === head ? 'at HEAD' : `at ${tagCommit}, HEAD is ${head}`})` : ' (lightweight)'}`],
    ['GitHub Release', `${identity.githubRelease.tag} (${identity.prerelease ? 'prerelease' : 'stable'} channel ${identity.channel})`],
    ['release notes', `${identity.notes} (${notesState})`],
    ['macOS DMG', `${identity.macos.dmg} (CFBundleShortVersionString ${identity.macos.shortVersionString}, build ${identity.macos.build})`],
    ['macOS Sparkle payload', identity.macos.zip],
    ['iOS TestFlight', `marketing ${identity.ios.marketingVersion}, build ${identity.ios.build}`],
    ['Android APK', `${identity.android.apk} (versionName ${identity.android.versionName}, versionCode ${identity.android.versionCode})`],
    ['Runner binary and /dl', `orbit ${identity.runner.version} (/dl/version.json ${identity.server.dlVersion})`],
    ['Sparkle appcast', `shortVersionString ${identity.appcast.shortVersionString}, channel ${identity.appcast.channel}, build ${identity.appcast.build}`],
    ['android-update.json', `tag ${identity.androidUpdate.tag}, versionName ${identity.androidUpdate.versionName}`],
  ];
  const width = Math.max(...rows.map(([name]) => name.length));
  return rows.map(([name, value]) => `  ${name.padEnd(width)}  ${value}`).join('\n');
}

function main(argv) {
  const [command, ...args] = argv;
  const flag = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const build = flag('--build') ?? git(['rev-list', '--count', 'HEAD']) ?? '0';
  const buildNumber = Number(build);

  if (command === 'derive') {
    const version = flag('--version') ?? packageVersionAt(repoRoot);
    console.log(JSON.stringify(releaseIdentity(version, buildNumber), null, 2));
    return 0;
  }

  if (command === 'check-notes') {
    const file = args[0];
    if (!file) throw new Error('usage: check-notes <file>');
    const source = readOrNull(path.resolve(repoRoot, file));
    if (source === null) throw new Error(`${file} does not exist`);
    const version = path.basename(file, '.md');
    const problems = notesProblems(source, version);
    if (problems.length) {
      for (const problem of problems) console.error(`✗ ${problem}`);
      return 1;
    }
    console.log(`✓ ${file} carries every required section for ${version}`);
    return 0;
  }

  if (command === 'check-tag') {
    const tag = args[0];
    if (!tag) throw new Error('usage: check-tag <vX.Y.Z[-beta.N]>');
    const version = tag.startsWith('v') ? tag.slice(1) : null;
    const identity = parseReleaseVersion(version) ? releaseIdentity(version, buildNumber) : null;
    const notesFile = path.join(repoRoot, identity?.notes ?? `release-notes/${version}.md`);
    const notes = readOrNull(notesFile);
    const tagObject = git(['cat-file', '-t', `refs/tags/${tag}`]);
    const tagCommit = git(['rev-parse', `${tag}^{commit}`]);
    const head = git(['rev-parse', 'HEAD']);
    const packageVersion = packageVersionAt(repoRoot);
    const problems = identityProblems({ tag, packageVersion, notes, tagObject, tagCommit, head });
    const notesState = notes === null ? 'missing'
      : notesProblems(notes, version).length ? 'invalid' : 'valid';
    console.log(`release identity ${version ?? tag} (source ${head ?? 'unknown'}, build ${buildNumber})`);
    if (identity) console.log(table(identity, { packageVersion, tagObject, tagCommit, head, notesState }));
    if (problems.length) {
      for (const problem of problems) console.error(`✗ ${problem}`);
      return 1;
    }
    console.log('✓ every surface names one release');
    return 0;
  }

  console.error('usage: release-identity.mjs check-tag <tag> | check-notes <file> | derive [--version V] [--build N]');
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
