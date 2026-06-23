import { useEffect, useMemo, useState } from 'react';
import { App as AntApp, Drawer } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { refreshSessionDiff } from '../api';
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
  onMergeToMain,
  merging,
  onResolveInSession,
  resolving,
  onCommit,
  committing,
  turnActive,
}: {
  detail?: SessionDetail | null;
  /** Fallback for older runners that don't report `worktreeDirty`: true once the session has
   *  ended (work committed at completion) so the bar shows Merge, false while live so it shows
   *  the read-only "uncommitted" note. When the runner DOES report worktreeDirty, that drives
   *  the Commit-vs-Merge choice instead — for live and ended sessions alike. */
  committed?: boolean;
  /** True while a turn is actively in flight (live session, not awaiting input). The branch
   *  state is then transient — possibly a mid-turn committed checkpoint the agent will build
   *  on — so the bar holds "Merge to main" (hidden) and "Commit" (disabled) until the turn
   *  finishes; committing a half-built mid-turn tree would capture an inconsistent snapshot. */
  turnActive?: boolean;
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
  /** Provided by the parent (owns the mutation); enables the "Commit" button shown while the
   *  live worktree is dirty. The outcome surfaces via detail.commitStatus/worktreeDirty. */
  onCommit?: () => void;
  committing?: boolean;
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
  // A worktree with no diff has nothing actionable or informative to show — hide the bar entirely.
  if (files.length === 0) return null;
  const add = files.reduce((s, f) => s + Math.max(0, f.additions), 0);
  const del = files.reduce((s, f) => s + Math.max(0, f.deletions), 0);

  // Git-state-driven primary action. When the runner reports `worktreeDirty`, the bar shows
  // Commit while the worktree has uncommitted changes and Merge once it's clean. Older runners
  // don't report it (null) → fall back to the session lifecycle (`committed`): live shows the
  // read-only "uncommitted" note, ended shows Merge.
  const dirtyKnown = detail.worktreeDirty != null;
  const showCommit = dirtyKnown && detail.worktreeDirty === true;
  const mergeReady = dirtyKnown ? !showCommit : !!committed;
  // Hold "Merge to main" while a turn is in flight: a clean worktree mid-turn is just a
  // transient checkpoint the agent is still building on, not finished work ready for main.
  const showMerge = mergeReady && !turnActive;

  return (
    <>
    <div className={`wt-bar${open ? ' wt-open' : ''}`}>
      {/* The whole row toggles the file list — the chevron is just an affordance. It stays a
          plain div (not role=button) because it wraps the branch-copy and chevron buttons;
          the chevron remains the keyboard-accessible toggle. */}
      <div className="wt-row wt-row-toggle" onClick={toggle}>
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
        <span className="wt-stat">
          <span className="wt-add">+{add}</span>
          <span className="wt-del">−{del}</span>
          <span className="wt-files">
            · {files.length} {files.length === 1 ? 'file' : 'files'}
            {showMerge ? ' · committed' : ''}
          </span>
        </span>
        <span className="wt-spacer" />
        {showCommit && (
          <CommitButton
            status={detail.commitStatus}
            busy={committing}
            turnActive={turnActive}
            onCommit={onCommit}
          />
        )}
        {showMerge && (
          <MergeButton
            status={detail.mergeStatus}
            busy={merging}
            onMerge={onMergeToMain}
            onResolveInSession={onResolveInSession}
            resolving={resolving}
          />
        )}
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
      </div>
      {open && (
        <div className="wt-files-panel">
          {files.map((f) => (
            <FileRow key={f.path} file={f} onClick={() => setOpenFile(f.path)} />
          ))}
          <div className="wt-merge">
            {showCommit ? (
              <div className="wt-merge-manual">
                {detail.commitStatus === 'error' && (
                  <span className="wt-merge-err" title={detail.commitError ?? undefined}>
                    {detail.commitError || 'Commit failed'}
                  </span>
                )}
                <span className="wt-merge-label">
                  Uncommitted changes on {branch} — commit them to merge into main.
                </span>
              </div>
            ) : showMerge ? (
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
            ) : turnActive ? (
              <span className="wt-merge-label">Turn in progress — you can merge to main once it finishes.</span>
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

/** Compact "Commit" control on the worktree bar, shown while the live worktree has uncommitted
 *  changes (worktreeDirty). Commits them onto the branch via the runner (heartbeat round-trip);
 *  once the runner reports the tree clean the bar flips to MergeButton. Drives off commitStatus:
 *  idle → Commit; pending → "Committing…"; error → "Retry commit" (detail sits in the expanded
 *  panel). Disabled while a turn is in flight (turnActive) — the mid-turn tree is half-built, so
 *  committing it would capture an inconsistent snapshot. With no driver (no onCommit) it renders
 *  nothing. */
function CommitButton({
  status,
  busy,
  turnActive,
  onCommit,
}: {
  status?: SessionDetail['commitStatus'];
  busy?: boolean;
  turnActive?: boolean;
  onCommit?: () => void;
}) {
  if (!onCommit) return null;
  const pending = busy || status === 'pending';
  const failed = status === 'error';
  return (
    <button
      type="button"
      className={`wt-merge-btn${failed ? ' wt-merge-btn-failed' : ''}`}
      disabled={pending || turnActive}
      onClick={onCommit}
      title={
        turnActive && !pending
          ? 'Wait for the current turn to finish before committing'
          : failed
            ? 'Commit failed — try again'
            : 'Commit the worktree changes onto this branch'
      }
    >
      {pending ? 'Committing…' : failed ? 'Retry commit' : 'Commit'}
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
  const qc = useQueryClient();
  const q = useQuery({ ...sessionDiffQuery(sessionId), enabled: openPath != null });
  const patchByPath = useMemo(() => {
    const m = new Map<string, SessionFilePatch>();
    for (const p of q.data?.patches ?? []) m.set(p.path, p);
    return m;
  }, [q.data]);
  const active = files.find((f) => f.path === openPath) ?? null;

  // The file list refreshes on every heartbeat but the stored per-file patches only refresh at
  // turn boundaries, so a working-changes file changed since the last turn end can show in the
  // list with no diff. When that happens, ask the live runner to recompute now and poll until
  // the fresh diff lands. Skipped for committed snapshots (final — no live worktree to refresh)
  // and binary/too-large files (which have their own placeholders).
  const activePatch = active ? patchByPath.get(active.path) : undefined;
  const activeBinary = active ? active.additions < 0 || active.deletions < 0 : false;
  const stale =
    !committed && !!active && !activeBinary && !activePatch?.patch && !activePatch?.truncated;
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    if (!stale) {
      setRefreshing(false);
      return;
    }
    setRefreshing(true);
    let tries = 0;
    void refreshSessionDiff(sessionId).catch(() => {});
    const iv = setInterval(() => {
      tries += 1;
      void qc.invalidateQueries({ queryKey: sessionDiffQuery(sessionId).queryKey });
      if (tries >= 8) {
        clearInterval(iv);
        setRefreshing(false); // gave up (~16s) — fall back to the empty placeholder
      }
    }, 2000);
    return () => clearInterval(iv);
  }, [stale, sessionId, active?.path, qc]);

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
            <DiffPane
              file={active}
              patch={activePatch}
              loading={q.isLoading}
              refreshing={refreshing}
            />
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
  refreshing,
}: {
  file: SessionChangedFile;
  patch?: SessionFilePatch;
  loading?: boolean;
  refreshing?: boolean;
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
      ) : refreshing ? (
        <div className="wt-diff-empty">Refreshing diff…</div>
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
