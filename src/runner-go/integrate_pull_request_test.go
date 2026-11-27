package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Landing through a pull request on the runner (docs/design/protected-branch-landing.md §9, §13 "Runner Go tests").
//
// Real git against a bare origin whose pre-receive hook refuses the target the way GitHub does: the same `remote:`
// lines (GH006 for classic branch protection, GH013 for a ruleset), the same `[remote rejected]` push. The landing
// branch is not protected, as `orbit/land/*` is not on GitHub.

const (
	gh006Refusal = "GH006: Protected branch update failed for refs/heads/main.\nChanges must be made through a pull request."
	gh013Refusal = "GH013: Repository rule violations found for refs/heads/main.\nReview all repository rules at https://github.com/o/r/rules?ref=refs%2Fheads%2Fmain\n\n- Changes must be made through a pull request."
)

// protectBranch makes origin refuse every update of refs/heads/<branch> with GitHub's words, one `error:` line each.
func protectBranch(t *testing.T, origin, branch, words string) {
	t.Helper()
	var echo strings.Builder
	for _, line := range strings.Split(words, "\n") {
		echo.WriteString("    echo " + shellQuote("error: "+line) + " >&2\n")
	}
	hook := "#!/bin/sh\nwhile read old new ref; do\n  if [ \"$ref\" = \"refs/heads/" + branch + "\" ]; then\n" +
		echo.String() + "    exit 1\n  fi\ndone\nexit 0\n"
	if err := os.WriteFile(filepath.Join(origin, "hooks", "pre-receive"), []byte(hook), 0o755); err != nil {
		t.Fatalf("write the pre-receive hook: %v", err)
	}
}

// landingRefOf is the landing branch a job of this test pushes to.
func landingRefOf(t *testing.T) string {
	return "refs/heads/orbit/land/" + strings.ReplaceAll(strings.ToLower(t.Name()), "/", "-")
}

// taskOntoMain is a LAND_TASK of one task branch straight onto main, which a MAIN-line project's landing is: main is
// not Orbit's own branch, so the control plane sends it with a pull-request mode.
func taskOntoMain(t *testing.T, r *integrationRepo, landVia string) IntegrationJobCommand {
	t.Helper()
	r.checkoutNew("task/a", "main")
	r.write("a.txt", "from a\n")
	r.commit("task a")
	r.push("task/a")
	r.checkout("main")
	cmd := r.command("task/a", "main")
	cmd.LandVia = landVia
	if landVia == landViaPullRequest || landVia == landViaPushAsMe {
		cmd.LandingRef = landingRefOf(t)
	}
	return cmd
}

// A protected refusal of the target is a push of the landing branch, with its lease, and never TARGET_MOVED: the job
// answers PULL_REQUEST with the commit the landing branch now holds and GitHub's words, and the target is untouched,
// on origin and in this machine's checkout alike.
func TestLandTaskProtectedRefusalPushesTheLandingBranch(t *testing.T) {
	t.Parallel()
	for _, words := range []string{gh006Refusal, gh013Refusal} {
		t.Run(strings.SplitN(words, ":", 2)[0], func(t *testing.T) {
			t.Parallel()
			r := newIntegrationRepo(t)
			cmd := taskOntoMain(t, r, landViaPullRequest)
			mainBefore := r.originRev("refs/heads/main")
			protectBranch(t, r.origin, "main", words)

			result := runIntegrationJob(cmd, silent)
			if result.State != "PULL_REQUEST" || result.Phase != "PUSH" || result.ErrorCode != "" {
				t.Fatalf("result = %s/%s %s %v, want PULL_REQUEST/PUSH", result.State, result.Phase, result.ErrorCode, result.ErrorDetail)
			}
			if result.TestedSha == "" || result.LandingRefSha != result.TestedSha {
				t.Fatalf("landing branch answered %q, tested %q", result.LandingRefSha, result.TestedSha)
			}
			if got := r.originRev(cmd.LandingRef); got != result.TestedSha {
				t.Fatalf("origin's landing branch holds %q, want the tested commit %q", got, result.TestedSha)
			}
			if got := r.originRev("refs/heads/main"); got != mainBefore {
				t.Fatalf("origin's main moved to %s", got)
			}
			if got := r.rev("main"); got != mainBefore {
				t.Fatalf("this checkout's main moved to %s: the target did not move, so neither may its copy", got)
			}
			first := strings.SplitN(words, "\n", 2)[0]
			if !strings.Contains(result.PushRefusal, first) || !strings.Contains(result.PushRefusal, "Changes must be made through a pull request") {
				t.Fatalf("push refusal %q does not quote GitHub", result.PushRefusal)
			}
			if result.TestedTreeSha == "" || result.LandedSha != "" {
				t.Fatalf("tested tree %q, landed %q: a pull request landing has not landed yet", result.TestedTreeSha, result.LandedSha)
			}
		})
	}
}

// With landVia PUSH there is no pull request to fall back to (§3 rules 1 to 3): the same refusal is PUSH_PROTECTED,
// quoting GitHub, and nothing else is pushed.
func TestLandTaskProtectedRefusalWithoutAFallbackIsPushProtected(t *testing.T) {
	t.Parallel()
	r := newIntegrationRepo(t)
	cmd := taskOntoMain(t, r, landViaPush)
	protectBranch(t, r.origin, "main", gh006Refusal)

	result := runIntegrationJob(cmd, silent)
	if result.State != "ERROR" || result.ErrorCode != "PUSH_PROTECTED" {
		t.Fatalf("result = %s %s, want ERROR PUSH_PROTECTED", result.State, result.ErrorCode)
	}
	if refusal, _ := result.ErrorDetail["pushRefusal"].(string); !strings.Contains(refusal, "GH006") {
		t.Fatalf("detail %v does not quote GitHub", result.ErrorDetail)
	}
	if listed, _ := git(r.origin, "for-each-ref", "refs/heads/orbit/"); listed != "" {
		t.Fatalf("a landing branch was pushed: %s", listed)
	}
}

// A control plane that named no landVia is one that knows neither answer: it is told PUSH_REJECTED, as it always
// was — and still never TARGET_MOVED, which would send a LAND_TASK round after round at a branch that cannot move.
func TestLandTaskProtectedRefusalForALegacyControlPlaneIsPushRejected(t *testing.T) {
	t.Parallel()
	r := newIntegrationRepo(t)
	cmd := taskOntoMain(t, r, "")
	protectBranch(t, r.origin, "main", gh006Refusal)

	result := runIntegrationJob(cmd, silent)
	if result.State != "ERROR" || result.ErrorCode != "PUSH_REJECTED" {
		t.Fatalf("result = %s %s, want ERROR PUSH_REJECTED", result.State, result.ErrorCode)
	}
}

// The four spellings of a refusal by the branch's rules are all read as protected, and none of them as the race
// isNonFastForward retries; a push that lost a race is not protected.
func TestProtectedRefusalsAreReadAsProtected(t *testing.T) {
	t.Parallel()
	protected := []string{
		"remote: error: GH006: Protected branch update failed for refs/heads/main.\n ! [remote rejected] main -> main (protected branch hook declined)",
		"remote: error: GH013: Repository rule violations found for refs/heads/main.\n ! [remote rejected] main -> main (push declined due to repository rule violations)",
		" ! [remote rejected] HEAD -> main (protected branch hook declined)",
		" ! [remote rejected] HEAD -> main (push declined due to repository rule violations)",
	}
	for _, output := range protected {
		if !isProtectedRefusal(output) {
			t.Errorf("not read as protected: %q", output)
		}
		if isNonFastForward(output) {
			t.Errorf("read as a lost race: %q", output)
		}
	}
	for _, output := range []string{
		" ! [rejected]        main -> main (fetch first)",
		" ! [rejected]        main -> main (non-fast-forward)",
		"fatal: Authentication failed for 'https://github.com/o/r.git/'",
	} {
		if isProtectedRefusal(output) {
			t.Errorf("read as protected: %q", output)
		}
	}
}

// What a landing quotes is GitHub's own words, from its `remote:` lines, and git's rejection line when GitHub said
// nothing.
func TestGithubRefusalWordsQuoteGithub(t *testing.T) {
	t.Parallel()
	output := "remote: error: GH006: Protected branch update failed for refs/heads/main.\nremote: error: Changes must be made through a pull request.\nTo https://github.com/o/r.git\n ! [remote rejected] HEAD -> main (protected branch hook declined)\nerror: failed to push some refs to 'https://github.com/o/r.git'"
	if got, want := githubRefusalWords(output), "GH006: Protected branch update failed for refs/heads/main. Changes must be made through a pull request."; got != want {
		t.Fatalf("words = %q, want %q", got, want)
	}
	bare := "To https://github.com/o/r.git\n ! [remote rejected] HEAD -> main (protected branch hook declined)"
	if got := githubRefusalWords(bare); got != "! [remote rejected] HEAD -> main (protected branch hook declined)" {
		t.Fatalf("words without remote lines = %q", got)
	}
}

// A promotion into a protected main takes the same step at M-S4: the merge commit the checks passed goes to the
// landing branch, and main stays where it was.
func TestPromotionProtectedRefusalPushesTheLandingBranch(t *testing.T) {
	t.Parallel()
	r := newIntegrationRepo(t)
	r.checkoutNew("project/p", "main")
	r.write("p.txt", "project work\n")
	r.commit("project work")
	r.push("project/p")
	r.checkout("main")
	mainBefore := r.originRev("refs/heads/main")
	protectBranch(t, r.origin, "main", gh006Refusal)

	land := r.promotionCommand("LAND_PROMOTION", "project/p", "PROJECT_BRANCH")
	land.LandVia = landViaPullRequest
	land.LandingRef = landingRefOf(t)
	result := runIntegrationJob(land, silent)
	if result.State != "PULL_REQUEST" || result.LandingRefSha == "" || result.LandingRefSha != result.TestedSha {
		t.Fatalf("result = %s %s landing %q tested %q", result.State, result.ErrorCode, result.LandingRefSha, result.TestedSha)
	}
	if got := r.originRev(land.LandingRef); got != result.TestedSha {
		t.Fatalf("origin's landing branch holds %q, want %q", got, result.TestedSha)
	}
	if parents, _ := git(r.origin, "rev-list", "--parents", "-n", "1", result.TestedSha); len(strings.Fields(parents)) != 3 ||
		strings.Fields(parents)[1] != mainBefore {
		t.Fatalf("the landing branch should hold the merge commit onto main %s: %s", mainBefore, parents)
	}
	if got := r.originRev("refs/heads/main"); got != mainBefore {
		t.Fatalf("origin's main moved to %s", got)
	}
}

// A subject whose pull request is open lands through it: the target is not tried at all — here it would have
// accepted the push — and the landing branch is pushed over what Orbit pushed there before (§9 item 2).
func TestOpenPullRequestPushesOnlyTheLandingBranch(t *testing.T) {
	t.Parallel()
	r := newIntegrationRepo(t)
	cmd := taskOntoMain(t, r, landViaPullRequest)
	mainBefore := r.originRev("refs/heads/main")
	// What an earlier attempt left on the landing branch, which the lease names.
	mustRun(t, r.work, "git", "push", "--quiet", "origin", mainBefore+":"+cmd.LandingRef)
	cmd.PullRequestOpen = true
	cmd.LandingRefSha = mainBefore

	result := runIntegrationJob(cmd, silent)
	if result.State != "PULL_REQUEST" || result.PushRefusal != "" {
		t.Fatalf("result = %s %s refusal %q, want PULL_REQUEST without a refusal", result.State, result.ErrorCode, result.PushRefusal)
	}
	if got := r.originRev("refs/heads/main"); got != mainBefore {
		t.Fatalf("the target was pushed: origin's main is %s", got)
	}
	if got := r.originRev(cmd.LandingRef); got != result.TestedSha || got != result.LandingRefSha {
		t.Fatalf("origin's landing branch holds %q, tested %q, answered %q", got, result.TestedSha, result.LandingRefSha)
	}
}

// A retry after a flaky check on GitHub finds the landing branch already holding the tested tree on the base it was
// built on: it answers that commit and pushes nothing, so GitHub does not run its checks again (§4.5).
func TestOpenPullRequestReusesTheTestedTreeOnTheSameBase(t *testing.T) {
	t.Parallel()
	r := newIntegrationRepo(t)
	cmd := taskOntoMain(t, r, landViaPullRequest)
	mainTip := r.originRev("refs/heads/main")
	tree, _ := git(r.work, "rev-parse", "task/a^{tree}")
	// The same tree on the same base, under another commit: what an earlier attempt pushed.
	earlier, err := git(r.work, "commit-tree", tree, "-p", mainTip, "-m", "an earlier attempt")
	if err != nil {
		t.Fatalf("commit-tree: %v", err)
	}
	mustRun(t, r.work, "git", "push", "--quiet", "origin", earlier+":"+cmd.LandingRef)
	cmd.PullRequestOpen = true
	cmd.LandingRefSha = earlier

	result := runIntegrationJob(cmd, silent)
	if result.State != "PULL_REQUEST" || result.LandingRefSha != earlier {
		t.Fatalf("result = %s %s landing %q, want the earlier commit %q answered as it is", result.State, result.ErrorCode, result.LandingRefSha, earlier)
	}
	if result.TestedSha == earlier || result.TestedTreeSha != tree {
		t.Fatalf("tested %q (tree %q): the checks ran on this job's own commit with the same tree", result.TestedSha, result.TestedTreeSha)
	}
	if got := r.originRev(cmd.LandingRef); got != earlier {
		t.Fatalf("the landing branch was pushed: it holds %q", got)
	}

	// Another tree is not reused: the branch is pushed over it, under the lease on what it held.
	changed := r.rev("main") // a commit whose tree is main's, not the task's
	mustRun(t, r.work, "git", "push", "--quiet", "--force", "origin", changed+":"+cmd.LandingRef)
	cmd.JobID += "-again"
	cmd.LandingRefSha = changed
	again := runIntegrationJob(cmd, silent)
	if again.State != "PULL_REQUEST" || again.LandingRefSha != again.TestedSha || r.originRev(cmd.LandingRef) != again.TestedSha {
		t.Fatalf("again = %s landing %q tested %q origin %q", again.State, again.LandingRefSha, again.TestedSha, r.originRev(cmd.LandingRef))
	}
}

// The lease is on what Orbit last pushed to the landing branch. A branch that holds anything else was pushed by
// somebody else: it is not overwritten, and the job says so rather than answering PULL_REQUEST (§12: Orbit merges
// only what it pushed).
func TestLandingBranchLeaseRefusesAPushOrbitDidNotMake(t *testing.T) {
	t.Parallel()
	r := newIntegrationRepo(t)
	cmd := taskOntoMain(t, r, landViaPullRequest)
	recorded := r.originRev("refs/heads/main")
	protectBranch(t, r.origin, "main", gh006Refusal)
	// Somebody else's commit on the landing branch.
	r.checkoutNew("intruder", "main")
	r.write("x.txt", "not orbit's\n")
	intruder := r.commit("not orbit's")
	r.checkout("main")
	mustRun(t, r.work, "git", "push", "--quiet", "origin", intruder+":"+cmd.LandingRef)
	cmd.LandingRefSha = recorded

	result := runIntegrationJob(cmd, silent)
	if result.State != "ERROR" || result.ErrorCode != "PUSH_REJECTED" {
		t.Fatalf("result = %s %s, want ERROR PUSH_REJECTED", result.State, result.ErrorCode)
	}
	if detail, _ := result.ErrorDetail["detail"].(string); !strings.Contains(detail, "landing branch") {
		t.Fatalf("detail %v does not name the landing branch", result.ErrorDetail)
	}
	if refusal, _ := result.ErrorDetail["pushRefusal"].(string); !strings.Contains(refusal, "GH006") {
		t.Fatalf("detail %v lost GitHub's refusal", result.ErrorDetail)
	}
	if got := r.originRev(cmd.LandingRef); got != intruder {
		t.Fatalf("the landing branch was overwritten: it holds %q", got)
	}
}

// A RUNNER_LOCAL target has no GitHub to open a pull request on: the mode is ignored and the ref is moved locally.
func TestLandsThroughPullRequestNeedsARemoteAndABranch(t *testing.T) {
	t.Parallel()
	cases := []struct {
		landVia, ref string
		local, want  bool
	}{
		{landViaPullRequest, "refs/heads/orbit/land/x", false, true},
		{landViaPushAsMe, "refs/heads/orbit/land/x", false, true},
		{landViaPullRequest, "refs/heads/orbit/land/x", true, false},
		{landViaPullRequest, "", false, false},
		{landViaPush, "refs/heads/orbit/land/x", false, false},
		{"", "refs/heads/orbit/land/x", false, false},
	}
	for _, c := range cases {
		if got := landsThroughPullRequest(c.landVia, c.ref, c.local); got != c.want {
			t.Errorf("landsThroughPullRequest(%q, %q, %v) = %v, want %v", c.landVia, c.ref, c.local, got, c.want)
		}
	}
}

// The runner says it does all of this, for jobs and for a session's Merge (§9 item 7): the control plane sends a
// pull-request mode to no runner that does not.
func TestRunnerDeclaresThePullRequestCapabilities(t *testing.T) {
	t.Parallel()
	declared := strings.Split(runnerCapabilitiesV1, ",")
	for _, capability := range []string{"integration-pull-request/v1", "session-merge-pull-request/v1"} {
		found := false
		for _, d := range declared {
			if strings.TrimSpace(d) == capability {
				found = true
			}
		}
		if !found {
			t.Errorf("%s is not declared: %s", capability, runnerCapabilitiesV1)
		}
	}
}

// A session's Merge into a protected main (§4.6): the replayed tip goes to the session's landing branch and the merge
// answers pull_request with it. Neither origin's main nor this machine's moves.
func TestSessionMergeProtectedRefusalPushesTheLandingBranch(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := initRepo(t)
	bare := addOriginBare(t, repo)
	base := mustGit(t, repo, "rev-parse", "main")
	mustGit(t, repo, "checkout", "-b", "orbit/feat")
	commitFile(t, repo, "feature.txt", "feature\n", "feature work")
	mustGit(t, repo, "checkout", "main")
	advanceOriginMain(t, repo, "remote.txt", "remote\n")
	originMain := mustGit(t, bare, "rev-parse", "main")
	protectBranch(t, bare, "main", gh006Refusal)

	landingRef := "refs/heads/orbit/land/merge-session"
	out := mergeToMain(MergeCommand{
		WorkDir: repo, Branch: "orbit/feat", SessionID: "merge-session", BaseSha: base, TargetBranch: "main",
		LandVia: landViaPullRequest, LandingRef: landingRef,
	})
	if out.Status != "pull_request" {
		t.Fatalf("merge = %+v, want pull_request", out)
	}
	pushed := mustGit(t, bare, "rev-parse", landingRef)
	if out.PushedSha != pushed {
		t.Fatalf("answered %q, the landing branch holds %q", out.PushedSha, pushed)
	}
	if parent := mustGit(t, bare, "rev-parse", pushed+"^"); parent != originMain {
		t.Fatalf("the replay is not onto origin's main %s: its parent is %s", originMain, parent)
	}
	if !strings.Contains(out.PushRefusal, "GH006") || out.TargetBranch != "main" || out.RebaseBase != originMain {
		t.Fatalf("refusal %q target %q base %q", out.PushRefusal, out.TargetBranch, out.RebaseBase)
	}
	if got := mustGit(t, bare, "rev-parse", "main"); got != originMain {
		t.Fatalf("origin's main moved to %s", got)
	}
	if got := mustGit(t, repo, "rev-parse", "main"); got != originMain {
		t.Fatalf("this machine's main is %s, want origin's %s and no further", got, originMain)
	}
}

// Pressing Merge again while the session's pull request is open updates that pull request: the landing branch is
// pushed and the target is not tried, protected or not.
func TestSessionMergeOpenPullRequestPushesOnlyTheLandingBranch(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := initRepo(t)
	bare := addOriginBare(t, repo)
	base := mustGit(t, repo, "rev-parse", "main")
	mustGit(t, repo, "checkout", "-b", "orbit/feat")
	commitFile(t, repo, "feature.txt", "feature\n", "feature work")
	mustGit(t, repo, "checkout", "main")
	originMain := mustGit(t, bare, "rev-parse", "main")

	landingRef := "refs/heads/orbit/land/open-session"
	out := mergeToMain(MergeCommand{
		WorkDir: repo, Branch: "orbit/feat", SessionID: "open-session", BaseSha: base, TargetBranch: "main",
		LandVia: landViaPullRequest, LandingRef: landingRef, PullRequestOpen: true,
	})
	if out.Status != "pull_request" || out.PushRefusal != "" {
		t.Fatalf("merge = %+v, want pull_request without a refusal", out)
	}
	if got := mustGit(t, bare, "rev-parse", "main"); got != originMain {
		t.Fatalf("the target was pushed: origin's main is %s", got)
	}
	if got := mustGit(t, bare, "rev-parse", landingRef); got != out.PushedSha {
		t.Fatalf("landing branch %s, answered %s", got, out.PushedSha)
	}
}

// Without a fallback the protected refusal is an error that quotes GitHub; with no landVia at all, the merge fails as
// it always did.
func TestSessionMergeProtectedRefusalWithoutAFallback(t *testing.T) {
	for _, landVia := range []string{landViaPush, ""} {
		t.Run("landVia="+landVia, func(t *testing.T) {
			t.Setenv("ORBIT_HOME", t.TempDir())
			repo := initRepo(t)
			bare := addOriginBare(t, repo)
			base := mustGit(t, repo, "rev-parse", "main")
			mustGit(t, repo, "checkout", "-b", "orbit/feat")
			commitFile(t, repo, "feature.txt", "feature\n", "feature work")
			mustGit(t, repo, "checkout", "main")
			protectBranch(t, bare, "main", gh006Refusal)

			out := mergeToMain(MergeCommand{
				WorkDir: repo, Branch: "orbit/feat", SessionID: "plain-session", BaseSha: base, TargetBranch: "main", LandVia: landVia,
			})
			if out.Status != "error" {
				t.Fatalf("merge = %+v, want error", out)
			}
			want := "could not push main to origin"
			if landVia != "" {
				want = "GitHub refused the push to main because of the branch's rules: GH006"
			}
			if !strings.Contains(out.Message, want) {
				t.Fatalf("message %q does not say %q", out.Message, want)
			}
			if listed := mustGit(t, bare, "for-each-ref", "refs/heads/orbit/"); listed != "" {
				t.Fatalf("a landing branch was pushed: %s", listed)
			}
		})
	}
}
