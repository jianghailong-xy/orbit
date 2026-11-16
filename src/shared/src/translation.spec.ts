import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bilingualPairs, type BilingualPair } from './translation';

/**
 * `bilingual-pairs.fixture.json` is how a reply and its translation pair block by block ("Show both
 * languages", 03-interleaved.png). This walks it through `bilingualPairs`, which the web draws from;
 * OrbitKit's BilingualPairsFixtureTests and Android core's BilingualPairsTest walk the same file.
 */
const fixture = JSON.parse(readFileSync(path.join(__dirname, 'bilingual-pairs.fixture.json'), 'utf8')) as {
  cases: Array<{ name: string; translation: string; original: string; pairs: BilingualPair[] | null }>;
};

describe('bilingualPairs', () => {
  it('has the cases the board asks for', () => {
    const names = fixture.cases.map((c) => c.name);
    for (const kind of ['paragraphs', 'headings', 'nested lists', 'code blocks', 'merged two paragraphs']) {
      expect(names.some((n) => n.includes(kind)), kind).toBe(true);
    }
  });

  for (const c of fixture.cases) {
    it(c.name, () => {
      expect(bilingualPairs(c.translation, c.original)).toEqual(c.pairs);
    });
  }
});
