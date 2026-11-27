// @vitest-environment jsdom
import type { ApprovalTranslation } from '@orbit/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listQuestionApprovals, type ApprovalInfo } from '../api';
import { useQuestionTranslations } from './questionTranslations';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  listQuestionApprovals: vi.fn(),
}));

const translation = (text: string) => ({ lang: 'zh', questions: [{ question: text }] }) as unknown as ApprovalTranslation;
const card = (sessionId: string, toolUseId: string, text: string, status: ApprovalInfo['status'] = 'ALLOWED'): ApprovalInfo => ({
  id: `A-${toolUseId}`, sessionId, toolName: 'AskUserQuestion', input: {}, toolUseId, status,
  createdAt: '2026-11-22T00:00:00Z', translation: translation(text),
});

let root: Root;
let qc: QueryClient;
let shown: ReadonlyMap<string, ApprovalTranslation>;
function Probe({ sessionId, approvals, on }: { sessionId: string | null; approvals: ApprovalInfo[]; on: boolean }): null {
  shown = useQuestionTranslations(sessionId, approvals, on);
  return null;
}
const render = async (sessionId: string | null, approvals: ApprovalInfo[] = [], on = true): Promise<void> => {
  await act(async () => root.render(
    <QueryClientProvider client={qc}><Probe sessionId={sessionId} approvals={approvals} on={on} /></QueryClientProvider>,
  ));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
};
const reads = (id: string): number => vi.mocked(listQuestionApprovals).mock.calls.filter(([sid]) => sid === id).length;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.mocked(listQuestionApprovals).mockImplementation(async (id) => [card(id, `Q-${id}`, `decided in ${id}`)]);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(document.createElement('div'));
});
afterEach(async () => {
  await act(async () => root.unmount());
  qc.clear();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('the translations of decided questions', () => {
  it('are not read again after a later session or translation change', async () => {
    await render('S1');
    expect(reads('S1')).toBe(1);
    expect(shown.get('Q-S1')).toEqual(translation('decided in S1'));

    await render('S2'); // another session, and back
    await render('S1');
    await render('S1', [], false); // translation off, and on again
    await render('S1', [], true);
    await render('S1', [card('S1', 'Q-live', 'raised live', 'PENDING')]); // a live approval
    expect(reads('S1')).toBe(1);
    expect(shown.get('Q-S1')).toEqual(translation('decided in S1'));
    expect(shown.get('Q-live')).toEqual(translation('raised live'));
  });

  it('keep what a live approval added when it leaves the live list', async () => {
    await render('S1');
    await render('S1', [card('S1', 'Q-live', 'raised live', 'PENDING')]);
    await render('S1', []); // decided: it leaves `approvals`
    await render('S2');
    await render('S1');
    expect(shown.get('Q-live')).toEqual(translation('raised live'));
    expect(reads('S1')).toBe(1);
  });

  it('are read once more on a return after the safety minute, which may have missed a decision', async () => {
    await render('S1');
    await render('S2');
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000); });
    await render('S1');
    expect(reads('S1')).toBe(2);
  });

  it('are empty, and not read, while translation is off', async () => {
    await render('S1', [], false);
    expect(reads('S1')).toBe(0);
    expect(shown.size).toBe(0);
  });
});
