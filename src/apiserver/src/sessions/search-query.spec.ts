import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONTENT_MIN_CHARS, normalizeSearchQuery, stripEmphasis } from './search-query';

test('empty / whitespace-only -> null (caller answers with recents)', () => {
  assert.equal(normalizeSearchQuery(''), null);
  assert.equal(normalizeSearchQuery('   \n\t '), null);
  assert.equal(normalizeSearchQuery(undefined), null);
  assert.equal(normalizeSearchQuery(null), null);
});

test('trims and wraps into a contains-pattern', () => {
  const out = normalizeSearchQuery('  merge  ');
  assert.equal(out?.raw, 'merge');
  assert.equal(out?.pattern, '%merge%');
});

test('decodes exact UUID and Base62 public ids for direct session lookup', () => {
  const uuid = '915d27d1-b92f-4cc6-819f-174ff5be13a9';
  const publicId = '4QISUlGbd1LAaxJywzvT7x';

  assert.equal(normalizeSearchQuery(uuid)?.sessionId, uuid);
  assert.equal(normalizeSearchQuery(publicId)?.sessionId, uuid);
  assert.equal(normalizeSearchQuery('not an id')?.sessionId, null);
});

test('recognizes the conventional abbreviated UUID used for child sessions', () => {
  assert.equal(normalizeSearchQuery('915D27D1')?.sessionIdPrefix, '915d27d1');
  assert.equal(normalizeSearchQuery('915d27d1b92f')?.sessionIdPrefix, '915d27d1b92f');
  assert.equal(normalizeSearchQuery('915d27d')?.sessionIdPrefix, null);
  assert.equal(normalizeSearchQuery('915d27d1b92f4')?.sessionIdPrefix, null);
  assert.equal(normalizeSearchQuery('merge-id')?.sessionIdPrefix, null);
});

test('LIKE metacharacters are escaped so they match literally', () => {
  // Without escaping, '100%' would become '%100%%' — the trailing %% still matches everything
  // after "100", turning a literal search into a prefix search.
  assert.equal(normalizeSearchQuery('100%')?.pattern, '%100\\%%');
  assert.equal(normalizeSearchQuery('a_b')?.pattern, '%a\\_b%');
  assert.equal(normalizeSearchQuery('C:\\path')?.pattern, '%C:\\\\path%');
  // raw stays unescaped — it feeds strpos(), which is a literal search.
  assert.equal(normalizeSearchQuery('100%')?.raw, '100%');
});

test('content search is gated on the trigram floor', () => {
  assert.equal(normalizeSearchQuery('ab')?.searchContent, false);
  assert.equal(normalizeSearchQuery('abc')?.searchContent, true);
  // Chinese counts the same way — '会话' (2 chars) is the case that measured 533ms.
  assert.equal(normalizeSearchQuery('会话')?.searchContent, false);
  assert.equal(normalizeSearchQuery('会话列表')?.searchContent, true);
  assert.equal(CONTENT_MIN_CHARS, 3);
});

test('the floor counts code points, not UTF-16 units', () => {
  // Two emoji are 2 characters to pg_trgm but `.length === 4`; counting units would wrongly
  // clear the floor and hand the index a pattern it can only answer with a full scan.
  assert.equal(normalizeSearchQuery('🎉🎉')?.searchContent, false);
  assert.equal(normalizeSearchQuery('🎉🎉🎉')?.searchContent, true);
});

test('an over-long query is capped', () => {
  const out = normalizeSearchQuery('x'.repeat(500));
  assert.equal(out?.raw.length, 200);
});

test('stripEmphasis drops markdown marks but keeps identifier characters', () => {
  // What the user read is "the merge button"; what's stored is the markdown source.
  assert.equal(stripEmphasis('the **merge** button'), 'the merge button');
  assert.equal(stripEmphasis('run `npm run build`'), 'run npm run build');
  // `_` is part of the identifier, not decoration around it.
  assert.equal(stripEmphasis('file_path'), 'file_path');
  assert.equal(stripEmphasis('snake_case_name'), 'snake_case_name');
  assert.equal(stripEmphasis('plain text'), 'plain text');
});

test('a stripped query still escapes LIKE metacharacters', () => {
  // Stripping happens before normalization, so the escaping has to survive it.
  assert.equal(normalizeSearchQuery(stripEmphasis('**100%**'))?.pattern, '%100\\%%');
  assert.equal(normalizeSearchQuery(stripEmphasis('`a_b`'))?.pattern, '%a\\_b%');
  // A query of nothing but marks strips to empty, which normalizes to null rather than
  // matching every row.
  assert.equal(normalizeSearchQuery(stripEmphasis('***')), null);
});
