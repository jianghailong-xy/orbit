// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttachmentResolverContext, ExportCtx, QueuedUserTurn, type RunEvent, Transcript } from './Transcript';

/**
 * The transcript's pictures and the viewer they open.
 *
 * A turn's attachments are behind the bearer-guarded download route, so each is fetched through the resolver and
 * drawn from the object URL it hands back — a placeholder of the same size holds its place until then, and keeps it
 * when the fetch fails. The object URL belongs to the picture: it is revoked when the picture goes, and at once when
 * it lands after the picture has gone.
 *
 * Every thumbnail the conversation draws — a turn's attachments, a tool's screenshot — joins one viewer that pages
 * through them in the order of the conversation, whatever order their bytes arrived in; a picture that has not
 * arrived is not a page. A reply's Markdown picture, and a queued turn's, open on their own. The saved HTML file
 * draws plain pictures and no viewer.
 */

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const at = '2026-09-28T12:00:00.000Z';
const EVENTS: RunEvent[] = [
  { seq: 1, type: 'user', turnId: 't1', ts: at, payload: { text: 'Two screens.', attachments: [{ id: 'wide', mime: 'image/png' }, { id: 'tall', mime: 'image/png' }] } },
  { seq: 2, type: 'assistant', turnId: 't1', ts: at, payload: { text: 'The diagram:\n\n![Layout diagram](orbit-attachment:diagram)' } },
  { seq: 3, type: 'tool_use', turnId: 't1', ts: at, payload: { id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/shot.png' } } },
  { seq: 4, type: 'tool_result', turnId: 't1', ts: at, payload: { toolUseId: 'toolu_1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }] } },
  { seq: 5, type: 'turn_end', turnId: 't1', ts: at, payload: {} },
  { seq: 6, type: 'user', turnId: 't2', ts: at, payload: { text: 'One more, one missing.', attachments: [{ id: 'later', mime: 'image/png' }, { id: 'missing', mime: 'image/png' }] } },
];

let container: HTMLDivElement;
let root: Root;
let pending: Map<string, { resolve: (url: string) => void; reject: (error: Error) => void }>;
let revoked: string[];
const resolver = vi.fn((id: string) => new Promise<string>((resolve, reject) => pending.set(id, { resolve, reject })));

async function settle(): Promise<void> {
  for (let tick = 0; tick < 4; tick += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

async function draw(events: RunEvent[] = EVENTS): Promise<void> {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <AttachmentResolverContext.Provider value={resolver}>
          <Transcript events={events} />
        </AttachmentResolverContext.Provider>
      </MemoryRouter>,
    );
  });
  await settle();
}

async function land(id: string, url = `blob:${id}`): Promise<void> {
  pending.get(id)!.resolve(url);
  await settle();
}

async function fail(id: string): Promise<void> {
  pending.get(id)!.reject(new Error(`attachment ${id}: 404`));
  await settle();
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  });
  await settle();
}

async function key(name: string): Promise<void> {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
  });
  await settle();
}

const bubble = (seq: number) => container.querySelector<HTMLElement>(`.chat-user[data-seq="${seq}"]`)!;
const thumbnails = (scope: Element) => [...scope.querySelectorAll<HTMLButtonElement>('button.chat-image-btn')];
const viewer = () => document.querySelector<HTMLElement>('[role="dialog"]');
const shown = () => viewer()?.querySelector('.orbit-image-preview-img')?.getAttribute('src') ?? null;
const position = () => viewer()?.querySelector('.orbit-image-preview-progress')?.textContent ?? null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) => setTimeout(() => frame(performance.now()), 0) as unknown as number);
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => clearTimeout(handle));
  pending = new Map();
  revoked = [];
  resolver.mockClear();
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: (url: string) => revoked.push(url) });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL;
});

describe('a turn’s attachments', () => {
  it('are fetched through the resolver and hold their place until they land; one that fails keeps it', async () => {
    await draw();
    expect(resolver.mock.calls.map(([id]) => id).sort()).toEqual(['diagram', 'later', 'missing', 'tall', 'wide']);
    expect(bubble(1).querySelectorAll('.chat-image.chat-image-loading')).toHaveLength(2);
    expect(bubble(1).querySelector('img')).toBeNull();

    await land('wide');
    await land('tall');
    expect(bubble(1).querySelectorAll('.chat-image-loading')).toHaveLength(0);
    expect(thumbnails(bubble(1)).map((button) => button.querySelector('img')!.getAttribute('src'))).toEqual(['blob:wide', 'blob:tall']);

    await fail('missing');
    expect(bubble(6).querySelectorAll('.chat-image.chat-image-loading')).toHaveLength(2);
    await land('later');
    expect(bubble(6).querySelectorAll('.chat-image-loading')).toHaveLength(1);
    expect(thumbnails(bubble(6))).toHaveLength(1);
  });

  it('revoke their object URLs when the transcript goes, and one that lands after it has gone at once', async () => {
    await draw();
    await land('wide');
    await land('diagram');
    expect(revoked).toEqual([]);
    await act(async () => root.unmount());
    expect(revoked.sort()).toEqual(['blob:diagram', 'blob:wide']);
    pending.get('tall')!.resolve('blob:tall');
    await settle();
    expect(revoked).toContain('blob:tall');
    root = createRoot(container);
  });
});

describe('the viewer', () => {
  it('pages through every thumbnail in the order of the conversation, whatever order the bytes arrived in', async () => {
    await draw();
    // The later turn's picture lands first; the first turn's after it.
    await land('later');
    await land('tall');
    await land('wide');
    await fail('missing');

    await click(thumbnails(bubble(1))[1]);
    expect(viewer()).not.toBeNull();
    expect(shown()).toBe('blob:tall');
    expect(position()).toBe('2 / 4');
    await key('ArrowRight');
    expect(shown()).toBe(`data:image/png;base64,${PNG}`);
    expect(position()).toBe('3 / 4');
    await key('ArrowRight');
    expect(shown()).toBe('blob:later');
    expect(position()).toBe('4 / 4');
    await key('ArrowRight');
    expect(position()).toBe('4 / 4');
    await key('Escape');
    expect(viewer()).toBeNull();
    // The viewer holds no object URL of its own: closing it revokes nothing.
    expect(revoked).toEqual([]);
  });

  it('opens a reply’s Markdown picture on its own', async () => {
    await draw();
    await land('diagram');
    const picture = container.querySelector<HTMLElement>('.md [role="button"][aria-label="Layout diagram"]')!;
    expect(picture.querySelector('img')!.className).toBe('orbit-image-img md-image');
    await click(picture);
    expect(shown()).toBe('blob:diagram');
    expect(position()).toBeNull();
    expect(viewer()!.querySelector('[aria-label="Next image"]')).toBeNull();
  });

  it('opens a queued turn’s picture on its own, since a queued turn is drawn outside the conversation', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <QueuedUserTurn event={EVENTS[0]} turnImages={{ t1: [{ url: 'blob:local-wide', mime: 'image/png' }] }} queued={<span>Queued</span>} />
        </MemoryRouter>,
      );
    });
    await settle();
    const picture = container.querySelector<HTMLElement>('.chat-images [role="button"][aria-label="Image sent by user"]')!;
    expect(picture.querySelector('img')!.getAttribute('src')).toBe('blob:local-wide');
    await click(picture);
    expect(shown()).toBe('blob:local-wide');
    expect(position()).toBeNull();
  });
});

describe('the saved HTML file', () => {
  it('draws plain pictures and no viewer', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ExportCtx.Provider value={{ images: new Map([['wide', 'data:image/png;base64,AAAA'], ['diagram', 'data:image/png;base64,BBBB']]) }}>
          <Transcript events={EVENTS} />
        </ExportCtx.Provider>
      </MemoryRouter>,
    );
    expect(html).toContain('<img class="chat-image" src="data:image/png;base64,AAAA" alt="Image sent by user"/>');
    expect(html).toContain('<img class="md-image" src="data:image/png;base64,BBBB" alt="Layout diagram"/>');
    expect(html).not.toContain('role="button"');
    expect(html).not.toContain('orbit-image');
    expect(html).not.toContain('role="dialog"');
  });
});
