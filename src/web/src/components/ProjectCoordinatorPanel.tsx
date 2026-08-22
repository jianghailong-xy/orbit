import type { ReactNode } from 'react';
import { Alert, Button, Checkbox, Empty, InputNumber, Select, Spin, Switch, Tag, Typography } from 'antd';
import { Link } from 'react-router-dom';
import { encodeId } from '../lib/idCodec';
import {
  absentReasonText,
  automationPolicyCopy,
  blockerKindCopy,
  policyDraftChanged,
  policyEscalation,
  policyRefusal,
  runStateCopy,
  triggerRefusal,
  BLOCKER_SEVERITY_COLOR,
  DONE_REFUSAL_TEXT,
  type AcceptanceRun,
  type ControlRefusal,
  type CoordinatorAction,
  type CoordinatorBlocker,
  type CoordinatorDecision,
  type CoordinatorEvent,
  type CoordinatorStatus,
  type PolicyDraft,
} from '../lib/coordinatorStatus';

/**
 * The Coordinator surface of a project: what the control loop is doing, why it is not doing
 * something else, and the few things an owner can do about it (contract AC10, unit 21).
 *
 * Every component here is PRESENTATIONAL and exported. They take the server's answer and the
 * control state as props and render; not one of them fetches, decides or derives. That is both how
 * the panel is tested — a static render cannot press a button, so each state has to be handed in —
 * and the property that matters most about this screen: it must agree with the loop, and the only
 * way to be sure of that is never to compute a second opinion. `runState`, `blockers`, the wake
 * candidates, the budget arithmetic and the acceptance evidence are all read straight through.
 *
 * THREE THINGS THIS FILE IS CAREFUL ABOUT
 *
 *  - **Absent is drawn.** Every nullable field the server pairs with a closed-set reason is
 *    rendered through {@link Absent}, so "unknown" and "none" are sentences rather than a blank
 *    cell, a `0`, or a green tick. A project nobody has ever reconciled must not look healthy.
 *  - **No fallback is implied.** The blocker copy says what is being waited on. Nothing on this
 *    screen suggests the loop will switch provider, runner or agent by itself, because it will not.
 *  - **Nothing is overwritten silently.** Every control write carries `expectedConfigRevision`;
 *    when one is refused, the form CLOSES until the reader has looked at what changed, rather than
 *    letting the next press succeed against the revision that refused the last one.
 */

/** Any id spelling -> the short public one, or null when it is neither.
 *
 *  Null rather than the raw value on purpose: this screen carries ids from seven ledgers, and a
 *  value that cannot be encoded is far likelier to be a bug than something worth pasting. Printing
 *  it anyway is how a raw UUID reaches the page, which is the one thing the id codec exists to
 *  prevent. */
function publicId(id: string | null | undefined): string | null {
  if (!id) return null;
  try {
    return encodeId(id);
  } catch {
    return null;
  }
}

/** An id as a link, in the short spelling — or, when it cannot be encoded, as a stated failure.
 *  Never as the raw value. */
export function IdLink({
  kind,
  id,
  children,
}: {
  kind: 'sessions' | 'workspaces' | 'tasks';
  id: string | null | undefined;
  children?: ReactNode;
}) {
  const short = publicId(id);
  if (!short) {
    return <Typography.Text type="secondary">unreadable id</Typography.Text>;
  }
  return <Link to={`/${kind}/${encodeURIComponent(short)}`}>{children ?? short}</Link>;
}

/** A machine key (an action's `idempotencyKey`, an event's `dedupeKey`) shown as itself. The
 *  server already publicized the ids embedded in it, so it is printed verbatim and not re-encoded. */
function Key({ value }: { value: string | null }) {
  return value ? (
    <Typography.Text code style={{ fontSize: 12, wordBreak: 'break-all' }}>{value}</Typography.Text>
  ) : (
    <Typography.Text type="secondary">none</Typography.Text>
  );
}

/** An instant on the reader's wall clock, or nothing when there is no instant. The absent case is
 *  always rendered by the caller with its own reason — never as a dash that could mean anything. */
export function when(value: string | null | undefined): string | null {
  if (!value) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime())
    ? null
    : at.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/**
 * The sentence for a value that is not there.
 *
 * Rendered wherever the value would have been, in secondary text, and never collapsed to an empty
 * node: the whole point of the server's closed reason set is that "nothing is blocking this" and
 * "this build cannot tell you" are different answers, and a blank cell merges them again.
 */
export function Absent({ reason }: { reason: string | null | undefined }) {
  const text = absentReasonText(reason);
  return text ? <Typography.Text type="secondary">{text}</Typography.Text> : null;
}

/** One labelled fact. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 8, padding: '2px 0', flexWrap: 'wrap' }}>
      <Typography.Text type="secondary" style={{ minWidth: 180 }}>{label}</Typography.Text>
      <span style={{ flex: 1, minWidth: 200 }}>{children}</span>
    </div>
  );
}

/** One titled block of the panel. */
function Section({ title, extra, children }: { title: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <Typography.Title level={5} style={{ marginBottom: 8 }}>{title}</Typography.Title>
        {extra}
      </div>
      {children}
    </div>
  );
}

/** Why a control is closed, said where the control is. A disabled button with no sentence beside
 *  it is indistinguishable from a broken one. */
export function Refused({ refusal }: { refusal: ControlRefusal | null }) {
  return refusal ? (
    <Typography.Paragraph
      type={refusal.code === 'IN_FLIGHT' ? 'secondary' : 'warning'}
      style={{ marginBottom: 0, marginTop: 8 }}
    >
      {refusal.message}
    </Typography.Paragraph>
  ) : null;
}

/** The lifecycle of the WORK and the state of the LOOP, side by side and never merged: a project
 *  can be OPEN and its loop BLOCKED, and a reader who sees only one of the two has the wrong
 *  answer half the time. */
export function CoordinatorOverview({ status }: { status: CoordinatorStatus }) {
  const run = runStateCopy(status.runtime.runState);
  const readAt = when(status.readAt);
  return (
    <Section title="State">
      <Fact label="Project">
        <Tag color={status.project.status === 'OPEN' ? 'blue' : status.project.status === 'DONE' ? 'green' : 'default'}>
          {status.project.status}
        </Tag>
        <Typography.Text type="secondary">
          {status.project.taskCount} task{status.project.taskCount === 1 ? '' : 's'}
          {Object.entries(status.project.tasksByStatus).length > 0
            ? ` — ${Object.entries(status.project.tasksByStatus).map(([s, n]) => `${s} ${n}`).join(', ')}`
            : ''}
        </Typography.Text>
      </Fact>
      <Fact label="Run state">
        <Tag color={run.color}>{status.runtime.runState}</Tag>
        <Typography.Text type="secondary">{run.description}</Typography.Text>
      </Fact>
      <Fact label="Reconcile lease">
        {status.runtime.lease ? (
          <span>
            held until {when(status.runtime.lease.expiresAt)}
            {status.runtime.lease.heartbeatAt ? `, last heartbeat ${when(status.runtime.lease.heartbeatAt)}` : ''}
            {' '}(fencing token {status.runtime.lease.fencingToken})
          </span>
        ) : (
          <Absent reason={status.runtime.leaseAbsentReason} />
        )}
      </Fact>
      <Fact label="Acceptance attempt">{status.runtime.acceptanceAttempt}</Fact>
      {readAt ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>Read at {readAt}</Typography.Text>
      ) : null}
    </Section>
  );
}

/** WHO coordinates this project, WHERE, and which conversation is currently doing it. The three
 *  are separate rows because they go absent separately, and each absence means something else. */
export function CoordinatorIdentity({ status }: { status: CoordinatorStatus }) {
  const c = status.coordination;
  return (
    <Section title="Coordination">
      <Fact label="Coordinator agent">
        {c.agentId ? (
          <span>
            <IdLink kind="workspaces" id={c.agentId}>{c.agentName ?? undefined}</IdLink>{' '}
            <Tag>{c.identitySource}</Tag>
          </span>
        ) : (
          <Absent reason={c.agentIdAbsentReason} />
        )}
      </Fact>
      <Fact label="Coordination workspace">
        {c.workspaceId ? (
          <IdLink kind="workspaces" id={c.workspaceId} />
        ) : (
          <Absent reason={c.workspaceIdAbsentReason} />
        )}
      </Fact>
      <Fact label="Generation">{c.generation}</Fact>
      <Fact label="Coordination session">
        {c.session ? (
          <span>
            <IdLink kind="sessions" id={c.session.id} />{' '}
            <Tag>{c.session.runStatus}</Tag>
            <Tag>{c.session.runState}</Tag>
            <Tag>{c.session.lifecycleState}</Tag>
            {c.session.endReason ? <Typography.Text type="secondary">ended: {c.session.endReason}</Typography.Text> : null}
          </span>
        ) : (
          <Absent reason={c.sessionAbsentReason} />
        )}
      </Fact>
    </Section>
  );
}

/** What the admission gates are counting, read the way they count it. Not recomputed here: a
 *  status page that did its own arithmetic would eventually differ from the gate by one and send
 *  somebody looking for a bug in the gate. */
export function CoordinatorConsumption({ status }: { status: CoordinatorStatus }) {
  const c = status.consumption;
  return (
    <Section title="What it is spending">
      <Fact label="Tasks in flight">
        {c.tasksInFlight} of {status.policy.maxConcurrentTasks} — {c.concurrencyRemaining} left
      </Fact>
      <Fact label="Coordinator sessions (24h)">
        {c.coordinatorSessionsLast24h}
        {status.policy.sessionBudgetPerDay !== null
          ? ` of ${status.policy.sessionBudgetPerDay}`
          : ''}
      </Fact>
      <Fact label="Budget remaining">
        {c.budgetRemaining !== null ? c.budgetRemaining : <Absent reason={c.budgetRemainingAbsentReason} />}
      </Fact>
      <Fact label="Window started">
        {when(c.budgetWindowStartedAt)
          ?? <Typography.Text type="secondary">The server did not report a readable window start.</Typography.Text>}
      </Fact>
    </Section>
  );
}

/** When it next looks, and the candidates the deciding pass weighed and rejected. Read back from
 *  what that pass recorded, so the losers shown are ones a decision actually saw. */
export function CoordinatorWake({ status }: { status: CoordinatorStatus }) {
  const w = status.nextWake;
  return (
    <Section title="Next wake">
      <Fact label="Scheduled">
        {w.at ? (
          <span>{when(w.at)}{w.reason ? ` — ${w.reason}` : ''}</span>
        ) : (
          <Absent reason={w.absentReason} />
        )}
      </Fact>
      {w.flooredBy ? <Fact label="Floored by">{w.flooredBy}</Fact> : null}
      <Fact label="Candidates considered">
        {w.candidates.length > 0 ? (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {w.candidates.map((candidate, i) => (
              <li key={i}>
                {when(typeof candidate.at === 'string' ? candidate.at : null) ?? 'no instant recorded'}
                {candidate.reason ? ` — ${String(candidate.reason)}` : ''}
              </li>
            ))}
          </ul>
        ) : (
          <Absent reason={w.candidatesAbsentReason} />
        )}
      </Fact>
      {w.decisionId ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Recorded by the decision below.
        </Typography.Text>
      ) : null}
    </Section>
  );
}

/** One blocker row: what it is, who owns it now, what would clear it, and the one sentence that
 *  says what to do. `requiredAction` is the server's, verbatim — this screen does not paraphrase
 *  the instruction the loop recorded. */
export function BlockerRow({ blocker }: { blocker: CoordinatorBlocker }) {
  const copy = blockerKindCopy(blocker.kind);
  const resolved = blocker.resolvedAt !== null;
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 6,
        padding: 12,
        marginBottom: 8,
        opacity: resolved ? 0.7 : 1,
      }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Typography.Text strong>{copy.label}</Typography.Text>
        <Tag color={resolved ? 'default' : (BLOCKER_SEVERITY_COLOR[blocker.severity] ?? 'default')}>
          {blocker.severity}
        </Tag>
        <Tag>owner {blocker.owner}</Tag>
        <Tag>clears on {blocker.recovery}</Tag>
        {blocker.escalatedAt ? <Tag color="volcano">escalated {when(blocker.escalatedAt)}</Tag> : null}
        {resolved ? <Tag color="green">resolved {when(blocker.resolvedAt)} by {blocker.resolvedBy ?? 'unknown'}</Tag> : null}
      </div>
      <Typography.Paragraph style={{ marginBottom: 4, marginTop: 8 }}>
        {blocker.requiredAction}
      </Typography.Paragraph>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 4 }}>{copy.note}</Typography.Paragraph>
      <div style={{ fontSize: 12 }}>
        <Typography.Text type="secondary">
          {blocker.kind} · subject {blocker.subjectType}{' '}
        </Typography.Text>
        {blocker.subjectType === 'TASK' ? <IdLink kind="tasks" id={blocker.subjectId} />
          : blocker.subjectType === 'SESSION' ? <IdLink kind="sessions" id={blocker.subjectId} />
            : blocker.subjectType === 'WORKSPACE' ? <IdLink kind="workspaces" id={blocker.subjectId} />
              : <Typography.Text type="secondary">{blocker.subjectType === 'PROJECT' ? 'this project' : 'not linkable'}</Typography.Text>}
        <Typography.Text type="secondary">
          {' '}· seen {blocker.occurrences}× since {when(blocker.firstSeenAt)}
          {resolved ? '' : ` · next check ${when(blocker.nextCheckAt)}`}
        </Typography.Text>
      </div>
    </div>
  );
}

/** What is stopping this project, and what stopped it before. History is kept because "what was
 *  blocking this yesterday and what ended it" is the question a recurring blocker is answered by. */
export function CoordinatorBlockers({ status }: { status: CoordinatorStatus }) {
  const { open, openEmptyReason, resolved } = status.blockers;
  return (
    <Section title={`Blockers${open.length > 0 ? ` (${open.length})` : ''}`}>
      {open.length > 0 ? (
        open.map((blocker) => <BlockerRow key={blocker.id} blocker={blocker} />)
      ) : (
        <Absent reason={openEmptyReason} />
      )}
      {resolved.length > 0 ? (
        <details style={{ marginTop: 12 }}>
          <summary style={{ cursor: 'pointer' }}>
            <Typography.Text type="secondary">{resolved.length} resolved earlier</Typography.Text>
          </summary>
          <div style={{ marginTop: 8 }}>
            {resolved.map((blocker) => <BlockerRow key={blocker.id} blocker={blocker} />)}
          </div>
        </details>
      ) : null}
    </Section>
  );
}

/** One ledger row, with the idempotency key it was claimed under — which is what makes "did this
 *  run twice" answerable rather than guessable. */
export function ActionRow({ action }: { action: CoordinatorAction }) {
  return (
    <div style={{ fontSize: 12, padding: '4px 0' }}>
      <Tag>{action.type}</Tag>
      <Tag color={action.status === 'APPLIED' ? 'green' : action.status === 'REFUSED' ? 'red' : 'gold'}>
        {action.status}
      </Tag>
      {action.refusalCode ? <Tag color="red">{action.refusalCode}</Tag> : null}
      {action.reasonCode ? <Tag>{action.reasonCode}</Tag> : null}
      {action.subjectType === 'TASK' && action.subjectId ? <IdLink kind="tasks" id={action.subjectId} /> : null}
      {action.resultSessionId ? <> → <IdLink kind="sessions" id={action.resultSessionId} /></> : null}
      <div><Key value={action.idempotencyKey} /></div>
    </div>
  );
}

/** The last few passes: what each decided, on which snapshot, and what it produced. Bounded by the
 *  server — a project reconciles on every event and the ledger is append-only. */
export function CoordinatorDecisions({ status }: { status: CoordinatorStatus }) {
  const { decisions, decisionsEmptyReason } = status;
  return (
    <Section title="Recent decisions">
      {decisions.length === 0 ? (
        <Absent reason={decisionsEmptyReason} />
      ) : (
        decisions.map((decision: CoordinatorDecision) => (
          <div key={decision.id} style={{ borderTop: '1px solid var(--border-subtle)', padding: '8px 0' }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <Typography.Text>{when(decision.createdAt)}</Typography.Text>
              <Tag>{decision.decidedBy ?? 'decided by unknown'}</Tag>
              {decision.runStateBefore || decision.runStateAfter ? (
                <Typography.Text type="secondary">
                  {decision.runStateBefore ?? 'unknown'} → {decision.runStateAfter ?? 'unknown'}
                </Typography.Text>
              ) : (
                <Typography.Text type="secondary">no run-state transition recorded</Typography.Text>
              )}
            </div>
            {decision.reason ? <Typography.Paragraph style={{ marginBottom: 4 }}>{decision.reason}</Typography.Paragraph> : null}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              snapshot {decision.decisionInputHash ?? 'not recorded'} · fencing token {decision.fencingToken}
            </Typography.Text>
            {decision.actions.length === 0 ? (
              <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>No action came of it.</Typography.Text></div>
            ) : (
              decision.actions.map((action) => <ActionRow key={action.id} action={action} />)
            )}
          </div>
        ))
      )}
    </Section>
  );
}

/** What is claimed and unpublished right now, and what durable signals are still waiting. Empty is
 *  the healthy state for both, which is exactly why both say so in words. */
export function CoordinatorInFlight({ status }: { status: CoordinatorStatus }) {
  const { pendingActions, pendingActionsEmptyReason, events } = status;
  return (
    <Section title="In flight">
      <Fact label="Claimed, not published">
        {pendingActions.length > 0
          ? <div>{pendingActions.map((action) => <ActionRow key={action.id} action={action} />)}</div>
          : <Absent reason={pendingActionsEmptyReason} />}
      </Fact>
      <Fact label="Unconsumed signals">
        {events.pending.length > 0 ? (
          <div>
            {events.pending.map((event: CoordinatorEvent) => (
              <div key={event.id} style={{ fontSize: 12, padding: '2px 0' }}>
                <Tag>{event.kind}</Tag>
                <Typography.Text type="secondary">
                  {event.occurrences}× · {event.attempts} attempt{event.attempts === 1 ? '' : 's'}
                  {event.nextAttemptAt ? ` · next attempt ${when(event.nextAttemptAt)}` : ''}
                </Typography.Text>
                <div><Key value={event.dedupeKey} /></div>
              </div>
            ))}
          </div>
        ) : (
          <Absent reason={events.pendingEmptyReason} />
        )}
      </Fact>
    </Section>
  );
}

/** One acceptance attempt: what it concluded, criterion by criterion, and whether it still counts.
 *
 *  A superseded run is drawn as superseded rather than hidden — "we did pass once, and here is what
 *  ended it" is the question somebody asks after a project reopens, and a screen that dropped the
 *  row would answer it with silence. */
function AcceptanceRunRow({ run }: { run: AcceptanceRun }) {
  const colour = run.verdict === 'PASS' ? 'green' : run.verdict === 'FAIL' ? 'red' : run.verdict ? 'gold' : 'default';
  return (
    <div style={{ fontSize: 12 }}>
      <div>
        <Tag color={colour}>{run.verdict ?? 'not concluded'}</Tag>
        <Typography.Text type="secondary">attempt {run.attempt} · by {run.decidedBy}</Typography.Text>
        {run.supersededAt ? (
          <Tag color="volcano" style={{ marginLeft: 6 }}>
            superseded{run.supersededReason ? `: ${run.supersededReason}` : ''}
          </Tag>
        ) : null}
      </div>
      {run.criteria.map((criterion) => (
        <div key={criterion.id} style={{ padding: '2px 0' }}>
          <Tag color={criterion.verdict === 'PASS' ? 'green' : criterion.verdict === 'FAIL' ? 'red' : criterion.verdict ? 'gold' : 'default'}>
            {criterion.verdict ?? 'open'}
          </Tag>
          <Typography.Text>{criterion.ordinal}. {criterion.criterionText}</Typography.Text>
          {criterion.summary ? (
            <Typography.Text type="secondary"> — {criterion.summary}</Typography.Text>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** The evidence a project-level acceptance would be judged on — never a verdict of this screen's
 *  own. "Never attempted" is rendered as itself, because a page that drew it as a clean slate
 *  would be claiming a pass nobody ran. */
export function CoordinatorAcceptance({ status }: { status: CoordinatorStatus }) {
  const a = status.acceptance;
  const v = a.evidence.verifications;
  return (
    <Section title="Acceptance evidence">
      <Fact label="Criteria">
        {a.criteria
          ? <Typography.Text style={{ whiteSpace: 'pre-wrap' }}>{a.criteria}</Typography.Text>
          : <Absent reason={a.criteriaAbsentReason} />}
      </Fact>
      <Fact label="May this project be DONE?">
        {a.doneGate.allowed ? (
          <span>
            <Tag color="green">yes</Tag>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              the acceptance run below matches the current facts
            </Typography.Text>
          </span>
        ) : (
          <span>
            <Tag color="red">no</Tag>
            <Typography.Text code style={{ fontSize: 12 }}>{a.doneGate.refusalCode ?? 'REFUSED'}</Typography.Text>{' '}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {(a.doneGate.refusalCode && DONE_REFUSAL_TEXT[a.doneGate.refusalCode])
                || a.doneGate.reason
                || 'This build does not recognise the refusal code the server returned.'}
            </Typography.Text>
          </span>
        )}
      </Fact>
      <Fact label="Acceptance run">
        {a.run ? <AcceptanceRunRow run={a.run} /> : <Absent reason={a.runAbsentReason} />}
      </Fact>
      <Fact label="Facts digest">
        <Typography.Text code style={{ fontSize: 12 }}>{a.doneGate.acceptanceDigest.slice(0, 16)}…</Typography.Text>{' '}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          the criteria, every task and its status, every verification verdict and the newest branch
          observation — a PASS is only usable while this value still matches the one it recorded
        </Typography.Text>
      </Fact>
      <Fact label="Last acceptance action">
        {a.lastRun ? <ActionRow action={a.lastRun} /> : <Absent reason={a.lastRunAbsentReason} />}
      </Fact>
      <Fact label="Verifications">
        {v.total === 0 ? (
          <Typography.Text type="secondary">No verification task has been filed in this project.</Typography.Text>
        ) : (
          <span>
            {v.total} total — <Tag color="green">{v.pass} pass</Tag>
            <Tag color="red">{v.fail} fail</Tag>
            <Tag color="gold">{v.inconclusive} inconclusive</Tag>
            <Tag>{v.pending} not concluded</Tag>
            {v.unresolvedFailures > 0 ? <Tag color="red">{v.unresolvedFailures} unresolved</Tag> : null}
          </span>
        )}
      </Fact>
      <Fact label="Undelivered @-mentions">
        {/* §13.8. A mention nobody could deliver used to be one apiserver's log line; the whole
            point of the ledger is that it is somewhere a person looks. Here rather than only on
            the task, because "an agent was asked for something and never heard" is a fact about
            the project's progress. */}
        {/* THREE states, not two. `undefined` means this server predates the ledger and has no
            opinion; collapsing it into an empty array would report "every mention arrived" on the
            strength of a field the server never sent — a new client telling a comfortable lie about
            an old one. Empty-with-a-reason is the healthy case, and it is a different sentence. */}
        {a.evidence.undeliveredMentions === undefined ? (
          <Absent reason="MENTION_AUDIT_UNAVAILABLE" />
        ) : a.evidence.undeliveredMentions.length > 0 ? (
          <div>
            {a.evidence.undeliveredMentions.map((mention) => (
              <div key={mention.id} style={{ fontSize: 12, padding: '2px 0' }}>
                <Tag color={mention.status === 'DEAD' ? 'red' : 'gold'}>
                  {mention.status === 'DEAD' ? 'not delivered' : 'not delivered yet'}
                </Tag>
                <Link to={`/tasks/${mention.taskId}`}>{mention.taskId}</Link>{' → '}
                {/* WHO was asked, not just where: "a mention on task X is stuck" leaves the reader
                    to work out which agent is waiting on them. Rendered rather than linked because
                    this app has no agent detail route — a link would 404, which is worse than an
                    id somebody can search for. */}
                <Typography.Text code>{mention.workspaceId}</Typography.Text>{' '}
                <Typography.Text code>{mention.errorCode ?? 'UNKNOWN'}</Typography.Text>
                {mention.requiredAction ? (
                  <Typography.Text type="secondary"> — {mention.requiredAction}</Typography.Text>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <Absent reason={a.evidence.undeliveredMentionsEmptyReason ?? 'NO_UNDELIVERED_MENTION'} />
        )}
      </Fact>
      <Fact label="Branch merge evidence">
        {a.evidence.merges.length > 0 ? (
          <div>
            {a.evidence.merges.map((merge) => (
              <div key={merge.sessionId} style={{ fontSize: 12, padding: '2px 0' }}>
                <Typography.Text code>{merge.branch}</Typography.Text>{' '}
                {merge.branchMerged === true ? (
                  <Tag color="green">merged{merge.mergeTarget ? ` into ${merge.mergeTarget}` : ''}</Tag>
                ) : merge.branchMerged === false ? (
                  <Tag color="default">not merged</Tag>
                ) : (
                  <Tag color="gold">merge state not reported</Tag>
                )}
                {merge.mergeStatus ? <Tag>{merge.mergeStatus}</Tag> : null}
                {merge.worktreeDirty ? <Tag color="volcano">worktree dirty</Tag> : null}
                <IdLink kind="sessions" id={merge.sessionId} />
                {merge.taskId ? <> · <IdLink kind="tasks" id={merge.taskId}>{merge.taskTitle ?? undefined}</IdLink></> : null}
              </div>
            ))}
          </div>
        ) : (
          <Absent reason={a.evidence.mergesEmptyReason} />
        )}
      </Fact>
    </Section>
  );
}

/** What a manual trigger answered with. `deduplicated` is the one that matters: it is the
 *  difference between "queued" and "already queued", which is what a second press has to be told. */
export interface TriggerResult {
  triggerId: string;
  accepted: boolean;
  configRevision: string;
  automationPolicy: string;
  eventId: string | null;
  occurrences: number;
  deduplicated: boolean;
  occurredAt: string | null;
  consumedAt: string | null;
  nextAttemptAt: string | null;
}

/**
 * "Look at this project now".
 *
 * It commits one durable signal and nothing else — every action the resulting pass might take is
 * still decided by the same policy, authorization, concurrency and budget gates. The copy says so,
 * because a button that reads like it forces a step would be describing a second dispatch path
 * that does not exist.
 */
export function CoordinatorTrigger({
  status,
  readOnly,
  pending,
  conflict,
  error,
  result,
  onRun,
}: {
  status: CoordinatorStatus | undefined;
  readOnly: boolean;
  pending: boolean;
  conflict: boolean;
  error: Error | null;
  result: TriggerResult | null;
  onRun: () => void;
}) {
  const refusal = triggerRefusal({ status, readOnly, pending, conflict });
  return (
    <Section title="Run now">
      <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
        Queues one signal asking this project’s coordinator to look. It grants nothing and skips
        nothing: whatever the pass then does still goes through the same policy, authorization,
        concurrency and budget checks.
      </Typography.Paragraph>
      <Button type="primary" loading={pending} disabled={refusal !== null} onClick={onRun}>
        Run now
      </Button>
      <Refused refusal={refusal} />
      {error ? (
        <Alert
          style={{ marginTop: 12 }}
          type="error"
          showIcon
          message="The coordinator was not triggered"
          description={error.message}
        />
      ) : null}
      {result ? (
        <Alert
          style={{ marginTop: 12 }}
          type={result.deduplicated ? 'warning' : 'success'}
          showIcon
          message={result.deduplicated ? 'Already queued' : 'Queued'}
          description={
            result.deduplicated
              ? `This press matched a signal that was already waiting (seen ${result.occurrences}×), so it is one run and not two.`
              : `Queued against configRevision ${result.configRevision}, automation ${result.automationPolicy}. The pass runs after this; it is not running yet.`
          }
        />
      ) : null}
    </Section>
  );
}

/**
 * The four settings that decide what this project's coordinator may do.
 *
 * Every submit carries `expectedConfigRevision`, and an edit that hands the coordinator MORE room
 * has to be confirmed in the form before it can be sent — the checkbox is not decoration: this
 * page is also where a project gets switched into automation, and that must be a thing somebody
 * chose rather than a side effect of raising a concurrency cap.
 *
 * When a write has been refused as stale, the Save button stays closed until the reader presses
 * "Review current settings". Reopening it any earlier would let the next press succeed against the
 * revision that refused the last one, which is the silent overwrite the fence exists to stop.
 */
export function CoordinatorPolicyForm({
  status,
  draft,
  onDraft,
  readOnly,
  pending,
  conflict,
  confirmed,
  onConfirm,
  error,
  onSubmit,
  onReview,
}: {
  status: CoordinatorStatus | undefined;
  draft: PolicyDraft;
  onDraft: (draft: PolicyDraft) => void;
  readOnly: boolean;
  pending: boolean;
  /** The stale-revision refusal, still unacknowledged. */
  conflict: { message: string } | null;
  confirmed: boolean;
  onConfirm: (confirmed: boolean) => void;
  error: Error | null;
  onSubmit: () => void;
  onReview: () => void;
}) {
  const refusal = policyRefusal({ status, readOnly, pending, conflict: conflict !== null });
  const escalation = status ? policyEscalation(draft, status) : null;
  const changed = status ? policyDraftChanged(draft, status) : false;
  const blocked = refusal !== null || !changed || (escalation !== null && !confirmed);
  const policy = automationPolicyCopy(draft.automationPolicy);

  return (
    <Section title="Coordination settings">
      {status ? (
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
          At configRevision {status.policy.configRevision}. Every write from here states that
          revision, so an edit composed against settings somebody has since changed is refused
          rather than merged.
        </Typography.Paragraph>
      ) : null}

      <Fact label="Coordinator">
        <Switch
          aria-label="Coordinator enabled"
          checked={draft.coordinatorEnabled}
          disabled={refusal !== null}
          onChange={(coordinatorEnabled) => onDraft({ ...draft, coordinatorEnabled })}
        />{' '}
        <Typography.Text type="secondary">
          {draft.coordinatorEnabled
            ? 'On — it may run on its own schedule, within the level below.'
            : 'Off — it does not run, and a trigger would be discarded. It stays off until you turn it on.'}
        </Typography.Text>
      </Fact>

      <Fact label="Automation level">
        <Select
          aria-label="Automation level"
          value={draft.automationPolicy}
          disabled={refusal !== null}
          style={{ minWidth: 200 }}
          onChange={(automationPolicy: string) => onDraft({ ...draft, automationPolicy })}
          options={['MANUAL', 'GUARDED_AUTO', 'AUTO'].map((value) => ({
            value,
            label: automationPolicyCopy(value).label,
          }))}
        />
        <div><Typography.Text type="secondary">{policy.description}</Typography.Text></div>
      </Fact>

      <Fact label="Max tasks in flight">
        <InputNumber
          aria-label="Max tasks in flight"
          min={1}
          max={100}
          value={draft.maxConcurrentTasks}
          disabled={refusal !== null}
          onChange={(value) => onDraft({ ...draft, maxConcurrentTasks: typeof value === 'number' ? value : draft.maxConcurrentTasks })}
        />
      </Fact>

      <Fact label="Coordinator sessions per day">
        <InputNumber
          aria-label="Coordinator sessions per day"
          min={1}
          max={10000}
          value={draft.sessionBudgetPerDay ?? undefined}
          placeholder="no limit"
          disabled={refusal !== null}
          onChange={(value) => onDraft({ ...draft, sessionBudgetPerDay: typeof value === 'number' ? value : null })}
        />{' '}
        <Typography.Text type="secondary">
          {draft.sessionBudgetPerDay === null
            ? 'Empty means uncapped — not a limit of zero.'
            : 'Sessions you start yourself are never counted against this.'}
        </Typography.Text>
      </Fact>

      {escalation ? (
        <Alert
          style={{ marginTop: 12 }}
          type="warning"
          showIcon
          message="This edit gives the coordinator more room"
          description={
            <div>
              <Typography.Paragraph style={{ marginBottom: 8 }}>{escalation}</Typography.Paragraph>
              <Checkbox checked={confirmed} onChange={(e) => onConfirm(e.target.checked)}>
                I want this project to run with that much autonomy.
              </Checkbox>
            </div>
          }
        />
      ) : null}

      {conflict ? (
        <Alert
          style={{ marginTop: 12 }}
          type="warning"
          showIcon
          message="Refused — these settings changed under you"
          description={
            <div>
              <Typography.Paragraph style={{ marginBottom: 8 }}>{conflict.message}</Typography.Paragraph>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
                Nothing was written. Your edit is still here; pressing below replaces it with the
                settings as they now stand, so you can decide against those instead.
              </Typography.Paragraph>
              <Button size="small" onClick={onReview}>Review current settings</Button>
            </div>
          }
        />
      ) : null}

      {error && !conflict ? (
        <Alert
          style={{ marginTop: 12 }}
          type="error"
          showIcon
          message="Settings were not saved"
          description={error.message}
        />
      ) : null}

      <div style={{ marginTop: 12 }}>
        <Button type="primary" loading={pending} disabled={blocked} onClick={onSubmit}>
          Save settings
        </Button>
        <Refused refusal={refusal} />
        {refusal === null && !changed ? (
          <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
            Nothing is changed. Saving anyway would move this project’s configRevision and refuse
            somebody else’s in-flight edit for no reason.
          </Typography.Paragraph>
        ) : null}
        {refusal === null && changed && escalation !== null && !confirmed ? (
          <Typography.Paragraph type="warning" style={{ marginTop: 8, marginBottom: 0 }}>
            Confirm the box above before this can be saved.
          </Typography.Paragraph>
        ) : null}
      </div>
    </Section>
  );
}

/**
 * The whole surface: one read, its controls, and every state that read can be in.
 *
 * The loading, failed and never-loaded states are rendered here rather than being folded into the
 * sections, because a section that draws itself from `undefined` is a section that draws a project
 * with no blockers, no budget and no decisions — which is a specific and wrong claim, not a blank.
 */
export function ProjectCoordinatorPanel({
  status,
  loading,
  error,
  onRetry,
  readOnly,
  trigger,
  policy,
}: {
  status: CoordinatorStatus | undefined;
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
  readOnly: boolean;
  trigger: Omit<Parameters<typeof CoordinatorTrigger>[0], 'status' | 'readOnly'>;
  policy: Omit<Parameters<typeof CoordinatorPolicyForm>[0], 'status' | 'readOnly'>;
}) {
  return (
    <div style={{ marginBottom: 24 }}>
      <Typography.Title level={4}>Coordinator</Typography.Title>

      {readOnly ? (
        <Alert
          style={{ marginBottom: 16 }}
          type="info"
          showIcon
          message="Read-only"
          description="Your account may read this project’s coordinator but not drive it. Its owner keeps the final control."
        />
      ) : null}

      {loading && !status ? (
        <div style={{ padding: 32, textAlign: 'center' }}><Spin /></div>
      ) : error && !status ? (
        <Alert
          type="error"
          showIcon
          message="The coordinator’s state could not be read"
          description={
            <div>
              <Typography.Paragraph style={{ marginBottom: 8 }}>{error.message}</Typography.Paragraph>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
                Nothing below is known while this fails — an unread state is not a healthy one.
              </Typography.Paragraph>
              <Button size="small" danger onClick={onRetry}>Retry</Button>
            </div>
          }
        />
      ) : !status ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No coordinator state has been read yet." />
      ) : (
        <>
          {error ? (
            <Alert
              style={{ marginBottom: 16 }}
              type="warning"
              showIcon
              message="Showing the last state that loaded"
              description={`The latest refresh failed (${error.message}), so everything below is as of ${when(status.readAt) ?? 'an earlier read'}.`}
              action={<Button size="small" onClick={onRetry}>Retry</Button>}
            />
          ) : null}
          <CoordinatorOverview status={status} />
          <CoordinatorIdentity status={status} />
          <CoordinatorBlockers status={status} />
          <CoordinatorTrigger {...trigger} status={status} readOnly={readOnly} />
          <CoordinatorPolicyForm {...policy} status={status} readOnly={readOnly} />
          <CoordinatorConsumption status={status} />
          <CoordinatorWake status={status} />
          <CoordinatorDecisions status={status} />
          <CoordinatorInFlight status={status} />
          <CoordinatorAcceptance status={status} />
        </>
      )}
    </div>
  );
}
