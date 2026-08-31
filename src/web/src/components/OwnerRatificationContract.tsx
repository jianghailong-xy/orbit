import { Tag } from 'antd';
import Markdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { shortDigest } from '../lib/judgments';
import { remarkHardBreaks } from '../lib/remarkHardBreaks';
import type {
  OwnerRatificationDecisionSurface,
  OwnerRatificationReview,
} from '../lib/ownerRatification';

/**
 * Everything the agent actually wrote, rendered once and shared by every owner decision surface.
 *
 * The whole value of ratification is seeing WHAT was drafted, so a second surface that only grew
 * an "approve?" button would be worse than no second surface. It is one component rather than two
 * similar ones for the property the acceptance criteria state directly: the same pending question
 * read from the conversation it was drafted in and from the standalone review page must show the
 * same digest and the same contract. Identical markup is how that stops being a promise.
 *
 * No decision control lives here, and no CTA is accepted: the capability belongs in a caller's ref.
 */
export function OwnerRatificationContractSections({
  review,
  surface,
  idPrefix = 'ratification',
}: {
  review: OwnerRatificationReview;
  surface: OwnerRatificationDecisionSurface;
  idPrefix?: string;
}) {
  const reference = surface.reference;
  const contract = surface.semanticContract ?? review.semanticContract ?? {};
  const risk = record(contract.riskBoundary);
  const permissions = record(contract.permissions);
  const recipients = record(contract.recipients);
  const budget = record(contract.budget);
  const criteria = Array.isArray(contract.criteria) ? contract.criteria : [];
  const trust = Array.isArray(contract.criteriaTrust) ? contract.criteriaTrust : [];
  const trustByHash = new Map(trust.map((item) => [item.semanticHash, item.completionCriterion]));

  return (
    <>
      <section
        className="judgment-evidence-identity"
        aria-labelledby={`${idPrefix}-identity-heading`}
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
          <div><h2 id={`${idPrefix}-identity-heading`}>Canonical decision identity</h2></div>
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

      <section className="judgment-review-section" aria-labelledby={`${idPrefix}-goal-heading`}>
        <h2 id={`${idPrefix}-goal-heading`}>Goal</h2>
        <div className="owner-ratification-markdown" data-owner-ratification-goal="">
          <Markdown remarkPlugins={[remarkGfm, remarkHardBreaks]} rehypePlugins={[rehypeHighlight]}>
            {display(contract.goal, '未声明 goal')}
          </Markdown>
        </div>
      </section>

      <section className="judgment-review-section" aria-labelledby={`${idPrefix}-criteria-heading`}>
        <div className="judgment-section-title-row">
          <h2 id={`${idPrefix}-criteria-heading`}>Completion criteria</h2>
          <span className="judgment-claim-count">{criteria.length} 条</span>
        </div>
        <ol className="owner-ratification-criteria">
          {criteria.map((criterion, index) => (
            <li
              key={`${criterion.semanticHash}:${index}`}
              data-criterion-hash={criterion.semanticHash}
              data-completion-criterion={trustByHash.get(criterion.semanticHash) ?? 'UNDECLARED'}
            >
              <span>{criterion.text}</span>
              <Tag>{trustByHash.get(criterion.semanticHash) ?? 'UNDECLARED'}</Tag>
              <code>{shortDigest(criterion.semanticHash)}</code>
            </li>
          ))}
        </ol>
      </section>

      <section className="judgment-review-section" aria-labelledby={`${idPrefix}-diff-heading`}>
        <h2 id={`${idPrefix}-diff-heading`}>Semantic diff</h2>
        <p className="judgment-section-intro">本次 request 相对上一份 contract 的语义变化；首次请求会标记 initial。</p>
        <pre className="judgment-json">{JSON.stringify(surface.semanticDiff, null, 2)}</pre>
      </section>

      <section className="judgment-review-section" aria-labelledby={`${idPrefix}-envelope-heading`}>
        <h2 id={`${idPrefix}-envelope-heading`}>Risk、permission、recipient 与预算 envelope</h2>
        <div className="owner-ratification-envelope-grid">
          <article data-envelope="riskBoundary">
            <h3>Risk</h3>
            <dl>
              <div><dt>Automation policy</dt><dd>{display(risk.automationPolicy)}</dd></div>
              <div><dt>Convergence thresholds</dt><dd>{display(risk.convergenceThresholds)}</dd></div>
              <div><dt>Unbounded authorization</dt><dd>{display(risk.unboundedAuthorizedBy, '未授权')}</dd></div>
            </dl>
          </article>
          <article data-envelope="permissions">
            <h3>Permissions</h3>
            <dl>
              <div><dt>Mode</dt><dd>{display(risk.automationPolicy)}</dd></div>
              <div><dt>Coordinator enabled</dt><dd>{display(permissions.coordinatorEnabled)}</dd></div>
              <div><dt>maxConcurrent</dt><dd>{display(permissions.maxConcurrentTasks)}</dd></div>
            </dl>
          </article>
          <article data-envelope="recipients">
            <h3>Recipients</h3>
            <dl>
              <div><dt>Owner</dt><dd>{display(recipients.ownerId)}</dd></div>
              <div><dt>Coordinator agents</dt><dd>{display(recipients.coordinatorAgentIds, '[]')}</dd></div>
              <div><dt>Members</dt><dd>{display(recipients.members, '[]')}</dd></div>
            </dl>
          </article>
          <article data-envelope="budget">
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

      <section className="judgment-review-section" aria-labelledby={`${idPrefix}-authority-heading`}>
        <h2 id={`${idPrefix}-authority-heading`}>为什么不能由 Agent 决定</h2>
        <p data-owner-ratification-why-not-agent="">
          {display(surface.whyNotAgent, 'Agent 或 runner 不能批准自己的 goal、authority、risk 或 budget。')}
        </p>
      </section>

      <section className="judgment-review-section" aria-labelledby={`${idPrefix}-options-heading`}>
        <h2 id={`${idPrefix}-options-heading`}>选项、影响与推荐</h2>
        <div className="owner-ratification-option-grid">
          <article data-option="APPROVE">
            <Tag color="green">APPROVE</Tag>
            <h3>Ratify 此精确 digest</h3>
            <p>{display(surface.impacts.APPROVE)}</p>
          </article>
          <article data-option="DENY">
            <Tag color="red">DENY</Tag>
            <h3>不授予此契约执行权限</h3>
            <p>{display(surface.impacts.DENY)}</p>
          </article>
        </div>
        <dl className="owner-ratification-consequences">
          <div data-consequence="recommendation"><dt>推荐</dt><dd>{display(surface.recommendation)}</dd></div>
          <div data-consequence="noAction"><dt>不作为后果</dt><dd>{display(surface.noActionConsequence)}</dd></div>
          <div data-consequence="cost"><dt>成本上限</dt><dd>{costCeiling(budget)}</dd></div>
          <div data-consequence="expiry"><dt>到期时间</dt><dd>{when(reference.expiresAt)}</dd></div>
          <div data-consequence="resume"><dt>决定后自动续跑</dt><dd>{display(surface.resumeAfterDecision)}</dd></div>
        </dl>
      </section>
    </>
  );
}

/** The full digest/evaluation-plan audit trail, disclosed rather than dumped inline. */
export function OwnerRatificationContractDisclosure({
  review,
}: {
  review: OwnerRatificationReview;
}) {
  return (
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
  );
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function display(value: unknown, fallback = '未声明'): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return fallback;
  return JSON.stringify(value);
}

/** A null budget is an ABSENT ceiling, which is not the same statement as an authorized infinite
 *  one. Spelling it out is the difference between reading "unlimited" and reading "undeclared". */
export function finiteBudget(value: unknown): string {
  return value === null || value === undefined
    ? '未声明有限额度（null；不等于 Owner 已授权无限额度）'
    : display(value);
}

/** What approving costs at most, in the contract's own two budget terms. */
export function costCeiling(budget: Record<string, unknown>): string {
  return `sessionBudgetPerDay=${finiteBudget(budget.sessionBudgetPerDay)}`
    + ` · attemptBudget=${finiteBudget(budget.attemptBudget)}`;
}

export function when(value: string): string {
  return new Date(value).toLocaleString();
}
