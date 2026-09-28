import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WikiSource } from './wiki';
import { wikiSourceLink, wikiSourceRefText, wikiSourceWord } from '../components/WikiSources';

/**
 * An imported file is a `note` (contracts/wiki.contract.json `import`, criterion 1): the entries a
 * local model read in it cite the note by its id, and the server keeps the file it came from as the
 * source's locator, `{ path }`. What the entry drawer's Sources section makes of that is the file's
 * path under the word Note — no Orbit page to link, since a note has none.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CONTRACT: any = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../contracts/wiki.contract.json'), 'utf8'));

describe('an imported note as a source', () => {
  it('is a source kind the contract declares, whose locator is the file', () => {
    expect(Object.keys(CONTRACT.sourceKinds)).toContain('note');
    expect(CONTRACT.import.tables).toEqual(['wiki_note']);
    expect(CONTRACT.import.source).toMatch(/Its locator is \{ path \}/u);
  });

  it('reads as the file it came from, under the word Note, with no card to open', () => {
    const source: WikiSource = {
      id: 'source-1',
      kind: 'note',
      ref: '34WLbvrZ2SKHshXeJhZNn',
      locator: { path: 'memory/prefers-chinese.md' },
      quote: 'Reply in Chinese',
      quoteVerified: true,
      state: 'live',
      tainted: false,
      createdAt: '2026-09-28T02:00:00.000Z',
    };
    expect(wikiSourceWord(source)).toBe('Note');
    expect(wikiSourceRefText(source)).toBe('memory/prefers-chinese.md');
    expect(wikiSourceLink(source)).toBeNull();
  });
});
