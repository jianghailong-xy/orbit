// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { ProjectSessionsDoneCard } from './ProjectSettlementCard';
import type { ProjectDoneDocument } from '../lib/projectDone';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../api', () => ({ api: vi.fn() }));
const project: ProjectDoneDocument = {
  id: 'p1', title: 'Session Recap', status: 'DONE', doneBy: 'DERIVED',
  doneAt: '2026-11-10T12:00:00Z',
  derivedDone: { status: 'DONE', done: true, withheld: [], confirmation: 'CONFIRMED', criteria: [],
    counts: { criteria: 6, met: 6, landed: 6, onMain: 6,
      byReason: { IN_FLIGHT: 0, ON_PROJECT_BRANCH: 0, NOTHING_TO_LAND: 0, NO_RECEIPT: 0, CODELESS: 0 } } },
};
const confirmation = { state: 'CONFIRMED', confirmed: true, currentVersion: { digest: 'd', material: [] },
  confirmation: { criteriaDigest: 'd', criteriaMaterial: [], confirmedAt: '2026-10-02T12:00:00Z', confirmedById: 'owner' } };
let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); vi.resetAllMocks(); });
async function mount(doc = project) {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  notifyManager.setScheduler((cb) => cb());
  await act(async () => { root.render(<QueryClientProvider client={qc}><ProjectSessionsDoneCard projectId="p1" project={doc} /></QueryClientProvider>); });
  dispose = () => { act(() => root.unmount()); qc.clear(); host.remove(); };
  return host;
}
describe('DERIVED done receipt on the sessions page', () => {
  it('names the standing confirmation date and calls the existing authenticated owner Reopen door', async () => {
    vi.mocked(api).mockImplementation(async (path) => path.endsWith('/acceptance/confirmation') ? confirmation : { id: 'p1' });
    const host = await mount();
    expect(host.textContent).toContain('From the criteria you confirmed on Oct 2. Not right? Reopen it.');
    expect(host.textContent).not.toContain('Nov 10');
    const button = host.querySelector('button')!;
    expect(button.textContent).toBe('Reopen project');
    await act(async () => button.click());
    expect(api).toHaveBeenCalledWith('/projects/p1', { method: 'PATCH', body: { status: 'OPEN' } });
    // This owner-authenticated route calls reopenRecordOfPress, covered over HTTP in project-owner-reopen.pg.spec.ts.
    expect(api).toHaveBeenCalledTimes(3); // confirmation, press, invalidated confirmation
  });
  it('leaves the OWNER-recorded card unchanged', async () => {
    const host = await mount({ ...project, doneBy: 'OWNER' });
    expect(host.textContent).toContain('recorded by you');
    expect(host.textContent).not.toContain('From the criteria');
    expect(host.querySelector('button')).toBeNull();
    expect(api).not.toHaveBeenCalled();
  });
});
