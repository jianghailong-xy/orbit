import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSessionEventPage } from './api';

const okJson = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as Response;

// These tests run in node, not jsdom (the suite renders with react-dom/server and needs no DOM).
// api.ts reads the bearer token from localStorage on every call, so stand one in.
beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: () => 'test-token', setItem: () => {}, removeItem: () => {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getSessionEventPage', () => {
  it('carries an AbortSignal through to fetch', async () => {
    // The transcript fires a tail page on every selection change and cancels the superseded one,
    // so a signal that stopped at the api() boundary would leave a burst of them in flight while
    // the user scrubs the session list with the arrow keys.
    const fetchMock = vi.fn(async () => okJson({ events: [], hasMore: false }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await getSessionEventPage('s1', { tail: 200, signal: controller.signal });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/api/sessions/s1/events/page?tail=200');
    expect(init.signal).toBe(controller.signal);
  });

  it('rejects when the signal aborts, so the caller can stop instead of retrying blindly', async () => {
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      return okJson({ events: [], hasMore: false });
    });
    const controller = new AbortController();
    controller.abort();

    await expect(getSessionEventPage('s1', { tail: 200, signal: controller.signal })).rejects.toThrow();
  });

  it('omits the signal when none is passed — every other caller is unaffected', async () => {
    const fetchMock = vi.fn(async () => okJson({ events: [], hasMore: false }));
    vi.stubGlobal('fetch', fetchMock);

    await getSessionEventPage('s1', { before: 40, limit: 200 });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBeUndefined();
  });
});
