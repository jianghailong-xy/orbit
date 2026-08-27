import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Empty, Spin, Tag } from 'antd';
import { Link } from 'react-router-dom';
import { api } from '../api';
import {
  judgmentInboxPath,
  judgmentReviewPath,
  shortDigest,
  type JudgmentInboxPage,
} from '../lib/judgments';
import {
  projectAcceptanceInboxPath,
  projectAcceptanceReviewPath,
  type ProjectAcceptanceInboxPage,
} from '../lib/projectAcceptance';

const when = (value: string): string => new Date(value).toLocaleString();

export function JudgmentInboxPage() {
  const taskInbox = useQuery({
    queryKey: ['judgments', 'open'],
    queryFn: () => api<JudgmentInboxPage>(judgmentInboxPath({ status: 'OPEN', limit: 100 })),
  });
  const projectInbox = useQuery({
    queryKey: ['project-acceptance', 'pending'],
    queryFn: () => api<ProjectAcceptanceInboxPage>(projectAcceptanceInboxPath(100)),
  });
  const total = (taskInbox.data?.total ?? 0) + (projectInbox.data?.total ?? 0);
  const entries = [
    ...(taskInbox.data?.items ?? []).map((item) => ({
      kind: 'TASK' as const,
      at: item.submittedAt,
      item,
    })),
    ...(projectInbox.data?.items ?? []).map((item) => ({
      kind: 'PROJECT' as const,
      at: item.startedAt,
      item,
    })),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const loading = taskInbox.isLoading || projectInbox.isLoading;
  const failed = taskInbox.isError || projectInbox.isError;
  const error = taskInbox.error ?? projectInbox.error;
  const fetching = taskInbox.isFetching || projectInbox.isFetching;

  return (
    <div className="judgment-page judgment-inbox-page">
      <header className="judgment-page-head">
        <div>
          <h1 className="page-title">待我判定</h1>
          <p>任务级 HUMAN_SIGNOFF 与项目级验收共用一个收件箱；请审阅当前证据后作出决定。</p>
        </div>
        {taskInbox.data && projectInbox.data
          ? <span className="judgment-count" aria-label={`${total} open requests`}>{total}</span>
          : null}
      </header>

      {loading ? (
        <div className="judgment-loading" role="status" aria-label="Loading judgment inbox"><Spin /></div>
      ) : failed ? (
        <Alert
          type="error"
          showIcon
          message="待我判定 could not be loaded"
          description={error instanceof Error ? error.message : undefined}
          action={(
            <Button
              danger
              size="small"
              loading={fetching}
              disabled={fetching}
              onClick={() => {
                void taskInbox.refetch();
                void projectInbox.refetch();
              }}
            >
              Retry
            </Button>
          )}
        />
      ) : entries.length === 0 ? (
        <Empty description="没有待判定的证据" />
      ) : (
        <ul className="judgment-inbox-list" aria-label="Open human decisions">
          {entries.map((entry) => entry.kind === 'TASK' ? (
            <li key={`task:${entry.item.requestId}`} className="judgment-inbox-card">
              <Link to={judgmentReviewPath(entry.item.requestId)}>
                <Tag color="blue">任务级签字</Tag>
                <div className="judgment-inbox-title">{entry.item.taskTitle}</div>
                <div className="judgment-inbox-project">{entry.item.projectTitle ?? 'No project'}</div>
                <dl className="judgment-inbox-facts">
                  <div><dt>Evidence</dt><dd>r{entry.item.evidenceRevision} · {shortDigest(entry.item.evidenceDigest)}</dd></div>
                  <div><dt>Submitted by</dt><dd>{entry.item.actorName ?? entry.item.actorType}</dd></div>
                  <div><dt>Submitted</dt><dd>{when(entry.item.submittedAt)}</dd></div>
                  <div><dt>Commit</dt><dd>{entry.item.commit ?? 'Not provided'}</dd></div>
                </dl>
                <span className="judgment-inbox-open">Review and decide →</span>
              </Link>
            </li>
          ) : (
            <li key={`project:${entry.item.runId}`} className="judgment-inbox-card project-acceptance-inbox-card">
              <Link to={projectAcceptanceReviewPath(entry.item.projectId, entry.item.runId)}>
                <Tag color="gold">项目级验收</Tag>
                <div className="judgment-inbox-title">{entry.item.projectTitle}</div>
                <div className="judgment-inbox-project">Project {entry.item.projectStatus}</div>
                <dl className="judgment-inbox-facts">
                  <div><dt>Evidence version</dt><dd>attempt {entry.item.attempt}</dd></div>
                  <div><dt>Current verdict</dt><dd>{entry.item.currentVerdict}</dd></div>
                  <div><dt>Criteria</dt><dd>{entry.item.answeredCount}/{entry.item.criterionCount} answered</dd></div>
                  <div><dt>Opened</dt><dd>{when(entry.item.startedAt)}</dd></div>
                </dl>
                <span className="judgment-inbox-open">Review every criterion →</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
