import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The conversation title bar at phone width: one row — ←, the title (or the capsule naming the
 * reader's last question), its badges, ⋯. The status line that used to sit under it is gone (owner,
 * 2026-11-26); its Follow, tags, run state and time live in ⋯ and the session's settings. Every rule
 * sits in the mobile block, the same breakpoint as useIsMobile, so the desktop header is untouched.
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

  it('keeps the title and its badges on the one row, the title taking what is left', () => {
    expect(block).toContain('.workspace-header-main > .workspace-title-line {\n    display: flex;\n    flex-wrap: nowrap;');
    expect(block).toMatch(/\.workspace-title-line > \.workspace-name \{\n    flex: 1 1 auto;\n    min-width: 0;/);
    // Not the old shape, where the title line stepped aside and the title claimed a full row.
    expect(block).not.toContain('.workspace-title-line {\n    display: contents;');
    expect(block).not.toContain('.workspace-title-line > .workspace-name {\n    flex: 0 0 100%;');
  });

  it('gives the off-the-tail capsule the title row instead of a row of its own', () => {
    // The capsule's home in the row, and the title and badges stepping aside while it shows.
    expect(block).toMatch(/\.workspace-title-jump \{\n    display: flex;\n    flex: 1 1 auto;\n    min-width: 0;/);
    expect(block).toContain('.workspace-title-line.shows-jump > :not(.workspace-title-jump) {\n    display: none;');
    // Hidden while nothing is off the tail, but mounted: its strip's line is what says something waits.
    expect(block).toContain('.workspace-title-jump[hidden] {\n    display: none;');
  });

  it('keeps a draft’s line — where it will run — while the session’s own line is gone', () => {
    expect(block).toMatch(/\.workspace-header-main > \.workspace-sub \{/);
  });
});
