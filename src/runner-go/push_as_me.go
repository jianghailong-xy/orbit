package main

import (
	"errors"
	"fmt"
	"strings"
)

// Push as me (docs/design/protected-branch-landing.md §5, §9 items 3 and 5). A landing whose control plane fixed
// landVia PUSH_AS_ME pushes its target with the owner's own GitHub token, so GitHub decides with the owner's rights —
// admin bypass included — whether the push may pass the branch's rules. The runner asks for that token once, at the
// landing's push boundary (after an integration job's synchronous PUSH report was accepted, or while it holds a
// session's Merge), keeps it in a local variable for that landing's push attempts and nowhere else, and hands it to
// the push alone, the way the App's token travels (github_credential.go): the command's environment, Orbit's
// read-only helper, no machine helper, no hook.
//
// The target is never pushed again with another credential. Refused by the branch's rules, or the token not accepted,
// the landing pushes its landing branch with today's credential order and answers PULL_REQUEST, with GitHub's words;
// the token not to be had, the same with Orbit's reason.

// The capability that says this runner does all of that. Its apiserver twin is PUSH_AS_ME_CAPABILITY in
// @orbit/shared: the control plane hands PUSH_AS_ME only to a runner that declared it, and for an integration job only
// on a v2 claim (reportBeforePush).
const pushAsMeCapabilityV1 = "push-as-me/v1"

// pushAsMePurpose is RunnerGitCredentialRequest.Purpose for the owner's token.
const pushAsMePurpose = "PUSH_AS_ME"

// pushedAsOwner is a result's pushedAs for a target push GitHub took with the owner's token.
const pushedAsOwner = "OWNER"

// What a landing that did not push as the owner says instead of GitHub's words.
const (
	// The owner's token could not be had: Orbit's own reason follows.
	pushAsMeUnavailablePrefix = "Orbit could not use your GitHub account for this push: "
	// GitHub did not authenticate the push with the owner's token: GitHub's words follow.
	pushAsMeTokenRefusedPrefix = "GitHub did not accept your token: "
	// A job handed PUSH_AS_ME on a claim that does not report its push first, which the control plane never does:
	// the push boundary the token route answers at does not exist for it.
	pushAsMeWithoutPushReport = pushAsMeUnavailablePrefix +
		"this landing was not claimed under the protocol that reports its push to Orbit first."
)

// The most of GitHub's "Bypassed rule violations" a result carries: rules, and characters of each.
const (
	bypassedRulesMax   = 20
	bypassedRuleLenMax = 200
)

// pushesAsOwner reports whether a landing pushes its target with the owner's token: the control plane said
// PUSH_AS_ME, the landing goes through a pull request when refused (landsThroughPullRequest), and its pull request is
// not already open — an open one means only the landing branch is pushed.
func pushesAsOwner(landVia string, viaPullRequest, pullRequestOpen bool) bool {
	return landVia == landViaPushAsMe && viaPullRequest && !pullRequestOpen
}

// askOwnerGitCredential asks the control plane for the owner's own GitHub token for one landing's target push: the
// repository is the one remote names in the checkout dir, resolved as orbitGitCredentialFor resolves origin, and
// attempt names the job's claim or the session's merge operation. A refusal answers Orbit's own sentence. The answer
// is asked for once per landing and held by the caller for that landing's push attempts only.
func askOwnerGitCredential(dir, remote string, attempt RunnerGitCredentialRequest) (*orbitGitCredential, error) {
	workspace := githubWorkspaceOf(dir)
	if workspace == "" {
		return nil, errors.New("this checkout is not one Orbit cloned from GitHub")
	}
	origin, err := git(dir, "remote", "get-url", remote)
	if err != nil {
		return nil, fmt.Errorf("could not read the remote %s of this checkout", remote)
	}
	path, ok := githubRepoPath(origin)
	if !ok {
		return nil, fmt.Errorf("the remote %s is not a GitHub repository", remote)
	}
	attempt.WorkspaceID, attempt.Host, attempt.Path, attempt.Purpose = workspace, githubGitHost, path, pushAsMePurpose
	return askOrbitGitCredentialWith(attempt)
}

// pushAsOwner is a Push as me landing's target push: `git push <remote> <refspec>` with the owner's credential alone
// (networkGitOwnerOnly). It answers git's stderr, on success too, and the error a failed push is.
func pushAsOwner(dir, remote string, credential *orbitGitCredential, refspec string) (string, error) {
	return networkGitOwnerOnly(dir, networkGitTimeout, credential, []string{"push", remote, refspec})
}

// ownerPushRefusal is what a landing says when the owner's push failed for a reason that is a fallback to the landing
// branch — GitHub's words for a refusal by the branch's rules, or for the owner's token not accepted — and whether
// the failure is one: false for a non-fast-forward or any other failure, which the landing answers as it always did.
func ownerPushRefusal(stderr string, err error) (string, bool) {
	switch {
	case errors.Is(err, errGitAuthFailed):
		return pushAsMeTokenRefusedPrefix + githubRefusalWords(stderr), true
	case isProtectedRefusal(stderr):
		return githubRefusalWords(stderr), true
	}
	return "", false
}

// bypassedRulesOf reads, out of an accepted push's stderr, the rules GitHub said the push bypassed:
//
//	remote: Bypassed rule violations for refs/heads/main:
//	remote:
//	remote: - Changes must be made through a pull request.
//	remote:
//	remote: - Required status check "ci" is expected.
//
// One entry per `- ` line under a "Bypassed rule violations" heading, without the dash, at most bypassedRulesMax of
// them, each clipped to bypassedRuleLenMax. Nil when GitHub said nothing of the kind.
func bypassedRulesOf(stderr string) []string {
	var rules []string
	under := false
	for _, raw := range strings.Split(stderr, "\n") {
		line := strings.TrimSpace(strings.TrimRight(raw, "\r"))
		if !strings.HasPrefix(line, "remote:") {
			under = false
			continue
		}
		line = strings.TrimSpace(strings.TrimPrefix(line, "remote:"))
		switch {
		case strings.HasPrefix(strings.ToLower(line), "bypassed rule violations"):
			under = true
		case line == "":
		case under && strings.HasPrefix(line, "-"):
			if rule := strings.TrimSpace(strings.TrimPrefix(line, "-")); rule != "" && len(rules) < bypassedRulesMax {
				rules = append(rules, clip(rule, bypassedRuleLenMax))
			}
		default:
			under = false
		}
	}
	return rules
}
