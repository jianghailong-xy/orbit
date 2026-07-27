import { describe, expect, it } from 'vitest';
import { findMatches, type FindMatch, type FindSegment } from './findMatches';

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

  it('spans segments inside one block (markdown splits a sentence across nodes)', () => {
    // "the **merge** bug" renders as three text nodes under one <p>.
    const segments = [seg('the '), seg('merge'), seg(' bug')];
    const [m] = findMatches(segments, 'the merge bug');
    expect(m).toEqual({ startSeg: 0, startOffset: 0, endSeg: 2, endOffset: 4 });
    expect(slice(segments, m)).toBe('the merge bug');
  });

  it('never spans two blocks', () => {
    // The tail of one message and the head of the next must not join into a match.
    const segments = [seg('the ', 0), seg('merge', 1)];
    expect(findMatches(segments, 'the merge')).toHaveLength(0);
    expect(findMatches(segments, 'merge')).toHaveLength(1);
  });

  it('rejoins a block whose segments are interrupted by a nested block', () => {
    // <div>keep <div>inner</div> going</div> — the outer run is split in two, so a phrase
    // straddling the nested block does not match, but each side still does.
    const segments = [seg('keep ', 0), seg('inner', 1), seg(' going', 0)];
    expect(findMatches(segments, 'keep going')).toHaveLength(0);
    expect(findMatches(segments, 'going')).toHaveLength(1);
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
    expect(findMatches(segments, '.*')).toHaveLength(0);
  });

  it('matches CJK text', () => {
    const segments = [seg('修复了合并的问题'), seg('合并到 main', 1)];
    expect(findMatches(segments, '合并')).toHaveLength(2);
  });

  it('returns nothing for an empty query', () => {
    expect(findMatches([seg('anything')], '')).toEqual([]);
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
