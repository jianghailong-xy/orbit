import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * A held message's failure line says why (docs/ux/translation-failure-policy.html, frames 4B and 7), e.g.
 * "The translator didn't answer in time, so it wasn't sent · Retry · Send as written". Unlike today's short
 * generic line it wraps in a narrow column. The meta row under the bubble is one 18px line with its items
 * centred, so a wrapped line grew upward and its first line was drawn over the bubble's bottom border
 * (2026-11-18). While the row holds a failure line (`has-failure-foot`, Transcript's user bubble) it grows
 * downward instead, the line right-aligned under the bubble, and the line itself may wrap.
 */
const css = readFileSync(new URL('./index.css', import.meta.url), 'utf8');

/** One top-level rule's declarations, by selector. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'u').exec(css);
  if (!match) throw new Error(`index.css has no top-level rule for ${selector}`);
  return match[1];
}

describe('a held message’s failure line', () => {
  it('grows the meta row downward, never up over the bubble', () => {
    const row = rule('.chat-user-meta.has-failure-foot');
    expect(row).toContain('height: auto');
    expect(row).toContain('align-items: flex-start');
    expect(row).toContain('white-space: normal');
  });

  it('wraps right-aligned, Retry and Send as written each whole', () => {
    expect(rule('.chat-translate-foot.is-error')).toContain('flex-wrap: wrap');
    expect(rule('.chat-user-meta.has-failure-foot > .chat-translate-foot.is-error')).toContain('justify-content: flex-end');
    expect(rule('.chat-translate-foot.is-error .chat-translate-action')).toContain('white-space: nowrap');
  });
});
