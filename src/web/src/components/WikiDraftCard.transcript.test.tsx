// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WikiChatDraftView } from '@orbit/shared';
import { Transcript } from './Transcript';
import { WikiDraftCardCtx, useWikiChatSessionCards, type WikiDraftCardHost } from './WikiDraftCard';

/**
 * Where a chat's card is drawn (contract `chat.drafts.toolResult`, design §7.1): from the draftId its drafting call
 * answered, wherever the chat is shown — in the panel and on the full session page, which provide the card's host —
 * never read off the conversation's words; anywhere else (a share link, an export) the call is drawn as any tool call;
 * and a run of tool calls never folds a card away. The full session page's host opens what a card opens in the space's
 * wiki with the chat beside it, and asks again through the chat's own message door.
 */

const SPACE = '0196f000-0000-7000-8000-000000000001';
const CARD: WikiChatDraftView = {
  id: '34draftA1b2c3d4e5f6g7',
  sessionId: 'S1chat',
  kind: 'entry',
  state: 'draft',
  label: 'Add decision',
  rationale: 'To ride out one gateway restart.',
  ops: [],
  sections: [],
  rewrites: [{ doc: 'sessions-runtime', key: 'turn-delivery', where: '3.1 §3', title: 'Turn delivery' }],
  similar: [],
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
};
const ANSWER = { changesetId: '', replayed: false, ops: [{ seq: 0, status: 'draft', entryId: null }], status: 'draft', draftId: CARD.id, similar: [], rewrites: CARD.rewrites };

let writes: Array<{ path: string; body: Record<string, unknown> }>;
const reply = (status: number, body: unknown): Response =>
  ({ ok: status < 400, status, statusText: '', text: async () => JSON.stringify(body), json: async () => body }) as unknown as Response;
async function serve(url: string, init?: RequestInit): Promise<Response> {
  const path = url.split('?')[0]!;
  if ((init?.method ?? 'GET').toUpperCase() === 'POST') {
    writes.push({ path, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} });
    return reply(201, { turnId: 'T9', seq: 9, kind: 'message', placement: 'accepted' });
  }
  if (path === `/api/wiki/chat-drafts/${CARD.id}`) return reply(200, CARD);
  if (path === '/api/wiki/spaces') return reply(200, [{ id: SPACE, slug: 'orbit', title: 'orbit', pendingOps: 0 }]);
  return reply(404, { message: `${url} is not in this fixture` });
}

let container: HTMLDivElement;
let root: Root;
const HOST: WikiDraftCardHost = {
  spaceId: SPACE,
  openSection: () => {},
  openEntry: () => {},
  openReview: () => {},
  openSettings: () => {},
  openPlan: () => {},
  send: async () => {},
  focus: null,
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  writes = [];
  vi.stubGlobal('fetch', vi.fn(serve));
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
  for (let tick = 0; tick < 8; tick += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

let seq = 0;
/** One call and its answer, as the runner records them. */
function call(name: string, input: Record<string, unknown>, content: unknown) {
  const id = `toolu_${++seq}`;
  return [
    { seq: ++seq, type: 'tool_use', turnId: 't1', payload: { id, name, input } },
    { seq: ++seq, type: 'tool_result', turnId: 't1', payload: { toolUseId: id, content, isError: false } },
  ];
}

async function draw(events: unknown[], host: WikiDraftCardHost | null): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <WikiDraftCardCtx.Provider value={host}>
            <Transcript events={events as never} />
          </WikiDraftCardCtx.Provider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle();
}

const cardShown = (): string | null => container.querySelector('.wk-draft')?.getAttribute('data-draft') ?? null;
const toolNames = (): string[] => [...container.querySelectorAll('.chat-tool-name')].map((node) => node.textContent ?? '');

describe('a drafting call in a chat’s transcript', () => {
  it.each([
    ['wiki_propose, as Claude Code records its structured answer', 'mcp__orbit__wiki_propose', JSON.stringify(ANSWER)],
    ['wiki_draft, a rewrite', 'mcp__orbit__wiki_draft', [{ type: 'text', text: JSON.stringify({ status: 'draft', draftId: CARD.id, kind: 'rewrite', replayed: false, rewrites: [] }) }]],
    ['wiki_note correcting an entry', 'mcp__orbit__wiki_note', JSON.stringify({ noted: true, noteId: 'N1', created: true, readBy: 'x', challenged: { status: 'draft', draftId: CARD.id } })],
    ['wiki_propose under Codex, which passes the MCP result whole', 'mcp__orbit__wiki_propose', { content: [{ type: 'text', text: 'Drafted card …' }], structuredContent: ANSWER }],
    ['wiki_propose under an engine that hands the agent text alone', 'mcp__orbit__wiki_propose', `Drafted card ${CARD.id} for the owner of this wiki chat. Nothing in the wiki changed.`],
  ])('%s is drawn as its card, read from the server, in place of the call', async (_name, name, content) => {
    await draw(call(name, { rationale: 'x' }, content), HOST);
    expect(cardShown()).toBe(CARD.id);
    expect(container.querySelector('.wk-draft-k')?.textContent).toBe('Draft · Add decision');
    expect(toolNames()).toEqual([]);
  });

  it('stays a call where no card is drawn: a share link or an export has no card host', async () => {
    await draw(call('mcp__orbit__wiki_propose', { rationale: 'x' }, JSON.stringify(ANSWER)), null);
    expect(cardShown()).toBeNull();
    // A plain call, so it folds into the steps line like any other.
    expect(container.querySelector('.chat-steps-line')!.textContent).toBe('Used 1 tool');
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toEqual([]);
  });

  it('stays a call when it made no card: a dry run, or a request none of whose ops passed', async () => {
    await draw(call('mcp__orbit__wiki_propose', { dryRun: true }, JSON.stringify({ ...ANSWER, draftId: null, dryRun: true })), HOST);
    expect(cardShown()).toBeNull();
    expect(container.querySelectorAll('.chat-tool-card')).toHaveLength(1);
  });

  it('is never folded into a run of tool calls, which folds the calls around it as ever', async () => {
    const events = [
      ...call('Read', { file_path: 'src/apiserver/src/runners/runner-presence.ts' }, 'x'),
      ...call('mcp__orbit__wiki_search', { query: 'heartbeat offline' }, '{}'),
      ...call('mcp__orbit__wiki_propose', { rationale: 'x' }, JSON.stringify(ANSWER)),
      ...call('Read', { file_path: 'a.ts' }, 'x'),
      ...call('Read', { file_path: 'b.ts' }, 'x'),
      ...call('Read', { file_path: 'c.ts' }, 'x'),
    ];
    await draw(events, HOST);
    expect(cardShown()).toBe(CARD.id);
    // The card splits the run: the two calls before it and the three reads after it are a steps line each.
    expect(container.querySelectorAll('.chat-steps')).toHaveLength(2);
    // Outside a chat the same transcript folds the drafting call with the others, as before.
    act(() => root.unmount());
    root = createRoot(container);
    await draw(events, null);
    expect(cardShown()).toBeNull();
    expect(container.querySelectorAll('.chat-steps')).toHaveLength(1);
    expect(container.querySelector('.chat-steps-line')!.textContent).toBe('Read 4 files, used 2 tools');
  });
});

describe('the full session page of a chat (design §7.1: the same card)', () => {
  function Where() {
    const location = useLocation();
    return <output data-where={`${location.pathname}${location.search}${location.hash}`} />;
  }
  let host: WikiDraftCardHost | null = null;
  function Page({ spaceId }: { spaceId: string | null }) {
    host = useWikiChatSessionCards('S1chat', spaceId);
    return <Where />;
  }

  async function page(spaceId: string | null): Promise<void> {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={['/sessions/S1chat']}>
            <Routes>
              <Route path="*" element={<Page spaceId={spaceId} />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await settle();
  }
  const where = () => container.querySelector('output')?.getAttribute('data-where');

  it('opens what a card opens in the space’s wiki, the chat beside it, and asks again through the chat’s message door', async () => {
    await page(SPACE);
    expect(host?.spaceId).toBe(SPACE);
    await act(async () => host!.openSection('sessions-runtime', 'turn-delivery'));
    expect(where()).toBe('/wiki/orbit/d/sessions-runtime?chat=S1chat#sec-turn-delivery');
    await act(async () => host!.openEntry('E5'));
    expect(where()).toMatch(/^\/wiki\/orbit\/e\/E5\?chat=S1chat$/u);
    await act(async () => host!.openReview('C7', 0));
    expect(where()).toBe('/wiki/orbit/review?chat=S1chat#rv-C7-0');
    await act(async () => host!.openPlan());
    expect(where()).toBe('/wiki/orbit/plan?chat=S1chat');
    await act(async () => host!.openSettings());
    expect(where()).toBe('/wiki/orbit/settings');
    await act(async () => host!.send('Draft it again.'));
    expect(writes).toHaveLength(1);
    expect(writes[0]!.path).toBe('/api/sessions/S1chat/turns/current-work-routing');
    expect(writes[0]!.body).toMatchObject({ content: 'Draft it again.', intent: 'NEXT_TURN' });
    expect(writes[0]!.body).not.toHaveProperty('wikiContext');
  });

  it('has no card host for a session that is no chat', async () => {
    await page(null);
    expect(host).toBeNull();
  });

  it('is what the session page hands its conversation', () => {
    const file = ['src/components/WorkspaceView.tsx', 'src/web/src/components/WorkspaceView.tsx']
      .map((path) => resolve(process.cwd(), path))
      .find((path) => existsSync(path))!;
    const source = readFileSync(file, 'utf8');
    expect(source).toContain('const wikiChatCards = useWikiChatSessionCards(');
    expect(source).toContain('?.wikiChatSpaceId ?? null');
    expect(source).toContain('wikiChat={wikiChatCards}');
  });
});
