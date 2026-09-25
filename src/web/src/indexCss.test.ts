import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * index.css is one stylesheet, and this holds it to that.
 *
 * On 2026-09-25 a Wiki commit (c00eefef3) pasted 13,524 lines of an older copy of the sheet back into
 * the middle of it. Every top-level rule then existed twice, and the stale copy — later in the file —
 * won the cascade over the live one: it quietly undid a fix made the same afternoon (ce4c38307, the
 * drawer's running dot), and the next commits to touch the file landed their rules in either copy.
 * Nothing said so until three tests that each happen to count one selector went red.
 *
 * So the count is held here for every selector at once: a top-level rule's selector is written once.
 * Six were already written twice in the sheet the paste landed on (c00eefef3^); they are held at the
 * two they had rather than judged here. At-rules are not counted — `@media (max-width: 600px)` is
 * meant to recur beside each thing it adjusts.
 */
const css = readFileSync(new URL('./index.css', import.meta.url), 'utf8');

const WRITTEN_TWICE_BEFORE = new Map<string, number>([
  [':root', 2],
  ['.ant-message-notice:has(.toast-err)', 2],
  ['.runner-sub', 2],
  ['.wt-diff-body', 2],
  ['.wt-diff-view', 2],
  ['.tdp-compose', 2],
]);

/** Each top-level rule's selector and the line its `{` is on. Comments are blanked, not removed, so
 *  the line numbers are the file's own. */
function topLevelRules(sheet: string): Array<{ selector: string; line: number }> {
  const code = sheet.replace(/\/\*[\s\S]*?\*\//gu, (comment) => comment.replace(/[^\n]/gu, ' '));
  const rules: Array<{ selector: string; line: number }> = [];
  let depth = 0;
  let line = 1;
  let prelude = '';
  for (const ch of code) {
    if (ch === '\n') line += 1;
    if (ch === '{') {
      const selector = prelude.replace(/\s+/gu, ' ').trim();
      if (depth === 0 && !selector.startsWith('@')) rules.push({ selector, line });
      depth += 1;
      prelude = '';
    } else if (ch === '}') {
      depth -= 1;
      prelude = '';
    } else if (ch === ';') {
      prelude = '';
    } else if (depth === 0) {
      prelude += ch;
    }
  }
  return rules;
}

/** Every selector written more often than it may be, with the lines it is written on. */
function writtenTooOften(sheet: string): string[] {
  const lines = new Map<string, number[]>();
  for (const { selector, line } of topLevelRules(sheet)) {
    lines.set(selector, [...(lines.get(selector) ?? []), line]);
  }
  return [...lines]
    .filter(([selector, at]) => at.length > (WRITTEN_TWICE_BEFORE.get(selector) ?? 1))
    .map(([selector, at]) => `${selector} — lines ${at.join(', ')}`);
}

describe('index.css', () => {
  it('writes each top-level rule once', () => {
    const offenders = writtenTooOften(css);
    expect(
      offenders,
      `${offenders.length} selectors have more than one top-level rule. A later rule silently wins over an earlier one with the same selector, so merge them into one — and if hundreds are listed, a copy of the sheet has been pasted into itself:\n${offenders.slice(0, 20).join('\n')}`,
    ).toEqual([]);
  });

  it('is read the way a browser reads it, so a pasted copy cannot pass', () => {
    const rules = topLevelRules(css);
    // A reader that found nothing would pass the test above on any file at all.
    expect(rules.length).toBeGreaterThan(2000);
    expect(rules.filter((rule) => rule.selector === '.app-nav')).toHaveLength(1);
    // Nested rules belong to their at-rule, not to the top level.
    expect(topLevelRules('@media (max-width: 600px) { .a { color: red; } }\n.a { color: blue; }')).toEqual([
      { selector: '.a', line: 2 },
    ]);
    // And the accident itself: the sheet pasted into itself is caught rule by rule.
    expect(writtenTooOften(`${css}\n${css}`).length).toBeGreaterThan(2000);
  });
});
