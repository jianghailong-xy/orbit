import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Skeleton, Space, Tag, Typography } from 'antd';
import { api } from '../api';
import { projectCrossingsQuery } from '../lib/queries';
import {
  CROSSING_STATE_LABEL,
  CROSSING_STATE_MEANING,
  labelFor,
  orderCrossings,
  type CrossingState,
  type ProjectCrossingRow,
} from '../lib/attribution';

/**
 * Unit L7: the declared crossings this project is an end of, and the one place a person answers
 * them.
 *
 * §7 RB2 is the whole reason this is a screen and not an automation: the approver of a
 * cross-project crossing is the USER. Not the target project's coordinator — an agent signing for
 * another agent is the original incident with one more actor in it — so the question has to reach
 * somebody, and a question nobody can see is a project that quietly stops.
 *
 * ANSWERING TAKES TWO PRESSES, and the second one is not a formality. It names both ends, the
 * subject and the crossing key, and it sends that key back to the server, which refuses an answer
 * that names a different crossing than the row at that id (`APPROVAL_TARGET_MISMATCH`). A queue
 * that reordered between the render and the click is exactly the case the fence catches — without
 * it, one considered answer becomes an answer about somebody else's work.
 */

/** What the second press is agreeing to, as data rather than as a sentence built at the call site.
 *  Exported because it is the part worth testing: the prompt must name both ends, or it is a
 *  confirmation of nothing. */
export function crossingConfirmPrompt(
  row: ProjectCrossingRow,
  decision: 'APPROVE' | 'DENY',
): { verb: string; from: string; to: string; subject: string; consequence: string } {
  return {
    verb: decision === 'APPROVE' ? 'Approve' : 'Refuse',
    from: row.fromProject?.title ?? (row.fromProjectPublicId ?? row.fromProjectId),
    to: row.toProject?.title ?? (row.toProjectPublicId ?? row.toProjectId),
    subject: row.title,
    consequence:
      decision === 'APPROVE'
        ? 'The writer may then file this work under the target project. It is not filed by this answer.'
        : 'Refusing is final for this crossing. If you change your mind, file the work yourself.',
  };
}

/** A crossing that is still a question is the only one that can be answered. */
export function isAnswerable(state: CrossingState): boolean {
  return state === 'PENDING';
}

function ProjectEnd({
  title,
  id,
  status,
}: {
  title: string | undefined;
  id: string;
  status: string | undefined;
}) {
  return (
    <span>
      <Typography.Text strong>{title ?? 'unnamed project'}</Typography.Text>{' '}
      <Typography.Text code copyable={{ text: id }}>
        {id}
      </Typography.Text>
      {status ? (
        <>
          {' '}
          <Tag aria-label={`Project status ${status}`}>{status}</Tag>
        </>
      ) : null}
    </span>
  );
}

/**
 * One crossing.
 *
 * `confirming` is held by the parent rather than by the row, so opening a second confirmation
 * closes the first: two rows both showing "are you sure" is two questions competing for one press.
 */
export function CrossingRow({
  row,
  confirming,
  busy,
  error,
  onAsk,
  onCancel,
  onAnswer,
}: {
  row: ProjectCrossingRow;
  confirming: 'APPROVE' | 'DENY' | null;
  busy: boolean;
  error: Error | null;
  onAsk: (decision: 'APPROVE' | 'DENY') => void;
  onCancel: () => void;
  onAnswer: (decision: 'APPROVE' | 'DENY') => void;
}) {
  const prompt = confirming ? crossingConfirmPrompt(row, confirming) : null;
  return (
    <li
      style={{ listStyle: 'none', padding: '10px 0', borderTop: '1px solid var(--border-subtle)' }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        {/* The state is a WORD before it is anything else (AC5): the tag carries the server's own
            value and the sentence beside it says what follows from it. */}
        <Tag aria-label={`Crossing ${row.state}`}>{row.state}</Tag>
        <Typography.Text strong>{labelFor(CROSSING_STATE_LABEL, row.state)}</Typography.Text>
        <Tag aria-label={`Crossing kind ${row.kind}`}>{row.kind}</Tag>
      </div>
      <div style={{ marginTop: 4 }}>{row.title}</div>
      <div style={{ marginTop: 4 }}>
        <ProjectEnd
          title={row.fromProject?.title}
          id={row.fromProjectPublicId ?? row.fromProjectId}
          status={row.fromProject?.status}
        />
        <Typography.Text type="secondary"> → </Typography.Text>
        <ProjectEnd
          title={row.toProject?.title}
          id={row.toProjectPublicId ?? row.toProjectId}
          status={row.toProject?.status}
        />
      </div>
      <Typography.Text type="secondary">
        {labelFor(CROSSING_STATE_MEANING, row.state)}
      </Typography.Text>
      {row.reason ? (
        <div>
          <Typography.Text type="secondary">Reason given: {row.reason}</Typography.Text>
        </div>
      ) : null}
      {/* The landing project's acceptance epoch, because a crossing asked before a reopen lands
          in a project whose acceptance standing has since been retired. */}
      {row.toProject ? (
        <div>
          <Typography.Text type="secondary" style={{ fontVariantNumeric: 'tabular-nums' }}>
            Landing epoch {row.toProject.acceptanceEpoch}
          </Typography.Text>
        </div>
      ) : null}

      {error ? (
        <Alert
          type="error"
          showIcon
          style={{ marginTop: 8 }}
          message="That answer was not recorded"
          description={error.message}
        />
      ) : null}

      {!isAnswerable(row.state) ? null : prompt ? (
        <div style={{ marginTop: 8 }}>
          <Typography.Text strong>
            {`${prompt.verb} moving “${prompt.subject}” from ${prompt.from} to ${prompt.to}?`}
          </Typography.Text>
          <div>
            <Typography.Text type="secondary">{prompt.consequence}</Typography.Text>
          </div>
          <div>
            <Typography.Text type="secondary">Crossing </Typography.Text>
            <Typography.Text code>{row.crossingKey.slice(0, 12)}</Typography.Text>
          </div>
          <Space style={{ marginTop: 8 }}>
            <Button
              size="small"
              type="primary"
              danger={confirming === 'DENY'}
              loading={busy}
              onClick={() => onAnswer(confirming!)}
            >
              {`Yes, ${prompt.verb.toLowerCase()}`}
            </Button>
            <Button size="small" disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
          </Space>
        </div>
      ) : (
        <Space style={{ marginTop: 8 }}>
          <Button size="small" onClick={() => onAsk('APPROVE')}>
            Approve…
          </Button>
          <Button size="small" danger onClick={() => onAsk('DENY')}>
            Refuse…
          </Button>
        </Space>
      )}
    </li>
  );
}

/** The write. `acknowledgedCrossingKey` is what makes the second press a fence and not a habit. */
export function decideCrossing(
  projectId: string,
  row: ProjectCrossingRow,
  decision: 'APPROVE' | 'DENY',
): Promise<unknown> {
  return api(
    `/projects/${encodeURIComponent(projectId)}/handoffs/${encodeURIComponent(row.publicId ?? row.id)}/decision`,
    { method: 'POST', body: { decision, acknowledgedCrossingKey: row.crossingKey } },
  );
}

export function ProjectCrossingsCard({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const crossings = useQuery({ ...projectCrossingsQuery(projectId), enabled: Boolean(projectId) });
  const [confirming, setConfirming] = useState<{ id: string; decision: 'APPROVE' | 'DENY' } | null>(
    null,
  );
  const answer = useMutation({
    mutationFn: ({ row, decision }: { row: ProjectCrossingRow; decision: 'APPROVE' | 'DENY' }) =>
      decideCrossing(projectId, row, decision),
    onSuccess: () => {
      setConfirming(null);
      // The crossing queue AND the project: answering one unblocks a write, and what that write
      // then does shows up in the project's own tallies.
      void qc.invalidateQueries({ queryKey: ['project', projectId] });
    },
  });

  const rows = orderCrossings(crossings.data ?? []);
  const pending = rows.filter((row) => isAnswerable(row.state)).length;

  return (
    <Card
      title="Cross-project crossings"
      size="small"
      style={{ marginTop: 16 }}
      extra={
        <Typography.Text style={{ fontVariantNumeric: 'tabular-nums' }}>
          {pending} waiting
        </Typography.Text>
      }
    >
      {crossings.isPending ? (
        <Skeleton active title={false} paragraph={{ rows: 2 }} />
      ) : crossings.isError ? (
        <Alert
          type="warning"
          showIcon
          message="Crossings could not be loaded"
          description={crossings.error instanceof Error ? crossings.error.message : undefined}
        />
      ) : rows.length === 0 ? (
        <Typography.Text type="secondary">
          Nothing has been asked about work crossing into or out of this project.
        </Typography.Text>
      ) : (
        <ul style={{ margin: 0, padding: 0 }}>
          {rows.map((row) => (
            <CrossingRow
              key={row.id}
              row={row}
              confirming={confirming?.id === row.id ? confirming.decision : null}
              busy={answer.isPending && confirming?.id === row.id}
              error={
                answer.isError && confirming?.id === row.id
                  ? (answer.error as Error)
                  : null
              }
              onAsk={(decision) => {
                answer.reset();
                setConfirming({ id: row.id, decision });
              }}
              onCancel={() => setConfirming(null)}
              onAnswer={(decision) => answer.mutate({ row, decision })}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}
