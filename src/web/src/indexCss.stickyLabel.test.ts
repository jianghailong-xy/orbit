import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The sticky bar over the transcript names the turn in view with a label and its text. Over a turn
 * another session sent, the label is `From <session title>` (lib/sessionMessage), and a task
 * session's title runs to 80 characters. On 2026-10-31 such a label measured 518px on a 390px-wide
 * screen: it ran past the window, and the text beside it was left 0px wide.
 *
 * So the label is capped at 45% of the bar and cut with an ellipsis. It still does not shrink:
 * `flex: 0 1 auto` let the long text squeeze it to `From Tas…`. `Your question` is shorter than the
 * cap and does not change.
 */
const css = readFileSync(new URL('./index.css', import.meta.url), 'utf8');

/** One top-level rule's declarations, by selector. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'u').exec(css);
  if (!match) throw new Error(`index.css has no top-level rule for ${selector}`);
  return match[1];
}

describe('the sticky bar’s label', () => {
  it('is capped and cut with an ellipsis, so the text beside it keeps its room', () => {
    const label = rule('.chat-sticky-label');
    expect(label).toContain('flex: none');
    expect(label).toContain('max-width: 45%');
    expect(label).toContain('overflow: hidden');
    expect(label).toContain('text-overflow: ellipsis');
    expect(label).toContain('white-space: nowrap');
  });
});
