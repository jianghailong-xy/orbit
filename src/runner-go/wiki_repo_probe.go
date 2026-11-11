package main

import (
	"errors"
	"os"
	"strings"
)

// The probe (contract `repoOps.kinds.probe`, docs/wiki-repo-tiers-design.md §7.3): which tier a working directory would
// be read on, asked when the owner picks a workspace for maintenance and again by `Check again and run now`.
//
// IT ONLY LOOKS. No fetch, no snapshot, nothing read of any file: the answer is the tier and, for git, the origin it is a
// clone of. A git checkout is held to the space's repository the way every operation holds it (wikiRepoOpCheckout) —
// its origin is the space's address and its history starts from the space's first commit — but from what the checkout
// already has: the commit checked out, or origin's default branch as the last fetch left it. A directory that is there
// and is not git is the folder tier. Anything else fails with the reason the checkout would have failed with, so the
// server words it the same way (`wikiRepoDetail`).

// The capability a runner declares when it answers `probe`. Its apiserver twin is WIKI_REPO_OP_PROBE_CAPABILITY in
// src/shared/src/wikiRepoOps.ts: the server asks a runner that does not declare it nothing, since an older runner would
// fetch before it learned it does not know the kind.
const wikiRepoOpProbeCapabilityV1 = "wiki-repo-op-probe/v1"

// wikiRepoOpProbe answers the probe: `{tier: "git", origin}` or `{tier: "folder"}`, or a failure naming its reason.
func wikiRepoOpProbe(cmd WikiRepoOpCommand) wikiRepoOpOutcome {
	workDir := expandTilde(strings.TrimSpace(cmd.WorkDir))
	if workDir == "" {
		return wikiRepoOpFailedWith(wikiRepoOpReasonf(wikiRepoReasonNoWorkDir, "the operation names no working directory to read the repository in"))
	}
	if info, statErr := os.Stat(workDir); statErr != nil || !info.IsDir() {
		if statErr == nil {
			statErr = errors.New("not a directory")
		}
		return wikiRepoOpFailedWith(wikiRepoOpReasonf(wikiRepoReasonNotFound, "%s was not found on this machine: %v", workDir, statErr))
	}
	root, err := wikiImportGit(workDir, "rev-parse", "--show-toplevel")
	if err != nil || root == "" {
		return wikiRepoOpSucceeded(map[string]interface{}{"tier": "folder"})
	}
	remote, _ := wikiImportGit(root, "remote", "get-url", "origin")
	origin := ""
	if strings.TrimSpace(remote) != "" {
		origin = normalizeWikiRepoURL(remote)
	}
	if want := strings.TrimSpace(cmd.RepoURLNorm); want != "" && origin != want {
		return wikiRepoOpFailedWith(wikiRepoOpReasonf(wikiRepoReasonWrongRepository, "the checkout %s is a clone of %s, not of the space's repository %s: "+
			"nothing was read", root, firstNonEmpty(origin, "no origin"), want))
	}
	if first := strings.ToLower(strings.TrimSpace(cmd.RootCommitSha)); first != "" {
		// What the checkout already holds: the commit checked out, else origin's default branch as last fetched. A checkout
		// with neither (a clone of an empty repository) has no history to hold to the first commit, and the run's fetch will.
		for _, ref := range []string{"HEAD", "refs/remotes/origin/HEAD"} {
			if _, err := wikiImportGit(root, "rev-parse", "--verify", "--quiet", ref+"^{commit}"); err != nil {
				continue
			}
			if !wikiRepoOpStartsFrom(root, ref, first) {
				return wikiRepoOpFailedWith(wikiRepoOpReasonf(wikiRepoReasonRootMismatch, "the checkout %s does not start from the space's first commit %s: "+
					"it is another repository behind the same URL, so nothing was read", root, first))
			}
			break
		}
	}
	return wikiRepoOpSucceeded(map[string]interface{}{"tier": "git", "origin": origin})
}
