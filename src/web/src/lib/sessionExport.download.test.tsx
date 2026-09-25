// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventPageEvent } from '../api';

// The export inlines two stylesheets through vite's `?raw`, and one of them lives in node_modules —
// which in a worktree is linked into the main checkout (scripts/worktree-overlay.sh), outside vite's
// allow list, where that transform is refused as "Denied ID". What it holds is not what this file is
// about, and the export under test is the real one.
vi.mock('highlight.js/styles/github.css?raw', () => ({ default: '' }));
// The two owner reads the menu's Download HTML makes; everything else is the real module.
vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  getSessionEventPage: vi.fn(),
  fetchAttachmentDataUrl: vi.fn(),
}));
const { fetchAttachmentDataUrl, getSessionEventPage } = await import('../api');
const { downloadSessionHtml } = await import('./sessionExport');

/**
 * Download HTML from a session's own ⋯ menu (docs/share-links-design.md §8, decision 3: exporting is
 * not publishing). The file is built from the WHOLE transcript, read through the owner's page route
 * from the newest page back to the first, unclipped — a saved file has no way to fetch a card's full
 * payload when it is opened — and its images come through the owner's attachment route. No public
 * link is involved at any step.
 */

const SESSION = {
  id: '34ToZJmiOG8Ym1MR6ingQ',
  title: 'Download me',
  status: 'SUCCEEDED',
  createdAt: '2026-09-23T13:59:36.399Z',
  workspace: { name: 'orbit' },
};
const IMAGE = 'att_7Fq2';

const event = (seq: number, over: Partial<EventPageEvent> = {}): EventPageEvent => ({
  seq,
  type: 'assistant',
  payload: { text: `message ${seq}` },
  turnId: 'turn-1',
  ts: '2026-09-23T14:00:00.000Z',
  ...over,
});

let blobs: Blob[];

beforeEach(() => {
  blobs = [];
  URL.createObjectURL = (blob: Blob): string => {
    blobs.push(blob);
    return 'blob:orbit-export';
  };
  URL.revokeObjectURL = (): void => {};
  vi.spyOn(HTMLElement.prototype, 'click').mockImplementation(() => {});
  vi.mocked(getSessionEventPage).mockReset();
  vi.mocked(fetchAttachmentDataUrl).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Download HTML from the session menu', () => {
  it('reads every page as the owner, unclipped, newest first, and writes them oldest first', async () => {
    // Two pages: the newest (seq 3–4) says there is more; the one before it (seq 1–2) is the start.
    // Seq 1 is a user turn with an image, and the Bash result at seq 2 is longer than a page clips.
    const long = 'x'.repeat(5000);
    vi.mocked(getSessionEventPage).mockImplementation(async (_id, opts) =>
      opts.before === undefined
        ? { events: [event(3), event(4)], hasMore: true }
        : {
            events: [
              event(1, {
                type: 'user',
                payload: { text: 'look at this', attachments: [{ id: IMAGE, mime: 'image/png', name: 'shot.png' }] },
              }),
              event(2, { payload: { text: `the whole output: ${long}` } }),
            ],
            hasMore: false,
          },
    );
    vi.mocked(fetchAttachmentDataUrl).mockResolvedValue('data:image/png;base64,iVBORw0KGgo=');

    await downloadSessionHtml(SESSION);

    expect(vi.mocked(getSessionEventPage).mock.calls).toEqual([
      [SESSION.id, { before: undefined, limit: 500, whole: true }],
      [SESSION.id, { before: 3, limit: 500, whole: true }],
    ]);
    expect(fetchAttachmentDataUrl).toHaveBeenCalledWith(IMAGE);
    expect(blobs).toHaveLength(1);
    const html = await blobs[0].text();
    const order = ['look at this', 'the whole output', 'message 3', 'message 4'].map((text) => html.indexOf(text));
    expect(order.every((at) => at >= 0), 'an event is missing from the file').toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain(long);
    expect(html).toContain('data:image/png;base64,iVBORw0KGgo=');
    expect(html).toContain('<title>Download me — Orbit</title>');
  });

  it('reads one page when the transcript fits in one', async () => {
    vi.mocked(getSessionEventPage).mockResolvedValue({ events: [event(1)], hasMore: false });
    await downloadSessionHtml(SESSION);
    expect(getSessionEventPage).toHaveBeenCalledTimes(1);
    expect(await blobs[0].text()).toContain('message 1');
  });
});

describe('the owner page route, whole or clipped', () => {
  it('asks the server to clip only when the transcript is for reading, not for a file', async () => {
    const { getSessionEventPage: real } = await vi.importActual<typeof import('../api')>('../api');
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ events: [], hasMore: false }), { status: 200 });
    });
    try {
      await real('S1', { before: 10, limit: 500, whole: true });
      await real('S1', { tail: 200 });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(urls).toEqual([
      '/api/sessions/S1/events/page?before=10&limit=500',
      '/api/sessions/S1/events/page?tail=200&maxPayload=2048',
    ]);
  });
});
