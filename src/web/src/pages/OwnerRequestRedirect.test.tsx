// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OwnerRequestRedirect } from './OwnerRequestRedirect';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REQUEST = '34vReqAAAAAAAAAAAAAAA';
const SESSION = '34vSesAAAAAAAAAAAAAAA';

let root: Root | null = null;
let host: HTMLElement;

function Where() {
  const { pathname, search } = useLocation();
  return <output>{pathname + search}</output>;
}

async function open(url: string): Promise<string> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[url]}>
          <Routes>
            <Route path="/waiting" element={<OwnerRequestRedirect />} />
            <Route path="*" element={<Where />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
  return host.querySelector('output')?.textContent ?? '';
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  apiMock.mockReset();
});

describe('the old Waiting on you address', () => {
  it('opens the session that filed the request it names', async () => {
    apiMock.mockResolvedValue({ id: REQUEST, askedBySessionId: SESSION });
    expect(await open(`/waiting?request=${REQUEST}`)).toBe(`/sessions/${SESSION}`);
    expect(apiMock).toHaveBeenCalledWith(`/owner-requests/${REQUEST}`);
  });

  it('lands on the session list when it names no request', async () => {
    expect(await open('/waiting?tab=declined')).toBe('/');
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('lands on the session list when the request cannot be read', async () => {
    apiMock.mockRejectedValue(new Error('404'));
    expect(await open(`/waiting?request=${REQUEST}`)).toBe('/');
  });
});
