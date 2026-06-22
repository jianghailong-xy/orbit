import type { SessionChangedFile, SessionDetail } from '../api';

/**
 * The result of a session's per-session git worktree, shown below the header once the run
 * has finished (the runner reports `isolationStatus` + the diff on completion, so the panel
 * stays hidden while a session is still live). For an isolated run it shows the branch the
 * work was committed to and the changed files — the branch is left for a manual merge. For
 * a session whose agent dir isn't a git repo it nudges the user to enable isolation.
 */
export function SessionOutputs({
  detail,
  onEnableIsolation,
  enabling,
}: {
  detail?: SessionDetail | null;
  /** Provided by the parent (which owns the mutation); when set, the non-git nudge offers a
   *  one-click "Enable isolation" that flips the agent's autoInitGit. */
  onEnableIsolation?: () => void;
  enabling?: boolean;
}) {
  const iso = detail?.isolationStatus;
  // Only meaningful once the runner has reported a terminal outcome; both fields land then.
  if (!iso) return null;

  if (iso === 'shared-nogit') {
    return (
      <div className="session-outputs session-outputs-nogit">
        <span className="session-outputs-warn">⚠ Ran without isolation</span>
        <span className="session-outputs-hint">
          This agent's directory isn't a git repo, so concurrent sessions share it and can
          clobber each other's edits. Enable isolation to have the runner <code>git init</code>{' '}
          it (with a default <code>.gitignore</code> + baseline commit) on the next run, after
          which each run gets its own branch.
        </span>
        {onEnableIsolation && (
          <button
            type="button"
            className="session-outputs-enable"
            disabled={enabling}
            onClick={onEnableIsolation}
          >
            {enabling ? 'Enabling…' : 'Enable isolation'}
          </button>
        )}
      </div>
    );
  }
  if (iso !== 'worktree' || !detail?.branch) return null;

  const files = detail.changedFiles ?? [];
  return (
    <div className="session-outputs">
      <div className="session-outputs-head">
        <span className="session-outputs-branch" title="Merge this branch to land the changes">
          {detail.branch}
        </span>
        {detail.baseSha && (
          <span className="session-outputs-base">from {detail.baseSha.slice(0, 8)}</span>
        )}
        <span className="session-outputs-count">
          {files.length === 0 ? 'no changes' : `${files.length} file${files.length === 1 ? '' : 's'} changed`}
        </span>
      </div>
      {files.length > 0 && (
        <div className="session-outputs-files">
          {files.map((f) => (
            <FileRow key={f.path} file={f} />
          ))}
        </div>
      )}
      {files.length > 0 && (
        <code className="session-outputs-merge">git merge {detail.branch}</code>
      )}
    </div>
  );
}

function FileRow({ file }: { file: SessionChangedFile }) {
  const binary = file.additions < 0 || file.deletions < 0;
  const status = (file.status || 'M').slice(0, 1).toUpperCase();
  return (
    <div className="session-file">
      <span className={`session-file-status st-${status.toLowerCase()}`} title={status}>
        {status}
      </span>
      <span className="session-file-path">{file.path}</span>
      {binary ? (
        <span className="session-file-bin">binary</span>
      ) : (
        <span className="session-file-stat">
          <span className="add">+{file.additions}</span>
          <span className="del">−{file.deletions}</span>
        </span>
      )}
    </div>
  );
}
