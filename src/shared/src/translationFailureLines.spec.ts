import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TRANSLATION_UNAVAILABLE_TAG, translationFailureSentence } from './translation';

/**
 * `translation-failure-lines.fixture.json` is frame 7's B column of docs/ux/translation-failure-policy.html:
 * the failure line's first sentence per reason, on a held message and on a card answer. The web draws from
 * `translationFailureSentence`; the OrbitKit and Android copies walk the same file.
 */
const fixture = JSON.parse(readFileSync(path.join(__dirname, 'translation-failure-lines.fixture.json'), 'utf8')) as {
  unavailableTag: string;
  cases: Array<{ name: string; reason?: string; httpStatus?: number; message: string; answer: string }>;
};

describe('translationFailureSentence', () => {
  it('covers every reason frame 7 names, and the generic fallback', () => {
    const reasons = new Set(fixture.cases.map((c) => c.reason));
    for (const r of ['TIMEOUT', 'NETWORK', 'HTTP', 'TRUNCATED', 'MANGLED', 'EMPTY', 'UNAVAILABLE', undefined]) {
      expect(reasons.has(r), String(r)).toBe(true);
    }
  });

  for (const c of fixture.cases) {
    it(c.name, () => {
      expect(translationFailureSentence('message', c.reason, c.httpStatus)).toBe(c.message);
      expect(translationFailureSentence('answer', c.reason, c.httpStatus)).toBe(c.answer);
    });
  }

  it('the composer tag suffix while unavailable', () => {
    expect(TRANSLATION_UNAVAILABLE_TAG).toBe(fixture.unavailableTag);
  });
});
