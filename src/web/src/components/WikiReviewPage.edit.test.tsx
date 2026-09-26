// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { App as AntApp } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WikiChangeset, WikiChangesetOp } from '@orbit/shared';
import { WikiReviewPage } from './WikiReviewPage';

/**
 * Review's Edit, driven in a document: the button opens a form on the proposal's own title and one
 * line, and what reaches `POST /api/wiki/changesets/:id/decide` is `action: 'edit'` with the keys the
 * owner changed and no others.
 *
 * WHY THE BODY IS READ OFF THE WIRE: Edit used to send `action: 'edit'` with no form and no `edited`
 * at all — which the server recorded as the owner's edit of words the owner never touched (an add),
 * or refused as WIKI_SCHEMA (an amend). What the request carries is the whole claim, so the fetch
 * below is a small server: it answers the page's reads, records every decide, and drops a decided op
 * from the queue the way the real one does, so what the page does next is what it would do there.
 */

const ADD_TITLE = 'Secret redaction lets ENV_VAR=value secrets through';
const ADD_SUMMARY = 'A watch delivery stores the value unredacted.';
const ENTRY_ID = '0196b200-0000-7000-8000-00000000bbbb';
const ENTRY = {
  id: ENTRY_ID,
  spaceId: '0196b200-0000-7000-8000-0000000000dd',
  kind: 'recipe',
  title: 'Upgrade rebuilds only what changed',
  summary: 'Rebuild the images and recreate every service.',
  fields: {},
  topics: [],
  aliases: [],
  anchors: [],
  trust: 'confirmed',
  status: 'active',
  currentRevision: 3,
  sources: [],
  history: [],
  exposure: [],
};
const AMEND_SUMMARY = 'Rebuild the images and recreate only the services that changed.';

let counter = 0;
const id = (): string => `0196b200-0000-7000-8000-${String(++counter).padStart(12, '0')}`;

function op(over: Partial<WikiChangesetOp> = {}): WikiChangesetOp {
  return {
    id: id(),
    changesetId: 'changeset',
    seq: 0,
    op: 'add',
    entryId: null,
    baseRevision: null,
    payload: {},
    similar: [],
    tainted: false,
    decision: 'pending',
    decisionReason: null,
    decisionNote: null,
    resultEntryId: null,
    resultRevision: null,
    decidedAt: null,
    ...over,
  } as WikiChangesetOp;
}

function changeset(ops: WikiChangesetOp[]): WikiChangeset {
  return {
    id: id(),
    spaceId: ENTRY.spaceId,
    origin: 'agent',
    sessionId: null,
    toolCallId: null,
    rationale: 'a session',
    status: 'pending',
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    decidedAt: null,
    expiresAt: null,
    ops,
  } as WikiChangeset;
}

const addOf = (title: string, summary = ADD_SUMMARY) =>
  op({ op: 'add', payload: { entry: { kind: 'pitfall', title, summary, fields: {}, anchors: [] } } });

const AMEND = () =>
  op({ op: 'amend', entryId: ENTRY_ID, baseRevision: 3, payload: { changes: { summary: AMEND_SUMMARY } } });

// ── the server ────────────────────────────────────────────────────────────────────────────────────

let queue: WikiChangeset[] = [];
/** When set, every decide is answered with this instead of being applied. */
let refusal: { status: number; body: Record<string, unknown> } | null = null;
let decides: Array<{ url: string; body: { decisions: Array<Record<string, unknown>> } }> = [];

const reply = (status: number, body: unknown): Response =>
  ({
    ok: status < 400,
    status,
    statusText: '',
    text: async () => JSON.stringify(body),
    json: async () => body,
  }) as unknown as Response;

async function serve(url: string, init?: RequestInit): Promise<Response> {
  if (init?.method === 'POST' && /^\/api\/wiki\/changesets\/[^/]+\/decide$/.test(url)) {
    const body = JSON.parse(String(init.body)) as (typeof decides)[number]['body'];
    decides.push({ url, body });
    if (refusal) return reply(refusal.status, refusal.body);
    const decided = new Set(body.decisions.map((decision) => decision.opId));
    queue = queue.map((row) => ({
      ...row,
      ops: row.ops.map((one) => (decided.has(one.id) ? { ...one, decision: 'edited' } : one)),
    })) as WikiChangeset[];
    return reply(200, {});
  }
  if (url.startsWith('/api/wiki/review')) return reply(200, queue);
  if (url.startsWith('/api/wiki/spaces')) return reply(200, []);
  if (url.startsWith(`/api/wiki/entries/${ENTRY_ID}`)) return reply(200, ENTRY);
  return reply(404, { message: `${url} is not in this fixture` });
}

// ── the page ──────────────────────────────────────────────────────────────────────────────────────

let container: HTMLDivElement;
let root: Root;

/** The width the page reads: a phone, or (by default) anything wider. */
function viewport(phone: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: phone && query === '(max-width: 600px)',
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('fetch', vi.fn(serve));
  viewport(false);
  refusal = null;
  decides = [];
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  for (let tick = 0; tick < 4; tick += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

/** Review over `changesets`, once the card that names `ready` is on screen. */
async function mount(changesets: WikiChangeset[], ready: string): Promise<void> {
  queue = changesets;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          {/* The app mounts AntD's `App`, which is what gives `App.useApp()` its message API. */}
          <AntApp>
            <WikiReviewPage spaceSlug={null} />
          </AntApp>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await vi.waitFor(() => expect(cardOf(ready)).toBeTruthy(), { timeout: 10_000 });
  await settle();
}

function cardOf(title: string): HTMLElement {
  const card = [...container.querySelectorAll<HTMLElement>('.approval-card')].find((one) =>
    one.textContent?.includes(title),
  );
  if (!card) throw new Error(`no card says “${title}”`);
  return card;
}

const buttonIn = (scope: Element, text: string): HTMLButtonElement => {
  const found = [...scope.querySelectorAll('button')].find((button) => button.textContent === text);
  if (!found) throw new Error(`no ${text} button`);
  return found;
};

const form = (): HTMLElement | null => document.body.querySelector<HTMLElement>('.ant-modal');
const titleField = (): HTMLInputElement => form()!.querySelector('input.ant-input') as HTMLInputElement;
const summaryField = (): HTMLTextAreaElement => form()!.querySelector('textarea.ant-input') as HTMLTextAreaElement;
/** The form's own Accept — not the card's, which is the button beside Edit. */
const acceptInForm = (): HTMLButtonElement =>
  form()!.querySelector('.ant-modal-footer .ant-btn-primary') as HTMLButtonElement;

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

/** Type into a field through React's own setter, so the change is one React sees. */
async function type(field: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function openEdit(title: string): Promise<void> {
  await click(buttonIn(cardOf(title), 'Edit'));
  await vi.waitFor(() => expect(form()).not.toBeNull(), { timeout: 10_000 });
}

// ── the tests ─────────────────────────────────────────────────────────────────────────────────────

describe("Review's Edit", () => {
  it("opens a form on the proposal's own title and one line, and decides nothing yet", async () => {
    const add = addOf(ADD_TITLE);
    await mount([changeset([add])], ADD_TITLE);
    expect(form()).toBeNull();

    await openEdit(ADD_TITLE);
    expect(titleField().value).toBe(ADD_TITLE);
    expect(summaryField().value).toBe(ADD_SUMMARY);
    // The card's answers are unchanged by it: Accept · Edit · Reject, in that order.
    const answers = [...cardOf(ADD_TITLE).querySelectorAll('.card-actions button')].map((b) => b.textContent);
    expect(answers).toEqual(['Accept', 'Edit', 'Reject']);
    expect(decides).toEqual([]);
  });

  it('sends the title the owner changed, and not the summary they left alone', async () => {
    const add = addOf(ADD_TITLE);
    const cs = changeset([add]);
    await mount([cs], ADD_TITLE);
    await openEdit(ADD_TITLE);

    await type(titleField(), 'Secret redaction misses keys joined by an underscore');
    await click(acceptInForm());

    expect(decides).toHaveLength(1);
    expect(decides[0].url).toBe(`/api/wiki/changesets/${cs.id}/decide`);
    expect(decides[0].body).toEqual({
      decisions: [
        { opId: add.id, action: 'edit', edited: { title: 'Secret redaction misses keys joined by an underscore' } },
      ],
    });
    expect('summary' in (decides[0].body.decisions[0].edited as object)).toBe(false);
    // Accepted, like Accept: the form closes and the decided card leaves the queue.
    await vi.waitFor(() => expect(form()).toBeNull(), { timeout: 10_000 });
    await vi.waitFor(() => expect(container.textContent).toContain('Nothing is waiting for you.'), { timeout: 10_000 });
  });

  it("opens an amend on the entry with the amend's changes over it, and sends its edit as edited", async () => {
    const amend = AMEND();
    await mount([changeset([amend])], ENTRY.title);
    await openEdit(ENTRY.title);
    // The title is the entry's — the amend does not change it — and the one line is the amend's.
    expect(titleField().value).toBe(ENTRY.title);
    expect(summaryField().value).toBe(AMEND_SUMMARY);

    await type(titleField(), 'Upgrade recreates only the services that changed');
    await click(acceptInForm());

    expect(decides).toHaveLength(1);
    expect(decides[0].body.decisions).toEqual([
      { opId: amend.id, action: 'edit', edited: { title: 'Upgrade recreates only the services that changed' } },
    ]);
  });

  it('cannot be sent while nothing has changed', async () => {
    await mount([changeset([addOf(ADD_TITLE)])], ADD_TITLE);
    await openEdit(ADD_TITLE);
    expect(acceptInForm().disabled).toBe(true);
    await click(acceptInForm());
    expect(decides).toEqual([]);

    // Space around the same words is the same words; a change undone is no change.
    await type(titleField(), `  ${ADD_TITLE} `);
    expect(acceptInForm().disabled).toBe(true);
    await type(summaryField(), 'Something else entirely.');
    expect(acceptInForm().disabled).toBe(false);
    await type(summaryField(), ADD_SUMMARY);
    expect(acceptInForm().disabled).toBe(true);
    expect(decides).toEqual([]);
  });

  it('keeps the form open with the refusal in it when the server says no', async () => {
    refusal = {
      status: 400,
      body: { code: 'WIKI_SCHEMA', message: "the owner's edit does not have the shape this contract gives it" },
    };
    await mount([changeset([addOf(ADD_TITLE)])], ADD_TITLE);
    await openEdit(ADD_TITLE);
    await type(titleField(), 'A title the server refuses');
    await click(acceptInForm());

    expect(decides).toHaveLength(1);
    expect(form()).not.toBeNull();
    expect(form()!.querySelector('.ant-alert')?.textContent).toContain(
      "the owner's edit does not have the shape this contract gives it",
    );
    // What the owner typed is still there to fix and send again.
    expect(titleField().value).toBe('A title the server refuses');
    expect(acceptInForm().disabled).toBe(false);
  });

  it('turns to the next proposal on a phone once the edit is accepted, as Accept does', async () => {
    viewport(true);
    await mount([changeset([addOf('The first proposal')]), changeset([addOf('The second proposal')])], 'The first proposal');
    expect(container.textContent).toContain('1 of 2');
    expect(container.textContent).not.toContain('The second proposal');

    await openEdit('The first proposal');
    await type(titleField(), 'The first proposal, as the owner put it');
    await click(acceptInForm());

    await vi.waitFor(() => expect(cardOf('The second proposal')).toBeTruthy(), { timeout: 10_000 });
    expect(container.textContent).not.toContain('The first proposal');
    expect(form()).toBeNull();
  });
});
