import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completeSession } from '../api';
import { sessionsQuery } from './queries';

const apiMock = vi.hoisted(() => vi.fn());

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: apiMock };
});

describe('canonical session lifecycle API', () => {
  beforeEach(() => {
    apiMock.mockReset().mockResolvedValue([]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(['open', 'completed', 'trash'] as const)(
    'uses the %s view value in both the cache key and request',
    async (view) => {
      const query = sessionsQuery({ runnerId: 'runner-1', view });

      expect(query.queryKey).toEqual(['sessions', 'runner-1', view]);
      await (query.queryFn as () => Promise<unknown>)();
      expect(apiMock).toHaveBeenCalledWith(`/sessions?runnerId=runner-1&view=${view}`);
    },
  );

  it('posts Complete to the canonical endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });

    await completeSession('session-1');

    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/session-1/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: undefined,
    });
  });

  it('falls back to the old Complete route only when the canonical route is missing', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });

    await completeSession('session-1');

    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/api/sessions/session-1/complete',
      '/api/sessions/session-1/archive',
    ]);
  });

  it('retries a silently unsupported Completed view through its legacy alias', async () => {
    apiMock
      .mockResolvedValueOnce([{ id: 'open-1', lifecycleState: 'OPEN' }])
      .mockResolvedValueOnce([{ id: 'done-1', filingState: 'ARCHIVED' }]);
    const query = sessionsQuery({ view: 'completed' });

    const rows = await (query.queryFn as () => Promise<any[]>)();

    expect(rows.map((row) => row.id)).toEqual(['done-1']);
    expect(apiMock).toHaveBeenNthCalledWith(1, '/sessions?view=completed');
    expect(apiMock).toHaveBeenNthCalledWith(2, '/sessions?view=archived');
  });
});
