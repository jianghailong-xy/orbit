import { type MouseEvent as ReactMouseEvent, useEffect, useMemo, useRef, useState } from 'react';
import { App as AntApp, Drawer, Dropdown, Segmented, Tooltip } from 'antd';
import type { MenuProps } from 'antd';
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
  /** Provided by the parent (owns the mutation); enables the "Merge to main" button. Receives
   *  the chosen target branch (undefined → the default, which the runner auto-detects: main,
   *  else master). The outcome surfaces via detail.mergeStatus/mergeError (parent polls). */
  onMergeToMain?: (target?: string) => void;
  merging?: boolean;
  /** Provided by the parent; on a conflict/error, resumes the session so its agent rebases the
   *  branch onto the latest main and resolves the conflicts (after which the merge fast-forwards). */
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
  // The merge/commit failure reason (+ a copyable manual-merge command) lives in the file panel,
  // which is collapsed by default — so a failure can land unseen. Auto-expand the panel the moment
  // the runner reports an error/conflict, revealing it without the user hunting. Keyed by the
  // failure so it fires once per transition; the user can still collapse it afterward.
  const failKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const failed =
      detail?.mergeStatus === 'error' ||
      detail?.mergeStatus === 'conflict' ||
      detail?.commitStatus === 'error';
    const key = failed ? `${detail?.id}:${detail?.mergeStatus ?? ''}:${detail?.commitStatus ?? ''}` : null;
    if (key && key !== failKeyRef.current) setOpen(true);
    failKeyRef.current = key;
  }, [detail?.id, detail?.mergeStatus, detail?.commitStatus]);
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
  // Faithful by-hand equivalent of the runner's rebase merge: replay the branch onto the target,
  // then fast-forward the target to it — a linear history, no merge commit. Copyable fallback below.
  const manualMergeCmd = `git rebase ${detail.mergeTarget || 'main'} ${branch} && git checkout ${detail.mergeTarget || 'main'} && git merge --ff-only ${branch}`;
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
  // Commit only applies to a live session: the runner commits a finished session's work at
  // completion and the backend rejects /commit once it has ended. So an ended session that
  // still reports dirty (stale flag, not-yet-reset by a heartbeat) must NOT keep offering a
  // Commit button that always 409s — it falls through to Merge like any other ended session.
  const showCommit = dirtyKnown && detail.worktreeDirty === true && !committed;
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
            mergeError={detail.mergeError}
            busy={merging}
            targets={detail.mergeTargets ?? []}
            mergeTarget={detail.mergeTarget}
            agentDefaultTarget={detail.agent?.defaultMergeTarget}
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
                  <code className="wt-merge-cmd" title="Copy" onClick={() => copy(manualMergeCmd)}>
                    {manualMergeCmd}
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

/** Compact "Merge to main" control on the worktree bar — a split button once the work is
 *  committed: the left segment merges into the default target (main, else master), and a caret
 *  opens a dropdown of the repo's other branches (mergeTargets) to merge into instead. Drives
 *  off the server-reported mergeStatus: idle → the split button; pending → "Merging…"; merged →
 *  a ✓ chip (naming the target); conflict → "Resolve in session" (resume so the agent rebases the
 *  branch onto main and fixes the conflicts — offered only for a main/master target); error →
 *  "Retry merge" (a precondition failure like a dirty main that a rebase can't fix — re-runs the
 *  same target). The failure detail + a copyable rebase fallback live in the expandable file
 *  panel below. With no reported targets (older runner) the caret is
 *  hidden and the button behaves exactly as before. With no driver at all only the ✓ can show. */
function MergeButton({
  status,
  mergeError,
  busy,
  targets,
  mergeTarget,
  agentDefaultTarget,
  onMerge,
  onResolveInSession,
  resolving,
}: {
  status?: SessionDetail['mergeStatus'];
  /** Why the last merge failed (for an 'error'); surfaced on the failed button's hover. */
  mergeError?: string | null;
  busy?: boolean;
  /** Candidate target branches reported by the runner (empty for older runners). */
  targets: string[];
  /** The branch the last merge targeted (null = the auto-detected default). */
  mergeTarget?: string | null;
  /** The agent's remembered default target (set when the user last switched in the dropdown).
   *  Wins over main/master as the left-segment default — but only while it's still a reported
   *  target, so a renamed/deleted branch falls back cleanly. */
  agentDefaultTarget?: string | null;
  onMerge?: (target?: string) => void;
  onResolveInSession?: () => void;
  resolving?: boolean;
}) {
  if (status === 'merged') {
    // Annotate the target only when it's an unusual one — keep the common main/master merge clean.
    const elsewhere = mergeTarget && mergeTarget !== 'main' && mergeTarget !== 'master';
    return (
      <span className="wt-merge-done" title={`Merged into ${mergeTarget || 'main'}`}>
        ✓ Merged{elsewhere ? ` → ${mergeTarget}` : ''}
      </span>
    );
  }
  const failed = status === 'conflict' || status === 'error';
  // The reason a failed merge shows on hover: the runner's precondition message for an 'error'
  // (e.g. "develop has uncommitted changes…"), or a fixed note for a 'conflict' (mirroring the
  // panel — the raw git conflict dump isn't shown). Replaces the old generic "expand for details"
  // title so the actual cause is visible without opening the panel.
  const failureHint =
    status === 'conflict'
      ? 'Merge conflict — aborted, working tree left clean. Resolve it from the panel below.'
      : mergeError || 'Merge failed — see the panel below.';
  // Resolve-in-session has the agent rebase the branch onto main and fix conflicts — meaningful
  // only for a real merge *conflict* whose target IS main/master. An 'error' outcome is a
  // precondition failure (a dirty main checkout, the target checked out elsewhere, … — see the
  // runner's mergeToMain) that a rebase can't fix; it, and a conflict on some other target, fall
  // through to a plain "Retry merge" (+ the failure detail in the panel below).
  const resolvable =
    status === 'conflict' && (!mergeTarget || mergeTarget === 'main' || mergeTarget === 'master');
  if (failed && onResolveInSession && resolvable) {
    return (
      <Tooltip
        placement="top"
        title={
          <>
            {failureHint}
            <br />
            Resume the session to have its agent rebase onto main and resolve it.
          </>
        }
      >
        <button
          type="button"
          className="wt-merge-btn wt-merge-btn-failed"
          disabled={resolving}
          onClick={(e) => {
            e.stopPropagation();
            onResolveInSession();
          }}
        >
          {resolving ? 'Resuming…' : 'Resolve in session'}
        </button>
      </Tooltip>
    );
  }
  if (!onMerge) return null;
  const pending = busy || status === 'pending';

  // The left-segment default: the agent's remembered target if it's still on offer, else main,
  // else master, else the first reported branch; undefined means "let the runner auto-detect"
  // (the original behavior, and the older-runner case where `targets` is empty). Retry re-runs
  // the SAME target that failed; a fresh merge uses the default.
  const remembered = agentDefaultTarget && targets.includes(agentDefaultTarget) ? agentDefaultTarget : undefined;
  const defaultTarget =
    remembered ?? (targets.includes('main') ? 'main' : targets.includes('master') ? 'master' : targets[0]);
  const primaryTarget = failed ? (mergeTarget ?? undefined) : defaultTarget;
  const primaryLabel = pending
    ? 'Merging…'
    : failed
      ? `Retry merge to ${mergeTarget ?? defaultTarget ?? 'main'}`
      : `Merge to ${defaultTarget ?? 'main'}`;
  const hasMenu = targets.length > 0 && !pending;

  const mainBtn = (
    <button
      type="button"
      className={`wt-merge-btn${failed ? ' wt-merge-btn-failed' : ''}${hasMenu ? ' wt-merge-btn-split' : ''}`}
      disabled={pending}
      onClick={(e) => {
        e.stopPropagation();
        onMerge(primaryTarget);
      }}
      title={failed ? undefined : `Merge this branch into ${defaultTarget ?? 'main'}`}
    >
      {primaryLabel}
    </button>
  );
  // On failure, hover surfaces the real reason via an antd Tooltip (native title cleared above);
  // otherwise the plain button with its native title is enough.
  const mainBtnEl = failed ? (
    <Tooltip title={failureHint} placement="top">
      {mainBtn}
    </Tooltip>
  ) : (
    mainBtn
  );
  // Older runner (no reported targets) or mid-merge → the plain button, no caret.
  if (!hasMenu) return mainBtnEl;

  const items: MenuProps['items'] = targets.map((b) => ({
    key: b,
    label: (
      <span className="wt-merge-target">
        <span className="wt-merge-target-name">{b}</span>
        {b === defaultTarget && <span className="wt-merge-target-tag">default</span>}
      </span>
    ),
    onClick: () => onMerge(b),
  }));

  return (
    <span className="wt-merge-split-wrap" onClick={(e) => e.stopPropagation()}>
      {mainBtnEl}
      <Dropdown trigger={['click']} placement="topRight" menu={{ items }}>
        <button
          type="button"
          className={`wt-merge-caret${failed ? ' wt-merge-btn-failed' : ''}`}
          aria-label="Choose a branch to merge into"
          title="Merge into another branch"
          onClick={(e) => e.stopPropagation()}
        >
          ▾
        </button>
      </Dropdown>
    </span>
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
      onClick={(e) => {
        // Don't let the click bubble to the row's toggle — committing shouldn't expand the panel.
        e.stopPropagation();
        onCommit();
      }}
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

const WT_DIFF_WIDTH_KEY = 'wt-diff-width';
const WT_DIFF_WIDTH_MIN = 560;
const WT_DIFF_WIDTH_DEFAULT = 'min(1100px, 94vw)';
const WT_DIFF_MODE_KEY = 'wt-diff-mode';
// Render at most this many rows of a single file's diff up front; a giant file (e.g. a
// 2k-line new file) then offers a "show more" button rather than laying out everything at once.
const DIFF_ROW_CAP = 600;

/** Split a path into its (trailing-slash) directory and basename. */
function splitPath(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf('/');
  return i < 0 ? { dir: '', name: path } : { dir: path.slice(0, i + 1), name: path.slice(i + 1) };
}

type TreeNode =
  | {
      kind: 'dir';
      /** Display segment — a compacted single-child chain like `Sources/OrbitApp`. */
      name: string;
      /** Full path from the root; the stable key for collapse state. */
      path: string;
      children: TreeNode[];
      add: number;
      del: number;
      fileCount: number;
      binaryOnly: boolean;
    }
  | { kind: 'file'; name: string; file: SessionChangedFile };

/** Build a nested directory tree from the changed-file paths, with two readability tricks: a
 *  chain of single-child directories is compacted into one node (VS Code "compact folders", so
 *  `a/b/c` is one row not three), and per-directory stats / binary-only flags are rolled up so a
 *  folder shows a summary and can fold away (build-output dirs like `.build/debug` default shut).
 *  Directories sort before files; both alphabetical. */
function buildFileTree(files: SessionChangedFile[]): TreeNode[] {
  type Raw = { dirs: Map<string, Raw>; files: SessionChangedFile[] };
  const root: Raw = { dirs: new Map(), files: [] };
  for (const f of files) {
    const segs = f.path.split('/');
    segs.pop(); // basename — the file lives in the dir named by the remaining segments
    let cur = root;
    for (const seg of segs) {
      let next = cur.dirs.get(seg);
      if (!next) {
        next = { dirs: new Map(), files: [] };
        cur.dirs.set(seg, next);
      }
      cur = next;
    }
    cur.files.push(f);
  }
  const convert = (raw: Raw, prefix: string): TreeNode[] => {
    const nodes: TreeNode[] = [];
    for (const dirName of [...raw.dirs.keys()].sort((a, b) => a.localeCompare(b))) {
      let seg = dirName;
      let node = raw.dirs.get(dirName)!;
      let path = prefix + dirName;
      // Compact a single-child chain (one subdir, no files of its own) into this row.
      while (node.files.length === 0 && node.dirs.size === 1) {
        const [childName, childRaw] = [...node.dirs.entries()][0];
        seg += '/' + childName;
        path += '/' + childName;
        node = childRaw;
      }
      const children = convert(node, path + '/');
      let add = 0;
      let del = 0;
      let fileCount = 0;
      let binaryOnly = true;
      for (const c of children) {
        if (c.kind === 'file') {
          fileCount += 1;
          if (c.file.additions > 0) add += c.file.additions;
          if (c.file.deletions > 0) del += c.file.deletions;
          if (c.file.additions >= 0 && c.file.deletions >= 0) binaryOnly = false;
        } else {
          fileCount += c.fileCount;
          add += c.add;
          del += c.del;
          if (!c.binaryOnly) binaryOnly = false;
        }
      }
      nodes.push({ kind: 'dir', name: seg, path, children, add, del, fileCount, binaryOnly });
    }
    for (const f of raw.files.sort((a, b) => a.path.localeCompare(b.path))) {
      nodes.push({ kind: 'file', name: f.path.slice(f.path.lastIndexOf('/') + 1), file: f });
    }
    return nodes;
  };
  return convert(root, '');
}

/** Files in tree (depth-first display) order — used for prev/next nav so it follows the list. */
function treeFiles(nodes: TreeNode[]): SessionChangedFile[] {
  const out: SessionChangedFile[] = [];
  for (const n of nodes) {
    if (n.kind === 'file') out.push(n.file);
    else out.push(...treeFiles(n.children));
  }
  return out;
}

/** The changed-file list for the drawer rail, rendered as a collapsible directory tree. Collapse
 *  state is keyed by each directory's full path; binary-only dirs (build artifacts) default shut,
 *  and the user's manual toggles win and persist while live heartbeats refresh `files`. */
function FileTree({
  files,
  activePath,
  onSelect,
}: {
  files: SessionChangedFile[];
  activePath?: string | null;
  onSelect: (path: string) => void;
}) {
  const tree = useMemo(() => buildFileTree(files), [files]);
  const [override, setOverride] = useState<Record<string, boolean>>({});
  const collapsed = (node: Extract<TreeNode, { kind: 'dir' }>) => override[node.path] ?? node.binaryOnly;
  const toggle = (node: Extract<TreeNode, { kind: 'dir' }>) =>
    setOverride((o) => ({ ...o, [node.path]: !collapsed(node) }));
  return (
    <div className="wt-diff-files">
      <TreeNodes
        nodes={tree}
        depth={0}
        activePath={activePath}
        onSelect={onSelect}
        collapsed={collapsed}
        toggle={toggle}
      />
    </div>
  );
}

function TreeNodes({
  nodes,
  depth,
  activePath,
  onSelect,
  collapsed,
  toggle,
}: {
  nodes: TreeNode[];
  depth: number;
  activePath?: string | null;
  onSelect: (path: string) => void;
  collapsed: (node: Extract<TreeNode, { kind: 'dir' }>) => boolean;
  toggle: (node: Extract<TreeNode, { kind: 'dir' }>) => void;
}) {
  return (
    <>
      {nodes.map((node) =>
        node.kind === 'file' ? (
          <FileRow
            key={node.file.path}
            file={node.file}
            display="name"
            indent={depth}
            active={node.file.path === activePath}
            onClick={() => onSelect(node.file.path)}
          />
        ) : (
          <div key={node.path} className="wt-tree-dir">
            <button
              type="button"
              className="wt-diff-group-head"
              style={{ paddingLeft: 8 + depth * 16 }}
              onClick={() => toggle(node)}
              title={node.path}
            >
              <span className="wt-diff-group-caret">{collapsed(node) ? '▸' : '▾'}</span>
              <span className="wt-diff-group-dir">{node.name}/</span>
              <span className="wt-diff-group-meta">
                <span className="wt-diff-group-n">{node.fileCount}</span>
                {node.binaryOnly ? (
                  <span className="session-file-bin">binary</span>
                ) : (
                  <>
                    <span className="add">+{node.add}</span>
                    <span className="del">−{node.del}</span>
                  </>
                )}
              </span>
            </button>
            {!collapsed(node) && (
              <TreeNodes
                nodes={node.children}
                depth={depth + 1}
                activePath={activePath}
                onSelect={onSelect}
                collapsed={collapsed}
                toggle={toggle}
              />
            )}
          </div>
        ),
      )}
    </>
  );
}

function FileRow({
  file,
  active,
  display = 'full',
  indent,
  onClick,
}: {
  file: SessionChangedFile;
  active?: boolean;
  /** 'full' shows the dimmed directory + bold basename; 'name' shows only the basename (for a
   *  row under a folder header that already carries the directory). */
  display?: 'full' | 'name';
  /** Tree depth — indents the row so it aligns under its folder. Omitted = flat (inline panel). */
  indent?: number;
  onClick?: () => void;
}) {
  const binary = file.additions < 0 || file.deletions < 0;
  const status = (file.status || 'M').slice(0, 1).toUpperCase();
  const { dir, name } = splitPath(file.path);
  return (
    <button
      type="button"
      className={`session-file session-file-btn${active ? ' active' : ''}`}
      style={indent != null ? { paddingLeft: 8 + indent * 16 } : undefined}
      onClick={onClick}
      title={`View diff · ${file.path}`}
    >
      <span className={`session-file-status st-${status.toLowerCase()}`} title={status}>
        {status}
      </span>
      <span className="session-file-path">
        {display === 'full' && dir && <span className="session-file-dir">{dir}</span>}
        <span className="session-file-name">{name}</span>
      </span>
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

  // Drag the drawer's left edge to widen it for a roomier review; the width persists, and a
  // double-click on the handle resets to the default. null → the responsive CSS default.
  const [width, setWidth] = useState<number | null>(() => {
    const s = Number(localStorage.getItem(WT_DIFF_WIDTH_KEY));
    return s >= WT_DIFF_WIDTH_MIN ? s : null;
  });
  const [resizing, setResizing] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const startResize = (e: ReactMouseEvent): void => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width ?? bodyRef.current?.getBoundingClientRect().width ?? 1100;
    let latest = startW;
    setResizing(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const onMove = (ev: MouseEvent): void => {
      // The drawer sits on the right, so dragging left (smaller clientX) widens it.
      latest = Math.min(window.innerWidth - 48, Math.max(WT_DIFF_WIDTH_MIN, startW + startX - ev.clientX));
      setWidth(latest);
    };
    const onUp = (): void => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setResizing(false);
      localStorage.setItem(WT_DIFF_WIDTH_KEY, String(Math.round(latest)));
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };
  const resetWidth = (): void => {
    setWidth(null);
    localStorage.removeItem(WT_DIFF_WIDTH_KEY);
  };

  // Unified (default) vs side-by-side split rendering of the diff, remembered across reloads.
  const [viewMode, setViewMode] = useState<'unified' | 'split'>(() =>
    localStorage.getItem(WT_DIFF_MODE_KEY) === 'split' ? 'split' : 'unified',
  );
  const changeViewMode = (m: 'unified' | 'split'): void => {
    setViewMode(m);
    localStorage.setItem(WT_DIFF_MODE_KEY, m);
  };

  // Prev/next file nav follows the grouped display order and skips binary files (no diff to show).
  const orderedPaths = useMemo(
    () =>
      treeFiles(buildFileTree(files))
        .filter((f) => f.additions >= 0 && f.deletions >= 0)
        .map((f) => f.path),
    [files],
  );
  const navIdx = active ? orderedPaths.indexOf(active.path) : -1;
  const prevPath = navIdx > 0 ? orderedPaths[navIdx - 1] : null;
  const nextPath = navIdx >= 0 && navIdx < orderedPaths.length - 1 ? orderedPaths[navIdx + 1] : null;
  const navPos = navIdx >= 0 ? `${navIdx + 1}/${orderedPaths.length}` : '';

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
      width={width ?? WT_DIFF_WIDTH_DEFAULT}
      open={openPath != null}
      onClose={onClose}
      title={
        <span className="wt-diff-head">
          <BranchLabel branch={branch} />
          <span className="wt-diff-head-sub">{committed ? 'committed' : 'working changes'}</span>
        </span>
      }
    >
      <div className="wt-diff-body" ref={bodyRef}>
        <div
          className={`wt-diff-resizer${resizing ? ' resizing' : ''}`}
          onMouseDown={startResize}
          onDoubleClick={resetWidth}
          title="Drag to resize · double-click to reset"
        />
        <div className="wt-diff-list">
          <FileTree files={files} activePath={openPath} onSelect={onSelect} />
        </div>
        <div className="wt-diff-pane">
          {active ? (
            <DiffPane
              file={active}
              patch={activePatch}
              loading={q.isLoading}
              refreshing={refreshing}
              viewMode={viewMode}
              onViewMode={changeViewMode}
              pos={navPos}
              onPrev={prevPath ? () => onSelect(prevPath) : undefined}
              onNext={nextPath ? () => onSelect(nextPath) : undefined}
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
  viewMode,
  onViewMode,
  pos,
  onPrev,
  onNext,
}: {
  file: SessionChangedFile;
  patch?: SessionFilePatch;
  loading?: boolean;
  refreshing?: boolean;
  viewMode: 'unified' | 'split';
  onViewMode: (m: 'unified' | 'split') => void;
  /** "3/17" position of this file within the navigable (non-binary) set. */
  pos: string;
  onPrev?: () => void;
  onNext?: () => void;
}) {
  const binary = file.additions < 0 || file.deletions < 0;
  return (
    <>
      <div className="wt-diff-pane-head">
        <span className="wt-diff-nav">
          <button type="button" onClick={onPrev} disabled={!onPrev} aria-label="Previous file" title="Previous file">
            ‹
          </button>
          <span className="wt-diff-nav-pos">{pos}</span>
          <button type="button" onClick={onNext} disabled={!onNext} aria-label="Next file" title="Next file">
            ›
          </button>
        </span>
        <span className="wt-diff-pane-path">{file.path}</span>
        {!binary && (
          <>
            <span className="wt-diff-pane-stat">
              <span className="add">+{file.additions}</span>
              <span className="del">−{file.deletions}</span>
            </span>
            <Segmented
              size="small"
              value={viewMode}
              onChange={(v) => onViewMode(v as 'unified' | 'split')}
              options={[
                { label: 'Unified', value: 'unified' },
                { label: 'Split', value: 'split' },
              ]}
            />
          </>
        )}
      </div>
      {binary ? (
        <div className="wt-diff-empty">Binary file — no preview</div>
      ) : patch?.patch ? (
        viewMode === 'split' ? <SplitDiffView patch={patch.patch} /> : <DiffView patch={patch.patch} />
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

type PatchLine = { type: 'add' | 'del' | 'ctx'; text: string; oldNo?: number; newNo?: number };
type PatchRow = PatchLine | { type: 'hunk'; text: string };

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
  const [expanded, setExpanded] = useState(false);
  useEffect(() => setExpanded(false), [patch]); // a freshly opened file starts capped again
  const capped = !expanded && rows.length > DIFF_ROW_CAP;
  const shown = capped ? rows.slice(0, DIFF_ROW_CAP) : rows;
  return (
    <div className="chat-diff wt-diff-view">
      {shown.map((r, k) =>
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
      {capped && (
        <button type="button" className="wt-diff-more" onClick={() => setExpanded(true)}>
          Show {rows.length - DIFF_ROW_CAP} more lines
        </button>
      )}
    </div>
  );
}

type SplitCell = { text: string; no?: number; kind: 'ctx' | 'add' | 'del' } | null;
type SplitRow = { type: 'pair'; left: SplitCell; right: SplitCell } | { type: 'hunk'; text: string };

/** Re-fold a parsed unified diff into side-by-side rows: context lines mirror on both sides, and
 *  a run of deletions/additions within a change block zips row-by-row (deletion left, addition
 *  right) so a modified line shows old-vs-new aligned; the longer side's leftovers stand alone. */
function toSplitRows(rows: PatchRow[]): SplitRow[] {
  const out: SplitRow[] = [];
  let dels: PatchLine[] = [];
  let adds: PatchLine[] = [];
  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) {
      const d = dels[i];
      const a = adds[i];
      out.push({
        type: 'pair',
        left: d ? { text: d.text, no: d.oldNo, kind: 'del' } : null,
        right: a ? { text: a.text, no: a.newNo, kind: 'add' } : null,
      });
    }
    dels = [];
    adds = [];
  };
  for (const r of rows) {
    if (r.type === 'hunk') {
      flush();
      out.push({ type: 'hunk', text: r.text });
    } else if (r.type === 'del') {
      dels.push(r);
    } else if (r.type === 'add') {
      adds.push(r);
    } else {
      flush();
      out.push({
        type: 'pair',
        left: { text: r.text, no: r.oldNo, kind: 'ctx' },
        right: { text: r.text, no: r.newNo, kind: 'ctx' },
      });
    }
  }
  flush();
  return out;
}

function SplitSide({ cell }: { cell: SplitCell }) {
  if (!cell) {
    return (
      <div className="diff-split-cell diff-split-empty">
        <span className="diff-ln" />
        <span className="diff-text" />
      </div>
    );
  }
  return (
    <div className={`diff-split-cell diff-${cell.kind}`}>
      <span className="diff-ln">{cell.no ?? ''}</span>
      <span className="diff-sign">{cell.kind === 'add' ? '+' : cell.kind === 'del' ? '-' : ' '}</span>
      <span className="diff-text">{cell.text}</span>
    </div>
  );
}

/** Side-by-side counterpart to DiffView: old on the left, new on the right. Shares the row cap. */
function SplitDiffView({ patch }: { patch: string }) {
  const rows = useMemo(() => toSplitRows(parseUnifiedDiff(patch)), [patch]);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => setExpanded(false), [patch]);
  const capped = !expanded && rows.length > DIFF_ROW_CAP;
  const shown = capped ? rows.slice(0, DIFF_ROW_CAP) : rows;
  return (
    <div className="chat-diff wt-diff-view wt-diff-split">
      {shown.map((r, k) =>
        r.type === 'hunk' ? (
          <div key={k} className="diff-line diff-gap diff-split-hunk">
            <span className="diff-text">{r.text}</span>
          </div>
        ) : (
          <div key={k} className="diff-split-row">
            <SplitSide cell={r.left} />
            <SplitSide cell={r.right} />
          </div>
        ),
      )}
      {capped && (
        <button type="button" className="wt-diff-more" onClick={() => setExpanded(true)}>
          Show {rows.length - DIFF_ROW_CAP} more rows
        </button>
      )}
    </div>
  );
}
