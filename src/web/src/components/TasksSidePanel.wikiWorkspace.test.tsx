// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeId } from '../lib/idCodec';
import { ThemeProvider } from '../lib/theme';
import { WIKI_FROM_WORKSPACE_KEY } from '../lib/wikiSpace';
import { TasksSidePanel } from './TasksSidePanel';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: () => new Promise(() => undefined),
}));

/**
 * Where the reader is, as the sidebar tells the Wiki (design §12.3.4): `/wiki` opens the space bound to
 * the workspace the reader came from. The sidebar knows that workspace — its active one, or on a
 * project's page the workspace the project's coordinator runs in — and keeps it for this tab; a page
 * that is in no workspace (the Projects or Tasks list) clears it, and the Wiki's own pages leave it be.
 */

const WORKSPACE = encodeId('0196d000-0000-7000-8000-0000000000a1');
const COORDINATOR_WORKSPACE = encodeId('0196d000-0000-7000-8000-0000000000a2');
const PROJECT = encodeId('0196d000-0000-7000-8000-0000000000b1');

let root: Root | null = null;

beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined })),
  );
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

function mount(path: string): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['user', 'me'], { id: 'user', email: 'a@b.c', name: 'wikova', createdAt: '', role: 'MEMBER' });
  client.setQueryData(['workspaces'], []);
  client.setQueryData(['runners'], []);
  client.setQueryData(['session-counts'], []);
  client.setQueryData(['tasklists'], []);
  client.setQueryData(['wiki', 'spaces'], []);
  client.setQueryData(['project', PROJECT], { id: PROJECT, title: 'Wiki 内容先行', coordinatorWorkspaceId: COORDINATOR_WORKSPACE });
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <QueryClientProvider client={client}>
        <ThemeProvider>
          <MemoryRouter initialEntries={[path]}>
            <TasksSidePanel />
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    ),
  );
}

describe('the workspace the Wiki opens the space of', () => {
  it('is the workspace on screen', () => {
    mount(`/workspaces/${WORKSPACE}`);
    expect(sessionStorage.getItem(WIKI_FROM_WORKSPACE_KEY)).toBe(WORKSPACE);
  });

  it('is the coordinator’s workspace on a project’s page', () => {
    mount(`/projects/${PROJECT}`);
    expect(sessionStorage.getItem(WIKI_FROM_WORKSPACE_KEY)).toBe(COORDINATOR_WORKSPACE);
  });

  it('is the coordinator’s workspace on a project’s sessions page, not the workspace it shows', () => {
    mount(`/workspaces/${WORKSPACE}?project=${PROJECT}`);
    expect(sessionStorage.getItem(WIKI_FROM_WORKSPACE_KEY)).toBe(COORDINATOR_WORKSPACE);
  });

  it('is none after the Projects or Tasks list', () => {
    sessionStorage.setItem(WIKI_FROM_WORKSPACE_KEY, WORKSPACE);
    mount('/projects');
    expect(sessionStorage.getItem(WIKI_FROM_WORKSPACE_KEY)).toBeNull();
  });

  it('is left as the page before said while the Wiki is open', () => {
    sessionStorage.setItem(WIKI_FROM_WORKSPACE_KEY, WORKSPACE);
    mount('/wiki/orbit/activity');
    expect(sessionStorage.getItem(WIKI_FROM_WORKSPACE_KEY)).toBe(WORKSPACE);
  });
});
