package main

import (
	"strconv"
	"strings"
)

// The commits a session's branch holds, for the status bar's commit list (docs/mocks/session-commits-first). The
// bar counts a session's work in commits: one intent each, in the words of whoever made it, with that commit's own
// files under it. They are read from git each time a report is built, so a commit the agent made mid-turn, one
// rebased away, or the runner's own end-of-session commit all show as the branch now holds them.

// orbitSavedTrailer marks a commit the runner made itself rather than the agent: the end-of-session commit that
// keeps uncommitted work (finalizeWorktree) and the owner's Commit button (commitWorktree). The list labels it
// "Auto-saved by Orbit", so it does not read as the agent's stated intent. Its value says which.
const orbitSavedTrailer = "Orbit-Saved"

const (
	orbitSavedSessionEnd   = "session-end"
	orbitSavedCommitButton = "commit-button"
)

// branchCommitsMax is the most commits a report lists, newest first. A branch with more is a moved base rather than
// one session's work, like a diff past maxChangedFiles.
const branchCommitsMax = 100

// branchCommitFilesMax is the most files one commit lists; Files is cut there and FilesTruncated set.
const branchCommitFilesMax = 100

// branchCommitBodyMaxRunes caps a commit's message body as reported.
const branchCommitBodyMaxRunes = 4000

// BranchCommit is one commit of a session's branch, between its base and its tip. Mirrors @orbit/shared BranchCommit.
type BranchCommit struct {
	Sha         string `json:"sha"`
	Subject     string `json:"subject"`
	Body        string `json:"body,omitempty"`
	CommittedAt string `json:"committedAt"`
	// SavedBy is the Orbit-Saved trailer's value when the runner made this commit itself ("session-end",
	// "commit-button", "checkpoint" for a park checkpoint undone on resume); "" for a commit the agent made.
	SavedBy        string             `json:"savedBy,omitempty"`
	Files          []BranchCommitFile `json:"files"`
	FilesTruncated bool               `json:"filesTruncated,omitempty"`
}

// BranchCommitFile is one file a commit changed. Additions/Deletions are -1 for a binary file, as in ChangedFile.
type BranchCommitFile struct {
	Path      string `json:"path"`
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
}

// branchCommits lists the commits of the session's branch from its base to its tip, newest first. Nil when there is
// no branch to read (no worktree, no base, a tip git cannot resolve), which a report sends as "not reported"; an
// empty list when the branch holds no commit of its own.
func branchCommits(wt *Worktree) []BranchCommit {
	if wt == nil || wt.RepoDir == "" {
		return nil
	}
	base, tip := wt.baseSha(), effectiveBranchSha(wt)
	if base == "" || tip == "" {
		return nil
	}
	return branchCommitsBetween(wt.RepoDir, base, tip)
}

// branchCommitsBetween is branchCommits over a range of a repository. --first-parent leaves out the commits a merge of
// the target into the branch brought in, and --no-merges the merge commit itself: bringing main in is no step of the
// session's own work, and its diff against the branch is everything main changed meanwhile (on 2026-11-20 one such
// merge listed 100 files beside a 6-file fix).
func branchCommitsBetween(dir, base, tip string) []BranchCommit {
	if base == tip {
		return []BranchCommit{}
	}
	out, err := git(dir, branchCommitsLogArgs(base, tip, branchCommitsMax)...)
	return readBranchCommits(dir, out, err)
}

// branchCommitsLogArgs is the git log that lists at most limit commits of base..tip, with any extra log options.
func branchCommitsLogArgs(base, tip string, limit int, extra ...string) []string {
	args := []string{"log", "--first-parent", "--no-merges", "--no-color", "-n", strconv.Itoa(limit),
		"--format=%x1e%H%x1f%cI%x1f%s%x1f%b%x1d", "--numstat"}
	return append(append(args, extra...), base+".."+tip)
}

// readBranchCommits reads that log's answer, secrets redacted; nil when git failed.
func readBranchCommits(dir, out string, err error) []BranchCommit {
	if err != nil {
		logln("branch commits failed in", dir+":", err)
		return nil
	}
	commits := parseBranchCommits(out)
	if r := runnerSecrets().scrubber(); r != nil {
		for i := range commits {
			commits[i].Subject, commits[i].Body = r.redact(commits[i].Subject), r.redact(commits[i].Body)
		}
	}
	return commits
}

// parseBranchCommits reads branchCommitsBetween's log: one record per commit, opened by 0x1E, its header fields split
// by 0x1F and closed by 0x1D, then that commit's --numstat lines.
func parseBranchCommits(out string) []BranchCommit {
	commits := []BranchCommit{}
	for _, rec := range strings.Split(out, "\x1e") {
		head, stats, ok := strings.Cut(rec, "\x1d")
		if !ok {
			continue
		}
		f := strings.SplitN(head, "\x1f", 4)
		if len(f) != 4 || f[0] == "" {
			continue
		}
		body, savedBy := splitOrbitTrailers(f[3])
		if r := []rune(body); len(r) > branchCommitBodyMaxRunes {
			body = string(r[:branchCommitBodyMaxRunes]) + "..."
		}
		c := BranchCommit{Sha: f[0], CommittedAt: f[1], Subject: f[2], Body: body, SavedBy: savedBy,
			Files: []BranchCommitFile{}}
		for _, line := range strings.Split(stats, "\n") {
			parts := strings.SplitN(line, "\t", 3)
			if len(parts) != 3 {
				continue
			}
			if len(c.Files) == branchCommitFilesMax {
				c.FilesTruncated = true
				break
			}
			c.Files = append(c.Files, BranchCommitFile{Path: parts[2], Additions: numstatCount(parts[0]),
				Deletions: numstatCount(parts[1])})
		}
		commits = append(commits, c)
	}
	return commits
}

// splitOrbitTrailers takes Orbit's own trailers out of a commit body and says which runner commit it marks: the
// Orbit-Saved value, or "checkpoint" for a park checkpoint (parkCheckpointTrailer).
func splitOrbitTrailers(body string) (string, string) {
	savedBy := ""
	var kept []string
	for _, line := range strings.Split(body, "\n") {
		key, value, ok := strings.Cut(line, ": ")
		switch {
		case ok && key == orbitSavedTrailer:
			savedBy = strings.TrimSpace(value)
		case ok && key == parkCheckpointTrailer:
			savedBy = "checkpoint"
		default:
			kept = append(kept, line)
		}
	}
	return strings.TrimSpace(strings.Join(kept, "\n")), savedBy
}

func numstatCount(s string) int {
	n, err := strconv.Atoi(s)
	if err != nil {
		return -1
	}
	return n
}

// withOrbitSaved appends the Orbit-Saved trailer to a commit message the runner writes itself.
func withOrbitSaved(msg, why string) string {
	return strings.TrimRight(msg, "\n") + "\n\n" + orbitSavedTrailer + ": " + why
}
