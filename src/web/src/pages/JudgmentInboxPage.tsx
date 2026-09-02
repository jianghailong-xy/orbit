import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Empty, Spin, Tag } from 'antd';
import { Link } from 'react-router-dom';
import { api } from '../api';
import {
  projectAcceptanceInboxPath,
  projectAcceptanceReviewPath,
  type ProjectAcceptanceInboxPage,
} from '../lib/projectAcceptance';

const when = (value: string): string => new Date(value).toLocaleString();

/**
 * Everything still waiting on a person's decision.
 *
 * Until 2026-09-02 this was two inboxes in one list: task-level EVIDENCE_JUDGMENT requests and
 * project acceptance. The judgment request ledger and its review face were removed with the rest
 * of the judgment machinery, so what is left is the project half — which was never part of it.
 */
export function JudgmentInboxPage() {
  const projectInbox = useQuery({
    queryKey: ['project-acceptance', 'pending'],
    queryFn: () => api<ProjectAcceptanceInboxPage>(projectAcceptanceInboxPath(100)),
  });
  const total = projectInbox.data?.total ?? 0;
  const entries = [...(projectInbox.data?.items ?? [])]
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const hasAnyData = Boolean(projectInbox.data);
  const loading = !hasAnyData && projectInbox.isLoading;
  const failed = !hasAnyData && projectInbox.isError;
  const error = projectInbox.error;
  const fetching = projectInbox.isFetching;

  return (
    <div className="judgment-page judgment-inbox-page">
      <header className="judgment-page-head">
        <div>
          <h1 className="page-title">待我判定</h1>
          <p>项目验收的人工标准。任务级 EVIDENCE_JUDGMENT 的判定实现已于 2026-09-02 移除。</p>
        </div>
        {hasAnyData
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
              onClick={() => { void projectInbox.refetch(); }}
            >
              Retry
            </Button>
          )}
        />
      ) : entries.length === 0 ? (
        <Empty description="没有待判定的证据" />
      ) : (
        <ul className="judgment-inbox-list" aria-label="Open human decisions">
          {entries.map((item) => (
            <li key={`project:${item.runId}`} className="judgment-inbox-card project-acceptance-inbox-card">
              <Link to={projectAcceptanceReviewPath(item.projectId, item.runId)}>
                <Tag color="gold">
                  项目人工验收
                </Tag>
                <div className="judgment-inbox-title">{item.projectTitle}</div>
                <div className="judgment-inbox-project">Project {item.projectStatus}</div>
                <dl className="judgment-inbox-facts">
                  <div><dt>Evidence version</dt><dd>attempt {item.attempt}</dd></div>
                  <div><dt>Current verdict</dt><dd>{item.currentVerdict}</dd></div>
                  <div><dt>标准集</dt><dd>{item.criteriaDeclared ? '已声明' : '未声明'}</dd></div>
                  <div><dt>人工标准</dt><dd>{item.answeredCount}/{item.humanCriterionCount} answered</dd></div>
                  <div><dt>Opened</dt><dd>{when(item.startedAt)}</dd></div>
                </dl>
                <span className="judgment-inbox-open">处理人工标准 →</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
