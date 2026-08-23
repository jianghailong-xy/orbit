import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { TaskAttributionBody, TaskAttributionCard } from './TaskAttributionCard';
import { orderCrossings, publicIdOf, type TaskAttribution } from '../lib/attribution';

// The card fetches its own read, so the stub keeps an accidental live call visible as a failure
// rather than a hang. A static render never dispatches one — react-query subscribes in an effect —
// which is why every state below is seeded into the cache.
vi.mock('../api', () => ({ api: vi.fn(() => new Promise(() => {})) }));

const TASK = '0195c0de-0000-7000-8000-0000000000a1';
const PROJECT = '0195c0de-0000-7000-8000-000000000001';
const OTHER = '0195c0de-0000-7000-8000-000000000002';

const OWNING = {
  projectId: PROJECT,
  projectPublicId: 'AAAProject',
  title: 'Coordinator control loop',
  status: 'OPEN' as const,
  acceptanceEpoch: '3',
};

function view(over: Partial<TaskAttribution> = {}): TaskAttribution {
  return {
    taskId: TASK,
    owning: OWNING,
    owningAbsentReason: null,
    discovery: {
      project: null,
      triggerEvent: null,
      task: null,
      session: null,
      recorded: false,
      absentReason: 'NO_DISCOVERY_RECORDED',
      authority: 'EVIDENCE_ONLY',
    },
    acceptance: [],
    acceptanceAbsentReason: 'NOT_CITED_BY_ACCEPTANCE',
    crossing: null,
    crossingAbsentReason: 'NO_CROSSING_DECLARED',
    blocker: null,
    blockerAbsentReason: 'NOTHING_BLOCKING_ATTRIBUTION',
    ...over,
  };
}

const paint = (v: TaskAttribution) => renderToStaticMarkup(<TaskAttributionBody view={v} />);

describe('TaskAttributionCard — where this work counts', () => {
  it('names the owning project by TITLE and by pasteable id, not by one of them', () => {
    const html = paint(view());
    expect(html).toContain('Coordinator control loop');
    // AC1: the id is the thing you can look the project up by, and the title is the thing you can
    // recognise. Either one alone leaves the reader unable to check they are in the right place.
    expect(html).toContain('AAAProject');
    expect(html).toContain('epoch 3');
    expect(html).toContain('OPEN');
  });

  it('falls back to the raw id when a server predates the Base62 twin', () => {
    // AC3, mixed versions: an older build serves `projectId` alone, and a card that rendered
    // nothing then would drop the one field AC1 requires be visible.
    expect(publicIdOf({ projectId: PROJECT })).toBe(PROJECT);
    expect(publicIdOf({ projectId: PROJECT, projectPublicId: 'AAAProject' })).toBe('AAAProject');
  });

  it('says WHY each empty section is empty rather than rendering nothing', () => {
    const html = paint(view());
    expect(html).toContain('Nothing was recorded about where this work was noticed.');
    expect(html).toContain('No acceptance criterion cites this task as its evidence.');
    expect(html).toContain('No declared crossing touches this task.');
    expect(html).toContain('Nothing is blocking where this work counts.');
  });

  it('renders a task filed under no project as that, not as a blank', () => {
    const html = paint(view({ owning: null, owningAbsentReason: 'FILED_UNDER_NO_PROJECT' }));
    expect(html).toContain('This task is filed under no project.');
  });

  it('labels the discovery source as evidence, on the screen and not only in the payload', () => {
    // SC7. "Where this was noticed" reading like "where this belongs" is the original incident,
    // one screen later — so the chip is rendered from the server's own `authority` value.
    const html = paint(view({
      discovery: {
        project: { ...OWNING, projectId: OTHER, projectPublicId: 'BBBProject', title: 'Somewhere else' },
        triggerEvent: 'session.transcript',
        task: { taskId: TASK, title: 'the task that noticed it' },
        session: { sessionId: TASK, title: null },
        recorded: true,
        absentReason: null,
        authority: 'EVIDENCE_ONLY',
      },
    }));
    expect(html).toContain('EVIDENCE ONLY');
    expect(html).toContain('Somewhere else');
    expect(html).toContain('session.transcript');
    expect(html).toContain('the task that noticed it');
  });

  it('tells a PASS from before a reopen apart from one from a rerun, in words', () => {
    const link = {
      runId: 'r1', attempt: '4', ordinal: 2, criterionKey: 'k', text: 'the loop never idles',
      verdict: 'PASS' as const, epoch: '2', current: false,
    };
    const reopened = paint(view({
      acceptance: [{ ...link, staleReason: 'EPOCH_ADVANCED' }], acceptanceAbsentReason: null,
    }));
    const rerun = paint(view({
      acceptance: [{ ...link, epoch: '3', staleReason: 'RUN_SUPERSEDED' }],
      acceptanceAbsentReason: null,
    }));
    // AC5: not a colour and not a tooltip — the state is a word, and the two ways of going stale
    // are two different sentences because they are two different things to do next.
    expect(reopened).toContain('NOT CURRENT');
    expect(reopened).toContain('this project was reopened');
    expect(rerun).toContain('superseded by a later attempt in the same epoch');
    expect(paint(view({
      acceptance: [{ ...link, epoch: '3', current: true, staleReason: null }],
      acceptanceAbsentReason: null,
    }))).toContain('CURRENT');
  });

  it('shows a pending crossing with its stable code and its required action', () => {
    const html = paint(view({
      crossing: {
        handoffId: 'h1', kind: 'FILE_TASK', state: 'PENDING',
        from: OWNING, to: { ...OWNING, projectId: OTHER, title: 'Somewhere else' },
        subjectTaskId: TASK, crossingKey: 'c'.repeat(64),
        requestedAt: '2026-08-22T00:00:00.000Z', decidedAt: null, expiresAt: null,
        code: 'APPROVAL_PENDING', requiredAction: 'AWAIT_HANDOFF_APPROVAL',
      },
      crossingAbsentReason: null,
    }));
    expect(html).toContain('APPROVAL_PENDING');
    expect(html).toContain('AWAIT_HANDOFF_APPROVAL');
    expect(html).toContain('the work is not filed anywhere until you answer');
  });

  it('shows an attribution blocker with its code, its owner and what would clear it', () => {
    const html = paint(view({
      blocker: {
        blockerId: 'b1', kind: 'AWAITING_USER_INPUT', owner: 'USER',
        requiredAction: 'Say which project owns this work.',
        nextCheckAt: '2026-08-22T00:10:00.000Z', code: 'UNMAPPED_PROJECT_WORK',
      },
      blockerAbsentReason: null,
    }));
    expect(html).toContain('UNMAPPED_PROJECT_WORK');
    expect(html).toContain('AWAITING_USER_INPUT');
    expect(html).toContain('Say which project owns this work.');
    expect(html).toContain('owner USER');
  });

  it('gives every chip an accessible name, so none of them is colour alone', () => {
    const html = paint(view({
      acceptance: [{
        runId: 'r1', attempt: '1', ordinal: 1, criterionKey: 'k', text: 't',
        verdict: 'FAIL', epoch: '3', current: true, staleReason: null,
      }],
      acceptanceAbsentReason: null,
    }));
    expect(html).toContain('aria-label="Project status OPEN"');
    expect(html).toContain('aria-label="Acceptance epoch 3"');
    expect(html).toContain('aria-label="Verdict FAIL"');
    expect(html).toContain('aria-label="Current acceptance epoch"');
  });
});

describe('TaskAttributionCard — a server that does not answer', () => {
  function client() {
    return new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  }

  it('draws a mixed-version 404 as a warning, never as a broken page', () => {
    const qc = client();
    // Built rather than fetched: a static render never runs the query, so the error has to be put
    // where the observer reads it from.
    qc.getQueryCache()
      .build(qc, { queryKey: ['task', TASK, 'attribution'] })
      .setState({ status: 'error', error: new Error('404 Not Found'), fetchStatus: 'idle' });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <TaskAttributionCard taskId={TASK} />
      </QueryClientProvider>,
    );
    expect(html).toContain('Attribution boundary could not be loaded');
  });
});

describe('crossing order', () => {
  it('puts the questions first, oldest first, and the history newest first', () => {
    const row = (id: string, state: 'PENDING' | 'APPLIED', at: string) =>
      ({ id, state, requestedAt: at }) as never;
    const ordered = orderCrossings([
      row('a', 'APPLIED', '2026-08-01T00:00:00Z'),
      row('b', 'PENDING', '2026-08-03T00:00:00Z'),
      row('c', 'APPLIED', '2026-08-02T00:00:00Z'),
      row('d', 'PENDING', '2026-08-02T00:00:00Z'),
    ]);
    // A pending row is work waiting on the reader and the one that has waited longest is holding
    // up the most; an answered row is history, and history reads newest first.
    expect(ordered.map((r) => r.id)).toEqual(['d', 'b', 'c', 'a']);
  });
});
