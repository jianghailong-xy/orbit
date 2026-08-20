import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { interruptSession } from '../api';
import { offersInterruptAndSend } from '../components/WorkspaceView';

// Stubbed at fetch, not at api(): interruptSession calls api() inside its own module, so a
// module mock would leave the real one closed over. What travels on the wire is the point
// here anyway.
const fetchMock = vi.fn();

function sentRequests(): Array<{ url: string; method?: string; body: Record<string, unknown> | undefined }> {
  return fetchMock.mock.calls.map(([url, init]) => ({
    url: url as string,
    method: (init as RequestInit | undefined)?.method,
    body: (init as RequestInit | undefined)?.body
      ? JSON.parse((init as RequestInit).body as string)
      : undefined,
  }));
}

/**
 * "Stop the current turn and send this instead" — the request, and when it is offered.
 *
 * The request shape is the whole safety property. Stopping drops the follow-ups queued
 * behind the running turn, so a client that POSTed /interrupt and then POSTed /turns would
 * be racing its own delete; and a message sent while a turn runs is filed as a steer —
 * written INTO the turn being stopped. One request is what makes neither possible.
 */
describe('interruptSession', () => {
  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, turnId: 'turn-2', seq: 5 }),
    });
    vi.stubGlobal('fetch', fetchMock);
    // authedFetch reads the bearer token off localStorage, which these tests run without.
    vi.stubGlobal('localStorage', { getItem: () => null });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stays a bodyless POST when there is nothing to send afterwards', async () => {
    await interruptSession('session-1');

    expect(sentRequests()).toEqual([
      { url: '/api/sessions/session-1/interrupt', method: 'POST', body: undefined },
    ]);
  });

  it('carries the follow-up in the interrupt itself, not in a second request', async () => {
    await interruptSession('session-1', { content: 'stop — just rename the one file' });

    const sent = sentRequests();
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('/api/sessions/session-1/interrupt');
    expect(sent[0].method).toBe('POST');
    expect(sent[0].body?.content).toBe('stop — just rename the one file');
    // Keyed, so a retried request re-files neither the interrupt nor the message.
    expect(sent[0].body?.clientTurnId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('sends attachments with the follow-up, and omits the field when there are none', async () => {
    await interruptSession('session-1', { content: 'this one instead', attachmentIds: ['att-1'] });
    expect(sentRequests()[0].body?.attachmentIds).toEqual(['att-1']);

    fetchMock.mockClear();
    await interruptSession('session-1', { content: 'this one instead', attachmentIds: [] });
    expect(sentRequests()[0].body).not.toHaveProperty('attachmentIds');
  });

  it('reports the turn the follow-up was queued as', async () => {
    expect(await interruptSession('session-1', { content: 'this one instead' })).toEqual({
      ok: true,
      turnId: 'turn-2',
      seq: 5,
    });
  });
});

describe('offersInterruptAndSend', () => {
  const base = { running: true, canSend: true, ordinaryDraft: true, replying: false, busy: false };

  it('is offered while a turn generates and there is something to send', () => {
    expect(offersInterruptAndSend(base)).toBe(true);
  });

  it('is not offered when nothing is running — Send already means "do this next"', () => {
    expect(offersInterruptAndSend({ ...base, running: false })).toBe(false);
  });

  it('offers nothing Send itself would refuse', () => {
    // An empty composer, a mid-flight upload, an offline runner: canSend carries them all,
    // and a stop with nothing to put in its place is what the Stop button is for.
    expect(offersInterruptAndSend({ ...base, canSend: false })).toBe(false);
  });

  it('stays out of the way of a reply to a blocking question', () => {
    // That text answers the question the engine is waiting on; there is no turn of the
    // user's own to redirect.
    expect(offersInterruptAndSend({ ...base, replying: true })).toBe(false);
  });

  it('cannot be pressed twice into the same interrupt', () => {
    expect(offersInterruptAndSend({ ...base, busy: true })).toBe(false);
  });

  it('stays out of a `!cmd` or local `/command` draft', () => {
    // A `!cmd` runs on the runner beside the engine and a local `/command` never leaves the
    // browser. Offering it here would send either one as plain message text, which is what
    // the composer would then put in front of the model.
    expect(offersInterruptAndSend({ ...base, ordinaryDraft: false })).toBe(false);
  });
});
