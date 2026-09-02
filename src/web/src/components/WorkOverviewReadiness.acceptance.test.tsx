// @vitest-environment jsdom
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import {
  ProjectPanoramaHeader,
  type ProjectPanorama,
} from './ProjectPanoramaHeader';
import {
  ProjectTasks,
  projectTaskGroups,
  projectTaskWorkLabel,
} from '../pages/ProjectsPage';
import {
  buildProjectFlowElements,
} from './ProjectDependencyGraph';
import {
  layoutProjectDependencyGraph,
  type ProjectDependencyGraphResponse,
} from '../lib/projectDependencyGraph';
import { canStartTask } from '../lib/taskFilters';

vi.mock('../api', () => ({ api: vi.fn(() => new Promise(() => undefined)) }));

const PROJECT = '34EVnSK4xSBvXox6Za9AA';
const SUBJECT_FAILED = '34EVtIlOD1lRdPL4c5j7E';
const SUBJECT_MISSING = 'subject-missing';
const MANUAL_READY = 'manual-ready';
const AUTO_READY = 'automatic-ready';

function client() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false, retryOnMount: false } },
  });
}

const task = (over: Record<string, unknown>) => ({
  id: MANUAL_READY,
  title: 'Ordinary manual work',
  status: 'OPEN',
  parentTaskId: null,
  acceptanceCriteria: 'A runnable leaf',
  createdAt: '2026-08-29T00:00:00.000Z',
  updatedAt: '2026-08-29T00:00:00.000Z',
  dueDate: null,
  runAt: null,
  assignee: { id: 'workspace', name: 'Codex' },
  childCount: 0,
  unmetCount: 0,
  blocksCount: 0,
  topoLevel: 0,
  dependencyState: 'READY',
  completionCriterion: 'EVIDENCE_JUDGMENT',
  completionPolicy: 'MANUAL',
  verdict: null,
  verifiesTaskId: null,
  autoRunWhenReady: false,
  workState: 'READY',
  verificationState: null,
  ...over,
});

const tasks = [
  task({
    id: SUBJECT_FAILED,
    title: 'Root delivery subject',
    completionCriterion: 'VERIFICATION',
    completionPolicy: 'VERIFICATION_PASSED',
    workState: 'AWAITING_VERIFICATION',
    verificationState: 'FAILED',
    autoRunWhenReady: false,
  }),
  task({
    id: SUBJECT_MISSING,
    title: 'Subject without verifier',
    completionCriterion: 'VERIFICATION',
    completionPolicy: 'VERIFICATION_PASSED',
    workState: 'AWAITING_VERIFICATION',
    verificationState: 'MISSING',
    autoRunWhenReady: false,
  }),
  task({ id: MANUAL_READY, title: 'Ordinary manual work' }),
  task({
    id: AUTO_READY,
    title: 'Automatic runnable work',
    autoRunWhenReady: true,
    workState: 'READY',
  }),
];

function renderFixture(): string {
  const qc = client();
  const panorama: ProjectPanorama = {
    buckets: {
      running: 1,
      ready: 2,
      blocked: 3,
      awaitingVerification: 5,
      done: 11,
      failed: 1,
      cancelled: 2,
    },
    shape: { taskCount: 25, edgeCount: 24, ratio: 24 / 25, maxDepth: 8, form: 'chain' },
  };
  qc.setQueryData(['project', PROJECT, 'panorama'], panorama);
  qc.setQueryData(['project', PROJECT, 'tasks', 'root'], { items: tasks, nextCursor: null });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <main style={{ width: 358, margin: '0 auto', fontFamily: 'system-ui, sans-serif' }}>
          <ProjectPanoramaHeader projectId={PROJECT} projectStatus="OPEN" />
          <ProjectTasks projectId={PROJECT} />
        </main>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('mobile Work overview consumes canonical readiness', () => {
  const html = renderFixture();

  it('renders every exhaustive count including failed denominator work', () => {
    expect(html).toContain('Awaiting verification');
    expect(html).toContain('Failed');
    expect(html).toContain('Cancelled');
    expect(html).toContain('25 tasks');
    expect(html).toContain(
      'Task status: 1 running, 2 ready, 3 blocked, 5 awaiting verification, 11 done, 1 failed, 2 cancelled',
    );
  });

  it('does not call a zero-indegree verification subject Ready', () => {
    const groups = projectTaskGroups(tasks as never);
    expect(groups.find((group) => group.key === 'ready')?.tasks.map((one) => one.id))
      .toEqual([MANUAL_READY, AUTO_READY]);
    expect(groups.find((group) => group.key === 'awaiting-verification')?.tasks.map((one) => one.id))
      .toEqual([SUBJECT_FAILED, SUBJECT_MISSING]);

    const rollingSubject = task({
      id: 'rolling-subject',
      completionCriterion: 'VERIFICATION',
      completionPolicy: 'VERIFICATION_PASSED',
      workState: undefined,
      verificationState: undefined,
    });
    expect(projectTaskGroups([rollingSubject] as never)[0]?.key).toBe('awaiting-verification');
  });

  it('renders actionable failed and missing verifier labels on phone task cards', () => {
    expect(html).toContain('Verification failed');
    expect(html).toContain('Missing verifier');
    expect(html).toContain('subject work must not be started');
    expect(html).not.toContain('Run Now');
    expect(canStartTask({ ...tasks[0], runnable: false } as never)).toBe(false);
    expect(canStartTask({ ...tasks[0], runnable: undefined } as never)).toBe(false);
  });

  it('keeps manual and automatic READY meanings distinct without changing their lane', () => {
    expect(projectTaskWorkLabel(tasks[2] as never)?.text).toBe('Ready · can start now');
    expect(projectTaskWorkLabel(tasks[3] as never)?.text).toBe('Ready · automatic dispatch');
    expect(html).toContain('Ready · can start now');
    expect(html).toContain('Ready · automatic dispatch');
  });

  it('topology uses workState, not absence of incoming edges, for its ready tally', () => {
    const graph: ProjectDependencyGraphResponse = {
      marks: [{
        kind: 'TASK',
        id: SUBJECT_FAILED,
        taskId: SUBJECT_FAILED,
        title: 'Root delivery subject',
        status: 'OPEN',
        parentTaskId: null,
        workState: 'AWAITING_VERIFICATION',
        verificationState: 'FAILED',
      }],
      edges: [],
      taskCount: 1,
      folded: false,
      truncated: false,
      limits: { maxTasks: 50_000, maxMarks: 500 },
    };
    const elements = buildProjectFlowElements(layoutProjectDependencyGraph(graph));
    expect(elements.tally).toEqual({ ready: 0, done: 0 });
    expect(elements.nodes[0].data.task.workState).toBe('AWAITING_VERIFICATION');
  });

  it('writes the real component DOM fixture used for the 390x844 screenshot', () => {
    const htmlPath = process.env.WORK_OVERVIEW_PHONE_HTML;
    const evidencePath = process.env.WORK_OVERVIEW_DOM_EVIDENCE;
    if (!htmlPath || !evidencePath) return;
    mkdirSync(dirname(htmlPath), { recursive: true });
    writeFileSync(
      htmlPath,
      '<!doctype html><html><head><meta charset="utf-8">'
      + '<meta name="viewport" content="width=device-width,initial-scale=1">'
      + '<style>body{margin:16px;background:#f5f6f8;color:#172033}*{box-sizing:border-box}'
      + '.project-work-overview{max-width:358px}.project-task-row{background:white}</style>'
      + `</head><body>${html}</body></html>`,
    );
    const assertions = {
      awaitingVerificationBucket: html.includes('Awaiting verification'),
      verificationFailedCard: html.includes('Verification failed'),
      missingVerifierCard: html.includes('Missing verifier'),
      manualReadyCard: html.includes('Ready · can start now'),
      automaticReadyCard: html.includes('Ready · automatic dispatch'),
      noRunNow: !html.includes('Run Now'),
      verificationSubjectRunDisabled: !canStartTask({ ...tasks[0], runnable: false } as never),
      canonicalTwentyFiveTaskAria: html.includes('Task status: 1 running, 2 ready, 3 blocked, 5 awaiting verification, 11 done, 1 failed, 2 cancelled'),
    };
    expect(Object.values(assertions).every(Boolean)).toBe(true);
    writeFileSync(evidencePath, JSON.stringify({ viewport: { width: 390, height: 844 }, assertions }, null, 2));
  });
});
