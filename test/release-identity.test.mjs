import assert from 'node:assert/strict';
import test from 'node:test';

import {
  identityProblems,
  notesProblems,
  parseReleaseVersion,
  releaseIdentity,
  NOTES_SECTIONS,
} from '../scripts/release-identity.mjs';

/**
 * One release identity (scripts/release-identity.mjs): the root package version is the version of record,
 * the tag is v + that version, and every artifact and update feed derives from them.
 */

const NOTES = `# Orbit 0.1.257-beta.1

## Summary
The release identity rules and the first release that follows them.

## Upgrade impact
Runners older than this release must be reinstalled once.

## Security fixes
None in this release.

## Known limitations
None known.

## Artifacts and verification
DMG, TestFlight, APK and runner binaries all report 0.1.257-beta.1.

## Rollback
The previous release stays published for runner rollback.
`;

test('a prerelease identity derives every surface from the package version', () => {
  const id = releaseIdentity('0.1.257-beta.1', 10729);
  assert.equal(id.tag, 'v0.1.257-beta.1');
  assert.equal(id.prerelease, true);
  assert.equal(id.channel, 'beta');
  assert.equal(id.package.version, '0.1.257-beta.1');
  assert.equal(id.githubRelease.tag, 'v0.1.257-beta.1');
  assert.equal(id.githubRelease.prerelease, true);
  assert.equal(id.notes, 'release-notes/0.1.257-beta.1.md');
  assert.equal(id.macos.dmg, 'Orbit-v0.1.257-beta.1-arm64.dmg');
  assert.equal(id.macos.zip, 'Orbit-v0.1.257-beta.1-arm64.zip');
  assert.equal(id.macos.shortVersionString, '0.1.257-beta.1');
  assert.equal(id.macos.channel, 'beta');
  assert.equal(id.ios.marketingVersion, '0.1.257', 'Apple marketing versions are numeric');
  assert.equal(id.ios.build, 10729);
  assert.equal(id.android.versionName, '0.1.257-beta.1');
  assert.equal(id.android.versionCode, 10729);
  assert.equal(id.android.apk, 'orbit-android-0.1.257-beta.1.apk');
  assert.equal(id.runner.version, '0.1.257-beta.1');
  assert.equal(id.server.dlVersion, '0.1.257-beta.1');
  assert.equal(id.appcast.shortVersionString, '0.1.257-beta.1');
  assert.equal(id.appcast.channel, 'beta');
  assert.equal(id.androidUpdate.tag, 'v0.1.257-beta.1');
  assert.equal(id.androidUpdate.versionName, '0.1.257-beta.1');
});

test('a stable identity uses the stable channel and no prerelease flag', () => {
  const id = releaseIdentity('0.1.257', 42);
  assert.equal(id.tag, 'v0.1.257');
  assert.equal(id.prerelease, false);
  assert.equal(id.channel, 'stable');
  assert.equal(id.macos.channel, 'stable');
  assert.equal(id.appcast.channel, 'stable');
  assert.equal(id.ios.marketingVersion, '0.1.257');
});

test('only X.Y.Z and the beta channel X.Y.Z-beta.N are release versions', () => {
  for (const version of ['0.1.257', '0.1.257-beta.1', '0.1.257-beta.10', '10.0.0']) {
    assert.ok(parseReleaseVersion(version), version);
  }
  for (const version of ['v0.1.257', '0.1', '0.1.2-rc.1', '0.1.2-beta', '0.1.2-beta.0.1', '01.2.3', '0.1.2 ']) {
    assert.equal(parseReleaseVersion(version), null, version);
  }
});

test('release notes carry every required section with content', () => {
  assert.deepEqual(notesProblems(NOTES, '0.1.257-beta.1'), []);
  assert.deepEqual(NOTES_SECTIONS.map((section) => NOTES.includes(`## ${section}`)), NOTES_SECTIONS.map(() => true));
  assert.match(notesProblems(`# Orbit 9.9.9\n\n${NOTES}`, '0.1.257-beta.1').join('\n'), /first heading/);
  assert.match(notesProblems(NOTES.replace('## Security fixes\nNone in this release.\n', ''), '0.1.257-beta.1').join('\n'),
    /"## Security fixes" is missing/);
  assert.match(notesProblems(NOTES.replace('None in this release.', ''), '0.1.257-beta.1').join('\n'),
    /"## Security fixes" is empty/);
  assert.match(notesProblems(NOTES.replace('None in this release.', 'TODO'), '0.1.257-beta.1').join('\n'),
    /"## Security fixes" is still a placeholder/);
});

test('a matching tag, package version and notes are one identity', () => {
  assert.deepEqual(identityProblems({ tag: 'v0.1.257-beta.1', packageVersion: '0.1.257-beta.1', notes: NOTES }), []);
  assert.deepEqual(identityProblems({
    tag: 'v0.1.257-beta.1', packageVersion: '0.1.257-beta.1', notes: NOTES,
    tagObject: 'tag', tagCommit: 'a'.repeat(40), head: 'a'.repeat(40),
  }), []);
});

test('the drift this rule exists to stop is refused', () => {
  const problems = identityProblems({ tag: 'v0.1.2-beta.245', packageVersion: '0.1.254', notes: NOTES.replaceAll('0.1.257-beta.1', '0.1.2-beta.245') });
  assert.match(problems.join('\n'), /tag v0\.1\.2-beta\.245 names 0\.1\.2-beta\.245, but root package\.json names "0\.1\.254"/);
});

test('a release is refused without notes, on a lightweight tag, or from another commit', () => {
  assert.match(identityProblems({ tag: 'v0.1.257', packageVersion: '0.1.257', notes: null }).join('\n'), /notes are missing/);
  assert.match(identityProblems({ tag: 'v0.1.257', packageVersion: '0.1.257', notes: NOTES.replaceAll('0.1.257-beta.1', '0.1.257'),
    tagObject: 'commit' }).join('\n'), /lightweight/);
  assert.match(identityProblems({ tag: 'v0.1.257', packageVersion: '0.1.257', notes: NOTES.replaceAll('0.1.257-beta.1', '0.1.257'),
    tagObject: 'tag', tagCommit: 'a'.repeat(40), head: 'b'.repeat(40) }).join('\n'), /cut the release from the release commit/);
  assert.match(identityProblems({ tag: '0.1.257', packageVersion: '0.1.257', notes: NOTES }).join('\n'), /is not vX\.Y\.Z/);
});
