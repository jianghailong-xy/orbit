package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// mergeReceiptRepoDir is the repository an ALREADY_MERGED receipt is checked in. Empty is the
// process cwd: the session's checkout for the MCP server, the agent shell's cwd for the CLI. Every
// worktree on a machine shares the main checkout's object store, so a receipt recorded on another
// session's behalf is checkable from here too. A var so a test can point both doors at a repository
// it built.
var mergeReceiptRepoDir = ""

// checkAlreadyMergedSource refuses an ALREADY_MERGED receipt whose sourceSha the target does not
// contain. The control plane has no repository to check that claim in, and a wrong one is
// permanent: a dependent task's dependency closure takes every LANDED receipt's sourceSha as a
// commit its base must contain, the runner refuses it DEPENDENCY_BASE_NOT_LANDED while the base
// does not, and receipts are append-only, so a correct one recorded later cannot displace it.
//
// The target is the most specific one the receipt names: targetShaAfter, else targetShaBefore,
// else origin/<targetBranch>. Anything but a clean "yes" or "no" from git refuses too — an
// "already merged" that cannot be checked is not recorded.
func checkAlreadyMergedSource(sourceSha, targetBranch, targetShaBefore, targetShaAfter string) error {
	sourceSha, targetBranch = strings.TrimSpace(sourceSha), strings.TrimSpace(targetBranch)
	if sourceSha == "" || targetBranch == "" {
		return errors.New("sourceSha and targetBranch are required")
	}
	target, label := "origin/"+targetBranch, "origin/"+targetBranch
	if sha := strings.TrimSpace(targetShaAfter); sha != "" {
		target, label = sha, "targetShaAfter "+sha
	} else if sha := strings.TrimSpace(targetShaBefore); sha != "" {
		target, label = sha, "targetShaBefore "+sha
	}
	dir := mergeReceiptRepoDir
	if dir == "" {
		dir, _ = os.Getwd()
	}
	_, err := git(dir, "merge-base", "--is-ancestor", sourceSha, target)
	if err == nil {
		return nil
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) && exit.ExitCode() == 1 {
		return fmt.Errorf("refusing ALREADY_MERGED: sourceSha %s is not in %s. If the work reached "+
			"%s by cherry-pick or rebase, it landed as a different commit: give sourceSha as the "+
			"commit on %s that carries this content, not the original branch tip. A receipt naming "+
			"a commit the target does not contain goes into every dependent task's dependency "+
			"closure, and they stay refused DEPENDENCY_BASE_NOT_LANDED — receipts are append-only, "+
			"so a correct one recorded later does not take it out",
			sourceSha, label, targetBranch, targetBranch)
	}
	return fmt.Errorf("refusing ALREADY_MERGED: cannot check that sourceSha %s is in %s "+
		"(git merge-base --is-ancestor in %q: %v). Run `git fetch` first if either commit is "+
		"missing here, or run this from inside the repository — an \"already merged\" claim that "+
		"cannot be checked is not recorded", sourceSha, label, dir, err)
}
