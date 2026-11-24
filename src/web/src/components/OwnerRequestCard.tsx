import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { OwnerCardTranslation } from '@orbit/shared';
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
import { answerRefusedUntranslated } from '../lib/translation';
import { copyText } from '../lib/clipboard';
import { rehypeCodeWords } from '../lib/codeWords';
import { decisionReceiptAnchor } from '../lib/decisionReceipt';
import { ReferenceLink, referenceUrlTransform } from '../lib/markdownLinks';
import {
  BROWSER_SIGN_IN_COPY,
  CHANGE_COPY,
  KIND_TAGS,
  changeNumber,
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
  type AgentRequestKind,
  type OwnerRequest,
  type OwnerRequestSecretGrant,
  type OwnerRequestSecretSpec,
  type OwnerRequestStep,
} from '../lib/ownerRequests';
import { accountSecretsQuery, ownerRequestsQuery, runnersQuery } from '../lib/queries';
import { openRunnerBrowserTab } from '../lib/runnerBrowser';
import {
  WIKI_CREATE_CHANGE_SETTINGS,
  WIKI_CREATE_MAINTENANCE,
  WIKI_CREATE_NOT_HERE,
  WIKI_CREATE_READS_FROM,
  WIKI_CREATE_REPOSITORY,
  WIKI_WORKSPACE_OFFLINE,
  wikiCreateCardFacts,
} from '../lib/wikiStart';
import { ago, linkId, sameResourceId } from '../lib/watches';
import { CardActionButton, CardActions } from './CardAction';
import { OWNER_SEND_BACK_ACTION } from './OwnerConfirmationCard';
import { NOTE_PROMPT, OWN_ANSWER_PROMPT, YOUR_ANSWER, QuestionOptions, optionIndex, type Choice } from './CoordinatorQuestionCard';
import { decisionReceiptTime } from './EvidenceDecisionCard';
import Markdown from './Markdown';
import type { TranscriptInsert } from './Transcript';
import { RefusedAnswerFoot, useOwnerCardTranslation } from './TranslationParts';
import { Alert } from './ui/Alert';
import { Checkbox } from './ui/Checkbox';
import { Input } from './ui/Input';
import { Menu } from './ui/Menu';
import { PasswordInput } from './ui/PasswordInput';
import { Textarea } from './ui/Textarea';
import { WikiCreateDialog, sameId, useWikiWorkspaceChoices } from './WikiSetUpDialog';
import { ScheduleWaitingCard, isScheduleWaitingKind } from './ScheduleWaitingCard';
import { ConditionWaitingCard, isConditionWaitingKind } from './ConditionWaitingCard';
import { SettingsChangeCard, SettingsChangeFolded } from './SettingsChangeCard';
import { ProjectReopenCard, ProjectReopenFolded } from './ProjectReopenCard';
import './OwnerRequest.css';
import { useMachineName } from '../lib/managedRunner';

/**
 * What a session asked the owner to do, as a card in the conversation that asked and in the
 * "Waiting on you" inbox: one component reading one door (`/owner-requests`), so the two cannot say
 * different things. Pending it is the whole request; once it has ended it is one line saying how,
 * who and when, at the same place.
 */

type Ending =
  | { to: 'done'; body: { option?: number; text?: string; sendAsWritten?: true } }
  | { to: 'decline'; body: { reason: string; sendAsWritten?: true } }
  // WIKI_CREATE's Create wiki: the owner's door that makes the wiki and settles the card (design §3.6).
  | { to: 'create-wiki'; body: Record<string, never> }
  // CHANGE's Apply: the owner's door that writes the runner setting and settles the card.
  | { to: 'apply'; body: { maxConcurrent: number } };

/**
 * A request's agent-written words as the card draws them: translated while it is shown translated
 * (board 04-owner-cards.html); a step's command and link, and the option picked, stay the original's.
 */
function shownRequest(request: OwnerRequest, t: OwnerCardTranslation | undefined): OwnerRequest {
  if (!t) return request;
  return {
    ...request,
    title: t.title || request.title,
    why: t.why || request.why,
    ifUnanswered: request.ifUnanswered ? t.ifUnanswered || request.ifUnanswered : request.ifUnanswered,
    verifyHint: request.verifyHint ? t.verifyHint || request.verifyHint : request.verifyHint,
    options: request.options ? request.options.map((o, i) => {
      const to = t.options?.[i];
      if (!to) return o;
      return { ...o, label: to.label || o.label, ...(o.description !== undefined ? { description: to.description || o.description } : {}) };
    }) : request.options,
    steps: request.steps ? request.steps.map((step, i) => ({ ...step, text: t.steps?.[i]?.text || step.text })) : request.steps,
  };
}

const PRIMARY: Readonly<Record<AgentRequestKind, string>> = {
  DECISION: 'Send answer',
  SECRET: 'Provide key',
  MANUAL_STEP: 'Mark done',
  CONFIRM: 'Confirm',
  WIKI_CREATE: 'Create wiki',
  SETTINGS_CHANGE: 'Save changes',
  PROJECT_REOPEN: 'Reopen',
  BROWSER_SIGN_IN: BROWSER_SIGN_IN_COPY.openBrowser,
  CHANGE: CHANGE_COPY.primary,
};

/** The runner a secret goes to, by the name the owner knows it by. */
function useRunnerName(runnerId: string | undefined): string {
  const runners = useQuery({ ...runnersQuery(), enabled: Boolean(runnerId) });
  const runner = runners.data?.find((row) => runnerId && sameResourceId(row.id, runnerId));
  const machineNameOf = useMachineName();
  return (runner ? machineNameOf(runner) : '') || 'this runner';
}

/** The runner row a CHANGE names: its live Max Concurrent, how many sessions run now, and its name. */
function useChangeRunner(runnerId: string | undefined): { name: string; live: number | null; running: number | null } {
  const runners = useQuery({ ...runnersQuery(), enabled: Boolean(runnerId) });
  const row = runners.data?.find((r) => runnerId && sameResourceId(r.id, runnerId));
  const machineNameOf = useMachineName();
  return {
    name: (row ? machineNameOf(row) : '') || 'this runner',
    live: typeof row?.maxConcurrent === 'number' ? row.maxConcurrent : null,
    running: typeof row?.activeSessions === 'number' ? row.activeSessions : null,
  };
}

/** A CHANGE card's setting block: live value → editable number, what is running, and what the number would do. */
function ChangeSetting({ spec, value, onValue }: {
  spec: NonNullable<OwnerRequest['changeSpec']>;
  value: string;
  onValue: (value: string) => void;
}): JSX.Element {
  const { name, live, running } = useChangeRunner(spec.runnerId);
  const current = live ?? spec.before;
  const n = changeNumber(value);
  return (
    <div className="owner-request-change">
      <div className="owner-request-change-setting">{CHANGE_COPY.setting(name)}</div>
      <div className="owner-request-change-row">
        <span className="owner-request-change-live">{current}</span>
        <span aria-hidden="true">→</span>
        <Input
          type="number"
          min={1}
          step={1}
          className="owner-request-change-input"
          aria-label={CHANGE_COPY.numberLabel}
          value={value}
          invalid={n === null}
          onChange={(event) => onValue(event.target.value)}
        />
        {running !== null ? <span className="owner-request-change-running">{CHANGE_COPY.runningNow(running)}</span> : null}
      </div>
      {current !== spec.before ? <p className="owner-request-change-was">{CHANGE_COPY.wasWhenAsked(spec.before)}</p> : null}
      {n !== null && n < current ? <p className="owner-request-change-effect">{CHANGE_COPY.lowering(n)}</p> : null}
      {n !== null && n > current ? <p className="owner-request-change-effect">{CHANGE_COPY.raising(n)}</p> : null}
    </div>
  );
}

/** The tasks a request holds up, linked by title. A task that cannot be read keeps a link with no name. */
function HoldingUp({ taskIds }: { taskIds: readonly string[] }): JSX.Element {
  const tasks = useQueries({
    queries: taskIds.map((id) => ({
      queryKey: ['owner-request-task', id] as const,
      meta: { entities: ['task'] },
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

/**
 * What a WIKI_CREATE card will make (docs/wiki-explicit-creation-design.md §3.6): the repository, the asking session's
 * workspace it reads it from — offline when its runner is — and the maintenance it starts with.
 */
function WikiCreateFacts({ request }: { request: OwnerRequest }): JSX.Element {
  const { choices } = useWikiWorkspaceChoices();
  const workspaceId = choices.find((choice) => sameId(choice.id, request.workspaceId ?? null))?.id ?? request.workspaceId ?? null;
  const facts = wikiCreateCardFacts({ repoUrlNorm: request.repoUrlNorm, workspaceId }, choices);
  return (
    <dl className="owner-request-facts">
      {facts.repository ? <Fact label={WIKI_CREATE_REPOSITORY}>{facts.repository}</Fact> : null}
      <Fact label={WIKI_CREATE_READS_FROM}>
        {facts.readsFrom ?? '—'}
        {facts.offline ? <span className="owner-request-offline">{WIKI_WORKSPACE_OFFLINE}</span> : null}
      </Fact>
      <Fact label={WIKI_CREATE_MAINTENANCE}>{facts.maintenance}</Fact>
    </dl>
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
  // The "Copied" reset is cancelled when the card goes, so it never updates a card that is gone.
  const reset = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(reset.current), []);
  const copy = () => {
    void copyText(value).then((ok) => {
      if (!ok) return;
      setCopied(true);
      window.clearTimeout(reset.current);
      reset.current = window.setTimeout(() => setCopied(false), 1500);
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

/** Hands a talk about the request to the conversation's composer. Only a conversation has one, so the inbox passes none. */
type ChatAbout = (request: OwnerRequest) => void;

/** A pending request, whole. */
export function OwnerRequestCard(props: {
  request: OwnerRequest;
  now?: number;
  onChat?: ChatAbout;
  /** The conversation drawing the card, so a PROJECT_REOPEN names its askers only outside the asking session. */
  viewedFromSessionId?: string | null;
}): JSX.Element {
  // A scheduled task's items (failed, held, a run's approval, a run's wider envelope) are answered through the door of
  // what they point at, so they draw their own body in the same frame.
  // A proposed change to the owner's Settings is drawn as a confirmation card (docs/settings-from-conversation-design.md
  // §8.1); answered, as its own one-line fold. Expired or withdrawn, it reads as any request does.
  if (props.request.kind === 'SETTINGS_CHANGE') {
    if (props.request.state === 'PENDING') return <SettingsChangeCard request={props.request} />;
    if (props.request.state === 'DONE' || props.request.state === 'DECLINED') return <SettingsChangeFolded request={props.request} />;
  }
  if (props.request.kind === 'PROJECT_REOPEN') {
    if (props.request.state === 'PENDING') return <ProjectReopenCard request={props.request} viewedFromSessionId={props.viewedFromSessionId} />;
    if (props.request.state === 'DONE' || props.request.state === 'DECLINED') return <ProjectReopenFolded request={props.request} now={props.now} />;
  }
  if (props.request.state === 'PENDING' && isConditionWaitingKind(props.request.kind)) {
    return <ConditionWaitingCard request={props.request} now={props.now} />;
  }
  return isScheduleWaitingKind(props.request.kind) && props.request.state === 'PENDING'
    ? <ScheduleWaitingCard request={props.request} now={props.now} />
    : <AgentRequestCard {...props} />;
}

function AgentRequestCard({ request: given, now = Date.now(), onChat }: {
  request: OwnerRequest;
  now?: number;
  onChat?: ChatAbout;
}): JSX.Element {
  const qc = useQueryClient();
  const door = useSecretDoor(given);
  const translated = useOwnerCardTranslation(door.current.translation);
  const request = shownRequest(door.current, translated.shown);
  const [draft, setDraft] = useState<SecretDraft>(() => emptyDraft(request.secretSpec));
  const [chosen, setChosen] = useState<Choice>(request.recommendedOption ?? null);
  const [text, setText] = useState('');
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const [changing, setChanging] = useState(false);
  const [maxValue, setMaxValue] = useState(String(request.changeSpec?.requested ?? ''));
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
      : request.kind === 'CHANGE'
        ? changeNumber(maxValue) !== null
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
    if (request.kind === 'CHANGE') {
      end.mutate({ to: 'apply', body: { maxConcurrent: changeNumber(maxValue)! } });
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
        {request.kind === 'BROWSER_SIGN_IN' ? <p className="owner-request-eyebrow">{BROWSER_SIGN_IN_COPY.eyebrow}</p> : null}
        <div className="owner-request-title-row">
          <h3 className="owner-request-title">{request.title}</h3>
          <span className="owner-request-kind">{KIND_TAGS[request.kind]}</span>
        </div>
        {request.kind === 'BROWSER_SIGN_IN' ? (
          // The agent's reason, quoted as its own words; the session that asked; what signing in here means.
          <>
            <div className="owner-request-why">{`“${request.why}”`}</div>
            {request.askedBySessionTitle?.trim() ? (
              <p className="owner-request-notice">{BROWSER_SIGN_IN_COPY.fromSession(request.askedBySessionTitle.trim())}</p>
            ) : null}
            <p className="owner-request-notice">{BROWSER_SIGN_IN_COPY.note}</p>
          </>
        ) : (
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
        )}
        {request.kind === 'CHANGE' && request.changeSpec ? (
          <ChangeSetting spec={request.changeSpec} value={maxValue} onValue={setMaxValue} />
        ) : null}
        {request.blocksTaskIds.length > 0 || request.secretSpec ? (
          <dl className="owner-request-facts">
            {request.blocksTaskIds.length > 0 ? (
              <Fact label="Holding up"><HoldingUp taskIds={request.blocksTaskIds} /></Fact>
            ) : null}
            {request.secretSpec ? (
              <>
                <Fact label="Delivered to">{destination(request.secretSpec, runner)}</Fact>
                <Fact label="Removed">
                  {request.secretScope === 'SESSION' ? 'When the session ends, or after 7 days' : 'When the task ends, or after 7 days'}
                </Fact>
              </>
            ) : null}
          </dl>
        ) : null}

        {request.kind === 'WIKI_CREATE' ? <WikiCreateFacts request={request} /> : null}
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
            <>
              {removalToTell(grant) ? (
                <p className="owner-request-notice">{grantLine(grant!, runner, now)}</p>
              ) : null}
              <SecretEntry spec={request.secretSpec} runner={runner} draft={draft} onDraft={setDraft} />
            </>
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
        {translated.foot}

        {failed ? (
          <Alert type="error" title={`The key did not reach ${runner}`} description={grant.removalNote ?? 'Enter it again.'} />
        ) : null}
        {end.isError && answerRefusedUntranslated(end.error) && end.variables && end.variables.to !== 'create-wiki' && end.variables.to !== 'apply' ? (
          <RefusedAnswerFoot
            error={end.error}
            resend={(sendAsWritten) => {
              const ending = end.variables!;
              return end.mutateAsync(
                sendAsWritten ? ({ ...ending, body: { ...ending.body, sendAsWritten: true } } as Ending) : ending,
              );
            }}
          />
        ) : end.isError || door.failure ? (
          <Alert type="error" title="That was not recorded" description={door.failure ?? (end.error as Error).message} />
        ) : null}

        {request.kind === 'WIKI_CREATE' ? (
          <CardActions className="owner-request-actions">
            <CardActionButton
              tone="primary"
              disabled={end.isPending || closed}
              onClick={() => end.mutate({ to: 'create-wiki', body: {} })}
            >
              {PRIMARY.WIKI_CREATE}
            </CardActionButton>
            <CardActionButton disabled={end.isPending || closed} onClick={() => setChanging(true)}>
              {WIKI_CREATE_CHANGE_SETTINGS}
            </CardActionButton>
            {onChat && !closed ? (
              <CardActionButton onClick={() => onChat(request)}>{OWNER_SEND_BACK_ACTION}</CardActionButton>
            ) : null}
            <button
              type="button"
              className="owner-request-link owner-request-not-here"
              disabled={end.isPending || closed}
              onClick={() => end.mutate({ to: 'decline', body: { reason: WIKI_CREATE_NOT_HERE } })}
            >
              {WIKI_CREATE_NOT_HERE}
            </button>
            {changing ? <WikiCreateDialog workspaceId={request.workspaceId ?? null} onClose={() => setChanging(false)} /> : null}
          </CardActions>
        ) : request.kind === 'BROWSER_SIGN_IN' ? (
          // Open browser does not answer the card: Signed in is pressed in the browser tab, once the owner has.
          <CardActions className="owner-request-actions">
            <CardActionButton
              tone="primary"
              disabled={!request.browserRunnerId || closed}
              onClick={() => openRunnerBrowserTab(request.browserRunnerId!, true)}
            >
              {PRIMARY.BROWSER_SIGN_IN}
            </CardActionButton>
            <CardActionButton
              disabled={end.isPending || closed}
              onClick={() => end.mutate({ to: 'decline', body: { reason: BROWSER_SIGN_IN_COPY.notNow } })}
            >
              {BROWSER_SIGN_IN_COPY.notNow}
            </CardActionButton>
          </CardActions>
        ) : declining ? (
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
                {PRIMARY[request.kind as AgentRequestKind]}
              </CardActionButton>
            )}
            {onChat && !closed ? (
              <CardActionButton onClick={() => onChat(request)}>{OWNER_SEND_BACK_ACTION}</CardActionButton>
            ) : null}
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
  if (request.kind === 'BROWSER_SIGN_IN' && request.state === 'DECLINED') return BROWSER_SIGN_IN_COPY.notNow;
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
  if (request.kind === 'CHANGE' && request.changeSpec) {
    const { applied, actualBefore } = request.answer ?? {};
    const spec = request.changeSpec;
    return CHANGE_COPY.applied(runner, actualBefore ?? spec.before, applied ?? spec.requested, spec.requested);
  }
  if (request.kind === 'BROWSER_SIGN_IN') return BROWSER_SIGN_IN_COPY.signedIn(request.browserSite ?? '');
  if (request.kind === 'WIKI_CREATE') return request.answer?.name ? `Created the wiki ${request.answer.name}` : 'Wiki created';
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

/**
 * A removal the card must state on any request, not only a DONE one (design §6.1, §6.3, §6.4): one still pending, one
 * that ended without the runner ever confirming it (its runner was deleted after it fetched the key), and one the
 * runner confirmed with a note — a file it could not delete, or another file now standing at the path. A failed
 * delivery has an alert of its own on a pending card.
 */
function removalToTell(grant: OwnerRequestSecretGrant | null | undefined): boolean {
  if (!grant) return false;
  if (grant.state === 'REMOVING') return true;
  if (grant.state !== 'REMOVED' || grant.endReason === 'DELIVERY_FAILED') return false;
  return grant.endReason === 'RUNNER_DELETED' || Boolean(grant.removalNote?.trim());
}

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
    // The server's own unconfirmed-removal note says it all; a runner's note follows the reason.
    if (/^Removal unconfirmed/.test(grant.removalNote ?? '')) return grant.removalNote!;
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
export function OwnerRequestResolved({ request, now = Date.now() }: { request: OwnerRequest; now?: number }): JSX.Element {
  if (request.kind === 'SETTINGS_CHANGE' && (request.state === 'DONE' || request.state === 'DECLINED')) {
    return <SettingsChangeFolded request={request} />;
  }
  if (request.kind === 'PROJECT_REOPEN' && (request.state === 'DONE' || request.state === 'DECLINED')) {
    return <ProjectReopenFolded request={request} now={now} />;
  }
  return <AgentRequestResolved request={request} now={now} />;
}

function AgentRequestResolved({ request: given, now }: { request: OwnerRequest; now: number }): JSX.Element {
  const door = useSecretDoor(given);
  const request = door.current;
  // A delivered key's whole story on a DONE request; on any other ending, only a removal the owner must be told of —
  // pending, or never to be confirmed (§2, §6.1, §6.4) — so the card never implies gone while a copy may remain.
  const held = request.kind === 'SECRET' ? request.secretGrant : null;
  const grant = held && (request.state === 'DONE' || removalToTell(held)) ? held : null;
  const runner = useRunnerName(request.kind === 'SECRET' ? request.secretSpec?.runnerId : request.kind === 'CHANGE' ? request.changeSpec?.runnerId : undefined);
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
function ConversationRequest({ request, onChat }: { request: OwnerRequest; onChat?: ChatAbout }): JSX.Element {
  // A transcript only draws the requests its own session filed, so the card never names that session as the asker.
  const snoozes = useSnoozes();
  const now = Date.now();
  if (request.state !== 'PENDING') return <OwnerRequestResolved request={request} now={now} />;
  const until = snoozes[request.id] ?? 0;
  if (until > now) return <SnoozedRequest request={request} until={until} now={now} />;
  return <OwnerRequestCard request={request} now={now} onChat={onChat} viewedFromSessionId={request.askedBySessionId} />;
}

/**
 * This session's requests as transcript inserts, each where it was filed. Pending ones come from
 * their own read as well, so one older than the newest 200 of every state is still drawn.
 */
export function useSessionOwnerRequestInserts(
  sessionId: string | null | undefined,
  events: ReadonlyArray<{ seq: number; ts?: string }>,
  onChat?: ChatAbout,
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
            element: <ConversationRequest request={request} onChat={onChat} />,
          }];
    });
  }, [sessionId, events, open.data, all.data, onChat]);
}

/** One of this session's requests still waiting on its card, for the pinned strip to point at. */
export interface OwnerRequestPointer {
  id: string;
  /** The card's own title. */
  title: string;
  ageSeconds: number | null;
}

/**
 * The pending requests whose full card this conversation draws (`useSessionOwnerRequestInserts`),
 * oldest first: a snoozed one is drawn as a line and an ended one as its summary, so neither is a
 * card to go to (docs/mocks/owner-request-strip-jump). Same reads, so the strip and the cards agree.
 */
export function useSessionOwnerRequestPointers(sessionId: string | null | undefined): OwnerRequestPointer[] {
  const open = useQuery({ ...ownerRequestsQuery('open'), enabled: Boolean(sessionId) });
  const snoozes = useSnoozes();
  return useMemo(() => {
    if (!sessionId) return [];
    const now = Date.now();
    return (open.data?.requests ?? [])
      .filter((request) => sameResourceId(request.askedBySessionId, sessionId)
        && request.state === 'PENDING'
        && !((snoozes[request.id] ?? 0) > now)
        && Number.isFinite(Date.parse(request.createdAt)))
      .sort((x, y) => Date.parse(x.createdAt) - Date.parse(y.createdAt))
      .map((request) => ({
        id: request.id,
        title: request.title,
        ageSeconds: Math.max(0, Math.floor((now - Date.parse(request.createdAt)) / 1000)),
      }));
  }, [sessionId, open.data, snoozes]);
}

/** On a task a pending request holds up, wherever a task is listed or opened. */
export function WaitingOnYouTaskBadge({ taskId }: { taskId: string }): JSX.Element | null {
  const held = useQuery({
    ...ownerRequestsQuery('open'),
    select: (data) => isTaskHeld(data.requests, taskId),
  });
  return held.data ? <span className="owner-request-task-badge">{WAITING_ON_YOU}</span> : null;
}
