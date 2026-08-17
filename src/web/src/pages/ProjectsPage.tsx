import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Empty, List, Spin, Tag, Typography } from 'antd';
import { api } from '../api';

interface Project {
  id: string;
  title: string;
  status: 'OPEN' | 'DONE' | 'CANCELLED';
  goal?: string | null;
  createdAt: string;
  updatedAt: string;
  _count: { tasks: number };
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
              <List.Item.Meta
                title={
                  <span>
                    {p.title} <Tag color={STATUS_COLOR[p.status]}>{p.status}</Tag>
                  </span>
                }
                description={goalExcerpt(p.goal)}
              />
              <div>{p._count.tasks} task{p._count.tasks === 1 ? '' : 's'}</div>
            </List.Item>
          )}
        />
      )}
    </div>
  );
}
