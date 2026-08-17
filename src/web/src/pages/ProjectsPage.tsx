import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Empty, List, Spin, Tag, Typography } from 'antd';
import { Link, useParams } from 'react-router-dom';
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
}

const STATUS_COLOR: Record<Project['status'], string> = {
  OPEN: 'blue',
  DONE: 'green',
  CANCELLED: 'default',
};

// Row text, not the full goal — a project's goal can run to MAX_PROJECT_GOAL_CHARS (4,000 in
// the apiserver DTO), far past what a list row should show.
const GOAL_EXCERPT_LENGTH = 180;

function goalExcerpt(goal: string | null | undefined): string {
  const trimmed = goal?.trim();
  if (!trimmed) return 'No goal set';
  return trimmed.length > GOAL_EXCERPT_LENGTH ? `${trimmed.slice(0, GOAL_EXCERPT_LENGTH)}…` : trimmed;
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
                  description={goalExcerpt(p.goal)}
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

/** Read-only detail for one project: what it's for, how anyone would know it got there, and
 *  where its tasks stand. No row interaction and no writes — the tasks themselves aren't here. */
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
  const byStatus = Object.entries(p?.tasksByStatus ?? {});

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
        </>
      ) : null}
    </div>
  );
}
