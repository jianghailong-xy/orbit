import { CheckCircleFilled, DesktopOutlined } from '@ant-design/icons';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { LoginEngine } from '@orbit/shared';
import type { CursorRunnerFacts } from '../lib/cursorRuntime';
import { encodeId } from '../lib/idCodec';
import {
  answersDirProbe,
  firstEngineOn,
  installedLogins,
  isConnecting,
  isValidNewFolder,
  makesNewFolders,
  machineName,
  newFolderPath,
  newFolderPick,
  newFolderRootOf,
  newFolderVerdict,
  newWorkspaceName,
  updatesItself,
  type PickedFolder,
} from '../lib/machineSetup';
import {
  SETUP_CHANGE,
  SETUP_CHECK_AGAIN,
  SETUP_CREATE,
  SETUP_FOLDER,
  SETUP_FOOT_CREATE,
  SETUP_LEAD_CREATE,
  SETUP_NEW_FOLDER_DONE,
  SETUP_NEW_FOLDER_INVALID,
  SETUP_FOLDER_HINT,
  SETUP_NEW_FOLDER_NAME,
  SETUP_ON_A_KEY,
  SETUP_ON_A_POOL,
  SETUP_OPEN_MACHINE,
  SETUP_SIGN_IN_HELP,
  SETUP_USE_FOLDER,
  setupChecking,
  setupConnecting,
  setupCreateFailed,
  setupFolderHelp,
  setupNeedsUpdate,
  setupNoAnswer,
  setupNotInstalled,
  setupOffline,
  setupReadyCreate,
  setupSignIn,
  setupSignedIn,
  setupTitle,
  setupUpdating,
  setupUseEngine,
} from '../lib/machineSetupCopy';
import type { ProviderChoice } from '../lib/sessionProviderChoices';
import { useDirProbe } from '../lib/useDirProbe';
import { webShowsEngine } from '../lib/runnerEngines';
import { isLoginProvider } from '../lib/workspaceDefaults';
import { ENGINE_NAME, probeReportsSignedIn, RunnerSignIn } from './RunnerSignIn';
import type { Runner } from './TasksSidePanel';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { WelcomeHead } from './WelcomeCard';
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

/** Step one before it has an answer: one folder name in the machine's home (its Repos Folder on an older runner),
 *  which the machine itself checks as it is typed. A folder that is there is used; one that isn't is made. */
function FolderName({
  runner,
  disabled,
  onPick,
}: {
  runner: Runner;
  disabled: boolean;
  onPick: (folder: PickedFolder) => void;
}) {
  const machine = machineName(runner);
  const root = newFolderRootOf(runner);
  const [typed, setTyped] = useState('');
  const name = typed.trim();
  const settledName = useSettled(name);
  // The name is asked about where it would go: a folder, or a file, may be there already.
  const probe = useDirProbe(
    runner.id,
    !disabled && isValidNewFolder(settledName) ? newFolderPath(root, settledName) : undefined,
    true,
  );
  const found = settledName === name && probe.state === 'answered' ? probe.probe : null;
  const verdict = found ? newFolderVerdict(found, machine) : null;
  const candidate = found && isValidNewFolder(name) ? newFolderPick(found, name, root, machine) : null;

  const onFieldKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && candidate) onPick(candidate);
  };
  return (
    <>
      <div className="msc-step-title">{SETUP_FOLDER}</div>
      <div className="msc-step-help">{setupFolderHelp(machine)}</div>
      <div className="msc-folder">
      <Input
        className="msc-input"
        size="small"
        prefix={<span className="msc-prefix">{newFolderPath(root, '')}</span>}
        placeholder={SETUP_NEW_FOLDER_NAME}
        aria-label={SETUP_FOLDER}
        value={typed}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setTyped(e.target.value)}
        onKeyDown={onFieldKey}
        invalid={!!name && !isValidNewFolder(name)}
      />
      {!name ? (
        <span className="msc-meta">{SETUP_FOLDER_HINT}</span>
      ) : !isValidNewFolder(name) ? (
        <span className="msc-verdict bad">{SETUP_NEW_FOLDER_INVALID}</span>
      ) : verdict ? (
        // Nothing there yet reads as a note; anything there says what it is.
        <span className={found?.exists ? `msc-verdict ${verdict.tone}` : 'msc-meta'}>{verdict.text}</span>
      ) : settledName === name && (probe.state === 'unanswered' || probe.state === 'idle') ? (
        <NoAnswer machine={machine} onAgain={probe.again} />
      ) : (
        <span className="msc-verdict wait">{setupChecking(machine)}</span>
      )}
      </div>
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
 * A machine with no workspace, on its new session page, which it fills alone: no session list beside it
 * and no composer under it (owner 2026-11-16). It asks the two things only the owner can answer: the
 * folder sessions may read and change, and the coding CLI they run on (board rules 1–5), and once both
 * are answered its button makes the workspace. The folder and the engine belong to the page, which
 * makes the workspace with them: this card only shows them and takes the answers.
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
  onCreate,
  creating,
  createError,
  welcome,
}: {
  runner: Runner;
  /** Every runner of the account, which decides whether Cursor CLI is drawn at all (webShowsEngine). */
  fleet: readonly CursorRunnerFacts[] | null;
  /** The engine the draft runs on, which the composer's picks follow too. */
  engine: string;
  credential: SetupCredential;
  folder: PickedFolder | null;
  /** Both steps are done and the machine is here: Create workspace makes it. */
  ready: boolean;
  onFolder: (folder: PickedFolder | null) => void;
  /** Run on this engine's own sign-in instead, which is also how a key is left again. */
  onEngine: (engine: LoginEngine) => void;
  onUseApiKey: () => void;
  onCreate: () => void;
  /** The workspace is being made: the button waits. */
  creating: boolean;
  /** Why the last Create workspace was refused, said on the card until the next try. */
  createError: string | null;
  /** A new account's first machine (docs/mocks/new-user-onboarding): the card greets it. */
  welcome?: boolean;
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
            <div className="msc-sub">{SETUP_LEAD_CREATE}</div>
          </div>
        </div>
      )}

      {offline ? (
        // Never heard from is a machine still coming up, not one gone away; and with nothing declared yet, not
        // one too old to check folders either.
        <div className="msc-notice">{isConnecting(runner) ? setupConnecting(machine) : setupOffline(machine)}</div>
      ) : (
        !(probes && makesNewFolders(runner)) && (
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
            <FolderName runner={runner} disabled={offline || !probes || !makesNewFolders(runner)} onPick={onFolder} />
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

      <div className={`msc-foot${ready ? ' ready' : ''}`}>
        {ready && folder
          ? setupReadyCreate(newWorkspaceName(folder), folder.path)
          : SETUP_FOOT_CREATE}
      </div>
      {createError && <div className="msc-create-error">{setupCreateFailed(createError)}</div>}
      <div className="msc-create">
        <Button variant="primary" disabled={!ready} loading={creating} onClick={onCreate}>
          {SETUP_CREATE}
        </Button>
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
