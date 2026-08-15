import assert from 'node:assert/strict';
import { test } from 'node:test';
import { broaden, CONTENT_MIN_CHARS, normalizeSearchQuery, stripEmphasis } from './search-query';

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

test('a normalized query matches the phrase, exactly as it always did', () => {
  assert.deepEqual(normalizeSearchQuery('confirm directory')?.patterns, [['%confirm directory%']]);
  assert.equal(normalizeSearchQuery('confirm directory')?.byWord, false);
});

test('broaden asks for each word separately, so filler and word order stop mattering', () => {
  const norm = normalizeSearchQuery('confirm directory');
  assert.ok(norm);
  const wide = broaden(norm);
  assert.deepEqual(wide?.patterns, [['%confirm%'], ['%directory%']]);
  assert.equal(wide?.byWord, true);
  // `raw` is untouched: it is what the snippet still looks for first, and what the client echoes.
  assert.equal(wide?.raw, 'confirm directory');
});

test('broaden segments Chinese, which has no spaces to split on', () => {
  const norm = normalizeSearchQuery('会话列表排序');
  assert.ok(norm);
  assert.deepEqual(broaden(norm)?.patterns, [['%会话%'], ['%列表%'], ['%排序%']]);
});

test('a term with alternatives becomes an OR group inside the AND', () => {
  // 数据库优化 segments to 数据 + a run of stray characters; requiring the run joined finds
  // nothing, so any of its adjacent pairs will do.
  const wide = broaden(normalizeSearchQuery('数据库优化')!);
  assert.deepEqual(wide?.patterns, [['%数据%'], ['%库优%', '%优化%']]);
  // Only the certain term can anchor a snippet — the row need not contain either alternative in
  // particular.
  assert.equal(wide?.anchor, '数据');
});

test('broadening re-applies the trigram floor per word', () => {
  // A word below the floor drives no index, so letting 2-character Chinese words reach the
  // conversation bodies is a 1.9s sequential scan (29ms against the name columns instead). The
  // phrase query that ran first did search those bodies, and it is the one with an index.
  assert.equal(normalizeSearchQuery('会话列表排序')?.searchContent, true);
  assert.equal(broaden(normalizeSearchQuery('会话列表排序')!)?.searchContent, false);
  // English words clear the floor as a matter of course, so nothing narrows there.
  assert.equal(broaden(normalizeSearchQuery('the merge button')!)?.searchContent, true);
  // A single short word among long ones is enough to pull the tier out.
  assert.equal(broaden(normalizeSearchQuery('an important message')!)?.searchContent, false);
});

test('there is nothing to broaden to when the query is one word', () => {
  // Also the guard that keeps a fruitless search from being run twice.
  assert.equal(broaden(normalizeSearchQuery('merge')!), null);
  assert.equal(broaden(normalizeSearchQuery('file_path')!), null);
  // A CJK particle on its own segments to nothing, so there is no broader question to ask.
  assert.equal(broaden(normalizeSearchQuery('的')!), null);
  // And a broadened query is never broadened again.
  assert.equal(broaden(broaden(normalizeSearchQuery('the merge button')!)!), null);
});

test('broaden anchors the snippet on the longest word', () => {
  // Anchoring on "the" would cut the window at the top of a 7 KB body instead of at the part the
  // user was looking for.
  assert.equal(normalizeSearchQuery('the working directory')?.anchor, 'directory');
  // One word: the anchor is the query, and the snippet's coalesce never reaches past the phrase.
  assert.equal(normalizeSearchQuery('merge')?.anchor, 'merge');
});

test('broaden escapes LIKE metacharacters per word, and leaves the anchor literal', () => {
  const wide = broaden(normalizeSearchQuery('100% a_b')!);
  assert.deepEqual(wide?.patterns, [['%100\\%%'], ['%a\\_b%']]);
  // anchor and raw feed strpos(), which is a literal search.
  assert.equal(wide?.anchor, '100%');
});

test('the word count is capped, so a pasted paragraph is a bounded number of passes', () => {
  // Dropping the tail only widens what the fallback matches, and the phrase query ran first
  // regardless.
  const many = normalizeSearchQuery(Array.from({ length: 30 }, (_, i) => `w${i}`).join(' '));
  assert.equal(broaden(many!)?.patterns.length, 8);
});

test('a stripped query still escapes LIKE metacharacters', () => {
  // Stripping happens before normalization, so the escaping has to survive it.
  assert.equal(normalizeSearchQuery(stripEmphasis('**100%**'))?.pattern, '%100\\%%');
  assert.equal(normalizeSearchQuery(stripEmphasis('`a_b`'))?.pattern, '%a\\_b%');
  // A query of nothing but marks strips to empty, which normalizes to null rather than
  // matching every row.
  assert.equal(normalizeSearchQuery(stripEmphasis('***')), null);
});
