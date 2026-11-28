import { describe, expect, it } from 'vitest';
import {
  applyReferencePick,
  chipDeletionRange,
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

  it('leaves an @ someone typed as prose until a session is picked', () => {
    // `@` names a session you picked from the menu, not any word after an `@` (an email, a handle).
    expect(segmentComposer('ask @wikova or mail a@b.co', {})).toEqual([
      { type: 'text', text: 'ask @wikova or mail a@b.co' },
    ]);
  });

  it('marks a picked session with @ and a picked project with #, never one for the other', () => {
    const both: ReferenceMap = {
      'Deploy main': { kind: 'session', id: 'S1' },
      'Runner link': { kind: 'project', id: 'P1' },
    };

    const segs = segmentComposer('@Deploy main and #Runner link, not #Deploy main', both);

    expect(segs.filter((s) => s.type === 'ref')).toEqual([
      { type: 'ref', text: '@Deploy main', kind: 'session' },
      { type: 'ref', text: '#Runner link', kind: 'project' },
    ]);
  });

  it('keeps an @ inside a reference title part of that title', () => {
    const withAt: ReferenceMap = {
      'wikids @deepseek': { kind: 'list', id: LIST_ID },
      deepseek: { kind: 'session', id: 'S1' },
    };

    const segs = segmentComposer('see #wikids @deepseek failures', withAt);

    expect(segs.filter((s) => s.type === 'ref').map((s) => s.text)).toEqual(['#wikids @deepseek']);
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

  it('escapes brackets in the title, which real task titles start with', () => {
    // `[W 009/250] …` is the shape every task in this list uses. Unescaped, the first `]` closes
    // the link text and the bubble renders the uuid the chip existed to hide.
    const bracketed: ReferenceMap = { '[W 009/250] 000_00008.parquet': { kind: 'task', id: TASK_ID } };

    expect(materializeReferences('看 #[W 009/250] 000_00008.parquet', bracketed)).toBe(
      `看 [\\[W 009/250\\] 000_00008.parquet](orbit-task:${TASK_ID})`,
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

describe('@ sessions and # projects', () => {
  it('sends a picked session and project as the links the server expands', () => {
    const picked: ReferenceMap = {
      'Deploy main': { kind: 'session', id: 'S1' },
      'Runner link [v2]': { kind: 'project', id: 'P1' },
    };

    expect(materializeReferences('@Deploy main is stuck; see #Runner link [v2]', picked)).toBe(
      '[Deploy main](orbit-session:S1) is stuck; see [Runner link \\[v2\\]](orbit-project:P1)',
    );
  });

  it('reads the @ query at the caret and replaces only it on a pick', () => {
    const typed = 'compare #Runner link with @depl';

    expect(referenceToken(typed, '@')).toBe('depl');
    expect(referenceToken(typed)).toBeNull();

    const next = applyReferencePick(typed, 'Deploy main', { kind: 'session', id: 'S1' }, {});

    expect(next.text).toBe('compare #Runner link with @Deploy main ');
    expect(next.refs).toEqual({ 'Deploy main': { kind: 'session', id: 'S1' } });
  });

  it('inserts a title holding a $ as written', () => {
    const next = applyReferencePick('@co', 'Cost $5 cap', { kind: 'session', id: 'S1' }, {});

    expect(next.text).toBe('@Cost $5 cap ');
  });
});

describe('chipDeletionRange', () => {
  const picked: ReferenceMap = { 'Deploy main': { kind: 'session', id: 'S1' } };
  const typed = 'see @Deploy main why';

  it('takes the whole chip and its space with one Backspace at its end or after the space', () => {
    expect(chipDeletionRange(typed, picked, 16, 'Backspace')).toEqual({ start: 4, end: 17 });
    expect(chipDeletionRange(typed, picked, 17, 'Backspace')).toEqual({ start: 4, end: 17 });
  });

  it('takes it with Delete at its start', () => {
    expect(chipDeletionRange(typed, picked, 4, 'Delete')).toEqual({ start: 4, end: 17 });
  });

  it('leaves other carets to delete one character', () => {
    expect(chipDeletionRange(typed, picked, 10, 'Backspace')).toBeNull();
    expect(chipDeletionRange(typed, picked, 20, 'Backspace')).toBeNull();
    expect(chipDeletionRange(typed, picked, 16, 'Delete')).toBeNull();
    expect(chipDeletionRange('see @Deploy mai why', picked, 15, 'Backspace')).toBeNull();
  });
});

describe('referenceToken after a pick', () => {
  const picked: ReferenceMap = { 'Upgrade jerry deployment': { kind: 'session', id: 'S1' } };

  it('reads no query once the trailing text is a picked chip, with or without words after it', () => {
    expect(referenceToken('@Upgrade jerry deployment ', '@', picked)).toBeNull();
    expect(referenceToken('see @Upgrade jerry deployment why is it', '@', picked)).toBeNull();
  });

  it('still reads a query typed after the chip with its own sigil', () => {
    expect(referenceToken('@Upgrade jerry deployment and @dep', '@', picked)).toBe('dep');
  });

  it('does not take a # project title for an @ session chip', () => {
    expect(referenceToken('#Upgrade jerry deployment', '#', picked)).toBe('Upgrade jerry deployment');
  });
});
