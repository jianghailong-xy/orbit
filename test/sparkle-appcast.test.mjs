import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { compareVersions, mergeAppcast, parseAppcast } from '../scripts/sparkle-appcast.mjs';

/**
 * The Sparkle feed is merged at publish time (scripts/sparkle-appcast.mjs): a release's entry goes into the
 * feed as it stands on gh-pages then, not as it stood when the release's DMG was built.
 */

const item = (version, build) => `        <item>
            <title>${version}</title>
            <pubDate>Mon, 16 Nov 2026 18:00:00 +0000</pubDate>
            <link>https://github.com/jianghailong-xy/orbit</link>
            <sparkle:channel>beta</sparkle:channel>
            <sparkle:version>${build}</sparkle:version>
            <sparkle:shortVersionString>${version}</sparkle:shortVersionString>
            <sparkle:minimumSystemVersion>14.0</sparkle:minimumSystemVersion>
            <sparkle:hardwareRequirements>arm64</sparkle:hardwareRequirements>
            <enclosure url="https://github.com/jianghailong-xy/orbit/releases/download/v${version}/Orbitd-v${version}-arm64.zip" length="27921501" type="application/octet-stream" sparkle:edSignature="sig-${build}=="/>
        </item>
`;

const appcast = (...items) => `<?xml version="1.0" standalone="yes"?>
<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0">
    <channel>
        <title>Orbit</title>
${items.join('')}    </channel>
</rss>
`;

const versions = (xml) => parseAppcast(xml).items.map((entry) => entry.version);

test('an older release published after a newer one keeps the newer one first (beta.22 after beta.23)', () => {
  const feed = appcast(item('0.1.261-beta.23', 12161), item('0.1.261-beta.19', 12128));
  const merged = mergeAppcast(feed, appcast(item('0.1.261-beta.22', 12159)));
  assert.deepEqual(versions(merged), ['0.1.261-beta.23', '0.1.261-beta.22', '0.1.261-beta.19']);
});

test('a newer release goes on top, and every entry is copied byte for byte', () => {
  const old = [item('0.1.261-beta.23', 12161), item('0.1.261-beta.22', 12159)];
  const next = item('0.1.261-beta.24', 12170);
  const merged = mergeAppcast(appcast(...old), appcast(next));
  assert.equal(merged, appcast(next, ...old));
});

test('a re-run of the same release replaces its entry instead of listing it twice', () => {
  const feed = appcast(item('0.1.261-beta.23', 12161), item('0.1.261-beta.22', 12159));
  const rebuilt = item('0.1.261-beta.23', 12161).replace('sig-12161', 'sig-rebuilt');
  const merged = mergeAppcast(feed, appcast(rebuilt));
  assert.deepEqual(versions(merged), ['0.1.261-beta.23', '0.1.261-beta.22']);
  assert.match(merged, /sig-rebuilt/);
  assert.doesNotMatch(merged, /sig-12161/);
});

test('with no published feed yet, the release appcast is the feed', () => {
  const release = appcast(item('0.1.0', 1));
  assert.equal(mergeAppcast(null, release), release);
});

test('a feed with no entries gets the release entry inside its channel', () => {
  const merged = mergeAppcast(appcast(), appcast(item('0.1.0', 1)));
  assert.equal(merged, appcast(item('0.1.0', 1)));
});

test('a feed that is not an appcast is refused rather than overwritten', () => {
  assert.throws(() => mergeAppcast('<html>404</html>', appcast(item('0.1.0', 1))), /published feed has no <channel>/);
  assert.throws(() => mergeAppcast(appcast(), appcast()), /release appcast has no entry/);
  const unversioned = item('0.1.0', 1).replace('<sparkle:version>1</sparkle:version>', '');
  assert.throws(() => mergeAppcast(appcast(unversioned), appcast(item('0.1.1', 2))), /without a sparkle:version/);
});

test('builds are ordered as Sparkle orders them, the early dotted 0.1.0 build below every commit count', () => {
  const feed = appcast(item('0.1.261-beta.9', 9999), item('0.1.0', '0.1.0'));
  const merged = mergeAppcast(feed, appcast(item('0.1.261-beta.10', 10000)));
  assert.deepEqual(versions(merged), ['0.1.261-beta.10', '0.1.261-beta.9', '0.1.0']);
  assert.equal(compareVersions('12161', '0.1.0'), 1);
  assert.equal(compareVersions('10000', '9999'), 1);
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
});

test('the CLI merges a file in place', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'appcast-'));
  const feed = path.join(dir, 'feed.xml');
  const release = path.join(dir, 'release.xml');
  writeFileSync(feed, appcast(item('0.1.261-beta.23', 12161)));
  writeFileSync(release, appcast(item('0.1.261-beta.22', 12159)));
  const script = path.join(import.meta.dirname, '..', 'scripts', 'sparkle-appcast.mjs');
  const said = execFileSync(process.execPath, [script, 'merge', '--feed', feed, '--release', release, '--out', feed],
    { encoding: 'utf8' });
  assert.match(said, /2 entries, newest 0\.1\.261-beta\.23 \(build 12161\)/);
  assert.deepEqual(versions(readFileSync(feed, 'utf8')), ['0.1.261-beta.23', '0.1.261-beta.22']);
});
