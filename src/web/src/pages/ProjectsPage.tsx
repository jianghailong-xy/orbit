import { useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Alert, Button, Empty, Input, List, Modal, Select, Spin, Tag, Typography } from 'antd';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import {
  ProjectCoordinatorPanel,
  type TriggerResult,
} from '../components/ProjectCoordinatorPanel';
import {
  isForbidden,
  isStaleConfigRevision,
  policyDraftOf,
  policyPatchBody,
  triggerBody,
  type PolicyDraft,
} from '../lib/coordinatorStatus';
import { encodeId, routeId } from '../lib/idCodec';
import {
  projectCoordinatorStatusQuery,
  providersQuery,
  runnersQuery,
  workspacesQuery,
} from '../lib/queries';
import {
  RUN_AT_IMPOSSIBLE,
  runAtIso,
  runAtProblem,
  scheduledStart,
} from '../lib/taskSchedule';
import {
  mergedProviderOptions,
  modelOptionsForProvider,
  type ConfiguredProvider,
} from '../lib/workspaceDefaults';

// Re-exported, not re-implemented: the conversion between an instant and the viewer's wall clock
// now belongs to lib/taskSchedule, shared with the task panel's own Start at editor. This page
// keeps the names it has always exported so that everything reading a project's schedule — its
// rows, its New task dialog, and the tests over both — still has one place to import from.
export { RUN_AT_IMPOSSIBLE, runAtIso, runAtProblem, scheduledStart };

interface Project {
  id: string;
  title: string;
  status: 'OPEN' | 'DONE' | 'CANCELLED';
  goal?: string | null;
  createdAt: string;
  updatedAt: string;
  _count: { tasks: number };
}

/** What GET /projects/:id adds to a row: the long-form fields the list deliberately omits, plus
 *  the server's grouped task tally. Statuses with no tasks are absent from `tasksByStatus`
 *  entirely (it's a `groupBy`), so an empty object means "no tasks", not "counts unavailable". */
interface ProjectDetail extends Project {
  acceptanceCriteria?: string | null;
  instructions?: string | null;
  tasksByStatus?: Record<string, number>;
  /** The session this project is coordinated from, null on one that has never had a coordinator.
   *  Only the LABEL below depends on it — opening always goes through the server, which is what
   *  repairs a pointer that has since gone to Trash. */
  coordinatorSessionId?: string | null;
}

const STATUS_COLOR: Record<Project['status'], string> = {
  OPEN: 'blue',
  DONE: 'green',
  CANCELLED: 'default',
};

// Row text, not the full field — a project's goal can run to MAX_PROJECT_GOAL_CHARS (4,000 in the
// apiserver DTO), far past what a list row should show, and a task's acceptance criteria is the
// same shape of field read in the same shape of row.
const ROW_EXCERPT_LENGTH = 180;

function excerpt(text: string | null | undefined, empty: string): string {
  const trimmed = text?.trim();
  if (!trimmed) return empty;
  return trimmed.length > ROW_EXCERPT_LENGTH ? `${trimmed.slice(0, ROW_EXCERPT_LENGTH)}…` : trimmed;
}

/** Read-only index of the signed-in user's projects — newest first, no row interaction. */
export function ProjectsPage() {
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => api<Project[]>('/projects'),
  });

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <Typography.Title level={2} className="page-title">
        Projects
      </Typography.Title>

      {projects.isLoading ? (
        <div style={{ padding: 48, textAlign: 'center' }}>
          <Spin />
        </div>
      ) : projects.isError ? (
        <Alert
          type="error"
          showIcon
          message="Projects could not be loaded"
          description={projects.error instanceof Error ? projects.error.message : undefined}
          action={
            <Button size="small" danger onClick={() => projects.refetch()}>
              Retry
            </Button>
          }
        />
      ) : (projects.data?.length ?? 0) === 0 ? (
        <Empty description="No projects yet" style={{ marginTop: 48 }} />
      ) : (
        <List
          dataSource={projects.data}
          rowKey="id"
          renderItem={(p) => (
            <List.Item>
              {/* One link spanning the whole row — meta and count alike — so the entire row is a
                  single click and a single tab stop, rather than a title-sized target with dead
                  space either side. The short public id, never the raw UUID: the same spelling
                  every other link in the app is built with (see encodeId). */}
              <Link
                to={`/projects/${encodeURIComponent(encodeId(p.id))}`}
                style={{ display: 'flex', alignItems: 'center', gap: 16, width: '100%', color: 'inherit' }}
              >
                <List.Item.Meta
                  title={
                    <span>
                      {p.title} <Tag color={STATUS_COLOR[p.status]}>{p.status}</Tag>
                    </span>
                  }
                  description={excerpt(p.goal, 'No goal set')}
                />
                <div>{p._count.tasks} task{p._count.tasks === 1 ? '' : 's'}</div>
              </Link>
            </List.Item>
          )}
        />
      )}
    </div>
  );
}

/** One long-form field. Shown in full — the list row is where a goal gets truncated, this page is
 *  where it gets read — and pre-wrap so the author's own line breaks survive. */
function Field({ label, text, empty }: { label: string; text?: string | null; empty: string }) {
  const body = text?.trim();
  return (
    <div style={{ marginBottom: 24 }}>
      <Typography.Title level={5}>{label}</Typography.Title>
      <Typography.Paragraph
        type={body ? undefined : 'secondary'}
        style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}
      >
        {body || empty}
      </Typography.Paragraph>
    </div>
  );
}

/** Read-only detail for one project: what it's for, how anyone would know it got there, and where
 *  its tasks stand — down to a row per top-level task, and from there down to whichever levels
 *  the reader opens. Still no writes: every row is read-only, however deep it sits. */
export function ProjectDetailPage() {
  const params = useParams();
  const navigate = useNavigate();
  // The route param can still arrive as a raw UUID (an old bookmark, a pasted link), so normalize
  // before it reaches either the cache key or the URL — otherwise the same project caches twice.
  // Stays nullable: an id we don't have is a different state from one we do, and collapsing it to
  // '' would send a request to `/projects/` — a URL for no project, answered by the list route.
  const id = routeId(params.id);
  const project = useQuery({
    queryKey: ['project', id],
    queryFn: () => api<ProjectDetail>(`/projects/${encodeURIComponent(id!)}`),
    enabled: Boolean(id),
  });
  const p = project.data;
  const byStatus = Object.entries(p?.tasksByStatus ?? {});

  // Declared here, above the branch that decides whether the project loaded, because a hook cannot
  // live inside it — the section it drives renders further down. Keyed by project, so two projects
  // open in two tabs cannot read each other's in-flight or failed state.
  const coordinator = useMutation({
    mutationKey: ['project', id, 'coordinator'],
    mutationFn: async () => {
      // Not reachable from the button, which only exists inside the loaded branch — but the id is
      // nullable up here, and a guard is what keeps `/projects/null/coordinator` off the wire
      // rather than narrowing the type with an assertion that would send it.
      if (!id) throw new Error('This link is missing a project id.');
      return openProjectCoordinator(id);
    },
    // The id that gets navigated to is the one the SERVER just returned, never the pointer the
    // project document arrived with: on a trashed binding those are two different sessions, and
    // only the returned one is the live conversation.
    onSuccess: (result) => navigate(coordinatorSessionPath(result.sessionId)),
  });

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <Link to="/projects">← All projects</Link>

      {!id ? (
        // Nothing was asked for, so there is nothing to retry — only a way back. A malformed but
        // present id is NOT this case: it goes to the server and comes back a 404, below.
        <Alert
          style={{ marginTop: 24 }}
          type="error"
          showIcon
          message="Project could not be loaded"
          description="This link is missing a project id."
        />
      ) : project.isLoading ? (
        <div style={{ padding: 48, textAlign: 'center' }}>
          <Spin />
        </div>
      ) : project.isError ? (
        <Alert
          style={{ marginTop: 24 }}
          type="error"
          showIcon
          message="Project could not be loaded"
          description={project.error instanceof Error ? project.error.message : undefined}
          action={
            <Button size="small" danger onClick={() => project.refetch()}>
              Retry
            </Button>
          }
        />
      ) : p ? (
        <>
          <Typography.Title level={2} className="page-title">
            {p.title} <Tag color={STATUS_COLOR[p.status]}>{p.status}</Tag>
          </Typography.Title>

          <div style={{ marginBottom: 24 }}>
            <span style={{ marginRight: 8 }}>
              {p._count.tasks} task{p._count.tasks === 1 ? '' : 's'}
            </span>
            {byStatus.length === 0 ? (
              <Typography.Text type="secondary">No tasks yet</Typography.Text>
            ) : (
              byStatus.map(([status, n]) => (
                <Tag key={status}>
                  {status} {n}
                </Tag>
              ))
            )}
          </div>

          <Field label="Goal" text={p.goal} empty="No goal set" />
          <Field
            label="Acceptance criteria"
            text={p.acceptanceCriteria}
            empty="No acceptance criteria set"
          />
          <Field label="Instructions" text={p.instructions} empty="No instructions set" />
          {/* A sibling of the fields above and the tasks below, not a wrapper around either: a
              coordinator that fails to open costs the reader the coordinator and nothing else. */}
          <ProjectCoordinatorControl
            bound={Boolean(p.coordinatorSessionId)}
            pending={coordinator.isPending}
            error={coordinator.error}
            onOpen={() => coordinator.mutate()}
          />
          {/* Under the button that opens the conversation, because they are two halves of one
              question: that one is where a coordinator is TALKED to, this is what it has been
              doing and what it is allowed to do. Inside the loaded branch for the same reason the
              task page is — a project that 404s puts no second doomed request on the wire. */}
          <ProjectCoordinatorSection projectId={id} />
          {/* Inside this branch on purpose: the tasks page is only asked for once the project it
              belongs to came back, so a project that 404s never puts a second doomed request on
              the wire. `id` is the normalized route id — the same spelling the project query
              above is keyed and fetched with. */}
          <ProjectTasks projectId={id} />
        </>
      ) : null}
    </div>
  );
}

/**
 * What the coordination-settings form is handed before the first status lands.
 *
 * Never rendered — the panel draws a spinner until a status exists — but the form's props are not
 * nullable, and a nullable path through it would be a branch nothing can reach. The values are the
 * conservative ones on purpose: if this ever DID render, it would render a project that is switched
 * off and manual, which is the safe reading of "we do not know yet".
 */
const UNREAD_POLICY_DRAFT: PolicyDraft = {
  coordinatorEnabled: false,
  automationPolicy: 'MANUAL',
  maxConcurrentTasks: 1,
  sessionBudgetPerDay: null,
};

/** An id for one press of Run now, or null when this browser cannot mint one — in which case the
 *  server allocates it and only a retry loses its idempotency. */
function newTriggerId(): string | null {
  // `typeof crypto` rather than `crypto?.` — optional chaining still throws on an identifier that
  // was never declared, which is the only case this guard is for.
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : null;
}

/**
 * The Coordinator surface's one stateful half: the read, the two control writes, and what each
 * refusal does to the form.
 *
 * Everything it decides is about the WRITE path, and there are only three decisions in it:
 *
 *  - A 403 latches the whole surface read-only. Not guessed from the payload — the status read
 *    carries no permission field — but taken from the one place the answer actually exists.
 *  - A 409 `STALE_CONFIG_REVISION` records the conflict and re-reads the project. The form stays
 *    CLOSED until the reader presses "Review current settings": the next submit would carry the
 *    revision that has just superseded theirs and would therefore succeed, writing their stale
 *    intent over the change that refused it.
 *  - A press of Run now keeps its `triggerId` until it is answered, so a retry is the same request.
 *
 * The draft is `null` until the reader touches something, so the form shows the server's values and
 * follows them as they move. The moment it is edited it stops following — an edit being overwritten
 * by a poll is the same silent loss the revision fence exists to stop, one layer up.
 */
function ProjectCoordinatorSection({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const statusQ = useQuery(projectCoordinatorStatusQuery(projectId));
  const status = statusQ.data;

  const [readOnly, setReadOnly] = useState(false);
  const [draft, setDraft] = useState<PolicyDraft | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [conflict, setConflict] = useState<{ message: string } | null>(null);
  const [triggerResult, setTriggerResult] = useState<TriggerResult | null>(null);
  const triggerId = useRef<string | null>(null);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['project', projectId] });
  };

  /** What a refused control write means for the surface. Both branches are latches on purpose: a
   *  refusal that cleared itself on the next render would leave a button that keeps failing. */
  const noteRefusal = (error: Error) => {
    if (isForbidden(error)) setReadOnly(true);
    if (isStaleConfigRevision(error)) {
      setConflict({ message: error.message });
      refresh();
    }
  };

  const trigger = useMutation({
    mutationFn: () => {
      if (!status) throw new Error('The coordinator’s state has not loaded yet.');
      triggerId.current = triggerId.current ?? newTriggerId();
      return api<TriggerResult>(
        `/projects/${encodeURIComponent(projectId)}/coordinator/trigger`,
        { method: 'POST', body: triggerBody(status, triggerId.current) },
      );
    },
    onSuccess: (result) => {
      triggerId.current = null;
      setTriggerResult(result);
      refresh();
    },
    onError: noteRefusal,
  });

  const savePolicy = useMutation({
    mutationFn: () => {
      if (!status) throw new Error('The coordinator’s state has not loaded yet.');
      return api(`/projects/${encodeURIComponent(projectId)}`, {
        method: 'PATCH',
        body: policyPatchBody(draft ?? policyDraftOf(status), status),
      });
    },
    onSuccess: () => {
      // Back to following the server: what was just written IS the server's value now, and a draft
      // left behind would keep the form pinned to a revision that has moved.
      setDraft(null);
      setConfirmed(false);
      refresh();
    },
    onError: noteRefusal,
  });

  return (
    <ProjectCoordinatorPanel
      status={status}
      loading={statusQ.isLoading}
      error={statusQ.error instanceof Error ? statusQ.error : null}
      onRetry={() => void statusQ.refetch()}
      readOnly={readOnly}
      trigger={{
        pending: trigger.isPending,
        conflict: conflict !== null,
        error: trigger.error,
        result: triggerResult,
        onRun: () => {
          setTriggerResult(null);
          trigger.mutate();
        },
      }}
      policy={{
        draft: draft ?? (status ? policyDraftOf(status) : UNREAD_POLICY_DRAFT),
        onDraft: setDraft,
        pending: savePolicy.isPending,
        conflict,
        confirmed,
        onConfirm: setConfirmed,
        error: savePolicy.error,
        onSubmit: () => savePolicy.mutate(),
        onReview: () => {
          // The refreshed settings become the form's values again, and only then does Save reopen.
          setDraft(null);
          setConfirmed(false);
          setConflict(null);
          void statusQ.refetch();
        },
      }}
    />
  );
}

/** What POST /projects/:id/coordinator answers with. `created` tells the session this call opened
 *  apart from the one it found already bound; both are this project's coordinator, and this unit
 *  opens either of them the same way. */
export interface CoordinatorResult {
  sessionId: string;
  created: boolean;
  workspaceId: string | null;
}

/**
 * Resolve-or-create this project's one coordinator session.
 *
 * A POST every time, including from a project whose detail payload already names a coordinator.
 * The pointer it carries can be stale — the session behind it may since have gone to Trash — and
 * the server is what notices and replaces it, handing back the live conversation. Deep-linking
 * straight to `coordinatorSessionId` would skip that repair and land the reader inside Trash.
 *
 * The body is `{}` rather than nothing: `workspaceId` is what picks where a FIRST coordinator
 * opens, and this unit deliberately has no picker, so it sends none and lets the server's own
 * fallback answer — down to its 400 when even that has nothing to go on, which names the two
 * things a reader can actually do about it.
 */
export function openProjectCoordinator(projectId: string): Promise<CoordinatorResult> {
  return api<CoordinatorResult>(`/projects/${encodeURIComponent(projectId)}/coordinator`, { method: 'POST', body: {} });
}

/** Where a resolved coordinator is read. Through `encodeId`, like every other link in the app, so
 *  a response carrying the raw UUID and one carrying the short public id land on one route. */
export const coordinatorSessionPath = (sessionId: string): string =>
  `/sessions/${encodeURIComponent(encodeId(sessionId))}`;

/**
 * The Coordinator section as a function of its state alone.
 *
 * Presentational, and exported for the same reason ProjectTaskLevel is: a static render cannot
 * press the button, so handing each state in directly is the only way to assert what pending and
 * failed actually put on screen.
 *
 * One control for both labels. `bound` changes what the button is called — a project that already
 * has a coordinator is being reopened, not started — and nothing else: both spellings fire the
 * same resolve-or-create request, because which of the two it turns out to be is the server's
 * answer, not this component's guess.
 */
export function ProjectCoordinatorControl({
  bound,
  pending,
  error,
  onOpen,
}: {
  bound: boolean;
  pending: boolean;
  error: Error | null;
  onOpen: () => void;
}) {
  return (
    <div style={{ marginBottom: 24 }}>
      <Typography.Title level={4}>Coordinator</Typography.Title>
      <Typography.Paragraph type="secondary">
        A project has exactly one coordinator session. Opening it here reuses that conversation, or
        starts it if there is none yet.
      </Typography.Paragraph>

      {/* `disabled` as well as `loading`: the spinner says a request is in flight, but only the
          disabled state stops a second press from opening a second one. */}
      <Button type="primary" loading={pending} disabled={pending} onClick={onOpen}>
        {bound ? 'Open coordinator' : 'Start coordinator'}
      </Button>

      {/* The server's own message, verbatim. On the one failure a reader can act on — no workspace
          to open in — it names both ways out, and this unit has no picker of its own to offer
          instead. Inline, so a failure here leaves the project and its tasks where they were. */}
      {error ? (
        <Alert
          style={{ marginTop: 16 }}
          type="error"
          showIcon
          message="Coordinator could not be opened"
          description={error.message}
          action={
            <Button size="small" danger onClick={onOpen}>
              Retry
            </Button>
          }
        />
      ) : null}
    </div>
  );
}

/** One page of a project's task tree. `nextCursor` is non-null only when a further page really
 *  exists — the server reads one row past the limit rather than counting the remainder. */
interface ProjectTaskPage {
  items: ProjectTask[];
  nextCursor: string | null;
}

interface ProjectTask {
  id: string;
  title: string;
  status: 'OPEN' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED';
  parentTaskId: string | null;
  acceptanceCriteria?: string | null;
  createdAt: string;
  updatedAt: string;
  dueDate?: string | null;
  /** When this task starts on its own, once. Deliberately NOT `dueDate`, which sits right above
   *  it: that is a deadline nothing dispatches on, this is the trigger the server acts on. Absent
   *  — or null — on every task that has never been scheduled, which is most of them. */
  runAt?: string | null;
  assignee?: { id: string; name: string } | null;
  childCount: number;
}

/** A task has a status a project does not (IN_PROGRESS), so it gets its own map rather than a
 *  widened shared one — a project can never be IN_PROGRESS, and the types should keep saying so. */
const TASK_STATUS_COLOR: Record<ProjectTask['status'], string> = {
  OPEN: 'blue',
  IN_PROGRESS: 'gold',
  DONE: 'green',
  CANCELLED: 'default',
};

/**
 * The project's top-level tasks, read-only: the first page of them, each of which can be opened
 * onto its own direct children.
 *
 * Its own query rather than a field on the project, because the tree is paged and the project
 * document is not — folding one into the other would make every project read pay for a page of
 * tasks. Sending no `parentId` is what asks for the root level specifically, so the key names that
 * level too: the subtask pages hanging off these rows are the same endpoint with a `parentId`,
 * and they must not land on this entry.
 *
 * Only this level is fetched here. A row's own children are read by that row, and only once it is
 * opened — so a project with a deep tree still costs exactly one request until the reader asks for
 * more.
 */
function ProjectTasks({ projectId }: { projectId: string }) {
  // The dialog is opened from here rather than owning its own trigger, so the section that lists
  // the level a new task lands in is also the thing that offers to add one to it.
  const [creating, setCreating] = useState(false);
  const tasks = useQuery({
    queryKey: ['project', projectId, 'tasks', 'root'],
    queryFn: () =>
      api<ProjectTaskPage>(`/projects/${encodeURIComponent(projectId)}/tasks/page?limit=100`),
  });

  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Typography.Title level={4}>Tasks</Typography.Title>
        {/* Beside the heading, not inside the list: it is still offered on a project whose page
            of tasks is empty, still loading, or failed to load — none of which says anything
            about whether another task can be added. */}
        <Button type="primary" onClick={() => setCreating(true)}>
          New task
        </Button>
      </div>

      {tasks.isLoading ? (
        <div style={{ padding: 24, textAlign: 'center' }}>
          <Spin />
        </div>
      ) : tasks.isError ? (
        <Alert
          type="error"
          showIcon
          message="Tasks could not be loaded"
          description={tasks.error instanceof Error ? tasks.error.message : undefined}
          action={
            <Button size="small" danger onClick={() => tasks.refetch()}>
              Retry
            </Button>
          }
        />
      ) : tasks.data && tasks.data.items.length > 0 ? (
        <>
          <List
            dataSource={tasks.data.items}
            rowKey="id"
            renderItem={(t) => <ProjectTaskRow projectId={projectId} task={t} />}
          />
          {/* Said outright rather than shown as a button: this unit reads one page and sends no
              cursor, so a silent stop here would read as "that is all of them". */}
          {tasks.data.nextCursor ? (
            <Typography.Text type="secondary">
              More top-level tasks exist beyond this first page.
            </Typography.Text>
          ) : null}
        </>
      ) : (
        <Empty description="No top-level tasks yet" />
      )}

      <NewProjectTaskModal
        projectId={projectId}
        open={creating}
        onClose={() => setCreating(false)}
      />
    </div>
  );
}

/**
 * One read-only task row, plus — once the reader asks — the level directly beneath it.
 *
 * `expanded` lives here, per row, rather than in a set held by the page: keeping it local is what
 * makes the child page lazy, because a closed row renders no level component at all, so no child
 * query is even registered, let alone sent. Closing the row unmounts it again.
 *
 * The same component renders those children, so a subtask that has subtasks of its own gets the
 * same control and opens the same way — one level per press, never a whole subtree at once.
 */
function ProjectTaskRow({ projectId, task }: { projectId: string; task: ProjectTask }) {
  const [expanded, setExpanded] = useState(false);
  const starts = scheduledStart(task.runAt);

  return (
    <List.Item style={{ display: 'block' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <List.Item.Meta
          // Title in full: a task's title is its identity, and a half-read one names a
          // different task. The long-form field underneath is what gets cut instead.
          title={
            <span>
              {task.title} <Tag color={TASK_STATUS_COLOR[task.status]}>{task.status}</Tag>
              {/* Only on a task that actually has one — an unscheduled task is the normal case,
                  and a "not scheduled" chip on every row would drown the few that are. Said as
                  "Starts", never "Due": this is the trigger the server acts on, and the row
                  deliberately shows no `dueDate` at all, so the word has only one meaning here.
                  The <time> is what carries the precise instant for anything not reading the
                  screen — `dateTime` in canonical UTC for machines, the same in `title` for a
                  reader who needs the exact moment behind a to-the-minute local rendering. */}
              {starts ? (
                <Tag>
                  <time dateTime={starts.iso} title={starts.iso}>
                    Starts {starts.local}
                  </time>
                </Tag>
              ) : null}
            </span>
          }
          description={excerpt(task.acceptanceCriteria, 'No acceptance criteria set')}
        />
        <div>
          {task.childCount} subtask{task.childCount === 1 ? '' : 's'}
        </div>
        {/* Only where there is a level to open: on a leaf, a control would promise one that does
            not exist. `aria-expanded` is what makes it a disclosure rather than a plain button —
            it tells a reader who cannot see the indent which way this row currently sits. */}
        {task.childCount > 0 ? (
          <Button
            size="small"
            aria-expanded={expanded}
            // The visible text alone is the same three words on every expandable row, so a reader
            // moving between controls hears "Show subtasks" over and over with nothing to tell
            // them apart. The label names the row; the visible text stays its literal prefix, so
            // voice control still reaches it by what is on screen.
            aria-label={
              expanded ? `Hide subtasks for ${task.title}` : `Show subtasks for ${task.title}`
            }
            onClick={() => setExpanded((open) => !open)}
          >
            {expanded ? 'Hide subtasks' : 'Show subtasks'}
          </Button>
        ) : null}
      </div>

      {expanded ? (
        <div style={{ marginLeft: 32, marginTop: 8 }}>
          <ProjectTaskLevel projectId={projectId} parentTaskId={task.id} />
        </div>
      ) : null}
    </List.Item>
  );
}

/**
 * One task's direct children — the same endpoint the root list reads, with a `parentId`.
 *
 * The id goes on the wire through `encodeId`, like every link in the app: what a payload calls
 * `task.id` is a moving target across the public-id migration, and the server names a parent by
 * its short public id. It is idempotent, so an id that already arrived in that spelling is sent
 * unchanged. The cache key keeps the spelling it was handed instead — every row in one render
 * comes from one payload, and normalizing there would throw on an id `encodeId` cannot read.
 *
 * Keyed by project AND parent task, so neither two levels of one project nor the same-looking
 * level of two projects can share an entry. Every state it can be in is rendered in place, inside
 * the row that opened it: a level that fails takes down its own contents and nothing else, leaving
 * the parent row, its siblings and the root list exactly where they were.
 *
 * Exported for tests: a static render cannot press the row's button, so mounting this directly is
 * the only way to assert what an opened level shows.
 */
export function ProjectTaskLevel({
  projectId,
  parentTaskId,
}: {
  projectId: string;
  parentTaskId: string;
}) {
  const children = useQuery({
    queryKey: ['project', projectId, 'tasks', 'children', parentTaskId],
    queryFn: () =>
      api<ProjectTaskPage>(
        `/projects/${encodeURIComponent(projectId)}/tasks/page?parentId=${encodeURIComponent(encodeId(parentTaskId))}&limit=100`,
      ),
  });

  return children.isLoading ? (
    <div style={{ padding: 12, textAlign: 'center' }}>
      <Spin size="small" />
    </div>
  ) : children.isError ? (
    <Alert
      type="error"
      showIcon
      message="Subtasks could not be loaded"
      description={children.error instanceof Error ? children.error.message : undefined}
      action={
        <Button size="small" danger onClick={() => children.refetch()}>
          Retry
        </Button>
      }
    />
  ) : children.data && children.data.items.length > 0 ? (
    <>
      <List
        size="small"
        dataSource={children.data.items}
        rowKey="id"
        renderItem={(child) => <ProjectTaskRow projectId={projectId} task={child} />}
      />
      {/* Same reason as the root list: one page, no cursor sent, so stopping silently would read
          as "that is all of them". */}
      {children.data.nextCursor ? (
        <Typography.Text type="secondary">
          More subtasks exist beyond this first page.
        </Typography.Text>
      ) : null}
    </>
  ) : (
    // The only way to reach this level is a row that claimed at least one child, so an empty page
    // is not "a leaf" — it is a count that has since moved on.
    <Empty
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      description="No subtasks — the count on this row is out of date"
    />
  );
}

/**
 * What the New task form holds while it is being filled in.
 *
 * Only the title is required. Every other field is `undefined` until it is actually chosen, and
 * that distinction is load-bearing rather than incidental — see `newProjectTaskBody`.
 */
export interface NewProjectTaskDraft {
  title: string;
  description?: string;
  assigneeId?: string;
  provider?: string;
  model?: string;
  /** The `datetime-local` control's own value — `YYYY-MM-DDTHH:mm` on the VIEWER's wall clock, and
   *  never what goes on the wire. Held in that spelling because it is the only one the control can
   *  be handed back; `runAtIso` is the single place it becomes the UTC instant the API stores. */
  runAtLocal?: string;
}

/** A form with nothing filled in — what the dialog opens on, and what it returns to on success. */
export const EMPTY_NEW_TASK_DRAFT: NewProjectTaskDraft = { title: '' };

/**
 * Whether the dialog's Create button may fire at all.
 *
 * Both halves are "the reader asked for something this form cannot send": a title of nothing but
 * spaces names a task nobody can find again, and an impossible start is a schedule that cannot be
 * honoured. Exported and total, so the disabled state can be asserted directly — the button itself
 * lives behind a portal that a static render produces no markup for.
 */
export function canCreateProjectTask(draft: NewProjectTaskDraft): boolean {
  return draft.title.trim().length > 0 && runAtProblem(draft.runAtLocal) === null;
}

/**
 * The body `POST /tasks` is given, from a draft and the project it is being created under.
 *
 * What is absent from it is the point. A task with no provider pin inherits its assignee's, and
 * the way to say that is to send no `provider` at all — not `null`, and above all not a copy of
 * whichever provider the assignee happens to use today. Writing that value in would freeze it: the
 * assignee moving to another provider would stop carrying this task along with it, which is the
 * whole difference between inheriting and pinning.
 *
 * `''` is not "unselected" — it is OpenCode's own managed-model choice, a real selection — so what
 * is tested for is null/undefined rather than falsiness. The title is trimmed here, at the one
 * place the wire value is built, so no caller can send the untrimmed one.
 *
 * THROWS on a start that is present and impossible, rather than dropping it. Absence is how this
 * body says "unscheduled", so silently omitting an unconvertible value would spend the reader's
 * explicit choice on its exact opposite — a task created, successfully, with no schedule at all
 * and nothing on screen to say so. Synchronous, so the mutation that calls it rejects and the
 * dialog shows the same sentence the field does. The button is disabled long before this, which is
 * what makes this the invariant rather than the error path: it holds for any caller, including one
 * that never rendered the form.
 */
export function newProjectTaskBody(
  projectId: string,
  draft: NewProjectTaskDraft,
): Record<string, string> {
  const body: Record<string, string> = { projectId, title: draft.title.trim() };
  const description = draft.description?.trim();
  if (description) body.description = description;
  // Absent unless a time was actually chosen — an empty string here would be a 400, and a local
  // "9/1/2026, 9:00 AM" would be a schedule the server reads as no date at all. But a value that
  // is present and unusable is refused outright, never quietly dropped: see above.
  if (draft.runAtLocal) {
    const runAt = runAtIso(draft.runAtLocal);
    if (!runAt) throw new Error(RUN_AT_IMPOSSIBLE);
    body.runAt = runAt;
  }
  if (draft.assigneeId != null) body.assigneeId = draft.assigneeId;
  if (draft.provider != null) body.provider = draft.provider;
  if (draft.model != null) body.model = draft.model;
  return body;
}

/** Create one TOP-LEVEL task in this project. No `parentTaskId`: a subtask belongs to the row it
 *  hangs under, and this dialog is opened from the section that lists the root level. */
export function createProjectTask(projectId: string, draft: NewProjectTaskDraft): Promise<unknown> {
  return api('/tasks', { method: 'POST', body: newProjectTaskBody(projectId, draft) });
}

/**
 * What a newly created task changes, refreshed together.
 *
 * `['project', projectId]` is a PREFIX of the root-task page's key, so one invalidation covers both
 * the project document — whose total and per-status tallies the new task moved — and the level the
 * task was just added to. `['projects']` carries the same count on the list row, and `['tasks']`
 * is the prefix every other task view in the app reads under (its lists, its counts, its active
 * strip), none of which knows this project page exists.
 *
 * Exported because it is the half of the mutation a static render can never reach: the dialog's
 * button lives behind a portal, so calling this directly is the only way to assert what a
 * successful create actually refreshes.
 */
export function invalidateAfterProjectTaskCreate(qc: QueryClient, projectId: string): void {
  void qc.invalidateQueries({ queryKey: ['project', projectId] });
  void qc.invalidateQueries({ queryKey: ['projects'] });
  void qc.invalidateQueries({ queryKey: ['tasks'] });
}

/** As much of a workspace row as this form reads: the name it is picked by, the runner whose
 *  catalogue names its models, and the provider a task with no pin of its own inherits. */
interface AssigneeRow {
  id: string;
  name: string;
  runnerId?: string | null;
  provider?: string | null;
}

/** One labelled control in the form below. */
function FormRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 4 }}>
        {label}
      </Typography.Text>
      {children}
    </div>
  );
}

/**
 * The New task form's fields, in one state.
 *
 * Presentational and exported for the same reason ProjectCoordinatorControl is — and here it is
 * also the only way: an antd Modal renders through a portal, which a static render produces no
 * markup at all for, so the body has to be mountable on its own to be assertable at all.
 *
 * It does read its own option sources rather than take them as props. They are the same three the
 * task panel's pickers use, at the same keys: the owner's workspaces, the configured (BYOK)
 * providers, and the model catalogue the assignee's runner reported — model ids are per-machine,
 * which is why they come from that runner rather than from a table.
 */
export function NewProjectTaskForm({
  draft,
  onChange,
  error,
  pending,
}: {
  draft: NewProjectTaskDraft;
  onChange: (draft: NewProjectTaskDraft) => void;
  error: Error | null;
  pending: boolean;
}) {
  const workspacesQ = useQuery(workspacesQuery());
  const providersQ = useQuery(providersQuery());
  const runnersQ = useQuery(runnersQuery());
  const configuredProviders: ConfiguredProvider[] = providersQ.data ?? [];
  const assignees: AssigneeRow[] = workspacesQ.data ?? [];
  const assignee = assignees.find((a) => a.id === draft.assigneeId);
  const assigneeRunner = (runnersQ.data ?? []).find((r) => r.id === assignee?.runnerId);
  // The provider whose model space the Model picker lists: this task's own pin when it has one,
  // otherwise the assignee's — so the models offered always match what the run will use. Read
  // only to decide what is OFFERED; it is never written into the draft, which is what keeps an
  // inherited provider inherited rather than pinned at the moment the form was open.
  const effectiveProvider = draft.provider ?? assignee?.provider ?? null;
  // Recomputed on every keystroke rather than held in state: it is a pure reading of the draft,
  // and a copy of it could go stale against the value the field is actually showing.
  const runAtIssue = runAtProblem(draft.runAtLocal);
  // One id for the line under the control, whichever of the two it is currently showing. Generated
  // rather than written in, so mounting this form twice cannot put the same id in the document
  // twice — which would silently point both inputs at the first one's text.
  const runAtHelpId = useId();
  const modelOptions = useMemo(
    () => modelOptionsForProvider(effectiveProvider, assigneeRunner?.modelCatalog, configuredProviders),
    [effectiveProvider, assigneeRunner?.modelCatalog, configuredProviders],
  );

  return (
    <>
      <FormRow label="Title">
        <Input
          value={draft.title}
          placeholder="What needs doing"
          disabled={pending}
          onChange={(e) => onChange({ ...draft, title: e.target.value })}
        />
      </FormRow>
      <FormRow label="Description">
        <Input.TextArea
          rows={3}
          value={draft.description ?? ''}
          placeholder="Optional detail"
          disabled={pending}
          onChange={(e) => onChange({ ...draft, description: e.target.value })}
        />
      </FormRow>
      {/* After the two fields that say WHAT the task is, before the three that say who and what
          runs it: when it starts is a property of the task, not of the runtime picked for it. */}
      <FormRow label="Start at">
        <Input
          type="datetime-local"
          value={draft.runAtLocal ?? ''}
          disabled={pending}
          // Marked wrong on the control itself, not only in the text below it — `aria-invalid` is
          // what carries that to a reader who never sees the red ring.
          status={runAtIssue ? 'error' : undefined}
          aria-invalid={runAtIssue ? true : undefined}
          // `aria-invalid` alone only says THAT something is wrong. This is what lets the reason
          // be read out with it — and it points at the same line either way, so the hint is
          // announced on a field that is merely optional, not just the error on a broken one.
          aria-describedby={runAtHelpId}
          // '' is what clearing the control hands back, and it is not a time — folding it to
          // undefined here keeps "unscheduled" spelled one way in the draft, so the body builder
          // has one absence to read rather than two.
          onChange={(e) => onChange({ ...draft, runAtLocal: e.target.value || undefined })}
        />
        {/* One line, either the hint or the problem. The reader has just picked a time their own
            clock skips — a browser's datetime-local has no idea about their daylight-saving rules
            — so what they need here is that sentence, not the general advice they have already
            read. Inline and immediate: the alternative is finding out on a task that came back
            with no schedule and nothing saying why. */}
        {runAtIssue ? (
          <Typography.Text id={runAtHelpId} type="danger" style={{ fontSize: 12 }}>
            {runAtIssue}
          </Typography.Text>
        ) : (
          // A datetime-local control shows no placeholder, so what the other optional fields say
          // in one has to be said out loud here — including the two things the control itself
          // cannot: whose clock it is read on, and that this fires once rather than repeating.
          <Typography.Text id={runAtHelpId} type="secondary" style={{ fontSize: 12 }}>
            Optional, in your own time zone. The task starts once, at that time.
          </Typography.Text>
        )}
      </FormRow>
      <FormRow label="Assignee">
        <Select
          style={{ width: '100%' }}
          value={draft.assigneeId ?? undefined}
          placeholder="Unassigned"
          allowClear
          showSearch
          optionFilterProp="label"
          loading={workspacesQ.isLoading}
          disabled={pending}
          options={assignees.map((a) => ({ value: a.id, label: a.name }))}
          // The model goes with the assignee for the same reason it goes with the provider: an
          // unpinned task reads its model space off the assignee's provider and its ids off that
          // assignee's runner, so both halves of what made this model selectable move here. Left
          // behind, it would submit an id the new assignee's runtime has never heard of.
          onChange={(val) => onChange({ ...draft, assigneeId: val ?? undefined, model: undefined })}
        />
      </FormRow>
      <FormRow label="Provider">
        <Select
          style={{ width: '100%' }}
          value={draft.provider ?? undefined}
          // Unpinned is the normal case, so say what it actually does rather than "None".
          placeholder={assignee ? `Assignee's (${assignee.provider ?? 'claude'})` : "Assignee's"}
          allowClear
          showSearch
          optionFilterProp="label"
          loading={providersQ.isLoading}
          disabled={pending}
          options={mergedProviderOptions(configuredProviders)}
          // Changing the provider — or clearing it back to the assignee's — drops the model with
          // it: a model id only means anything inside one provider's model space, so leaving it
          // behind would submit a stale id against a provider that has never heard of it.
          onChange={(val) => onChange({ ...draft, provider: val ?? undefined, model: undefined })}
        />
      </FormRow>
      <FormRow label="Model">
        <Select
          style={{ width: '100%' }}
          value={draft.model ?? undefined}
          placeholder="Provider default"
          allowClear
          showSearch
          optionFilterProp="label"
          loading={runnersQ.isLoading}
          disabled={pending}
          // A model the catalogue doesn't name still has to render as itself rather than vanish
          // out of the box it is sitting in. Reachable while the dialog is open: these option
          // sources are live queries, so a runner heartbeat can retire an id already picked.
          options={
            draft.model != null && !modelOptions.some((o) => o.value === draft.model)
              ? [...modelOptions, { value: draft.model, label: draft.model }]
              : modelOptions
          }
          onChange={(val) => onChange({ ...draft, model: val ?? undefined })}
        />
      </FormRow>

      {/* The server's own message, inline and verbatim. Actionable because everything that was
          typed is still on screen beside it and the dialog's own Create button is still live —
          so the fix is to correct the field it names and press it again, with no second Retry
          control saying the same thing a few pixels away. */}
      {error ? (
        <Alert type="error" showIcon message="Task could not be created" description={error.message} />
      ) : null}
    </>
  );
}

/**
 * The New task dialog: one top-level task in this project, with an optional provider/model pin.
 *
 * `open` is controlled by the section that offers it, so the dialog itself is mounted with the
 * section and its body — and therefore its three option queries — costs nothing until the reader
 * actually asks to add a task.
 */
export function NewProjectTaskModal({
  projectId,
  open,
  onClose,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<NewProjectTaskDraft>(EMPTY_NEW_TASK_DRAFT);
  const create = useMutation({
    mutationFn: (values: NewProjectTaskDraft) => createProjectTask(projectId, values),
    onSuccess: () => {
      setDraft(EMPTY_NEW_TASK_DRAFT);
      onClose();
      invalidateAfterProjectTaskCreate(qc, projectId);
    },
  });
  // A title of nothing but spaces names a task nobody can find again, and an impossible start is a
  // schedule that cannot be honoured. Both are the reader asking for something this form cannot
  // send, so both close the button.
  //
  // Only the second is also refused by `newProjectTaskBody`, which is why that one holds for a
  // caller the button never gated. A blank title is trimmed there, not rejected — what catches it
  // past this point is the server's own `@MinLength(1)`, which the trim is what makes reachable.
  const creatable = canCreateProjectTask(draft);

  return (
    <Modal
      title="New task"
      open={open}
      // Cancel keeps what was typed — a mis-clicked Cancel should not cost a filled-in form — but
      // drops a failed attempt's error, so reopening does not greet the reader with it.
      onCancel={() => {
        create.reset();
        onClose();
      }}
      onOk={() => create.mutate(draft)}
      okText="Create task"
      confirmLoading={create.isPending}
      okButtonProps={{ disabled: !creatable }}
    >
      <NewProjectTaskForm
        draft={draft}
        onChange={setDraft}
        error={create.error}
        pending={create.isPending}
      />
    </Modal>
  );
}
