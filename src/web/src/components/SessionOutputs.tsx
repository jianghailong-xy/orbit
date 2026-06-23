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
}: {
  detail?: SessionDetail | null;
  /** True once the session has ended and the runner committed the work to the branch; while
   *  the session is still live the diff is uncommitted working-tree state (refreshed each turn). */
  committed?: boolean;
  /** Provided by the parent (which owns the mutation); enables the non-git nudge's button. */
  onEnableIsolation?: () => void;
  enabling?: boolean;
}) {
  const { message } = AntApp.useApp();
  const [open, setOpen] = useState(false);
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text)?.then(
      () => message.success('Copied'),
      () => message.error('Copy failed'),
    );
  };
  const toggle = () => setOpen((v) => !v);

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
      {/* The whole row toggles the file list — the chevron is just an affordance. It stays a
          plain div (not role=button) because it wraps the branch-copy and chevron buttons;
          the chevron remains the keyboard-accessible toggle. */}
      <div
        className={`wt-row${hasChanges ? ' wt-row-toggle' : ''}`}
        onClick={hasChanges ? toggle : undefined}
      >
        <button
          type="button"
          className="wt-branch"
          title="Copy branch name"
          onClick={(e) => {
            e.stopPropagation();
            copy(branch);
          }}
        >
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
            onClick={(e) => {
              e.stopPropagation();
              toggle();
            }}
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
              <>
                <span className="wt-merge-label">Committed to {branch} · merge with</span>
                <code className="wt-merge-cmd" title="Copy" onClick={() => copy(`git merge ${branch}`)}>
                  git merge {branch}
                </code>
              </>
            ) : (
              <span className="wt-merge-label">Working changes (uncommitted) on {branch}</span>
            )}
          </div>
        </div>
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
