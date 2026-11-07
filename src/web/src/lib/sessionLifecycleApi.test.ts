import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completeProjectSessions, completeSession } from '../api';
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

  it("posts a finished project's Complete to its sessions door and answers how many moved", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ completed: 3 }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });

    await expect(completeProjectSessions('project-1')).resolves.toEqual({ completed: 3 });
    expect(fetchMock.mock.calls.map(([path, init]) => [path, init.method])).toEqual([
      ['/api/projects/project-1/sessions/complete', 'POST'],
    ]);
  });

  it("surfaces an OPEN project's refusal by its code", async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ code: 'PROJECT_STILL_OPEN', message: 'This project is OPEN' }),
      { status: 409 },
    )));
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });

    await expect(completeProjectSessions('project-1')).rejects.toMatchObject({
      status: 409,
      code: 'PROJECT_STILL_OPEN',
    });
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
