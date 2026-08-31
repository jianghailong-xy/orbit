import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Checkbox, Spin, Tag } from 'antd';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { routeId } from '../lib/idCodec';
import { shortDigest } from '../lib/judgments';
import {
  OwnerRatificationContractDisclosure,
  OwnerRatificationContractSections,
} from '../components/OwnerRatificationContract';
import {
  isActiveOwnerRatificationReference,
  ownerRatificationDecisionPath,
  ownerRatificationPath,
  ownerRatificationReviewPath,
  splitOwnerRatificationCapability,
  type OwnerRatificationPrivateRead,
  type OwnerRatificationReview,
} from '../lib/ownerRatification';
import {
  newOwnerRatificationIdempotencyKey,
  ownerRatificationFailure,
  type OwnerRatificationDecision as Decision,
  type OwnerRatificationFailure as SafeFailure,
} from '../lib/ownerRatificationDecision';

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
      setFailure(ownerRatificationFailure(error));
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
      ?? newOwnerRatificationIdempotencyKey(reference.decisionRequestId, decision);
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
      const safe = ownerRatificationFailure(error);
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
  const criteria = Array.isArray(contract.criteria) ? contract.criteria : [];
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

      {reference && review && surface ? (
        <>
          <OwnerRatificationContractSections review={review} surface={surface} />

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

          <OwnerRatificationContractDisclosure review={review} />
        </>
      ) : review?.ratified ? (
        <p><Link to={`/projects/${projectId}`}>返回 Project</Link></p>
      ) : null}
    </div>
  );
}
