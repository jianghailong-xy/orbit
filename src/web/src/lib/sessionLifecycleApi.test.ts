import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completeSession, sessionEventsUrl } from '../api';
import { workspaceSessionCountsQuery, sessionsQuery } from './queries';

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

      expect(query.queryKey).toEqual(['sessions', 'runner-1', null, view, null, null]);
      await (query.queryFn as () => Promise<unknown>)();
      expect(apiMock).toHaveBeenCalledWith(`/sessions?runnerId=runner-1&view=${view}`);
    },
  );

  it('scopes the request and cache key by workspace, tag and page size when asked', async () => {
    const query = sessionsQuery({
      runnerId: 'runner-1',
      workspaceId: 'workspace-1',
      view: 'open',
      tagId: 'tag-1',
      limit: 40,
    });

    expect(query.queryKey).toEqual(['sessions', 'runner-1', 'workspace-1', 'open', 'tag-1', 40]);
    await (query.queryFn as () => Promise<unknown>)();
    expect(apiMock).toHaveBeenCalledWith(
      '/sessions?runnerId=runner-1&workspaceId=workspace-1&view=open&tagId=tag-1&limit=40',
    );
  });

  it('fetches the sidebar tallies from the counts endpoint, not the session list', async () => {
    const query = workspaceSessionCountsQuery();

    expect(query.queryKey).toEqual(['session-counts']);
    await (query.queryFn as () => Promise<unknown>)();
    expect(apiMock).toHaveBeenCalledWith('/sessions/counts');
  });

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
      // Matched, not spelled out: authedFetch stamps the build number on every request, and
      // pinning it here would mean a failing test on every version bump.
      headers: {
        'content-type': 'application/json',
        'x-orbit-client': expect.stringMatching(/^web\/\S+$/),
        'x-orbit-id-format': 'public',
      },
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

// REST opts into the public-id format with a header; EventSource cannot send one, so the SSE URLs
// carry the same opt-in as a query parameter. They have to move together: if only one opts in, a
// session arrives spelled one way over REST and the other way over its own event stream, and the
// reducer that merges them stops recognizing its own rows. Neither half fails loudly, so this
// asserts the pairing rather than trusting it.
describe('the public-id opt-in covers every transport', () => {
  it('puts idFormat on the session event stream, matching the header authedFetch sends', () => {
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => 'tok'), setItem: vi.fn(), removeItem: vi.fn() });
    expect(sessionEventsUrl('341DOGTVEs0Fk0gAn1mje')).toContain('idFormat=public');
    expect(sessionEventsUrl('341DOGTVEs0Fk0gAn1mje', 42)).toContain('idFormat=public');
  });
});
