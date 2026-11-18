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
type Case = (typeof fixture.cases)[number];

/** The board itself: the fixture is held to it, so a sentence changed on the board and not here (or the reverse) fails. */
const board = readFileSync(path.join(__dirname, '../../../docs/ux/translation-failure-policy.html'), 'utf8');
const plain = (html: string) => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
/** Frame 7's rows: the reason cell and the B column (its last cell). */
function frame7Rows(): Array<{ reasons: string; b: string }> {
  const start = board.indexOf('7 · Reason copy');
  const table = board.slice(start, board.indexOf('</table>', start));
  return [...table.matchAll(/<tr>(.*?)<\/tr>/g)]
    .map((m) => [...m[1].matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((c) => plain(c[1])))
    .filter((cells) => cells.length > 0)
    .map((cells) => ({ reasons: cells[0], b: cells[cells.length - 1] }));
}
/** The fixture cases a frame-7 row speaks for, read off its reason cell. */
function casesOf(reasons: string): Case[] {
  const retried = (s?: number) => s === 429 || (s !== undefined && s >= 500);
  if (reasons.includes('HTTP 429/5xx')) {
    return fixture.cases.filter((c) => c.reason === 'NETWORK' || (c.reason === 'HTTP' && retried(c.httpStatus)));
  }
  if (reasons.includes('HTTP other 4xx')) {
    return fixture.cases.filter(
      (c) => c.reason === 'HTTP' && c.httpStatus !== undefined && c.httpStatus >= 400 && c.httpStatus < 500 && !retried(c.httpStatus),
    );
  }
  const codes = reasons.match(/[A-Z_]{4,}/g) ?? [];
  return fixture.cases.filter((c) => c.reason !== undefined && codes.includes(c.reason));
}
const answerOf = (message: string) => message.replace(/, so it wasn't sent$/, ", so your answer wasn't sent");

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

  describe('the fixture is the board', () => {
    const rows = frame7Rows();

    it("frame 7 has its six B-column sentences, each ending \"so it wasn't sent\"", () => {
      expect(rows.map((r) => r.reasons)).toEqual([
        'TIMEOUT',
        'NETWORK, HTTP 429/5xx',
        'HTTP other 4xx',
        'TRUNCATED',
        'MANGLED, EMPTY',
        'Circuit open (UNAVAILABLE)',
      ]);
      for (const r of rows) expect(r.b).toMatch(/, so it wasn't sent$/);
    });

    for (const row of frame7Rows()) {
      it(`frame 7: ${row.reasons}`, () => {
        const cases = casesOf(row.reasons);
        expect(cases.length, `the fixture has a case for ${row.reasons}`).toBeGreaterThan(0);
        for (const c of cases) {
          expect(c.message, c.name).toBe(row.b);
          // Frame 5: a card answer has "the same wording as a message", naming "your answer".
          expect(c.answer, c.name).toBe(answerOf(row.b));
        }
      });
    }

    it('every other case is the generic line frame 2 draws today', () => {
      const covered = new Set(rows.flatMap((r) => casesOf(r.reasons)));
      const rest = fixture.cases.filter((c) => !covered.has(c));
      expect(rest.map((c) => c.name).sort()).toEqual(
        ['HTTP 302 (not a 4xx or 5xx)', 'HTTP with no status', 'NO_KEY', 'a reason this client does not know', 'no reason'].sort(),
      );
      for (const c of rest) {
        expect(c.message, c.name).toBe("Couldn't translate, so it wasn't sent");
        expect(c.answer, c.name).toBe("Couldn't translate, so it wasn't sent");
      }
      expect(plain(board)).toContain("Couldn't translate, so it wasn't sent");
    });

    it("frames 4B and 5 draw their examples from the same rows, and frame 6's tag is the fixture's", () => {
      const text = plain(board);
      expect(text).toContain("The translator didn't answer in time, so it wasn't sent · Retry · Send as written");
      expect(text).toContain('The translator was unreachable, so your answer wasn\'t sent · Retry · Send as written');
      expect(text).toContain(`Chinese → English · ${fixture.unavailableTag}`);
    });
  });

  /** OrbitKit and Android run their own copies against this fixture (TranslationFailureLinesParityTests,
   *  TranslationFailureLinesParityTest). This reads their sources too, so one run on any host compares all three. */
  describe('OrbitKit and Android say the same words', () => {
    const repo = path.join(__dirname, '../../..');
    const read = (rel: string) => readFileSync(path.join(repo, rel), 'utf8');
    const literals = (code: string) => [...code.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
    const clauses = [
      ...new Set(
        fixture.cases.map((c) => c.message).filter((m) => m !== "Couldn't translate, so it wasn't sent").map((m) => m.replace(/, so it wasn't sent$/, '')),
      ),
    ].sort();

    it('OrbitKit TranslationCopy', () => {
      const swift = read('src/macos/OrbitKit/Sources/OrbitKit/Models/Translation.swift');
      const cause = swift.slice(swift.indexOf('private static func failureCause('), swift.indexOf('// "Show both languages" in a conversation'));
      expect(cause.length).toBeGreaterThan(0);
      expect([...new Set(literals(cause))].sort()).toEqual(clauses);
      expect(swift).toContain('return "\\(cause), so \\(answer ? "your answer" : "it") wasn\'t sent"');
      expect(swift).toContain(`public static let sendFailed = "Couldn't translate, so it wasn't sent"`);
      expect(swift).toContain(`public static let unavailableTag = "${fixture.unavailableTag}"`);
    });

    it('Android TranslationFailureCopy', () => {
      const kt = read('src/android/app/src/main/kotlin/io/orbitd/android/translation/TranslationViews.kt');
      const start = kt.indexOf('object TranslationFailureCopy {');
      const copy = kt.slice(start, kt.indexOf('\n}\n', start));
      const consts = Object.fromEntries([...copy.matchAll(/const val (\w+) = "([^"]*)"/g)].map((m) => [m[1], m[2]]));
      const { MESSAGE_NOT_SENT, ANSWER_NOT_SENT, COMPOSER_UNAVAILABLE, ...rest } = consts;
      expect(Object.values(rest).sort()).toEqual(clauses);
      expect(MESSAGE_NOT_SENT).toBe(", so it wasn't sent");
      expect(ANSWER_NOT_SENT).toBe(", so your answer wasn't sent");
      expect(COMPOSER_UNAVAILABLE).toBe(fixture.unavailableTag);
      expect(kt).toContain(`const val SEND_FAILED = "Couldn't translate, so it wasn't sent"`);
    });
  });

  it('the composer tag suffix while unavailable', () => {
    expect(TRANSLATION_UNAVAILABLE_TAG).toBe(fixture.unavailableTag);
  });
});
