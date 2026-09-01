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
import {
  isFailureOwnerInboxItem,
  outcomeDecisionReviewPath,
  outcomeInboxPath,
  type CanonicalOwnerInboxItem,
  type OutcomeHumanInbox,
} from '../lib/outcomeSurfaces';
import { FailureCoordinationCard } from '../components/FailureCoordinationCard';
import { encodeId } from '../lib/idCodec';

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
  const outcomeInbox = useQuery({
    queryKey: ['outcomes', 'inbox'],
    queryFn: () => api<OutcomeHumanInbox>(outcomeInboxPath(100)),
  });
  const genericOutcomeItems = (outcomeInbox.data?.items ?? [])
    .filter((item): item is CanonicalOwnerInboxItem => !isFailureOwnerInboxItem(item));
  const failureOutcomeItems = (outcomeInbox.data?.items ?? []).filter(isFailureOwnerInboxItem);
  const total = (taskInbox.data?.total ?? 0) + (projectInbox.data?.total ?? 0)
    + genericOutcomeItems.length
    + failureOutcomeItems.length;
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
  const hasAnyData = Boolean(taskInbox.data || projectInbox.data || outcomeInbox.data);
  const loading = !hasAnyData && (taskInbox.isLoading || projectInbox.isLoading
    || outcomeInbox.isLoading);
  const failed = !hasAnyData && (taskInbox.isError || projectInbox.isError
    || outcomeInbox.isError);
  const error = taskInbox.error ?? projectInbox.error ?? outcomeInbox.error;
  const fetching = taskInbox.isFetching || projectInbox.isFetching || outcomeInbox.isFetching;

  return (
    <div className="judgment-page judgment-inbox-page">
      <header className="judgment-page-head">
        <div>
          <h1 className="page-title">待我判定</h1>
          <p>任务级 HUMAN_SIGNOFF 与项目验收共用一个收件箱；Failure Continuation 只在 owner-only 决策时进入这里，普通工程故障由 coordinator 自动处理。</p>
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
              onClick={() => {
                void taskInbox.refetch();
                void projectInbox.refetch();
                void outcomeInbox.refetch();
              }}
            >
              Retry
            </Button>
          )}
        />
      ) : entries.length === 0 && genericOutcomeItems.length === 0 && failureOutcomeItems.length === 0 ? (
        <Empty description="没有待判定的证据" />
      ) : (
        <ul className="judgment-inbox-list" aria-label="Open human decisions">
          {genericOutcomeItems.map((item) => {
            const protocol = item.decision;
            const requestId = String(item.decisionRequest?.requestId ?? '');
            return (
              <li key={`outcome:${requestId}`} className="judgment-inbox-card">
                <Link to={outcomeDecisionReviewPath(requestId)}>
                  <Tag color="gold">{protocol.decisionType}</Tag>
                  <div className="judgment-inbox-title">{item.projectTitle}</div>
                  <div className="judgment-inbox-project">Canonical project obligation</div>
                  <dl className="judgment-inbox-facts">
                    <div><dt>Agent 已做</dt><dd>{JSON.stringify(protocol.agentWorkCompleted)}</dd></div>
                    <div><dt>whyNotAgent</dt><dd>{protocol.whyNotAgent}</dd></div>
                    <div><dt>选项 / 影响</dt><dd>{JSON.stringify(protocol.options)} / {JSON.stringify(protocol.impacts)}</dd></div>
                    <div><dt>推荐</dt><dd>{JSON.stringify(protocol.recommendation)}</dd></div>
                    <div><dt>成本 / 期限</dt><dd>{JSON.stringify(protocol.cost)} / {JSON.stringify(protocol.deadline)}</dd></div>
                    <div><dt>不处理</dt><dd>{JSON.stringify(protocol.noActionConsequence)}</dd></div>
                    <div><dt>决定后自动续跑</dt><dd>{JSON.stringify(protocol.resumeBehavior)}</dd></div>
                  </dl>
                  <span className="judgment-inbox-open">Review bound revision and decide →</span>
                </Link>
              </li>
            );
          })}
          {failureOutcomeItems.map((item) => (
            <li
              key={`failure:${item.obligationId}`}
              className="judgment-inbox-card failure-continuation-inbox-card"
              data-obligation-id={item.obligationId}
              data-obligation-revision={item.obligationRevision}
              data-binding-digest={item.bindingDigest}
              data-reason={String(item.canonicalReason.code ?? '')}
            >
              <Tag color="volcano">Owner-only failure decision</Tag>
              <div className="judgment-inbox-title">{item.projectTitle}</div>
              <div className="judgment-inbox-project">{item.sourceTaskTitle}</div>
              <FailureCoordinationCard item={item} compact />
              <Link className="judgment-inbox-open" to={`/tasks/${encodeId(item.sourceTaskId)}`}>
                Review bound failure and decide →
              </Link>
            </li>
          ))}
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
          ) : entry.kind === 'PROJECT' ? (
            <li key={`project:${entry.item.runId}`} className="judgment-inbox-card project-acceptance-inbox-card">
              <Link to={projectAcceptanceReviewPath(entry.item.projectId, entry.item.runId)}>
                <Tag color="gold">
                  项目人工验收
                </Tag>
                <div className="judgment-inbox-title">{entry.item.projectTitle}</div>
                <div className="judgment-inbox-project">Project {entry.item.projectStatus}</div>
                <dl className="judgment-inbox-facts">
                  <div><dt>Evidence version</dt><dd>attempt {entry.item.attempt}</dd></div>
                  <div><dt>Current verdict</dt><dd>{entry.item.currentVerdict}</dd></div>
                  <div><dt>标准集</dt><dd>{entry.item.criteriaDeclared ? '已声明' : '未声明'}</dd></div>
                  <div><dt>人工标准</dt><dd>{entry.item.answeredCount}/{entry.item.humanCriterionCount} answered</dd></div>
                  <div><dt>Opened</dt><dd>{when(entry.item.startedAt)}</dd></div>
                </dl>
                <span className="judgment-inbox-open">处理人工标准 →</span>
              </Link>
            </li>
          ) : null)}
        </ul>
      )}
    </div>
  );
}
