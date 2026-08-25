import {
  ArrowRightOutlined,
  CheckCircleFilled,
  ClockCircleOutlined,
  LoadingOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Alert, Button, Popconfirm, Spin, Tag, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { encodeId } from '../lib/idCodec';
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

export interface ResumePausedListVars {
  listId: string;
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

/** Resume the whole owning list, then refresh every task surface whose dispatch gates changed. */
export function resumePausedListMutationOptions(
  qc: QueryClient,
  message: RunToast,
  projectId: string,
) {
  return {
    mutationFn: ({ listId }: ResumePausedListVars) =>
      api(`/task-lists/${encodeURIComponent(listId)}`, {
        method: 'PATCH',
        body: {
          paused: false,
          note: 'Resumed from the project Run queue',
        },
      }),
    onSuccess: () => {
      message.success('Task list resumed');
      return Promise.all([
        qc.invalidateQueries({ queryKey: ['project', projectId] }),
        qc.invalidateQueries({ queryKey: ['tasks'] }),
        qc.invalidateQueries({ queryKey: ['task-lists'] }),
      ]);
    },
    onError: (error: Error) => message.error(error.message),
  };
}

/**
 * The project's active and next executable work.
 *
 * The old card ranked every unfinished blocker, including tasks that could not actually start,
 * and offered a chart/table toggle. This card asks a narrower, actionable question: which tasks
 * can be run now, and which of those releases the most work? A row stays put after Run and changes
 * from Starting to Queued/Running until the work Session ends. Ready rows own an explicit Run
 * button; otherwise-ready work in a paused list owns an explicit, scope-confirmed Resume action.
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
  const queuedCount = data?.queuedCount ?? 0;
  const runningCount = data?.runningCount ?? 0;
  const pausedCount = data?.pausedCount ?? 0;
  const activeCount = queuedCount + runningCount;
  const qc = useQueryClient();
  const message = useToast();
  const resumeList = useMutation(resumePausedListMutationOptions(qc, message, projectId));
  const resumingListId = resumeList.isPending ? (resumeList.variables?.listId ?? null) : null;

  return (
    <section aria-labelledby="project-ready-to-run-heading" style={{ marginBottom: 24 }}>
      <Typography.Title
        id="project-ready-to-run-heading"
        level={4}
        style={{ marginBottom: 8 }}
      >
        Run queue{' '}
        {data ? (
          <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
            {queueSummary(
              data.readyCount,
              queuedCount,
              runningCount,
              pausedCount,
              data.impactTruncated != null,
            )}
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
          message="Run queue could not be read"
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
              description={`This project has more than ${data.impactTruncated.maxTasks} unfinished tasks, so tasks are shown without downstream impact ranking.`}
            />
          ) : null}

          {items.length === 0 ? (
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              No tasks are ready, running, or otherwise ready inside a paused task list. A task
              appears here when its prerequisites are complete and it has an assigned workspace.
            </Typography.Paragraph>
          ) : (
            <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {items.map((item) => (
                <ReadyTaskRow
                  key={item.taskId}
                  projectId={projectId}
                  item={item}
                  resumingListId={resumingListId}
                  onResumeList={(listId) => resumeList.mutate({ listId })}
                />
              ))}
            </ol>
          )}

          {items.length > 0 ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {queueHelp(data.readyCount, activeCount, pausedCount)}
            </Typography.Text>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function queueSummary(
  readyCount: number,
  queuedCount: number,
  runningCount: number,
  pausedCount: number,
  impactTruncated: boolean,
): string {
  const parts: string[] = [];
  if (runningCount > 0) parts.push(`${runningCount} running`);
  if (queuedCount > 0) parts.push(`${queuedCount} queued`);
  parts.push(`${readyCount} ready`);
  if (pausedCount > 0) parts.push(`${pausedCount} ready in paused lists`);
  const ranking = impactTruncated
    ? runningCount + queuedCount > 0
      ? 'active first · remaining tasks in stable order'
      : 'stable order'
    : runningCount + queuedCount > 0
      ? 'ready tasks sorted by work unblocked'
      : 'sorted by work unblocked';
  return `${parts.join(' · ')} · ${ranking}`;
}

function queueHelp(readyCount: number, activeCount: number, pausedCount: number): string {
  const parts: string[] = [];
  if (activeCount > 0) parts.push('Active tasks stay here until their run ends.');
  if (readyCount > 0) parts.push('Ready tasks can start now.');
  if (pausedCount > 0) {
    parts.push(
      'Paused candidates meet every other run requirement; resume their task list to make Run available.',
    );
  }
  return parts.join(' ');
}

function resumeDescription(item: ProjectReadyToRunItem): string {
  const list = item.pausedList;
  if (!list) return 'This task list must be resumed before the task can run.';
  const eligible = `${list.readyCount} otherwise-ready ${list.readyCount === 1 ? 'task' : 'tasks'}`;
  const immediate =
    list.autoRunReadyCount > 0
      ? ` ${list.autoRunReadyCount} ${list.autoRunReadyCount === 1 ? 'is' : 'are'} configured to auto-run and may start immediately.`
      : '';
  return `This removes the pause from the entire list. ${eligible} will become eligible.${immediate} Other automatic or scheduled work in the list can also dispatch once resumed.`;
}

function ReadyTaskRow({
  projectId,
  item,
  resumingListId,
  onResumeList,
}: {
  projectId: string;
  item: ProjectReadyToRunItem;
  resumingListId: string | null;
  onResumeList: (listId: string) => void;
}) {
  const qc = useQueryClient();
  const message = useToast();
  const navigate = useNavigate();
  const run = useMutation(runReadyTaskMutationOptions(qc, message, projectId, item.taskId));
  // Treat a response from an older server as READY during a rolling deploy.
  const runState = item.runState ?? 'READY';
  const impact =
    item.downstreamBlocked === null
      ? runState === 'READY'
        ? 'Ready now'
        : runState === 'PAUSED'
          ? 'Ready after resume'
          : 'Impact not ranked'
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
          {runState === 'RUNNING' ? (
            <>
              <LoadingOutlined aria-hidden spin style={{ color: 'var(--brand)' }} />
              Work in progress
            </>
          ) : runState === 'QUEUED' ? (
            <>
              <ClockCircleOutlined aria-hidden style={{ color: 'var(--brand)' }} />
              Waiting for runner
            </>
          ) : runState === 'PAUSED' ? (
            <>
              <PauseCircleOutlined aria-hidden style={{ color: 'var(--warning-solid)' }} />
              List paused
              {item.pausedList?.title ? ` · ${item.pausedList.title}` : ''}
            </>
          ) : (
            <>
              <CheckCircleFilled aria-hidden style={{ color: 'var(--success, #22a06b)' }} />
              Prerequisites complete
            </>
          )}
        </Typography.Text>
      </div>

      <Typography.Text
        className="project-ready-impact"
        type="secondary"
        style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
      >
        {impact}
      </Typography.Text>

      {runState === 'READY' ? (
        <Button
          className="project-ready-action"
          type="primary"
          icon={<PlayCircleOutlined />}
          loading={run.isPending}
          disabled={run.isPending}
          aria-label={`Run ${item.title}`}
          onClick={() => run.mutate({ triggerId: newRunRequestToken() })}
        >
          {run.isPending ? 'Starting' : 'Run'}
        </Button>
      ) : runState === 'PAUSED' && item.pausedList ? (
        <Popconfirm
          title={`Resume “${item.pausedList.title}”?`}
          description={resumeDescription(item)}
          okText="Resume list"
          cancelText="Cancel"
          okButtonProps={{ loading: resumingListId === item.pausedList.id }}
          onConfirm={() => onResumeList(item.pausedList!.id)}
        >
          <Button
            className="project-ready-action"
            icon={<PlayCircleOutlined />}
            loading={resumingListId === item.pausedList.id}
            disabled={resumingListId !== null}
            aria-label={`Resume list ${item.pausedList.title} for ${item.title}`}
          >
            Resume list
          </Button>
        </Popconfirm>
      ) : (runState === 'RUNNING' || runState === 'QUEUED') && item.sessionId ? (
        <Button
          className="project-ready-action"
          type="link"
          icon={<ArrowRightOutlined />}
          aria-label={`Open session for ${item.title}`}
          onClick={() => navigate(`/sessions/${encodeId(item.sessionId!)}`)}
        >
          Open session
        </Button>
      ) : (
        <Tag
          className="project-ready-action"
          color={
            runState === 'RUNNING' ? 'processing' : runState === 'PAUSED' ? 'warning' : 'default'
          }
          icon={
            runState === 'RUNNING' ? (
              <LoadingOutlined spin />
            ) : runState === 'PAUSED' ? (
              <PauseCircleOutlined />
            ) : (
              <ClockCircleOutlined />
            )
          }
          aria-label={`${runState === 'RUNNING' ? 'Running' : runState === 'PAUSED' ? 'Paused' : 'Queued'} ${item.title}`}
          style={{ marginInlineEnd: 0 }}
        >
          {runState === 'RUNNING' ? 'Running' : runState === 'PAUSED' ? 'Paused' : 'Queued'}
        </Tag>
      )}
    </li>
  );
}
