//go:build linux || darwin

package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// The relay end to end on the runner (docs/main-checkout-git-contract.md §10): a fake apiserver
// receives what handleMainCheckoutRequest posts for a snapshot read and for each action kind, and
// each test asserts how many answers each request id got and what Git looks like after.

// fakeMainCheckoutServer records every POST under /runner/main-checkout/.
type fakeMainCheckoutServer struct {
	mu    sync.Mutex
	posts map[string][]json.RawMessage // path → bodies, in order
	tr    *Transport
}

func newFakeMainCheckoutServer(t *testing.T) *fakeMainCheckoutServer {
	t.Helper()
	f := &fakeMainCheckoutServer{posts: map[string][]json.RawMessage{}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if r.Method != http.MethodPost || !strings.Contains(r.URL.Path, "/runner/main-checkout/") {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		f.mu.Lock()
		f.posts[r.URL.Path] = append(f.posts[r.URL.Path], body)
		f.mu.Unlock()
		_, _ = w.Write([]byte(`{"accepted":true}`))
	}))
	t.Cleanup(server.Close)
	f.tr = NewTransport(server.URL, "token")
	return f
}

// answers is every body posted for request id (to /snapshot or /result).
func (f *fakeMainCheckoutServer) answers(id string) []json.RawMessage {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []json.RawMessage
	for p, bodies := range f.posts {
		if strings.Contains(p, "/main-checkout/"+id+"/") {
			out = append(out, bodies...)
		}
	}
	return out
}

// oneResult asserts id got exactly one result post and returns it.
func (f *fakeMainCheckoutServer) oneResult(t *testing.T, id string) MainCheckoutActionResult {
	t.Helper()
	got := f.answers(id)
	if len(got) != 1 {
		t.Fatalf("request %s got %d answers, want 1: %s", id, len(got), got)
	}
	var res MainCheckoutActionResult
	if err := json.Unmarshal(got[0], &res); err != nil {
		t.Fatal(err)
	}
	return res
}

// resetMainCheckoutSeen forgets every request this process took, as a runner restart does.
func resetMainCheckoutSeen(t *testing.T) {
	mainCheckoutSeenMu.Lock()
	mainCheckoutSeen = map[string]string{}
	mainCheckoutSeenMu.Unlock()
	t.Cleanup(func() {
		mainCheckoutSeenMu.Lock()
		mainCheckoutSeen = map[string]string{}
		mainCheckoutSeenMu.Unlock()
	})
}

func mcFuture() string { return time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano) }
func mcPast() string   { return time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano) }

func ownsOnly(roots ...string) func(string) bool {
	return func(root string) bool {
		for _, r := range roots {
			if real, err := mainCheckoutRoot(context.Background(), r); err == nil && real == root {
				return true
			}
		}
		return false
	}
}

// relayCase is one action kind, set up on its own checkout.
type relayCase struct {
	kind  string
	root  string
	cmd   MainCheckoutActionCommand
	deps  mainCheckoutDeps
	state func(t *testing.T) string // the Git state the action changes, as one string
	check func(t *testing.T, res MainCheckoutActionResult)
}

func moveRelayCase(t *testing.T) relayCase {
	f := newMoveFixture(t)
	mcWrite(t, f.repo, "a.txt", "one\nTWO\nthree\n")
	cmd := f.cmd(t, "a.txt")
	deps := f.deps()
	deps.owns = ownsOnly(f.repo)
	return relayCase{kind: mainCheckoutMove, root: f.repo, cmd: cmd, deps: deps,
		state: func(t *testing.T) string {
			return fileState(t, f.repo, "a.txt") + "|" + fileState(t, f.target, "a.txt") + "|" + strings.Join(rescueBranches(t, f.repo), ",")
		},
		check: func(t *testing.T, res MainCheckoutActionResult) {
			requireFiles(t, "source", f.repo, map[string]string{"a.txt": "one\ntwo\nthree\n"})
			requireFiles(t, "target", f.target, map[string]string{"a.txt": "one\nTWO\nthree\n"})
			if b := rescueBranches(t, f.repo); len(b) != 1 || res.RescueBranch != b[0] {
				t.Fatalf("rescue branches %v, result names %q", b, res.RescueBranch)
			}
		}}
}

func commitRelayCase(t *testing.T) relayCase {
	repo := realRepo(t)
	commitFiles(t, repo, "base", map[string]string{"c.txt": "v1\n", "other.txt": "x\n"})
	base := headSha(repo)
	mcWrite(t, repo, "c.txt", "v2\n")
	mcWrite(t, repo, "other.txt", "not chosen\n")
	cmd := commitCmd(mustScan(t, repo), "Relay commit", "c.txt")
	return relayCase{kind: mainCheckoutCommit, root: repo, cmd: cmd, deps: mainCheckoutDeps{owns: ownsOnly(repo)},
		state: func(t *testing.T) string { return headSha(repo) + "|" + mcReadFile(t, repo, "c.txt") },
		check: func(t *testing.T, res MainCheckoutActionResult) {
			if n := commitCount(t, repo, base); n != "1" {
				t.Fatalf("%s commits on main since the base, want 1", n)
			}
			if res.Head != headSha(repo) || mustGit(t, repo, "show", "HEAD:c.txt") != "v2" {
				t.Fatalf("result head %s, HEAD %s", res.Head, headSha(repo))
			}
			if fileState(t, repo, "other.txt") != "not chosen\n" {
				t.Fatal("an unchosen file was touched")
			}
		}}
}

func pushRelayCase(t *testing.T) relayCase {
	repo, bare := pushRepo(t, true)
	before := headSha(repo)
	commitFiles(t, repo, "to push", map[string]string{"p.txt": "push me\n"})
	head := headSha(repo)
	cmd := pushCmd(t, repo)
	return relayCase{kind: mainCheckoutPush, root: repo, cmd: cmd, deps: mainCheckoutDeps{owns: ownsOnly(repo)},
		state: func(t *testing.T) string { return remoteRef(t, bare, "refs/heads/main") },
		check: func(t *testing.T, res MainCheckoutActionResult) {
			if got := remoteRef(t, bare, "refs/heads/main"); got != head {
				t.Fatalf("origin main %s, want %s", got, head)
			}
			if res.RemoteBefore != before || res.RemoteAfter != head {
				t.Fatalf("range %s..%s, want %s..%s", res.RemoteBefore, res.RemoteAfter, before, head)
			}
		}}
}

func rescueRelayCase(t *testing.T) relayCase {
	repo := realRepo(t)
	commitFiles(t, repo, "base", map[string]string{"r.txt": "v1\n"})
	head := headSha(repo)
	mcWrite(t, repo, "r.txt", "dirty\n")
	mcWrite(t, repo, "new.txt", "untracked\n")
	scan := mustScan(t, repo)
	cmd := MainCheckoutActionCommand{MainCheckoutActionRequest: MainCheckoutActionRequest{
		Kind: mainCheckoutRescue, Root: scan.Snapshot.Root, Fingerprint: scan.Snapshot.Fingerprint, RequestID: "req-rescue",
	}}
	return relayCase{kind: mainCheckoutRescue, root: repo, cmd: cmd, deps: mainCheckoutDeps{owns: ownsOnly(repo)},
		state: func(t *testing.T) string {
			return fileState(t, repo, "r.txt") + "|" + fileState(t, repo, "new.txt") + "|" + strings.Join(rescueBranches(t, repo), ",")
		},
		check: func(t *testing.T, res MainCheckoutActionResult) {
			requireFiles(t, "checkout", repo, map[string]string{"r.txt": "v1\n", "new.txt": "<absent>"})
			b := rescueBranches(t, repo)
			if len(b) != 1 || res.RescueBranch != b[0] || res.Head != head {
				t.Fatalf("rescue branches %v, result %+v", b, res)
			}
			if refState(t, repo, b[0], "r.txt") != "dirty\n" || refState(t, repo, b[0], "new.txt") != "untracked\n" {
				t.Fatal("the rescue branch does not hold what the checkout held")
			}
		}}
}

var relayCases = []struct {
	name string
	make func(t *testing.T) relayCase
}{
	{"move", moveRelayCase}, {"commit", commitRelayCase}, {"push", pushRelayCase}, {"rescue", rescueRelayCase},
}

func (c relayCase) request(id string) MainCheckoutRunnerRequest {
	cmd := c.cmd
	return MainCheckoutRunnerRequest{ID: id, Op: "action", Command: &cmd}
}

// A snapshot read is answered once under its id, with the diffs asked for.
func TestMainCheckoutRelaySnapshotRead(t *testing.T) {
	resetMainCheckoutSeen(t)
	srv := newFakeMainCheckoutServer(t)
	repo := realRepo(t)
	commitFiles(t, repo, "base", map[string]string{"a.txt": "one\n", "b.txt": "bee\n"})
	mcWrite(t, repo, "a.txt", "ONE\n")
	mcWrite(t, repo, "b.txt", "BEE\n")
	deps := mainCheckoutDeps{owns: ownsOnly(repo)}
	req := MainCheckoutRunnerRequest{ID: "read-1", Op: "snapshot", Root: repo, DiffPaths: []string{"a.txt"}, ExpiresAt: mcFuture()}
	handleMainCheckoutRequest(srv.tr, req, deps)
	handleMainCheckoutRequest(srv.tr, req, deps) // delivered again
	got := srv.answers("read-1")
	if len(got) != 1 {
		t.Fatalf("%d answers", len(got))
	}
	var snap MainCheckoutSnapshotAnswer
	if err := json.Unmarshal(got[0], &snap); err != nil || snap.Snapshot == nil || len(snap.Snapshot.Files) != 2 ||
		len(snap.Diffs) != 1 || !strings.Contains(snap.Diffs[0].Patch, "+ONE") {
		t.Fatalf("snapshot answer %s (%v)", got[0], err)
	}

	// A root this runner doesn't work in is answered with an error, never read.
	other := realRepo(t)
	handleMainCheckoutRequest(srv.tr, MainCheckoutRunnerRequest{ID: "read-2", Op: "snapshot", Root: other, ExpiresAt: mcFuture()}, deps)
	if got := srv.answers("read-2"); len(got) != 1 || !strings.Contains(string(got[0]), `"error"`) || strings.Contains(string(got[0]), `"snapshot"`) {
		t.Fatalf("unowned read answered %s", got)
	}
}

// Each kind is dispatched to its function and answered once; the same request delivered again
// (while the first copy runs, and after it answered) changes nothing and is not answered again.
func TestMainCheckoutRelayEachKindOnceAndRedelivery(t *testing.T) {
	for _, tc := range relayCases {
		t.Run(tc.name, func(t *testing.T) {
			resetMainCheckoutSeen(t)
			srv := newFakeMainCheckoutServer(t)
			c := tc.make(t)
			c.cmd.ExpiresAt = mcFuture()
			id := "row-" + tc.name

			// Two deliveries racing, then one more after the answer.
			var wg sync.WaitGroup
			for i := 0; i < 2; i++ {
				wg.Add(1)
				go func() { defer wg.Done(); handleMainCheckoutRequest(srv.tr, c.request(id), c.deps) }()
			}
			wg.Wait()
			res := srv.oneResult(t, id)
			if res.Status != mainCheckoutDone || res.Kind != c.kind || res.RequestID != c.cmd.RequestID {
				t.Fatalf("result %+v", res)
			}
			c.check(t, res)
			after := c.state(t)
			handleMainCheckoutRequest(srv.tr, c.request(id), c.deps)
			srv.oneResult(t, id)
			if now := c.state(t); now != after {
				t.Fatalf("a redelivery changed the checkout: %q → %q", after, now)
			}
			c.check(t, res)
		})
	}
}

// A request past its deadline is not started: no answer, nothing changed.
func TestMainCheckoutRelayExpiredNotStarted(t *testing.T) {
	resetMainCheckoutSeen(t)
	srv := newFakeMainCheckoutServer(t)
	repo := realRepo(t)
	handleMainCheckoutRequest(srv.tr, MainCheckoutRunnerRequest{ID: "read-late", Op: "snapshot", Root: repo, ExpiresAt: mcPast()},
		mainCheckoutDeps{owns: ownsOnly(repo)})
	if got := srv.answers("read-late"); len(got) != 0 {
		t.Fatalf("an expired read was answered: %s", got)
	}
	for _, tc := range relayCases {
		t.Run(tc.name, func(t *testing.T) {
			c := tc.make(t)
			c.cmd.ExpiresAt = mcPast()
			before := c.state(t)
			handleMainCheckoutRequest(srv.tr, c.request("late-"+tc.name), c.deps)
			if got := srv.answers("late-" + tc.name); len(got) != 0 {
				t.Fatalf("an expired %s was answered: %s", tc.name, got)
			}
			if now := c.state(t); now != before {
				t.Fatalf("an expired %s changed the checkout: %q → %q", tc.name, before, now)
			}
		})
	}
}

// An action on a checkout this runner doesn't work in is refused, and nothing is changed.
func TestMainCheckoutRelayUnownedRootRefused(t *testing.T) {
	for _, tc := range relayCases {
		t.Run(tc.name, func(t *testing.T) {
			resetMainCheckoutSeen(t)
			srv := newFakeMainCheckoutServer(t)
			c := tc.make(t)
			c.cmd.ExpiresAt = mcFuture()
			c.deps.owns = func(string) bool { return false }
			before := c.state(t)
			handleMainCheckoutRequest(srv.tr, c.request("unowned"), c.deps)
			if res := srv.oneResult(t, "unowned"); res.Status != mainCheckoutRefused || res.Code != mainCheckoutFingerprintStale {
				t.Fatalf("result %+v", res)
			}
			if now := c.state(t); now != before {
				t.Fatalf("checkout changed: %q → %q", before, now)
			}
		})
	}
}

// A runner that stops in the middle of an action (after it changed Git, before it answered) and
// gets the request again after a restart answers once, with the outcome of the one change it made.
func TestMainCheckoutRelayRestartMidAction(t *testing.T) {
	oldStep, oldCommit, oldPush := mainCheckoutStep, mainCheckoutCommitStep, mainCheckoutPushStep
	restore := func() { mainCheckoutStep, mainCheckoutCommitStep, mainCheckoutPushStep = oldStep, oldCommit, oldPush }
	t.Cleanup(restore)
	killed := errors.New("killed")
	stops := map[string]func(){
		mainCheckoutMove: func() { mainCheckoutStep = func(step string) bool { return step == "copied" } },
		mainCheckoutCommit: func() {
			mainCheckoutCommitStep = func(step string) error { return map[bool]error{true: killed}[step == "index-align"] }
		},
		mainCheckoutPush:   func() { mainCheckoutPushStep = func(string) error { return killed } },
		mainCheckoutRescue: func() { mainCheckoutStep = func(step string) bool { return step == "rescue-cleaned" } },
	}
	for _, tc := range relayCases {
		t.Run(tc.name, func(t *testing.T) {
			resetMainCheckoutSeen(t)
			srv := newFakeMainCheckoutServer(t)
			c := tc.make(t)
			c.cmd.ExpiresAt = mcFuture()
			id := "restart-" + tc.name
			before := c.state(t)

			// The first run stops after its change, and answers nothing.
			stops[c.kind]()
			handleMainCheckoutRequest(srv.tr, c.request(id), c.deps)
			restore()
			if got := srv.answers(id); len(got) != 0 {
				t.Fatalf("the stopped run answered: %s", got)
			}
			if c.state(t) == before {
				t.Fatal("the stopped run changed nothing; the test does not stop mid-action")
			}

			// Restart: the process forgets the request; the control plane hands it out again.
			resetMainCheckoutSeen(t)
			handleMainCheckoutRequest(srv.tr, c.request(id), c.deps)
			res := srv.oneResult(t, id)
			if res.Status != mainCheckoutDone || res.RequestID != c.cmd.RequestID {
				t.Fatalf("result after restart %+v", res)
			}
			c.check(t, res)
		})
	}
}
