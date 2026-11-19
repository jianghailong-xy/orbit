// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WikiChatDraftView, WikiDocSectionVersionView } from '@orbit/shared';
import { WikiDraftCard, WikiDraftCardCtx, type WikiDraftCardHost } from './WikiDraftCard';
import { WIKI_CHAT_REDO_MESSAGE } from '../lib/wikiChat';
import { wikiMonthDayTime } from '../lib/wikiDocs';

/**
 * A chat's card (docs/wiki-chat-design.md §7–§8, contract `chat.drafts` and `chat.presses`, board 42 ② ③ ④), drawn from
 * its id over a fake API: every state the server reads, with the buttons each offers and what each press sends; the
 * tag of a card drafted on web content; an applied card still waiting in Review; the line under an applied card for
 * every result of its rewrite; See changes, sentence by sentence; and the seen press a settled rewrite makes when shown.
 */

const SPACE = '0196f000-0000-7000-8000-000000000001';
const ADD = {
  seq: 0,
  op: 'add' as const,
  entryId: null,
  baseRevision: null,
  similar: [],
  tainted: false,
  entry: null,
  decision: null,
  payload: {
    entry: {
      kind: 'decision',
      title: 'Runner offline after three missed heartbeats',
      summary: 'Three missed heartbeats, not one, mark a runner offline.',
      fields: { decision: 'Three missed heartbeats mark a runner offline.' },
    },
    sources: [
      { kind: 'turn', session: 'self', quote: 'Keep three.' },
      { kind: 'commit', ref: '99cd3c4'.padEnd(40, '0'), locator: { path: 'src/apiserver/src/runners/runner-presence.ts', lines: '30-31' } },
    ],
  },
};
const REWRITES = [
  { doc: 'sessions-runtime', key: 'turn-delivery', where: '3.1 §3', title: 'Turn delivery and inbox claims' },
  { doc: 'runner-architecture', key: 'heartbeat', where: '7.1 §2', title: 'Heartbeats and going offline' },
];

function draft(over: Partial<WikiChatDraftView> = {}): WikiChatDraftView {
  return {
    id: 'D1',
    sessionId: 'S1chat',
    kind: 'entry',
    state: 'draft',
    label: 'Add decision',
    rationale: 'To ride out one gateway restart; one blip must not stop Resume.',
    ops: [ADD],
    sections: [],
    rewrites: REWRITES,
    similar: [{ id: 'E9', kind: 'decision', title: 'Heartbeat interval', status: 'active', trust: 'confirmed', score: 0.4 }],
    tainted: false,
    replaces: null,
    replacedBy: null,
    decision: null,
    decidedAt: null,
    undoneAt: null,
    undoable: false,
    changesetId: null,
    rewrite: null,
    createdAt: '2026-11-06T10:00:00.000Z',
    ...over,
  };
}

const UPDATED: NonNullable<WikiChatDraftView['rewrite']> = {
  jobId: 'J1',
  result: 'updated',
  reason: null,
  sha: '7f3e2a1c9b8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f',
  sections: [
    { doc: 'sessions-runtime', key: 'turn-delivery', where: '3.1 §3', result: 'updated', changed: 1, versionId: 'V2' },
    { doc: 'runner-architecture', key: 'heartbeat', where: '7.1 §2', result: 'same', changed: 0, versionId: null },
  ],
  seen: false,
  settledAt: '2026-11-06T10:05:00.000Z',
};

const VERSIONS: WikiDocSectionVersionView[] = [
  {
    id: 'V2',
    reason: { kind: 'chat', title: 'Runner offline: why three heartbeats' },
    at: '2026-11-06T10:05:00.000Z',
    replacedBy: { kind: 'job', jobId: 'J1' },
    changed: 1,
    rows: [
      { op: 'same', text: 'Heartbeats tell the control plane a runner is gone.' },
      { op: 'added', text: 'Three are kept so one gateway restart does not stop Resume.' },
      { op: 'same', text: 'The mechanism keeps the control plane current.' },
    ],
  },
  {
    id: 'V1',
    reason: { kind: 'maintenance' },
    at: '2026-11-01T08:00:00.000Z',
    replacedBy: { kind: 'job', jobId: 'J0' },
    changed: 1,
    rows: [
      { op: 'removed', text: 'Runners report every minute.' },
      { op: 'added', text: 'Runners send a heartbeat every 30 seconds.' },
    ],
  },
];

/** The card as the server reads it now; a press answers it as the press leaves it. */
let card: WikiChatDraftView;
let writes: Array<{ method: string; path: string; body: Record<string, unknown> }>;
/** What the next press answers instead of the card: a refusal. */
let refuse: { status: number; body: Record<string, unknown> } | null;

const reply = (status: number, body: unknown): Response =>
  ({ ok: status < 400, status, statusText: '', text: async () => JSON.stringify(body), json: async () => body }) as unknown as Response;

async function serve(url: string, init?: RequestInit): Promise<Response> {
  const path = url.split('?')[0]!;
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method === 'POST') {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    writes.push({ method, path, body });
    if (refuse) return reply(refuse.status, refuse.body);
    const press = path.split('/').pop();
    if ((press === 'apply' || press === 'edit') && card.kind === 'plan' && card.change) {
      // A plan card's press: the version it made, undoable while the plan stands there, its rebuild under it (contract
      // `chat.presses.apply`, `chat.presses.undo`).
      card = {
        ...card, state: 'applied', decision: 'applied', undoable: true, change: { ...card.change, version: card.change.baseVersion + 1 },
        rewrite: {
          jobId: 'B1', result: 'rewriting', reason: null, sha: null, seen: false, settledAt: null,
          sections: card.rewrites.map((one) => ({ doc: one.doc, key: one.key, where: one.where, result: null, changed: null, versionId: null })),
        },
      };
    } else if (press === 'apply' || press === 'edit') card = { ...card, state: 'applied', decision: press === 'edit' ? 'edited' : 'applied', undoable: true };
    if (press === 'discard') card = { ...card, state: 'discarded', decision: 'discarded' };
    if (press === 'undo') card = { ...card, state: 'undone', undoable: false };
    if (press === 'retry' && card.rewrite) card = { ...card, rewrite: { ...card.rewrite, result: 'rewriting', reason: null } };
    if (press === 'seen' && card.rewrite) card = { ...card, rewrite: { ...card.rewrite, seen: true } };
    return reply(200, { replayed: false, draft: card });
  }
  if (path === '/api/wiki/chat-drafts/D1') return reply(200, card);
  if (path === `/api/wiki/spaces/${SPACE}/docs/sessions-runtime/sections/turn-delivery/versions`) {
    return reply(200, { spaceId: SPACE, slug: 'sessions-runtime', key: 'turn-delivery', versions: VERSIONS });
  }
  return reply(404, { message: `${url} is not in this fixture` });
}

let container: HTMLDivElement;
let root: Root;
let host: WikiDraftCardHost & { calls: string[] };

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  card = draft();
  writes = [];
  refuse = null;
  const calls: string[] = [];
  host = {
    calls,
    spaceId: SPACE,
    openSection: (doc, key) => void calls.push(`section ${doc}#${key}`),
    openEntry: (entryId) => void calls.push(`entry ${entryId}`),
    openReview: (changesetId, seq) => void calls.push(`review ${changesetId}#${seq}`),
    openSettings: () => void calls.push('settings'),
    openPlan: (doc) => void calls.push(doc ? `plan ${doc}` : 'plan'),
    send: async (text) => void calls.push(`send ${text}`),
    focus: null,
  };
  vi.stubGlobal('fetch', vi.fn(serve));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  for (let tick = 0; tick < 8; tick += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

/** Draw the card as a fresh read of `view`: a new root and a new cache, as opening the chat again would. */
async function show(view: WikiChatDraftView = card): Promise<void> {
  card = view;
  act(() => root.unmount());
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <WikiDraftCardCtx.Provider value={host}>
            <WikiDraftCard draftId="D1" />
          </WikiDraftCardCtx.Provider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle();
}

const text = (selector: string): string => (document.querySelector(selector)?.textContent ?? '').replace(/\s+/g, ' ').trim();
const buttons = (selector = '.wk-draft-acts'): string[] =>
  [...document.querySelectorAll(`${selector} button`)].map((button) => button.textContent?.trim() ?? '');
const button = (label: string): HTMLButtonElement =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((one) => one.textContent?.trim() === label)!;
async function press(label: string): Promise<void> {
  const target = button(label);
  expect(target, label).toBeTruthy();
  await act(async () => target.click());
  await settle();
}
const pressed = (): string[] => writes.map((write) => write.path.replace('/api/wiki/chat-drafts/D1/', ''));
/** The card's rows, label and value, as its grid lays them out. */
const rows = (): Array<[string, string]> => {
  const cells = [...document.querySelectorAll('.wk-draft-kv > span')].map((cell) => (cell.textContent ?? '').replace(/\s+/g, ' ').trim());
  return cells.flatMap((cell, i) => (i % 2 === 0 ? [[cell, cells[i + 1] ?? ''] as [string, string]] : []));
};

describe('a card in each state the server reads (design §7.3)', () => {
  it('draws an open draft with what it would do: the entry’s words, why, the sources, the sections it rewrites, the entries it may duplicate', async () => {
    await show();
    expect(text('.wk-draft-k')).toBe('Draft · Add decision');
    expect(document.querySelector('.wk-draft-k')!.className).toContain('brand');
    expect(text('.wk-draft-ti')).toBe('Runner offline after three missed heartbeats');
    expect(rows()).toEqual([
      ['Decision', 'Three missed heartbeats mark a runner offline.'],
      ['Why', 'To ride out one gateway restart; one blip must not stop Resume.'],
      ['Sources', 'Your message in this chat src/apiserver/src/runners/runner-presence.ts L30-31 · 99cd3c4'],
      ['Rewrites', '3.1 §3 · 7.1 §2'],
      ['Similar', 'Heartbeat interval'],
    ]);
    expect(buttons()).toEqual(['Apply', 'Edit', 'Discard']);
    expect(button('Apply').className).toContain('orbit-button-primary');
    // No rewrite line before the press.
    expect(document.querySelector('.wk-draft-result')).toBeNull();
  });

  it.each([
    ['replaced', { state: 'replaced', replacedBy: 'D2' }, 'Replaced', 'grey', 'A newer draft took over.', []],
    ['changed since it was drafted', { state: 'changed' }, 'Changed since this draft', 'amber', null, ['Redo', 'Discard']],
    ['discarded', { state: 'discarded', decision: 'discarded' }, 'Discarded', 'grey', null, []],
    ['not applied: its chat ended', { state: 'not_applied' }, 'Not applied', 'grey', null, []],
    ['undone', { state: 'undone', decision: 'applied', undoneAt: '2026-11-06T11:00:00.000Z' }, 'Undone', 'grey', null, []],
    ['applied', { state: 'applied', decision: 'applied', undoable: true }, 'Applied · Confirmed by you', 'ok', null, ['Undo', 'Open entry']],
  ] as const)('%s', async (_name, over, title, tone, note, offered) => {
    await show(draft(over as Partial<WikiChatDraftView>));
    expect(text('.wk-draft-k')).toBe(title);
    expect(document.querySelector('.wk-draft-k')!.className).toContain(tone);
    expect(document.querySelector('.wk-draft-note')?.textContent ?? null).toBe(note);
    expect(buttons()).toEqual(offered);
    // A settled card is quiet and says what it was about; only an open one lists what it would do.
    const open = over.state === 'changed';
    expect(document.querySelector('.wk-draft-card')!.className.includes('quiet')).toBe(!open);
    expect(text('.wk-draft-ti')).toBe('Runner offline after three missed heartbeats');
    expect(!!document.querySelector('.wk-draft-kv')).toBe(open);
  });

  it('draws a rewrite card with Rewrite, and a plan card with Apply & rebuild and Open in Plan', async () => {
    await show(draft({ kind: 'rewrite', label: 'Rewrite from main', ops: [], similar: [], rewrites: [REWRITES[0]!] }));
    expect(text('.wk-draft-k')).toBe('Draft · Rewrite from main');
    expect(text('.wk-draft-ti')).toBe('3.1 §3 Turn delivery and inbox claims');
    expect(buttons()).toEqual(['Rewrite', 'Discard']);
    await press('Rewrite');
    expect(pressed()).toEqual(['apply']);

    await show(draft({ kind: 'plan', label: 'Plan change', ops: [], similar: [], rewrites: [] }));
    expect(text('.wk-draft-k')).toBe('Draft · Plan change');
    expect(buttons()).toEqual(['Apply & rebuild', 'Open in Plan', 'Discard']);
    await press('Open in Plan');
    expect(host.calls).toEqual(['plan']);
  });

  it('tags a card drafted after the chat read the web, whatever its state', async () => {
    for (const state of ['draft', 'applied'] as const) {
      await show(draft({ tainted: true, state }));
      expect(text('.wk-draft-web')).toBe('Based on web content · Read before you apply.');
    }
  });

  it('says an applied card whose challenge waits in Review is In Review, and opens that item of Review', async () => {
    await show(draft({
      state: 'applied',
      decision: 'applied',
      label: 'Challenge entry',
      changesetId: 'C7',
      ops: [{ seq: 0, op: 'challenge', entryId: 'E1', baseRevision: 3, payload: {}, similar: [], tainted: false, entry: { title: 'Lease length' }, decision: 'pending' }],
    }));
    expect(text('.wk-draft-k')).toBe('Applied · In Review');
    expect(text('.wk-draft-k')).not.toMatch(/Confirmed/u);
    expect(document.querySelector('.wk-draft-k')!.className).toContain('amber');
    await press('Keep, amend or retire the entry in Review.');
    expect(host.calls).toEqual(['review C7#0']);
    expect(buttons()).toEqual(['Open entry']);
  });
});

describe('the presses (design §7.2, contract `chat.presses`)', () => {
  it('Apply presses the owner’s door, and the card reads what the server answers', async () => {
    await show();
    await press('Apply');
    expect(writes).toEqual([{ method: 'POST', path: '/api/wiki/chat-drafts/D1/apply', body: {} }]);
    expect(text('.wk-draft-k')).toBe('Applied · Confirmed by you');
    expect(buttons()).toEqual(['Undo', 'Open entry']);
  });

  it('Discard and Undo press theirs', async () => {
    await show();
    await press('Discard');
    expect(text('.wk-draft-k')).toBe('Discarded');
    await show(draft({ state: 'applied', decision: 'applied', undoable: true }));
    await press('Undo');
    expect(pressed()).toEqual(['discard', 'undo']);
    expect(text('.wk-draft-k')).toBe('Undone');
    // An entry's Undo stands as it is: no note under the title.
    expect(document.querySelector('.wk-draft-note')).toBeNull();
  });

  it('an undone Rewrite from main says that the next maintenance run writes it from main again, if main has moved its files', async () => {
    // Design §8.4 (owner 11-07): the Undo puts back the version written at an older commit, and the next run follows main.
    await show(draft({
      kind: 'rewrite', label: 'Rewrite from main', ops: [], similar: [], rewrites: [REWRITES[0]!],
      state: 'applied', decision: 'applied', undoable: true, rewrite: { ...UPDATED, seen: true },
    }));
    expect(document.querySelector('.wk-draft-note')).toBeNull();
    await press('Undo');
    expect(pressed()).toEqual(['undo']);
    expect(text('.wk-draft-k')).toBe('Undone');
    expect(text('.wk-draft-note')).toBe('If main has changed the files this section draws on, the next maintenance run writes it from main again.');
    // A line, not a button: there is nothing to press about it.
    expect(document.querySelector('.wk-draft-note')!.tagName).toBe('DIV');
  });

  it('Edit lays the owner’s version over the op and applies it; with nothing changed it waits', async () => {
    await show();
    await press('Edit');
    const apply = () => [...document.querySelectorAll<HTMLButtonElement>('.wk-draft-edit button')].find((b) => b.textContent === 'Apply')!;
    expect(apply().disabled).toBe(true);
    const title = document.querySelector<HTMLInputElement>('.wk-draft-edit input[aria-label="Title"]')!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(title, 'Runner offline after three missed heartbeats (90 s)');
      title.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(apply().disabled).toBe(false);
    await act(async () => apply().click());
    await settle();
    expect(writes).toEqual([
      { method: 'POST', path: '/api/wiki/chat-drafts/D1/edit', body: { ops: [{ seq: 0, changes: { title: 'Runner offline after three missed heartbeats (90 s)' } }] } },
    ]);
    expect(document.querySelector('.wk-draft-edit')).toBeNull();
    expect(text('.wk-draft-k')).toBe('Applied · Confirmed by you');
  });

  it('Redo asks the chat for a new draft in the contract’s words; Open entry and the Rewrites open beside the chat', async () => {
    await show(draft({ state: 'changed' }));
    await press('Redo');
    expect(host.calls).toEqual([`send ${WIKI_CHAT_REDO_MESSAGE}`]);
    expect(writes).toEqual([]);

    await show(draft());
    await press('7.1 §2');
    await press('Heartbeat interval');
    await show(draft({ state: 'applied', decision: 'applied', undoable: true, ops: [{ ...ADD, entryId: 'E5' }] }));
    await press('Open entry');
    expect(host.calls.slice(1)).toEqual(['section runner-architecture#heartbeat', 'entry E9', 'entry E5']);
  });

  it('says a refused press in the server’s words, and keeps the card as it was', async () => {
    await show();
    refuse = { status: 409, body: { message: 'what this card changes changed since it was drafted: nothing was applied. Ask the chat to draft it again from what is there now (Redo)', code: 'WIKI_REVISION_CONFLICT' } };
    await press('Apply');
    expect(text('.wk-draft-failed')).toBe(
      'The card couldn’t be pressed: what this card changes changed since it was drafted: nothing was applied. Ask the chat to draft it again from what is there now (Redo)',
    );
    expect(text('.wk-draft-k')).toBe('Draft · Add decision');
  });
});

/** A plan card (C12): the owner's words put on a section's covers, against version 4 of the plan. */
const PLAN_CHANGE: NonNullable<WikiChatDraftView['change']> = {
  baseVersion: 4,
  version: null,
  docs: [{
    slug: 'sessions-runtime', title: 'Sessions runtime', number: '3.1', added: false,
    category: { key: 'runtime', title: 'Runtime', opens: false },
    fields: [],
    sections: [
      { key: 'recovery', title: 'Recovery', number: 2, edit: 'changed', fields: ['covers'], covers: 'What survives a respawn, for a first-time reader: the model first.' },
    ],
  }],
  moves: [],
};
/** A split (C17, board 42 ③): 3.1's §3 moved into a new document, 3.5, and 3.1's §1 written for a first-time reader. */
const SPLIT: NonNullable<WikiChatDraftView['change']> = {
  baseVersion: 4,
  version: null,
  docs: [
    { slug: 'sessions-runtime', title: 'Sessions runtime', number: '3.1', added: false, category: { key: 'runtime', title: 'Runtime', opens: false }, fields: [],
      sections: [{ key: 's1', title: 'Overview', number: 1, edit: 'changed', fields: ['covers'], covers: 'For a first-time reader: the model first.' }] },
    { slug: 'delivery', title: 'Delivery and heartbeats', number: '3.5', added: true, category: { key: 'runtime', title: 'Runtime', opens: false }, fields: [], sections: [] },
  ],
  moves: [{ title: 'Delivery and heartbeats', from: { doc: 'sessions-runtime', number: '3.1', key: 's3', section: 3 }, to: { doc: 'delivery', number: '3.5', key: 's3', section: 1 }, fields: [], covers: null }],
};
const planCard = (over: Partial<WikiChatDraftView> = {}): WikiChatDraftView =>
  draft({
    kind: 'plan', label: 'Plan change', ops: [], similar: [], rationale: 'The owner wants it written for a first-time reader.',
    sections: [{ doc: 'sessions-runtime', key: 'recovery', where: '3.1 §2', title: 'Recovery' }],
    rewrites: [{ doc: 'sessions-runtime', key: 'recovery', where: '3.1 §2', title: 'Recovery' }],
    change: PLAN_CHANGE,
    ...over,
  });

describe('a plan card (C12, design §6 third row, board 42 ④ ③)', () => {
  it('says what its change does to the document: the section it changes, the covers it writes, why, and what it rewrites', async () => {
    await show(planCard());
    expect(text('.wk-draft-k')).toBe('Draft · Plan change');
    expect(text('.wk-draft-ti')).toBe('3.1 Sessions runtime');
    expect(rows()).toEqual([
      ['Changes', '§2 Recovery (covers)'],
      ['Covers', '§2 Recovery: What survives a respawn, for a first-time reader: the model first.'],
      ['Why', 'The owner wants it written for a first-time reader.'],
      ['Rewrites', '3.1 §2'],
    ]);
    expect(buttons()).toEqual(['Apply & rebuild', 'Open in Plan', 'Discard']);
    expect(button('Apply & rebuild').className).toContain('orbit-button-primary');
    await press('3.1 §2');
    expect(host.calls).toEqual(['section sessions-runtime#recovery']);
  });

  it('says a new document, and the category it opens', async () => {
    await show(planCard({
      rewrites: [],
      change: {
        ...PLAN_CHANGE,
        docs: [{
          slug: 'runbooks', title: 'Runbooks', number: '4.1', added: true,
          category: { key: 'operations', title: 'Operations', opens: true },
          fields: [],
          sections: [{ key: 's1', title: 'Restarting the runner', number: 1, edit: 'added', fields: [], covers: 'The steps, in order.' }],
        }],
      },
    }));
    expect(text('.wk-draft-ti')).toBe('4.1 Runbooks');
    expect(rows()).toEqual([
      ['Document', 'New document in a new category, Operations'],
      ['Adds', '§1 Restarting the runner'],
      ['Covers', '§1 Restarting the runner: The steps, in order.'],
      ['Why', 'The owner wants it written for a first-time reader.'],
    ]);
  });

  it('Apply & rebuild presses the owner’s door once: the card is applied, with Undo and Open in Plan, and its rebuild stands under it', async () => {
    await show(planCard());
    await press('Apply & rebuild');
    expect(pressed()).toEqual(['apply']);
    expect(text('.wk-draft-k')).toBe('Applied · Confirmed by you');
    expect(buttons()).toEqual(['Undo', 'Open in Plan']);
    expect(document.querySelector('.wk-draft-note')).toBeNull();
    expect(text('.wk-draft-result')).toBe('Rewriting 3.1 §2…');
  });

  it('a press the plan’s gate refused writes nothing, and the card says every error, a draft still', async () => {
    await show(planCard());
    refuse = {
      status: 422,
      body: {
        code: 'WIKI_PLAN_GATE',
        message: "This plan change, applied to version 4, did not pass the plan's gate (references): 1 error. Nothing was stored; fix every one and send it again.",
        errors: [{ check: 'references', path: 'change.doc.sections[2].sources.sessions.projects[0]', message: 'no project of this account is titled "Runner hosting" or has that id' }],
      },
    };
    await press('Apply & rebuild');
    expect(document.querySelector('.wk-draft-failed')!.firstChild!.textContent).toBe(
      "The card couldn’t be pressed: This plan change, applied to version 4, did not pass the plan's gate (references): 1 error. Nothing was stored; fix every one "
        + 'and send it again.',
    );
    expect([...document.querySelectorAll('.wk-draft-failed-list li')].map((li) => li.textContent)).toEqual([
      'change.doc.sections[2].sources.sessions.projects[0]: no project of this account is titled "Runner hosting" or has that id',
    ]);
    expect(text('.wk-draft-k')).toBe('Draft · Plan change');
    expect(buttons()).toEqual(['Apply & rebuild', 'Open in Plan', 'Discard']);
  });

  it('Open in Plan opens its document on the plan page', async () => {
    await show(planCard());
    await press('Open in Plan');
    expect(host.calls).toEqual(['plan sessions-runtime']);
  });

  it('a rebuild that failed offers Try again under it, and Try again asks for the build again', async () => {
    await show(planCard({
      state: 'applied', decision: 'applied', undoable: true, change: { ...PLAN_CHANGE, version: 5 },
      rewrite: { ...UPDATED, result: 'failed', sections: [{ doc: 'sessions-runtime', key: 'recovery', where: '3.1 §2', result: 'failed', changed: null, versionId: null }] },
    }));
    expect(buttons()).toEqual(['Undo', 'Open in Plan']);
    expect(text('.wk-draft-result .t')).toBe('Rewrite failed');
    expect(buttons('.wk-draft-result')).toEqual(['Try again']);
    await press('Try again');
    expect(pressed()).toEqual(['seen', 'retry'], 'the failed rebuild was seen on screen, then asked for again');
  });
});

describe('a plan card of several documents, and its Undo (C17, board 42 ③)', () => {
  const splitCard = (over: Partial<WikiChatDraftView> = {}) => planCard({
    rationale: '3.1 is too long.',
    sections: [{ doc: 'sessions-runtime', key: 's1', where: '3.1 §1', title: 'Overview' }, { doc: 'delivery', key: 's3', where: '3.5 §1', title: 'Delivery and heartbeats' }],
    rewrites: [{ doc: 'sessions-runtime', key: 's1', where: '3.1 §1', title: 'Overview' }, { doc: 'delivery', key: 's3', where: '3.5 §1', title: 'Delivery and heartbeats' }],
    change: SPLIT,
    ...over,
  });

  it('says the split document by document: the move, the covers, the new document — and Rewrites names each document once', async () => {
    await show(splitCard());
    expect(text('.wk-draft-k')).toBe('Draft · Plan change');
    expect(text('.wk-draft-ti')).toBe('3.1 Sessions runtime · 3.5 Delivery and heartbeats');
    expect(rows()).toEqual([
      ['Moves', '3.1 §3 Delivery and heartbeats → new document 3.5'],
      ['Changes', '3.1 §1 Overview (covers)'],
      ['Covers', '3.1 §1 Overview: For a first-time reader: the model first.'],
      ['Document', '3.5 · New document in Runtime'],
      ['Why', '3.1 is too long.'],
      ['Rewrites', '3.1 · 3.5'],
    ]);
    expect(buttons()).toEqual(['Apply & rebuild', 'Open in Plan', 'Discard']);
    // A document's link opens its first section the press rewrites, beside the chat.
    await press('3.5');
    await press('Open in Plan');
    expect(host.calls).toEqual(['section delivery#s3', 'plan sessions-runtime']);
  });

  it('Undo presses the owner’s door once, and the card reads Undone', async () => {
    await show(splitCard({ state: 'applied', decision: 'applied', undoable: true, change: { ...SPLIT, version: 5 } }));
    expect(buttons()).toEqual(['Undo', 'Open in Plan']);
    await press('Undo');
    expect(pressed()).toEqual(['undo']);
    expect(text('.wk-draft-k')).toBe('Undone');
    expect(buttons()).toEqual([]);
  });

  it('once the plan moved on, Undo is off and the card says why; Open in Plan stays', async () => {
    await show(splitCard({ state: 'applied', decision: 'applied', undoable: false, change: { ...SPLIT, version: 5 } }));
    expect(text('.wk-draft-k')).toBe('Applied · Confirmed by you');
    expect(text('.wk-draft-note')).toBe('The plan has changed since, so this can no longer be undone.');
    expect(buttons()).toEqual(['Open in Plan']);
  });

  it('an Undo the server refuses — the plan moved on meanwhile — says so on the card, and writes nothing', async () => {
    await show(splitCard({ state: 'applied', decision: 'applied', undoable: true, change: { ...SPLIT, version: 5 } }));
    refuse = {
      status: 409,
      body: { code: 'WIKI_REVISION_CONFLICT', message: "the plan moved on since this card's press made version 5: it stands at version 6 (draft) now, so nothing was undone. Change the plan on the Plan page (Open in Plan)." },
    };
    await press('Undo');
    expect(document.querySelector('.wk-draft-failed')!.firstChild!.textContent).toBe(
      "The card couldn’t be pressed: the plan moved on since this card's press made version 5: it stands at version 6 (draft) now, so nothing was undone. "
        + 'Change the plan on the Plan page (Open in Plan).',
    );
    expect(text('.wk-draft-k')).toBe('Applied · Confirmed by you');
  });
});

describe('the line under an applied card, for every result (design §8.3)', () => {
  const applied = (rewrite: Partial<NonNullable<WikiChatDraftView['rewrite']>>) =>
    draft({ state: 'applied', decision: 'applied', undoable: true, rewrite: { ...UPDATED, ...rewrite } });

  it('rewriting: the sections and, once named, main’s commit', async () => {
    await show(applied({ result: 'rewriting', sha: null, sections: UPDATED.sections.map((s) => ({ ...s, result: null, changed: null, versionId: null })) }));
    expect(text('.wk-draft-result > .t')).toBe('Rewriting 3.1 §3 and 7.1 §2…');
    expect(document.querySelector('.wk-draft-result')!.className).toContain('run');
    await show(applied({ result: 'rewriting', sections: UPDATED.sections.map((s) => ({ ...s, result: null, changed: null, versionId: null })) }));
    expect(text('.wk-draft-result > .t')).toBe('Rewriting 3.1 §3 and 7.1 §2 from main@7f3e2a1…');
    expect(buttons('.wk-draft-result')).toEqual([]);
  });

  it('waiting: why, counted as waiting on the owner, with Settings when Settings fixes it', async () => {
    await show(applied({ result: 'waiting', reason: 'maintenance_running' }));
    expect(text('.wk-draft-result > .t')).toBe('Rewrite waiting · Maintenance is running');
    expect(document.querySelector('.wk-draft-result')!.getAttribute('data-waits')).toBe('true');
    expect(buttons('.wk-draft-result')).toEqual([]);
    await show(applied({ result: 'waiting', reason: 'no_workspace' }));
    expect(text('.wk-draft-result > .t')).toBe('Rewrite waiting · Maintenance has no workspace');
    expect(buttons('.wk-draft-result')).toEqual(['Settings']);
    await press('Settings');
    expect(host.calls).toEqual(['settings']);
  });

  it('failed: Try again queues the sections again', async () => {
    await show(applied({ result: 'failed', seen: true }));
    expect(text('.wk-draft-result > .t')).toBe('Rewrite failed');
    expect(buttons('.wk-draft-result')).toEqual(['Try again']);
    expect(document.querySelector('.wk-draft-result')!.className).toContain('error');
    await press('Try again');
    expect(pressed()).toEqual(['retry']);
    expect(text('.wk-draft-result > .t')).toBe('Rewriting 3.1 §3 and 7.1 §2 from main@7f3e2a1…');
  });

  it('gone: the section left the plan, and nothing is rewritten', async () => {
    await show(applied({ result: 'gone', sections: [{ doc: 'sessions-runtime', key: 'old', where: 'sessions-runtime §old', result: 'gone', changed: null, versionId: null }] }));
    expect(text('.wk-draft-result > .t')).toBe('sessions-runtime §old — no longer in the plan');
    expect(document.querySelector('.wk-draft-result')!.className).toContain('grey');
  });

  it('updated: Wiki updated, and See changes compares the section sentence by sentence', async () => {
    await show(applied({ seen: true }));
    expect(text('.wk-draft-result > .t')).toBe('Wiki updated · 3.1 §3 — 1 sentence · 7.1 §2 — reads the same');
    expect(buttons('.wk-draft-result')).toEqual(['See changes']);
    expect(document.querySelector('.wk-draft-result')!.className).toContain('ok');
    await press('See changes');
    const see = document.querySelector('.wk-draft-see')!;
    expect(see.querySelector('.wk-see-h')!.textContent).toBe('See changes · 3.1 §3');
    expect(see.querySelector('.wk-see-cause')!.textContent).toBe(`After chat Runner offline: why three heartbeats · 1 sentence changed · ${wikiMonthDayTime(VERSIONS[0]!.at)}`);
    // Only what the write changed: the added sentence shaded, the kept ones left out.
    expect([...see.querySelectorAll('.wk-see-rows > div')].map((row) => [row.className, row.textContent])).toEqual([
      ['wk-see-ins', 'Three are kept so one gateway restart does not stop Resume.'],
    ]);
    // 7.1 §2 read the same and kept no version: said so, with nothing to read.
    const same = see.querySelector('.wk-see[data-section="runner-architecture#heartbeat"]')!;
    expect(same.querySelector('.wk-see-h')!.textContent).toBe('See changes · 7.1 §2');
    expect(same.querySelector('.wk-see-none')!.textContent).toBe('Every sentence reads as it did.');
    expect(writes.filter((write) => write.path.includes('runner-architecture'))).toEqual([]);
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some(([url]) => String(url).includes('runner-architecture'))).toBe(false);
    // The write before it, folded: struck and shaded in turn.
    await press('Earlier changes (1)');
    const earlier = see.querySelector('.wk-see-v.earlier')!;
    expect(earlier.querySelector('.wk-see-cause')!.textContent).toBe(`After maintenance · 1 sentence changed · ${wikiMonthDayTime(VERSIONS[1]!.at)}`);
    expect([...earlier.querySelectorAll('.wk-see-rows > div')].map((row) => [row.className, row.textContent])).toEqual([
      ['wk-see-del', 'Runners report every minute.'],
      ['wk-see-ins', 'Runners send a heartbeat every 30 seconds.'],
    ]);
  });

  it('reads the same: amber, waiting until seen, with See changes', async () => {
    await show(applied({ result: 'same', seen: true, sections: [{ doc: 'sessions-runtime', key: 'turn-delivery', where: '3.1 §3', result: 'same', changed: 0, versionId: null }] }));
    expect(text('.wk-draft-result > .t')).toBe('3.1 §3 — reads the same');
    expect(buttons('.wk-draft-result')).toEqual(['See changes']);
    expect(document.querySelector('.wk-draft-result')!.className).toContain('amber');
  });

  it('tells the server a settled rewrite was seen once the card is shown, once', async () => {
    await show(applied({ result: 'same', seen: false }));
    expect(pressed()).toEqual(['seen']);
    await settle();
    expect(pressed()).toEqual(['seen']);
    // Rewriting or held up: nothing to have seen yet.
    writes = [];
    await show(applied({ result: 'waiting', reason: 'runner_offline', seen: false }));
    expect(pressed()).toEqual([]);
  });
});
