import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The desktop Wiki home fills the main region (mock 29): no 1040px cap, the directory sticky beside
 * it, and the cards placed by a grid that opens once the main column has room. Every rule sits in
 * the desktop-only block, so the phone's one column (pinned by the native parity tests) is untouched.
 */
const css = readFileSync(new URL('./index.css', import.meta.url), 'utf8');
const start = css.indexOf('/* ── the desktop home fills the main region (mock 29)');
const block = css.slice(start, css.indexOf('\n}\n', css.indexOf('@media (min-width: 961px) {', start)) + 2);

describe('the desktop Wiki home', () => {
  it('lives in one desktop-only block', () => {
    expect(start).toBeGreaterThan(-1);
    expect(block).toContain('@media (min-width: 961px) {');
  });

  it('drops the page cap on the home alone', () => {
    expect(block).toContain('.wk-page:has(> .wk-layout.home) { max-width: none; }');
    expect(css).toContain('.wk-page { max-width: 1040px; margin: 0 auto; }');
  });

  it('keeps the directory beside the page, scrolling on its own', () => {
    expect(block).toMatch(/\.wk-layout\.home > \.wk-dir-col \{ position: sticky; top: 0; max-height: [^;]+; overflow-y: auto;/);
  });

  it('places the cards by the main column’s width, not the window’s', () => {
    expect(block).toContain('.wk-layout.home > .wk-main { container: wk-home / inline-size; }');
    expect(block).toContain('@container wk-home (min-width: 760px) {');
    expect(block).toContain('.wk-cols > .wk-col { display: contents; }');
    expect(block).toContain('.wk-cols > .wk-col:last-child > .wk-card:last-child { grid-column: 3; grid-row: 1 / -1; }');
    expect(block).toContain('@container wk-home (min-width: 1400px) {');
  });
});
