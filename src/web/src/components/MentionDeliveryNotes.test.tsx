import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { MentionDeliveryNotes, type MentionDelivery } from './MentionDeliveryNotes';

/**
 * §13.8's visible half. The delivery ledger exists so a mention nobody could deliver stops being a
 * log line on one apiserver — which only holds if the thread actually says so.
 */
const AGENTS = [{ id: 'w1', name: 'reviewer' }];

function delivery(overrides: Partial<MentionDelivery> = {}): MentionDelivery {
  return {
    id: 'd1',
    workspaceId: 'w1',
    status: 'DELIVERED',
    attempts: 0,
    errorCode: null,
    requiredAction: null,
    lastError: null,
    nextAttemptAt: '2026-08-22T00:00:00.000Z',
    targetSessionId: 's1',
    ...overrides,
  };
}

function html(node: React.ReactNode): string {
  return renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
}

describe('MentionDeliveryNotes', () => {
  it('says where a delivered mention landed, and links it', () => {
    // "It arrived, and here is where" is what somebody opening a thread is usually after; a status
    // with nowhere to go leaves them hunting for the session by hand.
    const out = html(<MentionDeliveryNotes deliveries={[delivery()]} agents={AGENTS} />);
    expect(out).toContain('@reviewer: delivered');
    expect(out).toContain('/sessions/s1');
  });

  it('renders nothing for a comment that mentioned nobody', () => {
    expect(html(<MentionDeliveryNotes agents={AGENTS} />)).toBe('');
    expect(html(<MentionDeliveryNotes deliveries={[]} mentions={[]} agents={AGENTS} />)).toBe('');
  });

  it('marks a pre-ledger comment as untracked rather than delivered', () => {
    // `mention_delivery_version` 0: delivered by the old inline loop, which recorded nothing.
    // Claiming "delivered" would assert something nobody established, and "failed" would be worse.
    const out = html(<MentionDeliveryNotes deliveries={[]} mentions={['w1']} agents={AGENTS} />);
    expect(out).toContain('delivery not tracked');
    expect(out).not.toContain('delivered<');
  });

  it('names the agent, the state and the code when one is stuck', () => {
    const out = html(
      <MentionDeliveryNotes
        deliveries={[delivery({ status: 'BLOCKED', errorCode: 'NO_RUNNER', targetSessionId: null })]}
        agents={AGENTS}
      />,
    );
    expect(out).toContain('@reviewer: not delivered yet (NO_RUNNER)');
    expect(out).toContain('tdp-mention-delivery-blocked');
  });

  it('distinguishes queued from delivered', () => {
    // What the QUEUED state is for: durably queued is not read, and a person waiting for a reply
    // is entitled to know which one they are looking at.
    const out = html(
      <MentionDeliveryNotes deliveries={[delivery({ status: 'QUEUED' })]} agents={AGENTS} />,
    );
    expect(out).toContain('@reviewer: queued');
  });

  it('marks a dead delivery differently from one still being retried', () => {
    const out = html(
      <MentionDeliveryNotes
        deliveries={[delivery({ status: 'DEAD', errorCode: 'WORKSPACE_GONE' })]}
        agents={AGENTS}
      />,
    );
    expect(out).toContain('tdp-mention-delivery-dead');
    expect(out).not.toContain('tdp-mention-delivery-blocked');
  });

  it('falls back to the id when the agent is gone', () => {
    // The case the immutable snapshot column exists for: the agent was deleted, and the record of
    // what was asked for outlives it.
    const out = html(
      <MentionDeliveryNotes
        deliveries={[delivery({ status: 'DEAD', workspaceId: 'w-gone' })]}
        agents={AGENTS}
      />,
    );
    expect(out).toContain('@w-gone: not delivered');
  });
});
