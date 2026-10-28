package main

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

// A TASK_BRANCH promotion named by its commit (docs/project-integration-line-contract.md §10.5 O-L5,
// §10.9 item 6), against real repositories as integrate_test.go's cases are.
//
// The incident behind it (§10.1): agents pushed their work straight to the upstream, nobody ever
// pushed `orbit/task-*`, and every candidate's check answered SOURCE_BRANCH_MISSING because M-S1
// fetched a branch that existed on one machine only. The work is a commit, and the runner the source
// session ran on holds it, so the check takes the commit out of its own object store and fetches no
// task branch at all.

// anotherMachine is a second checkout of the same origin: the machine an agent worked on, whose
// commits this runner holds only once they have reached the origin and been fetched from there.
func (r *integrationRepo) anotherMachine() *integrationRepo {
	r.t.Helper()
	root := filepath.Dir(r.work)
	dir := filepath.Join(root, "elsewhere")
	mustRun(r.t, root, "git", "clone", "--quiet", r.origin, dir)
	mustRun(r.t, dir, "git", "config", "user.email", "orbit@example.invalid")
	mustRun(r.t, dir, "git", "config", "user.name", "orbit")
	return &integrationRepo{t: r.t, origin: r.origin, work: dir, scratch: r.scratch}
}

// TestPromotionOfATaskBranchNamedByItsCommitNeedsNoPublishedBranch: O-L5's ordinary case. The task's
// branch exists on this machine only, the candidate names the commit the task delivered, and both
// the check and the landing complete from that commit. The branch also moved on after DONE, so a
// promotion that read the branch instead of the commit would show it.
func TestPromotionOfATaskBranchNamedByItsCommitNeedsNoPublishedBranch(t *testing.T) {
	t.Parallel()
	r := newIntegrationRepo(t)
	fork := r.rev("main")
	r.checkoutNew("orbit/task-unpublished", "main")
	r.write("a.txt", "from the task\n")
	delivered := r.commit("task work")
	r.write("later.txt", "written after the task was done\n")
	r.commit("after DONE")
	r.checkout("main")
	r.write("upstream.txt", "moved on\n")
	mainTip := r.commit("main moved")
	r.push("main")
	if got := r.originRev("refs/heads/orbit/task-unpublished"); got != "" {
		t.Fatalf("the task branch is on the origin (%s): this case is about one that never was", got)
	}

	check := r.promotionCommand("CHECK_PROMOTION", "orbit/task-unpublished", "TASK_BRANCH")
	check.SourceSha = delivered
	check.SessionBaseSha = fork
	check.Checks = []IntegrationCheckSpec{
		{Name: "TASK_ACCEPTANCE", Command: "test -f a.txt && test ! -e later.txt", ExpectedExitCode: 0, TimeoutSeconds: 60},
	}
	checked := runIntegrationJob(check, silent)
	if checked.State != "READY" {
		t.Fatalf("check = %s %s (%s %v), want READY from the commit alone",
			checked.State, checked.Phase, checked.ErrorCode, checked.ErrorDetail)
	}
	if checked.SourceSha != delivered {
		t.Fatalf("the check worked from %s, want the delivered commit %s", checked.SourceSha, delivered)
	}
	if len(checked.Checks) != 1 || checked.Checks[0].ExitCode == nil || *checked.Checks[0].ExitCode != 0 {
		t.Fatalf("checks = %+v, want the task's own check run and passed on the delivered commit", checked.Checks)
	}
	if got := r.originRev("refs/heads/main"); got != mainTip {
		t.Fatalf("a check pushed: main is %s, want %s", got, mainTip)
	}

	land := r.promotionCommand("LAND_PROMOTION", "orbit/task-unpublished", "TASK_BRANCH")
	land.SourceSha = delivered
	land.SessionBaseSha = fork
	land.UpstreamShaChecked = mainTip
	land.MergeTreeSha = checked.TestedTreeSha
	landed := runIntegrationJob(land, silent)
	if landed.State != "LANDED" {
		t.Fatalf("landing = %s %s (%s %v), want LANDED", landed.State, landed.Phase, landed.ErrorCode, landed.ErrorDetail)
	}
	if got := r.originRev("refs/heads/main"); got != landed.LandedSha {
		t.Fatalf("origin main is %s, the result claims %s", got, landed.LandedSha)
	}
	if body, _ := git(r.work, "show", landed.LandedSha+":a.txt"); body != "from the task" {
		t.Fatalf("the landed commit does not carry the task's work: %q", body)
	}
	if _, err := git(r.work, "cat-file", "-e", landed.LandedSha+":later.txt"); err == nil {
		t.Fatal("the landing carried a commit made after the delivered one: it read the branch, not the commit")
	}
	if got := r.originRev("refs/heads/orbit/task-unpublished"); got != "" {
		t.Fatalf("the task branch was published (%s): a promotion writes the upstream and nothing else", got)
	}
}

// TestPromotionOfATaskBranchWhoseCommitThisRunnerLacksIsWorkCommitMissing: the commit is not in this
// machine's object store. The branch it was made on IS on the origin here — a fetch would find it —
// and is still not fetched, because the answer O-L5 asks for is about the commit: WORK_COMMIT_MISSING,
// not SOURCE_BRANCH_MISSING.
func TestPromotionOfATaskBranchWhoseCommitThisRunnerLacksIsWorkCommitMissing(t *testing.T) {
	t.Parallel()
	r := newIntegrationRepo(t)
	mainTip := r.rev("main")
	other := r.anotherMachine()
	other.checkoutNew("orbit/task-elsewhere", "main")
	other.write("elsewhere.txt", "made on another machine\n")
	delivered := other.commit("task work elsewhere")
	other.push("orbit/task-elsewhere")

	for _, kind := range []string{"CHECK_PROMOTION", "LAND_PROMOTION"} {
		t.Run(kind, func(t *testing.T) {
			job := r.promotionCommand(kind, "orbit/task-elsewhere", "TASK_BRANCH")
			job.JobID += "-" + kind
			job.SourceSha = delivered
			job.SessionBaseSha = mainTip
			job.UpstreamShaChecked = mainTip
			result := runIntegrationJob(job, silent)
			if result.State != "ERROR" || result.Phase != "FETCH" || result.ErrorCode != "WORK_COMMIT_MISSING" {
				t.Fatalf("result = %s %s (%s %v), want ERROR FETCH WORK_COMMIT_MISSING",
					result.State, result.Phase, result.ErrorCode, result.ErrorDetail)
			}
			if sha, _ := result.ErrorDetail["sha"].(string); sha != delivered {
				t.Fatalf("errorDetail = %v, want it to name the commit %s", result.ErrorDetail, delivered)
			}
		})
	}
	if _, err := git(r.work, "cat-file", "-e", delivered+"^{commit}"); err == nil {
		t.Fatal("the delivered commit is in this checkout now: the task branch was fetched")
	}
	if tip, _ := git(r.work, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/orbit/task-elsewhere"); tip != "" {
		t.Fatalf("the task branch was fetched (refs/remotes/origin/orbit/task-elsewhere = %s)", tip)
	}
	if got := r.originRev("refs/heads/main"); got != mainTip {
		t.Fatalf("main is %s, want it left at %s", got, mainTip)
	}
}

// TestPromotionOfAProjectBranchStillFetchesItsSource: O-L5 changes the TASK_BRANCH source only. A
// project branch's candidate names its commit too, and M-S1 still fetches the branch — here it is the
// fetch that brings that commit to this machine at all.
func TestPromotionOfAProjectBranchStillFetchesItsSource(t *testing.T) {
	t.Parallel()
	r := newIntegrationRepo(t)
	other := r.anotherMachine()
	other.checkoutNew("project/p", "main")
	other.write("feature.txt", "from the project\n")
	sourceSha := other.commit("work on the project branch")
	other.push("project/p")

	check := r.promotionCommand("CHECK_PROMOTION", "project/p", "PROJECT_BRANCH")
	check.SourceSha = sourceSha
	checked := runIntegrationJob(check, silent)
	if checked.State != "READY" {
		t.Fatalf("check = %s %s (%s %v), want READY", checked.State, checked.Phase, checked.ErrorCode, checked.ErrorDetail)
	}
	if checked.SourceSha != sourceSha {
		t.Fatalf("the check worked from %s, want %s", checked.SourceSha, sourceSha)
	}
	if tip, _ := git(r.work, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/project/p"); tip != sourceSha {
		t.Fatalf("refs/remotes/origin/project/p = %q, want the fetched %s", tip, sourceSha)
	}
}

// TestTheHeartbeatDeclaresIntegrationObserve: the control plane hands an OBSERVE_LANDING, or a
// TASK_BRANCH promotion named by its commit, only to a runner whose heartbeat declares
// integration-observe/v1 (§10.5 O-L5, §10.6), and it is declared where integration-job/v1 is: in the
// capability header of every call, the heartbeat's included, and in the link's Hello.
func TestTheHeartbeatDeclaresIntegrationObserve(t *testing.T) {
	declared := make(chan string, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/runner/heartbeat" {
			select {
			case declared <- r.Header.Get(runnerCapabilitiesHeader):
			default:
			}
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()
	if _, err := NewTransport(srv.URL, "runner-token").heartbeat(HeartbeatRequest{}); err != nil {
		t.Fatalf("heartbeat: %v", err)
	}
	header := "," + <-declared + ","
	hello := "," + strings.Join(linkHello("process").GetCapabilities(), ",") + ","
	for _, capability := range []string{"integration-job/v1", "integration-observe/v1"} {
		if !strings.Contains(header, ","+capability+",") {
			t.Errorf("the heartbeat's capability header %q does not declare %s", header, capability)
		}
		if !strings.Contains(hello, ","+capability+",") {
			t.Errorf("the link's Hello %q does not declare %s", hello, capability)
		}
	}
}
