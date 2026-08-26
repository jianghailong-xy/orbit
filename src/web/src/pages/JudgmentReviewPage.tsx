import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Spin, Tag } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { encodeId, routeId } from '../lib/idCodec';
import {
  judgmentReviewPath,
  shortDigest,
  type JudgmentReview,
} from '../lib/judgments';

const when = (value?: string | null): string => value ? new Date(value).toLocaleString() : '—';

function JsonFact({ value }: { value: unknown }) {
  return <pre className="judgment-json">{JSON.stringify(value, null, 2)}</pre>;
}

const STATE_COPY: Record<JudgmentReview['reviewState'], { label: string; color: string; text: string }> = {
  ACTION_REQUIRED: { label: 'Current · action required', color: 'gold', text: 'This is the current evidence revision and is ready for your decision.' },
  AWAITING_NEW_EVIDENCE: { label: 'Waiting for new evidence', color: 'blue', text: 'More evidence was requested. The task remains unchanged while a new revision is prepared.' },
  APPROVED: { label: 'Signed off', color: 'green', text: 'The human sign-off was recorded and task state was derived by the server.' },
  SUPERSEDED: { label: 'Superseded', color: 'default', text: 'A newer evidence revision replaced this request. This version is read-only history.' },
  DECIDED: { label: 'Decided', color: 'default', text: 'This request is already decided and remains in the audit history.' },
  EVIDENCE_REVISED: { label: 'New evidence received', color: 'blue', text: 'The requested new evidence has arrived. Open its current request to decide it.' },
};

export function JudgmentReviewPage() {
  const requestId = routeId(useParams().id);
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const [inlineError, setInlineError] = useState<string | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const decisionRef = useRef<HTMLTextAreaElement>(null);
  const currentRequestRef = useRef<HTMLAnchorElement>(null);
  const focusedRequestRef = useRef<string | null>(null);
  const review = useQuery({
    queryKey: ['judgment', requestId],
    queryFn: () => api<JudgmentReview>(`/judgments/${encodeURIComponent(requestId!)}`),
    enabled: Boolean(requestId),
  });

  useEffect(() => {
    if (review.isSuccess && focusedRequestRef.current !== requestId) {
      focusedRequestRef.current = requestId;
      headingRef.current?.focus();
    }
  }, [review.isSuccess, requestId]);
  useEffect(() => {
    if (inlineError) errorRef.current?.focus();
  }, [inlineError]);

  const refreshRelated = async (data: JudgmentReview) => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['judgments'] }),
      qc.invalidateQueries({ queryKey: ['task', data.task.id] }),
      qc.invalidateQueries({ queryKey: ['tasks'] }),
      data.task.projectId
        ? qc.invalidateQueries({ queryKey: ['project', data.task.projectId] })
        : Promise.resolve(),
      qc.invalidateQueries({ queryKey: ['projects'] }),
    ]);
  };

  const decide = useMutation({
    mutationFn: (action: 'PASS' | 'REQUEST_MORE_EVIDENCE') => {
      if (!review.data || !requestId) throw new Error('The review is not ready.');
      return api<JudgmentReview>(`/judgments/${encodeURIComponent(requestId)}/decision`, {
        method: 'POST',
        body: {
          requestId: review.data.request.id,
          evidenceDigest: review.data.evidence.digest,
          action,
          note: note.trim(),
        },
      });
    },
    onMutate: () => setInlineError(null),
    onSuccess: async (serverRead) => {
      setNote('');
      await refreshRelated(serverRead);
      // Deliberate server re-read after the write: no optimistic DONE/request/signal projection.
      await review.refetch();
    },
    onError: async (error: Error) => {
      // Preserve the server's original refusal inline, then refresh so a stale/superseded press
      // immediately reveals the current revision beside that refusal.
      setInlineError(error.message);
      if (review.data) await refreshRelated(review.data);
      await review.refetch();
    },
  });

  if (!requestId) {
    return <Alert type="error" showIcon message="Judgment request could not be loaded" description="This link is missing a request id." />;
  }
  if (review.isLoading) {
    return <div className="judgment-loading" role="status" aria-label="Loading judgment request"><Spin /></div>;
  }
  if (review.isError || !review.data) {
    return (
      <Alert
        type="error"
        showIcon
        message="Judgment request could not be loaded"
        description={review.error instanceof Error ? review.error.message : undefined}
        action={(
          <Button
            danger
            size="small"
            loading={review.isFetching}
            disabled={review.isFetching}
            onClick={() => review.refetch()}
          >
            Retry
          </Button>
        )}
      />
    );
  }

  const data = review.data;
  const state = STATE_COPY[data.reviewState];
  const actionable = data.isCurrent && data.reviewState === 'ACTION_REQUIRED';
  const currentRequestLink = data.currentEvidence.requestId
    && data.currentEvidence.requestId !== data.request.id
      ? judgmentReviewPath(data.currentEvidence.requestId)
      : null;
  const dependentNodes = data.derived.dependencyGraph.nodes.filter((node) => node.id !== data.task.id);

  return (
    <article className="judgment-page judgment-review-page">
      <Link to="/judgments">← 待我判定</Link>
      <header className="judgment-review-head">
        <div>
          <h1 ref={headingRef} tabIndex={-1} className="page-title">Review evidence</h1>
          <p>{data.task.title}</p>
        </div>
        <Tag color={state.color}>{state.label}</Tag>
      </header>

      <Alert
        className="judgment-state-alert"
        type={data.reviewState === 'APPROVED' ? 'success' : data.isCurrent ? 'info' : 'warning'}
        showIcon
        message={state.text}
        description={currentRequestLink ? <Link ref={currentRequestRef} to={currentRequestLink}>Open current evidence r{data.currentEvidence.revision} →</Link> : undefined}
      />

      {inlineError && (
        <div ref={errorRef} tabIndex={-1} role="alert" className="judgment-inline-error">
          <strong>Decision was not recorded.</strong>
          <span>{inlineError}</span>
          <Button
            size="small"
            danger
            onClick={() => {
              setInlineError(null);
              decide.reset();
              if (actionable) decisionRef.current?.focus();
              else if (currentRequestRef.current) currentRequestRef.current.focus();
              else headingRef.current?.focus();
            }}
            disabled={decide.isPending}
          >
            Dismiss
          </Button>
        </div>
      )}

      <section className="judgment-review-section" aria-labelledby="judgment-task-heading">
        <h2 id="judgment-task-heading">Task and completion criterion</h2>
        <dl className="judgment-facts">
          <div><dt>Task objective</dt><dd>{data.task.objective || 'No objective provided'}</dd></div>
          <div><dt>Acceptance criteria</dt><dd>{data.task.acceptanceCriteria || 'No acceptance criteria provided'}</dd></div>
          <div><dt>Completion criterion</dt><dd>{data.task.completionCriterion}</dd></div>
          <div><dt>Task status (server)</dt><dd>{data.derived.taskStatus}</dd></div>
        </dl>
        <h3>Criterion snapshot</h3>
        <JsonFact value={data.criterion} />
      </section>

      <section className="judgment-review-section" aria-labelledby="judgment-evidence-heading">
        <div className="judgment-section-title-row">
          <h2 id="judgment-evidence-heading">Structured evidence</h2>
          <Tag color={data.isCurrent ? 'green' : 'default'}>{data.isCurrent ? 'Current' : 'Not current'}</Tag>
        </div>
        <dl className="judgment-facts judgment-evidence-facts">
          <div><dt>Evidence revision</dt><dd>r{data.evidence.revision}</dd></div>
          <div><dt>Evidence digest</dt><dd className="judgment-digest" title={data.evidence.digest}>{data.evidence.digest}</dd></div>
          <div><dt>Current evidence revision</dt><dd>r{data.currentEvidence.revision}</dd></div>
          <div><dt>Current evidence digest</dt><dd className="judgment-digest" title={data.currentEvidence.digest}>{data.currentEvidence.digest}</dd></div>
          <div><dt>Submitted by</dt><dd>{data.evidence.actorName ?? data.evidence.actorType}</dd></div>
          <div><dt>Submitted at</dt><dd>{when(data.evidence.submittedAt)}</dd></div>
          <div><dt>Commit</dt><dd>{data.evidence.commit ?? 'Not provided'}</dd></div>
          <div><dt>Test summary</dt><dd>{data.evidence.testSummary == null ? 'Not provided' : <JsonFact value={data.evidence.testSummary} />}</dd></div>
          <div><dt>Request version</dt><dd>v{data.requestVersion}</dd></div>
          <div><dt>Request status</dt><dd>{data.request.status}</dd></div>
        </dl>
        <JsonFact value={data.evidence.structured} />
      </section>

      <section className="judgment-review-section" aria-labelledby="judgment-derived-heading" aria-live="polite">
        <h2 id="judgment-derived-heading">Server-derived result</h2>
        <dl className="judgment-facts judgment-derived-facts">
          <div><dt>Task status</dt><dd>{data.derived.taskStatus}</dd></div>
          <div><dt>Request</dt><dd>{data.request.status}{data.request.decision ? ` · ${data.request.decision}` : ''}</dd></div>
          <div><dt>Signal</dt><dd>{data.derived.signalOpen ? 'Open' : 'Closed'}</dd></div>
          <div><dt>Blocker</dt><dd>{data.derived.blockerOpen ? 'Open' : 'Closed'}</dd></div>
        </dl>
        <h3>Direct dependency state</h3>
        {dependentNodes.length === 0 ? (
          <p className="judgment-muted">No direct task dependencies.</p>
        ) : (
          <ul className="judgment-dependencies">
            {dependentNodes.map((node) => (
              <li key={node.id}>
                <Link to={`/tasks/${encodeId(node.id)}`}>{node.title}</Link>
                <span>{node.status} · {node.dependencyState}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="judgment-review-section" aria-labelledby="judgment-history-heading">
        <h2 id="judgment-history-heading">Evidence history</h2>
        <div className="judgment-history">
          {data.history.map((entry) => (
            <details key={entry.id} open={entry.id === data.evidence.id}>
              <summary>
                <span>Revision {entry.revision}</span>
                <span>{shortDigest(entry.digest)}</span>
                <span>{entry.isCurrentEvidence ? 'Current evidence' : entry.requests[0]?.status ?? 'Historical'}</span>
              </summary>
              <dl className="judgment-facts">
                <div><dt>Actor</dt><dd>{entry.actorName ?? entry.actorType}</dd></div>
                <div><dt>Submitted</dt><dd>{when(entry.submittedAt)}</dd></div>
                <div><dt>Commit</dt><dd>{entry.commit ?? 'Not provided'}</dd></div>
                <div><dt>Decision</dt><dd>{entry.requests[0]?.decision ?? entry.requests[0]?.status ?? 'None'}</dd></div>
              </dl>
              {entry.requests[0]?.decisionNote && <p>{entry.requests[0].decisionNote}</p>}
              {entry.requests[0]?.signoff && <p>{entry.requests[0].signoff.evidence}</p>}
              <JsonFact value={entry.structured} />
            </details>
          ))}
        </div>
      </section>

      <section className="judgment-decision" aria-labelledby="judgment-decision-heading">
        <h2 id="judgment-decision-heading">Your decision</h2>
        <label htmlFor="judgment-decision-note">Decision note</label>
        <textarea
          id="judgment-decision-note"
          ref={decisionRef}
          rows={5}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          disabled={!actionable || decide.isPending}
          aria-describedby="judgment-decision-help"
        />
        <p id="judgment-decision-help">
          For approval, record what you checked. For more evidence, say exactly what is missing.
        </p>
        <div className="judgment-decision-actions">
          <Button
            type="primary"
            loading={decide.isPending && decide.variables === 'PASS'}
            disabled={!actionable || !note.trim() || decide.isPending}
            onClick={() => decide.mutate('PASS')}
          >
            签字通过
          </Button>
          <Button
            loading={decide.isPending && decide.variables === 'REQUEST_MORE_EVIDENCE'}
            disabled={!actionable || !note.trim() || decide.isPending}
            onClick={() => decide.mutate('REQUEST_MORE_EVIDENCE')}
          >
            要求补充证据
          </Button>
        </div>
      </section>
    </article>
  );
}
