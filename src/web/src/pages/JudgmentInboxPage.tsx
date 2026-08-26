import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Empty, Spin } from 'antd';
import { Link } from 'react-router-dom';
import { api } from '../api';
import {
  judgmentInboxPath,
  judgmentReviewPath,
  shortDigest,
  type JudgmentInboxPage,
} from '../lib/judgments';

const when = (value: string): string => new Date(value).toLocaleString();

export function JudgmentInboxPage() {
  const inbox = useQuery({
    queryKey: ['judgments', 'open'],
    queryFn: () => api<JudgmentInboxPage>(judgmentInboxPath({ status: 'OPEN', limit: 100 })),
  });

  return (
    <div className="judgment-page judgment-inbox-page">
      <header className="judgment-page-head">
        <div>
          <h1 className="page-title">待我判定</h1>
          <p>HUMAN_SIGNOFF 是任务的正常完成判据。请审阅当前证据后作出决定。</p>
        </div>
        {inbox.data && <span className="judgment-count" aria-label={`${inbox.data.total} open requests`}>{inbox.data.total}</span>}
      </header>

      {inbox.isLoading ? (
        <div className="judgment-loading" role="status" aria-label="Loading judgment inbox"><Spin /></div>
      ) : inbox.isError ? (
        <Alert
          type="error"
          showIcon
          message="待我判定 could not be loaded"
          description={inbox.error instanceof Error ? inbox.error.message : undefined}
          action={(
            <Button
              danger
              size="small"
              loading={inbox.isFetching}
              disabled={inbox.isFetching}
              onClick={() => inbox.refetch()}
            >
              Retry
            </Button>
          )}
        />
      ) : inbox.data?.items.length === 0 ? (
        <Empty description="没有待判定的证据" />
      ) : (
        <ul className="judgment-inbox-list" aria-label="Open HUMAN_SIGNOFF requests">
          {inbox.data?.items.map((item) => (
            <li key={item.requestId} className="judgment-inbox-card">
              <Link to={judgmentReviewPath(item.requestId)}>
                <div className="judgment-inbox-title">{item.taskTitle}</div>
                <div className="judgment-inbox-project">{item.projectTitle ?? 'No project'}</div>
                <dl className="judgment-inbox-facts">
                  <div><dt>Evidence</dt><dd>r{item.evidenceRevision} · {shortDigest(item.evidenceDigest)}</dd></div>
                  <div><dt>Submitted by</dt><dd>{item.actorName ?? item.actorType}</dd></div>
                  <div><dt>Submitted</dt><dd>{when(item.submittedAt)}</dd></div>
                  <div><dt>Commit</dt><dd>{item.commit ?? 'Not provided'}</dd></div>
                </dl>
                <span className="judgment-inbox-open">Review and decide →</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
