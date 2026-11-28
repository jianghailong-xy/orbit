import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SharedSessionStatus } from './SharedSessionPage';

/**
 * The shared and guest page header pill on the server's own `guestRow` and `sharedHead` payloads (the file the Apple
 * guest surfaces are held to, with web's reading of each beside it): the pill's icon is the state's, as on the list row.
 */
type Case = {
  name: string;
  kind: string;
  web: { state: string; icon: 'clock' | 'spinner' | 'message' };
  payload: Record<string, unknown>;
};
const cases: Case[] = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../../../scripts/acceptance/session-three-state-check/guest-payloads.apple.json'),
    'utf8',
  ),
);
const GLYPH = { clock: 'anticon-clock-circle', spinner: 'anticon-loading', message: '<path d="M2.7 3.7h10.6' };
const PHASE = { clock: 'PENDING', spinner: 'RUNNING', message: 'IDLE' };
/** The pill's own markup: everything before the word. */
const draw = (payload: Record<string, unknown>) =>
  renderToStaticMarkup(<SharedSessionStatus head={payload} canReply={false} />);

describe('the shared and guest page header pill', () => {
  it('covers both payload kinds and all three icons', () => {
    expect(new Set(cases.map((c) => c.kind))).toEqual(new Set(['guestRow', 'sharedHead']));
    expect(new Set(cases.map((c) => c.web.icon))).toEqual(new Set(['clock', 'spinner', 'message']));
  });

  for (const c of cases) {
    it(`${c.kind} ${c.name}: ${c.web.icon} beside ${c.web.state}`, () => {
      const html = draw(c.payload);
      const pill = html.slice(0, html.indexOf(`${c.web.state}</span>`));
      expect(pill).toContain(`data-state="${PHASE[c.web.icon]}"`);
      expect(pill).toContain(GLYPH[c.web.icon]);
      expect(pill).not.toContain('status-dot');
    });

    it(`${c.kind} ${c.name}, facts absent: the spinner or the dot as before`, () => {
      const { phase: _phase, released: _released, ...older } = c.payload;
      const html = draw(older);
      expect(html).not.toContain('data-state=');
      expect(html.includes('status-dot')).toBe(!html.includes('anticon-loading'));
    });
  }
});
