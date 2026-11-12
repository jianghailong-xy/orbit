import { CheckCircleFilled, DesktopOutlined } from '@ant-design/icons';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { LoginEngine } from '@orbit/shared';
import { queuedTurnEvent } from '../lib/acceptedUserTurn';
import type { CursorRunnerFacts } from '../lib/cursorRuntime';
import { encodeId } from '../lib/idCodec';
import {
  answersDirProbe,
  defaultFolderChoice,
  firstEngineOn,
  folderName,
  folderVerdict,
  installedLogins,
  isConnecting,
  isOfferedFolder,
  isValidNewFolder,
  makesNewFolders,
  machineName,
  newFolderPath,
  newFolderPick,
  newFolderVerdict,
  registerDirToProbe,
  updatesItself,
  type FolderChoice,
  type PickedFolder,
} from '../lib/machineSetup';
import {
  HELD_SENDING,
  HELD_TRY_AGAIN,
  HELD_WITHDRAW,
  SETUP_CHANGE,
  SETUP_CHECK_AGAIN,
  SETUP_FOLDER,
  SETUP_FOOT,
  SETUP_LEAD,
  SETUP_NEW_FOLDER,
  SETUP_NEW_FOLDER_DONE,
  SETUP_NEW_FOLDER_INVALID,
  SETUP_NEW_FOLDER_META,
  SETUP_NEW_FOLDER_NAME,
  SETUP_ON_A_KEY,
  SETUP_ON_A_POOL,
  SETUP_OPEN_MACHINE,
  SETUP_REGISTER_DIR,
  SETUP_SIGN_IN_HELP,
  SETUP_USE_FOLDER,
  heldFailed,
  heldWaiting,
  setupChecking,
  setupConnecting,
  setupFolderHelp,
  setupNeedsUpdate,
  setupNoAnswer,
  setupNotInstalled,
  setupOffline,
  setupOtherFolder,
  setupReady,
  setupSignIn,
  setupSignedIn,
  setupTitle,
  setupUpdating,
  setupUseEngine,
} from '../lib/machineSetupCopy';
import type { ProviderChoice } from '../lib/sessionProviderChoices';
import { useDirProbe } from '../lib/useDirProbe';
import type { HeldMessage } from '../lib/useMachineSetup';
import { webShowsEngine } from '../lib/runnerEngines';
import { isLoginProvider } from '../lib/workspaceDefaults';
import { ENGINE_NAME, probeReportsSignedIn, RunnerSignIn } from './RunnerSignIn';
import type { Runner } from './TasksSidePanel';
import { QueuedUserTurn } from './Transcript';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { Radio, RadioGroup } from './ui/Radio';
import { WelcomeExamples, WelcomeHead } from './WelcomeCard';
import './MachineSetupCard.css';

const TYPED_PATH_SETTLE_MS = 400;

/** The second step's answer for the draft's engine and credential. */
export type SetupCredential =
  | { step: 'signedIn' }
  /** A login that isn't signed in here: RunnerSignIn. */
  | { step: 'signIn' }
  | { step: 'notInstalled' }
  /** A key or a pool: nothing to sign in on this machine. */
  | { step: 'onKey'; label: string; pool: boolean };

export function setupCredentialOf(
  runner: Pick<Runner, 'id' | 'engines'>,
  engine: string,
  provider: Pick<ProviderChoice, 'kind' | 'label'> | null | undefined,
): SetupCredential {
  if (provider && provider.kind !== 'login') {
    return { step: 'onKey', label: provider.label, pool: provider.kind === 'pool' };
  }
  if (probeReportsSignedIn([runner], runner.id, engine as LoginEngine)) return { step: 'signedIn' };
  // Nothing reported is not "nothing installed": a machine that has only just come up says soon.
  if (runner.engines && !runner.engines.find((e) => e.engine === engine)?.installed) return { step: 'notInstalled' };
  return { step: 'signIn' };
}

const engineName = (engine: string): string => ENGINE_NAME[engine as LoginEngine] ?? engine;

/** A check the machine gave no answer to, and the way to ask it again. */
function NoAnswer({ machine, onAgain }: { machine: string; onAgain: () => void }) {
  return (
    <span className="msc-verdict bad">
      {setupNoAnswer(machine)}{' '}
      <button className="msc-change" type="button" onClick={onAgain}>
        {SETUP_CHECK_AGAIN}
      </button>
    </span>
  );
}

/** What is typed, once the typing has stopped for a moment: what the machine is asked about. */
function useSettled(value: string): string {
  const [settled, setSettled] = useState('');
  useEffect(() => {
    const settle = setTimeout(() => setSettled(value), TYPED_PATH_SETTLE_MS);
    return () => clearTimeout(settle);
  }, [value]);
  return settled;
}

/** Step one before it has an answer: the folder `orbit register` ran in when that is a fair suggestion,
 *  a new folder, or any other, which the machine itself checks as it is typed. */
function FolderOptions({
  runner,
  disabled,
  onPick,
}: {
  runner: Runner;
  disabled: boolean;
  onPick: (folder: PickedFolder) => void;
}) {
  const machine = machineName(runner);
  const online = runner.online === true;
  const probes = answersDirProbe(runner);
  const registerDir = probes ? registerDirToProbe(runner.registerDir) : undefined;
  // Offline it can't be asked, and what it last answered is still worth showing.
  const registered = useDirProbe(runner.id, registerDir, online);
  const suggested = registered.state === 'answered' && isOfferedFolder(registered.probe) ? registered.probe : null;
  const offersNewFolder = makesNewFolders(runner);
  const reposRoot = runner.reposRoot ?? '';

  // Untouched, the choice follows what the machine says: its answer about the register directory can
  // arrive a heartbeat after the card does.
  const [touched, setTouched] = useState<FolderChoice | null>(null);
  const choice = touched ?? defaultFolderChoice(suggested, offersNewFolder);
  const [newName, setNewName] = useState('');
  const name = newName.trim();
  const settledName = useSettled(name);
  // A new folder's name is asked about where it would go: a folder, or a file, may be there already.
  const newProbe = useDirProbe(
    runner.id,
    choice === 'new' && offersNewFolder && !disabled && isValidNewFolder(settledName)
      ? newFolderPath(reposRoot, settledName)
      : undefined,
    true,
  );
  const found = settledName === name && newProbe.state === 'answered' ? newProbe.probe : null;
  const newVerdict = found ? newFolderVerdict(found, machine) : null;
  const [typed, setTyped] = useState('');
  const path = typed.trim();
  const settled = useSettled(path);
  const typedProbe = useDirProbe(runner.id, choice === 'other' && !disabled && settled ? settled : undefined, true);
  const checked = settled === path && typedProbe.state === 'answered' ? typedProbe.probe : null;
  const verdict = checked ? folderVerdict(checked, machine) : null;

  // The machine holds one question at a time (contract §2): a path asked before it had answered about the
  // register directory took that question's place, and the suggestion would never come. It is asked again
  // once nothing else on this card is waiting for an answer.
  const askRegisteredAgain =
    registered.state === 'idle' && !!registerDir && online && typedProbe.state !== 'checking' && newProbe.state !== 'checking';
  const registeredAgain = registered.again;
  useEffect(() => {
    if (askRegisteredAgain) registeredAgain();
  }, [askRegisteredAgain, registeredAgain]);

  let candidate: PickedFolder | null = null;
  if (choice === 'suggested' && suggested) {
    candidate = { kind: 'existing', path: suggested.path, note: folderVerdict(suggested, machine).short };
  } else if (choice === 'new' && offersNewFolder && isValidNewFolder(name) && found) {
    candidate = newFolderPick(found, name, reposRoot, machine);
  } else if (choice === 'other' && checked && verdict?.usable) {
    candidate = { kind: 'existing', path: checked.path, note: verdict.short };
  }

  // The field's keys stay its own (a radio group takes the arrows), and Enter is the button beside it.
  const onFieldKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter' && candidate) onPick(candidate);
  };
  const suggestion = suggested && folderVerdict(suggested, machine);
  return (
    <>
      <div className="msc-step-title">{SETUP_FOLDER}</div>
      <div className="msc-step-help">{setupFolderHelp(machine)}</div>
      <RadioGroup<FolderChoice> className="msc-options" value={choice} onValueChange={setTouched} disabled={disabled}>
        {suggested && suggestion && (
          <Radio value="suggested" className="msc-option">
            <span className="msc-path">{suggested.path}</span>
            <span className={`msc-verdict ${suggestion.tone}`}>{suggestion.text}</span>
            <span className="msc-meta">{SETUP_REGISTER_DIR}</span>
          </Radio>
        )}
        {offersNewFolder && (
          <Radio value="new" className="msc-option">
            <span className="msc-option-title">{SETUP_NEW_FOLDER}</span>
            {choice === 'new' && (
              <Input
                className="msc-input"
                size="small"
                prefix={<span className="msc-prefix">{newFolderPath(runner.reposRoot ?? '', '')}</span>}
                placeholder={SETUP_NEW_FOLDER_NAME}
                aria-label={SETUP_NEW_FOLDER}
                value={newName}
                disabled={disabled}
                autoFocus={touched === 'new'}
                // Typing here is a choice, which a late answer about the register directory must not undo.
                onChange={(e) => {
                  setTouched('new');
                  setNewName(e.target.value);
                }}
                onKeyDown={onFieldKey}
                invalid={!!name && !isValidNewFolder(name)}
              />
            )}
            {choice !== 'new' || !name ? (
              <span className="msc-meta">{SETUP_NEW_FOLDER_META}</span>
            ) : !isValidNewFolder(name) ? (
              <span className="msc-verdict bad">{SETUP_NEW_FOLDER_INVALID}</span>
            ) : newVerdict ? (
              // Nothing there yet reads as the board draws a new folder; anything there says what it means.
              <span className={newVerdict.tone === 'ok' ? 'msc-meta' : `msc-verdict ${newVerdict.tone}`}>{newVerdict.text}</span>
            ) : settledName === name && (newProbe.state === 'unanswered' || newProbe.state === 'idle') ? (
              <NoAnswer machine={machine} onAgain={newProbe.again} />
            ) : (
              <span className="msc-verdict wait">{setupChecking(machine)}</span>
            )}
          </Radio>
        )}
        <Radio value="other" className="msc-option">
          <span className="msc-option-title">{setupOtherFolder(machine)}</span>
          {choice === 'other' && (
            <>
              <Input
                className="msc-input msc-path-input"
                size="small"
                placeholder="/path/to/project"
                aria-label={setupOtherFolder(machine)}
                value={typed}
                disabled={disabled}
                autoFocus={touched === 'other'}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={onFieldKey}
              />
              {path && (verdict ? (
                <span className={`msc-verdict ${verdict.tone}`}>{verdict.text}</span>
              ) : settled === path && (typedProbe.state === 'unanswered' || typedProbe.state === 'idle') ? (
                <NoAnswer machine={machine} onAgain={typedProbe.again} />
              ) : (
                <span className="msc-verdict wait">{setupChecking(machine)}</span>
              ))}
            </>
          )}
        </Radio>
      </RadioGroup>
      <Button
        className="msc-use"
        variant="primary"
        size="small"
        disabled={!candidate || disabled}
        onClick={() => candidate && onPick(candidate)}
      >
        {SETUP_USE_FOLDER}
      </Button>
    </>
  );
}

/**
 * A machine with no workspace, on its new session page, where the engine hero stands for a machine
 * that has one. It asks the two things only the owner can answer: the folder sessions may read and
 * change, and the coding CLI they run on (board rules 1–5). The folder and the engine belong to the
 * page, which sends with them: this card only shows them and takes the answers.
 */
export function MachineSetupCard({
  runner,
  fleet,
  engine,
  credential,
  folder,
  ready,
  onFolder,
  onEngine,
  onUseApiKey,
  welcome,
}: {
  runner: Runner;
  /** Every runner of the account, which decides whether Cursor CLI is drawn at all (webShowsEngine). */
  fleet: readonly CursorRunnerFacts[] | null;
  /** The engine the draft runs on, which the composer's picks follow too. */
  engine: string;
  credential: SetupCredential;
  folder: PickedFolder | null;
  /** Both steps are done and the machine is here: the next send makes the workspace. */
  ready: boolean;
  onFolder: (folder: PickedFolder | null) => void;
  /** Run on this engine's own sign-in instead, which is also how a key is left again. */
  onEngine: (engine: LoginEngine) => void;
  onUseApiKey: () => void;
  /** A new account's first machine (docs/mocks/new-user-onboarding): the card greets it, and offers
   *  first messages to try, which fill the page's composer. */
  welcome?: { composerText: string; onExample: (text: string) => void };
}) {
  const machine = machineName(runner);
  const offline = runner.online !== true;
  const probes = answersDirProbe(runner);
  const name = engineName(engine);
  const others = installedLogins(runner.engines).filter((e) => e !== engine && webShowsEngine(e, fleet));
  const done = credential.step === 'signedIn' || credential.step === 'onKey';

  const alternatives = others.length > 0 && (
    <div className="msc-alt">
      {others.map((other, i) => (
        <span key={other}>
          {i > 0 && ' · '}
          <button className="msc-change" type="button" disabled={offline} onClick={() => onEngine(other)}>
            {setupUseEngine(engineName(other))}
          </button>
        </span>
      ))}
    </div>
  );

  return (
    <div className="msc">
      {welcome ? (
        <WelcomeHead />
      ) : (
        <div className="msc-head">
          <span className="msc-head-icon">
            <DesktopOutlined aria-hidden="true" />
          </span>
          <div>
            <div className="msc-title">{setupTitle(machine)}</div>
            <div className="msc-sub">{SETUP_LEAD}</div>
          </div>
        </div>
      )}

      {offline ? (
        // Never heard from is a machine still coming up, not one gone away; and with nothing declared yet, not
        // one too old to check folders either.
        <div className="msc-notice">{isConnecting(runner) ? setupConnecting(machine) : setupOffline(machine)}</div>
      ) : (
        !probes && (
          <div className="msc-notice">
            {updatesItself(runner) ? (
              setupUpdating(machine)
            ) : (
              <>
                {setupNeedsUpdate(machine)} <Link to={`/settings/machines/${encodeId(runner.id)}`}>{SETUP_OPEN_MACHINE}</Link>
              </>
            )}
          </div>
        )
      )}

      <div className="msc-step" data-step="folder">
        {folder ? <CheckCircleFilled className="msc-num done" /> : <span className="msc-num">1</span>}
        <div>
          {folder ? (
            <div className="msc-done-line">
              <span className="msc-step-title">{SETUP_FOLDER}</span>
              <span className="msc-path">{folder.path}</span>
              <span className="msc-meta">{folder.kind === 'new' ? SETUP_NEW_FOLDER_DONE : folder.note}</span>
              <button className="msc-change" type="button" disabled={offline} onClick={() => onFolder(null)}>
                {SETUP_CHANGE}
              </button>
            </div>
          ) : (
            <FolderOptions runner={runner} disabled={offline || !probes} onPick={onFolder} />
          )}
        </div>
      </div>

      <div className="msc-step" data-step="engine">
        {done ? <CheckCircleFilled className="msc-num done" /> : <span className="msc-num">2</span>}
        <div>
          {credential.step === 'signedIn' ? (
            <div className="msc-done-line">
              <span className="msc-step-title">{name}</span>
              <span className="msc-meta">{setupSignedIn(machine)}</span>
            </div>
          ) : credential.step === 'onKey' ? (
            <div className="msc-done-line">
              <span className="msc-step-title">{credential.label}</span>
              <span className="msc-meta">{credential.pool ? SETUP_ON_A_POOL : SETUP_ON_A_KEY}</span>
              <button
                className="msc-change"
                type="button"
                disabled={offline}
                // Back to a sign-in: this engine's, or for one that has none, the machine's first.
                onClick={() => onEngine(isLoginProvider(engine) ? (engine as LoginEngine) : firstEngineOn(runner.engines))}
              >
                {SETUP_CHANGE}
              </button>
            </div>
          ) : (
            <>
              <div className="msc-step-title">{setupSignIn(name, machine)}</div>
              <div className="msc-step-help">{SETUP_SIGN_IN_HELP}</div>
              {credential.step === 'notInstalled' ? (
                <div className="msc-step-help msc-not-installed">
                  {setupNotInstalled(name, machine)}{' '}
                  <Link to={`/settings/machines/${encodeId(runner.id)}`}>{SETUP_OPEN_MACHINE}</Link>
                </div>
              ) : (
                !offline && (
                  <RunnerSignIn key={engine} runnerId={runner.id} engine={engine as LoginEngine} onUseApiKey={onUseApiKey} />
                )
              )}
              {alternatives}
            </>
          )}
        </div>
      </div>

      {welcome && <WelcomeExamples step={3} picked={welcome.composerText} onPick={welcome.onExample} />}

      <div className={`msc-foot${ready ? ' ready' : ''}`}>
        {ready && folder
          ? setupReady(folder.kind === 'new' ? folder.name : folderName(folder.path), folder.path)
          : SETUP_FOOT}
      </div>
    </div>
  );
}

/** Brought into view as it appears: what lands under the card can land below the fold, and this pane
 *  has no tail to follow. Clear of the pane's fade (`.msc-revealed`), and again as a picture in it loads,
 *  which pushes its end back down. */
export function RevealedOnArrival({ className, children }: { className?: string; children: ReactNode }) {
  const arrived = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = arrived.current;
    if (!element) return;
    // Not an expression body: a browser may answer with a promise, which React would take for a cleanup.
    const reveal = () => {
      element.scrollIntoView({ block: 'nearest' });
    };
    reveal();
    // An image's `load` doesn't bubble, but it is seen on its way down to the image.
    element.addEventListener('load', reveal, true);
    return () => element.removeEventListener('load', reveal, true);
  }, []);
  return (
    <div ref={arrived} className={className ? `msc-revealed ${className}` : 'msc-revealed'}>
      {children}
    </div>
  );
}

/**
 * The first message, waiting under the card for both steps: the bubble it will be, with what it is
 * waiting for beneath it and the way to take it back (board rule 6). It goes by itself; only a refusal
 * stops it, and then it stays here, saying why, until it is tried again or taken back.
 */
export function HeldFirstMessage({
  held,
  machine,
  sending,
  onWithdraw,
  onRetry,
}: {
  held: HeldMessage;
  machine: string;
  sending: boolean;
  onWithdraw: () => void;
  onRetry: () => void;
}) {
  const event = useMemo(
    () =>
      queuedTurnEvent({
        turnId: 'held-first-message',
        content: held.content,
        shell: held.shell,
        attachments: held.attachments?.map(({ id, mime }) => ({ id, mimeType: mime })),
      }),
    [held],
  );
  return (
    <RevealedOnArrival className="msc-held">
      <QueuedUserTurn event={event} queued={null} />
      <div className="msc-held-state">
        {sending ? (
          HELD_SENDING
        ) : (
          <>
            {held.error ? (
              <>
                <span className="msc-held-error">{heldFailed(held.error)}</span> ·{' '}
                <button className="msc-change" type="button" onClick={onRetry}>
                  {HELD_TRY_AGAIN}
                </button>
              </>
            ) : (
              heldWaiting(machine)
            )}{' '}
            ·{' '}
            <button className="msc-change" type="button" onClick={onWithdraw}>
              {HELD_WITHDRAW}
            </button>
          </>
        )}
      </div>
    </RevealedOnArrival>
  );
}
