import { BranchesOutlined, ExportOutlined, GithubOutlined, LockOutlined, SearchOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type KeyboardEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { cloneRootFor, type GithubIntegration, type GithubRepository } from '@orbit/shared';
import {
  connectGithub,
  githubBranchesQuery,
  githubErrorText,
  githubRepositoriesQuery,
  repositoryCount,
} from '../lib/githubIntegration';
import {
  clonesRepositories,
  isValidNewFolder,
  machineName,
  newFolderPath,
  repositoryFolder,
  updatesItself,
  type PickedFolder,
} from '../lib/machineSetup';
import {
  pushedAgo,
  SETUP_BRANCH,
  SETUP_CHANGE,
  SETUP_CHECK_AGAIN,
  SETUP_CONNECT_GITHUB,
  SETUP_CONNECT_GITHUB_META,
  SETUP_DEFAULT_BRANCH,
  SETUP_GITHUB_ADD_REPOSITORIES,
  SETUP_GITHUB_CLONED_META,
  SETUP_GITHUB_LOADING,
  SETUP_GITHUB_META,
  SETUP_GITHUB_NONE,
  SETUP_GITHUB_NOT_LISTED,
  SETUP_GITHUB_PRIVATE,
  SETUP_GITHUB_SEARCH,
  SETUP_NEW_FOLDER_INVALID,
  SETUP_NEW_FOLDER_NAME,
  SETUP_OTHER_BRANCH,
  SETUP_RECONNECT_GITHUB,
  setupChecking,
  setupCloneNeedsUpdate,
  setupCloneUpdating,
  setupGithubAccount,
  setupGithubConnectFailed,
  setupGithubFolderExists,
  setupGithubListFailed,
  setupGithubSignInAgain,
  setupNoAnswer,
} from '../lib/machineSetupCopy';
import { useDirProbe } from '../lib/useDirProbe';
import type { Runner } from './TasksSidePanel';
import { Button } from './ui/Button';
import { Input } from './ui/Input';

/** How many repositories the list shows before anything is typed (board 01, note 4). */
const FIRST_REPOSITORIES = 8;
const TYPED_SETTLE_MS = 300;

/** This tab came back from GitHub's sign-in to this machine's card: From GitHub stays the choice (board 01, note 2). */
const returnKey = (runnerId: string) => `orbit.machineSetup.github.${runnerId}`;

/** Whether this machine's card is the one a GitHub sign-in started from; read once, and forgotten as it is read. */
export function takeGithubReturn(runnerId: string): boolean {
  try {
    const was = sessionStorage.getItem(returnKey(runnerId)) !== null;
    sessionStorage.removeItem(returnKey(runnerId));
    return was;
  } catch {
    return false;
  }
}

function useSettled(value: string, ms = TYPED_SETTLE_MS): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const settle = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(settle);
  }, [value, ms]);
  return settled;
}

/** `orbit-labs/` dimmed, then `orbit-web`. */
function RepositoryName({ fullName }: { fullName: string }) {
  const slash = fullName.indexOf('/');
  return (
    <span className="ghp-name">
      <span className="ghp-owner">{fullName.slice(0, slash + 1)}</span>
      {fullName.slice(slash + 1)}
    </span>
  );
}

const RepoMark = ({ repo }: { repo: Pick<GithubRepository, 'private'> }) =>
  repo.private ? <LockOutlined aria-label={SETUP_GITHUB_PRIVATE} /> : <GithubOutlined aria-hidden="true" />;

/**
 * The From GitHub option's body (docs/github-workspace-design.md §8, board 01 P1–P3): Connect GitHub until the account
 * is connected, then a search of the repositories Orbit's App reaches, most recently pushed first; once one is picked,
 * its default branch (Other branch for another) and the folder it is cloned into, which the machine is asked about — a
 * folder already there can't be cloned into. Says what it would pick through `onCandidate`; the card's button sends it.
 */
export function GithubFolderOption({
  runner,
  integration,
  disabled,
  onCandidate,
  onEnter,
}: {
  runner: Runner;
  integration: GithubIntegration;
  disabled: boolean;
  onCandidate: (folder: PickedFolder | null) => void;
  onEnter: () => void;
}) {
  const machine = machineName(runner);
  const [params, setParams] = useSearchParams();
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  // The callback's refusal, said once on the card it came back to; the address loses it.
  const [returned] = useState(() => params.get('github_error'));
  useEffect(() => {
    if (params.has('github') || params.has('github_error')) {
      setParams(
        (p) => {
          p.delete('github');
          p.delete('github_error');
          return p;
        },
        { replace: true },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connect = async () => {
    setConnecting(true);
    setConnectError(null);
    try {
      sessionStorage.setItem(returnKey(runner.id), '1');
    } catch {
      // Without the store the card still comes back; it just opens on its usual choice.
    }
    try {
      await connectGithub(`${window.location.pathname}${window.location.search}`);
    } catch (e) {
      setConnecting(false);
      setConnectError((e as Error).message);
    }
  };

  const clones = clonesRepositories(runner);
  const [search, setSearch] = useState('');
  const q = useSettled(search.trim());
  const [repo, setRepo] = useState<GithubRepository | null>(null);
  const [folder, setFolder] = useState('');
  const [branchOpen, setBranchOpen] = useState(false);
  const [branch, setBranch] = useState('');
  const connected = integration.connected && !integration.needsReconnect;
  const repositories = useQuery({ ...githubRepositoriesQuery(q), enabled: connected && !repo && clones });
  const branches = useQuery({ ...githubBranchesQuery(repo?.id ?? 0, ''), enabled: !!repo && branchOpen });

  const name = folder.trim();
  const settledName = useSettled(name, 400);
  // Where the server clones it (@orbit/shared cloneRootFor): home on a clone-workdir/v2 runner.
  const cloneRoot = cloneRootFor(runner) ?? '';
  const probe = useDirProbe(runner.id, repo && !disabled && isValidNewFolder(settledName) ? newFolderPath(cloneRoot, settledName) : undefined, true);
  const found = repo && settledName === name && probe.state === 'answered' ? probe.probe : null;
  const free = !!found && !found.error && !found.exists;
  const ref = branchOpen && branch.trim() && branch.trim() !== repo?.defaultBranch ? branch.trim() : null;

  const candidate: PickedFolder | null =
    repo && clones && free && isValidNewFolder(name)
      ? {
          kind: 'github',
          repoId: repo.id,
          repository: repo.fullName,
          private: repo.private,
          defaultBranch: repo.defaultBranch,
          ref,
          name,
          path: newFolderPath(cloneRoot, name),
        }
      : null;
  const candidateKey = candidate ? `${candidate.repoId}:${candidate.name}:${candidate.ref ?? ''}` : '';
  useEffect(() => {
    onCandidate(candidate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidateKey]);

  const pick = (picked: GithubRepository) => {
    setRepo(picked);
    setFolder(repositoryFolder(picked.fullName));
    setBranchOpen(false);
    setBranch('');
  };
  // The field's keys stay its own (a radio group takes the arrows), and Enter is the button beside it.
  const onFieldKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter' && candidate) onEnter();
  };

  const tooOld = !clones && (
    <span className="msc-verdict warn">{updatesItself(runner) ? setupCloneUpdating(machine) : setupCloneNeedsUpdate(machine)}</span>
  );

  if (!integration.connected || integration.needsReconnect) {
    return (
      <>
        <span className="msc-meta">{SETUP_GITHUB_META}</span>
        {integration.needsReconnect && <span className="msc-verdict warn">{setupGithubSignInAgain(integration.login ?? '')}</span>}
        {returned && <span className="msc-verdict bad">{githubErrorText(returned)}</span>}
        {connectError && <span className="msc-verdict bad">{setupGithubConnectFailed(connectError)}</span>}
        <span className="ghp-row">
          <Button size="small" icon={<GithubOutlined />} loading={connecting} disabled={disabled} onClick={() => void connect()}>
            {integration.needsReconnect ? SETUP_RECONNECT_GITHUB : SETUP_CONNECT_GITHUB}
          </Button>
          <span className="msc-meta">{SETUP_CONNECT_GITHUB_META}</span>
        </span>
        {tooOld}
      </>
    );
  }

  const count = repositoryCount(integration);
  if (!repo) {
    const list = repositories.data?.repositories ?? [];
    const shown = q ? list : list.slice(0, FIRST_REPOSITORIES);
    return (
      <>
        <span className="ghp-acct">
          {setupGithubAccount(integration.login ?? '', count)} ·{' '}
          <Link className="msc-change" to="/settings/integrations/github">
            {SETUP_CHANGE}
          </Link>
        </span>
        {tooOld}
        {clones && (
          <>
            <Input
              className="msc-input ghp-search"
              size="small"
              prefix={<SearchOutlined className="ghp-search-mark" />}
              placeholder={SETUP_GITHUB_SEARCH}
              aria-label={SETUP_GITHUB_SEARCH}
              value={search}
              disabled={disabled}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter' && shown[0]) pick(shown[0]);
              }}
            />
            <div className="ghp-menu" role="listbox" aria-label={SETUP_GITHUB_SEARCH}>
              {repositories.isPending ? (
                <div className="ghp-note">{SETUP_GITHUB_LOADING}</div>
              ) : repositories.isError ? (
                <div className="ghp-note msc-verdict bad">{setupGithubListFailed(repositories.error.message)}</div>
              ) : shown.length === 0 ? (
                <div className="ghp-note">{SETUP_GITHUB_NONE}</div>
              ) : (
                shown.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    role="option"
                    aria-selected={false}
                    className="ghp-item"
                    disabled={disabled}
                    onClick={() => pick(r)}
                  >
                    <span className="ghp-mark">
                      <RepoMark repo={r} />
                    </span>
                    <RepositoryName fullName={r.fullName} />
                    <span className="ghp-when">{pushedAgo(r.pushedAt)}</span>
                  </button>
                ))
              )}
              {integration.installUrl && (
                <div className="ghp-foot">
                  {SETUP_GITHUB_NOT_LISTED}{' '}
                  <a href={integration.installUrl} target="_blank" rel="noreferrer">
                    {SETUP_GITHUB_ADD_REPOSITORIES} <ExportOutlined />
                  </a>
                </div>
              )}
            </div>
          </>
        )}
      </>
    );
  }

  const branchNames = branches.data?.branches ?? [];
  return (
    <>
      <span className="ghp-row ghp-picked">
        <span className="ghp-repo">
          <span className="ghp-mark">
            <RepoMark repo={repo} />
          </span>
          {repo.fullName}
        </span>
        {!branchOpen && (
          <span className="msc-meta ghp-branch">
            <BranchesOutlined aria-label={SETUP_DEFAULT_BRANCH} /> {repo.defaultBranch}
          </span>
        )}
        <button className="msc-change" type="button" disabled={disabled} onClick={() => setRepo(null)}>
          {SETUP_CHANGE}
        </button>
      </span>
      {branchOpen && (
        <>
          <Input
            className="msc-input ghp-branch-input"
            size="small"
            prefix={<BranchesOutlined className="ghp-search-mark" />}
            placeholder={repo.defaultBranch}
            aria-label={SETUP_BRANCH}
            value={branch}
            disabled={disabled}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            list={`ghp-branches-${repo.id}`}
            onChange={(e) => setBranch(e.target.value)}
            onKeyDown={onFieldKey}
          />
          <datalist id={`ghp-branches-${repo.id}`}>
            {branchNames.map((b) => (
              <option key={b} value={b} />
            ))}
          </datalist>
        </>
      )}
      <Input
        className="msc-input"
        size="small"
        prefix={<span className="msc-prefix">{newFolderPath(cloneRoot, '')}</span>}
        placeholder={SETUP_NEW_FOLDER_NAME}
        aria-label={SETUP_NEW_FOLDER_NAME}
        value={folder}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setFolder(e.target.value)}
        onKeyDown={onFieldKey}
        invalid={!!name && !isValidNewFolder(name)}
      />
      {!name ? null : !isValidNewFolder(name) ? (
        <span className="msc-verdict bad">{SETUP_NEW_FOLDER_INVALID}</span>
      ) : found?.exists ? (
        <span className="msc-verdict bad">{setupGithubFolderExists(machine)}</span>
      ) : found?.error ? (
        <span className="msc-verdict bad">{found.error}</span>
      ) : settledName === name && (probe.state === 'unanswered' || probe.state === 'idle') ? (
        <span className="msc-verdict bad">
          {setupNoAnswer(machine)}{' '}
          <button className="msc-change" type="button" onClick={probe.again}>
            {SETUP_CHECK_AGAIN}
          </button>
        </span>
      ) : !found ? (
        <span className="msc-verdict wait">{setupChecking(machine)}</span>
      ) : null}
      <span className="msc-meta">
        {SETUP_GITHUB_CLONED_META}
        {!branchOpen && (
          <>
            {' '}
            <button className="msc-change" type="button" disabled={disabled} onClick={() => setBranchOpen(true)}>
              {SETUP_OTHER_BRANCH}
            </button>
          </>
        )}
      </span>
    </>
  );
}
