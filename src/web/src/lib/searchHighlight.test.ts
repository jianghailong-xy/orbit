import { describe, expect, it } from 'vitest';
import { splitHighlight } from './searchHighlight';

/** Reassembling the segments must always reproduce the input — no character invented or dropped. */
const rejoin = (segs: { text: string }[]): string => segs.map((s) => s.text).join('');

describe('splitHighlight', () => {
  it('marks a single match and keeps the surrounding text', () => {
    const segs = splitHighlight('fix the merge bug', 'merge');
    expect(segs).toEqual([
      { text: 'fix the ', match: false },
      { text: 'merge', match: true },
      { text: ' bug', match: false },
    ]);
  });

  it('marks every occurrence, not just the first', () => {
    const segs = splitHighlight('merge after merge', 'merge');
    expect(segs.filter((s) => s.match)).toHaveLength(2);
    expect(rejoin(segs)).toBe('merge after merge');
  });

  it('handles adjacent matches without dropping or duplicating text', () => {
    const segs = splitHighlight('abab', 'ab');
    expect(segs).toEqual([
      { text: 'ab', match: true },
      { text: 'ab', match: true },
    ]);
    expect(rejoin(segs)).toBe('abab');
  });

  it('matches case-insensitively but preserves the original casing', () => {
    const segs = splitHighlight('Merge to Main', 'merge');
    expect(segs[0]).toEqual({ text: 'Merge', match: true });
    expect(rejoin(segs)).toBe('Merge to Main');
  });

  it('matches Chinese', () => {
    const segs = splitHighlight('修复会话列表的排序', '会话列表');
    expect(segs).toEqual([
      { text: '修复', match: false },
      { text: '会话列表', match: true },
      { text: '的排序', match: false },
    ]);
  });

  it('collapses whitespace in the query, mirroring the server-collapsed snippet', () => {
    // The server collapsed "SSE   keepalive" to "SSE keepalive"; a query still carrying the
    // double space must still find it.
    const segs = splitHighlight('the SSE keepalive fix', 'SSE   keepalive');
    expect(segs.filter((s) => s.match)).toEqual([{ text: 'SSE keepalive', match: true }]);
  });

  it('falls back to plain text when the query is absent or empty', () => {
    expect(splitHighlight('nothing here', 'zzz')).toEqual([{ text: 'nothing here', match: false }]);
    expect(splitHighlight('nothing here', '   ')).toEqual([{ text: 'nothing here', match: false }]);
  });

  it('returns nothing for empty text', () => {
    expect(splitHighlight('', 'merge')).toEqual([]);
  });

  it('never invents or loses characters', () => {
    for (const [text, q] of [
      ['aaa', 'a'],
      ['merge merge merge', 'merge'],
      ['会话会话', '会话'],
      ['edge', 'edge'],
    ]) {
      expect(rejoin(splitHighlight(text, q))).toBe(text);
    }
  });
});

describe('splitHighlight, on a snippet the phrase is absent from', () => {
  it('marks each word instead — the row was admitted by the words', () => {
    const segs = splitHighlight('Confirm the working directory', 'confirm directory');
    expect(segs.filter((s) => s.match).map((s) => s.text)).toEqual(['Confirm', 'directory']);
    expect(rejoin(segs)).toBe('Confirm the working directory');
  });

  it('still prefers the phrase where it is present', () => {
    const segs = splitHighlight('Confirm the working directory', 'the working directory');
    expect(segs.filter((s) => s.match).map((s) => s.text)).toEqual(['the working directory']);
  });

  it('marks the longer word where two of them overlap', () => {
    const segs = splitHighlight('there and then', 'the there');
    expect(segs.filter((s) => s.match).map((s) => s.text)).toEqual(['there', 'the']);
    expect(rejoin(segs)).toBe('there and then');
  });

  it('marks the words of a segmented Chinese query', () => {
    const segs = splitHighlight('修复了合并问题', '修复合并');
    expect(segs.filter((s) => s.match).map((s) => s.text)).toEqual(['修复', '合并']);
    expect(rejoin(segs)).toBe('修复了合并问题');
  });

  it('falls back to plain text when no word is present', () => {
    expect(splitHighlight('nothing here', 'zzz yyy')).toEqual([
      { text: 'nothing here', match: false },
    ]);
  });
});
