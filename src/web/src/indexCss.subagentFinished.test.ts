import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The SubAgent finished line (components/SubagentFinishedCard) is purple while its run finished and
 * red when it did not. The first build set the dark theme's purple under `:root[data-theme='dark']`,
 * which outranked `.sawake.is-failed`, so a failed run's ✦ and the rule beside its result stayed
 * purple in dark. The purple is now scoped to the line that finished, in both themes.
 *
 * Its result is clamped to three lines. A `max-height` taken from the wrapper's 13px font cut the
 * third line of the 14px Markdown through its glyphs and its code chips; the clamp is now the
 * Markdown box's own line clamp.
 */
const css = readFileSync(new URL('./index.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '');

/** Every top-level rule, as [selector list, declarations]. */
const rules = [...css.matchAll(/(?:^|\n)([^{}\n/][^{}]*?)\s*\{([^}]*)\}/gu)].map((m) => [m[1].trim(), m[2]] as const);

function rule(selector: string): string {
  const found = rules.find(([selectors]) => selectors.split(',').map((s) => s.trim()).includes(selector));
  if (!found) throw new Error(`index.css has no top-level rule for ${selector}`);
  return found[1];
}

const PURPLE = /#7c3aed|#a78bfa|#c4b5fd|rgba\(167, 139, 250/u;

describe('the SubAgent finished line', () => {
  it('draws purple only on a line whose run finished, in either theme', () => {
    const purple = rules.filter(([selectors, body]) => /\.sawake/u.test(selectors) && PURPLE.test(body));
    expect(purple.length).toBeGreaterThan(0);
    for (const [selectors] of purple) {
      for (const selector of selectors.split(',').map((s) => s.trim())) {
        // The mark and the result's rule: purple only where the line is not a failure.
        if (/bgwake-mark|sawake-outcome/u.test(selector)) expect(selector).toContain(':not(.is-failed)');
      }
    }
  });

  it('turns a failed run’s mark and result rule to the error colour', () => {
    expect(rule('.sawake.is-failed .bgwake-mark')).toContain('color: var(--error-solid)');
    // The rule beside a failed result is the base rule's; only one that finished overrides it.
    expect(rule('.sawake-outcome')).toContain('border-left: 2px solid var(--error-solid)');
    expect(rule(':root[data-theme=\'dark\'] .sawake-outcome:not(.is-failed)')).toMatch(PURPLE);
  });

  it('clamps the result on the Markdown’s own lines, with no height that could cut one through', () => {
    const clamp = rule('.sawake-result-md.is-clamped > .md');
    expect(clamp).toContain('-webkit-line-clamp: 3');
    expect(clamp).toContain('display: -webkit-box');
    expect(clamp).toContain('overflow: hidden');
    expect(clamp).not.toContain('max-height');
  });
});
