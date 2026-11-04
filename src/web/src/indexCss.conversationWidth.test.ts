import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * A conversation has a reading width: on a 1920px window a reply ran to 90 Chinese characters a line, on 2560px to 135.
 *
 * It had a cap once, and the owner's complaint took it off (581bcb011, session 33aylFDIYQ1eH5X0DOjmY: "只占用了左边的一小部分"):
 * `.chat-assistant { max-width: 780px }` left the reply in the left of a wide pane, with the user's bubble far off on the
 * right. So the column is capped as a whole and stands centred: the scroller's padding narrows everything in it and leaves
 * its scrollbar on the pane's edge, and the composer takes the same width below it. `.chat-assistant` stays uncapped.
 *
 * 800px is what a 1440px window shows already, 55 characters a line, so no window at or below that moves.
 */
const css = readFileSync(new URL('./index.css', import.meta.url), 'utf8');

/** One top-level rule's declarations, by selector. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'u').exec(css);
  if (!match) throw new Error(`index.css has no top-level rule for ${selector}`);
  return match[1];
}

describe('the conversation’s width', () => {
  it('is one token on the pane', () => {
    expect(rule('.workspace-view')).toContain('--conversation-width: 800px');
  });

  it('centres the transcript by the scroller’s padding, which shrinks to nothing on a narrower pane', () => {
    expect(rule('.workspace-scroll-wrap > .workspace-sessions')).toContain(
      'padding-inline: max(0px, calc((100% - var(--conversation-width)) / 2))',
    );
  });

  it('gives the composer the same column, its left edge on the transcript’s', () => {
    const composer = rule('.workspace-composer');
    expect(composer).toContain('width: 100%');
    expect(composer).toContain('max-width: var(--conversation-width)');
    expect(composer).toContain('margin-inline: auto');
  });

  it('does not cap a reply on its own, which is what left it in the left of the pane', () => {
    expect(rule('.chat-assistant')).toContain('max-width: none');
  });

  it('leaves the session list and an exported transcript alone: they share the scroller’s class', () => {
    expect(rule('.workspace-sessions')).not.toContain('padding-inline');
  });
});

describe('a word of inline code', () => {
  it('stays whole, and a line may end before the code by the stylesheet, so nothing is copied with it', () => {
    expect(rule('.code-word')).toContain('white-space: nowrap');
    expect(rule('.code-break::before')).toContain("content: '\\200B'");
  });

  it('widens a table only inside its own scroller, so the conversation never scrolls sideways', () => {
    const scroller = rule('.md-table-scroll');
    expect(scroller).toContain('max-width: 100%');
    expect(scroller).toContain('overflow-x: auto');
    expect(css.indexOf('.md-table-scroll > table')).toBeGreaterThan(css.indexOf('\n.md table {'));
  });

  it('keeps a column of prose readable beside those words, in a table with code and no other', () => {
    const table = rule('.md-table-scroll:has(.code-word) > table');
    expect(table).toContain('width: max-content');
    expect(table).toContain('max-width: max(100%, 40em)');
  });
});
