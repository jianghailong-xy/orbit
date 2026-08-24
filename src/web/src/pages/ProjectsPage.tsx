import { useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Alert, Button, Empty, Input, List, Modal, Select, Spin, Tag, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { Link, useNavigate, useParams } from 'react-router-dom';
import Markdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { ApiError, api, restoreSession } from '../api';
import { ProjectAcceptanceCard } from '../components/ProjectAcceptanceCard';
import { ProjectReadyToRun } from '../components/ProjectReadyToRun';
import { ProjectChainProgress } from '../components/ProjectChainProgress';
import {
  ProjectCoordinatorCard,
  type CoordinatorAction,
  type CoordinatorCardLayout,
} from '../components/ProjectCoordinatorCard';
import { ProjectCrossingsCard } from '../components/ProjectCrossingsCard';
import { ProjectFilingBanner } from '../components/ProjectFilingBanner';
import { ProjectGoalCard } from '../components/ProjectGoalCard';
import { ProjectReopenControl } from '../components/ProjectReopenControl';
import { ProjectSections } from '../components/ProjectSections';
import {
  BucketMeter,
  Glyph,
  PANORAMA_BUCKETS,
  ProjectPanoramaHeader,
  type ProjectPanoramaBuckets,
} from '../components/ProjectPanoramaHeader';
import { ProjectsToolbar, type ProjectFilter } from '../components/ProjectsToolbar';
import { encodeId, routeId } from '../lib/idCodec';
import { markdownToPlainText } from '../lib/markdownText';
// The one relative-time spelling this app already exports. A row that says "3h ago" and a runner
// page that says "3h ago" should not be two functions that agree by coincidence.
import { ago } from '../lib/runnerEngines';
import {
  attentionChipOf,
  projectAttentionSections,
  spotlitProjectIds,
} from '../lib/projectAttention';
import {
  projectCoordinatorStatusQuery,
  providersQuery,
  runnersQuery,
  workspacesQuery,
} from '../lib/queries';
import { type TaskDependencyGraphResponse } from '../lib/taskDependencyGraph';
import {
  RUN_AT_IMPOSSIBLE,
  runAtIso,
  runAtProblem,
  scheduledStart,
} from '../lib/taskSchedule';
import { ProjectTasksGraph } from '../components/ProjectTasksGraph';
import { remarkHardBreaks } from '../lib/remarkHardBreaks';
import { useToast } from '../lib/toast';
import { useMediaQuery } from '../lib/useMediaQuery';
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
  /** Where the project's work stands, from the endpoint's own grouped aggregate. This — not
   *  `_count.tasks`, which counts settled work alongside the rest — is what sections and orders
   *  the list; see lib/projectAttention. */
  buckets: ProjectPanoramaBuckets;
  /** The most recent write to any of its tasks, or null on a project that has none yet. */
  lastActivityAt: string | null;
}

/** What GET /projects/:id adds to a row: the long-form fields the list deliberately omits, plus
 *  the server's grouped task tally. Statuses with no tasks are absent from `tasksByStatus`
 *  entirely (it's a `groupBy`), so an empty object means "no tasks", not "counts unavailable". */
interface ProjectDetail extends Project {
  acceptanceCriteria?: string | null;
  instructions?: string | null;
  tasksByStatus?: Record<string, number>;
}

const STATUS_COLOR: Record<Project['status'], string> = {
  OPEN: 'blue',
  DONE: 'green',
  CANCELLED: 'default',
};

const STATUS_LABEL: Record<Project['status'], string> = {
  OPEN: 'Open',
  DONE: 'Completed',
  CANCELLED: 'Cancelled',
};

// Row text, not the full field — a task's acceptance criteria runs far past what a list row should
// show. Read only by the detail page's task rows now: the projects list truncates its goal with
// the box instead (see .project-row-goal), a cut that does not depend on how wide each character
// happens to be, and so gives every row of that list the same height.
const ROW_EXCERPT_LENGTH = 180;

function excerpt(text: string | null | undefined, empty: string): string {
  const trimmed = text?.trim();
  if (!trimmed) return empty;
  return trimmed.length > ROW_EXCERPT_LENGTH ? `${trimmed.slice(0, ROW_EXCERPT_LENGTH)}…` : trimmed;
}

/**
 * WHICH projects to ask for — the status filter goes on the wire, never over the loaded array.
 *
 * `?status=` has been the endpoint's own narrowing since it was written; filtering client-side
 * would mean fetching every project in order to hide most of them, and would make the list of what
 * is in progress depend on how much of the list had been loaded. 'ALL' sends no parameter at all,
 * which is how the endpoint spells "no narrowing" (see ProjectsController.parseStatus).
 */
export function projectsPath(filter: ProjectFilter): string {
  return filter === 'ALL' ? '/projects' : `/projects?status=${filter}`;
}

/** The cache entry `projectsPath(filter)` fills. The filter is PART OF THE KEY because it is part
 *  of the request: two filters are two different answers, and sharing one entry between them would
 *  show the previous filter's rows under the new filter's name. `['projects']` stays the prefix,
 *  so one invalidation after a write still refreshes every filter's entry. */
export function projectsQueryKey(filter: ProjectFilter): [string, ProjectFilter] {
  return ['projects', filter];
}

/**
 * Whether one project answers what was typed in the search box.
 *
 * Client-side on purpose: an owner has tens of projects, all of them already on this page, so a
 * round trip per keystroke would buy nothing. Title AND goal, because the goal is what a project
 * is actually recognised by once titles start to look alike.
 *
 * The goal is matched with its Markdown REMOVED, so what is searched is what the row displays: a
 * goal written as `**Ship** the new site` has to be found by "ship the new site", which the source
 * text does not contain. Blank search matches everything — an empty box is not a filter.
 */
export function matchesProjectSearch(
  project: Pick<Project, 'title' | 'goal'>,
  search: string,
): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  if (project.title.toLowerCase().includes(needle)) return true;
  return markdownToPlainText(project.goal).toLowerCase().includes(needle);
}

/**
 * Which empty this is — or null, when the list has rows to show.
 *
 * The two are different situations and must not share a sentence. "No projects yet" is a statement
 * about the account, and it is only TRUE when nothing is being narrowed: said over a search that
 * matched nothing, it tells a reader with eighteen projects that they have none, and the way out
 * (clear the search) is the one thing it does not suggest. So the create CTA belongs to the first
 * and the way back belongs to the second.
 */
export function projectsEmptyKind(
  loadedCount: number,
  matchCount: number,
  filter: ProjectFilter,
  search: string,
): 'none' | 'no-match' | null {
  if (matchCount > 0) return null;
  return loadedCount === 0 && filter === 'ALL' && search.trim() === '' ? 'none' : 'no-match';
}

/** What the no-match empty says: whichever narrowing is responsible, named back to the reader. The
 *  search wins when both are on, because it is the one that was just typed. */
export function noMatchDescription(filter: ProjectFilter, search: string): string {
  const term = search.trim();
  if (term) return `No projects match “${term}”`;
  return filter === 'OPEN' ? 'No projects are in progress' : 'No completed projects';
}

/** Index of the signed-in user's projects: search and status filter above, then the four sections
 *  in attention order — what has stalled, what only needs closing, what is already running, what
 *  is finished and folded — and a way to start one from either the toolbar or an empty page. */
export function ProjectsPage() {
  const [filter, setFilter] = useState<ProjectFilter>('ALL');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const projects = useQuery({
    queryKey: projectsQueryKey(filter),
    queryFn: () => api<Project[]>(projectsPath(filter)),
  });
  const matches = useMemo(
    () => (projects.data ?? []).filter((p) => matchesProjectSearch(p, search)),
    [projects.data, search],
  );
  // Stalled, Wrapping up, In progress, Completed — in that order, off the buckets and
  // `lastActivityAt` every row carries. The rules and the reason for that order live in
  // lib/projectAttention; the server's unrendered `createdAt desc` no longer orders anything here.
  const sections = useMemo(() => projectAttentionSections(matches), [matches]);
  // The two biggest piles of startable work nobody is starting — the head of Stalled — get a wash
  // of amber behind them. Two and no more: see spotlitProjectIds for why a tint that covers a
  // whole section stops being a signal.
  const spotlit = useMemo(() => spotlitProjectIds(sections), [sections]);
  // ONE instant for the whole render, read here rather than per row: the badges are ages, and two
  // rows reading the clock a millisecond apart could land either side of a day boundary and
  // disagree about how long the same silence has been. Re-read on every render, so a page left
  // open does not keep reporting the age it had when it mounted.
  const now = Date.now();
  const empty = projectsEmptyKind(projects.data?.length ?? 0, matches.length, filter, search);

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <Typography.Title level={2} className="page-title">
        Projects
      </Typography.Title>

      {/* Above the loading/error branches, not inside the loaded one: the search box and the
          filter are how a slow or failed read is retried differently, and a toolbar that appears
          only once rows do would take the controls away exactly when they are needed. */}
      <ProjectsToolbar
        search={search}
        onSearchChange={setSearch}
        filter={filter}
        onFilterChange={setFilter}
        onNewProject={() => setCreating(true)}
      />
      <NewProjectModal open={creating} onClose={() => setCreating(false)} />

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
      ) : empty === 'none' ? (
        // The account has nothing at all — so the page's job is not to report that, it is to
        // offer the one thing a reader can do about it. A description with no control under it is
        // where a new owner's first visit used to end.
        <Empty description="No projects yet" style={{ marginTop: 48 }}>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
            New project
          </Button>
        </Empty>
      ) : empty === 'no-match' ? (
        // The projects exist; this view is hiding them. No create CTA here — a project is not what
        // this reader is missing — just the sentence naming what narrowed the list, and the way
        // back out of it.
        <Empty description={noMatchDescription(filter, search)} style={{ marginTop: 48 }}>
          <Button
            onClick={() => {
              setSearch('');
              setFilter('ALL');
            }}
          >
            {search.trim() ? 'Clear search' : 'Show all projects'}
          </Button>
        </Empty>
      ) : (
        <ProjectSections
          sections={sections}
          renderProject={(p) => {
            // The same field the detail page renders as Markdown, degraded to the line it reads
            // as — a row that shows `## 现状缺口` or `**一个依赖字段都没有**` is showing source,
            // not a goal. Not sliced to a character count: how many rendered lines 180 characters
            // occupy depends on how much of them is CJK, which is what had these rows jumping
            // between one and three lines. The box truncates instead (see .project-row-goal).
            const goal = markdownToPlainText(p.goal) || 'No goal set';
            // What is WRONG with this row, past which section it landed in — how long it has been
            // quiet, or that it is finished and still open. Null on most rows, which is the point
            // (see attentionChipOf).
            const chip = attentionChipOf(p, now);
            return (
              <List.Item
                className={`project-row${spotlit.has(p.id) ? ' project-row-spotlit' : ''}`}
                style={{ padding: '11px 10px' }}
              >
                {/* One link spanning the whole row — meta and count alike — so the entire row is a
                    single click and a single tab stop, rather than a title-sized target with dead
                    space either side. The short public id, never the raw UUID: the same spelling
                    every other link in the app is built with (see encodeId). */}
                <Link
                  to={`/projects/${encodeURIComponent(encodeId(p.id))}`}
                  className="project-row-link"
                >
                  <div className="project-row-main">
                    <div className="project-row-head">
                      <span className="project-row-title">{p.title}</span>
                      {chip ? (
                        <span className={`project-row-chip project-row-chip-${chip.tone}`}>
                          {chip.text}
                        </span>
                      ) : null}
                      <Tag color={STATUS_COLOR[p.status]}>{p.status}</Tag>
                    </div>
                    <div className="project-row-goal">{goal}</div>
                  </div>
                  <ProjectRowMeter buckets={p.buckets} />
                  {/* Furthest right, and the smaller of the two: when the project last moved is
                      what orders a list by attention, and how many tasks it holds is scale — kept
                      because a 6-blocked project and a 6,118-blocked one are not the same project,
                      and demoted because it was never the number to act on. */}
                  <div className="project-row-when">
                    <span className="project-row-activity">
                      {p.lastActivityAt ? ago(p.lastActivityAt, now) : 'No activity'}
                    </span>
                    <span className="project-row-count">
                      {p._count.tasks.toLocaleString('en-US')} task{p._count.tasks === 1 ? '' : 's'}
                    </span>
                  </div>
                </Link>
              </List.Item>
            );
          }}
        />
      )}
    </div>
  );
}

/**
 * Where one project's work stands, as a 6px bar and the four figures behind it.
 *
 * Everything about the buckets — which four, in what order, which shape and which token — comes
 * from `PANORAMA_BUCKETS`, the table the project page's own header is drawn from. Not copied:
 * imported, so a bucket that is amber there cannot be anything else here, and the meter is that
 * page's `BucketMeter` at a row's height rather than a second bar that agrees for now.
 *
 * COLOUR IS NOT CARRYING ANY OF THIS ALONE. Amber `--warning-solid` and neutral `--text-3` sit at
 * 2.32:1 and 2.94:1 against the row's background — below the 3:1 a non-text channel needs — so
 * each bucket brings its shape and its number too, and the bar, which has room for neither, spells
 * all four numbers into its `aria-label`.
 *
 * A bucket at zero draws no segment and prints no figure: this list is read to find the project
 * that is stuck, and a zero drawn as a hairline of colour is the value hardest to un-see.
 */
function ProjectRowMeter({ buckets }: { buckets: ProjectPanoramaBuckets }) {
  return (
    <div className="project-row-meter">
      <BucketMeter buckets={buckets} height={6} />
      {/* `aria-hidden` because the bar directly above already reads out all four numbers, named:
          this line is the same fact for the eye, and a screen reader should hear it once. The
          shape is what tells a reader which bucket a figure belongs to, and `title` names it for
          a pointer. */}
      <div className="project-row-buckets" aria-hidden="true">
        {PANORAMA_BUCKETS.filter((bucket) => buckets[bucket.key] > 0).map((bucket) => (
          <span key={bucket.key} title={bucket.label}>
            <Glyph shape={bucket.glyph} color={bucket.color} size={8} />
            <b>{buckets[bucket.key].toLocaleString('en-US')}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * What the New project form holds while it is being filled in.
 *
 * Two fields, and deliberately not four. A project's acceptance criteria and instructions are long
 * prose read as prompts, edited on the project's own page beside what they are about; asking for
 * them at the moment somebody is naming a project would turn "start something" into a form.
 */
export interface NewProjectDraft {
  title: string;
  goal?: string;
}

/** A form with nothing filled in — what the dialog opens on, and what it returns to on success. */
export const EMPTY_NEW_PROJECT_DRAFT: NewProjectDraft = { title: '' };

/** Whether the dialog's Create button may fire. A title of nothing but spaces names a project
 *  nobody can find again — and is what the server's own `@MinLength(1)` refuses, which the trim in
 *  `newProjectBody` is what makes reachable. Exported and total, because the button itself lives
 *  behind a portal that a static render produces no markup for. */
export function canCreateProject(draft: NewProjectDraft): boolean {
  return draft.title.trim().length > 0;
}

/** The body `POST /projects` is given. A goal of nothing but spaces is sent as no goal at all
 *  rather than as an empty string: blank and absent must not be two different stored states (the
 *  same rule UpdateProjectDto states for clearing one). */
export function newProjectBody(draft: NewProjectDraft): Record<string, string> {
  const body: Record<string, string> = { title: draft.title.trim() };
  const goal = draft.goal?.trim();
  if (goal) body.goal = goal;
  return body;
}

export function createProject(draft: NewProjectDraft): Promise<Project> {
  return api<Project>('/projects', { method: 'POST', body: newProjectBody(draft) });
}

/** What a newly created project changes. `['projects']` is the PREFIX of every filter's entry, so
 *  this refreshes the list under whichever filter is showing and the ones that are not — a project
 *  created while Completed is selected must not be missing from All when it is switched back to. */
export function invalidateAfterProjectCreate(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: ['projects'] });
}

/** The New project form's fields, in one state. Exported for the reason NewProjectTaskForm is: an
 *  antd Modal renders through a portal, which a static render produces no markup at all for, so
 *  the body has to be mountable on its own to be assertable at all. */
export function NewProjectForm({
  draft,
  onChange,
  error,
  pending,
}: {
  draft: NewProjectDraft;
  onChange: (draft: NewProjectDraft) => void;
  error?: Error | null;
  pending?: boolean;
}) {
  return (
    <>
      <FormRow label="Title">
        <Input
          autoFocus
          value={draft.title}
          disabled={pending}
          onChange={(e) => onChange({ ...draft, title: e.target.value })}
          placeholder="What this project is called"
        />
      </FormRow>
      <FormRow label="Goal">
        <Input.TextArea
          rows={3}
          value={draft.goal ?? ''}
          disabled={pending}
          onChange={(e) => onChange({ ...draft, goal: e.target.value })}
          placeholder="Optional. What this project is trying to achieve."
        />
      </FormRow>

      {/* The server's own message, inline and verbatim — see NewProjectTaskForm's note on why
          there is no second Retry control beside it. */}
      {error ? (
        <Alert
          type="error"
          showIcon
          message="Project could not be created"
          description={error.message}
        />
      ) : null}
    </>
  );
}

/** The New project dialog: a name, optionally what it is for, and nothing else. */
export function NewProjectModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<NewProjectDraft>(EMPTY_NEW_PROJECT_DRAFT);
  const create = useMutation({
    mutationFn: (values: NewProjectDraft) => createProject(values),
    onSuccess: () => {
      setDraft(EMPTY_NEW_PROJECT_DRAFT);
      onClose();
      invalidateAfterProjectCreate(qc);
    },
  });

  return (
    <Modal
      title="New project"
      open={open}
      // Cancel keeps what was typed and drops a failed attempt's error — the same bargain the New
      // task dialog strikes, for the same reason.
      onCancel={() => {
        create.reset();
        onClose();
      }}
      onOk={() => create.mutate(draft)}
      okText="Create project"
      confirmLoading={create.isPending}
      okButtonProps={{ disabled: !canCreateProject(draft) }}
    >
      <NewProjectForm
        draft={draft}
        onChange={setDraft}
        error={create.error}
        pending={create.isPending}
      />
    </Modal>
  );
}

/** One long-form field. Shown in full and with the author's own line breaks preserved. */
function Field({ label, text, empty }: { label: string; text?: string | null; empty: string }) {
  const body = text?.trim();
  return (
    <div style={{ marginBottom: 24 }}>
      <Typography.Title level={5}>{label}</Typography.Title>
      {/* Instructions are written the way task descriptions are — headings, lists, fenced
          commands — and are handed to a coordinator as a prompt, so read them as Markdown rather
          than source. `remarkHardBreaks` preserves the hand-laid-out lines. react-markdown is used
          directly because the transcript's `MD` carries session attachment/link resolution. */}
      {body ? (
        <div className="md">
          <Markdown remarkPlugins={[remarkGfm, remarkHardBreaks]} rehypePlugins={[rehypeHighlight]}>
            {body}
          </Markdown>
        </div>
      ) : (
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          {empty}
        </Typography.Paragraph>
      )}
    </div>
  );
}

/** Where the command centre stops having enough room for four readable work buckets beside the
 *  coordinator. Kept identical to `.project-command-center` in index.css. */
const PROJECT_COMMAND_NARROW_QUERY = '(max-width: 920px)';

/** Read-only detail for one project: what it's for, how anyone would know it got there, and where
 *  its tasks stand — down to a row per top-level task, and from there down to whichever levels
 *  the reader opens. Still no writes: every row is read-only, however deep it sits. */
export function ProjectDetailPage() {
  const params = useParams();
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
  const narrow = useMediaQuery(PROJECT_COMMAND_NARROW_QUERY);

  return (
    // 1040 rather than the list page's 900: the panorama's middle row is two cards side by side,
    // and the ranking bars in the left one stop being readable at half of 900.
    <div style={{ maxWidth: 1040, margin: '0 auto' }}>
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
          {/* Project identity gets one quiet row of its own. The old head put a tall Coordinator
              card beside two lines of title metadata, creating a large dead rectangle under the
              title. The stable goal now frames the page, followed by a balanced command centre
              for changing work state and the way to act on it. */}
          <header className="project-detail-identity">
            <Typography.Title level={2} className="page-title">
              {p.title}
            </Typography.Title>
            <div className="project-detail-meta">
              <Tag color={STATUS_COLOR[p.status]}>{STATUS_LABEL[p.status]}</Tag>
              <span>
                {p._count.tasks} task{p._count.tasks === 1 ? '' : 's'}
              </span>
            </div>
          </header>

          {/* The stable definition of the project comes before its changing execution state. A
              long brief stays complete here; its full Markdown remains the one source rather than
              being hidden behind a disclosure or repeated below the graph. */}
          <ProjectGoalCard goal={p.goal} />

          {/* One command centre, two responsibilities: the work account establishes context on
              the left, then the coordinator offers the primary human action on the right. On
              narrow screens they remain in this reading/focus order and stack full-width. */}
          <div className="project-command-center">
            <ProjectPanoramaHeader projectId={id} projectStatus={p.status} />
            {/* A grouped tally omits zero-valued statuses. Preserve "payload absent" as unknown,
                but turn a present map with no OPEN row into the honest zero the card can say. */}
            <ProjectCoordinatorSection
              projectId={id}
              layout={narrow ? 'narrow' : 'desktop'}
              openTaskCount={p.tasksByStatus ? (p.tasksByStatus.OPEN ?? 0) : undefined}
            />
          </div>

          {/* Directly under the counts it is the picture of, so the graph lands where a reader is
              already looking. Every project gets one, at any size: the section draws whatever the
              graph endpoint serves and says so when the server truncates. */}
          <ProjectTasksGraph projectId={id} />

          {/* Draws nothing at all unless this project is a chain: it reads the same shape the
              header above does and returns null for a mesh, so the strip is not something this
              page decides to show — it is something a chain-shaped project has. */}
          <ProjectChainProgress projectId={id} />

          {/* After the graph and its chain-specific reading, this queue turns that context into
              action. Full width, on its own, and ordered by how much downstream work each
              runnable task releases. */}
          <ProjectReadyToRun projectId={id} />

          {/* The criteria live HERE and nowhere else on this page. There used to be a
              `Field label="Acceptance criteria"` in this slot as well as the card below the task
              list, and the server parses one criterion out of every non-blank line of that same
              field — so the two were always the same sentences, and only the lower one carried the
              verdicts. One section now carries both, in the slot the stated criteria always had:
              after the goal, above the plan, and above the task list rather than buried under it,
              because "did it meet its bar" outranks "how far along is it". */}
          <ProjectAcceptanceCard projectId={id} />

          <Field label="Instructions" text={p.instructions} empty="No instructions set" />

          {/* The same tasks the graph above draws, as an indented topological plan — and the only
              one of the two that is exact at any size. Inside this branch on purpose: the tasks
              page is only asked for once the project it belongs to came back, so a project that
              404s never puts a second doomed request on the wire. `id` is the normalized route id
              — the same spelling the project query above is keyed and fetched with. */}
          <ProjectTasks projectId={id} />

          {/* Unit L7. Siblings of everything above, on the same terms: a crossings queue that
              500s costs the reader that card and leaves the page standing. Below the coordinator
              because both are things a PERSON answers, and §7 RB2 is explicit that these two are
              the person's alone — no coordinator signs a crossing for another goal, and none
              reopens a settled project on its own. */}
          <ProjectCrossingsCard projectId={id} />
          <ProjectReopenControl projectId={id} />
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

/** Where a resolved coordinator is read. Through `encodeId`, like every other link in the app, so
 *  a response carrying the raw UUID and one carrying the short public id land on one route. */
export const coordinatorSessionPath = (sessionId: string): string =>
  `/sessions/${encodeURIComponent(encodeId(sessionId))}`;

/**
 * Resolve-or-create this project's one coordinator session.
 *
 * A POST every time, including from a project whose status read already names a coordinator. The
 * pointer it carries can be stale — the session behind it may since have gone to Trash — and the
 * server is what notices and replaces it, handing back the live conversation. Following
 * `coordination.sessionId` straight to a route would skip that repair and land the reader inside
 * Trash.
 *
 * The body is `{}` rather than nothing: `workspaceId` is what picks where a FIRST coordinator
 * opens, and this unit deliberately has no picker, so it sends none and lets the server's own
 * fallback answer — down to its 400 when even that has nothing to go on, which names the two
 * things a reader can actually do about it.
 */
export function openProjectCoordinator(projectId: string): Promise<CoordinatorResult> {
  return api<CoordinatorResult>(`/projects/${encodeURIComponent(projectId)}/coordinator`, { method: 'POST', body: {} });
}

/**
 * The Coordinator, as the project header's right-hand column.
 *
 * Self-contained on the same terms as every other card on this page: it runs its own read, draws
 * its own loading and failure, and a status endpoint that 500s costs the reader the coordinator
 * and nothing else. Exported because a static render cannot press a button — mounting this
 * directly is the only way to assert what each press does.
 *
 * WHAT IT ADDS to the card it wraps is the three things a presentational component cannot do: the
 * POST, the navigation, and the one sentence the POST's answer can force. Everything about which
 * of the four states is on screen is the card's, and everything about what a press COSTS is here.
 */
export function ProjectCoordinatorSection({
  projectId,
  layout,
  openTaskCount,
}: {
  projectId: string;
  layout: CoordinatorCardLayout;
  /** Open tasks in this project — the card says what the conversation is FOR, and the status
   *  payload deliberately carries no task tally. */
  openTaskCount?: number;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [rebinding, setRebinding] = useState(false);
  const status = useQuery(projectCoordinatorStatusQuery(projectId));

  const open = useMutation({
    mutationKey: ['project', projectId, 'coordinator'],
    mutationFn: async () => {
      // Read BEFORE the press, because afterwards it is gone: `created` alone cannot tell a FIRST
      // coordinator from a REPLACEMENT for one that went to Trash, and only the second costs the
      // reader a conversation. The pair does tell them apart.
      const bound = status.data?.coordination.sessionId != null;
      return { ...(await openProjectCoordinator(projectId)), bound };
    },
    onSuccess: (result) => {
      // The id navigated to is the SERVER's, never the pointer the status read arrived with: on a
      // trashed binding those are two different sessions and only the returned one is live.
      navigate(coordinatorSessionPath(result.sessionId));
      if (result.bound && result.created) {
        // The one case where following the button lands somewhere other than where the reader was
        // going. Said on the way in rather than left to be discovered from an empty transcript.
        toast.warning(
          'This is a NEW coordinator conversation — the previous one was gone, and its history did not come with it.',
        );
      }
    },
  });

  const failure = open.error;
  const unavailable = isCoordinatorUnavailable(failure);
  // Where the reader is sent to repair a landing. The BOUND workspace, not the landing the status
  // proposed: `COORDINATOR_UNAVAILABLE` is a refusal ABOUT the workspace this project is tied to,
  // and on `WORKSPACE_FORGOTTEN` there is no id left to send anyone to.
  const boundWorkspaceId = status.data?.coordination.workspaceId ?? null;

  const restore = useMutation({
    mutationFn: async () => {
      const sessionId = status.data?.coordination.sessionId;
      if (!sessionId) throw new Error('There is no conversation left to restore.');
      return restoreSession(sessionId);
    },
    // The project's own document names the pointer this just brought back, so both entries under
    // `['project', id]` are refreshed by the one invalidation.
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project', projectId] }),
  });

  const act = (action: CoordinatorAction): void => {
    switch (action) {
      case 'open':
      case 'start':
        open.mutate();
        return;
      // Both are "this project's coordinator should open somewhere else", which is one write.
      case 'change-workspace':
      case 'rebind-workspace':
        setRebinding(true);
        return;
      // The workspace itself is what is broken; it is repaired where it is configured.
      case 'enable-workspace':
      case 'restore-workspace':
      case 'bind-workspace':
        if (boundWorkspaceId) navigate(`/workspaces/${encodeURIComponent(encodeId(boundWorkspaceId))}`);
        return;
      case 'restore-session':
        restore.mutate();
    }
  };

  return (
    <div
      className="project-command-coordinator"
      style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
    >
      {status.isPending ? (
        <div
          aria-label="Coordinator"
          style={{
            boxSizing: 'border-box',
            width: '100%',
            height: '100%',
            minHeight: 220,
            padding: 32,
            textAlign: 'center',
            background: 'var(--bg-raised)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 10,
          }}
        >
          <Spin />
        </div>
      ) : status.isError ? (
        // A READ that failed, which is the one thing here Retry is the right answer to.
        <Alert
          type="error"
          showIcon
          message="Coordinator could not be read"
          description={status.error instanceof Error ? status.error.message : undefined}
          action={
            <Button size="small" danger onClick={() => status.refetch()}>
              Retry
            </Button>
          }
        />
      ) : (
        <>
          <ProjectCoordinatorCard
            status={status.data}
            layout={layout}
            openTaskCount={openTaskCount}
            onAction={act}
          />
          {/* A press that was refused. `COORDINATOR_UNAVAILABLE` is a property of committed rows,
              so the same press returns the same 409 forever — it gets the two writes that can
              actually change the answer instead of a Retry that cannot. */}
          {failure ? (
            <Alert
              type="error"
              showIcon
              message={unavailable ? 'The coordinator cannot be opened' : 'Coordinator could not be opened'}
              description={failure.message}
              action={
                unavailable ? (
                  <Button size="small" onClick={() => setRebinding(true)}>
                    Rebind workspace…
                  </Button>
                ) : (
                  <Button size="small" danger onClick={() => open.mutate()}>
                    Retry
                  </Button>
                )
              }
            />
          ) : null}
          {restore.error ? (
            <Alert type="error" showIcon message="Could not restore" description={restore.error.message} />
          ) : null}
        </>
      )}

      {rebinding ? (
        <CoordinatorRebindDialog
          projectId={projectId}
          currentWorkspaceId={boundWorkspaceId}
          onClose={() => setRebinding(false)}
        />
      ) : null}
    </div>
  );
}

/** The refusal this page answers with a repair instead of a Retry. Read off the machine `code`
 *  the server sent, never the prose: 409 is several different refusals and only this one is
 *  fixed by moving the project's coordination workspace. */
export const COORDINATOR_UNAVAILABLE = 'COORDINATOR_UNAVAILABLE';

export function isCoordinatorUnavailable(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.code === COORDINATOR_UNAVAILABLE;
}

/** What POST /projects/:id/coordinator/rebind answers with. `moved` is false when the project
 *  already recorded this landing — a replay writes nothing. */
export interface CoordinatorRebindResult {
  projectId: string;
  coordinatorWorkspaceId: string;
  coordinatorSessionId: string | null;
  moved: boolean;
}

/**
 * Move where this project's coordinator opens.
 *
 * The verb behind every `COORDINATOR_UNAVAILABLE`, whose `requiredAction` has always read "rebind
 * this project's coordination workspace, then open the coordinator again". It writes the landing
 * and nothing else — not the session pointer, which is a rotation, and not the coordinator
 * identity — so a project with a live conversation keeps it and opens the NEXT one elsewhere.
 */
export function rebindProjectCoordinator(
  projectId: string,
  workspaceId: string,
): Promise<CoordinatorRebindResult> {
  return api<CoordinatorRebindResult>(`/projects/${encodeURIComponent(projectId)}/coordinator/rebind`, { method: 'POST', body: { workspaceId } });
}

/** Pick the workspace this project's coordinator opens in. Mounted only while open, so a project
 *  page that nobody rebinds never asks for the workspace list. */
function CoordinatorRebindDialog({
  projectId,
  currentWorkspaceId,
  onClose,
}: {
  projectId: string;
  currentWorkspaceId: string | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const workspaces = useQuery(workspacesQuery());
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const rebind = useMutation({
    mutationFn: (workspaceId: string) => rebindProjectCoordinator(projectId, workspaceId),
    onSuccess: () => {
      // Both the project document and the status read live under this prefix, and the refusal the
      // card is showing is decided by the row this just wrote.
      void qc.invalidateQueries({ queryKey: ['project', projectId] });
      onClose();
    },
  });

  return (
    <Modal
      open
      title="Rebind coordination workspace"
      okText="Rebind"
      okButtonProps={{ disabled: !picked, loading: rebind.isPending }}
      onOk={() => picked && rebind.mutate(picked)}
      onCancel={onClose}
    >
      <Typography.Paragraph type="secondary">
        The coordinator opens in this workspace from now on. The conversation already recorded is
        left where it is — this decides where the NEXT one opens.
      </Typography.Paragraph>
      <Select
        style={{ width: '100%' }}
        placeholder="Workspace"
        loading={workspaces.isPending}
        value={picked}
        onChange={setPicked}
        options={(workspaces.data ?? []).map((w: { id: string; name: string }) => ({
          value: w.id,
          label: w.id === currentWorkspaceId ? `${w.name} (current)` : w.name,
        }))}
      />
      {rebind.error ? (
        <Alert
          style={{ marginTop: 12 }}
          type="error"
          showIcon
          message="Could not rebind"
          description={rebind.error.message}
        />
      ) : null}
    </Modal>
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
  /** Prerequisites that are neither DONE nor CANCELLED — what this task is still waiting on. */
  unmetCount: number;
  /** Tasks that name this one as a prerequisite: what finishing it would release. */
  blocksCount: number;
  /** Longest prerequisite path to this task INSIDE this project. A source sits at 0, and tasks
   *  sharing a level share the property this list is sorted to show: they can run in parallel. */
  topoLevel: number;
  /** The same three words the task list uses, with `NONE` collapsed onto `READY` by the endpoint —
   *  a task nothing holds back and a task with no prerequisites at all read identically here. */
  dependencyState: 'READY' | 'BLOCKED' | 'BLOCKED_FAILED';
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
 * The same status, carried by a SHAPE rather than by colour alone.
 *
 * Four shapes for four statuses, spelled the way the panorama header's KPI row spells its four —
 * disc, triangle, square, check — so a reader moving between the two surfaces is not learning a
 * second vocabulary. Blocked-ness deliberately gets no fifth shape: it is already said in words by
 * the `waits N` badge, and a mark that meant two things at once would say neither.
 */
type TaskStatusGlyph = 'disc' | 'triangle' | 'square' | 'check';

const TASK_STATUS_MARK: Record<ProjectTask['status'], { glyph: TaskStatusGlyph; color: string }> = {
  IN_PROGRESS: { glyph: 'disc', color: 'var(--brand)' },
  OPEN: { glyph: 'triangle', color: 'var(--warning-solid)' },
  DONE: { glyph: 'check', color: 'var(--success)' },
  CANCELLED: { glyph: 'square', color: 'var(--text-3)' },
};

/** `aria-hidden` on purpose: the row's own status Tag already spells the status out, so a second
 *  reading of it is noise. The shape is here for the eye — the text is what the screen reader
 *  gets. `data-glyph` is what makes the four marks tellable apart without reading their colour. */
function TaskStatusMark({ status }: { status: ProjectTask['status'] }) {
  const { glyph, color } = TASK_STATUS_MARK[status];
  return (
    <svg
      data-glyph={glyph}
      width={12}
      height={12}
      viewBox="0 0 12 12"
      aria-hidden="true"
      focusable="false"
      style={{ color, flex: 'none' }}
    >
      {glyph === 'disc' ? (
        <circle cx="6" cy="6" r="5" fill="currentColor" />
      ) : glyph === 'triangle' ? (
        <polygon points="2.5,1 11,6 2.5,11" fill="currentColor" />
      ) : glyph === 'square' ? (
        <rect
          x="1.5"
          y="1.5"
          width="9"
          height="9"
          rx="1.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        />
      ) : (
        <path
          d="M1.5 6.4 L4.6 9.5 L10.5 2.6"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

/** One band of the list: the tasks sharing a topological level, or the trailing bucket of finished
 *  work. `level` is null only on that bucket, which is what the render dims. */
export interface ProjectTaskGroup {
  key: string;
  level: number | null;
  heading: string;
  tasks: ProjectTask[];
}

/**
 * One page of tasks, banded by topological level.
 *
 * The bands are the whole point and they say exactly one thing: everything inside a band can run
 * at the same time. Level 0 is what is not waiting on anything in this project; level N is what
 * cannot start until level N-1 has landed. Creation order — the axis this list used to be sorted
 * on — says nothing a reader can act on, and a parent/child tree says something else entirely
 * (what a task is PART OF, not when it can run), which is why neither is the axis any more.
 *
 * Order inside a band is the server's, untouched: this function only partitions, it never sorts
 * rows, so whatever the page decided is what a reader sees.
 *
 * DONE tasks leave their level and collect at the end. A finished task's level is a fact about a
 * graph that has already moved past it, and leaving it in a band would pad "what can run now" with
 * work that already ran.
 */
export function projectTaskGroups(items: ProjectTask[]): ProjectTaskGroup[] {
  const byLevel = new Map<number, ProjectTask[]>();
  const done: ProjectTask[] = [];
  for (const task of items) {
    if (task.status === 'DONE') {
      done.push(task);
      continue;
    }
    const band = byLevel.get(task.topoLevel);
    if (band) band.push(task);
    else byLevel.set(task.topoLevel, [task]);
  }

  const groups: ProjectTaskGroup[] = [...byLevel.entries()]
    .sort(([a], [b]) => a - b)
    .map(([level, tasks]) => ({
      key: `level-${level}`,
      level,
      // "ready" is a fact about the graph — nothing in this project is holding these up. It is not
      // a fact about what happens next, and the heading must not let it be read as one: tasks here
      // are dispatched by the coordinator (dispatch_authority COORDINATOR), the auto-run sweep
      // takes only LEGACY and stands down on these, so a level 0 band left alone runs never. The
      // page head's coordinator card makes the same claim from the other side — "tasks never start
      // on their own" — and these two sentences have to keep agreeing.
      heading:
        level === 0
          ? 'Level 0 · ready — the coordinator starts these'
          : `Level ${level} · waits on level ${level - 1}`,
      tasks,
    }));
  if (done.length > 0) groups.push({ key: 'done', level: null, heading: 'Done', tasks: done });
  return groups;
}

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
 *
 * Exported for tests, on the same terms as ProjectTaskLevel: mounting the section on its own is
 * what lets a page of tasks be handed in directly, without a project document standing in front
 * of it deciding whether the section renders at all.
 */
export function ProjectTasks({ projectId }: { projectId: string }) {
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
          {projectTaskGroups(tasks.data.items).map((group) => (
            // The finished band is dimmed rather than dropped: it is still the answer to "did that
            // land?", just not to "what can run now", which is what the levels above it answer.
            <div key={group.key} style={group.level === null ? { opacity: 0.55 } : undefined}>
              <div
                data-topo-group={group.key}
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  justifyContent: 'space-between',
                  gap: 16,
                  marginTop: 16,
                }}
              >
                <Typography.Text strong={group.level !== null} type="secondary">
                  {group.heading}
                </Typography.Text>
                <Typography.Text type="secondary">
                  {group.tasks.length} task{group.tasks.length === 1 ? '' : 's'}
                </Typography.Text>
              </div>
              <List
                dataSource={group.tasks}
                rowKey="id"
                renderItem={(t) => <ProjectTaskRow projectId={projectId} task={t} />}
              />
            </div>
          ))}
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
              <TaskStatusMark status={task.status} /> {task.title}{' '}
              <Tag color={TASK_STATUS_COLOR[task.status]}>{task.status}</Tag>
              {/* Both badges are omitted at zero rather than shown as `waits 0`. Most rows in a
                  real project have nothing on either side, and a list where every row carries two
                  zeroes is a list where the rows that do carry a number stop standing out. */}
              {task.unmetCount > 0 ? <Tag color="gold">waits {task.unmetCount}</Tag> : null}
              {task.blocksCount > 0 ? <Tag color="blue">blocks {task.blocksCount}</Tag> : null}
              {/* The one thing a tree could never say. `waits 3` names a count; WHICH three is
                  what a reader has to know to go unblock them, and on a hand-drawn graph it is
                  exactly where the escape lines get drawn. Only for two or more: at one, the
                  prerequisite is a click away and a second request per row is not worth it. */}
              {task.unmetCount >= 2 ? <ProjectTaskPrerequisites task={task} /> : null}
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
 * WHICH prerequisites a multi-prerequisite row is still waiting on, named inline.
 *
 * Mounted only by a row with two or more unmet prerequisites, and that placement is the budget:
 * a query registers when the component renders, so the rows that need nothing extra cost nothing
 * extra — no `enabled: false` entry sitting in the cache for the ~82% of tasks that wait on one
 * prerequisite or none.
 *
 * One level up, and only one: `maxDepth=1` asks for the direct prerequisites, which is what
 * "waiting on" means here. Anything further is the dependency graph's job, not a row's.
 *
 * Every state but "answered" renders nothing at all. The `waits N` badge beside this has already
 * told the reader the count; a spinner or an error strip inside a list row would be a second thing
 * to read for information the row is not really missing.
 */
function ProjectTaskPrerequisites({ task }: { task: ProjectTask }) {
  const graph = useQuery({
    queryKey: ['task', task.id, 'prerequisites'],
    queryFn: () =>
      api<TaskDependencyGraphResponse>(
        `/tasks/${encodeURIComponent(encodeId(task.id))}/dependency-graph?direction=upstream&maxDepth=1`,
      ),
  });

  // Read off the EDGES, not off `depth` or `isDirect`: an edge is the relationship itself, so
  // "source of an edge whose target is the focus" cannot mean anything but a direct prerequisite.
  // The focus is taken from the response rather than from `task.id` so the two ids being compared
  // always came from the same payload, whichever spelling of them the server is handing out.
  const waitingOn = useMemo(() => {
    if (!graph.data) return [];
    const byId = new Map(graph.data.nodes.map((node) => [node.id, node]));
    return graph.data.edges
      .filter((edge) => edge.targetTaskId === graph.data.focusTaskId)
      .map((edge) => byId.get(edge.sourceTaskId))
      .filter((node) => node && node.status !== 'DONE' && node.status !== 'CANCELLED')
      .map((node) => node!.title);
  }, [graph.data]);

  if (waitingOn.length === 0) return null;
  // The count comes from the page payload and the titles from the graph, so they can disagree —
  // a server that collapsed a branch, or a graph read a moment later than the page. Saying how
  // many are unaccounted for is the honest version; silently listing four of six is not.
  const missing = task.unmetCount - waitingOn.length;
  return (
    <Typography.Text type="secondary">
      {' → '}
      {waitingOn.join(', ')}
      {missing > 0 ? `, +${missing} more` : ''}
    </Typography.Text>
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
 * Presentational and exported for the same reason ProjectTaskLevel is — and here it is also the
 * only way: an antd Modal renders through a portal, which a static render produces no markup at
 * all for, so the body has to be mountable on its own to be assertable at all.
 *
 * It does read its own option sources rather than take them as props. They are the same three the
 * task panel's pickers use, at the same keys: the owner's workspaces, the configured (BYOK)
 * providers, and the model catalogue the assignee's runner reported — model ids are per-machine,
 * which is why they come from that runner rather than from a table.
 */
export function NewProjectTaskForm({
  projectId,
  draft,
  onChange,
  error,
  pending,
}: {
  /** Unit L7 / AC1: where this create files. Required, not optional — a form that can be rendered
   *  without saying where the work lands is the form the incident was submitted through. */
  projectId: string;
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
      {/* Above the first field, not beside the submit button: the answer to "which project is
          this going into" has to be visible while the form is being FILLED IN, which is when the
          reader still has a cheap way to change their mind. */}
      <ProjectFilingBanner projectId={projectId} />
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
        projectId={projectId}
        draft={draft}
        onChange={setDraft}
        error={create.error}
        pending={create.isPending}
      />
    </Modal>
  );
}
