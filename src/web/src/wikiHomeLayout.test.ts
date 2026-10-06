import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The desktop Wiki fills the main region (mocks 29, 33): no 1040px cap, a reading page centred, the directory sticky
 * beside it, and the home's cards and Activity's placed by grids that open by the main column's own width. Every rule
 * sits in the desktop-only block, so the phone's one column (pinned by the native parity tests) is untouched.
 */
const css = readFileSync(new URL('./index.css', import.meta.url), 'utf8');
const start = css.indexOf('/* ── the desktop Wiki fills the main region (mocks 29, 33)');
const block = css.slice(start, css.indexOf('\n}\n', css.indexOf('@media (min-width: 961px) {', start)) + 2);

/** One `@container` rule of the desktop block, from its head to its own closing brace. */
function container(query: string): string {
  const at = block.indexOf(`  @container ${query} {`);
  expect(at, query).toBeGreaterThan(-1);
  return block.slice(at, block.indexOf('\n  }\n', at) + 4);
}

describe('the desktop Wiki', () => {
  it('lives in one desktop-only block', () => {
    expect(start).toBeGreaterThan(-1);
    expect(block).toContain('@media (min-width: 961px) {');
  });

  it('drops the page cap on every page, and centres a reading page at a reading width', () => {
    expect(block).toContain('.wk-page { max-width: none; }');
    expect(block).toContain('.wk-page--reading > .wk-layout > .wk-main > * { max-width: 880px; margin-inline: auto; }');
  });

  it('keeps the directory beside every page, scrolling on its own', () => {
    expect(block).toMatch(/\.wk-layout > \.wk-dir-col \{ position: sticky; top: 0; max-height: [^;]+; overflow-y: auto;/);
  });
});

/**
 * The home on a desktop (design §12.3.1, mock 33 ① ②): its content, a card a category — one column, two once the main
 * column has 1100px, the principles across both — and nothing else. The rows inside the cards are the phone's, in the
 * phone's order: a desktop only boxes them.
 */
describe('the home on a desktop', () => {
  it('draws each category as a card, by the main column’s width: one column, two from 1100px', () => {
    expect(block).toContain('.wk-layout.home > .wk-main { container: wk-home / inline-size; }');
    expect(block).toContain('.wk-home { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; align-items: start; }');
    expect(block).toMatch(/\.wk-home > \.wk-pl-cat \{ margin: 0; padding: [^;]+; border: 1px solid var\(--border-subtle\); border-radius: 10px;/);
    const two = container('wk-home (min-width: 1100px)');
    expect(two).toContain('.wk-home { grid-template-columns: repeat(2, minmax(0, 1fr)); }');
    expect(two).toContain('.wk-home > .wk-home-pr, .wk-home > .wk-home-new { grid-column: 1 / -1; }');
  });

  it('has no right rail and no Browse · A–Z line, which the directory has atop it', () => {
    // The rail's grid went with the last component that drew it.
    expect(css).not.toMatch(/\.wk-cols?(?![\w-])/);
    expect(css).toContain('.wk-home-more { display: none;');
    expect(block).not.toContain('.wk-home-more');
  });
});

/**
 * Activity on a desktop (design §12.3.2, mock 33 ④ ⑤): the home's old cards in the grid they had there (mock 29) — Review
 * and Plan side by side on top, Recent decisions and Recently changed across under them, Agents used the wiki as the
 * right rail; from 1400px the decisions beside the changes — by the main column's own width. And what waits in another
 * space is there too (design §12.3.3): its plan banners over the cards; the Review card's long words break.
 */
describe('Activity on a desktop', () => {
  it('places its cards in the home’s old grid, by the main column’s width', () => {
    expect(block).toContain('.wk-page--activity > .wk-layout > .wk-main { container: wk-act / inline-size; }');
    const grid = container('wk-act (min-width: 760px)');
    expect(grid).toContain('.wk-act-cards { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) clamp(290px, 26%, 380px);');
    expect(grid).toContain('.wk-act-cards > .wk-card { grid-column: 1 / span 2; }');
    expect(grid).toContain('.wk-act-cards > .wk-review-card { grid-column: 1; grid-row: 1;');
    expect(grid).toContain('.wk-act-cards > .wk-plan-card { grid-column: 2; grid-row: 1;');
    expect(grid).toContain('.wk-act-cards:not(:has(> .wk-plan-card)) > .wk-review-card { grid-column: 1 / span 2; }');
    expect(grid).toContain('.wk-act-cards > .wk-changed-card + .wk-card { grid-column: 3; grid-row: 1 / -1; }');
    // Recently changed: a run per line.
    expect(grid).toContain('.wk-tl-run > div { display: grid;');
    const wide = container('wk-act (min-width: 1400px)');
    expect(wide).toContain('.wk-act-cards > .wk-decisions-card, .wk-act-cards > .wk-changed-card { grid-column: auto; grid-row: 2; }');
  });

  it('draws another space’s plan banners on a desktop too, where the cards stand for its own banners', () => {
    expect(css).toContain('\n.wk-banner { display: none;');
    expect(css).toContain('\n.wk-banner.wk-plan-banner.elsewhere { display: flex; }');
  });

  it('breaks a long word in a Review row where the card ends, rather than cutting it off', () => {
    expect(css).toMatch(/\n\.wk-rv-row \.t \{[^}]*-webkit-line-clamp: 2;[^}]*overflow-wrap: anywhere; \}/);
  });
});

/**
 * Activity (design §12.3.2): on a desktop it stands in the Wiki's frame with the space's name in the
 * head and the home's line under it (mock 33 ④ ⑤); on a phone (mock 31 ②) it drops that head and its line
 * for its own — `← Wiki`, the title and the space's name — and draws the status row as one line of words,
 * as the home does. Read out of the phone block, so the rules cannot land where a desktop would apply them.
 */
const phoneStart = css.indexOf('@media (max-width: 960px) {\n  .wk-page { display: flex; flex-direction: column; }');
const phone = css.slice(phoneStart, css.indexOf('\n}\n', phoneStart) + 2);

describe('Activity', () => {
  it('names the space in the Wiki head on a desktop, and in its own head on a phone', () => {
    expect(css).toContain('.wk-act-head .wk-space-tag { display: none; }');
    expect(phoneStart).toBeGreaterThan(-1);
    expect(phone).toContain('.wk-act-head .wk-space-tag { display: inline-flex; }');
  });

  it('draws its own head on a phone: no Wiki head or search over it, and `← Wiki` for the crumb', () => {
    expect(phone).toContain('.wk-page--activity > .wk-title-row, .wk-page--activity > .wk-search { display: none; }');
    expect(phone).toContain('.wk-page--activity > .wk-home-state { display: none; }');
    expect(css).toContain('.wk-crumb--back .back { display: none; }');
    expect(phone).toContain('.wk-crumb--back .ic, .wk-crumb--back > span { display: none; }');
    expect(phone).toContain('.wk-crumb--back .back { display: inline-flex; margin-right: 4px; }');
  });

  it('draws the status row on a phone as one line of words, as the home does', () => {
    expect(phone).toContain('.wk-act > .wk-status-row { margin-top: 6px; background: none; border: 0; border-radius: 0; }');
    expect(phone).toContain('.wk-act > .wk-status-row .project-integration-facts { display: block; line-height: 1.6; }');
  });
});

/**
 * The home on a phone (design §12.3.1, mocks 30 ③ and 31 ①): the head, the line under it, the search, then
 * the content — the principles, the documents by category, and Browse by category · A–Z index, which is the
 * phone's alone. Nothing of how the wiki is kept stands on it any more, so the phone block has no rule for
 * the old blocks: no status row under the head, no two columns to stack. The documents are the plan page's
 * phone rows, which the home draws at every width.
 */
describe('the home on a phone', () => {
  it('keeps the head, the line under it and the search in that order, the content after them', () => {
    expect(phone).toContain('.wk-page > .wk-title-row { order: 0; }');
    expect(phone).toContain('.wk-page > .wk-search { order: 2; margin-top: 12px; height: 40px; }');
    expect(phone).toContain('.wk-page > .wk-layout, .wk-page > .wk-body { order: 3; }');
    // The line comes right after the head in the page, so it needs no order of its own; the status row is
    // Activity's, under its own title.
    expect(css).toContain('.wk-home-state { margin-top: 6px;');
    expect(phone).not.toMatch(/\.wk-page > \.wk-home-state[ .{]/);
    expect(phone).not.toMatch(/\.wk-page > \.wk-status-row[ .{]/);
  });

  it('has no rule for the blocks that went to Activity', () => {
    expect(phone).not.toContain('.wk-cols');
  });

  it('ends on Browse by category · A–Z index, which a desktop has atop the directory instead', () => {
    expect(css).toContain('.wk-home-more { display: none;');
    // Written as the block's other rules are, so it outranks the base rule wherever the sheet puts that.
    expect(phone).toContain('.wk-home > .wk-home-more { display: flex; }');
  });

  it('draws a document as the plan page’s phone row on every width, its lead a shade darker than a question', () => {
    expect(css).toContain('\n.wk-pl-doc.phone { grid-template-columns: 34px minmax(0, 1fr) 12px;');
    expect(css).not.toContain('\n  .wk-pl-doc.phone {');
    expect(css).toContain('.wk-pl-doc .main > .q.lead { color: var(--text-2); }');
    expect(css).toContain('.wk-pl-doc.todo .main > .t { color: var(--text-3); }');
  });
});
