import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import { wikiSpacesQuery } from './queries';
import { isWikiDisabled, wikiShown, WIKI_DISABLED } from './wiki';

const api = vi.hoisted(() => vi.fn());
vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api,
}));

/**
 * An account the server has not switched the wiki on for (the apiserver's ORBIT_WIKI: `off`, or a
 * `canary` that does not list it) is answered 404 WIKI_DISABLED on every wiki route. The web reads that
 * answer once, off the owner's spaces, and every entry point the wiki has draws nothing from it.
 */

const disabled = () =>
  new ApiError('The Orbit wiki is not on for this account', 404, WIKI_DISABLED, { code: WIKI_DISABLED });

/** The spaces read, run the way react-query runs it. */
async function readSpaces(): Promise<unknown> {
  const { queryFn } = wikiSpacesQuery();
  return (queryFn as () => Promise<unknown>)();
}

beforeEach(() => api.mockReset());

describe('the server saying the wiki is off', () => {
  it('is a 404 that carries WIKI_DISABLED, and nothing else', () => {
    expect(isWikiDisabled(disabled())).toBe(true);
    expect(isWikiDisabled(new ApiError('Not Found', 404))).toBe(false);
    expect(isWikiDisabled(new ApiError('no such space', 404, 'NOT_FOUND'))).toBe(false);
    expect(isWikiDisabled(new ApiError('boom', 500, WIKI_DISABLED))).toBe(false);
    expect(isWikiDisabled(new Error(WIKI_DISABLED))).toBe(false);
  });

  it('is kept as the spaces read’s answer, null, rather than failing it', async () => {
    api.mockRejectedValueOnce(disabled());
    await expect(readSpaces()).resolves.toBeNull();
    expect(api).toHaveBeenCalledWith('/wiki/spaces');
  });

  it('while every other failure still fails the read', async () => {
    const outage = new ApiError('Bad Gateway', 502);
    api.mockRejectedValueOnce(outage);
    await expect(readSpaces()).rejects.toBe(outage);
    api.mockRejectedValueOnce(new ApiError('Not Found', 404));
    await expect(readSpaces()).rejects.toBeInstanceOf(ApiError);
  });

  it('and a list is a list', async () => {
    api.mockResolvedValueOnce([]);
    await expect(readSpaces()).resolves.toEqual([]);
  });
});

describe('whether the wiki’s entry points are drawn', () => {
  it('draws them once the server has answered with anything but WIKI_DISABLED', () => {
    expect(wikiShown({ data: [], isError: false })).toBe(true);
    expect(wikiShown({ data: [{ id: 'space' }], isError: false })).toBe(true);
    expect(wikiShown({ data: null, isError: false })).toBe(false);
  });

  it('draws nothing while the answer is on its way, so an account without the wiki is never offered one', () => {
    expect(wikiShown({ data: undefined, isError: false })).toBe(false);
  });

  it('still draws them when the read failed for another reason: a failure is not the server saying no', () => {
    expect(wikiShown({ data: undefined, isError: true })).toBe(true);
  });
});
