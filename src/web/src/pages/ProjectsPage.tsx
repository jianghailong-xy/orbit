import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, Button, Empty, List, Spin, Tag, Typography } from 'antd';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { encodeId, routeId } from '../lib/idCodec';

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
  const tasks = useQuery({
    queryKey: ['project', projectId, 'tasks', 'root'],
    queryFn: () =>
      api<ProjectTaskPage>(`/projects/${encodeURIComponent(projectId)}/tasks/page?limit=100`),
  });

  return (
    <div style={{ marginBottom: 24 }}>
      <Typography.Title level={4}>Tasks</Typography.Title>

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

  return (
    <List.Item style={{ display: 'block' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <List.Item.Meta
          // Title in full: a task's title is its identity, and a half-read one names a
          // different task. The long-form field underneath is what gets cut instead.
          title={
            <span>
              {task.title} <Tag color={TASK_STATUS_COLOR[task.status]}>{task.status}</Tag>
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
