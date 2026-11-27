// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as apiModule from '../api';
import * as store from './transcriptStore';
import { reopenWindow, useSessionStream } from './useSessionStream';

vi.mock('./transcriptStore', async (importOriginal) => {
  const real = await importOriginal<typeof import('./transcriptStore')>();
  return { ...real, saveTranscript: vi.fn(real.saveTranscript) };
});

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  getSessionEventPage: vi.fn(),
  getSessionEventPageAfter: vi.fn(),
  listApprovals: vi.fn(async () => []),
  listQueuedTurns: vi.fn(async () => ({ turns: [] })),
  getBackgroundShells: vi.fn(async () => []),
}));

const ev = (seq: number) => ({ seq, type: 'assistant', payload: { text: `m${seq}` }, ts: '2026-11-22T00:00:00Z' });
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => ev(from + i));

class FakeEventSource {
  static all: FakeEventSource[] = [];
  onmessage: ((e: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeEventSource.all.push(this); }
  close(): void {}
  emit(event: object): void { this.onmessage?.({ data: JSON.stringify(event) }); }
}
const lastStream = (): string => FakeEventSource.all[FakeEventSource.all.length - 1].url;

let root: Root;
let latest: ReturnType<typeof useSessionStream>;
const commits: number[] = [];
let atTail = true;
function Probe({ id }: { id: string }): null {
  latest = useSessionStream({
    sessionId: id, live: true, runStatus: 'RUNNING', runTerminal: false, readerAtTail: () => atTail,
  });
  commits.push(latest.events.length);
  return null;
}
const qc = new QueryClient();
const open = async (id: string): Promise<void> => {
  await act(async () => root.render(<QueryClientProvider client={qc}><Probe id={id} /></QueryClientProvider>));
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
};
const tailCalls = (id: string): number =>
  vi.mocked(apiModule.getSessionEventPage).mock.calls.filter(([sid, opts]) => sid === id && opts?.tail).length;

describe('reopening a cached session', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
    FakeEventSource.all = [];
    commits.length = 0;
    atTail = true;
    vi.mocked(apiModule.getSessionEventPage).mockImplementation(async () => ({ events: range(1, 200), hasMore: true }) as never);
    root = createRoot(document.createElement('div'));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('reads the gap as one page in one commit, then streams from past it', async () => {
    await open('S1');
    expect(lastStream()).toContain('sinceSeq=200');
    await open('S2');
    // S1 moved on by 150 events while S2 was open.
    vi.mocked(apiModule.getSessionEventPageAfter).mockResolvedValue({ events: range(201, 350), before: 200, after: null } as never);
    const from = commits.length;
    await open('S1');
    expect(apiModule.getSessionEventPageAfter).toHaveBeenCalledWith('S1', 200, expect.objectContaining({ limit: 200 }));
    expect(tailCalls('S1')).toBe(1); // the cold open's, and no other
    // The cached window first, then the whole gap at once: never a count in between.
    expect(commits.slice(from).filter((n) => n > 200 && n < 350)).toEqual([]);
    expect(latest.events.map((e) => e.seq).slice(-1)).toEqual([350]);
    expect(lastStream()).toContain('sinceSeq=350');
  });

  it('draws only the newest page of what was cached, with the rest left to page back in', async () => {
    await open('S1');
    vi.mocked(apiModule.getSessionEventPageAfter).mockResolvedValue({ events: range(201, 350), before: 200, after: null } as never);
    await open('S2');
    await open('S1'); // the cache now holds 350
    vi.mocked(apiModule.getSessionEventPageAfter).mockResolvedValue({ events: [], before: 350, after: null } as never);
    await open('S2');
    await open('S1');
    expect(latest.events).toHaveLength(200);
    expect(latest.events[0].seq).toBe(151);
    expect(latest.hasOlderNow()).toBe(true);
  });

  it('takes the newest page instead when the gap is wider than one', async () => {
    await open('S1');
    await open('S2');
    vi.mocked(apiModule.getSessionEventPageAfter).mockResolvedValue({ events: range(201, 400), before: 200, after: 400 } as never);
    vi.mocked(apiModule.getSessionEventPage).mockImplementation(async () => ({ events: range(4801, 5000), hasMore: true }) as never);
    await open('S1');
    expect(tailCalls('S1')).toBe(2);
    expect(latest.events.map((e) => e.seq)).toEqual(range(4801, 5000).map((e) => e.seq));
    expect(latest.hasOlderNow()).toBe(true);
    expect(lastStream()).toContain('sinceSeq=5000');
  });

  it('marks a reply a translation was folded into for the stored copy to write again', async () => {
    await open('S1');
    await act(async () => {
      FakeEventSource.all[FakeEventSource.all.length - 1].emit({ seq: 0, type: 'translation', payload: { of: 150, lang: 'en', text: 'hello' } });
    });
    expect(latest.events.find((e) => e.seq === 150)?.payload.translation).toEqual({ lang: 'en', text: 'hello' });
    expect(vi.mocked(store.saveTranscript).mock.calls.at(-1)?.[2]).toEqual([150]);
  });

  describe('when the server will not replay the gap', () => {
    const resync = async (): Promise<void> => {
      vi.mocked(apiModule.getSessionEventPage).mockImplementation(async () => ({ events: range(2801, 3000), hasMore: true }) as never);
      await act(async () => { FakeEventSource.all[FakeEventSource.all.length - 1].emit({ seq: 0, type: 'resync', payload: {} }); });
      await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    };

    it('takes the newest page for a reader following the latest message', async () => {
      await open('S1');
      await resync();
      expect(latest.events[0].seq).toBe(2801);
      expect(latest.detached).toBe(false);
      expect(lastStream()).toContain('sinceSeq=3000');
    });

    it('keeps the window of a reader who scrolled up, open at its bottom', async () => {
      await open('S1');
      const streams = FakeEventSource.all.length;
      atTail = false;
      await resync();
      expect(latest.events.map((e) => e.seq)).toEqual(range(1, 200).map((e) => e.seq));
      expect(latest.detached).toBe(true);
      expect(FakeEventSource.all).toHaveLength(streams); // no stream until they reach the latest
      vi.mocked(apiModule.getSessionEventPageAfter).mockResolvedValue({ events: range(201, 300), before: 200, after: null } as never);
      await act(async () => { await latest.loadNewer(); });
      expect(apiModule.getSessionEventPageAfter).toHaveBeenCalledWith('S1', 200, expect.anything());
      expect(latest.detached).toBe(false);
      expect(lastStream()).toContain('sinceSeq=300');
    });
  });

  it('keeps a window that fits as it was', () => {
    const entry = { events: range(1, 200), oldestSeq: 1, hasMoreOlder: false };
    expect(reopenWindow(entry)).toBe(entry);
  });
});
