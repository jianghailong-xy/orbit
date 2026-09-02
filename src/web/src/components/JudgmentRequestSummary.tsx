import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Spin } from 'antd';
import { Link } from 'react-router-dom';
import { api } from '../api';
import {
  judgmentInboxPath,
  judgmentReviewPath,
  shortDigest,
  type JudgmentInboxPage,
} from '../lib/judgments';

const when = (value: string): string => new Date(value).toLocaleString();

/** Open EVIDENCE_JUDGMENT requests embedded on a task or project page. Actions stay on the review. */
export function JudgmentRequestSummary({
  projectId,
  taskId,
  heading = '待我判定',
}: {
  projectId?: string;
  taskId?: string;
  heading?: string;
}) {
  const query = useQuery({
    queryKey: ['judgments', 'open', { projectId: projectId ?? null, taskId: taskId ?? null }],
    queryFn: () =>
      api<JudgmentInboxPage>(judgmentInboxPath({
        status: 'OPEN',
        projectId,
        taskId,
        limit: 5,
      })),
    enabled: Boolean(projectId || taskId),
  });

  if (query.isLoading) {
    return (
      <div className="judgment-summary-loading" role="status" aria-label={`Loading ${heading}`}>
        <Spin size="small" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <Alert
        className="judgment-summary-error"
        type="error"
        showIcon
        message={`${heading} could not be loaded`}
        description={query.error instanceof Error ? query.error.message : undefined}
        action={(
          <Button
            size="small"
            danger
            loading={query.isFetching}
            disabled={query.isFetching}
            onClick={() => query.refetch()}
          >
            Retry
          </Button>
        )}
      />
    );
  }
  if (!query.data?.items.length) return null;

  return (
    <section className="judgment-summary" aria-label={heading}>
      <div className="judgment-summary-head">
        <h2>{heading}</h2>
        <span>{query.data.total}</span>
      </div>
      <ul className="judgment-summary-list">
        {query.data.items.map((item) => (
          <li key={item.requestId}>
            <Link className="judgment-summary-link" to={judgmentReviewPath(item.requestId)}>
              <span className="judgment-summary-task">{item.taskTitle}</span>
              <span className="judgment-summary-meta">
                Evidence r{item.evidenceRevision} · {shortDigest(item.evidenceDigest)} ·{' '}
                {item.actorName ?? item.actorType} · {when(item.submittedAt)}
              </span>
              <span className="judgment-summary-action">Review evidence →</span>
            </Link>
          </li>
        ))}
      </ul>
      {query.data.total > query.data.items.length && (
        <Link className="judgment-summary-all" to="/judgments">
          View all {query.data.total} requests
        </Link>
      )}
    </section>
  );
}
