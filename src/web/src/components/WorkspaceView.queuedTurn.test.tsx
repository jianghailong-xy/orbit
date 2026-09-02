import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { QueuedTurnMeta, queuedTurnFromActiveSnapshot } from './WorkspaceView';

describe('the server-placement labels in the pending tail', () => {
  const render = (placement: 'steer' | 'queued') =>
    renderToStaticMarkup(<QueuedTurnMeta placement={placement} onCancel={() => {}} />);

  it('shows a live steer as sending and never offers Cancel', () => {
    const html = render('steer');
    expect(html).toContain('Sending…');
    expect(html).not.toContain('Cancel');
  });

  it('shows NEXT_TURN as queued and is the only placement with Cancel', () => {
    const html = render('queued');
    expect(html).toContain('Queued for next turn');
    expect(html).toContain('Cancel');
  });

  it('renders a durable API failure after reload and never offers Cancel', () => {
    const receipt = queuedTurnFromActiveSnapshot({
      turnId: 'current-work-1',
      targetTurnId: 'target-1',
      kind: 'steer',
      placement: 'steer',
      content: 'adjust this',
      createdAt: '2026-08-30T12:00:00.000Z',
      delivery: 'failed',
      deliveryCode: 'CURRENT_WORK_TARGET_COMPLETED',
      deliveryReason: 'The target turn completed before the engine acknowledged this message.',
    });
    expect(receipt).not.toBeNull();
    const html = renderToStaticMarkup(
      <QueuedTurnMeta
        placement={receipt!.placement}
        delivery={receipt!.delivery}
        deliveryReason={receipt!.deliveryReason}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain('Not delivered');
    expect(html).toContain('The target turn completed before the engine acknowledged this message.');
    expect(html).not.toContain('Cancel');
  });

  it('renders runner-loss ambiguity as unconfirmed rather than claiming non-delivery', () => {
    const html = renderToStaticMarkup(
      <QueuedTurnMeta
        placement="steer"
        delivery="unconfirmed"
        deliveryReason="The runner disappeared before acknowledgement."
        onCancel={() => {}}
      />,
    );
    expect(html).toContain('Delivery could not be confirmed');
    expect(html).not.toContain('Not delivered');
    expect(html).not.toContain('Cancel');
  });
});
