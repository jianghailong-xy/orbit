import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CheckOutlined, CopyOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { copyText } from '../lib/clipboard';
import { projectCrossingsQuery } from '../lib/queries';
import {
  CROSSING_STATE_LABEL,
  CROSSING_STATE_MEANING,
  labelFor,
  orderCrossings,
  type CrossingState,
  type ProjectCrossingRow,
} from '../lib/attribution';
import { Alert } from './ui/Alert';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { Skeleton } from './ui/Skeleton';
import { Tooltip } from './ui/Tooltip';
import './ui/Typography.css';

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

/**
 * A MOVE_TASK, in the card's own words. A request to move a task that already exists is not a
 * filing: the task is filed already, and confirming the request IS the move (account owner,
 * 2026-10-06), so nobody is left to send anything again. Each sentence is one literal, so a client
 * that shows the same request can hold its words to these.
 */
export const MOVE_TASK_SUBJECT_LABEL = 'Task to move';
export const MOVE_TASK_REQUESTED_CRITERION_LABEL = 'Target criterion requested';
export const MOVE_TASK_WITHDRAWN_CRITERION_LABEL = 'Source criterion it serves now';
export const MOVE_TASK_WITHDRAWN_CRITERION_NOTE = 'Confirming the move withdraws this declaration.';
export const MOVE_TASK_CRITERION_GONE = 'The target project no longer states this criterion.';
export const MOVE_TASK_APPROVE_CONSEQUENCE = 'Confirming is the move: the task joins the target project as soon as you answer, and nobody has to send the request again.';
export const MOVE_TASK_DENY_CONSEQUENCE = 'Refusing is final for this request, and the task stays where it is. If you change your mind, move the task yourself.';

/** What each state means for a MOVE_TASK, where `CROSSING_STATE_MEANING` speaks for a filing: the
 *  task is already filed, so "not filed anywhere until you answer" would be false of it. */
export const MOVE_TASK_STATE_MEANING: Readonly<Record<CrossingState, string>> = {
  PENDING: 'the task stays in its project until you answer, and confirming moves it',
  APPROVED: 'the task has not moved: this yes was recorded without moving it',
  DENIED: 'refusing is final for this request, and the task stays where it is',
  APPLIED: 'the task was moved when this request was confirmed',
};

/** What the second press is agreeing to, as data rather than as a sentence built at the call site.
 *  Exported because it is the part worth testing: the prompt must name both ends, or it is a
 *  confirmation of nothing. */
export function crossingConfirmPrompt(
  row: ProjectCrossingRow,
  decision: 'APPROVE' | 'DENY',
): { verb: string; from: string; to: string; subject: string; consequence: string } {
  const verb = decision === 'APPROVE' ? 'Approve' : 'Refuse';
  const from = row.fromProject?.title ?? (row.fromProjectPublicId ?? row.fromProjectId);
  const to = row.toProject?.title ?? (row.toProjectPublicId ?? row.toProjectId);
  if (row.kind === 'MOVE_TASK') {
    return {
      verb,
      from,
      to,
      // The task as it reads now; the row's own title is the one it had when the move was asked.
      subject: row.subjectTask?.title ?? row.title,
      consequence: decision === 'APPROVE' ? MOVE_TASK_APPROVE_CONSEQUENCE : MOVE_TASK_DENY_CONSEQUENCE,
    };
  }
  return {
    verb,
    from,
    to,
    subject: row.title,
    consequence:
      decision === 'APPROVE'
        ? 'The writer may then file this work under the target project. It is not filed by this answer.'
        : 'Refusing is final for this crossing. If you change your mind, file the work yourself.',
  };
}

/** A run of the card's text: secondary (`muted`), or strong. */
function Text({ muted = false, strong = false, children }: { muted?: boolean; strong?: boolean; children: ReactNode }) {
  return (
    <span className={muted ? 'orbit-typography orbit-typography-secondary' : 'orbit-typography'}>
      {strong ? <strong>{children}</strong> : children}
    </span>
  );
}

/** An id or a key, as code. */
function Code({ children }: { children: ReactNode }) {
  return (
    <span className="orbit-typography">
      <code>{children}</code>
    </span>
  );
}

/** How long the copy press says Copied (the replaced text control's own beat). */
const COPIED_MS = 3000;

/** An id as code, with the press that copies it: named Copy, said on hover, and a check named Copied
 *  for a few seconds once the id is on the clipboard. */
function CopyableCode({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = () =>
    void copyText(text).then((ok) => {
      if (!ok) return;
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPIED_MS);
    });
  const label = copied ? 'Copied' : 'Copy';
  return (
    <span className="orbit-typography">
      <code>
        {text}
        <span className="orbit-typography-actions">
          <Tooltip content={label}>
            <button
              type="button"
              className={`orbit-typography-copy${copied ? ' orbit-typography-copy-success' : ''}`}
              aria-label={label}
              onClick={copy}
            >
              {copied ? <CheckOutlined aria-hidden /> : <CopyOutlined aria-hidden />}
            </button>
          </Tooltip>
        </span>
      </code>
    </span>
  );
}

/** The server's reason for refusing an answer, under its code when it sent one. A confirmation
 *  refused because the task is being landed right then says so, and that the request still waits. */
function RefusalReason({ error }: { error: Error }) {
  const code = (error as { code?: unknown }).code;
  return (
    <>
      {typeof code === 'string' ? (
        <>
          <Code>{code}</Code>{' '}
        </>
      ) : null}
      {error.message}
    </>
  );
}

/** A row's buttons, side by side as the replaced space laid them out: inline, centred, 8px apart. */
const ACTIONS_STYLE = { display: 'inline-flex', alignItems: 'center', gap: 8, marginTop: 8 } as const;

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
      <Text strong>{title ?? 'unnamed project'}</Text>{' '}
      <CopyableCode text={id} />
      {status ? (
        <>
          {' '}
          <Badge aria-label={`Project status ${status}`}>{status}</Badge>
        </>
      ) : null}
    </span>
  );
}

/** MOVE_TASK: the task that already exists and is asked to move, by title and by id. */
function MoveSubject({ row }: { row: ProjectCrossingRow }) {
  const id = row.subjectTaskPublicId ?? row.subjectTaskId;
  return (
    <div style={{ marginTop: 4 }}>
      <Text muted>{MOVE_TASK_SUBJECT_LABEL}: </Text>
      <Text strong>{row.subjectTask?.title ?? row.title}</Text>
      {id ? (
        <>
          {' '}
          <CopyableCode text={id} />
        </>
      ) : null}
    </div>
  );
}

/** MOVE_TASK: what the task would count towards over there, and what it counts towards here now —
 *  the declaration the move takes back. */
function MoveCriteria({ row }: { row: ProjectCrossingRow }) {
  const requested = row.requestedCriterion;
  const withdrawn = row.withdrawnCriterion;
  return (
    <>
      {requested ? (
        <div>
          <Text muted>{MOVE_TASK_REQUESTED_CRITERION_LABEL}: </Text>
          <Text>{requested.text ?? MOVE_TASK_CRITERION_GONE}</Text>{' '}
          <Code>{requested.key}</Code>
        </div>
      ) : null}
      {withdrawn ? (
        <div>
          <Text muted>{MOVE_TASK_WITHDRAWN_CRITERION_LABEL}: </Text>
          <Text>{withdrawn.text}</Text>{' '}
          <Code>{withdrawn.key}</Code>{' '}
          <Text muted>{MOVE_TASK_WITHDRAWN_CRITERION_NOTE}</Text>
        </div>
      ) : null}
    </>
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
  const move = row.kind === 'MOVE_TASK';
  return (
    <li
      style={{ listStyle: 'none', padding: '10px 0', borderTop: '1px solid var(--border-subtle)' }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        {/* The state is a WORD before it is anything else (AC5): the tag carries the server's own
            value and the sentence beside it says what follows from it. */}
        <Badge aria-label={`Crossing ${row.state}`}>{row.state}</Badge>
        <Text strong>{labelFor(CROSSING_STATE_LABEL, row.state)}</Text>
        <Badge aria-label={`Crossing kind ${row.kind}`}>{row.kind}</Badge>
      </div>
      {move ? <MoveSubject row={row} /> : <div style={{ marginTop: 4 }}>{row.title}</div>}
      <div style={{ marginTop: 4 }}>
        <ProjectEnd
          title={row.fromProject?.title}
          id={row.fromProjectPublicId ?? row.fromProjectId}
          status={row.fromProject?.status}
        />
        <Text muted> → </Text>
        <ProjectEnd
          title={row.toProject?.title}
          id={row.toProjectPublicId ?? row.toProjectId}
          status={row.toProject?.status}
        />
      </div>
      <Text muted>
        {labelFor(move ? MOVE_TASK_STATE_MEANING : CROSSING_STATE_MEANING, row.state)}
      </Text>
      {move ? <MoveCriteria row={row} /> : null}
      {row.reason ? (
        <div>
          <Text muted>Reason given: {row.reason}</Text>
        </div>
      ) : null}
      {error ? (
        <Alert
          type="error"
          style={{ marginTop: 8 }}
          title="That answer was not recorded"
          description={<RefusalReason error={error} />}
        />
      ) : null}

      {!isAnswerable(row.state) ? null : prompt ? (
        <div style={{ marginTop: 8 }}>
          <Text strong>
            {`${prompt.verb} moving “${prompt.subject}” from ${prompt.from} to ${prompt.to}?`}
          </Text>
          <div>
            <Text muted>{prompt.consequence}</Text>
          </div>
          <div>
            <Text muted>Crossing </Text>
            <Code>{row.crossingKey.slice(0, 12)}</Code>
          </div>
          <div style={ACTIONS_STYLE}>
            <Button
              size="small"
              variant="primary"
              danger={confirming === 'DENY'}
              loading={busy}
              onClick={() => onAnswer(confirming!)}
            >
              {`Yes, ${prompt.verb.toLowerCase()}`}
            </Button>
            <Button size="small" disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div style={ACTIONS_STYLE}>
          <Button size="small" onClick={() => onAsk('APPROVE')}>
            Approve…
          </Button>
          <Button size="small" danger onClick={() => onAsk('DENY')}>
            Refuse…
          </Button>
        </div>
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
        <span className="orbit-typography" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {pending} waiting
        </span>
      }
    >
      {crossings.isPending ? (
        <Skeleton rows={2} />
      ) : crossings.isError ? (
        <Alert
          type="warning"
          title="Crossings could not be loaded"
          description={crossings.error instanceof Error ? crossings.error.message : undefined}
        />
      ) : rows.length === 0 ? (
        <Text muted>Nothing has been asked about work crossing into or out of this project.</Text>
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
