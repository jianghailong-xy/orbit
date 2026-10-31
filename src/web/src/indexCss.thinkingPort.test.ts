import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The live thinking block is a scroll area inside the transcript's own scroll area, so on
 * 2026-10-31 a streaming turn showed two scrollbars side by side on the right: the transcript's,
 * and the thinking port's 8px inside it (owner's screenshot, docs/mocks/session-think-scrollbar).
 *
 * The port still scrolls by wheel, trackpad and touch; it must not draw a bar of its own.
 *
 * Its 16px right inset is held too: that is the old 8px padding plus the 8px gutter the bar took,
 * so hiding the bar moves no text.
 */
const css = readFileSync(new URL('./index.css', import.meta.url), 'utf8');

/** One top-level rule's declarations, by selector. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'u').exec(css);
  if (!match) throw new Error(`index.css has no top-level rule for ${selector}`);
  return match[1];
}

describe('the live thinking port', () => {
  it('scrolls without drawing a second scrollbar beside the transcript’s', () => {
    const port = rule('.chat-think-port');
    expect(port).toContain('overflow-y: auto');
    expect(port).toContain('padding-right: 16px');
    expect(port).toContain('scrollbar-width: none');
    expect(rule('.chat-think-port::-webkit-scrollbar')).toContain('display: none');
  });
});
