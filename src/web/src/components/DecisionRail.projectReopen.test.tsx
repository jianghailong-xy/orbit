// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DecisionStrip, type PendingDecisionQueue } from './DecisionRail';
import { OwnerRequestCard, useSessionOwnerRequestPointers } from './OwnerRequestCard';
import type { OwnerRequest } from '../lib/ownerRequests';

/**
 * The web has no Needs you page (removed 2026-11-16); the pinned DecisionRail line is its equivalent. A PENDING
 * PROJECT_REOPEN the session filed is named there by the card's title, and following it reaches the card.
 */

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');

const SESSION = '34uOqHiF7f3VmoARfQg6y';
const REQUEST: OwnerRequest = {
  id: '35aaReopenReq0001',
  kind: 'PROJECT_REOPEN',
  state: 'PENDING',
  title: 'Reopen project “Share to Orbit”?',
  why: 'a gap.',
  blocksTaskIds: [],
  payload: { projectId: 'p1', statusAtAsk: 'DONE', settledAt: '2026-11-18T12:00:00.000Z', plannedWork: 'Add one task.', askers: [] },
  askedBySessionId: SESSION,
  askedBySessionTitle: 'Release checklist 0.1.262',
  createdAt: new Date(Date.now() - 120_000).toISOString(),
} as unknown as OwnerRequest;

const queue: PendingDecisionQueue = {
  decidingSessionId: SESSION, count: 0, oldestAgeSeconds: null, pending: [], waitingOnYou: [],
};

function Harness({ revealed }: { revealed: Array<Element | null> }): JSX.Element {
  const pointers = useSessionOwnerRequestPointers(SESSION);
  return (
    <>
      <DecisionStrip
        queue={queue}
        open={false}
        onToggle={() => {}}
        ownerRequests={pointers}
        onRevealOwnerRequest={(id) => revealed.push(document.getElementById(`owner-request-${id}`))}
      />
      <OwnerRequestCard request={REQUEST} viewedFromSessionId={SESSION} />
    </>
  );
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('a PROJECT_REOPEN on the pinned line', () => {
  it('is named by its title, and following it reaches the card', async () => {
    vi.mocked(api).mockImplementation(async () => ({ requests: [REQUEST] }));
    const revealed: Array<Element | null> = [];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root!.render(<QueryClientProvider client={qc}><MemoryRouter><Harness revealed={revealed} /></MemoryRouter></QueryClientProvider>);
    });
    for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
    const line = host.querySelector<HTMLButtonElement>('.decision-strip-line')!;
    expect(line.textContent).toContain(REQUEST.title);
    await act(async () => line.click());
    expect(revealed).toHaveLength(1);
    expect(revealed[0]?.getAttribute('data-kind')).toBe('PROJECT_REOPEN');
    expect(revealed[0]?.textContent).toContain('Planned work');
  });
});
