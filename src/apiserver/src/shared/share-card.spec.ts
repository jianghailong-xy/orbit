import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shareCardHead } from './share-card';

const meta = (head: string, key: string): string | undefined =>
  new RegExp(`<meta (?:name|property)="${key}" content="([^"]*)" />`).exec(head)?.[1];

test('a card names the root and says what kind of thing the link shares', () => {
  const head = shareCardHead({ kind: 'TASK', title: 'Add retries to webhook delivery' }, 'https://orbit.example');
  assert.match(head, /<title>Add retries to webhook delivery<\/title>/);
  assert.equal(meta(head, 'og:title'), 'Add retries to webhook delivery');
  assert.equal(meta(head, 'description'), 'A task shared from Orbit');
  assert.equal(meta(head, 'og:description'), 'A task shared from Orbit');
  assert.equal(meta(head, 'og:image'), 'https://orbit.example/icon-512.png');
});

test('each kind has its own line', () => {
  const line = (kind: 'SESSION' | 'TASK' | 'PROJECT' | 'WIKI') => meta(shareCardHead({ kind, title: 't' }, ''), 'description');
  assert.equal(line('SESSION'), 'A conversation shared from Orbit');
  assert.equal(line('PROJECT'), 'A project shared from Orbit');
  assert.equal(line('WIKI'), 'A wiki shared from Orbit');
});

test('a title is escaped, kept to its first line, and cut when long', () => {
  const head = shareCardHead({ kind: 'SESSION', title: '\n  <b>"Fix" & ship</b>  \nsecond line' }, '');
  assert.match(head, /<title>&lt;b&gt;&quot;Fix&quot; &amp; ship&lt;\/b&gt;<\/title>/);
  assert.doesNotMatch(head, /second line/);
  const long = meta(shareCardHead({ kind: 'TASK', title: 'x'.repeat(500) }, ''), 'og:title')!;
  assert.equal(long.length, 120);
  assert.ok(long.endsWith('…'));
});

test('an empty title reads Orbit', () => {
  assert.match(shareCardHead({ kind: 'SESSION', title: '  ' }, ''), /<title>Orbit<\/title>/);
});
