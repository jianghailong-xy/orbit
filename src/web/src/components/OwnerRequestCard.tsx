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
  type OwnerRequestSecretGrant,
  type OwnerRequestSecretSpec,
  type OwnerRequestStep,
} from '../lib/ownerRequests';
import { accountSecretsQuery, ownerRequestsQuery, runnersQuery } from '../lib/queries';
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
import { PasswordInput } from './ui/PasswordInput';
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

/** What the owner has put in so far. Held in this card's state only: never stored, never in a URL, gone on unmount. */
interface SecretDraft {
  value: string;
  save: boolean;
  saveAs: string;
  savedId: string | null;
}

const emptyDraft = (spec: OwnerRequestSecretSpec | null): SecretDraft =>
  ({ value: '', save: false, saveAs: spec?.name ?? '', savedId: null });

type SecretBody = { value: string; saveAs?: string } | { savedSecretId: string };

/**
 * A secret request's own doors: submit, cancel before delivery, revoke after. Not a mutation, because
 * a mutation keeps its variables in the query client's cache, and the key would be one of them. The
 * answer stands in for the request until the next read of it arrives.
 */
function useSecretDoor(request: OwnerRequest) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [answer, setAnswer] = useState<{ base: OwnerRequest; view: OwnerRequest } | null>(null);
  const post = async (door: 'secret' | 'secret/cancel' | 'secret/revoke', body?: SecretBody) => {
    setBusy(true);
    setFailure(null);
    try {
      const view = await api<OwnerRequest | undefined>(
        `/owner-requests/${encodeURIComponent(request.id)}/${door}`,
        body ? { method: 'POST', body } : { method: 'POST' },
      );
      if (view?.id) setAnswer({ base: request, view });
    } catch (error) {
      setFailure((error as Error).message);
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: ['owner-requests'] });
    }
  };
  return { post, busy, failure, current: answer && answer.base === request ? answer.view : request };
}

/** The key's input, a saved secret to use instead, and whether to keep this one for later. */
function SecretEntry({ spec, runner, draft, onDraft }: {
  spec: OwnerRequestSecretSpec;
  runner: string;
  draft: SecretDraft;
  onDraft: (draft: SecretDraft) => void;
}): JSX.Element {
  const saved = useQuery(accountSecretsQuery()).data?.secrets ?? [];
  const using = draft.savedId ? saved.find((secret) => secret.id === draft.savedId) : undefined;
  return (
    <div className="owner-request-secret">
      {draft.savedId ? (
        <div className="owner-request-field">
          <span>{spec.name}</span>
          <span className="owner-request-saved">
            {`Using saved “${using?.label ?? 'secret'}”`}
            <button type="button" className="owner-request-link" onClick={() => onDraft({ ...draft, savedId: null })}>
              Enter a key instead
            </button>
          </span>
        </div>
      ) : (
        <>
          <label className="owner-request-field">
            <span>{spec.name}</span>
            <PasswordInput
              value={draft.value}
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste the key"
              onChange={(event) => onDraft({ ...draft, value: event.target.value })}
            />
          </label>
          {saved.length > 0 ? (
            <span className="owner-request-saved">
              Use saved:
              {saved.map((secret) => (
                <button
                  key={secret.id}
                  type="button"
                  className="owner-request-chip"
                  onClick={() => onDraft({ ...draft, value: '', save: false, savedId: secret.id })}
                >
                  {secret.label}
                </button>
              ))}
            </span>
          ) : null}
          <label className="owner-request-save">
            <Checkbox checked={draft.save} onCheckedChange={(save) => onDraft({ ...draft, save })} />
            <span>Save to my account secrets for later runs</span>
          </label>
          {draft.save ? (
            <Input
              value={draft.saveAs}
              maxLength={100}
              aria-label="Name to save it under"
              placeholder="Name to save it under"
              onChange={(event) => onDraft({ ...draft, saveAs: event.target.value })}
            />
          ) : null}
        </>
      )}
      <p className="owner-request-notice">
        <LockOutlined aria-hidden="true" /> {secretNotice(spec, runner)}
      </p>
    </div>
  );
}

/** Submitted, not yet on the runner: the request is done only when the runner says it has the key (design §2, §4.3). */
function SecretOnItsWay({ grant, runner, expiresAt, now }: {
  grant: OwnerRequestSecretGrant;
  runner: string;
  expiresAt: string | null;
  now: number;
}): JSX.Element {
  const until = expiresAt ? `, until ${decisionReceiptTime(expiresAt, new Date(now))}` : '';
  return (
    <div className="owner-request-secret">
      <p className="owner-request-delivery">
        <ClockCircleOutlined aria-hidden="true" /> {`Key is on its way to ${runner}.`}
      </p>
      {grant.runnerOnline ? null : (
        <p className="owner-request-notice">{`${runner} is offline. Orbit will deliver this when it comes back${until}.`}</p>
      )}
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
export function OwnerRequestCard({ request: given, now = Date.now() }: { request: OwnerRequest; now?: number }): JSX.Element {
  const qc = useQueryClient();
  const door = useSecretDoor(given);
  const request = door.current;
  const [draft, setDraft] = useState<SecretDraft>(() => emptyDraft(request.secretSpec));
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
  if (request.state !== 'PENDING') return <OwnerRequestResolved request={request} now={now} />;

  const options = request.options ?? [];
  const closed = pastDeadline(request, now);
  const trimmed = text.trim();
  const chosenOption = optionIndex(chosen);
  const grant = request.kind === 'SECRET' ? request.secretGrant : null;
  const delivering = grant?.state === 'PENDING_DELIVERY';
  // An earlier key the runner fetched and never confirmed is still being removed (§2, §6.4): no new one until it is.
  const removing = grant?.state === 'REMOVING';
  const failed = grant?.state === 'REMOVED' && grant.endReason === 'DELIVERY_FAILED';
  const ready = request.kind === 'SECRET'
    ? draft.savedId !== null || (draft.value.trim() !== '' && (!draft.save || draft.saveAs.trim() !== ''))
    : request.kind === 'DECISION'
      ? chosenOption !== null || trimmed !== ''
      : true;
  const expiry = expiryText(request, now);
  const pressPrimary = () => {
    if (request.kind === 'SECRET') {
      const body: SecretBody = draft.savedId
        ? { savedSecretId: draft.savedId }
        : { value: draft.value, ...(draft.save ? { saveAs: draft.saveAs.trim() } : {}) };
      setDraft(emptyDraft(request.secretSpec));
      void door.post('secret', body);
      return;
    }
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
        {request.kind === 'SECRET' && request.secretSpec ? (
          delivering ? (
            <SecretOnItsWay grant={grant!} runner={runner} expiresAt={request.expiresAt} now={now} />
          ) : removing ? (
            <div className="owner-request-secret">
              <p className="owner-request-delivery">
                <ClockCircleOutlined aria-hidden="true" /> {grantLine(grant!, runner, now)}
              </p>
              <p className="owner-request-notice">{`You can enter a key again once ${runner} confirms the earlier one is gone.`}</p>
            </div>
          ) : (
            <SecretEntry spec={request.secretSpec} runner={runner} draft={draft} onDraft={setDraft} />
          )
        ) : null}
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

        {failed ? (
          <Alert type="error" title={`The key did not reach ${runner}`} description={grant.removalNote ?? 'Enter it again.'} />
        ) : null}
        {end.isError || door.failure ? (
          <Alert type="error" title="That was not recorded" description={door.failure ?? (end.error as Error).message} />
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
            {delivering ? (
              <CardActionButton disabled={door.busy} onClick={() => void door.post('secret/cancel')}>Cancel</CardActionButton>
            ) : (
              <CardActionButton
                tone="primary"
                disabled={!ready || end.isPending || door.busy || closed}
                onClick={pressPrimary}
              >
                {PRIMARY[request.kind]}
              </CardActionButton>
            )}
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

const GRANT_ENDINGS: Readonly<Record<string, string>> = {
  TASK_ENDED: 'Removed when the task ended',
  SESSION_ENDED: 'Removed when the session ended',
  EXPIRED: 'Removed when it expired',
  WITHDRAWN: 'Removed: the agent released it',
  REVOKED: 'Removed: you revoked it',
  MOVED: 'Removed when the session moved to another runner',
  RUNNER_DELETED: 'The runner was deleted; removal unconfirmed',
  KEY_UNREADABLE: 'Removed: the stored key could not be read',
  DELIVERY_FAILED: 'Delivery failed',
};

/** Where a delivered key stands now (design §6): in, being removed, or gone and why. */
function grantLine(grant: OwnerRequestSecretGrant, runner: string, now: number): string | null {
  const at = (iso: string) => decisionReceiptTime(iso, new Date(now));
  if (grant.state === 'ACTIVE') return `Key is in · expires ${at(grant.expiresAt)}`;
  if (grant.state === 'REMOVING') {
    return !grant.runnerOnline && grant.runnerLastSeenAt
      ? `Removal pending: ${runner} has not been online since ${at(grant.runnerLastSeenAt)}`
      : `Removal pending: waiting for ${runner} to confirm`;
  }
  if (grant.state === 'REMOVED') {
    const why = (grant.endReason && GRANT_ENDINGS[grant.endReason]) || 'Removed';
    return grant.removalNote ? `${why}. ${grant.removalNote}` : why;
  }
  return null;
}

const ENDING_ICON: Readonly<Record<string, ReactNode>> = {
  DONE: <CheckCircleFilled />,
  DECLINED: <CloseCircleFilled />,
  EXPIRED: <ClockCircleOutlined />,
  WITHDRAWN: <RollbackOutlined />,
};

/** A request that has ended, as one row: how, who, when, and from which device. */
export function OwnerRequestResolved({ request: given, now = Date.now() }: { request: OwnerRequest; now?: number }): JSX.Element {
  const door = useSecretDoor(given);
  const request = door.current;
  // A delivered key's whole story on a DONE request; on any other ending, only a removal still pending — a key the
  // runner fetched and never confirmed (§2, §6.4) — so the card never says gone while a copy may remain.
  const held = request.kind === 'SECRET' ? request.secretGrant : null;
  const grant = held && (request.state === 'DONE' || held.state === 'REMOVING') ? held : null;
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
        {grant ? <span className="owner-request-resolved-outcome">{grantLine(grant, runner, now)}</span> : null}
        {door.failure ? <span className="owner-request-resolved-error">{door.failure}</span> : null}
      </span>
      {grant?.state === 'ACTIVE' ? (
        <button type="button" className="owner-request-link" disabled={door.busy} onClick={() => void door.post('secret/revoke')}>
          Revoke
        </button>
      ) : null}
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
