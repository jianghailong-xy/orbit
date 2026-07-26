import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONTENT_MIN_CHARS, normalizeSearchQuery } from './search-query';

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
