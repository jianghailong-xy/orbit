import { Tag } from 'antd';
import { Link } from 'react-router-dom';
import { shortDigest } from '../lib/judgments';
import {
  isActiveOwnerRatificationReference,
  ownerRatificationReviewPath,
  type OwnerRatificationReference,
} from '../lib/ownerRatification';

const when = (value: string): string => new Date(value).toLocaleString();

/**
 * Project-detail rendering of the exact secret-free reference also returned to `/judgments` and
 * Project Attention. It offers no inline decision: the one authenticated, no-store review route
 * owns both options and the one-use capability.
 */
export function OwnerRatificationSummary({
  reference,
}: {
  reference: OwnerRatificationReference | null | undefined;
}) {
  if (!isActiveOwnerRatificationReference(reference)) return null;
  return (
    <section
      className="owner-ratification-summary"
      aria-labelledby="owner-ratification-summary-heading"
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
      <div className="owner-ratification-summary-head">
        <div>
          <Tag color="volcano">Owner Ratification</Tag>
          <h2 id="owner-ratification-summary-heading">等待 Owner 审阅当前执行契约</h2>
        </div>
        <Link
          className="owner-ratification-summary-action"
          to={ownerRatificationReviewPath(reference.projectId, reference.decisionRequestId)}
        >
          安全审阅并决定 →
        </Link>
      </div>
      <dl className="owner-ratification-summary-facts">
        <div><dt>Request</dt><dd>{reference.decisionRequestId}</dd></div>
        <div><dt>Request revision</dt><dd>{reference.requestRevision}</dd></div>
        <div><dt>Obligation</dt><dd>{reference.obligationId}</dd></div>
        <div><dt>Obligation revision</dt><dd>{reference.obligationRevision}</dd></div>
        <div><dt>Contract digest</dt><dd title={reference.contractDigest}>{shortDigest(reference.contractDigest)}</dd></div>
        <div><dt>Reason</dt><dd>{reference.reasonCode}</dd></div>
        <div><dt>Why now</dt><dd>{reference.reason}</dd></div>
        <div><dt>Binding</dt><dd>{reference.eligibility.bindingStatus}</dd></div>
        <div><dt>Owner</dt><dd>{reference.owner} · {reference.ownerId}</dd></div>
        <div><dt>Evaluated through</dt><dd>{reference.evaluatedThroughWatermark}</dd></div>
        <div><dt>Expires</dt><dd>{when(reference.expiresAt)}</dd></div>
      </dl>
      <p>
        这里不包含决策按钮或 CTA token；所有决定都在专用审阅页绑定当前 request、digest 与一次性能力提交。
      </p>
    </section>
  );
}
