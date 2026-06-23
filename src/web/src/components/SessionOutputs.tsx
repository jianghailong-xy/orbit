import { useState } from 'react';
import { App as AntApp } from 'antd';
import type { SessionChangedFile, SessionDetail } from '../api';

/**
 * Worktree status bar shown directly above the composer: the branch this session's work
 * lives on + its diff, collapsed to one line by default and expandable to the changed-file
 * list. Reflects what the runner reported on completion (isolation_status + changed_files),
 * so it appears once a run has finished. For a session whose agent dir isn't a git repo it
 * morphs into an amber "not isolated" nudge with a one-click enable.
 *
 * Step 1 (this) is terminal-only — the live +/− while a session is still RUNNING needs the
 * runner to report the working-tree diff per turn (a follow-up).
 */
export function SessionOutputs({
  detail,
  committed,
  onEnableIsolation,
  enabling,
  onMergeToMain,
  merging,
  onResolveInSession,
  resolving,
}: {
  detail?: SessionDetail | null;
  /** True once the session has ended and the runner committed the work to the branch; while
   *  the session is still live the diff is uncommitted working-tree state (refreshed each turn). */
  committed?: boolean;
  /** Provided by the parent (which owns the mutation); enables the non-git nudge's button. */
  onEnableIsolation?: () => void;
  enabling?: boolean;
  /** Provided by the parent (owns the mutation + confirm); enables the "Merge to main" button.
   *  The outcome surfaces via detail.mergeStatus/mergeError (the parent polls while pending). */
  onMergeToMain?: () => void;
  merging?: boolean;
  /** Provided by the parent; on a conflict/error, resumes the session so its agent merges main
   *  in and resolves the conflicts (after which the branch merges clean). */
  onResolveInSession?: () => void;
  resolving?: boolean;
}) {
  const { message } = AntApp.useApp();
  const [open, setOpen] = useState(false);
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text)?.then(
      () => message.success('Copied'),
      () => message.error('Copy failed'),
    );
  };

  const iso = detail?.isolationStatus;
  if (!iso) return null;

  // Non-git: ran in the shared workDir (no isolation). Offer the one-click enable.
  if (iso === 'shared-nogit') {
    return (
      <div className="wt-bar wt-bar-nogit">
        <div className="wt-row">
          <span className="wt-warn">⚠ Shared workDir — not isolated</span>
          <span className="wt-spacer" />
          {onEnableIsolation && (
            <button type="button" className="wt-enable" disabled={enabling} onClick={onEnableIsolation}>
              {enabling ? 'Enabling…' : 'Enable isolation'}
            </button>
          )}
        </div>
      </div>
    );
  }
  if (iso !== 'worktree' || !detail?.branch) return null;

  const branch = detail.branch;
  const files = detail.changedFiles ?? [];
  const hasChanges = files.length > 0;
  const add = files.reduce((s, f) => s + Math.max(0, f.additions), 0);
  const del = files.reduce((s, f) => s + Math.max(0, f.deletions), 0);

  return (
    <div className={`wt-bar${open ? ' wt-open' : ''}`}>
      <div className="wt-row">
        <button type="button" className="wt-branch" title="Copy branch name" onClick={() => copy(branch)}>
          <span className="wt-branch-ico">⎇</span>
          <BranchLabel branch={branch} />
        </button>
        {hasChanges ? (
          <span className="wt-stat">
            <span className="wt-add">+{add}</span>
            <span className="wt-del">−{del}</span>
            <span className="wt-files">
              · {files.length} {files.length === 1 ? 'file' : 'files'}
              {committed ? ' · committed' : ''}
            </span>
          </span>
        ) : (
          <span className="wt-stat wt-nochange">no changes</span>
        )}
        <span className="wt-spacer" />
        {committed && hasChanges && (
          <MergeButton
            status={detail.mergeStatus}
            busy={merging}
            onMerge={onMergeToMain}
            onResolveInSession={onResolveInSession}
            resolving={resolving}
          />
        )}
        {hasChanges && (
          <button
            type="button"
            className="wt-expand"
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? 'Hide files' : 'Show files'}
          >
            {open ? '▾' : '▸'}
          </button>
        )}
      </div>
      {open && hasChanges && (
        <div className="wt-files-panel">
          {files.map((f) => (
            <FileRow key={f.path} file={f} />
          ))}
          <div className="wt-merge">
            {committed ? (
              <div className="wt-merge-manual">
                {(detail.mergeStatus === 'conflict' || detail.mergeStatus === 'error') && (
                  <span className="wt-merge-err" title={detail.mergeError ?? undefined}>
                    {detail.mergeStatus === 'conflict'
                      ? 'Merge conflict — aborted, working tree left clean. Resolve manually:'
                      : detail.mergeError || 'Merge failed. Merge manually:'}
                  </span>
                )}
                <span className="wt-merge-or">
                  {detail.mergeStatus === 'merged' ? 'Merged ✓ · or by hand:' : 'Or merge manually:'}
                  <code className="wt-merge-cmd" title="Copy" onClick={() => copy(`git merge ${branch}`)}>
                    git merge {branch}
                  </code>
                </span>
              </div>
            ) : (
              <span className="wt-merge-label">Working changes (uncommitted) on {branch}</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Compact "Merge to main" control sitting on the worktree bar itself (shown once the work is
 *  committed). Drives off the server-reported mergeStatus: idle → a Merge button; pending →
 *  "Merging…"; merged → a ✓ chip; conflict/error → "Resolve in session" (resume the session so
 *  its agent merges main in and fixes the conflicts), falling back to "Retry merge" when the
 *  parent can't resume. The failure detail + a copyable `git merge <branch>` fallback live in
 *  the expandable file panel below. With no driver at all only the merged chip can show. */
function MergeButton({
  status,
  busy,
  onMerge,
  onResolveInSession,
  resolving,
}: {
  status?: SessionDetail['mergeStatus'];
  busy?: boolean;
  onMerge?: () => void;
  onResolveInSession?: () => void;
  resolving?: boolean;
}) {
  if (status === 'merged') {
    return (
      <span className="wt-merge-done" title="Merged into main">
        ✓ Merged
      </span>
    );
  }
  const failed = status === 'conflict' || status === 'error';
  // On a conflict/error, the best recovery is letting the session's own agent merge main in and
  // resolve — it has the context for the changes it made. Falls back to a plain retry.
  if (failed && onResolveInSession) {
    return (
      <button
        type="button"
        className="wt-merge-btn wt-merge-btn-failed"
        disabled={resolving}
        onClick={onResolveInSession}
        title="Resume the session and have its agent merge main in and resolve the conflicts"
      >
        {resolving ? 'Resuming…' : 'Resolve in session'}
      </button>
    );
  }
  if (!onMerge) return null;
  const pending = busy || status === 'pending';
  return (
    <button
      type="button"
      className={`wt-merge-btn${failed ? ' wt-merge-btn-failed' : ''}`}
      disabled={pending}
      onClick={onMerge}
      title={failed ? 'Merge failed — expand the file list for details' : 'Merge this branch into main'}
    >
      {pending ? 'Merging…' : failed ? 'Retry merge' : 'Merge to main'}
    </button>
  );
}

/** Render an auto-generated `orbit/<slug>-<hash>` branch with the prefix + hash dimmed so
 *  the meaningful slug reads first; falls back to the raw name for any other shape. */
function BranchLabel({ branch }: { branch: string }) {
  const m = branch.match(/^(orbit\/)(.+)(-[0-9a-f]{6})$/);
  if (!m) return <span className="wt-branch-name">{branch}</span>;
  return (
    <span className="wt-branch-name">
      <span className="wt-dim">{m[1]}</span>
      {m[2]}
      <span className="wt-dim">{m[3]}</span>
    </span>
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
