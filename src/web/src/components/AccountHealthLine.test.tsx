// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import type { AccountHealthBlock } from '../lib/accountHealth';
import { AccountHealthLine, AccountHealthLoginLine, AccountHealthProviderLine } from './AccountHealthLine';

vi.mock('../api', () => ({ api: vi.fn() }));
const toast = { success: vi.fn(), error: vi.fn() };
vi.mock('../lib/toast', () => ({ useToast: () => toast }));
const apiMock = vi.mocked(api);

const block = (extra: Partial<AccountHealthBlock> = {}): AccountHealthBlock => ({
  id: 'BLOCK1', subjectKey: 'runner:R1:cursor:default', runnerId: 'R1', engine: 'cursor', account: 'default', providerId: null,
  poolId: null, scopeModel: '', kind: 'ACCOUNT_ACTION_REQUIRED', said: 'Add a payment method to continue', trips: 1,
  since: '2026-11-22T17:19:00', nextTrialAt: '2026-11-22T18:19:00', trialRunning: false, line: '', ...extra,
});

let root: Root;
let host: HTMLDivElement;
let qc: QueryClient;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  qc.clear();
  apiMock.mockReset();
  toast.success.mockReset();
});
const render = async (blocks: AccountHealthBlock[]) => {
  apiMock.mockImplementation(async (path: string) => (path === '/account-health' ? { blocks } : {}));
  await act(async () => root.render(
    <QueryClientProvider client={qc}><AccountHealthLine runnerId="R1" engine="cursor" account="default" /></QueryClientProvider>,
  ));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
};

describe('the account row of a blocked account', () => {
  it('says what the provider said, when it began and when it is tried again, with a Check again button', async () => {
    await render([block()]);
    const text = host.querySelector('.re-health-text')!.textContent!;
    expect(text).toContain('Needs action · Cursor said "Add a payment method to continue"');
    expect(text).toContain('since Nov 22, 17:19');
    expect(text).toContain('tried again at');
    expect([...host.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Check again']);
  });

  it('reads a breaker block as a guess that counts the runs', async () => {
    await render([block({ kind: 'UNCLASSIFIED_ADMISSION', said: null, trips: 3 })]);
    expect(host.querySelector('.re-health-text')!.textContent).toContain('Not used for now · failed to start 4 runs');
  });

  it('draws nothing for an account that is not blocked, or another runner\'s', async () => {
    await render([block({ runnerId: 'R2' }), block({ scopeModel: 'gpt-x' })]);
    expect(host.querySelector('.re-health')).toBeNull();
  });

  it('Check again posts to the row and reads the blocks again', async () => {
    await render([block()]);
    apiMock.mockClear();
    await act(async () => host.querySelector<HTMLButtonElement>('button')!.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(apiMock).toHaveBeenCalledWith('/account-health/BLOCK1/check', { method: 'POST' });
    expect(apiMock.mock.calls.some(([path]) => path === '/account-health')).toBe(true);
    expect(toast.success).toHaveBeenCalled();
  });

  it('draws a blocked key and a blocked pool login with the server\'s own sentence and Check again', async () => {
    const key = block({ id: 'KEYBLK', subjectKey: 'provider:P1', runnerId: null, engine: null, account: null, providerId: 'P1', line: 'Needs action · Anthropic said "Your credit balance is too low"' });
    const login = block({ id: 'LOGINBLK', subjectKey: 'pool-login:POOL:acc1', runnerId: null, engine: null, account: 'acc1', poolId: 'POOL', kind: 'CREDENTIAL_REFUSED', said: 'Session expired', line: 'Needs action · team-pool said "Session expired"' });
    apiMock.mockImplementation(async (path: string) => (path === '/account-health' ? { blocks: [key, login] } : {}));
    await act(async () => root.render(
      <QueryClientProvider client={qc}>
        <div id="k"><AccountHealthProviderLine providerId="P1" /></div>
        <div id="l"><AccountHealthLoginLine poolId="POOL" accountId="acc1" /></div>
        <div id="other"><AccountHealthProviderLine providerId="P2" /></div>
      </QueryClientProvider>,
    ));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(host.querySelector('#k .re-health-text')!.textContent).toContain('Anthropic said "Your credit balance is too low"');
    expect(host.querySelector('#l .re-health-text')!.textContent).toContain('team-pool said "Session expired"');
    expect(host.querySelector('#other .re-health')).toBeNull();
    apiMock.mockClear();
    await act(async () => host.querySelector<HTMLButtonElement>('#k button')!.click());
    expect(apiMock).toHaveBeenCalledWith('/account-health/KEYBLK/check', { method: 'POST' });
  });
});
