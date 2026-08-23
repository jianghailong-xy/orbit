import { MutationObserver, QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runNowMutationOptions } from '../components/TaskDetailPanel';
import { RUN_REQUEST_RESEND_ATTEMPTS, newRunRequestToken } from './runRequestToken';

/**
 * A LOST ANSWER, END TO END — the real `api()`, the real `authedFetch`, the real resend policy, and
 * only `fetch` itself standing in.
 *
 * This is the failure the whole `triggerId` mechanism exists for and the only one no layer can see
 * on its own: the POST is delivered, the server commits the run, and the ANSWER is lost. Without a
 * resend the press fails on screen while its run is already going, and the next click — a new name
 * — starts a second one. With one, the resend carries the SAME name and the server answers it from
 * the first delivery's receipt.
 */
const TASK = '341DOGTVEs0Fk0gAn1mje';

const toast = () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() });
const okJson = () => ({ ok: true, status: 200, text: async () => '{}' }) as Response;
const refused = (status: number, body: unknown) =>
  ({ ok: false, status, statusText: 'Conflict', json: async () => body }) as Response;

/** The bodies `fetch` was actually handed, in order. Strings, deliberately: what has to match is
 *  the BYTES, not two objects that happen to compare equal. */
const sentBodies = (fetchMock: ReturnType<typeof vi.fn>): string[] =>
  fetchMock.mock.calls.map(([, init]) => (init as RequestInit).body as string);

beforeEach(() => {
  vi.stubGlobal('localStorage', {
    getItem: () => 'test-token',
    setItem: () => {},
    removeItem: () => {},
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * One press, through the real options.
 *
 * `retryDelay` is the one thing overridden: the shipped schedule is 250ms → 500ms → 1s, and paying
 * it here would put ~5s of real sleeping into the suite for something these tests do not assert.
 * WHICH failures are resent, and HOW MANY times, is `runRequestResend.retry` and comes through
 * untouched; the backoff schedule itself is pinned in runRequestToken.test.ts.
 */
const press = (qc: QueryClient) =>
  new MutationObserver(qc, {
    ...runNowMutationOptions(qc, toast(), TASK, null),
    retryDelay: 0,
  }).mutate({
    // The gesture. Every attempt below this line reuses what it drew.
    triggerId: newRunRequestToken(),
  });

describe('a Run now whose answer never arrives', () => {
  it('is resent byte-for-byte, under the name the click drew', async () => {
    const fetchMock = vi.fn();
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch')); // delivered; answer lost
    fetchMock.mockResolvedValueOnce(okJson());
    vi.stubGlobal('fetch', fetchMock);

    await press(new QueryClient());

    const bodies = sentBodies(fetchMock);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    // ...and it is the press's own name, not something re-derived on the way past.
    expect(JSON.parse(bodies[0]).triggerId).toMatch(/^[0-9A-Za-z]+$/);
  });

  it('draws a NEW name for the next click, even after the last press failed outright', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchMock);

    await press(new QueryClient()).catch(() => {});
    const first = sentBodies(fetchMock);
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(okJson());
    await press(new QueryClient());

    // A press that ran out of resends is over. The next click is a person deciding to run the task
    // again, and answering it from the failed press's receipt would answer a question nobody asked.
    expect(JSON.parse(first[0]).triggerId).not.toBe(JSON.parse(sentBodies(fetchMock)[0]).triggerId);
  });

  it('stops after a bounded number of attempts rather than grinding against an outage', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(press(new QueryClient())).rejects.toThrow();

    // One attempt plus RUN_REQUEST_RESEND_ATTEMPTS resends, all naming the same press.
    const bodies = sentBodies(fetchMock);
    expect(bodies).toHaveLength(RUN_REQUEST_RESEND_ATTEMPTS + 1);
    expect(new Set(bodies).size).toBe(1);
  });

  it('reads the answer back through TASK_RUN_REQUEST_IN_PROGRESS, under the same name', async () => {
    // The response-loss window in full: the first delivery is still committing when the resend
    // arrives, so the resend is told "being answered right now, ask again with the same triggerId".
    // Stopping there would fail the press while its run starts, and the next click would start a
    // second one under a new name.
    const fetchMock = vi.fn();
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch')); // delivered; answer lost
    fetchMock.mockResolvedValueOnce(
      refused(409, { message: 'being answered', code: 'TASK_RUN_REQUEST_IN_PROGRESS' }),
    );
    fetchMock.mockResolvedValueOnce(okJson()); // ...and now the original answer
    vi.stubGlobal('fetch', fetchMock);

    await press(new QueryClient());

    const bodies = sentBodies(fetchMock);
    expect(bodies).toHaveLength(3);
    expect(new Set(bodies).size).toBe(1); // byte-identical throughout
  });

  it('surfaces the real IN_PROGRESS refusal once the attempts are spent', async () => {
    // Not a summary of it: a reader whose press ran out of attempts while the control plane kept
    // saying "being answered right now" needs to be told exactly that.
    const fetchMock = vi.fn(async () =>
      refused(409, { message: 'being answered right now', code: 'TASK_RUN_REQUEST_IN_PROGRESS' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(press(new QueryClient())).rejects.toThrow('being answered right now');

    expect(sentBodies(fetchMock)).toHaveLength(4);
    expect(new Set(sentBodies(fetchMock)).size).toBe(1);
  });

  it('resends when a 2xx arrives but its body dies on the way', async () => {
    // The narrowest response-loss window there is, and the one the runner had a real bug in: the
    // server committed the run and sent the 200, and the BODY never finished. `fetch` has already
    // resolved by then — the headers arrived — so the failure surfaces from `res.text()`, below
    // every status check. It reaches `api()` as a TypeError rather than an `ApiError`, which is
    // exactly what `isLostRunAnswer` keys on: no answer was received, and one may well exist.
    const truncated = {
      ok: true,
      status: 200,
      text: async () => {
        throw new TypeError('network error');
      },
    } as unknown as Response;
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(truncated);
    fetchMock.mockResolvedValueOnce(okJson());
    vi.stubGlobal('fetch', fetchMock);

    await press(new QueryClient());

    const bodies = sentBodies(fetchMock);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]); // the same press, byte for byte
  });

  it('never resends an answer the server actually gave', async () => {
    // 409 TASK_RUN_REQUEST_MISMATCH is the server saying this name already means something else.
    // Sending it again says nothing new, and it is the one refusal a resend could not fix.
    const fetchMock = vi.fn(async () =>
      refused(409, { message: 'already used', code: 'TASK_RUN_REQUEST_MISMATCH' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(press(new QueryClient())).rejects.toThrow('already used');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
