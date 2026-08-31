import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Checkbox, Tag } from 'antd';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { shortDigest } from '../lib/judgments';
import {
  isActiveOwnerRatificationReference,
  ownerRatificationDecisionPath,
  ownerRatificationPath,
  ownerRatificationReviewPath,
  ownerRatificationSessionInboxPath,
  splitOwnerRatificationCapability,
  type OwnerRatificationInboxPage,
  type OwnerRatificationPrivateRead,
  type OwnerRatificationReference,
  type OwnerRatificationReview,
} from '../lib/ownerRatification';
import {
  newOwnerRatificationIdempotencyKey,
  ownerRatificationFailure,
  type OwnerRatificationDecision as Decision,
  type OwnerRatificationFailure as SafeFailure,
} from '../lib/ownerRatificationDecision';
import {
  OwnerRatificationContractDisclosure,
  OwnerRatificationContractSections,
} from './OwnerRatificationContract';

/**
 * The third path: an agent drafts the completion contract in this conversation, the owner reads
 * the rendered contract HERE, and confirms it with their own credential.
 *
 * It introduces no authorization model. `project.coordinator_session_id` already records which
 * conversation a contract was drafted in, and the two owner-authenticated routes this uses are the
 * ones the standalone review page has always used. What was missing was only the surface: the
 * product's own way of creating work is conversational, while the one path that skipped a pending
 * question was the Web form — so the more a person used Orbit as designed, the more often they
 * were sent to a different page to approve what they had just asked for.
 *
 * What it deliberately does NOT do:
 *  - It does not weaken `OWNER_RATIFICATION_ACTOR_FORBIDDEN`. The runner that drafted this cannot
 *    decide it, here or anywhere; the POST below carries the reader's own session credential and
 *    the server re-derives the owner from it.
 *  - It does not replace the inbox or the review page. Both still work, and both show this same
 *    request, rendered by the same component so the two cannot disagree.
 *  - It never decides anything on its own. There is no timeout, no default, and no retry that can
 *    become an approval: every write starts from a click on this card.
 *
 * The secret-free session-scoped inbox read is what decides whether to ask for the private read at
 * all, so opening an ordinary conversation neither mints a capability nor touches the contract.
 */
export function SessionOwnerRatificationCard({
  sessionId,
}: {
  sessionId?: string | null;
}) {
  const queryClient = useQueryClient();
  const capability = useRef<string | null>(null);
  const inFlight = useRef(false);
  const idempotency = useRef<Partial<Record<Decision, string>>>({});
  const [review, setReview] = useState<OwnerRatificationReview | null>(null);
  const [failure, setFailure] = useState<SafeFailure | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [submitting, setSubmitting] = useState<Decision | null>(null);
  const [outcome, setOutcome] = useState<{
    decision: Decision;
    rearmedWakeups: number | null;
  } | null>(null);

  const pending = useQuery({
    queryKey: ['owner-ratification', 'session', sessionId ?? null] as const,
    queryFn: () => api<OwnerRatificationInboxPage>(ownerRatificationSessionInboxPath(sessionId!)),
    enabled: Boolean(sessionId),
    // The question is raised by work happening in this very conversation, so a cached "nothing to
    // decide" from before the agent filed the project would hide it for as long as the tab is open.
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

  const drafted: OwnerRatificationReference | null = (pending.data?.items ?? [])
    .find((item) => isActiveOwnerRatificationReference(item)
      && item.coordinatorSessionId === sessionId) ?? null;
  const requestId = drafted?.decisionRequestId ?? null;
  const projectId = drafted?.projectId ?? null;
  const renderedDigest = drafted?.contractDigest ?? null;

  /**
   * Read the private contract for the exact question the secret-free reference named, and keep the
   * one-use capability in a ref that no render, cache entry or devtools inspection can reach.
   */
  const load = useCallback(async () => {
    if (!projectId || !requestId || !renderedDigest) return;
    setFailure(null);
    capability.current = null;
    try {
      const raw = await api<OwnerRatificationPrivateRead>(ownerRatificationPath(projectId));
      const split = splitOwnerRatificationCapability(raw);
      setReview(split.review);
      const projected = split.review.decisionSurface?.reference ?? null;
      const current = isActiveOwnerRatificationReference(projected) ? projected : null;
      const request = split.review.decisionRequest;
      // Approve-what-you-see, enforced before a button is ever enabled: the private read must
      // still describe the same request and the same digest the card is about to render.
      const exact = Boolean(
        current
        && request
        && current.decisionRequestId === requestId
        && request.id === requestId
        && current.contractDigest === split.review.contractDigest
        && request.contractDigest === split.review.contractDigest
        && current.owner === 'OWNER'
        && request.status === 'PENDING',
      );
      if (!exact) {
        setFailure({
          code: split.review.ratified ? 'ALREADY_RATIFIED' : 'OWNER_DECISION_STALE',
          message: split.review.ratified
            ? '此精确契约已由 Owner ratify；本卡片不会再次提交。'
            : '契约在本会话渲染后已经变化；卡片已 fail closed，请载入当前 request 重新审阅。',
          reloadCurrent: true,
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
          message: '该 CTA 已到期；重新载入会取得服务器生成的当前 request，不会产生第二条 ratification。',
          reloadCurrent: true,
          networkRetry: false,
        });
      } else {
        capability.current = split.ctaToken;
      }
    } catch (error) {
      capability.current = null;
      setFailure(ownerRatificationFailure(error));
    }
  }, [projectId, renderedDigest, requestId]);

  useEffect(() => {
    setAcknowledged(false);
    setOutcome(null);
    idempotency.current = {};
    void load();
    return () => {
      capability.current = null;
      inFlight.current = false;
    };
  }, [load]);

  const reload = useCallback(async () => {
    capability.current = null;
    setReview(null);
    setFailure(null);
    setAcknowledged(false);
    await queryClient.invalidateQueries({ queryKey: ['owner-ratification'] });
    await pending.refetch();
    await load();
  }, [load, pending, queryClient]);

  const decide = async (decision: Decision) => {
    const reference = review?.decisionSurface?.reference;
    const token = capability.current;
    if (!projectId || !requestId || !reference || !token || !acknowledged || inFlight.current
        || reference.decisionRequestId !== requestId
        || reference.contractDigest !== review?.contractDigest
        || reference.contractDigest !== renderedDigest
        || Date.parse(reference.expiresAt) <= Date.now()) {
      setFailure({
        code: 'OWNER_DECISION_LOCAL_FENCE',
        message: '本卡片无法证明 request、digest、CTA、到期时间与确认状态仍精确匹配；未发送决定。',
        reloadCurrent: true,
        networkRetry: false,
      });
      return;
    }
    inFlight.current = true;
    setSubmitting(decision);
    setFailure(null);
    const key = idempotency.current[decision]
      ?? newOwnerRatificationIdempotencyKey(reference.decisionRequestId, decision, 'session');
    idempotency.current[decision] = key;
    try {
      const result = await api<Record<string, unknown>>(ownerRatificationDecisionPath(projectId), {
        method: 'POST',
        body: {
          decision,
          decisionRequestId: reference.decisionRequestId,
          ctaToken: token,
          // The digest of what was rendered above, never a digest re-read at click time: if the
          // agent changed the contract after this card painted, the server refuses with a typed
          // reason instead of ratifying something the reader never saw.
          expectedContractDigest: reference.contractDigest,
          idempotencyKey: key,
        },
      });
      capability.current = null;
      const resume = result.automaticResume as { rearmedWakeups?: unknown } | undefined;
      setOutcome({
        decision,
        rearmedWakeups: typeof resume?.rearmedWakeups === 'number' ? resume.rearmedWakeups : null,
      });
      setAcknowledged(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['owner-ratification'] }),
        queryClient.invalidateQueries({ queryKey: ['projects'] }),
        queryClient.invalidateQueries({ queryKey: ['project', projectId] }),
      ]);
    } catch (error) {
      const safe = ownerRatificationFailure(error);
      if (!safe.networkRetry) capability.current = null;
      setFailure(safe);
    } finally {
      inFlight.current = false;
      setSubmitting(null);
    }
  };

  if (!sessionId || !drafted || !projectId) return null;

  const surface = review?.decisionSurface ?? null;
  const contract = surface?.semanticContract ?? review?.semanticContract ?? {};
  const criteria = Array.isArray(contract.criteria) ? contract.criteria : [];

  return (
    <section
      className="session-owner-ratification"
      aria-labelledby="session-owner-ratification-heading"
      data-session-owner-ratification=""
      data-session-id={sessionId}
      data-project-id={projectId}
      data-decision-request-id={drafted.decisionRequestId}
      data-contract-digest={drafted.contractDigest}
    >
      <header className="session-owner-ratification-head">
        <Tag color="volcano">Owner Ratification</Tag>
        <h2 id="session-owner-ratification-heading">
          此对话起草了一份完成契约，需要你本人确认
        </h2>
        <p className="session-owner-ratification-sub">
          {drafted.projectTitle} · Agent 用 runner 凭证起草，因此需要 Owner 凭证批准；
          你在这里看到的就是它写下的内容，批准提交的也正是这一份 digest{' '}
          <code>{shortDigest(drafted.contractDigest)}</code>。
        </p>
        <Link
          className="session-owner-ratification-review-link"
          to={ownerRatificationReviewPath(projectId, drafted.decisionRequestId)}
        >
          在独立审阅页打开同一份待批 →
        </Link>
      </header>

      {failure ? (
        <Alert
          className="session-owner-ratification-alert"
          type={failure.code === 'ALREADY_RATIFIED' ? 'success' : 'warning'}
          showIcon
          message={failure.code}
          description={failure.message}
          action={failure.reloadCurrent ? (
            <Button onClick={() => void reload()}>载入当前 request</Button>
          ) : undefined}
        />
      ) : null}

      {outcome ? (
        <Alert
          className="session-owner-ratification-alert"
          type={outcome.decision === 'APPROVE' ? 'success' : 'info'}
          showIcon
          message={`${outcome.decision} 已提交`}
          description={outcome.decision === 'APPROVE'
            ? `精确 contract digest 已 ratify；同一事务重新武装了 ${outcome.rearmedWakeups ?? 0} 个持久化 wake，`
              + '工作会自动重新进入 GUARDED_AUTO admission，无需第二次点击。'
            : '该 request 已拒绝；未授予执行权限，自动副作用执行保持关闭。'}
        />
      ) : null}

      {review && surface ? (
        <>
          <OwnerRatificationContractSections
            review={review}
            surface={surface}
            idPrefix="session-ratification"
          />

          <section
            className="judgment-decision owner-ratification-decision session-owner-ratification-decision"
            aria-labelledby="session-ratification-decision-heading"
          >
            <h2 id="session-ratification-decision-heading">Owner decision</h2>
            <p id="session-ratification-decision-fence">
              这条 POST 使用你自己的已认证连接，只提交上方 request{' '}
              <code>{drafted.decisionRequestId}</code> 与你所看到的精确 digest{' '}
              <code>{shortDigest(drafted.contractDigest)}</code>。runner 不代传，也不存在超时或重试
              会替你同意的路径。
            </p>
            <Checkbox
              checked={acknowledged}
              disabled={Boolean(outcome) || !capability.current}
              onChange={(event) => setAcknowledged(event.target.checked)}
            >
              我已在本对话内审阅 goal、全部 {criteria.length} 条标准、风险、权限与预算 envelope。
            </Checkbox>
            <div
              className="judgment-decision-actions"
              aria-describedby="session-ratification-decision-fence"
            >
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
          </section>

          <OwnerRatificationContractDisclosure review={review} />
        </>
      ) : (
        <p className="session-owner-ratification-loading" role="status">正在读取本会话起草的契约…</p>
      )}
    </section>
  );
}
