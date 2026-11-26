# Main checkout bar: the commits it hasn't pushed

Boards: `docs/mocks/main-checkout-unpushed-commits/01-web.png` (web) and `02-native.png` (iOS, macOS, Android).
Owner decisions (2026-11-26): every recommendation on both boards, as listed under Decided.

## Problem

The Main checkout bar reads "Clean · 4 commits not pushed" and offers Push. Nothing shows which commits those are:
the runner reports only `ahead: 4`. On the web the text can't be clicked. On iOS and macOS a tap opens a Review sheet
that says "No uncommitted files." On Android the row has no tap.

## Decided

1. **Web:** the whole bar row toggles, like the worktree bar's `.wt-row-toggle`, and opens the worktree bar's
   `CommitList` rows. A commit opens the session's right-side drawer in commit mode, with the message, files and that
   commit's own patches. The rail lists only the unpushed commits and has no "All changes" tab. When files are
   uncommitted too, the list starts with the pending row, which opens Review.
2. **Phones (iOS, Android):** a tap opens the Review sheet the bar already opens. The sheet gains a "Not pushed · N"
   group. With no uncommitted files, the empty file chooser is left out. With uncommitted files, the group sits below
   the files, folded to one row plus "N more". A commit opens the worktree bar's existing commit screen.
3. **macOS:** the same sheet, from the shared SwiftUI code.
4. **Cap:** the runner lists at most 20 commits (`MAIN_CHECKOUT_COMMITS_MAX`). Past that, the last line reads
   "and K more not listed" with `git log <upstream>..<branch>`.
5. No per-commit actions. Push stays on the bar.

## Contract (extends `docs/main-checkout-git-contract.md` §2 and §10)

- `MainCheckoutSnapshot.commits?: BranchCommit[]` holds `upstream..HEAD`, newest first, at most 20, using the
  existing `BranchCommit` shape (sha, subject, body, committedAt, files with numstat, filesTruncated).
  `commitsTruncated?: boolean` is set when `ahead` > 20. The field is absent when there is no upstream or HEAD is
  detached, and absent from older runners. Clients then draw today's bar, with no caret or ›.
- The list is on the snapshot (an on-demand read) only, never on the heartbeat.
- Snapshot read option `commit?: string` (full sha). When it is set, `diffPaths` are answered from that commit
  against its first parent (`git show`/`diff <sha>^ <sha> -- <path>`), with the same `MainCheckoutFileDiff` shape and
  byte cap. The runner refuses a sha that is not in `upstream..HEAD`: it serves no other history.
- Server: `GET /workspaces/:id/main-checkout` forwards `commit`. `validSnapshotAnswer` keeps at most 20 commits.

## Reuse

- Runner: `branchCommitsBetween(dir, base, tip)` in `src/runner-go/branch_commits.go`, called from
  `scanMainCheckout` in `src/runner-go/maincheckout.go`.
- Web: `CommitList` / `CommitRow` (`SessionCommits.tsx`), `WorktreeDiffDrawer` commit mode (`SessionOutputs.tsx`).
- Apple: the worktree commit screen in `WorktreeBar.swift`, `WorktreeCommitsLogic.swift`.
- Android: the commit screen in `reader/WorktreeBar.kt`, `WorktreeModel.kt`.

## Copy (English, shared across clients)

"N commits not pushed" (unchanged), "Not pushed · N", "On <branch>, not on <upstream>.", "and K more not listed",
"Uncommitted changes".
