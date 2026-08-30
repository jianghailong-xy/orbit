import { Tag, Typography } from 'antd';
import { Link } from 'react-router-dom';

import { encodeId } from '../lib/idCodec';
import {
  FAILURE_STAGE_LABEL,
  canonicalReasonLabel,
  type CanonicalFailureCoordination,
} from '../lib/failureCoordination';

const when = (value: string): string => new Date(value).toLocaleString();
const digest = (value: string): string => value.length > 18
  ? `${value.slice(0, 10)}…${value.slice(-6)}`
  : value;

/** One rendering of the canonical Failure Continuation document, shared by task and project UI. */
export function FailureCoordinationCard({
  item,
  compact = false,
}: {
  item: CanonicalFailureCoordination;
  compact?: boolean;
}) {
  return (
    <section
      className="failure-coordination-card"
      data-obligation-id={item.obligationId}
      data-obligation-revision={item.obligationRevision}
      data-binding-digest={item.bindingDigest}
      data-failure-reason={String(item.canonicalReason.code ?? '')}
      data-coordination-stage={item.stage}
      style={{
        marginTop: compact ? 8 : 12,
        padding: compact ? '10px 12px' : '12px 14px',
        border: `1px solid ${item.attention.required ? 'var(--warning-border)' : 'var(--border-subtle)'}`,
        borderRadius: 8,
        background: item.attention.required ? 'var(--warning-bg)' : 'var(--fill-muted)',
      }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        <Typography.Text strong>Failure Continuation</Typography.Text>
        <Tag color={item.stage === 'NEEDS_YOU' ? 'volcano' : item.stage === 'EXTERNAL_WAIT' ? 'blue' : 'purple'}>
          {FAILURE_STAGE_LABEL[item.stage]}
        </Tag>
        {item.attention.reasonCode ? <Tag color="gold">{item.attention.reasonCode}</Tag> : null}
      </div>
      <dl
        className="failure-coordination-facts"
        style={{
          display: 'grid',
          gridTemplateColumns: compact ? 'minmax(110px, auto) minmax(0, 1fr)' : 'minmax(130px, auto) minmax(0, 1fr)',
          gap: '4px 12px',
          margin: '10px 0 0',
          fontSize: 12,
        }}
      >
        <dt>Canonical reason</dt><dd style={{ margin: 0 }}>{canonicalReasonLabel(item)}</dd>
        <dt>Failed node</dt><dd style={{ margin: 0 }}>{item.failureNode}</dd>
        <dt>Fingerprint</dt><dd style={{ margin: 0 }}><code title={item.failureFingerprint}>{digest(item.failureFingerprint)}</code></dd>
        <dt>Evidence</dt>
        <dd style={{ margin: 0 }}>
          <code title={item.evidenceDigest}>{digest(item.evidenceDigest)}</code>
          <details>
            <summary>{item.evidenceSources.length} canonical source{item.evidenceSources.length === 1 ? '' : 's'}</summary>
            <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: '6px 0 0' }}>
              {JSON.stringify({ evidence: item.evidence, sources: item.evidenceSources }, null, 2)}
            </pre>
          </details>
        </dd>
        <dt>Deadline</dt><dd style={{ margin: 0 }}><time dateTime={item.deadlineAt}>{when(item.deadlineAt)}</time></dd>
        <dt>Coordinator</dt>
        <dd style={{ margin: 0 }}>
          {item.coordinator.wakeupState} · claim SLA {item.coordinator.claimSlaSeconds}s
        </dd>
        <dt>Obligation</dt><dd style={{ margin: 0 }}><code title={item.obligationId}>{item.obligationId}</code></dd>
        <dt>Revision / binding</dt>
        <dd style={{ margin: 0 }}>
          <code title={item.obligationRevision}>{digest(item.obligationRevision)}</code>
          {' / '}
          <code title={item.bindingDigest}>{digest(item.bindingDigest)}</code>
        </dd>
        <dt>Failed attempt</dt>
        <dd style={{ margin: 0 }}>
          preserved · {item.failedAttempt.terminationKind}
          {item.failedAttempt.actualExitCode === null ? '' : ` · exit ${item.failedAttempt.actualExitCode}`}
        </dd>
        <dt>Successor</dt>
        <dd style={{ margin: 0 }}>
          {item.successor ? (
            <Link to={`/tasks/${encodeId(item.successor.taskId)}`}>
              {item.successor.title} · {item.successor.status} · binding g{item.successor.bindingGeneration}
            </Link>
          ) : 'Coordinator has not rebound this obligation yet'}
        </dd>
      </dl>
    </section>
  );
}
