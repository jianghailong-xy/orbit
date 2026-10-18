package main

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// landedCompareLimit bounds both sides of the landed comparison: the session's own commits, and
// the commits origin/<target> gained since its merge base with the source. Past it nothing is
// judged landed by patch-id and the merge replays what it always did — a partial comparison would
// be a guess. A var only so a test can reach the limit without writing thousands of commits.
var landedCompareLimit = 5000

// sessionLanding is what landedCommits found out about the session's own commits.
type sessionLanding struct {
	// The commit on origin/<target> that carries each landed one, newest first.
	Landed []MergeRecoveryLandedCommit
	// The landed session commits, which a replay leaves out.
	Skip map[string]bool
	// Every one of the session's own commits landed: there is nothing left to merge.
	All bool
}

// landedCommits answers which of the session's own commits already reached origin/<target>
// (remote) — the question a merge has to ask before replaying them. A commit that landed as a
// rebase copy or a cherry-pick, and that the target has since built on, conflicts with its own
// copy when it is replayed again, and no resolution can clear that: the resolution is already
// merged. The 2026-10-11 incident was exactly that, after a merged session's branch was rewritten.
//
// The session's own commits are the non-merge commits the replay covers: rangeBase..source, where
// rangeBase is the fork point replayAnchor proved, else remote itself. One has landed when it is an
// ancestor of remote, or when its patch-id (`git patch-id --stable`) equals that of a non-merge
// commit remote gained since its merge base with the source. Only origin counts: a copy that only
// the local target has is unpublished, and stays the local-ahead or diverged case it always was.
//
// git's own --cherry-mark first narrows remote's commits to the ones that can match — it hashes
// only the diffs whose changed paths make a match possible: ~0.4 s across 5000 commits of this
// repository, where hashing every diff took ~22 s — and `git patch-id --stable` then pairs each
// session commit with the remote commit carrying it. Any failure, and either side past
// landedCompareLimit, answers "nothing landed": the merge then replays exactly what it did before.
func landedCommits(root, rangeBase, source, remote string) sessionLanding {
	if rangeBase == "" {
		rangeBase = remote
	}
	limit := strconv.Itoa(landedCompareLimit + 1)
	out, err := git(root, "rev-list", "--reverse", "--topo-order", "--no-merges", "--max-count="+limit, rangeBase+".."+source)
	own := splitLines(out)
	if err != nil || len(own) == 0 || len(own) > landedCompareLimit {
		return sessionLanding{}
	}
	// The ones origin does not have as themselves: only a copy can still account for these.
	out, err = git(root, "rev-list", "--no-merges", source, "^"+rangeBase, "^"+remote)
	if err != nil {
		return sessionLanding{}
	}
	pending := map[string]bool{}
	for _, sha := range splitLines(out) {
		pending[sha] = true
	}
	carriedBy := map[string]string{}
	for _, sha := range own {
		if !pending[sha] {
			carriedBy[sha] = sha
		}
	}
	if len(pending) > 0 {
		for sha, copy := range landedCopies(root, source, remote, pending) {
			carriedBy[sha] = copy
		}
	}
	if len(carriedBy) == 0 {
		return sessionLanding{}
	}

	shas := make([]string, 0, len(carriedBy))
	for _, sha := range carriedBy {
		shas = append(shas, sha)
	}
	details, err := landedCommitDetails(root, shas)
	if err != nil {
		return sessionLanding{}
	}
	landing := sessionLanding{Skip: map[string]bool{}, All: len(carriedBy) == len(own)}
	for i := len(own) - 1; i >= 0; i-- {
		sha := own[i]
		if carriedBy[sha] == "" {
			continue
		}
		commit, ok := details[carriedBy[sha]]
		if !ok {
			return sessionLanding{}
		}
		landing.Landed = append(landing.Landed, MergeRecoveryLandedCommit{MergeRecoveryCommit: commit, SourceSha: sha})
		landing.Skip[sha] = true
	}
	return landing
}

// landedCopies pairs each pending session commit with the newest non-merge commit remote gained
// since its merge base with the source that has the same stable patch-id. Nothing on any failure,
// or when remote gained more than landedCompareLimit commits.
func landedCopies(root, source, remote string, pending map[string]bool) map[string]string {
	count, err := git(root, "rev-list", "--count", "--no-merges", source+".."+remote)
	if n, convErr := strconv.Atoi(count); err != nil || convErr != nil || n > landedCompareLimit {
		return nil
	}
	out, err := git(root, "rev-list", "--no-merges", "--cherry-mark", "--right-only", source+"..."+remote)
	if err != nil {
		return nil
	}
	var candidates []string
	for _, line := range splitLines(out) {
		if sha, ok := strings.CutPrefix(line, "="); ok {
			candidates = append(candidates, sha)
		}
	}
	if len(candidates) == 0 {
		return nil
	}
	shas := append([]string{}, candidates...)
	for sha := range pending {
		shas = append(shas, sha)
	}
	ids, err := patchIDs(root, shas)
	if err != nil {
		return nil
	}
	// rev-list lists newest first, so the first commit seen for a patch-id is the newest carrying it.
	byID := map[string]string{}
	for _, sha := range candidates {
		if id := ids[sha]; id != "" && byID[id] == "" {
			byID[id] = sha
		}
	}
	copies := map[string]string{}
	for sha := range pending {
		if id := ids[sha]; id != "" && byID[id] != "" {
			copies[sha] = byID[id]
		}
	}
	return copies
}

// patchIDs maps each commit to its stable patch-id. diff-tree prints each commit's name ahead of its
// patch, which is a form `git patch-id` reads; --full-index keeps a binary change's blob names whole.
// A commit whose diff is empty has no patch-id, and no entry.
func patchIDs(root string, shas []string) (map[string]string, error) {
	diff := exec.Command("git", "-C", root, "diff-tree", "--stdin", "--root", "-p", "--full-index")
	diff.Stdin = strings.NewReader(strings.Join(shas, "\n") + "\n")
	patches, err := diff.StdoutPipe()
	if err != nil {
		return nil, err
	}
	ids := exec.Command("git", "-C", root, "patch-id", "--stable")
	ids.Stdin = patches
	var out bytes.Buffer
	ids.Stdout = &out
	if err := diff.Start(); err != nil {
		return nil, err
	}
	if err := ids.Run(); err != nil {
		// Nothing reads the patches any more; don't leave diff-tree blocked on a full pipe.
		_ = diff.Process.Kill()
		_ = diff.Wait()
		return nil, err
	}
	if err := diff.Wait(); err != nil {
		return nil, err
	}
	result := map[string]string{}
	for _, line := range splitLines(out.String()) {
		if fields := strings.Fields(line); len(fields) == 2 {
			result[fields[1]] = fields[0]
		}
	}
	return result, nil
}

// landedCommitDetails reads the commits on origin that carry the session's work. Their date is the
// committer date: when the commit was written onto origin's history, which for a rebase copy is
// when it merged. The author date a copy keeps names when the session first wrote the change.
func landedCommitDetails(root string, shas []string) (map[string]MergeRecoveryCommit, error) {
	out, err := git(root, append([]string{"show", "-s", "--format=%H%x1f%s%x1f%an%x1f%cI"}, shas...)...)
	if err != nil {
		return nil, err
	}
	details := map[string]MergeRecoveryCommit{}
	for _, line := range splitLines(out) {
		fields := strings.Split(line, "\x1f")
		if len(fields) != 4 {
			return nil, fmt.Errorf("could not read commit details")
		}
		details[fields[0]] = MergeRecoveryCommit{Sha: fields[0], Subject: fields[1], Author: fields[2], Date: fields[3]}
	}
	return details, nil
}

// alreadyLandedOutcome reports a session whose every commit is already on origin/<target>: nothing
// is replayed, nothing is pushed and no branch moves. An error carrying the ALREADY_LANDED recovery
// rather than a merge, because no landing happened here — confirming that these copies are this
// session's work is the owner's call. The local target's own commits are listed the way a check
// lists them; they belong to that checkout, not to this session, and nothing here pushes them.
func alreadyLandedOutcome(root string, r *MergeRecovery, landed []MergeRecoveryLandedCommit) mergeOutcome {
	r.LandedCommits = landed
	if r.CheckedAt == "" {
		r.CheckedAt = time.Now().UTC().Format(time.RFC3339)
	}
	if r.LocalCommits == nil && r.RemoteCommits == nil && r.LocalSha != r.RemoteSha {
		// Left out past the commit cap, as a check leaves them out.
		r.LocalCommits, _ = recoveryCommits(root, r.RemoteSha, r.LocalSha)
		r.RemoteCommits, _ = recoveryCommits(root, r.LocalSha, r.RemoteSha)
	}
	logln(fmt.Sprintf("origin/%s already has every commit of %s (%d) — nothing to merge",
		r.TargetBranch, shortSha(r.SourceSha), len(landed)))
	return recoveryError(r, "ALREADY_LANDED", "every commit of this session is already on origin/"+r.TargetBranch+" — nothing is left to merge")
}

// replaySource replays the session's commits — the source, checked out detached at HEAD in dir —
// onto newBase: from the fork point when replayAnchor proved one, else everything newBase lacks.
// Commits in landed are already on origin/<target> as copies (see landedCommits) and are left out:
// replaying them would conflict with their own copies as soon as the target built on those.
//
// With nothing landed this is the plain `git rebase` it always was. Otherwise it is the same rebase
// with its todo list written out — `pick` for each commit git would replay, in git's order, and
// `drop` for the landed ones — since a todo list is git's only way to leave out a named commit.
// Writing the drops (rather than deleting their lines) keeps rebase.missingCommitsCheck=error
// satisfied, and --empty=drop keeps what the non-interactive rebase does with a commit that turns
// out empty, where an interactive one would stop. A conflict leaves the same state to finish with
// `git rebase --continue` or to abort.
func replaySource(dir, newBase, anchor, sourceSha string, landed map[string]bool) (string, error) {
	upstream, args := newBase, []string{"rebase", newBase}
	if anchor != "" {
		upstream, args = anchor, []string{"rebase", "--onto", newBase, anchor}
	}
	if len(landed) == 0 {
		return git(dir, args...)
	}
	// The commits the rebase itself would pick, in its order: non-merge, oldest first, and without
	// those already in newBase as another commit.
	out, err := git(dir, "rev-list", "--reverse", "--topo-order", "--no-merges", "--cherry-pick", "--right-only", upstream+"..."+sourceSha)
	if err != nil {
		return "", err
	}
	var todo strings.Builder
	dropped := 0
	for _, sha := range splitLines(out) {
		command := "pick"
		if landed[sha] {
			command = "drop"
			dropped++
		}
		todo.WriteString(command + " " + sha + "\n")
	}
	if dropped == 0 {
		return git(dir, args...)
	}
	file, err := os.CreateTemp("", "orbit-replay-todo-")
	if err != nil {
		return "", fmt.Errorf("could not write the replay's todo list: %w", err)
	}
	defer os.Remove(file.Name())
	if _, err := file.WriteString(todo.String()); err != nil {
		file.Close()
		return "", fmt.Errorf("could not write the replay's todo list: %w", err)
	}
	if err := file.Close(); err != nil {
		return "", fmt.Errorf("could not write the replay's todo list: %w", err)
	}
	logln(fmt.Sprintf("replaying %s onto %s without %d commit(s) already on origin", shortSha(sourceSha), shortSha(newBase), dropped))
	env := append(os.Environ(), "GIT_SEQUENCE_EDITOR=cp "+shellQuote(file.Name()))
	return gitEnv(dir, env, "rebase", "-i", "--empty=drop", "--onto", newBase, upstream)
}
