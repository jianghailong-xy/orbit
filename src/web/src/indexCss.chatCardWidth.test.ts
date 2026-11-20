import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Every card in the conversation is one width (docs/mocks/chat-card-width, D1 = D2 = A, 2026-11-20).
 * On a column wider than 720px the notice cards (exception item, project started, …) stopped at 720px
 * while the cards on the shared `.approval-card` frame ran the full column, and the small ones stopped at
 * 560, 640 or 668px. Each now reads `--chat-card-max`, set once on the conversation's scroll wrap, so the
 * cards end on one line there and keep their own width anywhere else.
 */
const css = readFileSync(new URL('./index.css', import.meta.url), 'utf8');
const scheduled = readFileSync(new URL('./components/Scheduled.css', import.meta.url), 'utf8');
const machine = readFileSync(new URL('./components/MachineSetupCard.css', import.meta.url), 'utf8');

/** One top-level rule's declarations, by selector. */
function rule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'u').exec(source);
  if (!match) throw new Error(`no top-level rule for ${selector}`);
  return match[1];
}

describe('the conversation’s card width', () => {
  it('is set once, on the conversation', () => {
    expect(rule(css, '.workspace-scroll-wrap')).toContain('--chat-card-max: 720px');
    expect(css.match(/--chat-card-max:/gu)).toHaveLength(1);
  });

  it('caps the cards on the shared frame and the other full-width cards there', () => {
    const scoped = /\.workspace-scroll-wrap :is\(([^)]*)\)\s*\{([^}]*)\}/u.exec(css);
    expect(scoped, 'the scoped cap is missing').not.toBeNull();
    for (const card of ['.approval-card', '.review-card', '.chat-error-card', '.chat-session-card',
      '.owner-request-card', '.cu-rc-card', '.session-project-landing']) {
      expect(scoped![1]).toContain(card);
    }
    expect(scoped![2]).toContain('max-width: var(--chat-card-max)');
  });

  it('is what every card with a width of its own reads', () => {
    for (const card of ['.oic', '.tsc', '.psc', '.crc', '.smc', '.approval-card.evidence-decision-receipt',
      '.chat-status-card', '.landings-window-card.chat-status-card', '.src']) {
      expect(rule(css, card), card).toMatch(/var\(--chat-card-max, \d+px\)/u);
      // A literal width left beside the variable would be the one that wins.
      expect(rule(css, card), card).not.toMatch(/width: (?:min\()?(?:720|640|560)px/u);
    }
    for (const card of ['.sched-record', '.sched-report']) {
      expect(rule(scheduled, card), card).toContain('var(--chat-card-max, 640px)');
    }
    expect(scheduled).toContain('max-width: var(--chat-card-max, 560px)');
    expect(rule(machine, '.msc-draft')).toContain('var(--chat-card-max, 620px) + 48px');
  });
});
