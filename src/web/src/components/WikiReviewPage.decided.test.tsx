// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { App as AntApp } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WikiChangeset, WikiChangesetOp, WikiOpDecision } from '@orbit/shared';
import { WikiReviewPage } from './WikiReviewPage';
import { ToastViewport } from './ToastViewport';
import { clearToasts } from '../lib/toastStore';
import { wikiDecisionRefusal, wikiRecordedDecision } from '../lib/wiki';

/**
 * What Review says once the server has answered: the decision it RECORDED for the op, not the button.
 *
 * `POST /api/wiki/changesets/:id/decide` answers 200 with the whole changeset whatever became of the op.
 * An amend, supersede or retire whose entry moved past the revision it was written against is recorded
 * `conflict` and nothing is applied (`WikiService.applyDecision`, wiki-api.pg.spec.ts); so is a challenge
 * of an entry no longer active (`answerChallenge`); and a `withdrawn` op applied nothing either. Toasting
 * "Accepted" for those told the owner the opposite of what happened. The sentences are Android's, word
 * for word (`WikiCopy.conflictRefused` / `inactiveRefused` / `withdrawnRefused`), and OrbitKit's.
 *
 * The fetch below is a small server: it answers the page's reads, records each decide as the decision
 * the test names — the way the real one writes `decision` on the op — answers with the changeset, and
 * lists only what still waits, so the page does next what it would do there.
 */

const CONFLICT = 'Nothing was applied: the entry changed after this was proposed.';
const INACTIVE = 'Nothing was applied: the entry is no longer active.';
const WITHDRAWN = 'Nothing was applied: the proposal was withdrawn.';
const FAILED = "Couldn't record your answer";

const ENTRY_ID = '0196b700-0000-7000-8000-00000000bbbb';
const ENTRY = {
  id: ENTRY_ID,
  spaceId: '0196b700-0000-7000-8000-0000000000dd',
  kind: 'recipe',
  title: 'Upgrade rebuilds only what changed',
  summary: 'Rebuild the images and recreate every service.',
  fields: {},
  topics: [],
  aliases: [],
  anchors: [],
  trust: 'confirmed',
  status: 'active',
  // The amend below was written against r3; the entry has moved on since.
  currentRevision: 4,
  sources: [],
  history: [],
  exposure: [],
};
const ADD_TITLE = 'Secret redaction lets ENV_VAR=value secrets through';

let counter = 0;
const id = (): string => `0196b700-0000-7000-8000-${String(++counter).padStart(12, '0')}`;

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
    appliedByMode: null,
    spotCheck: false,
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

const ADD = () =>
  op({ op: 'add', payload: { entry: { kind: 'pitfall', title: ADD_TITLE, summary: 'Stored unredacted.', fields: {}, anchors: [] } } });
const AMEND = () =>
  op({
    op: 'amend',
    entryId: ENTRY_ID,
    baseRevision: 3,
    payload: { changes: { summary: 'Rebuild the images and recreate only the services that changed.' } },
  });
const CHALLENGE = () =>
  op({ op: 'challenge', entryId: ENTRY_ID, payload: { reason: 'docs/upgrade.md no longer says this' } });

// ── the server ────────────────────────────────────────────────────────────────────────────────────

let queue: WikiChangeset[] = [];
/** What the server records for the op the next decide names. */
let recorded: WikiOpDecision = 'accepted';
let decides: Array<Array<Record<string, unknown>>> = [];

const reply = (status: number, body: unknown): Response =>
  ({ ok: status < 400, status, statusText: '', text: async () => JSON.stringify(body), json: async () => body }) as unknown as Response;

async function serve(url: string, init?: RequestInit): Promise<Response> {
  const decide = /^\/api\/wiki\/changesets\/([^/]+)\/decide$/.exec(url);
  if (init?.method === 'POST' && decide) {
    const { decisions } = JSON.parse(String(init.body)) as { decisions: Array<Record<string, unknown>> };
    decides.push(decisions);
    const named = new Set(decisions.map((decision) => decision.opId));
    queue = queue.map((row) => ({
      ...row,
      ops: row.ops.map((one) => (named.has(one.id) ? { ...one, decision: recorded } : one)),
    }));
    const answered = queue.find((row) => row.id === decodeURIComponent(decide[1]))!;
    const waiting = answered.ops.some((one) => one.decision === 'pending');
    return reply(200, { ...answered, status: waiting ? 'pending' : 'settled' });
  }
  if (url.startsWith('/api/wiki/review')) {
    return reply(200, queue.filter((row) => row.ops.some((one) => one.decision === 'pending')));
  }
  if (url.startsWith('/api/wiki/spaces')) return reply(200, []);
  if (url.startsWith(`/api/wiki/entries/${ENTRY_ID}`)) return reply(200, ENTRY);
  return reply(404, { message: `${url} is not in this fixture` });
}

// ── the page ──────────────────────────────────────────────────────────────────────────────────────

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null, addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }));
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('fetch', vi.fn(serve));
  recorded = 'accepted';
  decides = [];
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    clearToasts();
    root.unmount();
  });
  container.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  for (let tick = 0; tick < 5; tick += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

/** Review over `changesets`, once a card that says `ready` is on screen. */
async function mount(changesets: WikiChangeset[], ready: string): Promise<HTMLElement> {
  queue = changesets;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <AntApp>
            <WikiReviewPage spaceSlug={null} />
          </AntApp>
          <ToastViewport />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await vi.waitFor(() => expect(cardSaying(ready)).toBeTruthy(), { timeout: 10_000 });
  await settle();
  return cardSaying(ready)!;
}

function cardSaying(text: string): HTMLElement | undefined {
  return [...container.querySelectorAll<HTMLElement>('.approval-card')].find((card) => card.textContent?.includes(text));
}

function button(label: string, scope: ParentNode): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find((one) => one.textContent?.trim() === label);
  if (!found) throw new Error(`no ${label} button`);
  return found;
}

async function press(label: string, scope: ParentNode): Promise<void> {
  await act(async () => button(label, scope).click());
  await settle();
}

const toasts = (): string => document.body.querySelector('.toast-viewport')?.textContent ?? '';
const form = (): HTMLElement | null => document.body.querySelector<HTMLElement>('.ant-modal');

/** Type into the form's title through React's own setter, so the change is one React sees. */
async function retitle(value: string): Promise<void> {
  const field = form()!.querySelector('input.ant-input') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/**
 * The refusal, under the headline every refused answer has — and no word of the answer's own. Read as
 * soon as anything is up: a passing toast leaves after its dwell, and what it said is the point.
 */
async function expectRefused(sentence: string, never: string): Promise<void> {
  await vi.waitFor(() => expect(toasts()).not.toBe(''), { timeout: 10_000 });
  expect(toasts()).not.toContain(never);
  expect(toasts()).toContain(FAILED);
  expect(toasts()).toContain(sentence);
}

// ── the tests ─────────────────────────────────────────────────────────────────────────────────────

describe('a decide the server recorded without applying it', () => {
  it('a stale amend: Accept says nothing was applied, not Accepted', async () => {
    recorded = 'conflict';
    const amend = AMEND();
    const card = await mount([changeset([amend])], ENTRY.title);

    await press('Accept', card);

    expect(decides).toEqual([[{ opId: amend.id, action: 'accept' }]]);
    await expectRefused(CONFLICT, 'Accepted');
  });

  it("a stale amend edited in Edit's form: the same refusal, and no 'Accepted with your edits'", async () => {
    recorded = 'conflict';
    const amend = AMEND();
    const card = await mount([changeset([amend])], ENTRY.title);
    await press('Edit', card);
    await vi.waitFor(() => expect(form()).not.toBeNull(), { timeout: 10_000 });

    await retitle('Upgrade recreates only the services that changed');
    await act(async () => (form()!.querySelector('.ant-modal-footer .ant-btn-primary') as HTMLButtonElement).click());
    await settle();

    expect(decides).toEqual([
      [{ opId: amend.id, action: 'edit', edited: { title: 'Upgrade recreates only the services that changed' } }],
    ]);
    await expectRefused(CONFLICT, 'Accepted');
  });

  it('a challenge of an entry no longer active: Re-confirm says the entry is no longer active', async () => {
    recorded = 'conflict';
    const challenge = CHALLENGE();
    const card = await mount([changeset([challenge])], ENTRY.title);

    await press('Re-confirm', card);

    expect(decides).toEqual([[{ opId: challenge.id, action: 'reconfirm' }]]);
    await expectRefused(INACTIVE, 'Re-confirmed');
  });

  it("a challenge of an entry no longer active: its Amend form says so too, and not 'Amended'", async () => {
    recorded = 'conflict';
    const challenge = CHALLENGE();
    const card = await mount([changeset([challenge])], ENTRY.title);
    await vi.waitFor(() => expect(button('Amend', card).disabled).toBe(false), { timeout: 10_000 });
    await press('Amend', card);
    await vi.waitFor(() => expect(form()).not.toBeNull(), { timeout: 10_000 });

    await retitle('Upgrade recreates what changed');
    await act(async () => button('Amend', form()!).click());
    await settle();

    expect(decides).toEqual([[{ opId: challenge.id, action: 'amend', edited: { title: 'Upgrade recreates what changed' } }]]);
    await expectRefused(INACTIVE, 'Amended');
  });

  it('a withdrawn proposal: Accept says it was withdrawn', async () => {
    recorded = 'withdrawn';
    const add = ADD();
    const card = await mount([changeset([add])], ADD_TITLE);

    await press('Accept', card);

    expect(decides).toEqual([[{ opId: add.id, action: 'accept' }]]);
    await expectRefused(WITHDRAWN, 'Accepted');
  });
});

describe('a decide the server recorded as asked', () => {
  it('Accept recorded `accepted` still says Accepted, about the entry, and nothing else', async () => {
    recorded = 'accepted';
    const add = ADD();
    const card = await mount([changeset([add])], ADD_TITLE);

    await press('Accept', card);

    await vi.waitFor(() => expect(toasts()).toContain('Accepted'), { timeout: 10_000 });
    expect(document.body.querySelector('.toast-viewport .toast-sub')?.textContent).toBe(ADD_TITLE);
    expect(toasts()).not.toContain(FAILED);
    expect(toasts()).not.toContain('Nothing was applied');
    // The decided card leaves the queue with the re-read, as it always did.
    await vi.waitFor(() => expect(container.textContent).toContain('Nothing is waiting for you.'), { timeout: 10_000 });
  });

  it("Retire on a challenge is recorded `withdrawn` — the retire takes its own challenge with it — and says Retired", async () => {
    // The server's own record of it (wiki-anchors.pg.spec.ts): the entry retired, and the challenge
    // "left with the entry it was about".
    recorded = 'withdrawn';
    const challenge = CHALLENGE();
    const card = await mount([changeset([challenge])], ENTRY.title);

    await press('Retire', card);

    expect(decides).toEqual([[{ opId: challenge.id, action: 'retire' }]]);
    await vi.waitFor(() => expect(toasts()).toContain('Retired'), { timeout: 10_000 });
    expect(toasts()).not.toContain('Nothing was applied');
    expect(toasts()).not.toContain(FAILED);
  });
});

describe('the rule, as the page reads it', () => {
  const answer = (...ops: Array<[string, WikiOpDecision]>): WikiChangeset =>
    changeset(ops.map(([opId, decision]) => op({ id: opId, decision })));

  it("reads the decided op's own decision, and nothing from an answer that does not hold it", () => {
    const both = answer(['op-1', 'accepted'], ['op-2', 'conflict']);
    expect(wikiRecordedDecision(both, 'op-2')).toBe('conflict');
    expect(wikiRecordedDecision(both, 'op-1')).toBe('accepted');
    expect(wikiRecordedDecision(both, 'op-3')).toBeNull();
    expect(wikiRecordedDecision({} as WikiChangeset, 'op-1')).toBeNull();
  });

  it('a conflict or a withdrawal is a refusal that applied nothing', () => {
    for (const kind of ['amend', 'supersede', 'retire', 'add']) {
      expect(wikiDecisionRefusal('conflict', kind, 'accept')).toBe(CONFLICT);
      expect(wikiDecisionRefusal('conflict', kind, 'edit')).toBe(CONFLICT);
    }
    for (const action of ['reconfirm', 'amend', 'retire'] as const) {
      expect(wikiDecisionRefusal('conflict', 'challenge', action)).toBe(INACTIVE);
    }
    expect(wikiDecisionRefusal('withdrawn', 'amend', 'accept')).toBe(WITHDRAWN);
    expect(wikiDecisionRefusal('withdrawn', 'add', 'edit')).toBe(WITHDRAWN);
    expect(wikiDecisionRefusal('withdrawn', 'challenge', 'reconfirm')).toBe(WITHDRAWN);
  });

  it('an answer that applied what was asked is no refusal — Retire on a challenge included', () => {
    for (const decision of ['accepted', 'edited', 'rejected', 'auto_applied', 'pending', 'verifying'] as const) {
      expect(wikiDecisionRefusal(decision, 'amend', 'accept')).toBeNull();
      expect(wikiDecisionRefusal(decision, 'challenge', 'reconfirm')).toBeNull();
    }
    expect(wikiDecisionRefusal(null, 'add', 'accept')).toBeNull();
    expect(wikiDecisionRefusal('withdrawn', 'challenge', 'retire')).toBeNull();
  });
});
