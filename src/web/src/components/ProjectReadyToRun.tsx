import { CheckCircleFilled, PlayCircleOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Alert, Button, Spin, Typography } from 'antd';
import { api } from '../api';
import {
  projectReadyToRunQuery,
  type ProjectReadyToRunItem,
} from '../lib/queries';
import { newRunRequestToken, runRequestResend } from '../lib/runRequestToken';
import { refreshTaskScheduleViews } from '../lib/taskSchedule';
import { useToast } from '../lib/toast';

type RunToast = Pick<ReturnType<typeof useToast>, 'success' | 'error'>;

/** The one name attached to a user's press, reused only when that same request is resent. */
export interface RunReadyTaskVars {
  triggerId: string;
}

/**
 * Start one row through the same endpoint and refresh boundary as every other manual Run action.
 *
 * The project prefix includes this card's ready query, so an accepted run keeps its button in the
 * loading state until the refetch has removed the now-busy task. A refusal refreshes nothing: the
 * task is still ready according to the last successful read, and the error tells the reader why
 * the attempted transition did not happen.
 */
export function runReadyTaskMutationOptions(
  qc: QueryClient,
  message: RunToast,
  projectId: string,
  taskId: string,
) {
  return {
    ...runRequestResend,
    mutationFn: ({ triggerId }: RunReadyTaskVars) =>
      api(`/tasks/${encodeURIComponent(taskId)}/execute`, {
        method: 'POST',
        body: { triggerId },
      }),
    onSuccess: () => {
      message.success('Run started');
      return refreshTaskScheduleViews(qc, taskId, projectId);
    },
    onError: (error: Error) => message.error(error.message),
  };
}

/**
 * The project's next executable work, ordered by downstream impact.
 *
 * The old card ranked every unfinished blocker, including tasks that could not actually start,
 * and offered a chart/table toggle. This card asks a narrower, actionable question: which tasks
 * can be run now, and which of those releases the most work? Each row owns an explicit Run button
 * so opening task detail and starting work never share the same click target.
 */
export function ProjectReadyToRun({
  projectId,
  limit = 5,
}: {
  projectId: string;
  limit?: number;
}) {
  const ready = useQuery(projectReadyToRunQuery(projectId, limit));
  const data = ready.data;
  const items = Array.isArray(data?.items) ? data.items : [];

  return (
    <section aria-labelledby="project-ready-to-run-heading" style={{ marginBottom: 24 }}>
      <Typography.Title
        id="project-ready-to-run-heading"
        level={4}
        style={{ marginBottom: 8 }}
      >
        Ready to run{' '}
        {data ? (
          <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
            {data.readyCount} {data.readyCount === 1 ? 'task' : 'tasks'} · sorted by work unblocked
          </Typography.Text>
        ) : null}
      </Typography.Title>

      {ready.isLoading ? (
        <div style={{ padding: 32, textAlign: 'center' }}>
          <Spin />
        </div>
      ) : ready.isError ? (
        <Alert
          type="error"
          showIcon
          message="Ready tasks could not be read"
          description={ready.error instanceof Error ? ready.error.message : undefined}
          action={
            <Button size="small" danger onClick={() => void ready.refetch()}>
              Retry
            </Button>
          }
        />
      ) : data ? (
        <>
          {data.impactTruncated ? (
            <Alert
              style={{ marginBottom: 12 }}
              type="warning"
              showIcon
              message="Impact ranking not computed"
              description={`This project has more than ${data.impactTruncated.maxTasks} unfinished tasks, so ready tasks are shown without downstream impact ranking.`}
            />
          ) : null}

          {items.length === 0 ? (
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              No tasks are ready to run. A task appears here when its prerequisites are complete,
              it has an assigned workspace, and no run is already in flight.
            </Typography.Paragraph>
          ) : (
            <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {items.map((item) => (
                <ReadyTaskRow key={item.taskId} projectId={projectId} item={item} />
              ))}
            </ol>
          )}

          {items.length > 0 ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              All prerequisites are complete. Run a task to start it now.
            </Typography.Text>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function ReadyTaskRow({
  projectId,
  item,
}: {
  projectId: string;
  item: ProjectReadyToRunItem;
}) {
  const qc = useQueryClient();
  const message = useToast();
  const run = useMutation(runReadyTaskMutationOptions(qc, message, projectId, item.taskId));
  const impact =
    item.downstreamBlocked === null
      ? 'Ready now'
      : `Unblocks ${item.downstreamBlocked} ${item.downstreamBlocked === 1 ? 'task' : 'tasks'}`;

  return (
    <li
      className="project-ready-row"
      data-testid="ready-task-row"
      style={{
        display: 'grid',
        alignItems: 'center',
        gap: 20,
        minHeight: 68,
        padding: '10px 0',
        borderTop: '1px solid var(--border-subtle)',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div
          title={item.title}
          style={{
            color: 'var(--text-1)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            marginBottom: 4,
          }}
        >
          {item.title}
        </div>
        <Typography.Text
          type="secondary"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}
        >
          <CheckCircleFilled aria-hidden style={{ color: 'var(--success, #22a06b)' }} />
          Prerequisites complete
        </Typography.Text>
      </div>

      <Typography.Text
        className="project-ready-impact"
        type="secondary"
        style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
      >
        {impact}
      </Typography.Text>

      <Button
        className="project-ready-run"
        type="primary"
        icon={<PlayCircleOutlined />}
        loading={run.isPending}
        disabled={run.isPending}
        aria-label={`Run ${item.title}`}
        onClick={() => run.mutate({ triggerId: newRunRequestToken() })}
      >
        {run.isPending ? 'Starting' : 'Run'}
      </Button>
    </li>
  );
}
