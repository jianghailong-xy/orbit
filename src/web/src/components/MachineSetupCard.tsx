import { DesktopOutlined } from '@ant-design/icons';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { MANAGED_RUNNER_COPY, MANAGED_RUNNER_REPOS_ROOT, managedSetupState, type LoginEngine } from '@orbit/shared';
import { encodeId } from '../lib/idCodec';
import type { ManagedRunner } from '../lib/managedRunner';
import {
  answersDirProbe,
  isConnecting,
  isValidNewFolder,
  makesNewFolders,
  machineName,
  newFolderPath,
  newFolderPick,
  newFolderRootOf,
  newFolderVerdict,
  updatesItself,
  type PickedFolder,
} from '../lib/machineSetup';
import {
  SETUP_CHECK_AGAIN,
  SETUP_CREATE,
  SETUP_FOLDER,
  SETUP_FOLDER_HINT,
  SETUP_NAME,
  SETUP_NAME_EDITED,
  SETUP_NAME_EMPTY,
  SETUP_NAME_HINT,
  SETUP_NAME_PLACEHOLDER,
  SETUP_NEW_FOLDER_INVALID,
  SETUP_NEW_FOLDER_NAME,
  SETUP_NEW_FOLDER_WITH_WORKSPACE,
  SETUP_OPEN_MACHINE,
  setupChecking,
  setupConnectingCreate,
  setupCreateFailed,
  setupNeedsUpdate,
  setupNewWorkspaceLead,
  setupNewWorkspaceTitle,
  setupNoAnswer,
  setupOfflineCreate,
  setupUpdatingCreate,
} from '../lib/machineSetupCopy';
import type { ProviderChoice } from '../lib/sessionProviderChoices';
import { useDirProbe } from '../lib/useDirProbe';
import { probeReportsSignedIn } from './RunnerSignIn';
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

/**
 * A machine with no workspace, on its new session page, which it fills alone (owner 2026-11-16,
 * docs/mocks/new-folder-in-home/workspace-card-with-name): the card makes the machine's first workspace and asks
 * only what that needs. The folder is one name in the machine's home (its Repos Folder on an older runner), which
 * the machine checks as it is typed: a folder there is used, one that isn't is made with the workspace. The
 * workspace's name follows the folder's until it is edited. Signing in a coding CLI is not asked here: the new
 * workspace's sessions ask for it where they need it.
 *
 * The account's managed runner while it is being set up or asleep (docs/managed-runner-no-default-workspace.md) is
 * not offline here: it cannot check the folder, so the name goes unchecked, and the workspace is made all the same.
 */
export function MachineSetupCard({
  runner,
  managed,
  onCreate,
  creating,
  createError,
  welcome,
}: {
  runner: Runner;
  /** The account's managed runner, read once for the whole page: how the card treats this runner if it is that one. */
  managed?: ManagedRunner | null;
  /** Make the workspace in this folder, under this name. */
  onCreate: (folder: PickedFolder, name: string) => void;
  /** The workspace is being made: the fields and the button wait. */
  creating: boolean;
  /** Why the last Create workspace was refused, said on the card until the next try. */
  createError: string | null;
  /** A new account's first machine (docs/mocks/new-user-onboarding): the card greets it. */
  welcome?: boolean;
}) {
  const machine = machineName(runner);
  const managedState = managedSetupState(runner.id, managed?.status);
  const offline = !managedState && runner.online !== true;
  const probes = answersDirProbe(runner);
  // A managed runner that isn't up makes the folder when its first session is claimed, on any runner version.
  const usable = !!managedState || (probes && makesNewFolders(runner));
  const disabled = offline || !usable;
  const root = managedState && !runner.reposRoot?.trim() ? MANAGED_RUNNER_REPOS_ROOT : newFolderRootOf(runner);

  const [typed, setTyped] = useState('');
  const folder = typed.trim();
  const settled = useSettled(folder);
  // The name is asked about where it would go: a folder, or a file, may be there already.
  const probe = useDirProbe(
    runner.id,
    !managedState && !disabled && isValidNewFolder(settled) ? newFolderPath(root, settled) : undefined,
    true,
  );
  const found = settled === folder && probe.state === 'answered' ? probe.probe : null;
  const verdict = found ? newFolderVerdict(found, machine) : null;
  const candidate: PickedFolder | null = managedState
    ? isValidNewFolder(folder) ? { kind: 'new', name: folder, path: newFolderPath(root, folder) } : null
    : found && isValidNewFolder(folder) ? newFolderPick(found, folder, root, machine) : null;

  // The workspace's name: the folder's until it is edited, and from then on what was typed, empty included.
  const [editedName, setEditedName] = useState<string | null>(null);
  const shownName = editedName ?? folder;
  const name = shownName.trim();
  const nameMissing = editedName !== null && !name;

  const canCreate = !!candidate && !!name && !disabled && !creating;
  const create = () => {
    if (canCreate && candidate) onCreate(candidate, name);
  };
  const onFieldKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter') create();
  };

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
            <div className="msc-title">{setupNewWorkspaceTitle(machine)}</div>
            <div className="msc-sub">{setupNewWorkspaceLead(machine)}</div>
          </div>
        </div>
      )}

      {managedState ? (
        <div className="msc-notice">{MANAGED_RUNNER_COPY.setup.notice[managedState]}</div>
      ) : offline ? (
        // Never heard from is a machine still coming up, not one gone away; and with nothing declared yet, not
        // one too old to check folders either.
        <div className="msc-notice">{isConnecting(runner) ? setupConnectingCreate(machine) : setupOfflineCreate(machine)}</div>
      ) : (
        !usable && (
          <div className="msc-notice">
            {updatesItself(runner) ? (
              setupUpdatingCreate(machine)
            ) : (
              <>
                {setupNeedsUpdate(machine)} <Link to={`/settings/machines/${encodeId(runner.id)}`}>{SETUP_OPEN_MACHINE}</Link>
              </>
            )}
          </div>
        )
      )}

      <div className="msc-body">
        <div className="msc-field" data-field="folder">
          <div className="msc-step-title">{SETUP_FOLDER}</div>
          <Input
            className="msc-input"
            size="small"
            prefix={<span className="msc-prefix">{newFolderPath(root, '')}</span>}
            placeholder={SETUP_NEW_FOLDER_NAME}
            aria-label={SETUP_FOLDER}
            value={typed}
            disabled={disabled || creating}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={onFieldKey}
            invalid={!!folder && !isValidNewFolder(folder)}
          />
          <div className="msc-line">
            {createError ? (
              <span className="msc-verdict bad">{setupCreateFailed(createError)}</span>
            ) : !folder ? (
              <span className="msc-meta">{SETUP_FOLDER_HINT}</span>
            ) : !isValidNewFolder(folder) ? (
              <span className="msc-verdict bad">{SETUP_NEW_FOLDER_INVALID}</span>
            ) : managedState ? (
              <span className="msc-meta">{MANAGED_RUNNER_COPY.setup.folderUnchecked[managedState]}</span>
            ) : verdict ? (
              // Nothing there yet reads as a note; anything there, or a check that failed, says what it is.
              found?.exists || found?.error ? (
                <span className={`msc-verdict ${verdict.tone}`}>{verdict.text}</span>
              ) : (
                <span className="msc-meta">{SETUP_NEW_FOLDER_WITH_WORKSPACE}</span>
              )
            ) : settled === folder && (probe.state === 'unanswered' || probe.state === 'idle') ? (
              <NoAnswer machine={machine} onAgain={probe.again} />
            ) : (
              <span className="msc-verdict wait">{setupChecking(machine)}</span>
            )}
          </div>
        </div>

        <div className="msc-field" data-field="name">
          <div className="msc-step-title">{SETUP_NAME}</div>
          <div className="msc-row">
            <Input
              className="msc-input"
              size="small"
              placeholder={folder || SETUP_NAME_PLACEHOLDER}
              aria-label={SETUP_NAME}
              value={shownName}
              disabled={disabled || creating}
              onChange={(e) => setEditedName(e.target.value)}
              onKeyDown={onFieldKey}
              invalid={nameMissing}
            />
            <Button variant="primary" disabled={!canCreate} loading={creating} onClick={create}>
              {SETUP_CREATE}
            </Button>
          </div>
          <div className="msc-line">
            {nameMissing ? (
              <span className="msc-verdict bad">{SETUP_NAME_EMPTY}</span>
            ) : (
              <span className="msc-meta">{editedName !== null ? SETUP_NAME_EDITED : SETUP_NAME_HINT}</span>
            )}
          </div>
        </div>
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
