// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp, ConfigProvider } from 'antd';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CodexRateLimitResetOperationStatus,
  CodexRateLimitResetOperationView,
} from '@orbit/shared';
import { api, ApiError } from '../api';
import { CODEX_RESET_CLIENT_TIMING, type CodexResetIntent, type CodexResetRunner } from '../lib/codexResetCredit';
import {
  OTHER_FINGERPRINT,
  RESET_FINGERPRINT,
  RESET_REQUEST_ID,
  RESET_RUNNER_ID,
  resetBlock,
  resetCredit,
  resetOperation,
  resetRunner,
} from '../lib/codexResetCredit.fixtures';
import { PlanUsageIndicator } from './PlanUsageIndicator';

/**
 * The Plan usage pill and its Codex reset credit, pressed in a real DOM: the popover's keyboard path,
 * the second confirmation, and what each create and each operation state puts in front of the reader.
 * The operation API is a fake that answers the way the create route does — a clientRequestId it has
 * seen is replayed as the same operation — so "one logical consume" is counted as operations the
 * server inserted, not as calls this file happened to make.
 */
vi.mock('../api', async (importOriginal) => ({
  // ApiError stays real: the refusal branches turn on `instanceof` plus a status and a code.
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
}));
const apiMock = vi.mocked(api);

const BASE = `/runners/${RESET_RUNNER_ID}/codex-rate-limit-reset`;
const ACTIVE = new Set<CodexRateLimitResetOperationStatus>(['PENDING', 'CONSUMING', 'REFRESHING']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OTHER_REQUEST_ID = '11111111-1111-4111-8111-111111111111';

/** The user API adds public-id twins to every operation it sends. */
const withTwins = (op: CodexRateLimitResetOperationView | null) =>
  op && { ...op, publicId: op.id, runnerPublicId: op.runnerId };

interface Call {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

class FakeResetApi {
  readonly calls: Call[] = [];
  readonly ops = new Map<string, CodexRateLimitResetOperationView>();
  inserted = 0;
  /** One per create, in order: `lose` drops the response (after committing when `landed`), `hang` never answers. */
  readonly faults: { kind: 'lose' | 'hang'; landed: boolean }[] = [];
  refusal: { code: string; operationId?: string } | null = null;
  /** What the list reports as active, when a test needs it to lag behind the rows. */
  listedActive: CodexRateLimitResetOperationView | null | undefined = undefined;

  constructor() {
    apiMock.mockImplementation(((path: string, options?: { method?: string; body?: unknown }) =>
      this.handle(path, options ?? {})) as never);
  }

  posts(): Call[] {
    return this.calls.filter((call) => call.method === 'POST');
  }

  reads(id: string): Call[] {
    return this.calls.filter((call) => call.method === 'GET' && call.path === `${BASE}/${id}`);
  }

  advance(id: string, status: CodexRateLimitResetOperationStatus, overrides: Parameters<typeof resetOperation>[1] = {}) {
    const current = this.ops.get(id)!;
    this.ops.set(
      id,
      resetOperation(status, {
        id,
        clientRequestId: current.clientRequestId,
        accountFingerprint: current.accountFingerprint,
        ...overrides,
      }),
    );
  }

  private async handle(path: string, options: { method?: string; body?: unknown }): Promise<unknown> {
    const method = options.method ?? 'GET';
    this.calls.push({ method, path, body: options.body as Record<string, unknown> | undefined });
    if (method === 'POST' && path === BASE) {
      return this.create(options.body as { clientRequestId: string; accountFingerprint: string });
    }
    if (method === 'GET' && path === BASE) {
      const rows = [...this.ops.values()];
      const active =
        this.listedActive !== undefined ? this.listedActive : (rows.find((op) => ACTIVE.has(op.status)) ?? null);
      return { active: withTwins(active), latest: withTwins(rows.at(-1) ?? null) };
    }
    if (method === 'GET' && path.startsWith(`${BASE}/`)) {
      const op = this.ops.get(decodeURIComponent(path.slice(BASE.length + 1)));
      if (!op) throw new ApiError('operation not found', 404);
      return withTwins(op);
    }
    throw new Error(`unexpected ${method} ${path}`);
  }

  private async create(body: { clientRequestId: string; accountFingerprint: string }): Promise<unknown> {
    if (this.refusal) throw new ApiError('Conflict', 409, this.refusal.code, { ...this.refusal });
    const fault = this.faults.shift();
    let op = [...this.ops.values()].find((row) => row.clientRequestId === body.clientRequestId);
    const replayed = op !== undefined;
    if (!op && (!fault || fault.landed)) {
      this.inserted += 1;
      op = resetOperation('PENDING', {
        id: `Op${this.inserted}`,
        clientRequestId: body.clientRequestId,
        accountFingerprint: body.accountFingerprint,
      });
      this.ops.set(op.id, op);
    }
    if (fault?.kind === 'lose') throw new TypeError('Failed to fetch');
    if (fault?.kind === 'hang') return new Promise(() => {});
    return { operation: withTwins(op!), replayed };
  }
}

const TIMING = { ...CODEX_RESET_CLIENT_TIMING, retryDelaysMs: [...CODEX_RESET_CLIENT_TIMING.retryDelaysMs] };
let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  apiMock.mockReset();
  localStorage.clear();
  Object.assign(CODEX_RESET_CLIENT_TIMING, { pollMs: 25, retryDelaysMs: [10, 10], postTimeoutMs: 2_000 });
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
});

afterEach(async () => {
  await unmount();
  document.body.innerHTML = '';
  Object.assign(CODEX_RESET_CLIENT_TIMING, TIMING);
  vi.unstubAllGlobals();
});

async function mount(runner: CodexResetRunner, reset = true): Promise<void> {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const mounted = root;
  await act(async () => {
    mounted.render(
      <QueryClientProvider client={client}>
        <ConfigProvider theme={{ token: { motion: false } }}>
          <AntApp>
            <MemoryRouter>
              <PlanUsageIndicator
                usage={runner.planUsage!.codex!}
                reset={reset ? { runner, workspaceId: 'Workspace1' } : undefined}
              />
            </MemoryRouter>
          </AntApp>
        </ConfigProvider>
      </QueryClientProvider>,
    );
  });
  await pause();
}

/** Unmounting and mounting again is what a reload does to this component: only localStorage survives. */
async function unmount(): Promise<void> {
  if (!root) return;
  const current = root;
  root = null;
  await act(async () => current.unmount());
  container?.remove();
  container = null;
  document.body.innerHTML = '';
}

// A mounted antd tree in jsdom is slow on a loaded machine. A test that times out keeps running in
// the background and its unmount would clear the next test's page, so the budget is generous and
// every wait gives up well inside it.
vi.setConfig({ testTimeout: 60_000 });

const pause = (ms = 0) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

async function until(what: string, predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for ${what}; the page says: ${document.body.textContent}`);
    }
    await pause(10);
  }
}

const pill = () => document.querySelector<HTMLButtonElement>('button.composer-usage')!;
const usagePanel = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Plan usage"]');
const panelText = () => usagePanel()?.textContent ?? '';
const button = (name: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((each) => each.textContent?.trim() === name) ??
  null;
const toastText = () =>
  Array.from(document.querySelectorAll('.ant-message'))
    .map((each) => each.textContent)
    .join(' ');

function confirmation(): HTMLElement | null {
  const title = Array.from(document.querySelectorAll('.ant-modal-title')).find(
    (each) => each.textContent === 'Use reset credit?',
  );
  return (title?.closest('[role="dialog"]') as HTMLElement | null) ?? null;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await pause();
}

async function keydown(element: Element, key: string, init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  });
  await pause();
}

async function openUsage(): Promise<void> {
  pill().focus();
  await click(pill());
  await until('the Plan usage popover', () => usagePanel() !== null && pill().getAttribute('aria-expanded') === 'true');
}

async function confirmReset(): Promise<void> {
  await click(button('Use reset credit')!);
  await until('the confirmation', () => button('Use reset') !== null);
  await click(button('Use reset')!);
}

function stored(): Record<string, unknown> | null {
  const raw = localStorage.getItem(`orbit.codexReset:${RESET_RUNNER_ID}`);
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
}

function remembered(overrides: Partial<CodexResetIntent>): void {
  const intent: CodexResetIntent = {
    v: 1,
    runnerId: RESET_RUNNER_ID,
    accountFingerprint: RESET_FINGERPRINT,
    confirmedAt: new Date().toISOString(),
    clientRequestId: RESET_REQUEST_ID,
    ...overrides,
  };
  localStorage.setItem(`orbit.codexReset:${RESET_RUNNER_ID}`, JSON.stringify(intent));
}

describe('the Plan usage pill', () => {
  it('opens as a labelled dialog from a press, keeps Tab inside, and hands focus back on Escape', async () => {
    new FakeResetApi();
    await mount(resetRunner(new Date()));
    const trigger = pill();
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger.getAttribute('aria-label')).toBe('Plan usage 92%');
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    await openUsage();
    await until('focus inside the popover', () => document.activeElement === usagePanel());
    const use = button('Use reset credit')!;
    expect(use.disabled).toBe(false);
    expect(use.getAttribute('aria-haspopup')).toBe('dialog');
    await keydown(usagePanel()!, 'Tab');
    expect(document.activeElement).toBe(use);
    await keydown(use, 'Tab');
    expect(document.activeElement).toBe(use);
    await keydown(use, 'Tab', { shiftKey: true });
    expect(document.activeElement).toBe(use);

    await keydown(use, 'Escape');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  it('draws the windows, the authoritative count, what the listed credits say about expiry, and the snapshot age', async () => {
    const now = new Date();
    new FakeResetApi();
    // Codex capped the list at one row while reporting four credits.
    await mount(resetRunner(now, {}, resetBlock(now, { rateLimitResetCredits: { availableCount: 4, credits: [resetCredit()] } })));
    await openUsage();
    const text = panelText();
    expect(text).toContain('5h limit92%');
    expect(text).toContain('Weekly limit68%');
    expect(text).toContain('Reset credit4 available');
    expect(text).not.toContain('1 available');
    expect(text).toContain('Earliest listed expires');
    expect(text).toContain('partial list');
    expect(text).toContain('Updated 2 min ago');
    const section = usagePanel()!.querySelector('section.cu-rc')!;
    expect(document.getElementById(section.getAttribute('aria-labelledby')!)?.textContent).toBe('Reset credit');
  });
});

describe('confirming a reset', () => {
  it('asks first with focus on Cancel, and a double press of Use reset sends one create under one clientRequestId', async () => {
    const server = new FakeResetApi();
    await mount(resetRunner(new Date()));
    await openUsage();
    await click(button('Use reset credit')!);
    await until('the confirmation', () => confirmation() !== null);
    const dialog = confirmation()!;
    // Looked up inside the dialog: under NODE_ENV=test rc-util hands every component the same id
    // ("test-id"), so a document-wide lookup would find the popover first. A browser gets unique ids.
    const labelId = dialog.getAttribute('aria-labelledby')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.querySelector(`[id="${labelId}"]`)?.textContent).toBe('Use reset credit?');
    expect(dialog.textContent).toContain(
      'This consumes 1 earned credit and resets eligible Codex usage windows. This action can’t be undone.',
    );
    expect(dialog.textContent).toContain('Current usage92% → reset');
    expect(dialog.textContent).toContain('Your conversations and their context aren’t affected.');
    await until('focus on Cancel', () => document.activeElement === button('Cancel'));

    await click(button('Cancel')!);
    await until('the confirmation to close', () => confirmation() === null);
    expect(server.posts()).toHaveLength(0);
    expect(stored()).toBeNull();
    await until('focus back on the entry', () => document.activeElement === button('Use reset credit'));
    expect(pill().getAttribute('aria-expanded')).toBe('true');

    await click(button('Use reset credit')!);
    await until('the confirmation', () => button('Use reset') !== null);
    const useReset = button('Use reset')!;
    await act(async () => {
      useReset.click();
      useReset.click();
    });
    await until('the operation to be followed', () => server.reads('Op1').length > 0);
    expect(server.posts()).toHaveLength(1);
    const body = server.posts()[0].body!;
    // The browser sends its own request id and the fingerprint it confirmed against — never a provider key.
    expect(Object.keys(body).sort()).toEqual(['accountFingerprint', 'clientRequestId', 'workspaceId']);
    expect(body.clientRequestId).toMatch(UUID);
    expect(body).toMatchObject({ accountFingerprint: RESET_FINGERPRINT, workspaceId: 'Workspace1' });
    expect(server.inserted).toBe(1);
    expect(stored()).toMatchObject({ clientRequestId: body.clientRequestId, operationId: 'Op1' });
    await until('focus on the status line', () => document.activeElement?.getAttribute('role') === 'status');
  });

  it('follows the operation through pending, a recoverable error and the refresh to success, then refreshes usage', async () => {
    const server = new FakeResetApi();
    await mount(resetRunner(new Date()));
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await openUsage();
    await confirmReset();
    await until('pending', () => panelText().includes('Starting reset…'));
    expect(panelText()).toContain('No credit has been used yet.');
    expect(pill().getAttribute('aria-label')).toBe('Plan usage 92%, reset in progress');
    expect(button('Use reset credit')).toBeNull();

    server.advance('Op1', 'CONSUMING', { lastErrorCode: 'PROVIDER_TIMEOUT' });
    await until('the recoverable error', () =>
      panelText().includes('Codex took too long to answer. Retrying the same request, so at most 1 credit is used.'),
    );
    server.advance('Op1', 'REFRESHING');
    await until('the refresh', () => panelText().includes('Limits reset — refreshing usage…'));
    server.advance('Op1', 'SUCCEEDED');
    await until('success', () => panelText().includes('Usage limits reset1 credit used. Plan usage has been refreshed.'));
    await until('the announcement', () => toastText().includes('Usage limits reset. 1 credit used. Plan usage has been refreshed.'));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['runners'] });
    expect(pill().getAttribute('aria-label')).toBe('Plan usage 92%');
    expect(stored()).toMatchObject({ operationId: 'Op1', settledAt: expect.any(String) });
    expect(server.posts()).toHaveLength(1);
    expect(server.inserted).toBe(1);

    await click(button('Dismiss')!);
    expect(stored()).toBeNull();
    await until('the entry to come back', () => button('Use reset credit') !== null);
    await until('focus on the entry that replaced Dismiss', () => document.activeElement === button('Use reset credit'));
  });

  it('sends an unanswered create again under the same clientRequestId, and it becomes the one operation', async () => {
    for (const landed of [true, false]) {
      const server = new FakeResetApi();
      server.faults.push({ kind: 'lose', landed });
      await mount(resetRunner(new Date()));
      await openUsage();
      await confirmReset();
      await until('the resend to be answered', () => server.reads('Op1').length > 0);
      const [first, second] = server.posts();
      expect(server.posts()).toHaveLength(2);
      expect(second.body!.clientRequestId).toBe(first.body!.clientRequestId);
      expect(server.inserted).toBe(1);
      await until('pending', () => panelText().includes('Starting reset…'));
      await unmount();
      localStorage.clear();
    }
  });

  it('hands Retry to the user once automatic resends run out, and Retry still reuses the id', async () => {
    const server = new FakeResetApi();
    server.faults.push(
      { kind: 'lose', landed: false },
      { kind: 'lose', landed: false },
      { kind: 'lose', landed: false },
    );
    await mount(resetRunner(new Date()));
    await openUsage();
    await confirmReset();
    await until('the unanswered notice', () => panelText().includes('Couldn’t confirm the reset request'));
    expect(panelText()).toContain('Retry sends the same request, so at most 1 credit is used.');
    expect(panelText()).not.toContain('No credit was used');
    expect(server.posts()).toHaveLength(3);
    expect(server.inserted).toBe(0);

    await click(button('Retry')!);
    await until('the operation', () => server.reads('Op1').length > 0);
    expect(server.posts()).toHaveLength(4);
    expect(new Set(server.posts().map((post) => post.body!.clientRequestId)).size).toBe(1);
    expect(server.inserted).toBe(1);
  });

  it('picks a confirmation back up after a reload: resends while unanswered, and only follows once answered', async () => {
    const server = new FakeResetApi();
    server.faults.push({ kind: 'hang', landed: true });
    const runner = resetRunner(new Date());
    await mount(runner);
    await openUsage();
    await confirmReset();
    await until('the create', () => server.posts().length === 1);
    const requestId = server.posts()[0].body!.clientRequestId;
    expect(stored()).toMatchObject({ clientRequestId: requestId });
    expect(stored()).not.toHaveProperty('operationId');

    await unmount();
    await mount(runner);
    await until('the resend', () => server.posts().length === 2);
    expect(server.posts()[1].body!.clientRequestId).toBe(requestId);
    await until('the stored operation', () => stored()?.operationId === 'Op1');
    expect(server.inserted).toBe(1);

    await unmount();
    const readsBefore = server.reads('Op1').length;
    await mount(runner);
    await until('following the stored operation', () => server.reads('Op1').length > readsBefore);
    expect(server.posts()).toHaveLength(2);
    await openUsage();
    await until('pending', () => panelText().includes('Starting reset…'));
    expect(button('Use reset credit')).toBeNull();
  });

  it('after the consume deadline, looks an unanswered confirmation up instead of sending it again', async () => {
    const server = new FakeResetApi();
    server.ops.set('Op7', resetOperation('SUCCEEDED', { id: 'Op7' }));
    remembered({ confirmedAt: new Date(Date.now() - 11 * 60_000).toISOString() });
    await mount(resetRunner(new Date()));
    await until('the lookup', () => stored()?.operationId === 'Op7');
    expect(server.posts()).toHaveLength(0);
  });

  it('follows the operation in the way when the create is refused as already in flight, creating nothing', async () => {
    const server = new FakeResetApi();
    server.ops.set('Op9', resetOperation('CONSUMING', { id: 'Op9', clientRequestId: OTHER_REQUEST_ID }));
    server.listedActive = null;
    server.refusal = { code: 'OPERATION_IN_FLIGHT', operationId: 'Op9' };
    await mount(resetRunner(new Date()));
    await openUsage();
    await confirmReset();
    await until('the operation in the way', () => panelText().includes('Using reset credit…'));
    expect(server.inserted).toBe(0);
    expect(server.reads('Op9').length).toBeGreaterThan(0);
    expect(stored()).toMatchObject({ operationId: 'Op9' });
    expect(stored()).not.toHaveProperty('clientRequestId');
  });

  it('says a refused create used no credit, and an account override takes the entry away', async () => {
    const server = new FakeResetApi();
    server.refusal = { code: 'NO_CREDIT_AVAILABLE' };
    await mount(resetRunner(new Date()));
    await openUsage();
    await confirmReset();
    await until('the refusal', () => panelText().includes('Couldn’t start the reset'));
    expect(panelText()).toContain('No reset credits available. No credit was used.');
    expect(stored()).toBeNull();
    await click(button('Dismiss')!);
    await until('the entry', () => button('Use reset credit') !== null);

    server.refusal = { code: 'ACCOUNT_OVERRIDE' };
    await confirmReset();
    await until('the override', () => panelText().includes("This workspace doesn't run on the runner's own Codex sign-in"));
    await click(button('Dismiss')!);
    await until('the section to go', () => !panelText().includes('Reset credit'));
    expect(button('Use reset credit')).toBeNull();
    // Nothing is left to focus in the section, so focus stays in the popover rather than the page.
    await until('focus back on the popover', () => document.activeElement === usagePanel());
    expect(server.inserted).toBe(0);
  });
});

describe('every result an operation can come to', () => {
  const results: { name: string; op: CodexRateLimitResetOperationView; title: string; says: string }[] = [
    { name: 'reset', op: resetOperation('SUCCEEDED'), title: 'Usage limits reset', says: '1 credit used. Plan usage has been refreshed.' },
    {
      name: 'alreadyRedeemed',
      op: resetOperation('SUCCEEDED', { outcome: 'alreadyRedeemed' }),
      title: 'Usage limits reset',
      says: 'Codex had already applied this reset, so no extra credit was used.',
    },
    { name: 'nothingToReset', op: resetOperation('NOTHING_TO_RESET'), title: 'Nothing to reset', says: 'No credit was used.' },
    { name: 'noCredit', op: resetOperation('NO_CREDIT'), title: 'No reset credit available', says: 'No credit was used.' },
    {
      name: 'a failed refresh after the consume',
      op: resetOperation('REFRESH_FAILED'),
      title: 'Limits reset — usage not refreshed',
      says: "Codex used 1 credit and reset your eligible usage windows, but Orbit couldn't read the updated usage.",
    },
    {
      name: 'a failed refresh after an account change',
      op: resetOperation('REFRESH_FAILED', { outcome: 'alreadyRedeemed', failureCode: 'ACCOUNT_CHANGED' }),
      title: 'Limits reset — usage not refreshed',
      says: "because the runner's Codex account changed",
    },
    {
      name: 'an account change before the consume',
      op: resetOperation('NOT_ATTEMPTED', { failureCode: 'ACCOUNT_CHANGED' }),
      title: 'Codex account changed',
      says: 'No credit was used.',
    },
    {
      name: 'a runner that never picked it up',
      op: resetOperation('NOT_ATTEMPTED', { failureCode: 'CONSUME_EXPIRED' }),
      title: "Reset didn't start",
      says: 'No credit was used.',
    },
    {
      name: 'a lost result',
      op: resetOperation('UNRESOLVED'),
      title: 'Result unknown',
      says: 'A credit may have been used — check the count once usage refreshes.',
    },
  ];
  for (const result of results) {
    it(`draws ${result.name} and announces it once`, async () => {
      const server = new FakeResetApi();
      server.ops.set(result.op.id, result.op);
      remembered({ operationId: result.op.id });
      await mount(resetRunner(new Date()));
      await openUsage();
      await until(result.name, () => panelText().includes(result.title));
      expect(panelText()).toContain(result.says);
      if (result.op.consumeState === 'CONFIRMED' && result.op.refreshState !== 'NOT_REQUIRED') {
        expect(panelText()).not.toContain('No credit was used');
      }
      expect(button('Dismiss')).not.toBeNull();
      expect(button('Use reset credit')).toBeNull();
      await until('the announcement', () => toastText().includes(result.title));
      expect(stored()).toMatchObject({ settledAt: expect.any(String) });
      expect(server.posts()).toHaveLength(0);
    });
  }

  it('keeps a pending reset honest when the runner is offline or its Codex account changed', async () => {
    new FakeResetApi().ops.set('Op1', resetOperation('PENDING'));
    remembered({ operationId: 'Op1' });
    await mount(resetRunner(new Date(), { online: false }));
    await openUsage();
    await until('offline', () =>
      panelText().includes('Waiting for the runner to come back online. No credit has been used yet.'),
    );
    await unmount();

    new FakeResetApi().ops.set('Op1', resetOperation('PENDING'));
    const now = new Date();
    await mount(resetRunner(now, {}, resetBlock(now, { accountFingerprint: OTHER_FINGERPRINT })));
    await openUsage();
    await until('the account change', () =>
      panelText().includes("The runner's Codex account changed, so this reset will stop without using a credit."),
    );
  });
});

describe('the reset entry', () => {
  const at = () => new Date();
  const rules: { name: string; runner: () => CodexResetRunner; reason: string; also?: string }[] = [
    { name: 'the runner is offline', runner: () => resetRunner(at(), { online: false }), reason: 'The runner is offline.' },
    {
      name: 'the snapshot is stale',
      runner: () => {
        const now = at();
        return resetRunner(now, {}, resetBlock(now, { fetchedAt: new Date(now.getTime() - 20 * 60_000).toISOString() }));
      },
      reason: 'Usage is out of date. Waiting for the runner to refresh it.',
      also: 'Updated 20 min ago · out of date',
    },
    {
      name: 'the runner lacks the capability',
      runner: () => resetRunner(at(), { capabilities: [] }),
      reason: 'Update this runner to use reset credits.',
    },
    { name: 'there is no lease', runner: () => resetRunner(at(), { heartbeatLeaseOwner: null }), reason: "The runner hasn't checked in yet." },
    { name: 'the runner is draining', runner: () => resetRunner(at(), { heartbeatDraining: true }), reason: 'The runner is restarting.' },
    {
      name: 'there are no credits',
      runner: () => {
        const now = at();
        return resetRunner(now, {}, resetBlock(now, { rateLimitResetCredits: { availableCount: 0, credits: [] } }));
      },
      reason: 'No reset credits available.',
      also: '0 available',
    },
    {
      name: 'Codex reports no credit summary',
      runner: () => {
        const now = at();
        return resetRunner(now, {}, resetBlock(now, { support: 'CREDITS_UNAVAILABLE', rateLimitResetCredits: null }));
      },
      reason: "Codex isn't reporting reset credits right now.",
      also: 'Count unavailable',
    },
  ];
  for (const rule of rules) {
    it(`is disabled with a named reason when ${rule.name}`, async () => {
      const server = new FakeResetApi();
      await mount(rule.runner());
      await openUsage();
      const use = button('Use reset credit')!;
      expect(use.disabled).toBe(true);
      expect(document.getElementById(use.getAttribute('aria-describedby')!)?.textContent).toBe(rule.reason);
      if (rule.also) expect(panelText()).toContain(rule.also);
      await click(use);
      expect(confirmation()).toBeNull();
      expect(server.posts()).toHaveLength(0);
    });
  }

  it('is not drawn for an unsupported sign-in, an older runner, or a session off the built-in Codex', async () => {
    const now = new Date();
    const cases: [CodexResetRunner, boolean][] = [
      [resetRunner(now, {}, resetBlock(now, { support: 'UNSUPPORTED_AUTH', accountFingerprint: undefined, rateLimitResetCredits: null })), true],
      [resetRunner(now, {}, null), true],
      [resetRunner(now), false],
    ];
    for (const [runner, reset] of cases) {
      const server = new FakeResetApi();
      await mount(runner, reset);
      await openUsage();
      expect(panelText()).toContain('5h limit');
      expect(panelText()).not.toContain('Reset credit');
      expect(server.calls).toHaveLength(0);
      await unmount();
    }
  });

  it('follows a reset already in flight from elsewhere instead of offering a second one', async () => {
    const server = new FakeResetApi();
    server.ops.set('Op5', resetOperation('REFRESHING', { id: 'Op5', clientRequestId: OTHER_REQUEST_ID }));
    await mount(resetRunner(new Date()));
    await openUsage();
    await until('the reset in flight', () => panelText().includes('Limits reset — refreshing usage…'));
    expect(button('Use reset credit')).toBeNull();
    expect(pill().getAttribute('aria-label')).toBe('Plan usage 92%, reset in progress');
    expect(server.posts()).toHaveLength(0);
  });
});
