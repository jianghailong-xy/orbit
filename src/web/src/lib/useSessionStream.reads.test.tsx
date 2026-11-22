// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as apiModule from '../api';
import { streamReport } from './listBudget';
import { sessionQuery } from './queries';
import { ControlPlaneProvider } from './useControlPlane';
import { useSessionStream } from './useSessionStream';

/**
 * What the session page's own stream reads, and how often (project criterion 5H45pvgKd1UpxD5Lg4Oi4Y): one read
 * serves every part of the page that shows the same data, and while the stream is online a read happens only on an
 * event that can change its answer. Every request below goes through a mocked api function, so each mock's calls are
 * the request recorder; the clock is faked, so "within the safety minute" is a number of milliseconds, not a race.
 */

vi.mock('./transcriptStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./transcriptStore')>()),
  loadTranscript: vi.fn(async () => null),
  saveTranscript: vi.fn(),
}));

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  getToken: () => 'token',
  getSession: vi.fn(async (id: string) => ({ id, status: 'RUNNING' })),
  getSessionEventPage: vi.fn(),
  getSessionEventPageAfter: vi.fn(),
  listApprovals: vi.fn(async () => []),
  listQueuedTurns: vi.fn(async () => []),
  getBackgroundShells: vi.fn(async () => []),
}));

const ev = (seq: number) => ({ seq, type: 'assistant', payload: { text: `m${seq}` }, ts: '2026-11-22T00:00:00Z' });
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => ev(from + i));

class FakeEventSource {
  static all: FakeEventSource[] = [];
  onmessage: ((e: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) { FakeEventSource.all.push(this); }
  close(): void { this.closed = true; }
}
/** The session's transcript stream, and the tab's control-plane stream (`/api/events`). */
const transcript = (): FakeEventSource =>
  [...FakeEventSource.all].reverse().find((es) => es.url.startsWith('/api/sessions/'))!;
const controlPlane = (): FakeEventSource =>
  [...FakeEventSource.all].reverse().find((es) => es.url.startsWith('/api/events'))!;
const emit = async (es: FakeEventSource, event: object): Promise<void> => {
  await act(async () => { es.onmessage?.({ data: JSON.stringify(event) }); });
};
const opens = async (es: FakeEventSource): Promise<void> => {
  await act(async () => { es.onopen?.(); });
};
const advance = async (ms: number): Promise<void> => {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
};

/** How many requests a mocked read made for one session. */
const reads = (fn: (...args: never[]) => unknown, id: string): number =>
  vi.mocked(fn).mock.calls.filter(([sid]) => sid === id).length;

let root: Root;
let qc: QueryClient;
let latest: ReturnType<typeof useSessionStream>;
function Probe({ id }: { id: string }): null {
  latest = useSessionStream({ sessionId: id, live: true, runStatus: 'RUNNING', runTerminal: false });
  return null;
}
/** The console's detail read beside the stream, as WorkspaceView keeps it on screen. */
function Detail({ id }: { id: string }): null {
  useQuery({ ...sessionQuery(id), staleTime: Infinity });
  return null;
}

const open = async (id: string, { withControlPlane = false } = {}): Promise<void> => {
  const page = <><Probe id={id} /><Detail id={id} /></>;
  await act(async () => root.render(
    <QueryClientProvider client={qc}>
      {withControlPlane ? <ControlPlaneProvider>{page}</ControlPlaneProvider> : page}
    </QueryClientProvider>,
  ));
  // The session-switch debounce and the tail seed.
  await advance(400);
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
  FakeEventSource.all = [];
  streamReport.stopped();
  vi.mocked(apiModule.getSessionEventPage).mockImplementation(async () => ({ events: range(1, 200), hasMore: true }) as never);
  vi.mocked(apiModule.getSessionEventPageAfter).mockImplementation(async (_id, after) => ({ events: [], before: after, after: null }) as never);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(document.createElement('div'));
});
afterEach(async () => {
  await act(async () => root.unmount());
  qc.clear();
  streamReport.stopped();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('pending approvals', () => {
  it('are read once for a stream startup and the stream opening', async () => {
    await open('S1');
    await opens(transcript());
    await advance(1_000);
    expect(reads(apiModule.listApprovals, 'S1')).toBe(1);
  });

  it('are read again when a dropped stream reopens, which can have missed a decision', async () => {
    await open('S1');
    await opens(transcript());
    await act(async () => { transcript().onerror?.(); });
    await advance(3_000);
    await opens(transcript());
    await advance(0);
    expect(reads(apiModule.listApprovals, 'S1')).toBe(2);
  });

  it('are still read when the stream fails before it ever opens', async () => {
    await open('S1');
    await act(async () => { transcript().onerror?.(); });
    await advance(0);
    expect(reads(apiModule.listApprovals, 'S1')).toBe(1);
  });

  it('are still read when the stream neither opens nor fails', async () => {
    await open('S1');
    await advance(2_000);
    expect(reads(apiModule.listApprovals, 'S1')).toBe(0);
    await advance(1_500);
    expect(reads(apiModule.listApprovals, 'S1')).toBe(1);
  });

  it('show the cards the read returns', async () => {
    vi.mocked(apiModule.listApprovals).mockResolvedValueOnce([
      { id: 'A1', sessionId: 'S1', toolName: 'Bash', input: {}, status: 'PENDING', createdAt: '2026-11-22T00:00:00Z' },
    ]);
    await open('S1');
    await opens(transcript());
    await advance(0);
    expect(latest.approvals.map((a) => a.id)).toEqual(['A1']);
  });
});

describe('the turns not yet taken', () => {
  it('are not read for a user or turn_end event alone, and are for queued_turns_changed', async () => {
    await open('S1');
    await opens(transcript());
    const startup = reads(apiModule.listQueuedTurns, 'S1');
    expect(startup).toBe(1);

    await emit(transcript(), { seq: 201, type: 'user', turnId: 'T1', payload: { text: 'hi' } });
    await emit(transcript(), { seq: 202, type: 'turn_end', turnId: 'T1', payload: {} });
    await advance(1_000);
    expect(reads(apiModule.listQueuedTurns, 'S1')).toBe(startup);

    await emit(transcript(), { seq: 0, type: 'queued_turns_changed', payload: {} });
    await advance(0);
    expect(reads(apiModule.listQueuedTurns, 'S1')).toBe(startup + 1);
  });

  it('are read at a turn end when a queued message waits behind it, since it becomes the head', async () => {
    vi.mocked(apiModule.listQueuedTurns).mockResolvedValueOnce([
      { turnId: 'T2', kind: 'message', content: 'next', placement: 'queued' } as never,
    ]);
    await open('S1');
    await opens(transcript());
    await advance(0);
    expect(latest.queued.map((t) => t.turnId)).toEqual(['T2']);
    const before = reads(apiModule.listQueuedTurns, 'S1');

    await emit(transcript(), { seq: 201, type: 'turn_end', turnId: 'T1', payload: {} });
    await advance(0);
    expect(reads(apiModule.listQueuedTurns, 'S1')).toBe(before + 1);
  });

  it('drop the turn a user event says the runner took, without reading', async () => {
    vi.mocked(apiModule.listQueuedTurns).mockResolvedValueOnce([
      { turnId: 'T2', kind: 'steer', content: 'also this', placement: 'steer', targetTurnId: 'T1' } as never,
    ]);
    await open('S1');
    await opens(transcript());
    await advance(0);
    expect(latest.queued.map((t) => t.turnId)).toEqual(['T2']);
    const before = reads(apiModule.listQueuedTurns, 'S1');

    await emit(transcript(), { seq: 201, type: 'user', turnId: 'T2', payload: { text: 'also this' } });
    await advance(0);
    expect(latest.queued).toEqual([]);
    expect(reads(apiModule.listQueuedTurns, 'S1')).toBe(before);
  });
});

describe('the background inventory', () => {
  it('is not read again for a return to the session within the stream-aware staleTime', async () => {
    streamReport.opened();
    vi.mocked(apiModule.getBackgroundShells).mockResolvedValue([
      { shellId: 'B1', toolUseId: 'B1', kind: 'shell', status: 'completed', startedSeq: 3 } as never,
    ]);
    await open('S1');
    expect(reads(apiModule.getBackgroundShells, 'S1')).toBe(1);
    await open('S2');
    await advance(45_000);
    await open('S1');
    expect(reads(apiModule.getBackgroundShells, 'S1')).toBe(1);
    // What the cache holds is still drawn.
    expect(latest.serverBgShells.map((s) => s.shellId)).toEqual(['B1']);
  });

  it('is read again once the safety minute has passed', async () => {
    streamReport.opened();
    await open('S1');
    await open('S2');
    await advance(61_000);
    await open('S1');
    expect(reads(apiModule.getBackgroundShells, 'S1')).toBe(2);
  });

  it('is read on every open while the stream is down', async () => {
    streamReport.dropped();
    await open('S1');
    await open('S2');
    await open('S1');
    expect(reads(apiModule.getBackgroundShells, 'S1')).toBe(2);
  });
});

describe('the session detail at a turn end', () => {
  it('is read once for one turn_end and its control-plane event', async () => {
    await open('S1', { withControlPlane: true });
    await opens(controlPlane());
    await opens(transcript());
    await advance(0);
    const before = reads(apiModule.getSession, 'S1');

    await emit(transcript(), { seq: 201, type: 'turn_end', turnId: 'T1', payload: {} });
    await advance(50);
    await emit(controlPlane(), { type: 'session.updated', sessionId: 'S1', data: { id: 'S1' } });
    await advance(3_000);
    expect(reads(apiModule.getSession, 'S1')).toBe(before + 1);
  });

  it('is still read at a turn end when no control-plane stream is live to read it', async () => {
    await open('S1');
    await opens(transcript());
    await advance(0);
    const before = reads(apiModule.getSession, 'S1');

    await emit(transcript(), { seq: 201, type: 'turn_end', turnId: 'T1', payload: {} });
    await advance(1_000);
    expect(reads(apiModule.getSession, 'S1')).toBe(before + 1);
  });
});
