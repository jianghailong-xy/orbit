package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// The runner half of the SOURCE handshake (docs/project-source-contract.md §6.3), against real git.
//
// Against real git deliberately: what SR38 asks for is a SEQUENCE — fetch from the authority, then
// resolve — and the property it buys is that the commit frozen is one that really was the tip at
// that moment. A fake git can be made to agree with any order at all, including the one this exists
// to forbid (read whatever local ref happens to be lying around).

// pinServer is a control plane that records what the runner sent and answers with what is frozen.
type pinServer struct {
	*httptest.Server
	requests []SourcePinRequest
	paths    []string
	// respond builds the answer for the nth request; nil answers "you won, with what you sent".
	respond func(n int, req SourcePinRequest) SourcePinResponse
}

func newPinServer(t *testing.T) *pinServer {
	t.Helper()
	p := &pinServer{}
	p.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req SourcePinRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		p.paths = append(p.paths, r.URL.Path)
		p.requests = append(p.requests, req)
		res := SourcePinResponse{State: sourceStatePinned, BaseSha: req.BaseSha, WonRace: true}
		if p.respond != nil {
			res = p.respond(len(p.requests)-1, req)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(res)
	}))
	t.Cleanup(p.Close)
	return p
}

// originAndClone builds an upstream repo with one commit and a clone of it, and returns both paths
// plus the upstream tip.
func originAndClone(t *testing.T) (origin, clone, tip string) {
	t.Helper()
	origin = initRepo(t)
	clone = filepath.Join(t.TempDir(), "clone")
	if out, err := git(t.TempDir(), "clone", origin, clone); err != nil {
		t.Fatalf("clone: %v (%s)", err, out)
	}
	// A clone starts from a fresh .git/config: the origin's repo-local identity is not copied.
	mustGit(t, clone, "config", "user.email", "test@orbit")
	mustGit(t, clone, "config", "user.name", "Test")
	return origin, clone, mustGit(t, origin, "rev-parse", "HEAD")
}

func selectedJob(workDir string) *ClaimedSession {
	return &ClaimedSession{
		SessionID: "11111111-1111-4111-8111-111111111111",
		WorkDir:   workDir,
		Branch:    "orbit/work",
		Source: &SessionSource{
			State:          sourceStateSelected,
			Kind:           "PROJECT_UPSTREAM",
			CodebaseID:     "22222222-2222-4222-8222-222222222222",
			RepoURL:        "https://example.invalid/acme/widgets",
			Ref:            "refs/heads/main",
			ConfigRevision: "0",
			RefAuthority:   refAuthorityRemote,
			RemoteName:     "origin",
		},
	}
}

// A ref-valued selector is resolved by asking the authority, and the commit that is frozen is the
// one the ref pointed at WHEN THE RUN STARTED — not when the session was created (SR32 / S2.04).
func TestSourcePinFreezesTheTipAtStart(t *testing.T) {
	origin, clone, atCreate := originAndClone(t)
	srv := newPinServer(t)
	tr := NewTransport(srv.URL, "tok")

	// The session queued while the line moved on. This is the case the two separate freezing
	// moments exist for: the SELECTOR is what was decided at create, the COMMIT is what is true at
	// start, and a task that waited ten minutes should begin from the main it begins at.
	commitFile(t, origin, "later.txt", "later\n", "upstream advanced")
	atStart := mustGit(t, origin, "rev-parse", "HEAD")
	if atStart == atCreate {
		t.Fatal("fixture did not advance the upstream ref")
	}

	job := selectedJob(clone)
	if err := ensureSourcePinned(context.Background(), tr, job); err != nil {
		t.Fatalf("ensureSourcePinned: %v", err)
	}
	if len(srv.requests) != 1 {
		t.Fatalf("expected one pin request, got %d", len(srv.requests))
	}
	if got := srv.requests[0].BaseSha; got != atStart {
		t.Errorf("pinned %s, want the tip at start %s (create-time tip was %s)", got, atStart, atCreate)
	}
	if !strings.HasSuffix(srv.paths[0], "/source/pin") {
		t.Errorf("pin posted to %s", srv.paths[0])
	}
	if job.Source.State != sourceStatePinned || job.Source.BaseSha != atStart {
		t.Errorf("job not left pinned: state=%s baseSha=%s", job.Source.State, job.Source.BaseSha)
	}
}

// SR38: the resolution FETCHES and then resolves. A local ref left behind by something else is not
// an answer — it may be a commit that was never the authority's tip at any moment.
func TestSourcePinRefusesToTrustAStaleLocalRef(t *testing.T) {
	origin, clone, _ := originAndClone(t)
	srv := newPinServer(t)
	tr := NewTransport(srv.URL, "tok")

	// The clone's local `refs/heads/main` is deliberately moved somewhere the authority has never
	// been. If resolution read it, that fabricated commit is what would be frozen.
	commitFile(t, clone, "local.txt", "only here\n", "local-only commit")
	fabricated := mustGit(t, clone, "rev-parse", "HEAD")
	authoritative := mustGit(t, origin, "rev-parse", "HEAD")

	job := selectedJob(clone)
	if err := ensureSourcePinned(context.Background(), tr, job); err != nil {
		t.Fatalf("ensureSourcePinned: %v", err)
	}
	if got := srv.requests[0].BaseSha; got != authoritative {
		t.Errorf("pinned %s; want the authority's tip %s, not the local %s", got, authoritative, fabricated)
	}
}

// originBranch gives origin a branch with a commit of its own, without touching origin's checkout.
func originBranch(t *testing.T, origin, branch string) string {
	t.Helper()
	sha := mustGit(t, origin, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "tip of "+branch)
	mustGit(t, origin, "update-ref", "refs/heads/"+branch, sha)
	return sha
}

// gitRunningBetweenFetchAndRead puts a git first on PATH that runs the real one and, whenever that
// was a fetch naming ref, runs the shell command `between` before it returns: the moment between a
// resolution's fetch and its read of what it fetched, which nothing outside resolveSourceSha can
// otherwise reach.
func gitRunningBetweenFetchAndRead(t *testing.T, checkout, ref, between string) {
	t.Helper()
	realGit, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}
	bin := t.TempDir()
	script := "#!/bin/sh\n" +
		"\"$ORBIT_TEST_REAL_GIT\" \"$@\"\n" +
		"status=$?\n" +
		"case \" $* \" in *\" fetch \"*\"$ORBIT_TEST_FETCHED_REF\"*) " + between + " ;; esac\n" +
		"exit $status\n"
	if err := os.WriteFile(filepath.Join(bin, "git"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ORBIT_TEST_REAL_GIT", realGit)
	t.Setenv("ORBIT_TEST_CHECKOUT", checkout)
	t.Setenv("ORBIT_TEST_FETCHED_REF", ref)
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
}

// THE RACE THIS PINS SHUT (2026-10-08, runner workstation-gpu, project 34bmzOkov3xN2yLPrnsCk, three
// times in one day). The resolution runs in the workspace's main checkout, and so do the integration
// jobs — landings, promotion checks — and other sessions' resolutions, each with a fetch of its own.
// It used to read what it had fetched out of FETCH_HEAD: one file per checkout, which every one of
// those fetches rewrites, emptying it when it starts and filling it when it ends. A fetch landing
// between the resolution's fetch and its read either left the file empty, and a ref that existed
// was refused BASE_REF_NOT_FOUND ("fatal: Needed a single revision"), or left its own answer in it,
// and the session was pinned to another project's freshly pushed tip.
//
// The window is a few milliseconds wide, so the other fetch is put in it on purpose: right after the
// resolution's fetch of its ref returns, before anything is read.
func TestSourcePinIsNotTakenFromAnotherFetchesAnswer(t *testing.T) {
	origin, clone, _ := originAndClone(t)
	mine := originBranch(t, origin, "project/mine")
	other := originBranch(t, origin, "project/other")

	for _, tc := range []struct{ name, between string }{
		// An integration job's `git fetch <remote> <ref>` (integrationFetch) of another project's
		// line, over by the time the resolution reads.
		{"another fetch finished in between",
			`"$ORBIT_TEST_REAL_GIT" -C "$ORBIT_TEST_CHECKOUT" fetch --quiet origin refs/heads/project/other`},
		// One still running: git empties FETCH_HEAD when a fetch starts and writes it when it ends.
		{"another fetch still running", `: > "$ORBIT_TEST_CHECKOUT/.git/FETCH_HEAD"`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			gitRunningBetweenFetchAndRead(t, clone, "refs/heads/project/mine", tc.between)
			job := selectedJob(clone)
			job.Source.Ref = "refs/heads/project/mine"

			sha, refusal := resolveSourceSha(job)
			if refusal != nil {
				t.Fatalf("refused %s (stderr %q), but refs/heads/project/mine exists at %s",
					refusal.Code, refusal.Detail["stderr"], mine)
			}
			if sha == other {
				t.Fatalf("pinned %s, the tip of refs/heads/project/other that another fetch had just fetched; "+
					"want refs/heads/project/mine's %s", sha, mine)
			}
			if sha != mine {
				t.Fatalf("pinned %s, want refs/heads/project/mine's tip %s", sha, mine)
			}
			if left := mustGit(t, clone, "for-each-ref", "refs/orbit-source-pin/"); left != "" {
				t.Errorf("the resolution left its fetch's ref behind: %s", left)
			}
		})
	}
}

// The same race left to happen by itself: sessions on two lines resolving in one checkout at the
// same moment, again and again. Each must come out on its own line's tip, every time.
func TestSourcePinConcurrentResolutionsKeepTheirOwnRefs(t *testing.T) {
	origin, clone, _ := originAndClone(t)
	lines := []struct{ ref, tip string }{
		{"refs/heads/project/a", originBranch(t, origin, "project/a")},
		{"refs/heads/project/b", originBranch(t, origin, "project/b")},
	}
	const rounds = 15
	failures := make(chan string, len(lines)*rounds)
	var wg sync.WaitGroup
	for i, line := range lines {
		job := selectedJob(clone)
		job.SessionID = fmt.Sprintf("%08d-1111-4111-8111-111111111111", i)
		job.Source.Ref = line.ref
		wg.Add(1)
		go func(job *ClaimedSession, want string) {
			defer wg.Done()
			for round := 0; round < rounds; round++ {
				sha, refusal := resolveSourceSha(job)
				switch {
				case refusal != nil:
					failures <- fmt.Sprintf("%s, round %d: refused %s (stderr %q)",
						job.Source.Ref, round, refusal.Code, refusal.Detail["stderr"])
				case sha != want:
					failures <- fmt.Sprintf("%s, round %d: pinned %s, want %s", job.Source.Ref, round, sha, want)
				}
			}
		}(job, line.tip)
	}
	wg.Wait()
	close(failures)
	for failure := range failures {
		t.Error(failure)
	}
}

// A fetch of a branch also moves this checkout's remote-tracking copy of it, which every other fetch
// of that line here writes as well; two at once and git refuses the second with "cannot lock ref".
// That is a statement about another process, not about the ref, and a refusal ends the session for
// good — so it is retried the way an integration job's fetch is (integrationFetch).
func TestSourcePinRetriesARefLockAnotherFetchHeld(t *testing.T) {
	origin, clone, _ := originAndClone(t)
	// origin/main has to move, or the fetch never takes its lock.
	commitFile(t, origin, "later.txt", "later\n", "upstream advanced")
	tip := mustGit(t, origin, "rev-parse", "HEAD")
	lock := filepath.Join(clone, ".git", "refs", "remotes", "origin", "main.lock")
	if err := os.WriteFile(lock, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	releaseRefLockOnFirstRetry(t, lock)

	sha, refusal := resolveSourceSha(selectedJob(clone))
	if refusal != nil {
		t.Fatalf("refused %s over a lock another fetch held for a moment (stderr %q)", refusal.Code, refusal.Detail["stderr"])
	}
	if sha != tip {
		t.Fatalf("pinned %s, want origin's tip %s", sha, tip)
	}
}

// A lock held through every attempt is still not a missing ref: it is reported as the authority
// being out of reach, with git's own words, never as BASE_REF_NOT_FOUND.
func TestSourcePinRefLockThatOutlivesItsRetriesIsNotAMissingRef(t *testing.T) {
	origin, clone, _ := originAndClone(t)
	commitFile(t, origin, "later.txt", "later\n", "upstream advanced")
	lock := filepath.Join(clone, ".git", "refs", "remotes", "origin", "main.lock")
	if err := os.WriteFile(lock, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	restore := integrationFetchLockPause
	integrationFetchLockPause = func(time.Duration) {}
	t.Cleanup(func() {
		integrationFetchLockPause = restore
		_ = os.Remove(lock)
	})

	_, refusal := resolveSourceSha(selectedJob(clone))
	if refusal == nil {
		t.Fatal("resolved through a ref lock that was never released")
	}
	if refusal.Code != sourceRefusalAuthorityUnreachable {
		t.Fatalf("refusal code %q, want %q: a lock another process holds is not a missing ref",
			refusal.Code, sourceRefusalAuthorityUnreachable)
	}
	if stderr, _ := refusal.Detail["stderr"].(string); !strings.Contains(stderr, "cannot lock ref") {
		t.Fatalf("the refusal does not carry git's own words: %v", refusal.Detail)
	}
}

// SR38 again, for the ref the fetch writes into: one left behind by an attempt that died between its
// fetch and its cleanup is overwritten by the next fetch and never read in its place — not even when
// that fetch fails.
func TestSourcePinNeverReadsAPinRefLeftBehind(t *testing.T) {
	origin, clone, _ := originAndClone(t)
	commitFile(t, clone, "local.txt", "only here\n", "local-only commit")
	fabricated := mustGit(t, clone, "rev-parse", "HEAD")
	authoritative := mustGit(t, origin, "rev-parse", "HEAD")
	job := selectedJob(clone)
	leftover := "refs/orbit-source-pin/" + job.SessionID

	mustGit(t, clone, "update-ref", leftover, fabricated)
	if sha, refusal := resolveSourceSha(job); refusal != nil || sha != authoritative {
		t.Fatalf("resolved %q (refusal %+v); want the authority's %s, not the leftover %s",
			sha, refusal, authoritative, fabricated)
	}

	mustGit(t, clone, "update-ref", leftover, fabricated)
	job.Source.Ref = "refs/heads/does-not-exist"
	if sha, refusal := resolveSourceSha(job); refusal == nil || refusal.Code != sourceRefusalRefNotFound {
		t.Fatalf("resolved %q (refusal %+v); a ref the authority does not have is %s, whatever was left behind",
			sha, refusal, sourceRefusalRefNotFound)
	}
}

// Gate G2 asks whether THIS MACHINE holds the repository, and an agent's workDir is allowed to carry
// a leading ~ — sessionExecDir expands it before the engine chdirs in. Resolution has to expand it
// too: as written, "~/orbit" is not a path that exists, so isGitRepo said no and every project task
// on such an agent was refused SOURCE_AUTHORITY_UNREACHABLE by a checkout the machine has (live on
// longdeMac-mini.local, 2026-10-07: the agent is configured "~/orbit" and no project task could
// start until it was re-spelled).
func TestSourcePinExpandsATildeWorkDir(t *testing.T) {
	origin, _, tip := originAndClone(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	clone := filepath.Join(home, "orbit")
	if out, err := git(t.TempDir(), "clone", origin, clone); err != nil {
		t.Fatalf("clone: %v (%s)", err, out)
	}
	srv := newPinServer(t)
	tr := NewTransport(srv.URL, "tok")

	job := selectedJob("~/orbit")
	if err := ensureSourcePinned(context.Background(), tr, job); err != nil {
		t.Fatalf("ensureSourcePinned: %v", err)
	}
	if len(srv.requests) != 1 || srv.requests[0].Refusal != nil {
		t.Fatalf("expected one resolved pin, got %+v", srv.requests)
	}
	if job.Source.State != sourceStatePinned || job.Source.BaseSha != tip {
		t.Errorf("pin after a ~ workDir: state=%s baseSha=%s, want PINNED %s",
			job.Source.State, job.Source.BaseSha, tip)
	}
}

// SR29: every recovery path READS the pin. Resume, reclaim and takeover must not resolve again, or
// a ref that moved would quietly make the second half of a run about different code than the first.
func TestSourcePinnedSessionResolvesNothing(t *testing.T) {
	origin, clone, tip := originAndClone(t)
	srv := newPinServer(t)
	tr := NewTransport(srv.URL, "tok")

	commitFile(t, origin, "after.txt", "after\n", "upstream moved after the pin")

	job := selectedJob(clone)
	job.Source.State = sourceStatePinned
	job.Source.BaseSha = tip
	if err := ensureSourcePinned(context.Background(), tr, job); err != nil {
		t.Fatalf("ensureSourcePinned: %v", err)
	}
	if len(srv.requests) != 0 {
		t.Errorf("a pinned session asked the control plane to re-freeze: %d requests", len(srv.requests))
	}
	if job.Source.BaseSha != tip {
		t.Errorf("pin moved to %s; it must stay %s", job.Source.BaseSha, tip)
	}
}

// SR30: the loser of the compare-and-set adopts the winner's commit. A worktree may already stand
// on it, and one session may have only one baseline.
func TestSourcePinLoserAdoptsTheWinnersCommit(t *testing.T) {
	_, clone, _ := originAndClone(t)
	winner := strings.Repeat("a", 40)
	srv := newPinServer(t)
	srv.respond = func(int, SourcePinRequest) SourcePinResponse {
		return SourcePinResponse{
			State: sourceStatePinned, BaseSha: winner, WonRace: false,
			ResolvedByRunnerID: "33333333-3333-4333-8333-333333333333",
		}
	}
	tr := NewTransport(srv.URL, "tok")

	job := selectedJob(clone)
	if err := ensureSourcePinned(context.Background(), tr, job); err != nil {
		t.Fatalf("ensureSourcePinned: %v", err)
	}
	if job.Source.BaseSha != winner {
		t.Errorf("loser kept its own answer %s instead of adopting %s", job.Source.BaseSha, winner)
	}
}

// SR33's first half, as the caller sees it: anything short of PINNED is an error, and the caller's
// contract is that it starts nothing. The refusal carries one of §10.1's codes rather than a free
// text, so the control plane can record WHICH gate stopped.
func TestSourcePinFailuresNeverReachPinned(t *testing.T) {
	_, clone, _ := originAndClone(t)

	t.Run("a ref the authority does not have", func(t *testing.T) {
		srv := newPinServer(t)
		srv.respond = func(_ int, req SourcePinRequest) SourcePinResponse {
			if req.Refusal == nil {
				t.Errorf("expected a refusal, got baseSha %q", req.BaseSha)
				return SourcePinResponse{State: sourceStatePinned, BaseSha: req.BaseSha, WonRace: true}
			}
			return SourcePinResponse{State: sourceStateRefused, RefusalCode: req.Refusal.Code}
		}
		job := selectedJob(clone)
		job.Source.Ref = "refs/heads/does-not-exist"
		err := ensureSourcePinned(context.Background(), NewTransport(srv.URL, "tok"), job)
		if err == nil {
			t.Fatal("a session whose ref does not exist was allowed to proceed")
		}
		if got := srv.requests[0].Refusal.Code; got != sourceRefusalRefNotFound {
			t.Errorf("refusal code %q, want %q", got, sourceRefusalRefNotFound)
		}
		if job.Source.State == sourceStatePinned {
			t.Error("the job was left pinned by a refused resolution")
		}
	})

	t.Run("a control plane that cannot be reached", func(t *testing.T) {
		srv := newPinServer(t)
		srv.Close() // nothing is listening: the pin cannot happen, so nothing is frozen
		job := selectedJob(clone)
		if err := ensureSourcePinned(context.Background(), NewTransport(srv.URL, "tok"), job); err == nil {
			t.Fatal("a session whose pin never committed was allowed to proceed")
		}
		if job.Source.BaseSha != "" {
			t.Errorf("a local answer was kept as if it had been frozen: %s", job.Source.BaseSha)
		}
	})

	t.Run("an already-refused session is terminal", func(t *testing.T) {
		srv := newPinServer(t)
		job := selectedJob(clone)
		job.Source.State = sourceStateRefused
		job.Source.RefusalCode = sourceRefusalRefNotFound
		if err := ensureSourcePinned(context.Background(), NewTransport(srv.URL, "tok"), job); err == nil {
			t.Fatal("a REFUSED session was allowed to re-resolve; recovery is a new session")
		}
		if len(srv.requests) != 0 {
			t.Errorf("a REFUSED session talked to the control plane: %d requests", len(srv.requests))
		}
	})
}

// SR45/SR46: a Legacy session takes no Git requirement and makes no call. Every session that exists
// today is one of these, so this is the assertion that says the feature ships inert.
func TestSourcePinIsInertForLegacySessions(t *testing.T) {
	srv := newPinServer(t)
	tr := NewTransport(srv.URL, "tok")
	for _, job := range []*ClaimedSession{
		{SessionID: "s1", WorkDir: t.TempDir()},
		{SessionID: "s2", WorkDir: t.TempDir(), Source: &SessionSource{State: sourceStateUnbound}},
	} {
		if needsSourcePin(job) {
			t.Errorf("session %s was treated as a SOURCE session", job.SessionID)
		}
		if err := ensureSourcePinned(context.Background(), tr, job); err != nil {
			t.Errorf("session %s: %v", job.SessionID, err)
		}
	}
	if len(srv.requests) != 0 {
		t.Errorf("a Legacy session talked to the SOURCE endpoint: %d requests", len(srv.requests))
	}
}

// S2.07: the pin comes BEFORE the worktree, and the worktree before the engine (SR33).
//
// A source-order assertion rather than a behavioural one, because the thing being constrained is
// the order of two statements inside the run loop's session start — and the failure it prevents is
// silent: a worktree created first would be forked from the workDir's HEAD, and every later step
// would succeed on the wrong code.
func TestWorktreeIsNotCreatedBeforeThePin(t *testing.T) {
	source, err := os.ReadFile("runloop.go")
	if err != nil {
		t.Fatal(err)
	}
	pin := strings.Index(string(source), "ensureSourcePinned(loopCtx, t, job)")
	worktree := strings.Index(string(source), "setupWorktree(job, sessionExecDir(job.WorkDir))")
	if pin < 0 || worktree < 0 {
		t.Fatalf("cannot find both steps in the session start path (pin=%d worktree=%d)", pin, worktree)
	}
	if pin > worktree {
		t.Error("the worktree is created before the SOURCE is pinned; a failed pin would already " +
			"have forked a checkout from the workDir's HEAD")
	}
	// And the bail-out is a return, not a log-and-continue: SR33 makes engine start a conjunction,
	// so a run that cannot pin must not reach the rest of the function at all.
	after := string(source)[pin:]
	if !strings.Contains(after[:strings.Index(after, "stageCredential := func()")], "return") {
		t.Error("a failed pin does not stop the session from starting")
	}
}

// A pinned run whose checkout was refused is reported the way an engine that cannot start is: the run
// ends FAILED with the refusal's code in its error, and no engine is started for it.
func TestSourceRefusedRunFailsBeforeAnyEngine(t *testing.T) {
	// Asserted in the source first, so a build without the check stops here instead of reaching the
	// real engine path through the call below.
	source, err := os.ReadFile("session.go")
	if err != nil {
		t.Fatal(err)
	}
	start := strings.Index(string(source), "func runSessionProcess(")
	if start < 0 {
		t.Fatal("cannot find runSessionProcess in session.go")
	}
	body := string(source)[start:]
	refusal, engine := strings.Index(body, "job.SourceRefusal"), strings.Index(body, "ensureEngine(")
	if refusal < 0 || engine < 0 || refusal > engine {
		t.Fatalf("runSessionProcess does not stop a refused run before ensureEngine (refusal check at %d, ensureEngine at %d)", refusal, engine)
	}

	job := &ClaimedSession{SessionID: "s-refused", SourceRefusal: &SourcePinRefusal{
		Code:   sourceRefusalDependencyNotLanded,
		Detail: map[string]interface{}{"reason": "pinned commit abc does not contain prerequisite commit(s) def"},
	}}
	var events []string
	emit := func(eventType string, payload map[string]interface{}) {
		msg, _ := payload["message"].(string)
		events = append(events, eventType+": "+msg)
	}
	st, ended, reload := runSessionProcess(context.Background(), context.Background(), nil, job, "", "", t.TempDir(),
		emit, nil, func(string) {}, true, nil, nil, nil, nil, nil)
	if st != stFailed || !ended || reload {
		t.Errorf("runSessionProcess = (%s, ended=%v, reload=%v), want a failed end", st, ended, reload)
	}
	if len(events) != 1 || !strings.HasPrefix(events[0], evError+": ") ||
		!strings.Contains(events[0], sourceRefusalDependencyNotLanded) || !strings.Contains(events[0], "does not contain prerequisite") {
		t.Errorf("events = %q, want exactly one error naming the refusal", events)
	}
}
