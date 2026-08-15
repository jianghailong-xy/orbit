import { describe, expect, it } from 'vitest';
import {
  applyReferencePick,
  materializeReferences,
  referenceToken,
  segmentComposer,
  type ReferenceMap,
} from './composerRefs';

const LIST_ID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const TASK_ID = '550e8400-e29b-41d4-a716-446655440000';

const refs: ReferenceMap = {
  'FineWeb CC-MAIN-2025-26': { kind: 'list', id: LIST_ID },
  'W 009/250 → WARC': { kind: 'task', id: TASK_ID },
};

/** Concatenating the segments must reproduce the input — see below for why this one matters. */
const rejoin = (text: string, map: ReferenceMap = refs) =>
  segmentComposer(text, map)
    .map((s) => s.text)
    .join('');

describe('segmentComposer', () => {
  it('keeps every character, in order, whatever it finds', () => {
    // The invariant the whole design rests on. The mirror paints these segments underneath a
    // transparent textarea, so a segmentation that dropped or added a character would slide the
    // caret away from the glyph the user sees — and the first version of this feature did
    // exactly that, invisibly, because the textarea's own text was transparent.
    for (const sample of [
      '',
      'no references here',
      '帮我看下 #FineWeb CC-MAIN-2025-26 为什么卡住了',
      '@wikova 先看 #W 009/250 → WARC，再对照 #FineWeb CC-MAIN-2025-26 的失败归因',
      '#FineWeb CC-MAIN-2025-26',
      '  @a  #FineWeb CC-MAIN-2025-26  ',
      'trailing newline\n',
    ]) {
      expect(rejoin(sample)).toBe(sample);
    }
  });

  it('marks a recorded token as a reference and leaves prose alone', () => {
    const segs = segmentComposer('帮我看下 #FineWeb CC-MAIN-2025-26 为什么卡住了', refs);

    expect(segs).toEqual([
      { type: 'text', text: '帮我看下 ' },
      { type: 'ref', text: '#FineWeb CC-MAIN-2025-26', kind: 'list' },
      { type: 'text', text: ' 为什么卡住了' },
    ]);
  });

  it('prefers the longer of two tokens where one is a prefix of the other', () => {
    // Real here: `[W 009/250] …` and `[W 009/250] … → WARC` coexist, and a shortest-match would
    // reference a different task than the one picked.
    const nested: ReferenceMap = {
      'W 009/250': { kind: 'task', id: TASK_ID },
      'W 009/250 → WARC': { kind: 'task', id: LIST_ID },
    };

    const segs = segmentComposer('看 #W 009/250 → WARC', nested);

    expect(segs.find((s) => s.type === 'ref')?.text).toBe('#W 009/250 → WARC');
  });

  it('marks @mentions, including after an opening bracket', () => {
    const segs = segmentComposer('（@wikova 看一下）', {});

    expect(segs).toEqual([
      { type: 'text', text: '（' },
      { type: 'mention', text: '@wikova' },
      { type: 'text', text: ' 看一下）' },
    ]);
  });

  it('does not treat an @ inside a reference title as a mention', () => {
    // The title has to contain a *matchable* mention for this to test the guard rather than the
    // mention pattern: `@ deepseek` has a space after the `@` and never matches at all, so a
    // fixture using it passes with the guard deleted.
    const withAt: ReferenceMap = { 'wikids @deepseek': { kind: 'list', id: LIST_ID } };

    const segs = segmentComposer('看 #wikids @deepseek 的失败', withAt);

    expect(segs.filter((s) => s.type === 'mention')).toEqual([]);
    expect(segs.find((s) => s.type === 'ref')?.text).toBe('#wikids @deepseek');
  });

  it('finds nothing to mark when nothing has been picked', () => {
    // A `#` someone typed as prose — a heading, an issue number — must stay prose.
    expect(segmentComposer('#1 完成了', {})).toEqual([{ type: 'text', text: '#1 完成了' }]);
  });
});

describe('materializeReferences', () => {
  it('expands a recorded token into the link the server understands', () => {
    expect(materializeReferences('看下 #FineWeb CC-MAIN-2025-26 的归因', refs)).toBe(
      `看下 [FineWeb CC-MAIN-2025-26](orbit-list:${LIST_ID}) 的归因`,
    );
  });

  it('expands every occurrence of the same reference', () => {
    const out = materializeReferences('#FineWeb CC-MAIN-2025-26 和 #FineWeb CC-MAIN-2025-26', refs);

    expect(out.match(/orbit-list:/g)).toHaveLength(2);
  });

  it('leaves an edited token as the literal text the user typed', () => {
    // The agreed degradation: the reference quietly does not expand. Nothing is sent that they
    // cannot see, and nothing errors.
    expect(materializeReferences('看下 #FineWeb CC-MAIN-2025 的归因', refs)).toBe(
      '看下 #FineWeb CC-MAIN-2025 的归因',
    );
  });

  it('leaves a bare # alone', () => {
    expect(materializeReferences('#1 完成了', refs)).toBe('#1 完成了');
  });
});

describe('applyReferencePick', () => {
  it('replaces only the trailing #query, leaving earlier text intact', () => {
    const out = applyReferencePick('看下 #FineWeb 和 #Fine', 'FineWeb CC-MAIN-2025-26', {
      kind: 'list',
      id: LIST_ID,
    }, {});

    expect(out.text).toBe('看下 #FineWeb 和 #FineWeb CC-MAIN-2025-26 ');
    expect(out.refs['FineWeb CC-MAIN-2025-26']).toEqual({ kind: 'list', id: LIST_ID });
  });

  it('re-points a title picked twice, keeping the newer id', () => {
    const first = applyReferencePick('#W', 'W 009/250', { kind: 'task', id: TASK_ID }, {});
    const second = applyReferencePick('#W', 'W 009/250', { kind: 'task', id: LIST_ID }, first.refs);

    expect(second.refs['W 009/250']).toEqual({ kind: 'task', id: LIST_ID });
  });
});

describe('referenceToken', () => {
  it('captures a multi-word query, since titles contain spaces', () => {
    expect(referenceToken('看下 #FineWeb CC-MAIN')).toBe('FineWeb CC-MAIN');
  });

  it('is null when there is no # being typed', () => {
    expect(referenceToken('看下 FineWeb')).toBeNull();
  });

  it('does not reach across a line break', () => {
    expect(referenceToken('#FineWeb\n第二行')).toBeNull();
  });
});
