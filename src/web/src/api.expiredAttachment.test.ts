// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAttachmentObjectUrl, fetchSharedAttachmentObjectUrl } from './api';
import { ExpiredAttachmentError } from './lib/evidenceFiles';

/** The two reads a conversation's pictures and files go through, on what a real route answers once the bytes have gone. */
const answer = (status: number, body: string): void => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status, headers: { 'content-type': 'application/json' } })));
};

afterEach(() => vi.unstubAllGlobals());

const DOORS = [
  ['a person\'s', () => fetchAttachmentObjectUrl('a')],
  ['a shared link\'s', () => fetchSharedAttachmentObjectUrl('token', 'a')],
] as const;

describe.each(DOORS)('%s read', (_name, read) => {
  it('turns a 410 into the error a placeholder is drawn from, with its date', async () => {
    answer(410, JSON.stringify({ statusCode: 410, message: 'gone', expiredAt: '2026-09-14T00:00:00.000Z' }));
    const error = await read().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ExpiredAttachmentError);
    expect((error as ExpiredAttachmentError).expiredAt).toBe('2026-09-14T00:00:00.000Z');
  });

  it('has no date from a server older than the field, nor from a body it cannot read', async () => {
    for (const body of [JSON.stringify({ statusCode: 410, message: 'this file expired on 2026-09-14' }), '<html>']) {
      answer(410, body);
      const error = await read().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ExpiredAttachmentError);
      expect((error as ExpiredAttachmentError).expiredAt).toBeNull();
    }
  });

  it.each([404, 500, 503])('leaves a %i as the plain failure it always was', async (status) => {
    answer(status, '{}');
    const error = await read().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ExpiredAttachmentError);
  });
});
