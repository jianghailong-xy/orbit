import { useEffect, useMemo, useState } from 'react';
import { App as AntApp, Drawer } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { SessionChangedFile, SessionDetail, SessionFilePatch } from '../api';
import { sessionDiffQuery } from '../lib/queries';

/**
 * Worktree status bar shown directly above the composer: the branch this session's work
 * lives on + its diff, collapsed to one line by default and expandable to the changed-file
 * list. The diff updates live each turn (uncommitted working-tree state) and settles to the
 * committed branch once the session ends. For a session whose agent dir isn't a git repo it
 * morphs into an amber "not isolated" nudge with a one-click enable.
 *
 * Clicking a file opens a right-side drawer with that file's unified diff (lazily fetched
 * from /sessions/:id/diff — the patch text never rides the session payload), with the file
 * list alongside so you can flip between files without leaving the drawer.
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
  // The changed file whose diff is shown in the drawer (null = drawer closed). Reset when the
  // open session changes so a switched-to session never inherits the previous one's open file.
  const [openFile, setOpenFile] = useState<string | null>(null);
  useEffect(() => setOpenFile(null), [detail?.id]);
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
    <>
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
            <FileRow key={f.path} file={f} onClick={() => setOpenFile(f.path)} />
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
      <WorktreeDiffDrawer
        sessionId={detail.id}
        files={files}
        branch={branch}
        committed={committed}
        openPath={openFile}
        onSelect={setOpenFile}
        onClose={() => setOpenFile(null)}
      />
    </>
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

function FileRow({
  file,
  active,
  onClick,
}: {
  file: SessionChangedFile;
  active?: boolean;
  onClick?: () => void;
}) {
  const binary = file.additions < 0 || file.deletions < 0;
  const status = (file.status || 'M').slice(0, 1).toUpperCase();
  return (
    <button
      type="button"
      className={`session-file session-file-btn${active ? ' active' : ''}`}
      onClick={onClick}
      title={`View diff · ${file.path}`}
    >
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
    </button>
  );
}

/** Right-side drawer showing one changed file's unified diff, with the full file list in a
 *  left rail so you can flip between files without closing it. The patch set is fetched lazily
 *  (only while the drawer is open) and cached under the session's query key, so reopening is
 *  instant and a turn end refreshes it. */
function WorktreeDiffDrawer({
  sessionId,
  files,
  branch,
  committed,
  openPath,
  onSelect,
  onClose,
}: {
  sessionId: string;
  files: SessionChangedFile[];
  branch: string;
  committed?: boolean;
  openPath: string | null;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const q = useQuery({ ...sessionDiffQuery(sessionId), enabled: openPath != null });
  const patchByPath = useMemo(() => {
    const m = new Map<string, SessionFilePatch>();
    for (const p of q.data?.patches ?? []) m.set(p.path, p);
    return m;
  }, [q.data]);
  const active = files.find((f) => f.path === openPath) ?? null;

  return (
    <Drawer
      className="wt-diff-drawer"
      placement="right"
      width="min(960px, 94vw)"
      open={openPath != null}
      onClose={onClose}
      title={
        <span className="wt-diff-head">
          <BranchLabel branch={branch} />
          <span className="wt-diff-head-sub">{committed ? 'committed' : 'working changes'}</span>
        </span>
      }
    >
      <div className="wt-diff-body">
        <div className="wt-diff-list">
          {files.map((f) => (
            <FileRow
              key={f.path}
              file={f}
              active={f.path === openPath}
              onClick={() => onSelect(f.path)}
            />
          ))}
        </div>
        <div className="wt-diff-pane">
          {active ? (
            <DiffPane file={active} patch={patchByPath.get(active.path)} loading={q.isLoading} />
          ) : (
            <div className="wt-diff-empty">Select a file to view its diff</div>
          )}
        </div>
      </div>
    </Drawer>
  );
}

/** One file's header (path + stat) and its diff body, or the right placeholder for a binary,
 *  oversized, still-loading, or empty diff. */
function DiffPane({
  file,
  patch,
  loading,
}: {
  file: SessionChangedFile;
  patch?: SessionFilePatch;
  loading?: boolean;
}) {
  const binary = file.additions < 0 || file.deletions < 0;
  return (
    <>
      <div className="wt-diff-pane-head">
        <span className="wt-diff-pane-path">{file.path}</span>
        {!binary && (
          <span className="wt-diff-pane-stat">
            <span className="add">+{file.additions}</span>
            <span className="del">−{file.deletions}</span>
          </span>
        )}
      </div>
      {binary ? (
        <div className="wt-diff-empty">Binary file — no preview</div>
      ) : patch?.patch ? (
        <DiffView patch={patch.patch} />
      ) : patch?.truncated ? (
        <div className="wt-diff-empty">Diff too large to preview inline</div>
      ) : loading ? (
        <div className="wt-diff-empty">Loading diff…</div>
      ) : (
        <div className="wt-diff-empty">No diff to preview</div>
      )}
    </>
  );
}

type PatchRow =
  | { type: 'add' | 'del' | 'ctx'; text: string; oldNo?: number; newNo?: number }
  | { type: 'hunk'; text: string };

/** Parse a git unified diff for ONE file into render rows, carrying real file line numbers
 *  from each `@@ -old +new @@` header. File-header noise (diff --git/index/+++/---/mode) is
 *  dropped; only hunks and their lines remain. */
function parseUnifiedDiff(patch: string): PatchRow[] {
  const rows: PatchRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const line of patch.split('\n')) {
    if (line === '') continue; // trailing-newline artifact; real blank ctx lines are " "
    if (line.startsWith('@@')) {
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        oldNo = Number(m[1]);
        newNo = Number(m[2]);
      }
      rows.push({ type: 'hunk', text: line });
      continue;
    }
    if (
      line.startsWith('diff --git') ||
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('new file') ||
      line.startsWith('deleted file') ||
      line.startsWith('old mode') ||
      line.startsWith('new mode') ||
      line.startsWith('similarity ') ||
      line.startsWith('rename ') ||
      line.startsWith('\\') // "\ No newline at end of file"
    ) {
      continue;
    }
    if (line.startsWith('+')) {
      rows.push({ type: 'add', text: line.slice(1), newNo: newNo++ });
    } else if (line.startsWith('-')) {
      rows.push({ type: 'del', text: line.slice(1), oldNo: oldNo++ });
    } else {
      rows.push({
        type: 'ctx',
        text: line.startsWith(' ') ? line.slice(1) : line,
        oldNo: oldNo++,
        newNo: newNo++,
      });
    }
  }
  return rows;
}

/** Render a parsed unified diff, reusing the transcript's .diff-* row styling (two line-number
 *  gutters + sign + text); hunk headers render like the collapsed-context "gap" rows. */
function DiffView({ patch }: { patch: string }) {
  const rows = useMemo(() => parseUnifiedDiff(patch), [patch]);
  return (
    <div className="chat-diff wt-diff-view">
      {rows.map((r, k) =>
        r.type === 'hunk' ? (
          <div key={k} className="diff-line diff-gap">
            <span className="diff-gutter" />
            <span className="diff-text">{r.text}</span>
          </div>
        ) : (
          <div key={k} className={`diff-line diff-${r.type}`}>
            <span className="diff-ln">{r.oldNo ?? ''}</span>
            <span className="diff-ln">{r.newNo ?? ''}</span>
            <span className="diff-sign">
              {r.type === 'add' ? '+' : r.type === 'del' ? '-' : ' '}
            </span>
            <span className="diff-text">{r.text}</span>
          </div>
        ),
      )}
    </div>
  );
}
