package main

import (
	"fmt"
	"strings"
)

// Landing through a pull request (docs/design/protected-branch-landing.md §4, §9). A landing pushes its tested commit
// to the target as it always did. When GitHub refuses that push because of the branch's rules — a branch that
// requires a pull request, status checks or a review — the landing pushes the same commit to a branch of Orbit's own,
// `orbit/land/<id>`, and answers PULL_REQUEST: the control plane opens the pull request and merges it once GitHub
// allows. The refusal is never read as TARGET_MOVED, because the target did not move and pushing it again cannot help.

// The capability that says this runner turns a protected refusal of an integration job's target push into a push of
// its landing branch (§9 item 1), and pushes only the landing branch for a subject whose pull request is open (item
// 2). The control plane sends landVia, landingRef, landingRefSha and pullRequestOpen only to a runner that declared
// it; its apiserver twin is INTEGRATION_PULL_REQUEST_CAPABILITY in @orbit/shared.
const integrationPullRequestCapabilityV1 = "integration-pull-request/v1"

// The same for a session's own Merge (§4.6, §9 item 5): its twin is SESSION_MERGE_PULL_REQUEST_CAPABILITY.
const sessionMergePullRequestCapabilityV1 = "session-merge-pull-request/v1"

// How a landing reaches its target (§3), as the control plane fixed it when it handed the attempt out.
const (
	// The target and nothing else: a refusal by the branch's rules is PUSH_PROTECTED.
	landViaPush = "PUSH"
	// The target as today, then the landing branch when GitHub refuses the target because of its rules.
	landViaPullRequest = "PULL_REQUEST"
	// The same, with the owner's own GitHub token on the target push (§5, push_as_me.go). Sent only to a runner that
	// declared pushAsMeCapabilityV1.
	landViaPushAsMe = "PUSH_AS_ME"
)

// landsThroughPullRequest reports whether a refused target push of this landing falls back to its landing branch:
// the control plane named a pull-request mode and the branch to push, and the target is on a remote. A RUNNER_LOCAL
// ref has no GitHub behind it to open a pull request on.
func landsThroughPullRequest(landVia, landingRef string, local bool) bool {
	return !local && strings.TrimSpace(landingRef) != "" && (landVia == landViaPullRequest || landVia == landViaPushAsMe)
}

// isProtectedRefusal reports whether a failed push was refused because of the branch's rules rather than because
// the target moved (§9 item 1): classic branch protection (`GH006`, `protected branch hook declined`) or a ruleset
// (`GH013`, `push declined due to repository rule violations`).
func isProtectedRefusal(pushOutput string) bool {
	s := strings.ToLower(pushOutput)
	return strings.Contains(s, "gh006") ||
		strings.Contains(s, "gh013") ||
		strings.Contains(s, "protected branch hook declined") ||
		strings.Contains(s, "push declined due to repository rule violations")
}

// pushRefusalWordsMax is the most of GitHub's refusal a result carries. The control plane clips and redacts it again.
const pushRefusalWordsMax = 1000

// githubRefusalWords is what GitHub said when it refused a push, out of git's output: the `remote:` lines it wrote,
// without git's prefixes and without the blank ones, joined into one paragraph — "GH006: Protected branch update
// failed for refs/heads/main. Changes must be made through a pull request." When GitHub wrote none, git's own
// `[remote rejected]` line is the reason. The landing quotes it (§5.5).
func githubRefusalWords(pushOutput string) string {
	var said []string
	var rejected string
	for _, raw := range strings.Split(pushOutput, "\n") {
		line := strings.TrimSpace(strings.TrimRight(raw, "\r"))
		switch {
		case strings.HasPrefix(line, "remote:"):
			line = strings.TrimSpace(strings.TrimPrefix(line, "remote:"))
			line = strings.TrimSpace(strings.TrimPrefix(line, "error:"))
			if line != "" {
				said = append(said, line)
			}
		case rejected == "" && strings.Contains(line, "[remote rejected]"):
			rejected = line
		}
	}
	words := strings.Join(said, " ")
	if words == "" {
		words = firstNonEmpty(rejected, strings.TrimSpace(pushOutput))
	}
	return clip(words, pushRefusalWordsMax)
}

// landingBranchPush is one push of a landing's tested commit to its landing branch (§4.1 step 4, §9 item 1).
type landingBranchPush struct {
	// The checkout the push runs from: a job's scratch worktree, a merge's staging checkout.
	dir        string
	remote     string
	landingRef string
	// What the push puts there, and the tree the checks passed on.
	tested  string
	treeSha string
	// The target tip the tested commit was built on: a commit already on the landing branch is reused only when it
	// carries the tested tree on top of this tip (§9 item 2).
	baseSha string
	// What Orbit last pushed to the landing branch, as the control plane recorded it: the push's lease. Empty when
	// the control plane recorded none, and the lease is then what the remote holds when the push starts.
	expected string
	// The subject's pull request is open: a commit already on the branch that carries the tested tree on the same
	// base is answered as it is and nothing is pushed, so GitHub does not run the checks again (§4.5).
	reuse bool
}

// run pushes the tested commit to the landing branch with a lease, reads the branch back and answers the commit it
// holds. Through networkGit, so on a checkout Orbit cloned from GitHub a push the machine's credential cannot make is
// made with Orbit's. A lease that does not hold, or a branch that reads back as anything else, is an error: Orbit
// merges only the commit it pushed (§12).
func (p landingBranchPush) run() (string, error) {
	current, err := remoteRefSha(p.dir, p.remote, p.landingRef)
	if err != nil {
		return "", err
	}
	if p.reuse && current != "" && p.holdsTestedTree(current) {
		return current, nil
	}
	lease := strings.TrimSpace(p.expected)
	if lease == "" {
		lease = current
	}
	if _, err := networkGit(p.dir, networkGitTimeout, "push", "--force-with-lease="+p.landingRef+":"+lease,
		p.remote, p.tested+":"+p.landingRef); err != nil {
		return "", err
	}
	after, err := remoteRefSha(p.dir, p.remote, p.landingRef)
	if err != nil {
		return "", err
	}
	if after != p.tested {
		return "", fmt.Errorf("%s reads %s after the push, not %s", p.landingRef, firstNonEmpty(shortSha(after), "nothing"), shortSha(p.tested))
	}
	return after, nil
}

// holdsTestedTree reports whether the landing branch's commit head carries the tested tree on top of the base this
// landing was built on: merged into that base by any method GitHub offers, it gives the tree the checks passed on.
func (p landingBranchPush) holdsTestedTree(head string) bool {
	if _, err := networkGit(p.dir, networkGitTimeout, "fetch", "--no-tags", p.remote, p.landingRef); err != nil {
		return false
	}
	fetched, err := git(p.dir, "rev-parse", "FETCH_HEAD")
	if err != nil || fetched != head {
		return false
	}
	tree, err := git(p.dir, "rev-parse", head+"^{tree}")
	return err == nil && tree == p.treeSha && p.baseSha != "" && isAncestor(p.dir, p.baseSha, head)
}

// remoteRefSha is the commit ref names on remote, "" when it does not exist there.
func remoteRefSha(dir, remote, ref string) (string, error) {
	out, err := networkGit(dir, networkGitTimeout, "ls-remote", remote, ref)
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 && fields[1] == ref {
			return fields[0], nil
		}
	}
	return "", nil
}

// toLandingBranch ends a landing whose target GitHub refused because of its rules, or whose subject's pull request is
// open, by pushing its landing branch (§9 items 1 and 2). refusal is GitHub's words, "" when the target was not
// tried. The result keeps everything the job measured: the control plane writes the pull request from it (J-T14).
func toLandingBranch(result integrationResult, cmd IntegrationJobCommand, scratch, remote, tested, treeSha, baseSha, refusal string) integrationResult {
	pushed, err := landingBranchPush{
		dir: scratch, remote: remote, landingRef: cmd.LandingRef,
		tested: tested, treeSha: treeSha, baseSha: baseSha,
		expected: cmd.LandingRefSha, reuse: cmd.PullRequestOpen,
	}.run()
	if err != nil {
		result.State, result.Phase, result.ErrorCode = "ERROR", "PUSH", "PUSH_REJECTED"
		detail := map[string]any{
			"detail":     "could not push the landing branch " + strings.TrimPrefix(cmd.LandingRef, "refs/heads/") + ": " + clip(gitStderr(err), 2000),
			"landingRef": cmd.LandingRef,
		}
		if refusal != "" {
			detail["pushRefusal"] = refusal
		}
		result.ErrorDetail = detail
		return result
	}
	result.State, result.Phase = "PULL_REQUEST", "PUSH"
	result.LandingRefSha = pushed
	result.PushRefusal = refusal
	return result
}

// protectedPushResult is a target push GitHub refused because of the branch's rules, for a landing with no pull
// request to fall back to (§3 rules 1 to 3): PUSH_PROTECTED, quoting GitHub. Only for a control plane that named
// landVia: one that did not knows no such code, and is answered PUSH_REJECTED as it always was.
func protectedPushResult(result integrationResult, stderr string) integrationResult {
	result.State, result.Phase, result.ErrorCode = "ERROR", "PUSH", "PUSH_PROTECTED"
	result.ErrorDetail = map[string]any{"detail": clip(stderr, 2000), "pushRefusal": githubRefusalWords(stderr)}
	return result
}
