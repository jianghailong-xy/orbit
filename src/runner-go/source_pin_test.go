package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
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
