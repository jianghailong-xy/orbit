// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WatchView } from '@orbit/shared';
import { WatchEditorModal, type WatchEditorMode } from './WatchEditor';

/**
 * Following and editing a watch, pressed in a real document. What is asserted is the request the
 * dialog sends — the one thing the server acts on — and that a refusal stays in front of the reader
 * instead of closing the dialog on them.
 */

vi.mock('../api', () => ({ api: vi.fn(), getSession: vi.fn() }));
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() };
vi.mock('../lib/toast', () => ({ useToast: () => toast }));
const { api, getSession } = await import('../api');

const HOUR = 3_600_000;
const at = (fromNow: number) => new Date(Date.now() + fromNow).toISOString();

const watch = (over: Partial<WatchView> = {}): WatchView => ({
  id: 'W1',
  observerType: 'USER',
  observerSessionId: null,
  predicateVersion: 1,
  predicate: { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' },
  mode: 'ONE_SHOT',
  action: 'NOTIFY_USER',
  state: 'ACTIVE',
  generation: 0,
  expiresAt: at(21.5 * HOUR),
  nextEvaluateAt: null,
  lastEvaluatedAt: at(-10_000),
  idempotencyKey: null,
  createdAt: at(-HOUR),
  updatedAt: at(-HOUR),
  targets: [{ targetKind: 'TASK', targetResourceId: 'T1', state: 'OBSERVED', targetEpoch: 0, lastEvaluatedAt: null }],
  matches: [],
  expiryDeliveries: [],
  ...over,
});

type Init = { method?: string; body?: unknown };
const writes: [string, Init | undefined][] = [];

function serve(routes: Record<string, (init?: Init) => unknown>) {
  vi.mocked(api).mockImplementation((async (path: string, init?: Init) => {
    if (init?.method) writes.push([path, init]);
    if (/^\/tasks\/[^/]+\/row$/.test(path)) return { title: 'Web Watch cards', status: 'OPEN' };
    const handler = routes[`${init?.method ?? 'GET'} ${path}`];
    if (!handler) throw new Error(`unstubbed ${init?.method ?? 'GET'} ${path}`);
    return handler(init);
  }) as never);
  vi.mocked(getSession).mockImplementation((async (id: string) => ({ id, title: `Session ${id}` })) as never);
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
const onClose = vi.fn();

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function open(mode: WatchEditorMode): Promise<void> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  const next = createRoot(container);
  root = next;
  const node: ReactElement = <WatchEditorModal mode={mode} onClose={onClose} />;
  await act(async () => {
    next.render(
      <MemoryRouter>
        <QueryClientProvider client={client}>{node}</QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await settle();
}

async function click(element: Element | null | undefined, what: string): Promise<void> {
  expect(element, `${what} is on screen`).toBeTruthy();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

const button = (text: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>('.ant-modal button')].find(
    (b) => b.textContent?.trim() === text,
  );

/** Press the radio whose label starts with this text. */
async function choose(label: string): Promise<void> {
  const wrapper = [...document.body.querySelectorAll('.ant-modal label')].find((l) =>
    (l.textContent ?? '').startsWith(label),
  );
  await click(wrapper?.querySelector('input'), `the "${label}" choice`);
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  writes.length = 0;
  onClose.mockReset();
  toast.success.mockReset();
});

afterEach(async () => {
  if (root) {
    const mounted = root;
    await act(async () => mounted.unmount());
  }
  container?.remove();
  container = null;
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.mocked(api).mockReset();
  vi.mocked(getSession).mockReset();
});

describe('following a target', { timeout: 30_000 }, () => {
  it('sends a one-shot notify watch with the default condition and deadline', async () => {
    serve({ 'POST /watches': () => watch() });
    await open({ kind: 'create', targets: [{ kind: 'TASK', id: 'T1' }] });

    expect(document.body.querySelector('.ant-modal-title')?.textContent).toBe('Follow task');
    expect(document.body.querySelector('.ant-modal')?.textContent).toContain('Web Watch cards');
    await click(button('Follow'), 'Follow');

    expect(writes).toEqual([
      [
        '/watches',
        {
          method: 'POST',
          body: {
            predicateVersion: 1,
            predicate: { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' },
            targets: [{ kind: 'TASK', id: 'T1' }],
            action: 'NOTIFY_USER',
            ttlSeconds: 86_400,
            idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
          },
        },
      ],
    ]);
    expect(onClose).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('Following');
  });

  it('sends the condition and the deadline that were chosen', async () => {
    serve({ 'POST /watches': () => watch() });
    await open({ kind: 'create', targets: [{ kind: 'TASK', id: 'T1' }] });
    await choose('Is done');
    await choose('7 days');
    await click(button('Follow'), 'Follow');

    expect(writes).toHaveLength(1);
    expect(writes[0][1]?.body).toMatchObject({
      predicate: { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_DONE' },
      ttlSeconds: 7 * 86_400,
    });
  });

  it('offers a session only the conditions a session can meet', async () => {
    serve({});
    await open({ kind: 'create', targets: [{ kind: 'SESSION', id: 'S1' }] });
    const options = [...document.body.querySelectorAll('.watch-editor-option')].map((o) => o.textContent);
    expect(options).toEqual([
      'Finishes its turn',
      'Ends',
      'Is moved to Completed or Trash',
      'Asks for an approval',
      'Notify me',
      'Resume a session',
    ]);
  });

  it('keeps a refusal in the dialog, which stays open', async () => {
    serve({
      'POST /watches': () => {
        throw Object.assign(new Error('1 of 1 targets cannot be read by this account'), {
          status: 403,
          code: 'PERMISSION_DENIED',
        });
      },
    });
    await open({ kind: 'create', targets: [{ kind: 'TASK', id: 'T1' }] });
    await click(button('Follow'), 'Follow');

    expect(document.body.querySelector('.ant-modal [role="alert"]')?.textContent).toBe(
      'This account cannot read one of the targets.',
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it('resumes only a session that was picked, and never offers the watched session itself', async () => {
    serve({
      'GET /sessions/search?q=&limit=20': () => ({
        q: '',
        contentSearched: false,
        total: 2,
        hits: [
          { id: 'S_TARGET', title: 'The watched session', agent: null },
          { id: 'S_COORD', title: 'Coordinator', agent: { id: 'a1', name: 'orbit' } },
        ],
      }),
      'POST /watches': () => watch(),
    });
    await open({ kind: 'create', targets: [{ kind: 'SESSION', id: 'S_TARGET' }] });
    await choose('Resume a session');
    expect(button('Follow')?.disabled, 'nothing to resume yet').toBe(true);

    await act(async () => {
      document.body
        .querySelector('.ant-modal .ant-select-content')
        ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    await settle();
    const offered = [...document.body.querySelectorAll('.ant-select-item-option')].map((o) => o.textContent);
    expect(offered).toEqual(['Coordinator · orbit']);
    await click(document.body.querySelector('.ant-select-item-option'), 'the coordinator option');
    await click(button('Follow'), 'Follow');

    expect(writes).toHaveLength(1);
    expect(writes[0][1]?.body).toMatchObject({
      predicate: { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'SESSION_TURN_SETTLED' },
      targets: [{ kind: 'SESSION', id: 'S_TARGET' }],
      action: 'RESUME_SESSION',
      observerSessionId: 'S_COORD',
    });
  });
});

describe('editing a watch', { timeout: 30_000 }, () => {
  it('keeps the deadline unless asked, and sends only what changed', async () => {
    serve({ 'PATCH /watches/W1': (init) => ({ ...watch(), ...(init?.body as object) }) });
    await open({ kind: 'edit', watch: watch() });

    expect(document.body.querySelector('.ant-modal-title')?.textContent).toBe('Edit watch');
    expect(button('Save')?.disabled, 'nothing changed yet').toBe(true);
    await choose('Fails');
    await click(button('Save'), 'Save');

    expect(writes).toEqual([
      [
        '/watches/W1',
        {
          method: 'PATCH',
          body: { predicateVersion: 1, predicate: { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_FAILED' } },
        },
      ],
    ]);
    expect(onClose).toHaveBeenCalled();
  });

  it('moves the deadline alone, counted from now', async () => {
    serve({ 'PATCH /watches/W1': () => watch() });
    await open({ kind: 'edit', watch: watch() });
    expect(document.body.querySelector('.ant-modal')?.textContent).toContain('Keep (in 21h)');
    await choose('1 hour');
    await click(button('Save'), 'Save');

    expect(writes).toEqual([['/watches/W1', { method: 'PATCH', body: { ttlSeconds: 3_600 } }]]);
  });

  it('shows a condition it cannot say rather than flattening it, and still moves its deadline', async () => {
    serve({ 'PATCH /watches/W1': () => watch() });
    await open({
      kind: 'edit',
      watch: watch({
        predicate: {
          kind: 'ALL_OF',
          operands: [
            { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_DONE' },
            { kind: 'ANY', over: 'ALL_TARGETS', leaf: 'SESSION_NEEDS_ATTENTION' },
          ],
        },
        targets: [
          { targetKind: 'TASK', targetResourceId: 'T1', state: 'OBSERVED', targetEpoch: 0, lastEvaluatedAt: null },
          { targetKind: 'SESSION', targetResourceId: 'S1', state: 'OBSERVED', targetEpoch: 0, lastEvaluatedAt: null },
        ],
      }),
    });
    const fixed = document.body.querySelector('.watch-editor-fixed')?.textContent ?? '';
    expect(fixed).toContain('When the task is done, and the session asks for an approval');
    expect(document.body.querySelectorAll('.watch-editor-options input')).toHaveLength(0);

    await choose('3 days');
    await click(button('Save'), 'Save');
    expect(writes).toEqual([['/watches/W1', { method: 'PATCH', body: { ttlSeconds: 3 * 86_400 } }]]);
  });
});
