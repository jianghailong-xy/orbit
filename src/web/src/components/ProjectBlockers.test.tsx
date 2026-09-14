// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProjectBlockersCard,
  type ProjectBlocker,
  type ProjectBlockers,
} from './ProjectBlockers';

/**
 * The Blockers card on the project page (mock 6): what each open blocker says, and resolving one
 * with a reason. Static renders for what is drawn; jsdom for typing the reason and pressing
 * Resolve all the way through to the (mocked) `api()` call.
 */

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

const PROJECT_ID = '34ODoUKJGEsfbgcJDGS4q';
const NOW = Date.parse('2026-09-13T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

const SCOPE_ACTION =
  '这份交付改了它自己的声明里没提过的文件。请看 detail.paths 列出的那些改动，'
  + '决定接受、退回还是让它拆开；在你决定之前不要合并。';

function blocker(over: Partial<ProjectBlocker> = {}): ProjectBlocker {
  return {
    id: '4BLRNxGq7TOI1lIiOh4g1j',
    kind: 'AWAITING_USER_APPROVAL',
    owner: 'USER',
    severity: 'CRITICAL',
    requiredAction: SCOPE_ACTION,
    subjectType: 'TASK',
    subjectId: '34OEE9Ftd7jJEDjbB347f',
    subjectTitle: '阶段2b 作业完成通知 + resume 时注入作业状态',
    criterionOrdinal: 3,
    criterionRevision: 1,
    detail: {
      reason: 'OUTSIDE_DECLARED_SCOPE',
      source: 'CRITERION_UNLANDED',
      paths: [
        'src/apiserver/src/runner-api/background-jobs-context.ts',
        'src/apiserver/src/runner-api/runner-api.controller.ts',
        'src/runner-go/background_jobs.go',
      ],
    },
    firstSeenAt: new Date(NOW - 6 * 24 * HOUR).toISOString(),
    resolvedAt: null,
    resolvedBy: null,
    resolutionNote: null,
    ...over,
  };
}

const STANDARD = blocker({
  id: '6fWujE4NBkVyzMWkL975oc',
  kind: 'POLICY_MANUAL_HOLD',
  requiredAction: '这份工作声明的那条验收标准在它开工之后被改过。请确认按今天的措辞它算不算通过。',
  subjectTitle: '阶段0 止血：warm 淘汰避让 + TTL 续期',
  criterionOrdinal: 5,
  criterionRevision: 2,
  detail: { reason: 'ACCEPTANCE_STANDARD_MOVED', source: 'CRITERION_UNLANDED', paths: [] },
  firstSeenAt: new Date(NOW - 4 * HOUR).toISOString(),
});

const AUTO_RESOLVED = blocker({
  id: '3mZLAZL3OvQix77hxsBQYH',
  resolvedAt: '2026-09-07T11:46:00.000Z',
  resolvedBy: 'AUTO',
  resolutionNote: 'the work landed on main',
});

function standing(over: Partial<ProjectBlockers> = {}): ProjectBlockers {
  return { open: [blocker(), STANDARD], resolved: [AUTO_RESOLVED], resolvedCount: 3, ...over };
}

function client(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

function paint(blockers: ProjectBlockers): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={client()}>
      <ProjectBlockersCard projectId={PROJECT_ID} blockers={blockers} now={NOW} />
    </QueryClientProvider>,
  );
}

describe('ProjectBlockersCard — what each blocker says', () => {
  it('names each open blocker’s kind, the work it is about, what it asks and its files', () => {
    const html = paint(standing());

    expect(html).toContain('Blockers');
    expect(html).toContain('2 open');

    expect(html).toContain('Needs your approval');
    expect(html).toContain('Changed files it didn’t declare');
    expect(html).toContain('阶段2b 作业完成通知 + resume 时注入作业状态');
    expect(html).toContain(SCOPE_ACTION);
    // The first file whole, the next by name in the same directory, the rest counted.
    expect(html).toContain(
      'src/apiserver/src/runner-api/background-jobs-context.ts · runner-api.controller.ts · +1',
    );
    expect(html).toContain('since 6d');

    expect(html).toContain('Standard moved');
    expect(html).toContain('Its acceptance criterion changed after it started');
    expect(html).toContain('阶段0 止血：warm 淘汰避让 + TTL 续期 · criterion 5 is now revision 2');
    expect(html).toContain('since 4h');

    expect(html.match(/Resolve…/g)).toHaveLength(2);
  });

  it('names a blocker of any other kind by its kind and who has to act', () => {
    const html = paint(standing({
      open: [blocker({
        kind: 'COORDINATOR_NO_PROGRESS',
        subjectType: 'PROJECT',
        subjectTitle: null,
        requiredAction: 'The coordinator stopped after 7 decisions without progress.',
        detail: {},
      })],
      resolved: [],
      resolvedCount: 0,
    }));
    expect(html).toContain('Needs you');
    expect(html).toContain('Coordinator no progress');
    expect(html).toContain('The coordinator stopped after 7 decisions without progress.');
    expect(html).not.toContain('resolved');
  });

  it('says how many were resolved and how the latest one ended', () => {
    const html = paint(standing());
    expect(html).toContain('3 resolved');
    expect(html).toContain('Auto-resolved — the work landed on main (');
  });

  it('draws nothing when nothing is open', () => {
    expect(paint(standing({ open: [] }))).toBe('');
  });
});

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  // The reason field grows with its text, which antd measures with a ResizeObserver jsdom lacks.
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
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
});

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  container?.remove();
  container = null;
  document.body.innerHTML = '';
  apiMock.mockReset();
  vi.unstubAllGlobals();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

async function mount(ui: JSX.Element): Promise<void> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const node = document.createElement('div');
  document.body.appendChild(node);
  container = node;
  const next = createRoot(node);
  root = next;
  await act(async () => next.render(ui));
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function button(label: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => (candidate.textContent ?? '').trim() === label);
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function type(field: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function openDialog(): Promise<HTMLElement> {
  await mount(
    <QueryClientProvider client={client()}>
      <ProjectBlockersCard projectId={PROJECT_ID} blockers={standing()} now={NOW} />
    </QueryClientProvider>,
  );
  const first = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
    .filter((candidate) => (candidate.textContent ?? '').trim() === 'Resolve…')[0];
  expect(first).toBeDefined();
  await click(first!);
  await settle();
  const dialog = document.body.querySelector<HTMLElement>('.ant-modal');
  expect(dialog).not.toBeNull();
  return dialog!;
}

describe('ProjectBlockersCard — resolving one', () => {
  it('asks why it is no longer blocking, and sends nothing without an answer', async () => {
    const dialog = await openDialog();
    const text = dialog.textContent ?? '';
    expect(text).toContain('Resolve this blocker');
    expect(text).toContain('Changed files it didn’t declare · 阶段2b 作业完成通知 + resume 时注入作业状态');
    expect(text).toContain('Why is it no longer blocking?');
    expect(text).toContain('Recorded with your name and this reason');

    const resolve = button('Resolve');
    expect(resolve?.disabled).toBe(true);
    await type(dialog.querySelector('textarea')!, '   ');
    expect(button('Resolve')?.disabled).toBe(true);
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('sends the reason to the blocker’s resolve door', async () => {
    apiMock.mockResolvedValue({ ...blocker(), resolvedBy: 'USER', resolutionNote: 'accepted' });
    const dialog = await openDialog();
    const reason = '已在 09-07 合入 main，判据 3 已满足；这 3 个文件是注入作业状态的必要改动，接受。';
    await type(dialog.querySelector('textarea')!, reason);
    const resolve = button('Resolve');
    expect(resolve?.disabled).toBe(false);
    await click(resolve!);
    await settle();

    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(apiMock).toHaveBeenCalledWith(
      `/projects/${PROJECT_ID}/blockers/4BLRNxGq7TOI1lIiOh4g1j/resolve`,
      { method: 'POST', body: { reason } },
    );
  });

  it('keeps the dialog open and says why when the resolution is refused', async () => {
    apiMock.mockRejectedValue(new Error('BLOCKER_ALREADY_RESOLVED: this blocker is already resolved'));
    const dialog = await openDialog();
    await type(dialog.querySelector('textarea')!, 'closing it');
    await click(button('Resolve')!);
    await settle();

    const text = document.body.querySelector('.ant-modal')?.textContent ?? '';
    expect(text).toContain('That resolution was not recorded');
    expect(text).toContain('BLOCKER_ALREADY_RESOLVED: this blocker is already resolved');
  });
});
