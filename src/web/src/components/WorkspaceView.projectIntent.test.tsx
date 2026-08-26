// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: vi.fn() };
});

const { api } = await import('../api');
const apiMock = vi.mocked(api);
const { WorkspaceView } = await import('./WorkspaceView');

const RUNNER_ID = '0195c0de-0000-7000-8000-000000000011';
const WORKSPACE_ID = '0195c0de-0000-7000-8000-000000000012';
const NEW_SESSION_PATH = `/workspaces/${WORKSPACE_ID}/new`;
const RUNNER = {
  id: RUNNER_ID,
  name: 'mac-01',
  online: true,
  maxConcurrent: 2,
  activeSessions: 0,
  engines: [
    { engine: 'claude', installed: true, auth: 'yes' },
    { engine: 'codex', installed: true, auth: 'yes' },
    { engine: 'kimi', installed: true, auth: 'yes' },
  ],
} satisfies Runner;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  apiMock.mockReset();
  apiMock.mockImplementation((path: string) => {
    if (path === '/users/me') {
      return Promise.resolve({
        id: 'user-1',
        email: 'reader@example.com',
        name: 'Reader',
        createdAt: '2026-01-01T00:00:00Z',
        preferences: { defaultEffort: 'high' },
      }) as Promise<never>;
    }
    if (path === '/providers' || path === '/session-tags') {
      return Promise.resolve([]) as Promise<never>;
    }
    if (path === '/workspaces') {
      return Promise.resolve([
        {
          id: WORKSPACE_ID,
          name: 'orbit',
          runnerId: RUNNER_ID,
          createdAt: '2026-01-01T00:00:00Z',
          lastProvider: 'claude',
          effort: 'high',
        },
      ]) as Promise<never>;
    }
    if (path.startsWith('/sessions?')) return Promise.resolve([]) as Promise<never>;
    return Promise.reject(new Error(`unstubbed endpoint: ${path}`));
  });
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
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: () => {},
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: () => {},
  });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
  delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  vi.unstubAllGlobals();
});

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(entry: string): Promise<void> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[entry]}>
          <AntApp>
            <WorkspaceView runner={RUNNER} />
            <LocationProbe />
          </AntApp>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
}

const one = (selector: string): HTMLElement => {
  const element = container?.querySelector<HTMLElement>(selector) ?? null;
  expect(element, selector).toBeTruthy();
  return element!;
};

describe('New Session project intent', () => {
  it('renders the intent strip and project hero when the compose route carries ?intent=project', async () => {
    await mount(`${NEW_SESSION_PATH}?intent=project`);

    expect(one('.np-title').textContent).toBe('Start a new project');
    expect(one('.np-sub').textContent).toBe(
      'Describe what you want done — 目标、验收标准和任务拆解在对话里定。',
    );
    const intent = one('.composer-project-intent');
    expect(intent.querySelector('b')?.textContent).toBe('◧ 这次会开出一个新项目');
    expect(intent.querySelector('span')?.textContent).toBe(
      '—— 说清楚要做成什么，它会先读仓库再跟你敲定计划',
    );
    expect(intent.querySelectorAll('button[aria-label="关闭项目意图"]')).toHaveLength(1);
  });

  it('keeps the ordinary compose framing byte-for-byte when the route has no intent', async () => {
    await mount(NEW_SESSION_PATH);

    expect({
      title: one('.np-title').outerHTML,
      subtitle: one('.np-sub').outerHTML,
      intent: container?.querySelector('.composer-project-intent') ?? null,
    }).toEqual({
      title: '<div class="np-title">Start a new session</div>',
      subtitle:
        '<div class="np-sub">Describe the task — Orbit remembers who runs it.</div>',
      intent: null,
    });
  });

  it('dismisses into the ordinary New Session route and framing', async () => {
    await mount(`${NEW_SESSION_PATH}?intent=project`);

    await act(async () => one('button[aria-label="关闭项目意图"]').click());
    await flush();

    expect(one('[data-testid="location"]').textContent).toBe(NEW_SESSION_PATH);
    expect(container?.querySelector('.composer-project-intent')).toBeNull();
    expect(one('.np-title').textContent).toBe('Start a new session');
    expect(one('.np-sub').textContent).toBe(
      'Describe the task — Orbit remembers who runs it.',
    );
  });
});

describe('the existing composer control inventory', () => {
  it('still defines exactly the five named pills and no sixth one', () => {
    // Visibility is state-dependent (Workspace belongs to an unlocked draft; Provider to a
    // live/resumable session), so no honest runtime fixture paints all five at once. Assert the
    // owned JSX block instead: this task may add the one dismiss button above it, but no config
    // control definition may appear in or disappear from the existing row.
    const source = readFileSync(resolve(process.cwd(), 'src/components/WorkspaceView.tsx'), 'utf8');
    const start = source.indexOf('<div className="composer-pills">');
    const end = source.indexOf('{shownPlanUsage &&', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const pills = source.slice(start, end);

    expect({
      workspace: pills.includes('title="Workspace"'),
      permission: pills.includes('title={configHints.permissionMode}'),
      provider: pills.includes('title={configHints.provider}'),
      model: pills.includes('title={configHints.model}'),
      effort: pills.includes('title={configHints.effort}'),
    }).toEqual({
      workspace: true,
      permission: true,
      provider: true,
      model: true,
      effort: true,
    });
    expect(pills.match(/<span className="composer-pill(?: [^"]*)?">/g) ?? []).toHaveLength(5);
  });
});
