// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeId } from '../lib/idCodec';
import { TasksSidePanel, workspaceStepDirection } from './TasksSidePanel';

/**
 * ⌘/Ctrl + Up/Down through the sidebar's Workspaces, as a reader presses it: one row up or down from
 * the open Workspace, stopping at the ends, never while a text field's caret still has somewhere to
 * go — and, the half that is timing, from the row just stepped to, not from the one the previous
 * session's placeholder names while the next session loads.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
  getSession: vi.fn(),
}));
// The Appearance menu's context is no part of this; the panel only reads it.
vi.mock('../lib/theme', () => ({ useThemeMode: () => ({ mode: 'system', setMode: () => {} }) }));
const { api, getSession } = await import('../api');

// Ids as the server hands them out: the public spelling, which is also what a route resolves to.
const A = encodeId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
const B = encodeId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
const C = encodeId('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
const SHARED = encodeId('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
const SESSION_IN_A = encodeId('0000000a-0000-4000-8000-00000000000a');
const SESSION_IN_B = encodeId('0000000b-0000-4000-8000-00000000000b');
const RUNNER = encodeId('0000000f-0000-4000-8000-00000000000f');

const WORKSPACES = [
  { id: A, name: 'alpha', createdAt: '2026-09-01T00:00:00.000Z', position: 0, runnerId: RUNNER },
  { id: B, name: 'bravo', createdAt: '2026-09-02T00:00:00.000Z', position: 1, runnerId: RUNNER },
  { id: C, name: 'charlie', createdAt: '2026-09-03T00:00:00.000Z', position: 2, runnerId: RUNNER },
  // Config-only: no runner, so no console to open. It sorts last, in the Shared group.
  { id: SHARED, name: 'shared', createdAt: '2026-08-01T00:00:00.000Z', position: null, runnerId: null },
];

/** The sidebar's reads, and each session's detail by id — a missing one never answers. */
function serve(sessions: Record<string, { id: string; workspace: { id: string } }> = {}) {
  vi.mocked(api).mockImplementation((async (path: string) => {
    if (path === '/runners') return [{ id: RUNNER, name: 'wikova', online: true }];
    if (path === '/workspaces') return WORKSPACES;
    if (path === '/projects?status=OPEN') return [];
    if (path === '/sessions/counts') return [];
    if (path === '/users/me') return { id: 'me', name: 'Me', email: 'me@example.com', role: 'USER' };
    if (path === '/wiki/spaces') return [];
    throw new Error(`unstubbed ${path}`);
  }) as never);
  vi.mocked(getSession).mockImplementation(((sessionId: string) =>
    sessions[sessionId] ? Promise.resolve(sessions[sessionId]) : new Promise(() => {})) as never);
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let navigate: NavigateFunction | null = null;
let pathname = '';

/** Where the router is, and a hand on it for the navigation WorkspaceView would make. */
function RouterProbe() {
  navigate = useNavigate();
  pathname = useLocation().pathname;
  return null;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function visit(path: string): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  const next = createRoot(container);
  root = next;
  await act(async () => {
    next.render(
      <MemoryRouter initialEntries={[path]}>
        <QueryClientProvider client={client}>
          <TasksSidePanel />
          <RouterProbe />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await settle();
}

/** One press, from wherever focus stands; whether the page took it from the browser. */
async function press(
  key: 'ArrowUp' | 'ArrowDown',
  init: KeyboardEventInit = { metaKey: true },
): Promise<boolean> {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  await act(async () => {
    document.activeElement!.dispatchEvent(event);
  });
  await settle();
  return event.defaultPrevented;
}

const activeRow = () =>
  container!.querySelector('.tp-group .tp-item.active .tp-workspace-name')?.textContent ?? null;

/** A text field with the keyboard, its caret at `caret` (a selection when given two ends). */
function focusField(value: string, caret: number, end = caret): HTMLTextAreaElement {
  const field = document.createElement('textarea');
  document.body.appendChild(field);
  field.value = value;
  field.focus();
  field.setSelectionRange(caret, end);
  return field;
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
});

afterEach(async () => {
  if (root) {
    const mounted = root;
    await act(async () => mounted.unmount());
  }
  container?.remove();
  container = null;
  root = null;
  navigate = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.mocked(api).mockReset();
  vi.mocked(getSession).mockReset();
});

describe('⌘/Ctrl + Up/Down through the Workspaces', () => {
  it('steps the open Workspace one row down or up, in the order the sidebar lists them', async () => {
    serve();
    await visit(`/workspaces/${B}`);
    expect(activeRow()).toBe('bravo');

    expect(await press('ArrowDown')).toBe(true);
    expect(pathname).toBe(`/workspaces/${C}`);
    expect(activeRow()).toBe('charlie');

    // Ctrl is the same chord off a Mac.
    expect(await press('ArrowUp', { ctrlKey: true })).toBe(true);
    expect(pathname).toBe(`/workspaces/${B}`);
    await press('ArrowUp');
    expect(pathname).toBe(`/workspaces/${A}`);
    expect(activeRow()).toBe('alpha');
  });

  it('counts from the session’s Workspace on a session page', async () => {
    serve({ [SESSION_IN_B]: { id: SESSION_IN_B, workspace: { id: B } } });
    await visit(`/sessions/${SESSION_IN_B}`);
    expect(activeRow()).toBe('bravo');

    await press('ArrowDown');
    expect(pathname).toBe(`/workspaces/${C}`);
  });

  it('stops at the ends, and keeps the chord from the browser there too', async () => {
    serve();
    await visit(`/workspaces/${A}`);
    expect(await press('ArrowUp')).toBe(true);
    expect(pathname).toBe(`/workspaces/${A}`);

    await act(async () => navigate!(`/workspaces/${C}`));
    await settle();
    // Below charlie is only the config-only row, which has no console to open.
    expect(await press('ArrowDown')).toBe(true);
    expect(pathname).toBe(`/workspaces/${C}`);
  });

  it('leaves the chord to the browser with no Workspace open', async () => {
    serve();
    await visit('/projects');
    expect(await press('ArrowDown')).toBe(false);
    expect(await press('ArrowUp')).toBe(false);
    expect(pathname).toBe('/projects');
  });

  it('holds the row just stepped to while the next session loads, and steps on from it', async () => {
    // WorkspaceView lands a Workspace on one of its sessions. Until that session's detail arrives,
    // the only session detail the sidebar has is the previous one — from the Workspace just left.
    serve({ [SESSION_IN_A]: { id: SESSION_IN_A, workspace: { id: A } } });
    await visit(`/sessions/${SESSION_IN_A}`);
    expect(activeRow()).toBe('alpha');

    await press('ArrowDown');
    expect(pathname).toBe(`/workspaces/${B}`);
    await act(async () => navigate!(`/sessions/${SESSION_IN_B}`, { replace: true }));
    await settle();
    expect(activeRow()).toBe('bravo');

    await press('ArrowDown');
    expect(pathname).toBe(`/workspaces/${C}`);
  });

  it('lets a text field keep the chord while its caret can still move that way', async () => {
    serve();
    await visit(`/workspaces/${B}`);
    const text = 'first line\nsecond line';

    // Mid-text, and with the whole draft selected: both ways are the caret's.
    const field = focusField(text, 5);
    expect(await press('ArrowDown')).toBe(false);
    expect(await press('ArrowUp')).toBe(false);
    field.setSelectionRange(0, text.length);
    expect(await press('ArrowDown')).toBe(false);
    expect(pathname).toBe(`/workspaces/${B}`);

    // At the end the caret can still go up, not down.
    field.setSelectionRange(text.length, text.length);
    expect(await press('ArrowUp')).toBe(false);
    expect(await press('ArrowDown')).toBe(true);
    expect(pathname).toBe(`/workspaces/${C}`);

    // At the start, the other way round.
    field.setSelectionRange(0, 0);
    expect(await press('ArrowDown')).toBe(false);
    expect(await press('ArrowUp')).toBe(true);
    expect(pathname).toBe(`/workspaces/${B}`);

    // An empty field is at both ends.
    field.remove();
    focusField('', 0);
    await press('ArrowUp');
    expect(pathname).toBe(`/workspaces/${A}`);
  });

  it('leaves a press that a menu under the caret already took', async () => {
    serve();
    await visit(`/workspaces/${B}`);
    // As the composer's slash menu does with any Down while it is open.
    const field = focusField('/com', 4);
    field.addEventListener('keydown', (e) => e.preventDefault());
    await press('ArrowDown');
    expect(pathname).toBe(`/workspaces/${B}`);
  });
});

describe('workspaceStepDirection', () => {
  const chord = (over: Partial<Parameters<typeof workspaceStepDirection>[0]> = {}) =>
    workspaceStepDirection(
      {
        altKey: false,
        ctrlKey: false,
        defaultPrevented: false,
        isComposing: false,
        key: 'ArrowDown',
        metaKey: true,
        shiftKey: false,
        ...over,
      },
      null,
    );

  it('is Cmd or Ctrl with Up or Down, and nothing else', () => {
    expect(chord()).toBe(1);
    expect(chord({ key: 'ArrowUp' })).toBe(-1);
    expect(chord({ metaKey: false, ctrlKey: true })).toBe(1);
    expect(chord({ metaKey: false })).toBeNull();
    // Shift extends a selection to the field's end; Alt is a paragraph on a Mac.
    expect(chord({ shiftKey: true })).toBeNull();
    expect(chord({ altKey: true })).toBeNull();
    expect(chord({ key: 'ArrowLeft' })).toBeNull();
    expect(chord({ isComposing: true })).toBeNull();
  });

  it('takes a press in a field with no caret', () => {
    const box = document.createElement('input');
    box.type = 'checkbox';
    expect(
      workspaceStepDirection(
        {
          altKey: false,
          ctrlKey: false,
          defaultPrevented: false,
          isComposing: false,
          key: 'ArrowUp',
          metaKey: true,
          shiftKey: false,
        },
        box,
      ),
    ).toBe(-1);
  });
});
