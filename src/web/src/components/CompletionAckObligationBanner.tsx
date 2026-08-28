import { SyncOutlined } from '@ant-design/icons';
import type { ControlPlaneObligation } from '../api';

export const COMPLETION_ACK_RETRYING_LINE = 'Command finished · completion receipt retrying';
export const COMPLETION_ACK_RETRYING_STATUS = 'Completion receipt retrying';

/**
 * Treat the canonical identity as the admission ticket for this UI. A malformed rolling-upgrade
 * payload must not turn an arbitrary server object into a high-priority operational warning.
 */
export function controlPlaneObligationsOf(source: {
  controlPlaneObligations?: ControlPlaneObligation[] | null;
} | null | undefined): ControlPlaneObligation[] {
  if (!Array.isArray(source?.controlPlaneObligations)) return [];
  return source.controlPlaneObligations.filter(
    (obligation) =>
      obligation != null &&
      typeof obligation.obligationId === 'string' &&
      obligation.obligationId.length > 0 &&
      (typeof obligation.obligationRevision === 'number' ||
        typeof obligation.obligationRevision === 'string'),
  );
}

const ownerLabel = (owner: string): string =>
  owner === 'PROJECT_COORDINATOR' || owner === 'COORDINATOR'
    ? 'Project coordinator'
    : owner.replaceAll('_', ' ').toLowerCase();

/**
 * A read-only incident banner. Recovery is owned by the routed obligation, so this surface does
 * not offer Cancel or Rerun buttons that would discard/re-execute already-successful work.
 */
export function CompletionAckObligationBanner({
  obligations,
}: {
  obligations?: ControlPlaneObligation[] | null;
}) {
  const canonical = controlPlaneObligationsOf({ controlPlaneObligations: obligations });
  if (canonical.length === 0) return null;

  return (
    <div className="completion-ack-obligations" aria-live="polite">
      {canonical.map((obligation) => (
        <section
          className="completion-ack-obligation"
          data-obligation-id={obligation.obligationId}
          data-obligation-revision={String(obligation.obligationRevision)}
          key={`${obligation.obligationId}:${obligation.obligationRevision}`}
          role="alert"
        >
          <div className="completion-ack-obligation-head">
            <SyncOutlined spin aria-hidden="true" />
            <span>{COMPLETION_ACK_RETRYING_LINE}</span>
          </div>
          <p className="completion-ack-obligation-reason">{obligation.reason}</p>
          <dl className="completion-ack-obligation-facts">
            <div>
              <dt>Obligation</dt>
              <dd>
                <code>{obligation.obligationId}</code>
                <span className="completion-ack-obligation-revision">
                  revision {obligation.obligationRevision}
                </span>
              </dd>
            </div>
            <div>
              <dt>Owner</dt>
              <dd>{ownerLabel(obligation.owner)}</dd>
            </div>
            <div>
              <dt>Next action</dt>
              <dd>{obligation.requiredAction}</dd>
            </div>
          </dl>
        </section>
      ))}
    </div>
  );
}
