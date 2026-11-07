// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeishuChatRoutes } from '@orbit/shared';
import { ApiError } from '../api';

/**
 * Orbit's confirm page for connecting a Feishu group (docs/feishu-bot-design.md §8.1), opened from the bot's card with
 * its one-time ticket: it names the group the ticket would connect, asks for the workspace, the permission mode — saying
 * what that lets the group do on which runner — who may start sessions, ticked by name from the group's members, and the
 * two limits — and confirms with one POST.
 * A ticket that no longer works is said to, with nothing to submit. Over a stand-in for the server.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock('../lib/toast', () => ({ useToast: () => toast }));

import { api } from '../api';
import { FeishuConnectGroupPage, groupConsequence } from './FeishuConnectGroupPage';

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let pending: FeishuChatRoutes['pending'];
let posted: unknown[];
let refuse: Error | null;

beforeEach(() => {
  pending = {
    chatId: 'oc_team', chatName: 'Release team', expiresAt: '2099-01-01T00:00:00.000Z', connected: false,
    members: [{ openId: 'ou_bob', name: 'Bob' }, { openId: 'ou_carol', name: 'Carol' }, { openId: 'ou_dan', name: null }],
  };
  posted = [];
  refuse = null;
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation(async (path: string, options: { method?: string; body?: unknown } = {}) => {
    if (path === '/workspaces') return [{ id: 'ws-1', name: 'groups workspace', enabled: true, runner: { name: 'build-box', displayName: 'Build box' } }];
    if (path === '/integrations/feishu/chats?ticket=t-123') return { routes: [], pending };
    if (path === '/integrations/feishu/chats/confirm' && options.method === 'POST') {
      if (refuse) throw refuse;
      posted.push(structuredClone(options.body));
      return { id: 'route-1' };
    }
    throw new Error(`the stand-in server has no ${options.method ?? 'GET'} ${path}`);
  });
});

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  container?.remove();
  container = null;
  document.body.innerHTML = '';
});

async function settle() {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
async function open(url = '/settings/integrations/feishu/connect-group?ticket=t-123') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[url]}>
        <QueryClientProvider client={client}>
          <Routes>
            <Route path="/settings/integrations/feishu/connect-group" element={<FeishuConnectGroupPage />} />
            <Route path="/settings/integrations/feishu" element={<div>the Feishu settings</div>} />
          </Routes>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await settle();
}
async function click(element: Element | null | undefined, what: string) {
  expect(element, `${what} is on screen`).toBeTruthy();
  await act(async () => { element!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await settle();
}
const button = (label: string) => [...container!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label);
const member = (name: string) =>
  [...container!.querySelectorAll<HTMLElement>('[aria-label="Allowed senders"] label.orbit-choice')]
    .find((l) => l.textContent === name)?.querySelector<HTMLElement>('[role="checkbox"]');
const radio = (label: string) =>
  [...container!.querySelectorAll<HTMLElement>('label.orbit-choice')].find((l) => l.textContent?.startsWith(label))?.querySelector<HTMLElement>('[role="radio"]');

describe('the confirm page', () => {
  it('names the group, says what the mode lets the group do on which runner, and confirms the choices in one POST', async () => {
    await open();
    expect(container!.textContent).toContain('Release team');
    expect(container!.textContent).toContain('People in this group can make agents act on Build box in Default mode.');
    await click(radio('Accept Edits'), 'Accept Edits');
    expect(container!.textContent).toContain('People in this group can make agents act on Build box in Accept Edits mode.');
    await click(radio('Only these people'), 'Only these people');
    // The group's members by name; nobody is ticked yet, so there is nothing to submit.
    expect([...container!.querySelectorAll('[aria-label="Allowed senders"] label.orbit-choice')].map((l) => l.textContent))
      .toEqual(['Bob', 'Carol', 'A member whose name Feishu did not give']);
    expect(button('Connect group')?.disabled).toBe(true);
    await click(member('Carol'), 'Carol');
    await click(member('Bob'), 'Bob');
    await click(button('Connect group'), 'Connect group');
    expect(posted).toEqual([{
      ticket: 't-123', workspaceId: 'ws-1', permissionMode: 'acceptEdits', allowedOpenIds: ['ou_bob', 'ou_carol'],
      maxConcurrentSessions: 2, sessionsPerDay: 20,
    }]);
    expect(container!.textContent).toContain('the Feishu settings');
    expect(toast.success).toHaveBeenCalledWith('Group connected', 'Release team can now start sessions in groups workspace.');
  });

  it('sends an empty list for everyone in the group, and drops what was ticked once everyone is chosen', async () => {
    await open();
    await click(radio('Only these people'), 'Only these people');
    await click(member('Bob'), 'Bob');
    await click(member('Bob'), 'Bob again');
    expect(button('Connect group')?.disabled, 'unticked again, nobody is chosen').toBe(true);
    await click(member('Bob'), 'Bob');
    await click(radio('Everyone in the group'), 'Everyone in the group');
    await click(button('Connect group'), 'Connect group');
    expect((posted[0] as { allowedOpenIds: string[] }).allowedOpenIds).toEqual([]);
  });

  it('offers only everyone when Feishu would not say who is in the group', async () => {
    pending = { ...pending!, members: null };
    await open();
    expect(container!.textContent).toContain("Orbit couldn't read who is in this group from Feishu");
    const only = radio('Only these people');
    expect(only?.hasAttribute('data-disabled') || only?.getAttribute('aria-disabled') === 'true').toBe(true);
    await click(button('Connect group'), 'Connect group');
    expect((posted[0] as { allowedOpenIds: string[] }).allowedOpenIds).toEqual([]);
  });

  it('shows the server\'s refusal and stays', async () => {
    refuse = new ApiError('This link to connect a group has expired or was already used.', 409);
    await open();
    await click(button('Connect group'), 'Connect group');
    expect(container!.textContent).toContain("Couldn't connect the group");
    expect(container!.textContent).toContain('expired or was already used');
  });

  it('says a ticket no longer works, with nothing to submit', async () => {
    pending = null;
    await open();
    expect(container!.textContent).toContain('This link has expired or was already used');
    expect(button('Connect group')).toBeUndefined();
    await open('/settings/integrations/feishu/connect-group');
    expect(container!.textContent).toContain('This link has expired or was already used');
  });
});

describe('the words', () => {
  it('state the consequence as the design asks', () => {
    expect(groupConsequence('build-box', 'bypassPermissions')).toBe('People in this group can make agents act on build-box in Bypass mode.');
  });
});
