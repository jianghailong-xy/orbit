// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { MANAGED_RUNNER_COPY, managedRunnerDisplay, type ManagedRunnerDisplay, type ManagedRunnerStatus } from '@orbit/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The managed runner's state as the web draws it, from the server state samples every client is
 * rendered from (src/shared/src/managed-runner-states.fixture.json — the apiserver derives each
 * status in it from its own stored inputs). Each status goes through the web's own reading of it,
 * and what reaches the page is held to the words and actions the fixture gives that state.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
}));
const toast = { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() };
vi.mock('../lib/toast', () => ({ useToast: () => toast }));

const { api, ApiError } = await import('../api');
const apiMock = vi.mocked(api);
const { ManagedRunnerNotice } = await import('./ManagedRunnerNotice');
const { encodeId } = await import('../lib/idCodec');

const fixture = JSON.parse(
  readFileSync(resolve(process.cwd(), '../shared/src/managed-runner-states.fixture.json'), 'utf8'),
) as { states: { name: string; status: ManagedRunnerStatus; display: ManagedRunnerDisplay | null }[] };
const state = (name: string) => fixture.states.find((c) => c.name === name)!.status;

let container: HTMLDivElement;
let root: Root | null = null;
let client: QueryClient;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  apiMock.mockReset();
  for (const fn of Object.values(toast)) fn.mockReset();
});

afterEach(async () => {
  if (root) {
    const mounted = root;
    root = null;
    await act(async () => mounted.unmount());
  }
  container?.remove();
});

async function render(status: ManagedRunnerStatus): Promise<void> {
  if (root) {
    const mounted = root;
    root = null;
    await act(async () => mounted.unmount());
    container.remove();
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const display = managedRunnerDisplay(status)!;
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ManagedRunnerNotice managed={{ status, display }} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

const notice = () => container.querySelector<HTMLElement>('.managed-runner-notice')!;
const button = (label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label);
async function press(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('every server state sample, drawn', () => {
  it('says each state in the fixture’s words, with exactly the actions it allows', async () => {
    const drawn = fixture.states.filter(({ display }) => display);
    expect(drawn.length).toBeGreaterThan(10);
    for (const { name, status, display } of drawn) {
      await render(status);
      const expected = display!;
      expect(notice().dataset.kind, name).toBe(expected.kind);
      expect(notice().querySelector('.managed-runner-notice-title')?.textContent, name).toBe(expected.title);
      expect(notice().querySelector('.managed-runner-notice-detail')?.textContent, name).toBe(expected.detail);
      expect(!!button(MANAGED_RUNNER_COPY.retry), `${name}: Retry`).toBe(expected.retry);
      expect(!!button(MANAGED_RUNNER_COPY.ensure), `${name}: Set up`).toBe(expected.ensure);
      const signIn = [...container.querySelectorAll('a')].find((a) => a.textContent === MANAGED_RUNNER_COPY.signIn);
      expect(!!signIn, `${name}: Open Infrastructure`).toBe(expected.signIn);
      if (signIn) expect(signIn.getAttribute('href')).toBe(`/infrastructure?runner=${encodeId(status.runnerId!)}`);
      // A state that moves by itself shows it is moving; none of them is an endless spinner on its own.
      expect(!!notice().querySelector('.orbit-spinner'), `${name}: moving`).toBe(expected.moving);
      // No state of a managed runner points anybody at registering a machine.
      expect(container.textContent?.toLowerCase(), name).not.toContain('register');
    }
  });

  it('draws the seven states the clients were asked for, among them a failure with Retry', async () => {
    for (const [name, title] of [
      ['preparing: provisioning, retrying a transient error', 'Preparing your managed runner'],
      ['waiting for capacity before the first start', 'Waiting for capacity'],
      ['available', 'Managed runner ready'],
      ['sleeping', 'Managed runner asleep'],
      ['waking: a message asked the sleeping runner', 'Waking your managed runner'],
      ['failed: retryable', 'Managed runner failed'],
      ['removed', 'Managed runner removed'],
    ] as const) {
      await render(state(name));
      expect(notice().querySelector('.managed-runner-notice-title')?.textContent, name).toBe(title);
    }
    expect(button(MANAGED_RUNNER_COPY.retry)).toBeUndefined();
    await render(state('failed: retryable'));
    expect(button(MANAGED_RUNNER_COPY.retry)).toBeDefined();
  });

  it('shows a reason it has never heard of by the server’s own sentence', async () => {
    await render(state('failed: a reason this client does not know'));
    expect(notice().querySelector('.managed-runner-notice-detail')?.textContent).toBe('A newer server says why in its own words.');
    expect(button(MANAGED_RUNNER_COPY.retry)).toBeUndefined();
  });
});

describe('the actions call the server', () => {
  it('Retry posts the retry with the revision it read and a fresh idempotency key, and shows the answer', async () => {
    const failed = state('failed: retryable');
    const answer = { ...state('preparing: requested'), revision: failed.revision + 1 };
    apiMock.mockImplementation((async (path: string) => {
      if (path === '/managed-runner/retry') return answer;
      throw new Error(`unexpected ${path}`);
    }) as typeof api);
    await render(failed);
    await press(button(MANAGED_RUNNER_COPY.retry)!);

    expect(apiMock).toHaveBeenCalledTimes(1);
    const [path, options] = apiMock.mock.calls[0] as [string, { method: string; body: { idempotencyKey: string; revision: number } }];
    expect(path).toBe('/managed-runner/retry');
    expect(options.method).toBe('POST');
    expect(options.body.revision).toBe(failed.revision);
    expect(options.body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(client.getQueryData(['managed-runner'])).toEqual(answer);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('a refused Retry says the server’s reason and reads the status again', async () => {
    apiMock.mockImplementation((async (path: string) => {
      if (path === '/managed-runner/retry') {
        throw new ApiError('The managed runner moved on: read it again.', 409, 'MANAGED_RUNNER_REVISION_CONFLICT');
      }
      throw new Error(`unexpected ${path}`);
    }) as typeof api);
    await render(state('failed: retryable'));
    await press(button(MANAGED_RUNNER_COPY.retry)!);
    expect(toast.error).toHaveBeenCalledWith("Couldn't retry the managed runner", 'The managed runner moved on: read it again.');
  });

  it('Set up posts the ensure, with an idempotency key and nothing else', async () => {
    apiMock.mockImplementation((async (path: string) => {
      if (path === '/managed-runner/ensure') return state('preparing: requested');
      throw new Error(`unexpected ${path}`);
    }) as typeof api);
    await render(state('no mapping, offered'));
    await press(button(MANAGED_RUNNER_COPY.ensure)!);

    const [path, options] = apiMock.mock.calls[0] as [string, { method: string; body: Record<string, unknown> }];
    expect(path).toBe('/managed-runner/ensure');
    expect(options.method).toBe('POST');
    expect(Object.keys(options.body)).toEqual(['idempotencyKey']);
    expect(client.getQueryData(['managed-runner'])).toEqual(state('preparing: requested'));
  });

  it('an account the server gives none to is told so, and offered no Set up', async () => {
    await render(state('no mapping, account not eligible'));
    expect(notice().querySelector('.managed-runner-notice-detail')?.textContent).toBe(
      state('no mapping, account not eligible').reason!.message,
    );
    expect(state('no mapping, account not eligible').reason!.code).toBe('MANAGED_RUNNER_NOT_ELIGIBLE');
    expect(button(MANAGED_RUNNER_COPY.ensure)).toBeUndefined();
  });
});
