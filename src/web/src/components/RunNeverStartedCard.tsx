import { WarningFilled } from '@ant-design/icons';
import {
  dispatchRefusalNextStep,
  SOURCE_FIX_ACTIONS,
  SOURCE_REFUSAL_CODES,
  type SourceFixAction,
  type SourceRefusalCode,
} from '@orbit/shared';
import { dshRepair } from '../lib/dshRuntime';
import { ENGINE_CLI_NAME } from '../lib/runnerEngines';
import { sessionRetryPending, sessionRunStateOf, type SessionStateSource } from '../lib/sessionState';
import { sourceRefusalWhy } from '../lib/sourceRefusal';
import { FROM_ORBIT } from './ProjectProgressStatus';
import { antigravityRepair } from './Transcript';

/**
 * A run that never became one, as the card both kinds of session draw for it.
 *
 * THE FACT THIS COVERS. A session can hold a slot with nothing behind it: the runner refused the
 * start before any engine existed (its SOURCE would not resolve, or the machine cannot run the
 * engine at all), or the engine died before it read the message. On screen that used to be the
 * ordinary waiting notice — "Getting the session ready … usually seconds" — which is a promise the
 * wait will end. It does not: nothing is coming, and the reader is the only one who can change
 * that. So the transcript that will stay empty says why instead.
 *
 * ONE CARD, TWO CAUSE SETS. The chrome — the ⚠ head, "This run never started", FROM ORBIT, the two
 * buttons' shapes — is the same everywhere, because it is the same fact. What differs is where the
 * cause comes from. A session with a SOURCE reads the code, the ref and the runner's own words off
 * its own columns (`sourceState` REFUSED) and gets its next step from the SAME sentence the task's
 * timeline and the coordinator's message carry (`dispatchRefusalNextStep` in @orbit/shared). An
 * ordinary session has no such column, so its cause is read out of `session.error` — the vocabulary
 * the repair cards in the transcript already speak (runner-provider-support.ts's upgrade sentences,
 * `dshRepair` / `antigravityRepair`, the reaper's offline sentence). Not one of those sentences is
 * rewritten here: the card shows the server's words and only decides which of them apply.
 *
 * WHY THE DERIVATION IS NOT JSX. Which cause applies, and what the card should say about it, is a
 * decision about a session row — testable without a DOM, and it is the half a reviewer has to be
 * able to check against the contract (project-source-contract §6.1/§10.1 for the SOURCE half). The
 * component below only lays out what `runNeverStarted` returns.
 */

/** What the card is about, in the closed set the two cause sets give. */
export type NeverStartedCause =
  | 'SOURCE_REFUSED'
  | 'RUNNER_UPGRADE'
  | 'ENGINE_NOT_INSTALLED'
  | 'ENGINE_UNSUPPORTED'
  | 'ENGINE_SIGNED_OUT'
  | 'RUNNER_OFFLINE'
  | 'ENGINE_DIED';

/** The presses a card can offer. The host supplies the handler; an id it cannot perform is not drawn. */
export type NeverStartedActionId =
  | 'start-again'
  | 'send-again'
  | 'install'
  | 'open-providers'
  | 'open-runner'
  | 'chat-about';

/** The label each press wears — the repo's existing words, never a second spelling. */
export const NEVER_STARTED_ACTION_LABEL: Readonly<Record<NeverStartedActionId, string>> = {
  // SR34's recovery for a refused SOURCE is a NEW run of the task, which is what the task panel's
  // Run now does; on an ordinary session the conversation itself is resumable, so its message goes
  // again (the transcript's own retry, whose button this is).
  'start-again': 'Start it again',
  'send-again': 'Send it again',
  install: 'Install',
  'open-providers': 'Open Infrastructure',
  'open-runner': 'Open the runner',
  'chat-about': 'Chat about this',
};

export const NEVER_STARTED_TITLE = 'This run never started';

/**
 * The gate: this card is about a run whose ENGINE NEVER SPOKE.
 *
 * `engineStartedAt` is exactly that fact ("when the engine first spoke for the current run"), so a
 * failure the engine itself reported — a spent quota, a rejected key mid-turn — keeps the card it
 * already has (the transcript's, or the auto-retry one) and never this one. A session the runner
 * has not claimed at all (QUEUED) has not started either, and is in scope for the causes that stop
 * a claim happening at all (an engine this runner cannot run).
 */
function applies(
  session: NeverStartedSession & { engineStartedAt?: string | null },
): boolean {
  const state = sessionRunStateOf(session);
  if (state !== 'QUEUED' && state !== 'RUNNING' && state !== 'FAILED') return false;
  if (session.engineStartedAt != null) return false;
  return !sessionRetryPending(session);
}

/** A session row as this card reads it. Only what the two cause sets need. */
export interface NeverStartedSession extends SessionStateSource {
  taskId?: string | null;
  /** Turns this run completed — the "0 turns" in the card's foot, and the gate on the one cause
   *  that is read off nothing but silence. */
  numTurns?: number | null;
  /** The run's SOURCE, as the session detail carries it (`GET /sessions/:id` spreads the columns). */
  sourceState?: string | null;
  sourceRef?: string | null;
  sourceRefusalCode?: string | null;
  sourceRefusalDetail?: {
    /** §10.1's pairing, written by the control plane when it froze the refusal. */
    fixAction?: string;
    ref?: string;
    stderr?: string;
    reason?: string;
    [key: string]: unknown;
  } | null;
}

export interface NeverStartedFacts {
  cause: NeverStartedCause;
  /** What the run was pinned to, as `<code> · <ref>` — null when the refusal named neither. */
  subject: string | null;
  /** The machine's own words (git's stderr, the engine's startup line), when there are any. */
  detail: string | null;
  why: string;
  body: string | null;
  /** The one step that changes the answer, when a SOURCE refusal named one. */
  next: string | null;
  /** The presses this cause wants, best first. The host draws the ones it can perform. */
  actions: NeverStartedActionId[];
  foot: string;
}

export interface NeverStartedInput {
  session: NeverStartedSession & { engineStartedAt?: string | null };
  /** The engine that would execute this session — its own, recorded at its creation — for the
   *  engine-named sentences below. */
  runtime: string;
  /** The key the session runs on, as a sentence names it (`the DeepSeek key “DeepSeek 2”`,
   *  sessionProviderChoices' keyName), for the sentence about a key its vendor rejected. */
  keyName?: string | null;
  /** The machine, as the user named it — the repair cards' `runnerName`. */
  runnerName?: string | null;
}

/** The engine's product name, from the one table that keeps them (lib/runnerEngines). */
function engineName(runtime: string): string {
  return ENGINE_CLI_NAME[runtime as keyof typeof ENGINE_CLI_NAME] ?? 'this engine';
}

/** `refs/heads/x` as the second half of the subject line, whole: it is an address, not prose. */
const subjectLine = (code: string | null, ref: string | null): string | null => {
  const parts = [code, ref].filter((part): part is string => !!part);
  return parts.length > 0 ? parts.join(' · ') : null;
};

/** The machine's own words out of the runner's refusal detail — git's stderr first, its own
 *  sentence second, exactly as the apiserver's `refusalReason` reads them. */
function refusalDetailText(detail: NeverStartedSession['sourceRefusalDetail']): string | null {
  for (const value of [detail?.stderr, detail?.reason]) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

/** How the machine's causes read. Every sentence is one the repo or the design mock already
 *  carries — the repair card it comes from, or the mock whose wording it keeps, is named beside
 *  it; nothing here is copy written for this card alone. */
const MACHINE_COPY = {
  upgradeWhy: 'Waiting for a newer runner', // DshRepairCard / AntigravityRepairCard, updateRunner
  /** AntigravityRepairCard's updateRunner body's second sentence, with this card's one subject. */
  upgradeClause: 'The runner updates itself when no session is running on it, and this run starts then.',
  notInstalledBody: 'Install it from Infrastructure, then send your message again.', // both repair cards
  unsupportedWhy: (machine: string) => `DeepSeek Harness can’t run on ${machine}`, // DshRepairCard
  unsupportedBody:
    'DeepSeek Harness 0.2.0-rc.2 runs on Linux x64 runners with Node 26 only. Move this work to a runner that can.',
  dshKeyWhy: 'DeepSeek Harness needs a DeepSeek key', // DshRepairCard
  dshKeyBody: 'This session has no DeepSeek key to run on. Add or re-enable a DeepSeek key in Infrastructure, then send your message again.',
  dshBadKeyWhy: 'DeepSeek rejected this API key', // DshRepairCard
  /** DshRepairCard's, naming the key when the session's is known. */
  dshBadKeyBody: (keyName: string | null | undefined) =>
    `Update ${keyName ?? 'the DeepSeek key'} in Infrastructure, then send your message again.`,
  antigravityAuthWhy: 'Antigravity needs authentication', // AntigravityRepairCard
  antigravityAuthBody:
    'Sign in with Google on this runner, or connect a Gemini API key in Infrastructure.',
  offlineWhy: 'The runner holding this session went offline',
  offlineBody: (machine: string) =>
    `${machine} stopped reporting while this run was starting. Nothing was produced, and nothing was sent anywhere.`,
  offlineFoot: 'Disconnected — runner went offline', // WorkspaceView.tsx, failedTitle's words
  diedWhy: 'The engine died before it could read your message',
  diedBody:
    'The CLI exited on startup with no output. Retrying on this runner rarely helps; the runner’s own report says what it has.',
  waitingFoot: 'No engine ran · your message is still here',
  endedFoot: 'Ended · no engine ran · 0 turns',
} as const;

/** Sentences the machine writes when an engine cannot run at all, read BY PATTERN and never by
 *  copying the server's constants: the sentence the card shows is the server's own. */
const UPGRADE_SENTENCE = /requires (?:a newer |an? )?Orbit runner|update this runner first/i;
const NOT_INSTALLED_SENTENCE = /isn’t installed|isn't installed|not installed/i;
const SIGNED_OUT_SENTENCE = /needs authentication|failed to authenticate|signed out|not signed in/i;
const OFFLINE_SENTENCE = /offline/i;

/** §6.1's three resolved states — the ones a SOURCE refusal can be about (SR45's Legacy split). */
const RESOLVED_SOURCE_STATES = new Set(['SELECTED', 'PINNED', 'REFUSED']);

/**
 * The cause a run's own SOURCE gives, or null when this session's baseline was never refused.
 *
 * TWO SHAPES, ONE READING. A refusal at RESOLUTION leaves the session at REFUSED and carries the
 * code, the ref and the runner's words in its own columns. A refusal at the CHECKOUT arrives after
 * the pin froze, so the session's SOURCE state cannot hold it (§6.1's freeze guard) and the only
 * place it exists is the run's last words, written as `<CODE>: <reason>` (`readDispatchRefusal` in
 * tasks/task-dispatch-refusal.ts reads the same string off the same row). Both are the same fact to
 * this card, and the code decides which gate it stopped at — exactly as the task's own timeline
 * says it. The Legacy gate is the server's: a session with no resolved SOURCE never had one to
 * refuse, so an error that merely looks like a code is not read as one.
 */
function sourceRefused(session: NeverStartedSession, error: string): NeverStartedFacts | null {
  const said = /^([A-Z][A-Z_]+): ([\s\S]+)$/.exec(error);
  const byCode =
    said && RESOLVED_SOURCE_STATES.has(session.sourceState ?? '') && SOURCE_REFUSAL_CODES.includes(said[1] as SourceRefusalCode)
      ? { code: said[1] as SourceRefusalCode, reason: said[2]!.trim() }
      : null;
  if (session.sourceState !== 'REFUSED' && !byCode) return null;
  const detail = session.sourceRefusalDetail;
  const code = (session.sourceRefusalCode as SourceRefusalCode | null) ?? byCode?.code ?? null;
  const ref =
    session.sourceRef ?? (typeof detail?.ref === 'string' ? detail.ref : null);
  // The server's own pairing wins (it is the one that froze the refusal); the table it wrote that
  // from is the shared one, so the checkout shape — whose pairing only the task's record carries —
  // gets the same advice rather than a second, narrower mapping invented on this side.
  const fixAction: SourceFixAction | string | null =
    detail?.fixAction ?? (code ? SOURCE_FIX_ACTIONS[code] : null);
  return {
    cause: 'SOURCE_REFUSED',
    subject: subjectLine(code, ref),
    detail: refusalDetailText(detail) ?? byCode?.reason ?? null,
    why: sourceRefusalWhy(fixAction),
    body: null,
    next: fixAction ? dispatchRefusalNextStep({ fixAction, ref }) : null,
    actions: session.taskId ? ['start-again', 'chat-about'] : ['send-again', 'chat-about'],
    foot: sessionRunStateOf(session) === 'FAILED' ? MACHINE_COPY.endedFoot : MACHINE_COPY.waitingFoot,
  };
}

/**
 * The cause a session with no SOURCE refusal can still have, from `session.error`.
 *
 * The two engine-specific vocabularies are read by their own classifiers (`dshRepair`,
 * `antigravityRepair`) so nothing here re-decides which DSH code means what; the generic sentences
 * are recognised by pattern, because a runtime this build has never heard of can still report one.
 */
function machineCause(input: NeverStartedInput, error: string): NeverStartedFacts | null {
  const { session, runtime } = input;
  const machine = input.runnerName || 'this runner';
  const task = !!session.taskId;
  const dsh = runtime === 'dsh' ? dshRepair(error) : null;
  const antigravity = runtime === 'antigravity' ? antigravityRepair(error) : null;

  if (dsh === 'updateRunner' || antigravity === 'updateRunner' || UPGRADE_SENTENCE.test(error)) {
    return {
      cause: 'RUNNER_UPGRADE',
      subject: null,
      detail: null,
      why: MACHINE_COPY.upgradeWhy,
      // The waiting half says nothing is wrong with the work and nothing is being asked of the
      // reader — the one cause here whose recovery is a machine's own, on its own schedule.
      body: `${error} ${MACHINE_COPY.upgradeClause}`,
      next: null,
      actions: ['open-runner'],
      foot: MACHINE_COPY.waitingFoot,
    };
  }
  if (dsh === 'unsupportedPlatform') {
    return {
      cause: 'ENGINE_UNSUPPORTED',
      subject: null,
      detail: null,
      why: MACHINE_COPY.unsupportedWhy(machine),
      body: MACHINE_COPY.unsupportedBody,
      next: null,
      actions: ['open-runner'],
      foot: MACHINE_COPY.waitingFoot,
    };
  }
  if (dsh === 'needsKey' || dsh === 'invalidKey') {
    const bad = dsh === 'invalidKey';
    return {
      cause: 'ENGINE_SIGNED_OUT',
      subject: null,
      detail: null,
      why: bad ? MACHINE_COPY.dshBadKeyWhy : MACHINE_COPY.dshKeyWhy,
      body: bad ? MACHINE_COPY.dshBadKeyBody(input.keyName) : MACHINE_COPY.dshKeyBody,
      next: null,
      actions: ['open-providers', task ? 'start-again' : 'send-again'],
      foot: MACHINE_COPY.waitingFoot,
    };
  }
  if (antigravity === 'needsKey' || SIGNED_OUT_SENTENCE.test(error)) {
    return {
      cause: 'ENGINE_SIGNED_OUT',
      subject: null,
      detail: null,
      why:
        antigravity === 'needsKey'
          ? MACHINE_COPY.antigravityAuthWhy
          : `${engineName(runtime)} needs authentication`,
      body: antigravity === 'needsKey' ? MACHINE_COPY.antigravityAuthBody : error,
      next: null,
      actions: ['open-providers', task ? 'start-again' : 'send-again'],
      foot: MACHINE_COPY.waitingFoot,
    };
  }
  if (dsh === 'notInstalled' || antigravity === 'notInstalled' || NOT_INSTALLED_SENTENCE.test(error)) {
    return {
      cause: 'ENGINE_NOT_INSTALLED',
      subject: null,
      detail: null,
      // Both repair cards name the machine this way; "on this runner" is the fallback for a
      // session whose runner the caller could not name.
      why: `${engineName(runtime)} isn’t installed on ${machine}`,
      body: MACHINE_COPY.notInstalledBody,
      next: null,
      // The install is a machine's engine-row press, and only the host knows whether it can make
      // one for this engine — an id it cannot perform draws no button at all.
      actions: ['install', 'open-runner'],
      foot: MACHINE_COPY.waitingFoot,
    };
  }
  if (OFFLINE_SENTENCE.test(error)) {
    return {
      cause: 'RUNNER_OFFLINE',
      subject: null,
      detail: null,
      why: MACHINE_COPY.offlineWhy,
      body: MACHINE_COPY.offlineBody(machine),
      next: null,
      actions: task ? ['start-again', 'open-runner'] : ['send-again', 'open-runner'],
      foot: MACHINE_COPY.offlineFoot,
    };
  }
  // Nothing named a cause and the run is over: the engine was started and never said anything.
  // Claimed only for a run that produced no turn at all, which is what makes "died before it could
  // read your message" a fact rather than a reading of the silence.
  if (sessionRunStateOf(session) === 'FAILED' && (session.numTurns ?? 0) === 0) {
    return {
      cause: 'ENGINE_DIED',
      subject: null,
      detail: error || null,
      why: MACHINE_COPY.diedWhy,
      body: error ? null : MACHINE_COPY.diedBody,
      next: null,
      actions: task ? ['start-again', 'open-runner'] : ['send-again', 'open-runner'],
      foot: MACHINE_COPY.endedFoot,
    };
  }
  return null;
}

/**
 * The card for a session whose run never became one, or null when this session is not that.
 *
 * Order is the whole of the discrimination: a refused SOURCE is a fact about THIS run and outranks
 * anything the error line says; with no refusal, the cause has to come from the machine, and only
 * for a run whose engine never spoke (see `applies`).
 */
export function runNeverStarted(input: NeverStartedInput): NeverStartedFacts | null {
  const error = typeof input.session.error === 'string' ? input.session.error.trim() : '';
  const refused = sourceRefused(input.session, error);
  if (refused) return refused;
  if (!applies(input.session)) return null;
  // Nothing failed and nothing said why: a session merely waiting to be claimed is not a story, and
  // this card would be inventing one. Failed with no words at all IS the story (the engine exited
  // before it said anything), and only that case is read below.
  if (error === '' && sessionRunStateOf(input.session) !== 'FAILED') return null;
  return machineCause(input, error);
}

export interface NeverStartedActions {
  startAgain?: () => void;
  sendAgain?: () => void;
  install?: () => void;
  openProviders?: () => void;
  openRunner?: () => void;
  chatAbout?: () => void;
  /** A press is already in flight, so none of them is offered twice. */
  busy?: boolean;
}

function CardButton({
  id,
  onClick,
  disabled,
  primary,
}: {
  id: NeverStartedActionId;
  onClick: () => void;
  disabled: boolean;
  primary: boolean;
}) {
  return (
    <button
      type="button"
      className={primary ? 'chat-authfix-go' : 'chat-authfix-retry'}
      data-action={id}
      onClick={onClick}
      disabled={disabled}
    >
      {NEVER_STARTED_ACTION_LABEL[id]}
    </button>
  );
}

/**
 * The card itself. The host hands it the handlers it can perform; an action with no handler is not
 * drawn, because a press that goes nowhere is worse than no press. The first action it can draw is
 * the filled one — the press this cause actually wants — and the rest are the ways out beside it.
 */
export function RunNeverStartedCard({
  never,
  actions,
}: {
  never: NeverStartedFacts;
  actions: NeverStartedActions;
}) {
  const handlers: Record<NeverStartedActionId, (() => void) | undefined> = {
    'start-again': actions.startAgain,
    'send-again': actions.sendAgain,
    install: actions.install,
    'open-providers': actions.openProviders,
    'open-runner': actions.openRunner,
    'chat-about': actions.chatAbout,
  };
  const drawable = never.actions.filter((id) => handlers[id]);
  const primary = drawable[0];
  return (
    <div className="chat-authfix" data-run-never-started={never.cause}>
      <div className="chat-authfix-head">
        <WarningFilled className="chat-authfix-icon" />
        <div className="chat-authfix-title">{NEVER_STARTED_TITLE}</div>
        <span className="criteria-provenance prov-neutral">{FROM_ORBIT}</span>
      </div>
      <div className="chat-authfix-desc run-never-started-why">{never.why}</div>
      {never.body ? <div className="chat-authfix-desc">{never.body}</div> : null}
      {never.subject ? (
        <div className="chat-authfix-msg run-never-started-subject">{never.subject}</div>
      ) : null}
      {never.detail ? <div className="chat-authfix-last">{never.detail}</div> : null}
      {never.next ? (
        <div className="chat-authfix-desc run-never-started-next">{never.next}</div>
      ) : null}
      {drawable.length > 0 ? (
        <div className="chat-authfix-actions">
          {drawable.map((id) => (
            <CardButton
              key={id}
              id={id}
              onClick={handlers[id]!}
              disabled={!!actions.busy}
              primary={id === primary}
            />
          ))}
        </div>
      ) : null}
      <div className="chat-authfix-msg run-never-started-foot">{never.foot}</div>
    </div>
  );
}
