import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Checkbox, Spin, Tag } from 'antd';
import { Link, useNavigate, useParams } from 'react-router-dom';
import Markdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { ApiError, api } from '../api';
import { routeId } from '../lib/idCodec';
import { shortDigest } from '../lib/judgments';
import {
  isActiveOwnerRatificationReference,
  ownerRatificationDecisionPath,
  ownerRatificationPath,
  ownerRatificationReviewPath,
  splitOwnerRatificationCapability,
  type OwnerRatificationPrivateRead,
  type OwnerRatificationReview,
} from '../lib/ownerRatification';
import { remarkHardBreaks } from '../lib/remarkHardBreaks';

type Decision = 'APPROVE' | 'DENY';

interface SafeFailure {
  code: string;
  message: string;
  reloadCurrent: boolean;
  networkRetry: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function display(value: unknown, fallback = '未声明'): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return fallback;
  return JSON.stringify(value);
}

function finiteBudget(value: unknown): string {
  return value === null || value === undefined
    ? '未声明有限额度（null；不等于 Owner 已授权无限额度）'
    : display(value);
}

function when(value: string): string {
  return new Date(value).toLocaleString();
}

function newIdempotencyKey(requestId: string, decision: Decision): string {
  const random = globalThis.crypto?.randomUUID?.()
    ?? Array.from(globalThis.crypto?.getRandomValues?.(new Uint32Array(4)) ?? [Date.now()])
      .map((part) => part.toString(16)).join('-');
  return `owner-ratification:web:v1:${requestId}:${decision}:${random}`;
}

/** Never expose server/driver prose here: a future error must not turn request input into UI text. */
function safeFailure(error: unknown): SafeFailure {
  if (!(error instanceof ApiError)) {
    return {
      code: 'NETWORK_UNCERTAIN',
      message: '网络结果未知；可以使用同一幂等键安全重试，或重新读取当前 request。',
      reloadCurrent: true,
      networkRetry: true,
    };
  }
  const code = error.code ?? (error.status === 404 ? 'NOT_AVAILABLE_TO_OWNER' : 'REQUEST_FAILED');
  if (code === 'OWNER_DECISION_STALE') {
    return { code, message: '契约或 request 已更新；旧 tab 未提交决定。请载入当前 request。', reloadCurrent: true, networkRetry: false };
  }
  if (code === 'OWNER_DECISION_CTA_EXPIRED') {
    return { code, message: '一次性 CTA 已到期；服务器已生成可恢复的新 request。', reloadCurrent: true, networkRetry: false };
  }
  if (code === 'OWNER_DECISION_ALREADY_SPENT') {
    const recorded = error.body?.recordedDecision;
    return {
      code,
      message: recorded === 'APPROVE' || recorded === 'DENY'
        ? `此 CTA 已由另一次点击或客户端提交 ${recorded}；请读取服务器记录的决定。`
        : '此 CTA 已被另一次点击或客户端消费；请读取已提交结果或当前 request。',
      reloadCurrent: true,
      networkRetry: false,
    };
  }
  if (code === 'OWNER_DECISION_IDEMPOTENCY_COLLISION') {
    return {
      code,
      message: '该幂等键已绑定另一组 request/digest/CTA/decision；本次未提交，请重新读取。',
      reloadCurrent: true,
      networkRetry: false,
    };
  }
  if (code === 'OWNER_DECISION_CTA_MISMATCH') {
    return { code, message: 'CTA 与当前 request 不匹配；未提交决定。请重新载入。', reloadCurrent: true, networkRetry: false };
  }
  if (code === 'NOT_AVAILABLE_TO_OWNER' || error.status === 403) {
    return { code, message: '该 project/request 对当前账号不可用；没有提交任何决定。', reloadCurrent: false, networkRetry: false };
  }
  return {
    code,
    message: '决定未得到可确认的提交结果；请重新读取当前 request 后再操作。',
    reloadCurrent: true,
    networkRetry: false,
  };
}

export function OwnerRatificationReviewPage() {
  const params = useParams();
  const projectId = routeId(params.projectId);
  const routeRequestId = routeId(params.requestId);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const capability = useRef<string | null>(null);
  const inFlight = useRef(false);
  const idempotency = useRef<Partial<Record<Decision, string>>>({});
  const lastDecision = useRef<Decision | null>(null);
  const [review, setReview] = useState<OwnerRatificationReview | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<SafeFailure | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [submitting, setSubmitting] = useState<Decision | null>(null);
  const [outcome, setOutcome] = useState<{ decision: Decision; automaticResume?: unknown } | null>(null);

  const load = useCallback(async (moveToCurrent = false) => {
    if (!projectId || !routeRequestId) {
      capability.current = null;
      setFailure({
        code: 'INVALID_REVIEW_LINK',
        message: '审阅链接缺少有效的 project 或 request identity。',
        reloadCurrent: false,
        networkRetry: false,
      });
      setLoading(false);
      return;
    }
    setLoading(true);
    setFailure(null);
    capability.current = null;
    try {
      const raw = await api<OwnerRatificationPrivateRead>(ownerRatificationPath(projectId));
      const split = splitOwnerRatificationCapability(raw);
      const projected = split.review.decisionSurface?.reference ?? null;
      const current = isActiveOwnerRatificationReference(projected) ? projected : null;
      const recorded = split.review.latestDecision;
      if (recorded?.decisionRequestId === routeRequestId) {
        setReview(split.review);
        setOutcome({ decision: recorded.decision });
        capability.current = null;
        return;
      }
      if (moveToCurrent && current && current.decisionRequestId !== routeRequestId) {
        navigate(ownerRatificationReviewPath(projectId, current.decisionRequestId), { replace: true });
        return;
      }
      setReview(split.review);
      const request = split.review.decisionRequest;
      const exact = Boolean(
        current
        && request
        && current.decisionRequestId === routeRequestId
        && request.id === routeRequestId
        && current.contractDigest === split.review.contractDigest
        && request.contractDigest === split.review.contractDigest
        && current.owner === 'OWNER'
        && request.status === 'PENDING',
      );
      if (!exact) {
        capability.current = null;
        setFailure({
          code: split.review.ratified ? 'ALREADY_RATIFIED' : 'OWNER_DECISION_STALE',
          message: split.review.ratified
            ? '此精确契约已由 Owner ratify；这个旧审阅页不会再次提交。'
            : '此链接不再指向当前 request/contract；旧 tab 已 fail closed。',
          reloadCurrent: Boolean(current),
          networkRetry: false,
        });
      } else if (!split.ctaToken) {
        setFailure({
          code: 'OWNER_DECISION_CAPABILITY_UNAVAILABLE',
          message: '私有读取未返回一次性 CTA；决定按钮保持关闭，请重新载入。',
          reloadCurrent: true,
          networkRetry: false,
        });
      } else if (Date.parse(current!.expiresAt) <= Date.now()) {
        setFailure({
          code: 'OWNER_DECISION_CTA_EXPIRED',
          message: '该 CTA 已到期；重新载入会取得服务器生成的当前 request。',
          reloadCurrent: true,
          networkRetry: false,
        });
      } else {
        capability.current = split.ctaToken;
      }
    } catch (error) {
      capability.current = null;
      setFailure(safeFailure(error));
    } finally {
      setLoading(false);
    }
  }, [navigate, projectId, routeRequestId]);

  useEffect(() => {
    void load(false);
    return () => {
      capability.current = null;
      inFlight.current = false;
    };
  }, [load]);

  const decide = async (decision: Decision) => {
    const reference = review?.decisionSurface?.reference;
    const token = capability.current;
    if (!projectId || !routeRequestId || !reference || !token || !acknowledged
        || inFlight.current || reference.decisionRequestId !== routeRequestId
        || reference.contractDigest !== review?.contractDigest
        || Date.parse(reference.expiresAt) <= Date.now()) {
      setFailure({
        code: 'OWNER_DECISION_LOCAL_FENCE',
        message: '本页无法证明 request、digest、CTA、到期时间与确认状态仍精确匹配；未发送决定。',
        reloadCurrent: true,
        networkRetry: false,
      });
      return;
    }
    inFlight.current = true;
    setSubmitting(decision);
    setFailure(null);
    lastDecision.current = decision;
    const key = idempotency.current[decision]
      ?? newIdempotencyKey(reference.decisionRequestId, decision);
    idempotency.current[decision] = key;
    try {
      const result = await api<Record<string, unknown>>(ownerRatificationDecisionPath(projectId), {
        method: 'POST',
        body: {
          decision,
          decisionRequestId: reference.decisionRequestId,
          ctaToken: token,
          expectedContractDigest: reference.contractDigest,
          idempotencyKey: key,
        },
      });
      capability.current = null;
      setOutcome({ decision, automaticResume: result.automaticResume });
      setAcknowledged(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['owner-ratification'] }),
        queryClient.invalidateQueries({ queryKey: ['projects'] }),
        queryClient.invalidateQueries({ queryKey: ['project', projectId] }),
      ]);
    } catch (error) {
      const safe = safeFailure(error);
      // A transport failure may have committed; retain the capability and the SAME key for one
      // idempotent retry. Every typed server refusal consumes local authority and requires a read.
      if (!safe.networkRetry) capability.current = null;
      setFailure(safe);
    } finally {
      inFlight.current = false;
      setSubmitting(null);
    }
  };

  if (loading) {
    return <div className="judgment-loading" role="status" aria-label="Loading Owner Ratification"><Spin /></div>;
  }

  const surface = review?.decisionSurface;
  const reference = surface?.reference;
  const contract = surface?.semanticContract ?? review?.semanticContract ?? {};
  const risk = record(contract.riskBoundary);
  const permissions = record(contract.permissions);
  const recipients = record(contract.recipients);
  const budget = record(contract.budget);
  const criteria = Array.isArray(contract.criteria) ? contract.criteria : [];
  const trust = Array.isArray(contract.criteriaTrust) ? contract.criteriaTrust : [];
  const trustByHash = new Map(trust.map((item) => [item.semanticHash, item.completionCriterion]));
  const retryDecision = lastDecision.current;

  return (
    <div className="judgment-page judgment-review-page owner-ratification-review-page">
      <Link className="judgment-back-link" to="/judgments">← 待我判定</Link>
      <header className="judgment-review-head">
        <div>
          <Tag color="volcano">Owner Ratification</Tag>
          <h1 className="page-title">审阅精确执行契约</h1>
          <p>{review?.projectTitle ?? 'Project'} · 只有账号 Owner 可在此页决定。</p>
        </div>
      </header>

      {failure ? (
        <Alert
          className="judgment-state-alert"
          type={failure.code === 'ALREADY_RATIFIED' ? 'success' : 'warning'}
          showIcon
          message={failure.code}
          description={failure.message}
          action={failure.reloadCurrent ? (
            <Button onClick={() => void load(true)}>载入当前 request</Button>
          ) : undefined}
        />
      ) : null}

      {outcome ? (
        <Alert
          className="judgment-state-alert"
          type={outcome.decision === 'APPROVE' ? 'success' : 'info'}
          showIcon
          message={`${outcome.decision} 已提交`}
          description={outcome.decision === 'APPROVE'
            ? '精确 contract digest 已 ratify；持久化 wake 会自动重新进入 GUARDED_AUTO admission，无需再次点击。网络重读会恢复同一决定结果。'
            : '该 request 已拒绝；未授予执行权限，自动副作用执行保持关闭。'}
        />
      ) : null}

      {reference && review ? (
        <>
          <section
            className="judgment-evidence-identity"
            aria-labelledby="ratification-identity-heading"
            data-decision-request-id={reference.decisionRequestId}
            data-obligation-id={reference.obligationId}
            data-obligation-revision={reference.obligationRevision}
            data-contract-digest={reference.contractDigest}
            data-reason={reference.reasonCode}
            data-eligibility-reason={reference.eligibility.reasonCode}
            data-binding-status={reference.eligibility.bindingStatus}
            data-owner={reference.owner}
            data-evaluated-through-watermark={reference.evaluatedThroughWatermark}
          >
            <div className="judgment-identity-head">
              <div><h2 id="ratification-identity-heading">Canonical decision identity</h2></div>
              <Tag color={reference.expired ? 'red' : 'orange'}>
                {reference.expired ? 'EXPIRED' : reference.status}
              </Tag>
            </div>
            <dl className="judgment-identity-facts owner-ratification-identity-facts">
              <div><dt>Decision request</dt><dd>{reference.decisionRequestId}</dd></div>
              <div><dt>Request revision</dt><dd>{reference.requestRevision}</dd></div>
              <div><dt>Obligation</dt><dd>{reference.obligationId}</dd></div>
              <div><dt>Obligation revision</dt><dd>{reference.obligationRevision}</dd></div>
              <div><dt>Contract digest</dt><dd><code>{reference.contractDigest}</code></dd></div>
              <div><dt>Contract revision</dt><dd>{reference.contractRevision}</dd></div>
              <div><dt>Reason</dt><dd>{reference.reasonCode}</dd></div>
              <div><dt>Why now</dt><dd>{reference.reason}</dd></div>
              <div><dt>Binding</dt><dd>{reference.eligibility.bindingStatus}</dd></div>
              <div><dt>Owner</dt><dd>{reference.owner} · {reference.ownerId}</dd></div>
              <div><dt>Evaluated through watermark</dt><dd>{reference.evaluatedThroughWatermark}</dd></div>
              <div><dt>Expires</dt><dd>{when(reference.expiresAt)}</dd></div>
            </dl>
          </section>

          <section className="judgment-review-section" aria-labelledby="ratification-goal-heading">
            <h2 id="ratification-goal-heading">Goal</h2>
            <div className="owner-ratification-markdown">
              <Markdown remarkPlugins={[remarkGfm, remarkHardBreaks]} rehypePlugins={[rehypeHighlight]}>
                {display(contract.goal, '未声明 goal')}
              </Markdown>
            </div>
          </section>

          <section className="judgment-review-section" aria-labelledby="ratification-criteria-heading">
            <div className="judgment-section-title-row">
              <h2 id="ratification-criteria-heading">Completion criteria</h2>
              <span className="judgment-claim-count">{criteria.length} 条</span>
            </div>
            <ol className="owner-ratification-criteria">
              {criteria.map((criterion, index) => (
                <li key={`${criterion.semanticHash}:${index}`}>
                  <span>{criterion.text}</span>
                  <Tag>{trustByHash.get(criterion.semanticHash) ?? 'UNDECLARED'}</Tag>
                  <code>{shortDigest(criterion.semanticHash)}</code>
                </li>
              ))}
            </ol>
          </section>

          <section className="judgment-review-section" aria-labelledby="ratification-diff-heading">
            <h2 id="ratification-diff-heading">Semantic diff</h2>
            <p className="judgment-section-intro">本次 request 相对上一份 contract 的语义变化；首次请求会标记 initial。</p>
            <pre className="judgment-json">{JSON.stringify(surface.semanticDiff, null, 2)}</pre>
          </section>

          <section className="judgment-review-section" aria-labelledby="ratification-envelope-heading">
            <h2 id="ratification-envelope-heading">Risk、permission、recipient 与预算 envelope</h2>
            <div className="owner-ratification-envelope-grid">
              <article>
                <h3>Risk</h3>
                <dl>
                  <div><dt>Automation policy</dt><dd>{display(risk.automationPolicy)}</dd></div>
                  <div><dt>Convergence thresholds</dt><dd>{display(risk.convergenceThresholds)}</dd></div>
                  <div><dt>Unbounded authorization</dt><dd>{display(risk.unboundedAuthorizedBy, '未授权')}</dd></div>
                </dl>
              </article>
              <article>
                <h3>Permissions</h3>
                <dl>
                  <div><dt>Mode</dt><dd>{display(risk.automationPolicy)}</dd></div>
                  <div><dt>Coordinator enabled</dt><dd>{display(permissions.coordinatorEnabled)}</dd></div>
                  <div><dt>maxConcurrent</dt><dd>{display(permissions.maxConcurrentTasks)}</dd></div>
                </dl>
              </article>
              <article>
                <h3>Recipients</h3>
                <dl>
                  <div><dt>Owner</dt><dd>{display(recipients.ownerId)}</dd></div>
                  <div><dt>Coordinator agents</dt><dd>{display(recipients.coordinatorAgentIds, '[]')}</dd></div>
                  <div><dt>Members</dt><dd>{display(recipients.members, '[]')}</dd></div>
                </dl>
              </article>
              <article>
                <h3>Budget</h3>
                <dl>
                  <div><dt>sessionBudgetPerDay</dt><dd>{finiteBudget(budget.sessionBudgetPerDay)}</dd></div>
                  <div><dt>attemptBudget</dt><dd>{finiteBudget(budget.attemptBudget)}</dd></div>
                  <div><dt>Budget digest</dt><dd><code>{review.budgetDigest}</code></dd></div>
                </dl>
              </article>
            </div>
            <p className="owner-ratification-envelope-callout">
              当前执行模式：<strong>{display(risk.automationPolicy)}</strong>；并发上限：
              <strong>maxConcurrent={display(permissions.maxConcurrentTasks)}</strong>。
            </p>
          </section>

          <section className="judgment-review-section" aria-labelledby="ratification-authority-heading">
            <h2 id="ratification-authority-heading">为什么不能由 Agent 决定</h2>
            <p>{display(surface.whyNotAgent, 'Agent 或 runner 不能批准自己的 goal、authority、risk 或 budget。')}</p>
          </section>

          <section className="judgment-review-section" aria-labelledby="ratification-options-heading">
            <h2 id="ratification-options-heading">选项、影响与推荐</h2>
            <div className="owner-ratification-option-grid">
              <article>
                <Tag color="green">APPROVE</Tag>
                <h3>Ratify 此精确 digest</h3>
                <p>{display(surface.impacts.APPROVE)}</p>
              </article>
              <article>
                <Tag color="red">DENY</Tag>
                <h3>不授予此契约执行权限</h3>
                <p>{display(surface.impacts.DENY)}</p>
              </article>
            </div>
            <dl className="owner-ratification-consequences">
              <div><dt>推荐</dt><dd>{display(surface.recommendation)}</dd></div>
              <div><dt>不作为后果</dt><dd>{display(surface.noActionConsequence)}</dd></div>
              <div><dt>到期时间</dt><dd>{when(reference.expiresAt)}</dd></div>
              <div><dt>决定后自动续跑</dt><dd>{display(surface.resumeAfterDecision)}</dd></div>
            </dl>
          </section>

          <section className="judgment-decision owner-ratification-decision" aria-labelledby="ratification-decision-heading">
            <h2 id="ratification-decision-heading">Owner decision</h2>
            <p id="ratification-decision-fence">
              POST 只会提交上方 request <code>{reference.decisionRequestId}</code> 与精确 digest{' '}
              <code>{shortDigest(reference.contractDigest)}</code>。一次性 CTA 不进入 URL、页面文本或共享缓存。
            </p>
            <Checkbox
              checked={acknowledged}
              disabled={Boolean(outcome) || !capability.current}
              onChange={(event) => setAcknowledged(event.target.checked)}
            >
              我已审阅 goal、全部 {criteria.length} 条标准、semantic diff、权限、风险、接收者、预算与两种影响。
            </Checkbox>
            <div className="judgment-decision-actions" aria-describedby="ratification-decision-fence">
              <Button
                danger
                disabled={!acknowledged || !capability.current || Boolean(outcome) || Boolean(submitting)}
                loading={submitting === 'DENY'}
                onClick={() => void decide('DENY')}
              >
                DENY — 保持执行关闭
              </Button>
              <Button
                type="primary"
                disabled={!acknowledged || !capability.current || Boolean(outcome) || Boolean(submitting)}
                loading={submitting === 'APPROVE'}
                onClick={() => void decide('APPROVE')}
              >
                APPROVE exact digest
              </Button>
            </div>
            {failure?.networkRetry && retryDecision ? (
              <Button
                className="owner-ratification-network-retry"
                disabled={Boolean(submitting) || !capability.current}
                onClick={() => void decide(retryDecision)}
              >
                使用同一幂等键重试 {retryDecision}
              </Button>
            ) : null}
          </section>

          <details className="judgment-review-disclosure">
            <summary>完整 digest 与 evaluation plan</summary>
            <div className="judgment-audit-content">
              <dl className="judgment-facts">
                <div><dt>Evaluation plan digest</dt><dd><code>{review.evaluationPlanDigest}</code></dd></div>
                <div><dt>Risk digest</dt><dd><code>{review.riskPolicyDigest}</code></dd></div>
                <div><dt>Permission digest</dt><dd><code>{review.permissionDigest}</code></dd></div>
                <div><dt>Recipient digest</dt><dd><code>{review.recipientDigest}</code></dd></div>
              </dl>
              <pre className="judgment-json">{JSON.stringify(review.evaluationPlan, null, 2)}</pre>
            </div>
          </details>
        </>
      ) : review?.ratified ? (
        <p><Link to={`/projects/${projectId}`}>返回 Project</Link></p>
      ) : null}
    </div>
  );
}
