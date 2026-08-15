import { describe, expect, it } from 'vitest';
import { findMatches, queryWords, type FindMatch, type FindSegment } from './findMatches';

/** Shorthand: segments of one block unless a block number is given. */
const seg = (text: string, block = 0): FindSegment => ({ text, block });

/** The text a match covers, reassembled from the segments — the property that actually matters:
 *  a Range built from these offsets must select exactly the query. */
const slice = (segments: FindSegment[], m: FindMatch): string =>
  segments
    .slice(m.startSeg, m.endSeg + 1)
    .map((s, i) => {
      const start = i === 0 ? m.startOffset : 0;
      const end = m.startSeg + i === m.endSeg ? m.endOffset : s.text.length;
      return s.text.slice(start, end);
    })
    .join('');

describe('findMatches', () => {
  it('finds a match inside one segment', () => {
    const segments = [seg('fix the merge bug')];
    const [m, ...rest] = findMatches(segments, 'merge');
    expect(rest).toHaveLength(0);
    expect(m).toEqual({ startSeg: 0, startOffset: 8, endSeg: 0, endOffset: 13 });
    expect(slice(segments, m)).toBe('merge');
  });

  it('ignores case', () => {
    const segments = [seg('Merge to MAIN')];
    expect(findMatches(segments, 'merge')).toHaveLength(1);
    expect(findMatches(segments, 'main')).toHaveLength(1);
  });

  it('spans segments inside one block (markdown splits a word across nodes)', () => {
    // "**mer**ge" renders as two text nodes under one <p>.
    const segments = [seg('the '), seg('mer'), seg('ge bug')];
    const [m] = findMatches(segments, 'merge');
    expect(m).toEqual({ startSeg: 1, startOffset: 0, endSeg: 2, endOffset: 2 });
    expect(slice(segments, m)).toBe('merge');
  });

  it('never spans two blocks', () => {
    // The tail of one message and the head of the next must not join into a match.
    const segments = [seg('mer', 0), seg('ge', 1)];
    expect(findMatches(segments, 'merge')).toHaveLength(0);
    expect(findMatches(segments, 'ge')).toHaveLength(1);
  });

  it('does not rejoin a block whose segments are interrupted by a nested block', () => {
    // <div>kee<div>inner</div>p</div> — the outer run is split in two, so a word straddling the
    // nested block does not match, but what is inside it still does.
    const segments = [seg('kee', 0), seg('inner', 1), seg('p', 0)];
    expect(findMatches(segments, 'keep')).toHaveLength(0);
    expect(findMatches(segments, 'inner')).toHaveLength(1);
  });

  it('matches each word on its own, so order and filler words do not matter', () => {
    // The point of the whole thing: half-remembering a line still finds it.
    const segments = [seg('Confirm the working directory')];
    expect(findMatches(segments, 'directory confirm').map((m) => slice(segments, m))).toEqual([
      'Confirm',
      'directory',
    ]);
  });

  it('prefers the longer word where two of them overlap', () => {
    const segments = [seg('there')];
    expect(findMatches(segments, 'the there').map((m) => slice(segments, m))).toEqual(['there']);
  });

  it('drops markdown marks from the query, since the transcript renders without them', () => {
    const segments = [seg('the merge button')];
    expect(findMatches(segments, '**merge**')).toHaveLength(1);
    expect(findMatches(segments, '`merge`')).toHaveLength(1);
  });

  it('returns every occurrence in document order', () => {
    const segments = [seg('merge, then merge again', 0), seg('merge once more', 1)];
    const hits = findMatches(segments, 'merge');
    expect(hits).toHaveLength(3);
    expect(hits.map((m) => slice(segments, m))).toEqual(['merge', 'merge', 'merge']);
    expect(hits.map((m) => [m.startSeg, m.startOffset])).toEqual([
      [0, 0],
      [0, 12],
      [1, 0],
    ]);
  });

  it('handles adjacent matches', () => {
    const segments = [seg('abab')];
    expect(findMatches(segments, 'ab').map((m) => m.startOffset)).toEqual([0, 2]);
  });

  it('treats the query as literal text, not a pattern', () => {
    const segments = [seg('a.b axb 100% a_b')];
    expect(findMatches(segments, 'a.b')).toHaveLength(1);
    expect(findMatches(segments, '100%')).toHaveLength(1);
    expect(findMatches(segments, 'a_b')).toHaveLength(1);
    // `.+` rather than `.*`: an asterisk is a markdown mark and is dropped before matching, so
    // that one would legitimately search for a literal dot.
    expect(findMatches(segments, '.+')).toHaveLength(0);
    expect(findMatches(segments, 'a|b')).toHaveLength(0);
  });

  it('matches CJK text', () => {
    const segments = [seg('修复了合并的问题'), seg('合并到 main', 1)];
    expect(findMatches(segments, '合并')).toHaveLength(2);
  });

  it('segments a Chinese query, which has no spaces to split on', () => {
    // The phrase isn't there (a 了 sits between the two words), so the words carry it.
    const segments = [seg('修复了合并问题')];
    expect(findMatches(segments, '修复合并').map((m) => slice(segments, m))).toEqual([
      '修复',
      '合并',
    ]);
  });

  it('paints a phrase hit as one run, not as its separate words', () => {
    const segments = [seg('Confirm the working directory')];
    expect(
      findMatches(segments, 'the working directory').map((m) => slice(segments, m)),
    ).toEqual(['the working directory']);
  });

  it('returns nothing for an empty query', () => {
    expect(findMatches([seg('anything')], '')).toEqual([]);
    expect(findMatches([seg('anything')], '  ')).toEqual([]);
    expect(findMatches([seg('anything')], '**')).toEqual([]);
  });

  it('skips empty segments without shifting offsets', () => {
    const segments = [seg(''), seg('merge'), seg('')];
    const [m] = findMatches(segments, 'merge');
    expect(slice(segments, m)).toBe('merge');
  });

  it('stops at the limit', () => {
    const segments = [seg('a'.repeat(50))];
    expect(findMatches(segments, 'a', 10)).toHaveLength(10);
  });
});

describe('queryWords', () => {
  it('offers the phrase and its words, longest first', () => {
    // Longest first is what the caller's alternation needs: the phrase has to win wherever it is
    // present, or a phrase hit would be painted as three separate words.
    expect(queryWords('the merge button')).toEqual(['the merge button', 'button', 'merge', 'the']);
  });

  it('segments Chinese, which the server does too', () => {
    expect(queryWords('会话列表排序')).toEqual(['会话列表排序', '会话', '列表', '排序']);
  });

  it('is just the query when there is nothing to split', () => {
    expect(queryWords('  merge  ')).toEqual(['merge']);
    expect(queryWords('')).toEqual([]);
    expect(queryWords('**')).toEqual([]);
  });

  it('deduplicates, so a repeated word is not alternated twice', () => {
    expect(queryWords('merge merge')).toEqual(['merge merge', 'merge']);
  });
});
