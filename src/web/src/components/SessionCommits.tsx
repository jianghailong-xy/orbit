import type { BranchCommit } from '@orbit/shared';
import type { SessionChangedFile } from '../api';
import { ago } from '../lib/watches';

/**
 * The worktree bar counted in commits (docs/mocks/session-commits-first): what the session did is
 * a list of commits, one intent each in the words of whoever made it, and the files sit under a
 * commit. These are the pieces SessionOutputs draws them with: the collapsed row's summary, the
 * expanded list above the composer, the drawer's commit rail and the head over a commit's diff.
 */

/** The runner lists at most this many (branch_commits.go branchCommitsMax). */
const COMMITS_MAX = 100;

export function commitCountLabel(n: number): string {
  if (n >= COMMITS_MAX) return `${COMMITS_MAX}+ commits`;
  return `${n} ${n === 1 ? 'commit' : 'commits'}`;
}

/** What a runner-made commit is labelled, so it never reads as the agent's stated intent. Null for
 *  the agent's own commit. */
export function savedByLabel(savedBy?: string | null): { label: string; title: string } | null {
  switch (savedBy) {
    case undefined:
    case null:
    case '':
      return null;
    case 'commit-button':
      return { label: 'Saved with Commit', title: 'Orbit committed this when Commit was pressed; the message is generated from the diff.' };
    case 'checkpoint':
      return { label: 'Auto-saved by Orbit', title: 'A checkpoint Orbit saved while the session was parked; it is undone when the session resumes.' };
    default:
      return { label: 'Auto-saved by Orbit', title: 'Work left uncommitted when the session ended, saved by Orbit; the message is generated from the diff.' };
  }
}

export function commitStat(commit: BranchCommit): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const f of commit.files) {
    add += Math.max(0, f.additions);
    del += Math.max(0, f.deletions);
  }
  return { add, del };
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** A commit's files as the drawer's file list takes them. */
export function commitChangedFiles(commit: BranchCommit): SessionChangedFile[] {
  return commit.files.map((f) => ({ ...f, status: '' }));
}

/** The collapsed row's lead: the count, "+ uncommitted" while there is work no commit holds, and
 *  the newest subject (alone when it is the only commit). No commit yet reads as uncommitted files. */
export function CommitSummary({
  commits,
  dirty,
  fileCount,
}: {
  commits: BranchCommit[];
  dirty: boolean;
  fileCount: number;
}) {
  if (commits.length === 0) {
    return (
      <span className="wt-commits-lead">
        <span className="wt-commits-count">Uncommitted</span>
        <span className="wt-dim">
          · {fileCount} {fileCount === 1 ? 'file' : 'files'}
        </span>
      </span>
    );
  }
  const latest = commits[0];
  return (
    <span className="wt-commits-lead">
      {commits.length > 1 && <span className="wt-commits-count">{commitCountLabel(commits.length)}</span>}
      {dirty && <span className="wt-commit-tag wt-commit-tag-pending">+ uncommitted</span>}
      <span className="wt-commits-subject" title={latest.subject}>
        {commits.length > 1 && <span className="wt-dim">· latest: </span>}
        {latest.subject}
      </span>
    </span>
  );
}

function CommitRow({
  commit,
  now,
  active,
  onOpen,
}: {
  commit: BranchCommit;
  now: number;
  active?: boolean;
  onOpen: () => void;
}) {
  const { add, del } = commitStat(commit);
  const saved = savedByLabel(commit.savedBy);
  const n = commit.files.length;
  return (
    <button
      type="button"
      className={`wt-commit-row${active ? ' active' : ''}`}
      data-row-focus=""
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      title={commit.body ? `${commit.subject}\n\n${commit.body}` : commit.subject}
    >
      <span className={`wt-commit-dot${saved ? ' wt-commit-dot-auto' : ''}`} aria-hidden="true" />
      <span className="wt-commit-text">
        <span className="wt-commit-subject">{commit.subject || '(no message)'}</span>
        <span className="wt-commit-meta">
          <code className="wt-commit-sha">{shortSha(commit.sha)}</code>
          <span>
            · {ago(commit.committedAt, now)} · {n}
            {commit.filesTruncated ? '+' : ''} {n === 1 ? 'file' : 'files'}
          </span>
          {saved && (
            <span className="wt-commit-tag" title={saved.title}>
              {saved.label}
            </span>
          )}
        </span>
      </span>
      <span className="wt-commit-stat">
        <span className="wt-add">+{add}</span>
        <span className="wt-del">−{del}</span>
      </span>
    </button>
  );
}

function PendingRow({ active, onOpen }: { active?: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      className={`wt-commit-row${active ? ' active' : ''}`}
      data-row-focus=""
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      title="Changes in the worktree that no commit holds yet"
    >
      <span className="wt-commit-dot wt-commit-dot-pending" aria-hidden="true" />
      <span className="wt-commit-text">
        <span className="wt-commit-subject">Uncommitted changes</span>
        <span className="wt-commit-meta">Not committed yet · shown under All changes</span>
      </span>
    </button>
  );
}

/** The expanded bar: uncommitted work first, then the commits newest first, then the whole-branch view. */
export function CommitList({
  commits,
  dirty,
  fileCount,
  baseLabel,
  onOpenCommit,
  onOpenAll,
}: {
  commits: BranchCommit[];
  dirty: boolean;
  fileCount: number;
  /** "develop @ e9f1c07": what All changes is measured against. */
  baseLabel?: string | null;
  onOpenCommit: (sha: string) => void;
  onOpenAll: () => void;
}) {
  const now = Date.now();
  return (
    <div className="wt-commits-panel" onClick={(e) => e.stopPropagation()}>
      {(dirty || commits.length === 0) && <PendingRow onOpen={onOpenAll} />}
      {commits.map((c) => (
        <CommitRow key={c.sha} commit={c} now={now} onOpen={() => onOpenCommit(c.sha)} />
      ))}
      <div className="wt-commits-foot">
        <button type="button" className="wt-commits-all" onClick={onOpenAll}>
          All changes
        </button>
        <span className="wt-dim">
          · {fileCount} {fileCount === 1 ? 'file' : 'files'}
        </span>
        <span className="wt-spacer" />
        {baseLabel && <span className="wt-dim">based on {baseLabel}</span>}
      </div>
    </div>
  );
}

/** The drawer rail's switch between one commit at a time and the whole branch. */
export function CommitRailTabs({
  commitCount,
  fileCount,
  showingCommits,
  onCommits,
  onAll,
}: {
  commitCount: number;
  fileCount: number;
  showingCommits: boolean;
  onCommits: () => void;
  onAll: () => void;
}) {
  return (
    <div className="wt-rail-tabs" role="tablist">
      <button type="button" role="tab" aria-selected={showingCommits}
        className={`wt-rail-tab${showingCommits ? ' on' : ''}`} onClick={onCommits}>
        Commits {commitCount >= COMMITS_MAX ? `${COMMITS_MAX}+` : commitCount}
      </button>
      <button type="button" role="tab" aria-selected={!showingCommits}
        className={`wt-rail-tab${showingCommits ? '' : ' on'}`} onClick={onAll}>
        All changes {fileCount}
      </button>
    </div>
  );
}

/** The drawer rail's commit list, the open one marked. */
export function CommitRail({
  commits,
  activeSha,
  onSelect,
}: {
  commits: BranchCommit[];
  activeSha: string | null;
  onSelect: (sha: string) => void;
}) {
  const now = Date.now();
  return (
    <div className="wt-rail-commits">
      {commits.map((c) => (
        <CommitRow key={c.sha} commit={c} now={now} active={c.sha === activeSha} onOpen={() => onSelect(c.sha)} />
      ))}
    </div>
  );
}

/** Over a commit's diff: its message first, the why, then what the diff below shows. */
export function CommitHead({ commit, mixed }: { commit: BranchCommit; mixed: boolean }) {
  const { add, del } = commitStat(commit);
  const saved = savedByLabel(commit.savedBy);
  return (
    <div className="wt-commit-head">
      <div className="wt-commit-head-subject">{commit.subject || '(no message)'}</div>
      <div className="wt-commit-meta">
        <code className="wt-commit-sha">{shortSha(commit.sha)}</code>
        <span>· {ago(commit.committedAt, Date.now())}</span>
        <span className="wt-add">+{add}</span>
        <span className="wt-del">−{del}</span>
        <span>
          · {commit.files.length} {commit.files.length === 1 ? 'file' : 'files'}
        </span>
        {saved && (
          <span className="wt-commit-tag" title={saved.title}>
            {saved.label}
          </span>
        )}
      </div>
      {commit.body && <div className="wt-commit-head-body">{commit.body}</div>}
      {mixed && (
        <div className="wt-commit-head-note">
          This file has other changes on the branch too, so its diff below is the file’s whole change, not this commit’s alone.
        </div>
      )}
    </div>
  );
}
