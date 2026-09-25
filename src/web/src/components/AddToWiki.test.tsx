// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { App as AntApp } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADD_TO_WIKI, ADD_TO_WIKI_OWNER_NOTE, ADD_TO_WIKI_SOURCE, AddToWikiRow, titleFromSelection, useAddToWiki, AddToWikiCtx } from './AddToWiki';
import { encodeId } from '../lib/idCodec';

/**
 * Add to Wiki: the row under a reply, and the form it opens — mock 05c.
 *
 * What is pinned here is the write as much as the drawing: the entry goes to the OWNER's door
 * (`POST /api/wiki/spaces/:id/changesets`, which is what makes it apply at once with trust owner
 * instead of waiting in Review), the space is the one the server resolves for THIS conversation's
 * workspace, and the provenance is the turn the message belongs to. A selection inside the message
 * is what prefills it, and a selection somewhere else on the page is not this message's.
 */

const SESSION = encodeId('01a0d1f2-3a44-7c11-9b02-5f6e7d8c9a10');
const SPACE = '34Tcl0kralZrY8opuLJU4';
const TURN = '01a0d1f2-3a44-7c11-9b02-aa0b1c2d3e4f';

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

const okJson = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body }) as unknown as Response;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // AntD's Selects observe their own box; jsdom has no ResizeObserver, and without it the form
  // throws on mount rather than drawing (the same stub the other AntD-rendering specs carry).
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  fetchMock = vi.fn(async (url: string) =>
    url.startsWith('/api/wiki/spaces/for-session/')
      ? okJson({ id: SPACE, slug: 'orbit', title: 'Orbit' })
      : url.startsWith('/api/wiki/spaces/')
        ? okJson({ changesetId: 'cs', replayed: false, ops: [{ seq: 0, status: 'applied', opId: 'op', entryId: 'e', revision: 1 }] })
        : okJson({}),
  );
  vi.stubGlobal('fetch', fetchMock);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

/** A selection inside `el`, as the browser reports one: the range's ancestor is a node in it. */
function selectWithin(el: Element, text: string): void {
  const range = document.createRange();
  range.selectNodeContents(el);
  vi.stubGlobal('getSelection', () => ({
    isCollapsed: false,
    rangeCount: 1,
    toString: () => text,
    getRangeAt: () => range,
  }));
}

async function mount(
  row: React.ReactNode,
  /** `null` is a page with no conversation to write as — a shared link, or a static export. */
  conversation: { sessionId: string; title: string } | null = {
    sessionId: SESSION,
    title: 'Orbit：给任务加优先级',
  },
) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
        <MemoryRouter>
          {/* The app mounts AntD's `App`, which is what gives `App.useApp()` its message API. */}
          <AntApp>
            <AddToWikiCtx.Provider value={conversation}>{row}</AddToWikiCtx.Provider>
          </AntApp>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  for (let tick = 0; tick < 2; tick += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  for (let tick = 0; tick < 2; tick += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

/** The reply's row, with the message element it reads a selection out of. */
function Reply({ text = 'Got it. A runner update never evicts a turn in flight.' } = {}) {
  const messageRef = { current: null as HTMLElement | null };
  return (
    <div className="chat-msg chat-assistant" ref={(el) => { messageRef.current = el; }}>
      <span>{text}</span>
      <AddToWikiRow text={text} turnId={TURN} messageRef={messageRef} time="2h ago" />
    </div>
  );
}

/** The form's own fields, in the order they are drawn. `ant-input` and not every `input`: an
 *  AntD Select carries a search input of its own, which is not a field of this form. */
const title = () => container.querySelector('.wk-form input.ant-input') as HTMLInputElement;
const areas = () => [...container.querySelectorAll('.wk-form textarea.ant-input')] as HTMLTextAreaElement[];

describe('the row under a reply', () => {
  it('offers the copy button, Add to Wiki and the time — and the form on a click', async () => {
    await mount(<Reply />);
    expect(container.querySelector('.chat-copy')).not.toBeNull();
    expect(container.querySelector('.wk-addwiki')?.textContent).toContain(ADD_TO_WIKI);
    expect(container.querySelector('.chat-time')?.textContent).toBe('2h ago');
    expect(container.querySelector('.wk-pop')).toBeNull();

    await click(container.querySelector('.wk-addwiki') as Element);
    expect(container.querySelector('.wk-pop')).not.toBeNull();
    // The source line names the message and the conversation it is in, and the foot says what
    // writing one here means: yours, live at once.
    expect(container.querySelector('.wk-src-auto')?.textContent).toContain(
      `${ADD_TO_WIKI_SOURCE} · Orbit：给任务加优先级`,
    );
    expect(container.querySelector('.wk-pop-foot')?.textContent).toContain(ADD_TO_WIKI_OWNER_NOTE);
    expect(container.querySelector('.wk-pop-foot .tdp-badge.tone-owner')?.textContent).toBe('Owner');
  });

  it('prefills the summary with the selection and derives a title from it', async () => {
    await mount(<Reply />);
    selectWithin(container.querySelector('.chat-msg') as Element, 'A runner update never evicts a turn in flight. If one is running, it skips.');
    await click(container.querySelector('.wk-addwiki') as Element);
    const [summary] = areas();
    expect(summary.value).toBe(
      'A runner update never evicts a turn in flight. If one is running, it skips.',
    );
    expect(title().value).toBe('A runner update never evicts a turn in flight');
  });

  it('ignores a selection made outside this message', async () => {
    await mount(<Reply />);
    const elsewhere = document.createElement('p');
    document.body.append(elsewhere);
    selectWithin(elsewhere, '一些完全别处的字');
    await click(container.querySelector('.wk-addwiki') as Element);
    expect(areas()[0]?.value).toBe('');
    elsewhere.remove();
  });
});

describe('the write', () => {
  it('files into the space the server resolves for this conversation, citing the turn', async () => {
    await mount(<Reply />);
    await click(container.querySelector('.wk-addwiki') as Element);
    /** Type into one of the form's own inputs, through React's setter so it sees the change. */
    const set = async (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
      await act(async () => {
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    // Title and Summary are the two the door requires; the rest of the kind's schema is walked
    // after them — a principle's `statement` and `rationale`.
    await set(title(), 'A runner update never evicts a turn in flight');
    const [summary, statement, rationale] = areas();
    await set(summary, 'A runner update never evicts a turn in flight.');
    await set(statement, 'An update skips while a turn runs.');
    await set(rationale, 'Evicting a turn loses its work.');

    const add = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Add') as HTMLButtonElement;
    await click(add);

    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'POST');
    expect(post?.[0]).toBe(`/api/wiki/spaces/${SPACE}/changesets`);
    const body = JSON.parse(String((post?.[1] as RequestInit).body)) as {
      ops: Array<{ op: string; entry: Record<string, unknown>; sources: Array<Record<string, unknown>> }>;
    };
    expect(body.ops[0].op).toBe('add');
    expect(body.ops[0].entry).toMatchObject({
      kind: 'principle',
      title: 'A runner update never evicts a turn in flight',
      summary: 'A runner update never evicts a turn in flight.',
      fields: { statement: 'An update skips while a turn runs.', rationale: 'Evicting a turn loses its work.' },
    });
    // The turn, and nothing else: the record is what makes it a memory rather than an assertion.
    expect(body.ops[0].sources).toEqual([{ kind: 'turn', ref: TURN }]);
  });

  it('files nowhere until the space answers, and says so when there is none', async () => {
    // The refusal the door writes when the workspace is bound to nothing and has no repository URL
    // to bind on (`WIKI_SPACE_UNBOUND`), as the wire carries it: a status, and the sentence.
    fetchMock = vi.fn(async (url: string) =>
      url.startsWith('/api/wiki/spaces/for-session/')
        ? ({
            ok: false,
            status: 422,
            text: async () => JSON.stringify({ code: 'WIKI_SPACE_UNBOUND', message: 'This workspace is bound to no wiki space.' }),
            json: async () => ({ code: 'WIKI_SPACE_UNBOUND', message: 'This workspace is bound to no wiki space.' }),
          } as unknown as Response)
        : okJson({}),
    );
    vi.stubGlobal('fetch', fetchMock);
    await mount(<Reply />);
    await click(container.querySelector('.wk-addwiki') as Element);
    const add = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Add') as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(container.textContent).toContain('This workspace is bound to no wiki space.');
  });
});

describe('where the row is not', () => {
  it('draws nothing at all outside a conversation somebody can write to', async () => {
    await mount(
      <AddToWikiRow text="a reply" turnId={TURN} messageRef={{ current: null }} time="2h ago" />,
      null,
    );
    expect(container.querySelector('.wk-addwiki')).toBeNull();
    expect(container.querySelector('.wk-pop')).toBeNull();
    // The copy button and the time are not a write surface, so they stay.
    expect(container.querySelector('.chat-copy')).not.toBeNull();
  });
});

describe('the title a selection suggests', () => {
  it('is the first sentence without its full stop, and nothing when there is no sentence', () => {
    expect(titleFromSelection('A runner update never evicts a turn in flight. And more.')).toBe(
      'A runner update never evicts a turn in flight',
    );
    expect(titleFromSelection('闭集一律用 CHECK 约束表达。后面还有一句。')).toBe('闭集一律用 CHECK 约束表达');
    // No sentence ending in it: the field is left for the person rather than cut in half.
    expect(titleFromSelection('a clause with no end')).toBe('');
    expect(titleFromSelection('')).toBe('');
    // Too long for a title: the same answer.
    expect(titleFromSelection(`${'x'.repeat(200)}.`)).toBe('');
  });
});
