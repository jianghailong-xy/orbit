package main

import (
	"bufio"
	"bytes"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// The repositories on a managed runner's volume after an unclean stop (see volume_durability.go).
//
// The runner syncs the volume before it reports work and behind every tool an engine runs. What a
// power cut can still leave is Git work of its last moments, a sync's time or less before the cut:
//
//   - A lock file. Git writes a ref, the index or the config into <file>.lock and renames it into
//     place; a cut between the two can leave the lock, and Git refuses to touch that file again
//     ("File exists") until somebody removes it. A managed runner's volume is its own and nothing runs
//     Git there before the runner starts, so a lock no process holds is a leftover.
//   - A branch, HEAD or commit that cannot be read: the empty files of a write that had not reached
//     the disk (T02). A broken branch is restored from its own reflog when an entry there still
//     reads.
//
// What cannot be restored is said, once at start and again to every session that would work there,
// which is refused (checkoutDamage) instead of running in the workDir without a checkout or starting
// a new repository over the broken one, as setupWorktree's fallbacks would.

// recoverManagedRepositories is a managed runner's first look at the repositories on its volume,
// before anything runs Git there: the checkouts under reposRoot and the sessions' worktrees. Stale
// locks are removed, broken branches restored where their reflog allows it, the rest logged.
// Nothing for a self-managed runner.
func recoverManagedRepositories() {
	if !managedVolumeDurable() {
		return
	}
	checkouts := managedCheckouts()
	var removed, restored, damaged []string
	commonDirs := map[string]bool{}
	for _, checkout := range checkouts {
		if _, common := checkoutGitDirs(checkout); common != "" && !commonDirs[common] {
			commonDirs[common] = true
			removed = append(removed, clearStaleGitLocks(common)...)
		}
	}
	for _, checkout := range checkouts {
		if checkoutDamage(checkout) == "" {
			continue
		}
		if note := restoreCheckoutBranch(checkout); note != "" {
			restored = append(restored, note)
		}
		if reason := checkoutDamage(checkout); reason != "" {
			damaged = append(damaged, reason)
		}
	}
	for _, line := range append(append(removed, restored...), damaged...) {
		logln("volume check:", line)
	}
	logln(fmt.Sprintf("volume check: %d checkouts in %d repositories after start; %d stale lock files removed, %d branches restored, %d checkouts damaged",
		len(checkouts), len(commonDirs), len(removed), len(restored), len(damaged)))
	if len(removed)+len(restored) > 0 {
		syncManagedVolume("the volume check")
	}
}

// managedCheckouts are the checkouts a managed runner keeps: each directory under reposRoot with a
// .git of its own, and each session worktree (not the scratch checkouts beside them).
func managedCheckouts() []string {
	var out []string
	for _, root := range []string{reposRoot(), worktreesDir()} {
		entries, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		for _, e := range entries {
			name := e.Name()
			if !e.IsDir() || strings.HasPrefix(name, rebaseScratchPrefix) || strings.HasPrefix(name, mergeRecoveryWorktreePrefix) ||
				strings.HasPrefix(name, retiredCheckoutPrefix) || strings.HasPrefix(name, integrateScratchPrefix) {
				continue
			}
			if _, err := os.Lstat(filepath.Join(root, name, ".git")); err == nil {
				out = append(out, filepath.Join(root, name))
			}
		}
	}
	return out
}

// checkoutGitDirs reads a checkout's git directory and the repository's common directory from the
// files themselves, so they are found when Git cannot read the repository: .git is the directory,
// or a linked worktree's file naming its directory, whose commondir names the repository's.
func checkoutGitDirs(checkout string) (gitDir, commonDir string) {
	dotGit := filepath.Join(checkout, ".git")
	info, err := os.Lstat(dotGit)
	if err != nil {
		return "", ""
	}
	if info.IsDir() {
		return dotGit, dotGit
	}
	data, err := os.ReadFile(dotGit)
	if err != nil {
		return "", ""
	}
	target, ok := strings.CutPrefix(strings.TrimSpace(string(data)), "gitdir: ")
	if !ok || target == "" {
		return "", ""
	}
	if !filepath.IsAbs(target) {
		target = filepath.Join(checkout, target)
	}
	gitDir, commonDir = filepath.Clean(target), filepath.Clean(target)
	if common, err := os.ReadFile(filepath.Join(gitDir, "commondir")); err == nil {
		if c := strings.TrimSpace(string(common)); c != "" {
			if !filepath.IsAbs(c) {
				c = filepath.Join(gitDir, c)
			}
			commonDir = filepath.Clean(c)
		}
	}
	return gitDir, commonDir
}

// enclosingCheckout is the checkout dir sits in: dir itself or the nearest parent with a .git.
func enclosingCheckout(dir string) string {
	for d := filepath.Clean(dir); ; d = filepath.Dir(d) {
		if _, err := os.Lstat(filepath.Join(d, ".git")); err == nil {
			return d
		}
		if parent := filepath.Dir(d); parent == d {
			return ""
		}
	}
}

// clearStaleGitLocks removes the lock files of a repository that no process holds open, and says
// which: the repository's own (index, HEAD, config, packed-refs), its refs', its worktrees' and its
// object directory's. Git holds a lock open from the moment it creates it until it renames or
// removes it, so one nobody holds is what an interrupted Git left behind.
func clearStaleGitLocks(commonDir string) []string {
	var locks []string
	collect := func(dir string, recursive bool) {
		if !recursive {
			entries, _ := os.ReadDir(dir)
			for _, e := range entries {
				if e.Type().IsRegular() && strings.HasSuffix(e.Name(), ".lock") {
					locks = append(locks, filepath.Join(dir, e.Name()))
				}
			}
			return
		}
		_ = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
			if err == nil && d.Type().IsRegular() && strings.HasSuffix(d.Name(), ".lock") {
				locks = append(locks, path)
			}
			return nil
		})
	}
	collect(commonDir, false)
	collect(filepath.Join(commonDir, "refs"), true)
	collect(filepath.Join(commonDir, "objects", "info"), false)
	collect(filepath.Join(commonDir, "objects", "pack"), false)
	worktrees, _ := os.ReadDir(filepath.Join(commonDir, "worktrees"))
	for _, w := range worktrees {
		if w.IsDir() {
			collect(filepath.Join(commonDir, "worktrees", w.Name()), false)
		}
	}
	sort.Strings(locks)
	var removed []string
	for _, lock := range locks {
		if holder, err := indexLockHolder(lock); err != nil || holder != nil {
			continue
		}
		held := lockContentNote(lock)
		if err := os.Remove(lock); err != nil {
			logln("volume check: could not remove", lock+":", err)
			continue
		}
		removed = append(removed, fmt.Sprintf("removed %s, a lock no process held (%s): left by an interrupted Git", lock, held))
	}
	return removed
}

// lockContentNote says what a lock held, for the log: the commit a ref lock was about to write, or
// its size.
func lockContentNote(lock string) string {
	data, err := os.ReadFile(lock)
	if err != nil {
		return "unreadable"
	}
	if line := strings.TrimSpace(string(data)); objectIDPattern.MatchString(line) {
		return "it was writing " + line
	}
	return fmt.Sprintf("%d bytes", len(data))
}

var objectIDPattern = regexp.MustCompile(`^([0-9a-f]{40}|[0-9a-f]{64})$`)

// checkoutDamage says why the Git checkout dir sits in cannot be worked in, or "" when it can: its
// HEAD names a commit whose tree reads, or its branch has no commit yet and never had one, or dir is
// in no repository at all.
func checkoutDamage(dir string) string {
	checkout := enclosingCheckout(dir)
	if checkout == "" {
		return ""
	}
	gitDir, commonDir := checkoutGitDirs(checkout)
	where := "the Git repository at " + checkout
	if gitDir == "" {
		return where + " cannot be read: its .git names no repository"
	}
	if _, err := gitIn(checkout, gitDir, "rev-parse", "--verify", "--quiet", "HEAD^{tree}"); err == nil {
		return ""
	}
	head, err := os.ReadFile(filepath.Join(gitDir, "HEAD"))
	if err != nil {
		return fmt.Sprintf("%s cannot be read: its HEAD is missing or unreadable (%v)", where, err)
	}
	value := strings.TrimSpace(string(head))
	ref, symbolic := strings.CutPrefix(value, "ref: ")
	switch {
	case value == "":
		return where + " cannot be read: its HEAD is empty"
	case !symbolic && objectIDPattern.MatchString(value):
		return fmt.Sprintf("%s cannot be read: its HEAD is commit %s, which cannot be read", where, value)
	case !symbolic || !strings.HasPrefix(ref, "refs/"):
		return where + " cannot be read: its HEAD names neither a branch nor a commit"
	}
	branch := strings.TrimPrefix(ref, "refs/heads/")
	if loose, err := os.ReadFile(refFile(gitDir, commonDir, ref)); err == nil {
		content := strings.TrimSpace(string(loose))
		switch {
		case content == "":
			return fmt.Sprintf("%s cannot be read: its branch %s is empty", where, branch)
		case !objectIDPattern.MatchString(content):
			return fmt.Sprintf("%s cannot be read: its branch %s holds no commit id", where, branch)
		}
		return fmt.Sprintf("%s cannot be read: commit %s, where its branch %s points, cannot be read", where, content, branch)
	}
	if sha, err := gitIn(checkout, gitDir, "rev-parse", "--verify", "--quiet", ref); err == nil && sha != "" {
		return fmt.Sprintf("%s cannot be read: commit %s, where its branch %s points, cannot be read", where, sha, branch)
	}
	if len(reflogCommits(filepath.Join(commonDir, "logs", ref))) > 0 {
		return fmt.Sprintf("%s cannot be read: its branch %s is missing, though its reflog shows it had commits", where, branch)
	}
	return "" // a branch with no commit yet: a new repository
}

// gitIn runs git on the checkout's own git directory, named rather than discovered: Git skips a
// directory whose HEAD it cannot read and would go on to whatever repository encloses it.
func gitIn(checkout, gitDir string, args ...string) (string, error) {
	return git(checkout, append([]string{"--git-dir=" + gitDir}, args...)...)
}

// refFile is where a ref is written loose: the worktree's own directory for a per-worktree ref, the
// repository's for a branch.
func refFile(gitDir, commonDir, ref string) string {
	if strings.HasPrefix(ref, "refs/heads/") || strings.HasPrefix(ref, "refs/tags/") || strings.HasPrefix(ref, "refs/remotes/") {
		return filepath.Join(commonDir, ref)
	}
	if _, err := os.Stat(filepath.Join(gitDir, ref)); err == nil {
		return filepath.Join(gitDir, ref)
	}
	return filepath.Join(commonDir, ref)
}

// reflogCommits are the commits a reflog says its ref was moved to, newest first. Lines a cut left
// unfinished do not parse and are skipped.
func reflogCommits(path string) []string {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var out []string
	scanner := bufio.NewScanner(bytes.NewReader(data))
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) >= 2 && objectIDPattern.MatchString(fields[1]) && strings.Trim(fields[1], "0") != "" {
			out = append(out, fields[1])
		}
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out
}

// restoreCheckoutBranch puts the checked-out branch of a checkout back where its own reflog last
// moved it to a commit that still reads, when the branch itself is broken: empty, not a commit id,
// or missing although it had commits. It says what it did, or "" when it did nothing. A branch that
// points at a commit which cannot be read is left alone: moving it back would leave that commit's
// broken objects in the repository, and that is for a person to decide.
func restoreCheckoutBranch(checkout string) string {
	gitDir, commonDir := checkoutGitDirs(checkout)
	head, err := os.ReadFile(filepath.Join(gitDir, "HEAD"))
	if err != nil {
		return ""
	}
	ref, symbolic := strings.CutPrefix(strings.TrimSpace(string(head)), "ref: ")
	if !symbolic || !strings.HasPrefix(ref, "refs/heads/") {
		return ""
	}
	file := refFile(gitDir, commonDir, ref)
	if loose, err := os.ReadFile(file); err == nil && objectIDPattern.MatchString(strings.TrimSpace(string(loose))) {
		return "" // a commit id: the branch is intact, whatever its commit is
	} else if err == nil {
		if err := os.Remove(file); err != nil {
			return ""
		}
	}
	if _, err := gitIn(checkout, gitDir, "rev-parse", "--verify", "--quiet", ref); err == nil {
		return "" // packed, and readable again without its broken loose copy
	}
	for _, sha := range reflogCommits(filepath.Join(commonDir, "logs", ref)) {
		if _, err := gitIn(checkout, gitDir, "rev-parse", "--verify", "--quiet", sha+"^{tree}"); err != nil {
			continue
		}
		if _, err := gitIn(checkout, gitDir, "update-ref", "-m", "orbit: restored after an unclean stop", ref, sha); err != nil {
			logln("volume check: could not restore", ref, "in", checkout+":", err)
			return ""
		}
		return fmt.Sprintf("restored branch %s of %s to %s, the newest commit of its reflog that reads", strings.TrimPrefix(ref, "refs/heads/"), checkout, sha)
	}
	return ""
}

// repositoryDamagedRefusal is the code of a run refused for a damaged repository, and
// repositoryDamagedAdvice what its owner can do about it.
const (
	repositoryDamagedRefusal = "REPOSITORY_DAMAGED"
	repositoryDamagedAdvice  = ". The runner does not work in a damaged repository or start a new one over it: repair it, or move it aside to start afresh, then try again"
)

// managedCheckoutDamage is checkoutDamage for a session about to start on a managed runner: the
// workDir's checkout and the session's own worktree, if it has one. "" on a self-managed runner.
func managedCheckoutDamage(baseDir, sessionID string) string {
	if !managedVolumeDurable() {
		return ""
	}
	if reason := checkoutDamage(baseDir); reason != "" {
		return reason
	}
	if sessionID == "" {
		return ""
	}
	wtPath := filepath.Join(worktreesDir(), sessionID)
	if _, err := os.Lstat(filepath.Join(wtPath, ".git")); err != nil {
		return ""
	}
	return checkoutDamage(wtPath)
}
