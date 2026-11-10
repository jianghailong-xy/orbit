import { useMemo, useState, type JSX, type ReactNode } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  CheckCircleFilled,
  CloseCircleFilled,
  ClockCircleOutlined,
  DownOutlined,
  LockOutlined,
  RollbackOutlined,
} from '@ant-design/icons';
import remarkGfm from 'remark-gfm';
import { api } from '../api';
import { copyText } from '../lib/clipboard';
import { rehypeCodeWords } from '../lib/codeWords';
import { decisionReceiptAnchor } from '../lib/decisionReceipt';
import { ReferenceLink, referenceUrlTransform } from '../lib/markdownLinks';
import {
  KIND_TAGS,
  WAITING_ON_YOU,
  deviceLabel,
  expiryText,
  isTaskHeld,
  openableLink,
  pastDeadline,
  snoozeChoices,
  snoozeRequest,
  useSnoozes,
  wakeRequest,
  type OwnerRequest,
  type OwnerRequestSecretSpec,
  type OwnerRequestStep,
} from '../lib/ownerRequests';
import { ownerRequestsQuery, runnersQuery } from '../lib/queries';
import { ago, linkId, sameResourceId } from '../lib/watches';
import { CardActionButton, CardActions } from './CardAction';
import { NOTE_PROMPT, OWN_ANSWER_PROMPT, YOUR_ANSWER, QuestionOptions, optionIndex, type Choice } from './CoordinatorQuestionCard';
import { decisionReceiptTime } from './EvidenceDecisionCard';
import Markdown from './Markdown';
import type { TranscriptInsert } from './Transcript';
import { Alert } from './ui/Alert';
import { Checkbox } from './ui/Checkbox';
import { Input } from './ui/Input';
import { Menu } from './ui/Menu';
import { Textarea } from './ui/Textarea';
import './OwnerRequest.css';

/**
 * What a session asked the owner to do, as a card in the conversation that asked and in the
 * "Waiting on you" inbox: one component reading one door (`/owner-requests`), so the two cannot say
 * different things. Pending it is the whole request; once it has ended it is one line saying how,
 * who and when, at the same place.
 */

type Ending = { to: 'done'; body: { option?: number; text?: string } } | { to: 'decline'; body: { reason: string } };

const PRIMARY: Readonly<Record<OwnerRequest['kind'], string>> = {
  DECISION: 'Send answer',
  SECRET: 'Provide key',
  MANUAL_STEP: 'Mark done',
  CONFIRM: 'Confirm',
};

const SECRET_NOT_READY = 'Entering a key arrives with secret delivery.';

/** The runner a secret goes to, by the name the owner knows it by. */
function useRunnerName(runnerId: string | undefined): string {
  const runners = useQuery({ ...runnersQuery(), enabled: Boolean(runnerId) });
  const runner = runners.data?.find((row) => runnerId && sameResourceId(row.id, runnerId));
  return runner?.displayName ?? runner?.name ?? 'this runner';
}

/** The tasks a request holds up, linked by title. A task that cannot be read keeps a link with no name. */
function HoldingUp({ taskIds }: { taskIds: readonly string[] }): JSX.Element {
  const tasks = useQueries({
    queries: taskIds.map((id) => ({
      queryKey: ['owner-request-task', id] as const,
      queryFn: () => api<{ title?: string }>(`/tasks/${encodeURIComponent(id)}`),
      staleTime: 300_000,
      retry: false,
    })),
  });
  return (
    <span className="owner-request-chips">
      {taskIds.map((id, index) => (
        <Link key={id} className="owner-request-chip" to={`/tasks/${encodeURIComponent(linkId(id))}`}>
          {tasks[index]?.data?.title ?? 'Task'}
        </Link>
      ))}
    </span>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

/** A command or address on a step, with the one thing to do with it. */
function StepValue({ value, action, onAction, href }: {
  value: string;
  action: string;
  onAction?: () => void;
  href?: string;
}): JSX.Element {
  return (
    <span className="owner-request-value">
      <code>{value}</code>
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer">{action}</a>
      ) : (
        <button type="button" onClick={onAction}>{action}</button>
      )}
    </span>
  );
}

function CopyValue({ value }: { value: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void copyText(value).then((ok) => {
      if (!ok) return;
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  return <StepValue value={value} action={copied ? 'Copied' : 'Copy'} onAction={copy} />;
}

function Steps({ steps }: { steps: readonly OwnerRequestStep[] }): JSX.Element {
  return (
    <ol className="owner-request-steps">
      {steps.map((step, index) => {
        const href = step.link ? openableLink(step.link) : null;
        return (
          <li key={`${index}-${step.text}`}>
            <span className="owner-request-step-number">{index + 1}</span>
            <div>
              <div>{step.text}</div>
              {step.link ? (
                href ? <StepValue value={step.link} action="Open" href={href} /> : <code>{step.link}</code>
              ) : null}
              {step.command ? <CopyValue value={step.command} /> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Where the key goes and what it can do there, in the wording of the secrets design (§7.3). */
function secretNotice(spec: OwnerRequestSecretSpec, runner: string): string {
  const where = spec.filePath
    ? `Goes straight to ${runner} as a file. Orbit keeps it out of this conversation, but any program running as the runner’s user on ${runner} can read the file until it is removed.`
    : `Goes straight to ${runner}. Orbit keeps it out of this conversation and away from the agent; only commands the agent runs with it can use it.`;
  return `${where} Use a key you can revoke.`;
}

function destination(spec: OwnerRequestSecretSpec, runner: string): JSX.Element {
  return (
    <>
      Runner <strong>{runner}</strong> {spec.filePath ? 'at' : 'as'} <code>{spec.filePath ?? spec.envVar}</code>
    </>
  );
}

/** The key's input, drawn and switched off until the task that delivers secrets gives it somewhere to go. */
function SecretEntry({ spec, runner }: { spec: OwnerRequestSecretSpec; runner: string }): JSX.Element {
  return (
    <div className="owner-request-secret">
      <label className="owner-request-field">
        <span>{spec.name}</span>
        <Input disabled autoComplete="off" placeholder={SECRET_NOT_READY} />
      </label>
      <label className="owner-request-save">
        <Checkbox disabled checked={false} />
        <span>Save to my account secrets for later runs</span>
      </label>
      <p className="owner-request-notice">
        <LockOutlined aria-hidden="true" /> {secretNotice(spec, runner)}
      </p>
    </div>
  );
}

function RemindLater({ request, now }: { request: OwnerRequest; now: number }): JSX.Element {
  const choices = snoozeChoices(request, now);
  return (
    <Menu
      disabled={choices.length === 0}
      trigger={
        <button type="button" className="owner-request-later" disabled={choices.length === 0}>
          Remind me later <DownOutlined aria-hidden="true" />
        </button>
      }
      items={choices.map((choice) => ({
        key: choice.key,
        label: choice.label,
        onSelect: () => snoozeRequest(request.id, Date.now() + choice.ms),
      }))}
    />
  );
}

/** A pending request, whole. */
export function OwnerRequestCard({ request, now = Date.now() }: { request: OwnerRequest; now?: number }): JSX.Element {
  const qc = useQueryClient();
  const [chosen, setChosen] = useState<Choice>(request.recommendedOption ?? null);
  const [text, setText] = useState('');
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const runner = useRunnerName(request.secretSpec?.runnerId);
  const end = useMutation({
    mutationFn: ({ to, body }: Ending) =>
      api<OwnerRequest>(`/owner-requests/${encodeURIComponent(request.id)}/${to}`, { method: 'POST', body }),
    // Ended or refused, the lists are re-read: one somebody ended on another device turns into its summary here.
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['owner-requests'] });
    },
  });
  if (end.data) return <OwnerRequestResolved request={end.data} now={now} />;

  const options = request.options ?? [];
  const closed = pastDeadline(request, now);
  const trimmed = text.trim();
  const chosenOption = optionIndex(chosen);
  const ready = request.kind === 'SECRET'
    ? false
    : request.kind === 'DECISION'
      ? chosenOption !== null || trimmed !== ''
      : true;
  const expiry = expiryText(request, now);
  const pressPrimary = () => {
    const body = request.kind === 'DECISION'
      ? { ...(chosenOption !== null ? { option: chosenOption } : {}), ...(trimmed ? { text: trimmed } : {}) }
      : {};
    end.mutate({ to: 'done', body });
  };

  return (
    <section className="owner-request-card" id={`owner-request-${request.id}`} data-kind={request.kind}>
      <header className="owner-request-head">
        <span className="owner-request-dot" aria-hidden="true" />
        <span className="owner-request-waiting">{WAITING_ON_YOU}</span>
        <span className="owner-request-age">
          {`Asked ${ago(request.createdAt, now)}`}{expiry ? ` · ${expiry}` : ''}
        </span>
      </header>
      <div className="owner-request-body">
        <div className="owner-request-title-row">
          <h3 className="owner-request-title">{request.title}</h3>
          <span className="owner-request-kind">{KIND_TAGS[request.kind]}</span>
        </div>
        <div className="owner-request-why md">
          <Markdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeCodeWords]}
            urlTransform={referenceUrlTransform}
            components={{ a: ReferenceLink }}
          >
            {request.why}
          </Markdown>
        </div>
        {request.blocksTaskIds.length > 0 || request.secretSpec ? (
          <dl className="owner-request-facts">
            {request.blocksTaskIds.length > 0 ? (
              <Fact label="Holding up"><HoldingUp taskIds={request.blocksTaskIds} /></Fact>
            ) : null}
            {request.secretSpec ? (
              <>
                <Fact label="Delivered to">{destination(request.secretSpec, runner)}</Fact>
                <Fact label="Removed">When the task ends, or after 7 days</Fact>
              </>
            ) : null}
          </dl>
        ) : null}

        {request.kind === 'MANUAL_STEP' ? <Steps steps={request.steps ?? []} /> : null}
        {request.kind === 'SECRET' && request.secretSpec ? <SecretEntry spec={request.secretSpec} runner={runner} /> : null}
        {request.kind === 'DECISION' ? (
          <div className="owner-request-decision">
            <QuestionOptions
              name={`owner-request-${request.id}`}
              options={options}
              recommendedOption={request.recommendedOption}
              chosen={chosen}
              onChoose={setChosen}
            />
            <Textarea
              className="coordinator-question-free"
              value={text}
              maxLength={4000}
              autoSize={{ minRows: 2, maxRows: 8 }}
              placeholder={options.length === 0 ? YOUR_ANSWER : chosenOption !== null ? NOTE_PROMPT : OWN_ANSWER_PROMPT}
              onChange={(event) => setText(event.target.value)}
            />
          </div>
        ) : null}
        {request.verifyHint ? <p className="owner-request-hint">{`How to check: ${request.verifyHint}`}</p> : null}

        {end.isError ? (
          <Alert type="error" title="That was not recorded" description={(end.error as Error).message} />
        ) : null}

        {declining ? (
          <div className="owner-request-decline">
            <Textarea
              value={reason}
              maxLength={2000}
              autoSize={{ minRows: 2, maxRows: 6 }}
              placeholder="Why? The session that asked reads this."
              aria-label="Reason for declining"
              onChange={(event) => setReason(event.target.value)}
            />
            <CardActions className="owner-request-actions">
              <CardActionButton
                tone="primary"
                disabled={!reason.trim() || end.isPending || closed}
                onClick={() => end.mutate({ to: 'decline', body: { reason: reason.trim() } })}
              >
                Decline
              </CardActionButton>
              <CardActionButton onClick={() => setDeclining(false)}>Keep it</CardActionButton>
            </CardActions>
          </div>
        ) : (
          <CardActions className="owner-request-actions">
            <CardActionButton
              tone="primary"
              disabled={!ready || end.isPending || closed}
              title={request.kind === 'SECRET' ? SECRET_NOT_READY : undefined}
              onClick={pressPrimary}
            >
              {PRIMARY[request.kind]}
            </CardActionButton>
            <button type="button" className="owner-request-link" disabled={closed} onClick={() => setDeclining(true)}>
              {request.kind === 'MANUAL_STEP' ? 'Can’t do this…' : 'Decline…'}
            </button>
            <RemindLater request={request} now={now} />
          </CardActions>
        )}

        {request.ifUnanswered ? (
          <p className="owner-request-unanswered">
            <strong>If nobody answers:</strong> {request.ifUnanswered}
          </p>
        ) : null}
      </div>
    </section>
  );
}

/** The summary's second line: what came of it. */
function outcomeLine(request: OwnerRequest, runner: string): string {
  const note = request.resolutionNote?.trim();
  if (request.state === 'DECLINED') return note ? `Declined: “${note}”` : 'Declined';
  if (request.state === 'EXPIRED') return 'Expired before anyone answered';
  if (request.state === 'WITHDRAWN') return note ? `Withdrawn: “${note}”` : 'Withdrawn';
  if (request.kind === 'SECRET' && request.secretSpec) {
    const { envVar, filePath } = request.secretSpec;
    return `Delivered to ${runner} ${filePath ? 'at' : 'as'} ${filePath ?? envVar}`;
  }
  if (request.kind === 'DECISION') {
    const option = request.answer?.option;
    const label = option === undefined ? undefined : request.options?.[option]?.label;
    const said = request.answer?.text?.trim();
    if (label) return said ? `${label}: “${said}”` : label;
    return said ? `“${said}”` : 'Answered';
  }
  return request.kind === 'CONFIRM' ? 'Confirmed' : 'Marked done';
}

function endedBy(request: OwnerRequest): string | null {
  if (request.state === 'EXPIRED') return null;
  return request.resolvedByUserId ? 'by you' : 'by the session that asked';
}

const ENDING_ICON: Readonly<Record<string, ReactNode>> = {
  DONE: <CheckCircleFilled />,
  DECLINED: <CloseCircleFilled />,
  EXPIRED: <ClockCircleOutlined />,
  WITHDRAWN: <RollbackOutlined />,
};

/** A request that has ended, as one row: how, who, when, and from which device. */
export function OwnerRequestResolved({ request, now = Date.now() }: { request: OwnerRequest; now?: number }): JSX.Element {
  const runner = useRunnerName(request.kind === 'SECRET' ? request.secretSpec?.runnerId : undefined);
  const when = request.resolvedAt ? decisionReceiptTime(request.resolvedAt, new Date(now)) : null;
  const by = [endedBy(request), when].filter(Boolean).join(' · ');
  const device = deviceLabel(request.resolvedClient);
  return (
    <div className={`owner-request-resolved is-${request.state.toLowerCase()}`} id={`owner-request-${request.id}`}>
      <span className="owner-request-resolved-icon" aria-hidden="true">{ENDING_ICON[request.state]}</span>
      <span className="owner-request-resolved-text">
        <span className="owner-request-resolved-title">{request.title}</span>
        <span className="owner-request-resolved-outcome">{outcomeLine(request, runner)}</span>
      </span>
      <span className="owner-request-resolved-by">
        <span>{by}</span>
        {device ? <span>{`via ${device}`}</span> : null}
      </span>
    </div>
  );
}

/** A request put off with Remind me later, folded in the conversation until it comes back. */
function SnoozedRequest({ request, until, now }: { request: OwnerRequest; until: number; now: number }): JSX.Element {
  return (
    <div className="owner-request-snoozed" id={`owner-request-${request.id}`}>
      <ClockCircleOutlined aria-hidden="true" />
      <span className="owner-request-snoozed-title">{request.title}</span>
      <span className="owner-request-age">{`Reminder ${decisionReceiptTime(new Date(until).toISOString(), new Date(now))}`}</span>
      <button type="button" className="owner-request-link" onClick={() => wakeRequest(request.id)}>Show now</button>
    </div>
  );
}

/** One request where a conversation draws it: whole, folded for later, or as its summary. */
function ConversationRequest({ request }: { request: OwnerRequest }): JSX.Element {
  const snoozes = useSnoozes();
  const now = Date.now();
  if (request.state !== 'PENDING') return <OwnerRequestResolved request={request} now={now} />;
  const until = snoozes[request.id] ?? 0;
  if (until > now) return <SnoozedRequest request={request} until={until} now={now} />;
  return <OwnerRequestCard request={request} now={now} />;
}

/**
 * This session's requests as transcript inserts, each where it was filed. Pending ones come from
 * their own read as well, so one older than the newest 200 of every state is still drawn.
 */
export function useSessionOwnerRequestInserts(
  sessionId: string | null | undefined,
  events: ReadonlyArray<{ seq: number; ts?: string }>,
): TranscriptInsert[] {
  const open = useQuery({ ...ownerRequestsQuery('open'), enabled: Boolean(sessionId) });
  const all = useQuery({ ...ownerRequestsQuery('all'), enabled: Boolean(sessionId) });
  return useMemo(() => {
    if (!sessionId) return [];
    const byId = new Map<string, OwnerRequest>();
    for (const request of [...(all.data?.requests ?? []), ...(open.data?.requests ?? [])]) {
      if (sameResourceId(request.askedBySessionId, sessionId)) byId.set(request.id, request);
    }
    // Oldest first — the read is newest first — so two filed between the same two events read in the order they were asked.
    const asked = [...byId.values()].sort((x, y) => Date.parse(x.createdAt) - Date.parse(y.createdAt));
    return asked.flatMap((request) => {
      const anchor = decisionReceiptAnchor(events, request.createdAt);
      return anchor === null
        ? []
        : [{
            anchor,
            moment: request.createdAt,
            key: `owner-request:${request.id}`,
            element: <ConversationRequest request={request} />,
          }];
    });
  }, [sessionId, events, open.data, all.data]);
}

/** On a task a pending request holds up, wherever a task is listed or opened. */
export function WaitingOnYouTaskBadge({ taskId }: { taskId: string }): JSX.Element | null {
  const held = useQuery({
    ...ownerRequestsQuery('open'),
    select: (data) => isTaskHeld(data.requests, taskId),
  });
  return held.data ? <span className="owner-request-task-badge">{WAITING_ON_YOU}</span> : null;
}
