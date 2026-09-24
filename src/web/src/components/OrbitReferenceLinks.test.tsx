import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { ApprovalInfo } from '../api';
import { ProjectDetailPage } from '../pages/ProjectsPage';
import { ApprovalPanel } from './ApprovalPanel';
import { ProjectAcceptanceCard } from './ProjectAcceptanceCard';
import { ProjectGoalCard } from './ProjectGoalCard';
import { TaskDetailPanel } from './TaskDetailPanel';

// A static (effect-free) render never invokes a queryFn, so every read below is seeded into the
// cache instead; the stub is the backstop against a live call.
vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(() => new Promise(() => {})),
}));
// The project page draws its dependency graph behind `lazy()`, and a static render only paints the
// fallback — pulling React Flow in for it would buy nothing.
vi.mock('./ProjectDependencyGraph', async () => {
  const { createElement } = await import('react');
  return { ProjectDependencyGraph: () => createElement('div') };
});
// The task panel restores its drag-resized width on mount; Node has no localStorage to restore from.
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });

// Real public ids: the route is built through encodeId, which throws on anything that is neither
// id spelling, and a reference it cannot read degrades to an inert link rather than a route.
const TASK = '34TqaiSUMbQfgTGgyTuNK';
const SESSION = '1CWWwQ6MNVibWQQwFe5lQX';
const PROJECT = '34Tq39ByZ0rV4c6pJkfw7';

/** One reference to a task and one to a session, mid-sentence — where agents mostly write them. */
const prose = (tag: string) =>
  `See [${tag} task](orbit-task:${TASK}) and [${tag} session](orbit-session:${SESSION}).`;

function newClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false, retryOnMount: false } },
  });
}

function render(ui: ReactElement, qc = newClient(), path = '/') {
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The href of the one link reading `text` — undefined when react-markdown blanked it away. */
function hrefOf(html: string, text: string): string | undefined {
  const links = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].filter(
    (m) => m[2].replace(/<[^>]*>/g, '') === text,
  );
  expect(links, `one link reading "${text}"`).toHaveLength(1);
  return /\bhref="([^"]*)"/.exec(links[0][1])?.[1];
}

/** What `prose(tag)` has to come out as: both references routed to their page in the app. */
function expectRouted(html: string, tag: string) {
  expect(hrefOf(html, `${tag} task`)).toBe(`/tasks/${TASK}`);
  expect(hrefOf(html, `${tag} session`)).toBe(`/sessions/${SESSION}`);
}

describe('orbit-* references outside the transcript open their page in the app', () => {
  it('in a task comment', () => {
    const qc = newClient();
    qc.setQueryData(['task', TASK], {
      id: TASK,
      title: 'Fix the links',
      status: 'OPEN',
      assignee: null,
      sessions: [],
      dependsOn: [],
      dependedOnBy: [],
      comments: [
        { id: 'c1', authorName: 'orbit', createdAt: '2026-09-23T14:00:00Z', body: prose('comment') },
      ],
    });
    const html = render(
      <TaskDetailPanel
        taskId={TASK}
        onOpenTask={() => {}}
        onClose={() => {}}
        onDelete={() => {}}
        deleting={false}
      />,
      qc,
    );
    expectRouted(html, 'comment');
  });

  it('in a project goal', () => {
    expectRouted(render(<ProjectGoalCard goal={prose('goal')} />), 'goal');
  });

  it('in a project’s instructions', () => {
    const qc = newClient();
    qc.setQueryData(['project', PROJECT], {
      id: PROJECT,
      title: 'In-app Orbit links',
      status: 'OPEN',
      goal: 'Links open in the app',
      acceptanceCriteriaItems: [],
      instructions: prose('instructions'),
      createdAt: '2026-09-23T13:59:36Z',
      updatedAt: '2026-09-23T14:24:34Z',
      _count: { tasks: 0 },
      tasksByStatus: {},
    });
    const html = render(
      <Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />} />
      </Routes>,
      qc,
      `/projects/${PROJECT}`,
    );
    expectRouted(html, 'instructions');
  });

  it('in a project acceptance criterion', () => {
    const qc = newClient();
    qc.setQueryData(['project', PROJECT], {
      acceptanceCriteriaItems: [{ id: 'k1', ordinal: 1, text: prose('criterion'), revision: 1 }],
    });
    expectRouted(render(<ProjectAcceptanceCard projectId={PROJECT} />, qc), 'criterion');
  });

  describe('in an approval card', () => {
    const approval = (toolName: string, input: unknown): ApprovalInfo => ({
      id: 'a1',
      sessionId: SESSION,
      toolName,
      input,
      status: 'PENDING',
      createdAt: '2026-09-23T14:00:00Z',
    });
    // Every field the card renders as Markdown, each under its own tag so a link is traced to the
    // field it came from.
    const cases: Array<[string, ApprovalInfo, string[]]> = [
      ['a plan', approval('ExitPlanMode', { plan: prose('plan') }), ['plan']],
      [
        'a blocker’s required action and the agent’s reason',
        approval('orbit_blocker_resolve', {
          projectTitle: 'In-app Orbit links',
          reason: prose('reason'),
          blocker: { kind: 'HUMAN_DECISION_REQUIRED', requiredAction: prose('required action') },
        }),
        ['required action', 'reason'],
      ],
      [
        'a task’s description',
        approval('orbit_task_create', { title: 'Fix the links', description: prose('description') }),
        ['description'],
      ],
      [
        'a project’s goal and criteria',
        approval('orbit_project_create', {
          title: 'In-app Orbit links',
          goal: prose('project goal'),
          acceptanceCriteriaItems: [{ text: prose('project criterion') }],
        }),
        ['project goal', 'project criterion'],
      ],
    ];

    it.each(cases)('in %s', (_field, a, tags) => {
      const html = render(<ApprovalPanel approval={a} onDecide={() => {}} />);
      for (const tag of tags) expectRouted(html, tag);
    });
  });
});
