import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TRANSIENT_DB_CONFLICT_CODE,
  TRANSIENT_DB_CONFLICT_MESSAGE,
  TRANSIENT_DB_CONFLICT_RETRY_AFTER_SECONDS,
  transientDbConflictBody,
} from '@orbit/shared';
import { ApiError, api, getSessionEventPage } from './api';

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

describe('a database conflict answered by the server', () => {
  // The apiserver's boundary turns a deadlock or a failed serialization into this one answer
  // (src/apiserver/src/common/transient-db-conflict.filter.ts). What is asserted here is the web
  // half of that contract: the body the server actually serves — the shared builder both sides
  // import, not a copy of it — arrives as an ApiError a caller can branch on, by CODE rather than
  // by rewordable prose.
  const conflictResponse = () =>
    ({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      headers: new Headers({ 'retry-after': String(TRANSIENT_DB_CONFLICT_RETRY_AFTER_SECONDS) }),
      json: async () => transientDbConflictBody(),
    }) as unknown as Response;

  it('reaches the caller as an ApiError carrying the stable code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => conflictResponse()));

    const error = await api('/tasks', { method: 'POST', body: {} }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(503);
    expect((error as ApiError).code).toBe(TRANSIENT_DB_CONFLICT_CODE);
    expect((error as ApiError).message).toBe(TRANSIENT_DB_CONFLICT_MESSAGE);
  });

  it('says nothing about the database it came from', () => {
    // The same claim the server-side contract test makes, from the other end: a client can render
    // this body verbatim without leaking a statement, a table or a bound parameter.
    const served = JSON.stringify(transientDbConflictBody());
    for (const forbidden of ['UPDATE ', 'SELECT ', 'conversation_turn', '$1', 'sk-ant', 'at ']) {
      expect(served).not.toContain(forbidden);
    }
    expect(transientDbConflictBody().retryable).toBe(true);
    expect(transientDbConflictBody().retryAfterSeconds).toBe(TRANSIENT_DB_CONFLICT_RETRY_AFTER_SECONDS);
  });
});
