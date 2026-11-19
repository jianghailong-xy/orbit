#!/usr/bin/env node
/**
 * Merges one release's Sparkle appcast entry into the published feed, at the moment the release is published.
 *
 * release.yml's dmg job signs this release's update payload and writes an appcast holding only its entry.
 * Each entry carries its own EdDSA signature over its own zip, and the feed as a whole is unsigned, so entries
 * can be moved between files without the Sparkle key. The publish job merges the entry into the feed on the
 * gh-pages branch right before pushing it. Before, the dmg job seeded its appcast from the feed live on Pages
 * when it built. A release whose build waited for a runner while a newer one published then wrote back a feed
 * without the newer version (2026-11-16: beta.22, built before beta.23 was live and published after it, left
 * beta.23 out of the feed).
 *
 * The merged feed keeps every entry it had, replaces one naming the same version, and is ordered by build
 * number (sparkle:version), newest first. Entries are copied byte for byte, signatures included.
 *
 *   node scripts/sparkle-appcast.mjs merge --feed gh-pages/appcast.xml --release appcast.xml --out gh-pages/appcast.xml
 *
 * A missing --feed starts a new feed from the release's own appcast; a feed with no <channel> is refused rather
 * than overwritten.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ITEM = /[ \t]*<item>[\s\S]*?<\/item>[ \t]*\r?\n?/g;

// Sparkle's own order for sparkle:version: dot-separated parts, compared as numbers where both are numbers.
// Builds are commit counts (12161), but the feed still carries an early entry versioned 0.1.0.
export function compareVersions(a, b) {
  const pa = a.split('.');
  const pb = b.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '0';
    const y = pb[i] ?? '0';
    const diff = /^\d+$/.test(x) && /^\d+$/.test(y) ? Number(x) - Number(y) : x.localeCompare(y);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

function field(item, name) {
  return item.match(new RegExp(`<sparkle:${name}>([^<]*)</sparkle:${name}>`))?.[1]?.trim() ?? null;
}

/** Splits an appcast into what comes before its first entry, its entries, and what comes after the last. */
export function parseAppcast(xml, label = 'appcast') {
  const channel = xml.indexOf('<channel>');
  const close = xml.lastIndexOf('</channel>');
  if (channel < 0 || close < channel) throw new Error(`${label} has no <channel>`);
  const items = [];
  let head = null;
  let tail = null;
  for (const match of xml.matchAll(ITEM)) {
    if (match.index < channel || match.index > close) continue;
    if (head === null) head = xml.slice(0, match.index);
    let text = match[0];
    if (!text.endsWith('\n')) text += '\n';
    const build = field(text, 'version');
    const version = field(text, 'shortVersionString');
    if (!build || !version) {
      throw new Error(`${label} has an entry without a sparkle:version and a sparkle:shortVersionString`);
    }
    items.push({ text, build, version });
    tail = xml.slice(match.index + match[0].length);
  }
  if (head === null) {
    // No entries yet: they go right before </channel>, indented as its children.
    const closeLine = xml.lastIndexOf('\n', close) + 1;
    head = xml.slice(0, closeLine);
    tail = xml.slice(closeLine);
  }
  return { head, items, tail };
}

/** The feed with the release's entries in it: same-version entries replaced, newest build first. */
export function mergeAppcast(feedXml, releaseXml) {
  const release = parseAppcast(releaseXml, 'the release appcast');
  if (release.items.length === 0) throw new Error('the release appcast has no entry');
  const feed = feedXml === null ? { ...release, items: [] } : parseAppcast(feedXml, 'the published feed');
  const replaced = new Set(release.items.map((item) => item.version));
  const items = [...release.items, ...feed.items.filter((item) => !replaced.has(item.version))]
    .map((item, order) => ({ ...item, order }))
    .sort((a, b) => compareVersions(b.build, a.build) || a.order - b.order);
  return feed.head + items.map((item) => item.text).join('') + feed.tail;
}

function option(args, name) {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

export function main(args) {
  if (args[0] !== 'merge') {
    console.error('usage: sparkle-appcast.mjs merge --feed <published appcast> --release <release appcast> --out <file>');
    return 2;
  }
  const feedPath = option(args, '--feed');
  const releasePath = option(args, '--release');
  const out = option(args, '--out');
  if (!feedPath || !releasePath || !out) return main([]);
  const feed = existsSync(feedPath) ? readFileSync(feedPath, 'utf8') : null;
  const merged = mergeAppcast(feed, readFileSync(releasePath, 'utf8'));
  writeFileSync(out, merged);
  const { items } = parseAppcast(merged, out);
  console.log(`appcast: ${items.length} entries, newest ${items[0].version} (build ${items[0].build})`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exitCode = 1;
  }
}
