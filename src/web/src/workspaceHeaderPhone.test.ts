import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The conversation title bar at phone width: the title takes its row to itself and the Coordinator
 * badge and watch chips drop onto the status line under it, so ←, the Project sessions button and ⋯
 * no longer squeeze the title to a few letters. Every rule sits in the mobile block, the same
 * breakpoint as useIsMobile, so the desktop header is untouched.
 */
const css = readFileSync(new URL('./index.css', import.meta.url), 'utf8');
const rule = css.indexOf('  .workspace-header-main {\n    display: flex;');
const mobile = css.lastIndexOf('@media (max-width: 960px) {', rule);
const block = css.slice(mobile, css.indexOf('\n}\n', mobile) + 2);

describe('the conversation title bar at phone width', () => {
  it('lives in the mobile block, so the desktop header keeps one title line', () => {
    expect(rule).toBeGreaterThan(-1);
    expect(mobile).toBeGreaterThan(-1);
    expect(block).toContain('  .workspace-header-main {\n    display: flex;\n    flex-wrap: wrap;');
    // Outside every media block the title line still lays the title and its badges out in one row.
    expect(css).toMatch(/\n\.workspace-header-main \{\n  flex: 1;\n  min-width: 0;\n\}/);
    expect(css).toMatch(/\n\.workspace-title-line \{\n  display: flex;/);
  });

  it('gives the title a row to itself and sends the badges onto the status line', () => {
    expect(block).toContain('.workspace-header-main > .workspace-title-line {\n    display: contents;\n  }');
    expect(block).toMatch(/\.workspace-title-line > \.workspace-name,\n  \.workspace-title-line > \.workspace-name-input \{\n    flex: 0 0 100%;/);
  });

  it('wraps the status text under the badges rather than cutting it beside them', () => {
    expect(block).toMatch(/\.workspace-header-main > \.workspace-sub \{\n    flex: 1 1 auto;\n    min-width: 0;[^}]*text-overflow: ellipsis;/);
  });
});
