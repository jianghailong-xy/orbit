package main

import (
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
)

// A repository can name paths its session checkouts leave out (docs/session-checkout-storage-design.md §6): a
// checkout of the Orbit repository is 1.8 GiB, and nine tenths of that are evidence and mockups no session reads.
// The runner makes such a session checkout sparse, stages with --sparse in it so that what an agent writes under a
// left-out path still reaches its branch (addAllArgs), and tells the agent what is left out
// (checkoutInstructions). Only session checkouts are ever made sparse: the workspace's own directory and the
// scratch checkouts of merges and integration checks run whatever the repository's tests read.

// checkoutExcludeFile is that declaration: one pattern a line in gitignore syntax, # for comments. It is read from
// the commit a checkout forks from, so it is versioned with the code it describes and can differ per branch.
const checkoutExcludeFile = ".orbit/checkout-exclude"

// checkoutExclusions are the patterns the declaration at rev names, in its order: none when rev has no
// declaration, or there is no rev to read it from.
func checkoutExclusions(repoRoot, rev string) []string {
	if rev == "" {
		return nil
	}
	// `git show` would print a tree at that path as a listing; cat-file reads a file or nothing.
	out, err := git(repoRoot, "cat-file", "blob", rev+":"+checkoutExcludeFile)
	if err != nil {
		return nil
	}
	var patterns []string
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimRight(line, "\r")
		if strings.TrimSpace(line) == "" || strings.HasPrefix(line, "#") {
			continue
		}
		patterns = append(patterns, line)
	}
	return patterns
}

// sparseCheckoutPatterns is what `git sparse-checkout set --no-cone` is given for a declaration: every path, then
// each declared pattern negated. A declared `!pattern`, which brings a path back in gitignore syntax, is a plain
// pattern here; the last pattern that matches decides in both.
func sparseCheckoutPatterns(declared []string) []string {
	patterns := []string{"/*"}
	for _, p := range declared {
		if back, ok := strings.CutPrefix(p, "!"); ok {
			if back != "" {
				patterns = append(patterns, back)
			}
			continue
		}
		patterns = append(patterns, "!"+p)
	}
	return patterns
}

// gitVersion is what `git --version` says. A variable, so that a test can be an older git.
var gitVersion = func() (string, error) {
	out, err := exec.Command("git", "--version").Output()
	return strings.TrimSpace(string(out)), err
}

var gitVersionNumber = regexp.MustCompile(`(\d+)\.(\d+)`)

// gitTooOldForSparse is why this machine's git cannot keep a sparse session checkout, or "" when it can. What it
// needs is `git add --sparse`, which stages a new file under a left-out path and arrived in git 2.34.
func gitTooOldForSparse() string {
	version, err := gitVersion()
	if err != nil {
		return "`git --version` failed: " + err.Error()
	}
	m := gitVersionNumber.FindStringSubmatch(version)
	if m == nil {
		return fmt.Sprintf("`git --version` named no version: %q", version)
	}
	major, _ := strconv.Atoi(m[1])
	minor, _ := strconv.Atoi(m[2])
	if major < 2 || major == 2 && minor < 34 {
		return version + " is older than 2.34, the first git with `git add --sparse`"
	}
	return ""
}

// addSessionCheckout makes a session's checkout at wtPath with `git worktree add <args>`, the arguments a full
// checkout takes, and makes it sparse when the declaration at rev, the session's fork point, names paths to leave
// out and this git can keep a sparse checkout. Otherwise the checkout is the full one it always was, and the log
// says why. An error leaves no checkout behind, as a failed `git worktree add` does, so that what a caller does
// when the checkout cannot be made goes on as before.
func addSessionCheckout(sessionID, repoRoot, wtPath, rev string, args ...string) error {
	full := func(why string) error {
		logln(fmt.Sprintf("session %s — full checkout: %s", sessionID, why))
		_, err := git(repoRoot, append([]string{"worktree", "add"}, args...)...)
		return err
	}
	if rev == "" {
		return full("the session has no fork point to read " + checkoutExcludeFile + " from")
	}
	declared := checkoutExclusions(repoRoot, rev)
	if len(declared) == 0 {
		return full(fmt.Sprintf("no paths to leave out in %s at %s", checkoutExcludeFile, shortSha(rev)))
	}
	if why := gitTooOldForSparse(); why != "" {
		return full(fmt.Sprintf("%s at %s names paths to leave out, but %s", checkoutExcludeFile, shortSha(rev), why))
	}
	if _, err := git(repoRoot, append([]string{"worktree", "add", "--no-checkout"}, args...)...); err != nil {
		return err
	}
	// git 2.34 has no --no-cone for `set` (2.35 gave it one) and keeps it as one more pattern, which only a path of
	// that name matches; that version's `set` makes a non-cone checkout anyway (measured with Ubuntu 22.04's 2.34.1).
	sparse := true
	if _, err := git(wtPath, append([]string{"sparse-checkout", "set", "--no-cone"}, sparseCheckoutPatterns(declared)...)...); err != nil {
		logln(fmt.Sprintf("session %s — the checkout could not be made sparse, so it holds every path: %v", sessionID, err))
		_, _ = git(wtPath, "sparse-checkout", "disable")
		sparse = false
	}
	// `worktree add --no-checkout` wrote no index and no files: this is the checkout it left out, of the paths
	// the patterns keep.
	if _, err := git(wtPath, "reset", "-q", "--hard"); err != nil {
		_, _ = git(repoRoot, "worktree", "remove", "--force", wtPath)
		_ = os.RemoveAll(wtPath)
		_, _ = git(repoRoot, "worktree", "prune")
		return err
	}
	if sparse {
		logln(fmt.Sprintf("session %s — sparse checkout: %s at %s leaves out %s", sessionID, checkoutExcludeFile, shortSha(rev), strings.Join(declared, ", ")))
	}
	return nil
}

// sparseCheckout reports whether the checkout at dir leaves paths out: core.sparseCheckout, which `git
// sparse-checkout` sets in that checkout's own configuration and in no other checkout's.
func (ops worktreeGitOps) sparseCheckout(dir string) bool {
	out, err := ops.run(dir, "config", "--bool", "--get", "core.sparseCheckout")
	return err == nil && out == "true"
}

// addAllArgs is `git add -A` for a session checkout. In a sparse one it carries --sparse: without it, a new file
// under a left-out path makes `add -A` exit 1 and stay unstaged (git 2.47.3), so the session's work would not reach
// its branch. A git too old for --sparse (gitTooOldForSparse), which is never given a sparse checkout to make,
// stages as it always did.
func (ops worktreeGitOps) addAllArgs(dir string) []string {
	if ops.sparseCheckout(dir) && gitTooOldForSparse() == "" {
		return []string{"add", "-A", "--sparse"}
	}
	return []string{"add", "-A"}
}

func addAllArgs(dir string) []string { return unboundedWorktreeGitOps.addAllArgs(dir) }

// checkoutInstructions is what a session's engine is told about the sparse checkout it runs in (sparseCheckoutNote),
// so that a missing directory reads as left out rather than as gone. "" for any other checkout.
func checkoutInstructions(wt *Worktree) string {
	if wt == nil || wt.Path == "" || !unboundedWorktreeGitOps.sparseCheckout(wt.Path) {
		return ""
	}
	return sparseCheckoutNote(checkoutExclusions(wt.RepoDir, wt.baseSha()))
}

// sparseCheckoutNoteMaxPaths is how many left-out paths sparseCheckoutNote names; past it, it counts the rest.
const sparseCheckoutNoteMaxPaths = 12

// sparseCheckoutNote names the paths a declaration leaves out and says how to bring one in; "" when it leaves
// nothing out. ASCII, like the rest of the instructions it goes out with.
func sparseCheckoutNote(declared []string) string {
	var left []string
	for _, p := range declared {
		if !strings.HasPrefix(p, "!") {
			left = append(left, "`"+p+"`")
		}
	}
	if len(left) == 0 {
		return ""
	}
	named := strings.Join(left, ", ")
	if len(left) > sparseCheckoutNoteMaxPaths {
		named = strings.Join(left[:sparseCheckoutNoteMaxPaths], ", ") + fmt.Sprintf(" and %d more", len(left)-sparseCheckoutNoteMaxPaths)
	}
	return "This session's checkout is sparse: as the repository's " + checkoutExcludeFile + " declares, it leaves out " +
		named + ". Those paths are in git but not on disk here. To work in one, bring it in first with " +
		"`git sparse-checkout add <path>`; it then stays in this checkout. A new file you write under a left-out path " +
		"is still committed with your work; to stage one yourself, use `git add --sparse`."
}
