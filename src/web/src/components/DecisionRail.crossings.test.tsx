import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DecisionStrip, type PendingDecisionQueue } from './DecisionRail';

/**
 * Batches of cross-project requests waiting on their card in this conversation are on the pinned
 * line too, named by the card's own question and counted with the other questions — and the line
 * still answers nothing: pressing it goes to the card.
 */

const EMPTY: PendingDecisionQueue = { decidingSessionId: 's', count: 0, oldestAgeSeconds: null, pending: [] };

const paint = (crossings: Array<{ id: string; label: string; ageSeconds: number | null }>) =>
  renderToStaticMarkup(
    <DecisionStrip queue={EMPTY} open={false} onToggle={() => {}} crossings={crossings} />,
  );

describe('DecisionStrip — cross-project request batches', () => {
  it('draws nothing when no batch waits', () => {
    expect(paint([])).toBe('');
  });

  it('names the oldest batch by its card’s question and counts every batch', () => {
    const html = paint([
      { id: 'crossing-batch-B', label: 'File this task here?', ageSeconds: 60 },
      { id: 'crossing-batch-A', label: 'Move these tasks here?', ageSeconds: 7200 },
    ]);
    expect(html).toContain('Move these tasks here?');
    expect(html).toContain('>2h<');
    expect(html).toContain('2 needs your decision: Move these tasks here?');
    expect(html).toContain('1 of 2');
    expect(html).not.toContain('Approve');
    expect(html).not.toContain('Refuse');
  });
});
