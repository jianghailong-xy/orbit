// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FEISHU_APP_CALLBACKS,
  FEISHU_APP_EVENTS,
  FEISHU_APP_SCOPES,
  FEISHU_APP_TAKEN_MESSAGE,
  type FeishuAppSettings,
  type FeishuPlatform,
} from '@orbit/shared';
import { ApiError } from '../api';

/**
 * Settings → Integrations → Feishu (docs/feishu-bot-design.md §4.1, §4.2): the account's own Feishu or Lark app.
 * The platform, App ID and App Secret are saved with PUT /integrations/feishu, which asks Feishu first: a refusal
 * shows Feishu's own reason in the form and leaves the account without an app. The secret is written, never read
 * back: once saved the page only says it is saved, or that the key in force can no longer decrypt it. The app's
 * switch is a PATCH, Remove app a DELETE after a question. Below, the console steps in the order that works —
 * credentials into Orbit before the long connection — with every permission, event and callback name copyable.
 * Over a stand-in for the server that keeps the app the way FeishuAppService does.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
}));
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() };
vi.mock('../lib/toast', () => ({ useToast: () => toast }));
const copied: string[] = [];
vi.mock('../lib/clipboard', () => ({ copyText: vi.fn(async (text: string) => (copied.push(text), true)) }));
const { api } = await import('../api');
const { FeishuIntegrationPage, NOT_ALLOWED_NOTICE, SECRET_UNREADABLE_NOTICE } = await import('./FeishuIntegrationPage');

const SECRET = 'feishu-secret-never-shown-again';

/** The account's app as the stand-in keeps it: the secret as sent, which no answer carries. */
let stored: { platform: FeishuPlatform; appId: string; secret: string; enabled: boolean } | null;
let allowed: boolean;
let secretUnreadable: boolean;
/** What the stand-in's Feishu answers the next save with, when not a token. */
let refuse: ApiError | null;
let requests: Array<{ method: string; body?: unknown }>;
let container: HTMLDivElement | null = null;
let root: Root | null = null;

const app = (): FeishuAppSettings | null =>
  stored && {
    platform: stored.platform,
    appId: stored.appId,
    hasSecret: true,
    secretUnreadable,
    enabled: stored.enabled,
    messageDetail: 'TITLES_ONLY',
    approvalsInFeishu: true,
    defaultWorkspaceId: null,
    ownerOpenId: null,
    ownerName: null,
    botName: null,
    lastConnectedAt: null,
    lastEventAt: null,
    lastError: null,
    createdAt: '2026-11-07T08:00:00.000Z',
    updatedAt: '2026-11-07T08:00:00.000Z',
  };

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function click(element: Element | null | undefined, what: string): Promise<void> {
  expect(element, `${what} is on screen`).toBeTruthy();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

async function type(input: HTMLInputElement | null | undefined, value: string): Promise<void> {
  expect(input).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** The page as a fresh visit draws it: a new query client, so everything it shows is read from the server. */
async function open(): Promise<void> {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  container?.remove();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={['/settings/integrations/feishu']}>
        <QueryClientProvider client={client}>
          <FeishuIntegrationPage />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await settle();
}

const field = (label: string) => {
  const forId = [...container!.querySelectorAll('label')].find((l) => l.textContent === label)?.htmlFor;
  return forId ? container!.querySelector<HTMLInputElement>(`[id="${forId}"]`) : null;
};
const button = (label: string, within: ParentNode = container!) =>
  [...within.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label);
const radio = (label: string) =>
  [...container!.querySelectorAll<HTMLElement>('label.orbit-choice')].find((l) => l.textContent?.startsWith(label))?.querySelector<HTMLElement>('[role="radio"]');
const card = (title: string) =>
  [...container!.querySelectorAll<HTMLElement>('.orbit-card')].find((c) => c.querySelector('.orbit-card-title')?.textContent === title);
const badge = () => card('Your app')?.querySelector('.orbit-card-head .orbit-badge')?.textContent;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // Popconfirm measures its portal before painting; jsdom has no layout observer of its own.
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  for (const fn of Object.values(toast)) fn.mockReset();
  copied.length = 0;
  stored = null;
  allowed = true;
  secretUnreadable = false;
  refuse = null;
  requests = [];
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation(async (path: string, options: { method?: string; body?: unknown } = {}) => {
    const method = options.method ?? 'GET';
    if (path !== '/integrations/feishu') throw new Error(`the stand-in server has no ${method} ${path}`);
    requests.push({ method, ...(options.body === undefined ? {} : { body: structuredClone(options.body) }) });
    if (method === 'PUT') {
      if (refuse) throw refuse;
      const body = options.body as { platform: FeishuPlatform; appId: string; appSecret: string };
      stored = { platform: body.platform, appId: body.appId, secret: body.appSecret, enabled: stored?.enabled ?? true };
      secretUnreadable = false;
    } else if (method === 'PATCH') {
      if (!stored) throw new ApiError('No Feishu app is connected to this account.', 404);
      stored.enabled = (options.body as { enabled: boolean }).enabled;
    } else if (method === 'DELETE') {
      stored = null;
    }
    return { allowed, app: app() };
  });
});

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  container?.remove();
  container = null;
  // Popconfirm renders outside the component root.
  document.body.innerHTML = '';
});

describe('connecting an app', () => {
  it('asks for the platform, the App ID and the App Secret, and saves them trimmed in one PUT', async () => {
    await open();
    expect(card('Connect your app'), 'no app yet: the form').toBeTruthy();
    expect(card('Your app')).toBeUndefined();
    expect(radio('Feishu')?.getAttribute('aria-checked')).toBe('true');
    expect(container!.textContent).toContain('open.feishu.cn');
    expect(container!.textContent).toContain('open.larksuite.com');
    const connect = button('Connect');
    expect(connect?.disabled, 'nothing to save yet').toBe(true);

    await click(radio('Lark'), 'Lark');
    await type(field('App ID'), '  cli_lark_app  ');
    expect(button('Connect')?.disabled, 'no secret yet').toBe(true);
    await type(field('App Secret'), `${SECRET}\n`);
    expect(field('App Secret')?.type, 'the secret is typed into a password field').toBe('password');
    await click(button('Connect'), 'Connect');

    expect(requests).toEqual([
      { method: 'GET' },
      { method: 'PUT', body: { platform: 'LARK', appId: 'cli_lark_app', appSecret: SECRET } },
    ]);
    expect(toast.success).toHaveBeenCalledWith('Feishu app saved', 'Feishu accepted the App ID and App Secret.');
    // Saved: the app as it stands, and no form holding the secret.
    expect(card('Connect your app')).toBeUndefined();
    expect(badge()).toBe('Saved');
    const facts = card('Your app')!.textContent!;
    expect(facts).toContain('Lark');
    expect(facts).toContain('cli_lark_app');
    expect(facts).toContain('Saved. It is never shown again.');
    expect(document.body.innerHTML).not.toContain(SECRET);

    await open();
    expect(badge(), 'read back on a fresh visit').toBe('Saved');
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  it("shows Feishu's own reason when it refuses the credentials, keeps the form, and clears it once a field changes", async () => {
    refuse = new ApiError(
      'Feishu did not accept this App ID and App Secret: app secret invalid (code 10014). Nothing was saved.',
      400,
      'FEISHU_CREDENTIALS_REJECTED',
      { code: 'FEISHU_CREDENTIALS_REJECTED', feishuCode: 10014, feishuMsg: 'app secret invalid' },
    );
    await open();
    await type(field('App ID'), 'cli_x');
    await type(field('App Secret'), 'not-the-secret');
    await click(button('Connect'), 'Connect');
    const error = card('Connect your app')!.querySelector('.feishu-save-error');
    expect(error?.getAttribute('role')).toBe('alert');
    expect(error?.textContent).toContain("Couldn't save the app");
    expect(error?.textContent).toContain('app secret invalid (code 10014). Nothing was saved.');
    expect(card('Your app'), 'nothing saved').toBeUndefined();
    expect(toast.success).not.toHaveBeenCalled();

    await type(field('App Secret'), 'another-try');
    expect(card('Connect your app')!.querySelector('.feishu-save-error'), 'cleared once the secret changes').toBeNull();
  });

  it('says so when another account already connected the app', async () => {
    refuse = new ApiError(FEISHU_APP_TAKEN_MESSAGE, 409, 'FEISHU_APP_TAKEN');
    await open();
    await type(field('App ID'), 'cli_taken');
    await type(field('App Secret'), SECRET);
    await click(button('Connect'), 'Connect');
    expect(card('Connect your app')!.querySelector('.feishu-save-error')?.textContent).toContain(
      'This Feishu app is already connected to another Orbit account.',
    );
  });

  it('cannot connect while an administrator has turned Feishu bots off', async () => {
    allowed = false;
    await open();
    expect(container!.textContent).toContain(NOT_ALLOWED_NOTICE);
    expect(field('App ID')?.disabled).toBe(true);
    expect(field('App Secret')?.disabled).toBe(true);
    expect(button('Connect')?.disabled).toBe(true);
  });
});

describe('the app connected', () => {
  beforeEach(() => {
    stored = { platform: 'FEISHU', appId: 'cli_mine', secret: SECRET, enabled: true };
  });

  it('switches the app off with PATCH', async () => {
    await open();
    expect(badge()).toBe('Saved');
    const control = card('Your app')!.querySelector<HTMLElement>('[role="switch"]');
    expect(control?.getAttribute('aria-checked')).toBe('true');
    await click(control, 'Use this app');
    expect(requests.at(-1)).toEqual({ method: 'PATCH', body: { enabled: false } });
    expect(badge()).toBe('Off');
    expect(card('Your app')!.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('false');
  });

  it('replaces the credentials through the same check, the App ID kept and the secret asked for again', async () => {
    await open();
    await click(button('Replace credentials'), 'Replace credentials');
    expect(card('Replace credentials')).toBeTruthy();
    expect(field('App ID')?.value).toBe('cli_mine');
    expect(field('App Secret')?.value).toBe('');
    await type(field('App Secret'), `${SECRET}-rotated`);
    await click(button('Save'), 'Save');
    expect(requests.at(-1)).toEqual({ method: 'PUT', body: { platform: 'FEISHU', appId: 'cli_mine', appSecret: `${SECRET}-rotated` } });
    expect(card('Replace credentials'), 'closed once saved').toBeUndefined();
  });

  it('removes the app after asking, and offers the form again', async () => {
    await open();
    await click(button('Remove app'), 'Remove app');
    const question = [...document.body.querySelectorAll<HTMLElement>('[role="dialog"]')].find((d) =>
      d.textContent?.includes('Remove this Feishu app from Orbit?'));
    expect(question?.textContent).toContain('The app itself stays in your Feishu developer console.');
    await click(button('Remove app', question), 'the question\'s Remove app');
    expect(requests.at(-1)).toEqual({ method: 'DELETE' });
    expect(toast.success).toHaveBeenCalledWith('Feishu app removed');
    expect(card('Your app')).toBeUndefined();
    expect(card('Connect your app')).toBeTruthy();
  });

  it('asks for the App Secret again when the key in force can no longer decrypt it', async () => {
    secretUnreadable = true;
    await open();
    expect(badge()).toBe('Needs its App Secret');
    expect(card('Your app')!.textContent).toContain(SECRET_UNREADABLE_NOTICE);
  });
});

describe('the steps in the developer console', () => {
  it('names every permission, event and callback, each copyable, with the credentials going into Orbit before the long connection', async () => {
    await open();
    const steps = card('Set up the app in Feishu')!;
    const titles = [...steps.querySelectorAll('ol.feishu-steps > li > .admin-signin-label')].map((t) => t.textContent);
    expect(titles).toEqual([
      'Create a custom app',
      'Grant it these permissions',
      'Enter its App ID and App Secret in Orbit first',
      'Switch to the long connection',
      'Publish it',
    ]);
    const names = [...steps.querySelectorAll('.feishu-copy code')].map((c) => c.textContent);
    expect(names).toEqual([...FEISHU_APP_SCOPES, ...FEISHU_APP_EVENTS, ...FEISHU_APP_CALLBACKS]);
    for (const name of names) await click(button('Copy', steps.querySelector(`[aria-label="Copy ${name}"]`)?.parentElement ?? steps), `Copy ${name}`);
    expect(copied).toEqual(names);
    expect(steps.textContent).toContain('only messages that @mention the bot reach Orbit');
    expect([...steps.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([
      'https://open.feishu.cn/app',
      'https://open.larksuite.com/app',
    ]);
  });
});
