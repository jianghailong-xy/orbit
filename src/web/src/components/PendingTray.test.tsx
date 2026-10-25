// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { attachmentsSummary, PendingTray, type PendingTrayRow } from './PendingTray';

/** The tray's own drawing (docs/mocks/steer-tray): one row per message nothing has read yet. */

const row = (over: Partial<PendingTrayRow> = {}): PendingTrayRow => ({
  key: 't1',
  heading: 'current',
  text: 'then push it to main',
  previews: [],
  imageIds: [],
  files: 0,
  state: 'Waiting to be read',
  ...over,
});

describe('PendingTray', () => {
  it('draws nothing when nothing is waiting', () => {
    expect(renderToStaticMarkup(<PendingTray rows={[]} />)).toBe('');
  });

  it('says where each row is going, how it stands, and offers only what it can do', () => {
    const html = renderToStaticMarkup(
      <PendingTray
        rows={[
          row({ onWithdraw: () => {} }),
          row({ key: 't2', heading: 'next', text: 'and update the changelog', state: 'Queued for next turn', onSteer: () => {}, onWithdraw: () => {} }),
          // A Codex steer once Codex has it: nothing to press.
          row({ key: 't3', text: 'use the other endpoint' }),
        ]}
      />,
    );
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const rows = [...doc.querySelectorAll('.pending-tray-row')];
    expect(rows.map((r) => r.querySelector('.pending-tray-icon')?.classList.contains('is-current'))).toEqual([true, false, true]);
    expect(rows.map((r) => r.querySelector('.pending-tray-state')?.textContent)).toEqual([
      'Waiting to be read', 'Queued for next turn', 'Waiting to be read',
    ]);
    expect(rows.map((r) => [...r.querySelectorAll('.pending-tray-btn')].map((b) => b.getAttribute('aria-label') ?? b.textContent))).toEqual([
      ['Withdraw'], ['Steer', 'Withdraw'], [],
    ]);
    expect(rows[1].querySelector('.pending-tray-btn')?.getAttribute('title')).toBe('Send into the current turn now');
    expect(doc.querySelector('[aria-label="Withdraw"]')?.getAttribute('title')).toBe('Withdraw — back to the composer');
  });

  it('offers nothing on a row whose press is out', () => {
    const html = renderToStaticMarkup(
      <PendingTray rows={[row({ state: 'Withdrawing…', busy: true, onWithdraw: () => {} })]} />,
    );
    expect(html).toContain('Withdrawing…');
    expect(html).toContain('is-busy');
    expect(html).not.toContain('pending-tray-btn');
  });

  it('names a message of pictures and files alone by what it carries, and a `!cmd` as the command', () => {
    expect(attachmentsSummary(1, 0)).toBe('1 image');
    expect(attachmentsSummary(2, 1)).toBe('2 images, 1 file');
    expect(attachmentsSummary(0, 3)).toBe('3 files');
    const html = renderToStaticMarkup(
      <PendingTray
        rows={[
          row({ text: '', imageIds: ['a1'] }),
          row({ key: 't2', heading: 'next', text: 'npm test', shell: true, state: 'Queued for next turn' }),
        ]}
      />,
    );
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const texts = [...doc.querySelectorAll('.pending-tray-text')];
    expect(texts.map((t) => t.textContent)).toEqual(['1 image', '!npm test']);
    expect(texts[0].classList.contains('is-files')).toBe(true);
    expect(texts[1].classList.contains('is-shell')).toBe(true);
  });
});
