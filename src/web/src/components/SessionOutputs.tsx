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
              <MergeToMain
                branch={branch}
                status={detail.mergeStatus}
                error={detail.mergeError}
                busy={merging}
                onMerge={onMergeToMain}
                copy={copy}
              />
            ) : (
              <span className="wt-merge-label">Working changes (uncommitted) on {branch}</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** The "Merge to main" control on the committed status bar. Drives off the server-reported
 *  mergeStatus: idle → a Merge button; pending → "Merging…"; merged → a ✓; conflict/error →
 *  the reason + a Retry. The copyable `git merge <branch>` is always kept as a manual fallback
 *  (the runner only auto-merges a clean main; anything else comes back as an error to merge by
 *  hand). `onMerge` is absent when the parent can't drive it — then only the fallback shows. */
function MergeToMain({
  branch,
  status,
  error,
  busy,
  onMerge,
  copy,
}: {
  branch: string;
  status?: SessionDetail['mergeStatus'];
  error?: string | null;
  busy?: boolean;
  onMerge?: () => void;
  copy: (text: string) => void;
}) {
  const pending = busy || status === 'pending';
  const failed = status === 'conflict' || status === 'error';
  return (
    <div className="wt-merge-row">
      {status === 'merged' ? (
        <span className="wt-merge-done" title="Merged into main">
          ✓ Merged to main
        </span>
      ) : onMerge ? (
        <button type="button" className="wt-merge-btn" disabled={pending} onClick={onMerge}>
          {pending ? 'Merging…' : failed ? 'Retry merge' : 'Merge to main'}
        </button>
      ) : null}
      {failed && (
        <span className="wt-merge-err" title={error ?? undefined}>
          {status === 'conflict' ? 'Conflict — merge manually' : error || 'Merge failed'}
        </span>
      )}
      {status !== 'merged' && (
        <span className="wt-merge-or">
          or
          <code className="wt-merge-cmd" title="Copy" onClick={() => copy(`git merge ${branch}`)}>
            git merge {branch}
          </code>
        </span>
      )}
    </div>
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
