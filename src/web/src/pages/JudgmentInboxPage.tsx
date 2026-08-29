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
  isRatificationInboxItem,
  outcomeDecisionReviewPath,
  outcomeInboxPath,
  type CanonicalOwnerInboxItem,
  type OutcomeHumanInbox,
} from '../lib/outcomeSurfaces';
import {
  ownerRatificationInboxPath,
  ownerRatificationReviewPath,
  type OwnerRatificationInboxPage,
} from '../lib/ownerRatification';

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
  const ratificationInbox = useQuery({
    queryKey: ['owner-ratification', 'pending'],
    queryFn: () => api<OwnerRatificationInboxPage>(ownerRatificationInboxPath(100)),
  });
  const genericOutcomeItems = (outcomeInbox.data?.items ?? [])
    .filter((item): item is CanonicalOwnerInboxItem => !isRatificationInboxItem(item));
  const total = (taskInbox.data?.total ?? 0) + (projectInbox.data?.total ?? 0)
    + genericOutcomeItems.length
    + (ratificationInbox.data?.total ?? 0);
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
    ...(ratificationInbox.data?.items ?? []).map((item) => ({
      kind: 'RATIFICATION' as const,
      at: item.createdAt,
      item,
    })),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const hasAnyData = Boolean(
    taskInbox.data || projectInbox.data || outcomeInbox.data || ratificationInbox.data,
  );
  const loading = !hasAnyData && (taskInbox.isLoading || projectInbox.isLoading
    || outcomeInbox.isLoading || ratificationInbox.isLoading);
  const failed = !hasAnyData && (taskInbox.isError || projectInbox.isError
    || outcomeInbox.isError || ratificationInbox.isError);
  const error = taskInbox.error ?? projectInbox.error
    ?? outcomeInbox.error ?? ratificationInbox.error;
  const fetching = taskInbox.isFetching || projectInbox.isFetching
    || outcomeInbox.isFetching || ratificationInbox.isFetching;

  return (
    <div className="judgment-page judgment-inbox-page">
      <header className="judgment-page-head">
        <div>
          <h1 className="page-title">待我判定</h1>
          <p>任务级 HUMAN_SIGNOFF、项目验收与 Owner Ratification 共用一个收件箱；这里也只出现四类目标/风险/授权/身份请求，机械标准只展示结果。</p>
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
                void ratificationInbox.refetch();
              }}
            >
              Retry
            </Button>
          )}
        />
      ) : entries.length === 0 && genericOutcomeItems.length === 0 ? (
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
                  {entry.item.confirmationRequired ? '确认项目标准集' : '项目人工验收'}
                </Tag>
                <div className="judgment-inbox-title">{entry.item.projectTitle}</div>
                <div className="judgment-inbox-project">Project {entry.item.projectStatus}</div>
                <dl className="judgment-inbox-facts">
                  <div><dt>Evidence version</dt><dd>attempt {entry.item.attempt}</dd></div>
                  <div><dt>Current verdict</dt><dd>{entry.item.currentVerdict}</dd></div>
                  <div><dt>标准集</dt><dd>{entry.item.criteriaConfirmed ? '已确认' : '待确认'}</dd></div>
                  <div><dt>人工标准</dt><dd>{entry.item.answeredCount}/{entry.item.humanCriterionCount} answered</dd></div>
                  <div><dt>Opened</dt><dd>{when(entry.item.startedAt)}</dd></div>
                </dl>
                <span className="judgment-inbox-open">确认标准集并处理人工标准 →</span>
              </Link>
            </li>
          ) : (
            <li
              key={`ratification:${entry.item.decisionRequestId}`}
              className="judgment-inbox-card owner-ratification-inbox-card"
              data-decision-request-id={entry.item.decisionRequestId}
              data-obligation-id={entry.item.obligationId}
              data-obligation-revision={entry.item.obligationRevision}
              data-contract-digest={entry.item.contractDigest}
              data-reason={entry.item.reasonCode}
              data-owner={entry.item.owner}
              data-evaluated-through-watermark={entry.item.evaluatedThroughWatermark}
            >
              <Link to={ownerRatificationReviewPath(
                entry.item.projectId,
                entry.item.decisionRequestId,
              )}>
                <Tag color="volcano">Owner Ratification</Tag>
                <div className="judgment-inbox-title">{entry.item.projectTitle}</div>
                <div className="judgment-inbox-project">
                  {entry.item.reasonCode} · owner {entry.item.owner}
                </div>
                <dl className="judgment-inbox-facts">
                  <div><dt>Request</dt><dd>{entry.item.decisionRequestId}</dd></div>
                  <div><dt>Revision</dt><dd>{entry.item.requestRevision}</dd></div>
                  <div><dt>Obligation</dt><dd>{entry.item.obligationId}</dd></div>
                  <div><dt>Obligation revision</dt><dd>{entry.item.obligationRevision}</dd></div>
                  <div><dt>Contract digest</dt><dd>{shortDigest(entry.item.contractDigest)}</dd></div>
                  <div><dt>Evaluated through</dt><dd>{entry.item.evaluatedThroughWatermark}</dd></div>
                  <div><dt>Expires</dt><dd>{when(entry.item.expiresAt)}</dd></div>
                </dl>
                <span className="judgment-inbox-open">Review exact contract and decide →</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
