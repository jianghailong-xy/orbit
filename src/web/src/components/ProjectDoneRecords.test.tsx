// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { ProjectDoneCheck } from '@orbit/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, fetchAttachmentObjectUrl, uploadAttachment } from '../api';
import { ConfirmCriterionDialog } from './ConfirmCriterionDialog';
import { AcceptanceCriteriaCard, type AcceptanceCriterionItem } from './ProjectAcceptanceCard';
import { ProjectDoneCard } from './ProjectSettlementCard';
import {
  CONFIRM_SHEET_ATTACH,
  CONFIRM_SHEET_CONFIRM,
  CONFIRM_SHEET_DROP,
  CONFIRM_SHEET_NOT_AN_IMAGE,
  CONFIRM_SHEET_REMOVE,
  CRITERION_HIDE_CHANGES,
  CRITERION_WHAT_CHANGED,
  CRITERION_WORDING_NOT_KEPT,
  NON_CODE_MARKED_BY_COORDINATOR,
  confirmationLine,
  movedByLine,
  nonCodeReasonLine,
  type CriterionConfirmationStanding,
  type CriterionConfirmationView,
  type ProjectDoneDocument,
} from '../lib/projectDone';

/**
 * The four details the follow-up boards draw on top of the first pass: the non-code mark's reason
 * (01 B), the move record on both projects (02 G/I), the Confirm sheet's screenshot (03 ④ D) and
 * the stale row's What changed (03 J).
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: vi.fn(async () => ({})),
    uploadAttachment: vi.fn(async () => ({ id: 'shot-1' })),
    fetchAttachmentObjectUrl: vi.fn(async (id: string) => `blob:${id}`),
  };
});

const PROJECT = '34vfv0OR79IojfYntb8SA';
const FOLLOW_UP = '34w1followUpProject00';
const ORIGIN = '34w1originProject0000';
const byReason = { IN_FLIGHT: 0, ON_PROJECT_BRANCH: 0, NOTHING_TO_LAND: 0, NO_RECEIPT: 0, NO_BRANCH: 0, CODELESS: 0 };

function check(): ProjectDoneCheck {
  return { criteria: [], tasks: [], ownerItems: [], jobs: [], criteriaDigest: 'd', stateDigest: 's', nonCode: true, findings: [] };
}

/** CBAI after the move: three criteria, all met, criterion 4 gone to the follow-up. */
function afterMove(over: Partial<ProjectDoneDocument> = {}): ProjectDoneDocument {
  const items = ['Criterion 1', 'Criterion 2 (91 tasks)', 'Criterion 3 (2 tasks)']
    .map((text, index) => ({ id: `c${index + 1}`, key: `k${index + 1}`, ordinal: index + 1, text, revision: 1 }));
  return {
    id: PROJECT,
    title: 'CBAI Phase 0',
    status: 'OPEN',
    acceptanceCriteriaItems: items,
    nonCode: true,
    nonCodeSetBy: 'COORDINATOR',
    nonCodeSetAt: '2026-11-11T10:20:00.000Z',
    nonCodeReason: 'All work is documents and vendor accounts; no repository.',
    criteriaMovedOut: [{
      criterionKey: 'k4', definitionId: 'c4', ordinal: 4, text: 'External prerequisites settled',
      toProjectId: FOLLOW_UP, toProjectTitle: 'CBAI Phase 0 · follow-up', movedAt: '2026-11-11T11:40:00.000Z',
    }],
    derivedDone: {
      status: 'OPEN', done: false, withheld: [], confirmation: 'CONFIRMED', nonCode: true,
      criteria: items.map((item) => ({ definitionId: item.id, satisfied: true, landing: 'UNKNOWN', landingReason: null })),
      counts: { criteria: 3, met: 3, landed: 0, onMain: 0, byReason },
    },
    ...over,
  };
}

const confirmedAt = '2026-11-09T08:02:00.000Z';
function view(over: Partial<CriterionConfirmationView> = {}): CriterionConfirmationView {
  return {
    id: 'v1', revision: 1, confirmerKind: 'OWNER', outcome: 'CONFIRMED', sessionId: null, checkTaskId: null,
    note: 'Aliyun SMS template SMS_4821 shows Approved.', attachmentIds: [], at: confirmedAt,
    criterionText: 'The privacy policy is published at /privacy.', criterionVerificationMethod: 'Open /privacy.', ...over,
  };
}
function standing(over: Partial<CriterionConfirmationStanding>): CriterionConfirmationStanding {
  return { state: 'UNCONFIRMED', current: null, stale: false, checkRunning: null, ...over };
}
const row = (ordinal: number, over: Partial<AcceptanceCriterionItem>): AcceptanceCriterionItem => ({
  id: `r${ordinal}`, ordinal, text: `Criterion ${ordinal}`, revision: 1, verificationMethod: 'Open /privacy.',
  satisfiedBy: 'CONFIRMATION', satisfied: false, unmet: [{ clause: 'NOT_CONFIRMED', heldUpBy: [] }], ...over,
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  vi.mocked(api).mockClear();
  vi.mocked(uploadAttachment).mockClear();
  vi.mocked(fetchAttachmentObjectUrl).mockClear();
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:preview');
  globalThis.URL.revokeObjectURL = vi.fn();
  // The sheet's Textarea sizes itself with one; jsdom has none.
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
});

async function mount(element: React.ReactElement) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
        <MemoryRouter>{element}</MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return host;
}
const settle = async () => { for (let n = 0; n < 5; n += 1) await act(async () => { await Promise.resolve(); }); };
const button = (label: string): HTMLButtonElement => {
  const found = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label);
  if (!found) throw new Error(`no button ${label}`);
  return found as HTMLButtonElement;
};

describe('board 01 B — the non-code mark\'s reason', () => {
  it('the done card banner quotes it under who and when', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter><ProjectDoneCard project={afterMove()} doneCheck={check()} onRecordDone={() => {}} /></MemoryRouter>,
    );
    expect(html).toContain(`${NON_CODE_MARKED_BY_COORDINATOR} · Nov 11`);
    expect(html).toContain('<span class="project-done-non-code-reason">“All work is documents and vendor accounts; no repository.”</span>');
  });

  it('is only drawn for a marked project with a reason', () => {
    expect(nonCodeReasonLine({ nonCode: true, nonCodeReason: '  ' })).toBeNull();
    expect(nonCodeReasonLine({ nonCode: false, nonCodeReason: 'stale reason' })).toBeNull();
    expect(nonCodeReasonLine({ nonCode: true, nonCodeReason: null })).toBeNull();
  });
});

describe('board 02 G/I — the move record', () => {
  it('the source\'s done card says where criterion 4 went, by you and when, with a link', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter><ProjectDoneCard project={afterMove()} doneCheck={check()} onRecordDone={() => {}} /></MemoryRouter>,
    );
    expect(html).toMatch(new RegExp(
      `Criterion 4 moved to <a [^>]*href="/projects/${FOLLOW_UP}"[^>]*>CBAI Phase 0 · follow-up</a> by you · Nov 11, \\d\\d:40`,
      'u',
    ));
    expect(html).toContain('>Record as done<');
  });

  it('the source\'s criteria card lists it too; the destination\'s row says where it came from', () => {
    const moved = afterMove().criteriaMovedOut!;
    const source = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <AcceptanceCriteriaCard criteria={[row(1, { satisfiedBy: 'TASKS', satisfied: true, unmet: [] })]} movedOut={moved} integrationRef={null} projectId={PROJECT} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(source).toContain(`Criterion 4 moved to <a`);
    const destination = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <AcceptanceCriteriaCard
            integrationRef={null}
            projectId={FOLLOW_UP}
            criteria={[row(1, {
              text: 'External prerequisites settled', satisfiedBy: 'TASKS',
              movedFrom: { fromProjectId: ORIGIN, fromProjectTitle: 'CBAI Phase 0', movedAt: '2026-11-11T11:40:00.000Z' },
            })]}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(destination).toMatch(new RegExp(
      `Moved from <a [^>]*href="/projects/${ORIGIN}"[^>]*>CBAI Phase 0</a> by you · Nov 11<`, 'u',
    ));
    // A public page links nowhere: no move record on it.
    const shared = renderToStaticMarkup(
      <AcceptanceCriteriaCard integrationRef={null} movedOut={moved}
        criteria={[row(1, { satisfiedBy: 'TASKS', movedFrom: { fromProjectId: ORIGIN, fromProjectTitle: 'CBAI', movedAt: confirmedAt } })]} />,
    );
    expect(shared).not.toContain('moved to');
    expect(shared).not.toContain('Moved from');
  });

  it('an older record with no number still reads', () => {
    expect(movedByLine('2026-11-11T11:40:00.000Z', () => 'Nov 11')).toBe('by you · Nov 11');
  });
});

describe('board 03 — the Confirm sheet\'s screenshot', () => {
  const subject = { projectId: PROJECT, criterionId: 'r6', ordinal: 6, text: 'ICP filing is approved for cbai.example.cn.', revision: 2 };

  it('uploads a picked image, previews it, and sends its id with the confirmation', async () => {
    await mount(<ConfirmCriterionDialog subject={subject} open onClose={() => {}} />);
    expect(document.body.textContent).toContain(CONFIRM_SHEET_DROP);
    const input = document.querySelector<HTMLInputElement>('[data-testid="confirm-criterion-file"]')!;
    const file = new File(['png'], 'icp.png', { type: 'image/png' });
    await act(async () => {
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    expect(uploadAttachment).toHaveBeenCalledWith(file);
    expect(document.querySelector('.confirm-criterion-shot img')?.getAttribute('src')).toBe('blob:preview');
    expect(button(CONFIRM_SHEET_REMOVE)).toBeTruthy();
    await act(async () => { button(CONFIRM_SHEET_CONFIRM).click(); });
    await settle();
    expect(api).toHaveBeenCalledWith(
      `/projects/${PROJECT}/criteria/r6/confirmations`,
      { method: 'POST', body: { revision: 2, attachmentIds: ['shot-1'] } },
    );
  });

  it('refuses a file that is not an image without uploading it; Remove drops a picked one', async () => {
    await mount(<ConfirmCriterionDialog subject={subject} open onClose={() => {}} />);
    const input = document.querySelector<HTMLInputElement>('[data-testid="confirm-criterion-file"]')!;
    await act(async () => {
      Object.defineProperty(input, 'files', { value: [new File(['x'], 'notes.txt', { type: 'text/plain' })], configurable: true });
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(uploadAttachment).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(CONFIRM_SHEET_NOT_AN_IMAGE);
    await act(async () => {
      Object.defineProperty(input, 'files', { value: [new File(['png'], 'a.png', { type: 'image/png' })], configurable: true });
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    await act(async () => { button(CONFIRM_SHEET_REMOVE).click(); });
    expect(button(CONFIRM_SHEET_ATTACH)).toBeTruthy();
    await act(async () => { button(CONFIRM_SHEET_CONFIRM).click(); });
    await settle();
    expect(api).toHaveBeenCalledWith(`/projects/${PROJECT}/criteria/r6/confirmations`, { method: 'POST', body: { revision: 2 } });
  });

  it('the confirmer row shows the screenshot it was given with, and the done card counts it', async () => {
    await mount(
      <AcceptanceCriteriaCard integrationRef={null} projectId={PROJECT} criteria={[row(3, {
        satisfied: true, unmet: [], confirmation: standing({ state: 'CONFIRMED', current: view({ revision: 1, attachmentIds: ['shot-1'] }) }),
      })]} />,
    );
    await settle();
    expect(fetchAttachmentObjectUrl).toHaveBeenCalledWith('shot-1');
    const shot = host.querySelector<HTMLAnchorElement>('.acceptance-confirmation-shot')!;
    expect(shot.getAttribute('href')).toBe('blob:shot-1');
    expect(shot.querySelector('img')?.getAttribute('src')).toBe('blob:shot-1');
    expect(host.textContent).toContain('1 screenshot');
    expect(confirmationLine(view({ attachmentIds: ['shot-1'] }))).toBe(
      'Confirmed by you · Nov 9 · “Aliyun SMS template SMS_4821 shows Approved.” · 1 screenshot',
    );
  });
});

describe('board 03 J — a stale row\'s What changed', () => {
  it('shows the confirmed wording beside the current one, and folds away', async () => {
    await mount(
      <AcceptanceCriteriaCard integrationRef={null} projectId={PROJECT} criteria={[row(8, {
        revision: 2, text: 'The privacy policy is published at /privacy and names the SMS vendor.',
        confirmation: standing({ state: 'STALE', stale: true, current: view() }),
      })]} />,
    );
    expect(host.querySelector('.acceptance-what-changed')).toBeNull();
    await act(async () => { button(CRITERION_WHAT_CHANGED).click(); });
    const panel = host.querySelector('.acceptance-what-changed')!;
    expect(panel.querySelector('.is-then')!.textContent).toBe('Confirmed · revision 1The privacy policy is published at /privacy.');
    expect(panel.querySelector('.is-now')!.textContent).toBe('Now · revision 2The privacy policy is published at /privacy and names the SMS vendor.');
    await act(async () => { button(CRITERION_HIDE_CHANGES).click(); });
    expect(host.querySelector('.acceptance-what-changed')).toBeNull();
  });

  it('names a change of how it is checked, and says so when the confirmed wording was not kept', async () => {
    await mount(
      <AcceptanceCriteriaCard integrationRef={null} projectId={PROJECT} criteria={[
        row(1, { revision: 2, verificationMethod: 'Open /privacy on the live site.', text: 'The privacy policy is published at /privacy.', confirmation: standing({ state: 'STALE', stale: true, current: view() }) }),
        row(2, { revision: 3, confirmation: standing({ state: 'STALE', stale: true, current: view({ id: 'v2', criterionText: null, criterionVerificationMethod: null }) }) }),
      ]} />,
    );
    for (const press of Array.from(document.querySelectorAll('button')).filter((b) => b.textContent === CRITERION_WHAT_CHANGED)) {
      await act(async () => { press.click(); });
    }
    const [method, missing] = Array.from(host.querySelectorAll('.acceptance-what-changed'));
    expect(method.querySelector('.is-then .acceptance-what-changed-method')!.textContent).toBe('How it’s checked: Open /privacy.');
    expect(method.querySelector('.is-now .acceptance-what-changed-method')!.textContent).toBe('How it’s checked: Open /privacy on the live site.');
    expect(missing.querySelector('.is-then')!.textContent).toContain(CRITERION_WORDING_NOT_KEPT);
  });

  it('is not offered on a row that is not stale', () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <AcceptanceCriteriaCard integrationRef={null} projectId={PROJECT} criteria={[row(5, { confirmation: standing({}) })]} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(html).not.toContain(CRITERION_WHAT_CHANGED);
  });
});
