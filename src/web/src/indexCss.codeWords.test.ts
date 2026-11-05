import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * What inline code in prose needs from the stylesheet (lib/codeWords), and the width a conversation has.
 *
 * A conversation spans its pane. It has been capped twice and the owner took the cap off both times: `.chat-assistant
 * { max-width: 780px }` left a reply in the left of a wide pane (581bcb011, 2026-06-19), and an 800px column in the
 * middle of it left about 560px empty on each side of a 3008px window (682890bd2, withdrawn 2026-11-05).
 */
const css = readFileSync(new URL('./index.css', import.meta.url), 'utf8');

/** One top-level rule's declarations, by selector. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'u').exec(css);
  if (!match) throw new Error(`index.css has no top-level rule for ${selector}`);
  return match[1];
}

describe('a conversation', () => {
  it('spans its pane: neither the reply, the scroller nor the composer narrows it', () => {
    expect(rule('.chat-assistant')).toContain('max-width: none');
    expect(rule('.workspace-scroll-wrap > .workspace-sessions')).not.toContain('padding-inline');
    expect(rule('.workspace-composer')).not.toContain('max-width');
    expect(css).not.toContain('--conversation-width');
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
