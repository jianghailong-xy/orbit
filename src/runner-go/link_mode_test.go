package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"orbit/linkpb"
)

// Which way each call goes: the daemon's calls over the link and nothing else, every other process's over HTTPS.

// recordedRequest is one request a recording control plane received, whole.
type recordedRequest struct {
	Method string
	URI    string
	Body   string
	Header http.Header
}

// recordingControlPlane answers every request with answer and keeps it.
type recordingControlPlane struct {
	*httptest.Server
	mu       sync.Mutex
	received []recordedRequest
	answer   func(r *http.Request) (int, string)
}

func newRecordingControlPlane(t *testing.T) *recordingControlPlane {
	t.Helper()
	cp := &recordingControlPlane{}
	cp.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		h := r.Header.Clone()
		for _, name := range []string{"Accept-Encoding", "User-Agent", "Content-Length"} {
			h.Del(name)
		}
		cp.mu.Lock()
		cp.received = append(cp.received, recordedRequest{Method: r.Method, URI: r.URL.RequestURI(), Body: string(body), Header: h})
		answer := cp.answer
		cp.mu.Unlock()
		status, out := http.StatusOK, `{}`
		if answer != nil {
			status, out = answer(r)
		}
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(out))
	}))
	t.Cleanup(cp.Close)
	return cp
}

func (cp *recordingControlPlane) requests() []recordedRequest {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	return append([]recordedRequest{}, cp.received...)
}

// linkDaemonWorkout makes one call of each kind the daemon makes, over t.
func linkDaemonWorkout(t *testing.T, tr *Transport) {
	t.Helper()
	ctx := context.Background()
	if _, err := tr.heartbeat(HeartbeatRequest{Status: "ONLINE", Version: version, LeaseOwner: tr.leaseOwner,
		SupervisedSessionIDs: []string{"session-a"}, ReposRoot: "/srv/repos"}); err != nil {
		t.Fatal(err)
	}
	if _, err := tr.claimSession(ctx, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := tr.inbox(ctx, "session-a", "gen-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := tr.turnComplete(ctx, "session-a", TurnCompleteRequest{TurnID: "turn-1", Status: "completed"}); err != nil {
		t.Fatal(err)
	}
	if err := tr.mergeResult("session-a", MergeResultRequest{OperationID: "op-1", Status: "merged"}); err != nil {
		t.Fatal(err)
	}
	if _, err := tr.pollApproval(ctx, "session-a", "ap-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := tr.me(); err != nil {
		t.Fatal(err)
	}
	if err := tr.cursorKeyCheckResult(CursorKeyCheckResult{CheckID: linkTestCheckID, State: "INVALID", KeyFingerprint: "0123456789abcdef"}); err != nil {
		t.Fatal(err)
	}
	if err := tr.cursorKeyCheck("session-a", CursorKeyCheckReport{State: "VALID", KeyFingerprint: "0123456789abcdef"}); err != nil {
		t.Fatal(err)
	}
	if err := tr.sessionNotify("session-a", "Background shell job-1 ended (exit code 0): make"); err != nil {
		t.Fatal(err)
	}
	var agents json.RawMessage
	if err := tr.do(ctx, http.MethodGet, "/runner/agents", nil, &agents, 10*time.Second); err != nil {
		t.Fatal(err)
	}
}

// linkTestCheckID is a Cursor key check's id, as an apiserver mints one (cursor-key-check-relay.ts).
const linkTestCheckID = "0123456789abcdef0123456789abcdef"

// The link is the one way the daemon's work goes: every call of each kind goes over it from the first, with no call over
// HTTPS before it, and HTTPS hears only what stays there (D14): the link token and the agent tool API.
func TestEveryDaemonCallGoesOverTheLink(t *testing.T) {
	r := newLinkWorkRig(t)
	r.g.backend = func(c *fakeWorkConn, rpc *linkpb.Rpc) *linkpb.RpcResult {
		return fakeWorkAnswer(rpc, 200, `{"id":"runner-1","name":"over-the-link"}`)
	}
	r.useLink(t)
	linkDaemonWorkout(t, r.t)
	me, err := r.t.me()
	if err != nil {
		t.Fatal(err)
	}
	if me.Name != "over-the-link" {
		t.Errorf("answered %+v", me)
	}
	for _, path := range []string{"/runner/sessions/claim", "/runner/sessions/session-a/inbox", "/runner/sessions/session-a/turn-complete",
		"/runner/sessions/session-a/merge-result", "/runner/sessions/session-a/approvals/ap-1", "/runner/me",
		"/runner/cursor-key-check-result", "/runner/sessions/session-a/cursor-key-check", "/runner/sessions/session-a/notify"} {
		if len(r.g.rpcsTo(path)) == 0 {
			t.Errorf("%s did not go over the link", path)
		}
	}
	if _, _, beats := r.g.snapshot(); len(beats) == 0 {
		t.Error("the heartbeat did not go over the link")
	}
	if n := len(r.g.rpcsTo("/runner/agents")); n != 0 {
		t.Errorf("the agent tool API went over the link %d times", n)
	}
	if n := len(r.cp.requests("/api/runner/agents")); n != 1 {
		t.Errorf("the agent tool API went over HTTPS %d times, want 1", n)
	}
	for _, req := range r.cp.everything() {
		if req.path != "/api/runner/link-token" && req.path != "/api/runner/agents" {
			t.Errorf("%s went over HTTPS", req.path)
		}
	}
}

// A daemon call with no connection to go on fails as a network failure, which callers retry, within its own deadline,
// and goes nowhere else.
func TestADaemonCallWithNoLinkFailsAsRetryable(t *testing.T) {
	r := newLinkWorkRig(t)
	r.g.refuse = func(*http.Request) (int, string, string) {
		return http.StatusServiceUnavailable, `{"code":"DRAINING"}`, "30"
	}
	r.m.start()
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	_, err := r.t.claimSession(ctx, nil)
	if err == nil {
		t.Fatal("a claim with no connection succeeded")
	}
	if !isRetryableTransportError(err) {
		t.Errorf("%v is not retryable: the claim loop would stop the runner", err)
	}
	if n := len(r.cp.requests("/api/runner/sessions/claim")); n != 0 {
		t.Errorf("the claim went over HTTPS %d times", n)
	}
}

// A gateway that says MODE_HTTP forwards nothing: it is older than this binary and its server's RUNNER_LINK_REQUIRED is
// off, or it has not read it yet. Nothing goes over HTTPS for it. A connection welcomed in MODE_HTTP is closed and the
// next one opens after a wait, a beat answered MODE_HTTP fails, and a call refused LINK_MODE_HTTP is sent again until its
// deadline. Once the gateway says MODE_LINK the work goes on.
func TestAGatewayInModeHTTPLeavesTheWorkWaitingForTheLink(t *testing.T) {
	t.Run("Welcome", func(t *testing.T) {
		r := newLinkWorkRig(t)
		r.g.setMode(linkpb.Mode_MODE_HTTP)
		r.m.start()
		r.g.waitWelcomed(t, 1)
		linkWaitFor(t, 5*time.Second, "the connection welcomed in MODE_HTTP to close", func() bool { return len(r.g.open()) == 0 })
		ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
		defer cancel()
		if _, err := r.t.claimSession(ctx, nil); !errors.Is(err, errLinkNotConnected) {
			t.Errorf("a claim while the only gateway says MODE_HTTP: %v", err)
		}
		if n := len(r.cp.requests("/api/runner/sessions/claim")); n != 0 {
			t.Errorf("the claim went over HTTPS %d times", n)
		}
		r.g.setMode(linkpb.Mode_MODE_LINK)
		linkWaitFor(t, 20*time.Second, "the next connection to carry the work", func() bool { return r.m.work.current() != nil })
		if _, err := r.t.me(); err != nil {
			t.Fatal(err)
		}
		if !logged(r.logs, errLinkGatewayModeHTTP.Error()) {
			t.Errorf("the log does not say why: %v", r.logs.all())
		}
	})
	t.Run("HeartbeatAck", func(t *testing.T) {
		r := newLinkWorkRig(t)
		r.useLink(t)
		r.g.setMode(linkpb.Mode_MODE_HTTP)
		if _, err := r.t.heartbeat(HeartbeatRequest{Status: "ONLINE", LeaseOwner: r.t.leaseOwner}); !errors.Is(err, errLinkGatewayModeHTTP) {
			t.Errorf("a beat answered MODE_HTTP: %v", err)
		}
		if n := len(r.cp.requests("/api/runner/heartbeat")); n != 0 {
			t.Errorf("the beat went over HTTPS %d times", n)
		}
		r.g.setMode(linkpb.Mode_MODE_LINK)
		if _, err := r.t.heartbeat(HeartbeatRequest{Status: "ONLINE", LeaseOwner: r.t.leaseOwner}); err != nil {
			t.Errorf("a beat once the gateway says MODE_LINK: %v", err)
		}
	})
	t.Run("LINK_MODE_HTTP", func(t *testing.T) {
		r := newLinkWorkRig(t)
		r.useLink(t)
		r.g.setMode(linkpb.Mode_MODE_HTTP) // its Rpcs are refused LINK_MODE_HTTP from now on
		go func() {
			time.Sleep(300 * time.Millisecond)
			r.g.setMode(linkpb.Mode_MODE_LINK)
		}()
		if _, err := r.t.me(); err != nil {
			t.Fatalf("the refused call, sent again: %v", err)
		}
		if n := len(r.cp.requests("/api/runner/me")); n != 0 {
			t.Errorf("the refused call went over HTTPS %d times", n)
		}
		if calls := r.g.rpcsTo("/runner/me"); len(calls) < 2 || calls[0].requestID != calls[len(calls)-1].requestID {
			t.Errorf("the refused call went as %+v: want it sent again under its request_id", calls)
		}
	})
}

// The daemon's transport names no caller on any request; every other transport made with the runner credential
// names its caller on every request (runnerCallerHeader).
func TestTheDaemonNeverSaysWhoIsCalling(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	cp := newRecordingControlPlane(t)
	daemon := newCallerTransport(cp.URL, "runner-token", runnerCallerCLI)
	stop := startLink(daemon) // what runLoop does with its transport
	defer stop()
	var agents json.RawMessage
	if err := daemon.do(context.Background(), http.MethodGet, "/runner/agents", nil, &agents, 10*time.Second); err != nil {
		t.Fatal(err)
	}
	_, _ = daemon.fetchAttachment(context.Background(), "session-a", "att-1")
	requests := cp.requests()
	if len(requests) < 2 {
		t.Fatalf("%d requests over HTTPS", len(requests))
	}
	for _, r := range requests {
		if v := r.Header.Get(runnerCallerHeader); v != "" {
			t.Errorf("the daemon's %s %s says %s: %s", r.Method, r.URI, runnerCallerHeader, v)
		}
	}
}

// The daemon's calls that went beside the agent tool API until 2026-10-28 go where its other calls go: a Cursor key
// check's answer, a session's own key check and a background job's alert travel over the link, and not over HTTPS.
func TestTheCursorKeyChecksAndTheJobAlertGoOverTheLink(t *testing.T) {
	calls := []struct {
		path string
		body string
		call func(*Transport) error
	}{
		{"/runner/cursor-key-check-result", `{"checkId":"` + linkTestCheckID + `","state":"INVALID","keyFingerprint":"0123456789abcdef"}`,
			func(tr *Transport) error {
				return tr.cursorKeyCheckResult(CursorKeyCheckResult{CheckID: linkTestCheckID, State: "INVALID", KeyFingerprint: "0123456789abcdef"})
			}},
		{"/runner/sessions/session-a/cursor-key-check", `{"state":"VALID","keyFingerprint":"0123456789abcdef"}`,
			func(tr *Transport) error {
				return tr.cursorKeyCheck("session-a", CursorKeyCheckReport{State: "VALID", KeyFingerprint: "0123456789abcdef"})
			}},
		{"/runner/sessions/session-a/notify", `{"message":"Background shell job-1 ended (exit code 0): make"}`,
			func(tr *Transport) error {
				return tr.sessionNotify("session-a", "Background shell job-1 ended (exit code 0): make")
			}},
	}
	r := newLinkWorkRig(t)
	r.useLink(t)
	for _, c := range calls {
		if err := c.call(r.t); err != nil {
			t.Fatalf("%s: %v", c.path, err)
		}
		if n := len(r.cp.requests("/api" + c.path)); n != 0 {
			t.Errorf("%s went over HTTPS %d times", c.path, n)
		}
		rpcs := r.g.rpcsTo(c.path)
		if len(rpcs) != 1 {
			t.Errorf("%s went over the link %d times, want 1", c.path, len(rpcs))
			continue
		}
		if rpcs[0].method != http.MethodPost || string(rpcs[0].body) != c.body || rpcs[0].requestID == "" {
			t.Errorf("%s over the link: %s %s %q", c.path, rpcs[0].method, rpcs[0].body, rpcs[0].requestID)
		}
	}
}

func TestEveryOtherCallerSaysWhoItIs(t *testing.T) {
	for _, caller := range []string{runnerCallerMCP, runnerCallerAntigravityHook, runnerCallerCLI} {
		t.Run(caller, func(t *testing.T) {
			cp := newRecordingControlPlane(t)
			tr := newCallerTransport(cp.URL, "runner-token", caller)
			linkDaemonWorkout(t, tr)
			_, _ = tr.fetchAttachment(context.Background(), "session-a", "att-1")
			file := filepath.Join(t.TempDir(), "a.txt")
			if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
				t.Fatal(err)
			}
			_, _ = uploadTestAttachment(tr, "session-a", file, "text/plain")
			requests := cp.requests()
			if len(requests) < 12 {
				t.Fatalf("%d requests", len(requests))
			}
			for _, r := range requests {
				if v := r.Header.Get(runnerCallerHeader); v != caller {
					t.Errorf("%s %s says %s %q, want %q", r.Method, r.URI, runnerCallerHeader, v, caller)
				}
			}
		})
	}
}

// Every transport outside the daemon is made by newCallerTransport naming its caller, so the control plane can tell it
// from the daemon: NewTransport appears only where the daemon builds its own, where no runner credential is held, or
// where a request is no daemon route's.
func TestOnlyTheDaemonBuildsAnUnmarkedTransport(t *testing.T) {
	allowed := map[string]string{
		"runloop.go":    "t := NewTransport(cfg.ServerURL, cfg.RunnerToken)",                            // the daemon's own
		"transport.go":  "t := NewTransport(baseURL, token)",                                            // newCallerTransport
		"main.go":       `t := NewTransport(server, "")`,                                                // registration, no credential
		"selfupdate.go": `err = NewTransport(server, token).do(ctx, http.MethodGet, "/runner/release?"`, // not a daemon route
	}
	callers := map[string]string{
		"mcp.go": "runnerCallerMCP", "antigravity_approval.go": "runnerCallerAntigravityHook",
		"main.go": "runnerCallerCLI", "task_cli.go": "runnerCallerCLI", "session_cli.go": "runnerCallerCLI",
		"doctor.go": "runnerCallerCLI",
	}
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	seenCaller := map[string]bool{}
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		file, err := os.Open(f)
		if err != nil {
			t.Fatal(err)
		}
		scanner := bufio.NewScanner(file)
		scanner.Buffer(make([]byte, 1<<20), 1<<20)
		for n := 1; scanner.Scan(); n++ {
			line := strings.TrimSpace(scanner.Text())
			if strings.HasPrefix(line, "//") {
				continue
			}
			if strings.Contains(line, "NewTransport(") && !strings.HasPrefix(line, "func NewTransport(") {
				if want, ok := allowed[f]; !ok || !strings.Contains(line, want) {
					t.Errorf("%s:%d builds a transport that names no caller: %s", f, n, line)
				}
			}
			if strings.Contains(line, "newCallerTransport(") && !strings.HasPrefix(line, "func newCallerTransport(") {
				if want, ok := callers[f]; !ok || !strings.Contains(line, want) {
					t.Errorf("%s:%d does not name the caller %s: %s", f, n, callers[f], line)
				}
				seenCaller[f] = true
			}
		}
		file.Close()
	}
	for f := range callers {
		if !seenCaller[f] {
			t.Errorf("%s builds no marked transport", f)
		}
	}
}

// linkDaemonRoutes is RunnerApiController's routes that take the runner credential: the list the link gateway forwards
// and the apiserver serves over the link. A daemon route added to the controller fails this until the runner knows
// whether it goes over the link.
func TestLinkDaemonRoutesAreTheControllersGuardedRoutes(t *testing.T) {
	src, err := os.ReadFile("../apiserver/src/runner-api/runner-api.controller.ts")
	if err != nil {
		t.Fatal(err)
	}
	route := regexp.MustCompile(`^@(Get|Post|Put|Patch|Delete)\('([^']*)'\)`)
	param := regexp.MustCompile(`:[A-Za-z]+`)
	var guarded, open []string
	var decorators []string
	for _, raw := range strings.Split(string(src), "\n") {
		line := strings.TrimSpace(raw)
		if !strings.HasPrefix(line, "@") {
			decorators = nil
			continue
		}
		decorators = append(decorators, line)
		m := route.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		r := strings.ToUpper(m[1]) + " /runner/" + param.ReplaceAllString(m[2], ":id")
		if strings.Contains(strings.Join(decorators, " "), "@UseGuards(RunnerAuthGuard)") {
			guarded = append(guarded, r)
		} else {
			open = append(open, r)
		}
	}
	sort.Strings(guarded)
	sort.Strings(open)
	ours := append([]string{}, linkDaemonRoutes...)
	sort.Strings(ours)
	if !reflect.DeepEqual(guarded, ours) {
		t.Errorf("the controller's guarded routes and linkDaemonRoutes differ:\n controller: %v\n runner:     %v", guarded, ours)
	}
	// GET /runner/wake serves nobody: it answers every caller UPGRADE_REQUIRED, for the runners of 0.1.246 that still ask
	// once as they start. This binary never calls it, so it is not in linkDaemonRoutes.
	if want := []string{"GET /runner/wake", "POST /runner/device/poll", "POST /runner/device/start", "POST /runner/register"}; !reflect.DeepEqual(open, want) {
		t.Errorf("the controller's routes without the runner guard are %v, want %v", open, want)
	}
	// 49 counted on 2026-10-25, the daemon's three calls that went beside the agent tool API until 2026-10-28 (a
	// Cursor key check's answer, a session's own key check and a background job's alert), since 2026-10-31 the
	// directory probe's answer (docs/first-workspace-contract.md §2.4), since 2026-11-01 the Claude region check
	// (docs/claude-region-check-contract.md §3), and since 2026-11-02 the upload of a file an agent keeps
	// (docs/orbit-files-design.md §2.3); less /complete, since the cleanup after the cut-over.
	if n := len(guarded) + len(open); n != 54 {
		t.Errorf("the controller has %d routes; 54 since the cleanup after the cut-over", n)
	}
}

func TestLinkDaemonRouteMatchesAsTheControllerRoutes(t *testing.T) {
	cases := map[string]string{
		"GET /runner/sessions/claim":                        "GET /runner/sessions/claim",
		"GET /runner/sessions/abc/inbox?acceptsSteer=1":     "GET /runner/sessions/:id/inbox",
		"POST /runner/sessions/worktrees-removable":         "POST /runner/sessions/worktrees-removable",
		"POST /runner/sessions/abc/turns/t-1/suggestion":    "POST /runner/sessions/:id/turns/:id/suggestion",
		"GET /runner/sessions/abc/approvals/ap-1":           "GET /runner/sessions/:id/approvals/:id",
		"GET /runner/sessions/abc/events?after=3&limit=200": "GET /runner/sessions/:id/events",
		"POST /runner/heartbeat":                            linkRouteHeartbeat,
		"POST /runner/cursor-key-check-result":              "POST /runner/cursor-key-check-result",
		"POST /runner/sessions/abc/cursor-key-check":        "POST /runner/sessions/:id/cursor-key-check",
		"POST /runner/sessions/abc/notify":                  "POST /runner/sessions/:id/notify",
		"POST /runner/notify":                               "",
		"GET /runner/providers":                             "",
		"GET /runner/agents":                                "",
		"POST /runner/tasks/abc/comments":                   "",
		"GET /runner/release?latest=1":                      "",
		"POST /runner/register":                             "",
		"POST /runner/sessions//turn-complete":              "",
	}
	for call, want := range cases {
		method, path, _ := strings.Cut(call, " ")
		got, ok := linkDaemonRoute(method, path)
		if want == "" {
			if ok {
				t.Errorf("%s is matched as the daemon route %s", call, got)
			}
			continue
		}
		if !ok || got != want {
			t.Errorf("%s matches %q (%v), want %q", call, got, ok, want)
		}
	}
}

// A release check installs what the link assigned, from /dl as ever, and asks the control plane nothing; a rollback
// is a rollback, the previous release assigned without one is a rollout holding the runner back, and an assignment /dl
// does not publish is refused.
func TestReleaseCheckInstallsWhatTheLinkAssigns(t *testing.T) {
	t.Cleanup(func() { setLinkAssignedRelease(nil) })
	latest, previous := newRolloutRelease(t, rolloutTestLatest), newRolloutRelease(t, rolloutTestPrevious)
	cp := serveRollout(t, latest, &previous, releaseAssignment{Version: rolloutTestLatest})
	registerWith(t, cp.srv.URL)
	ctx := context.Background()

	setLinkAssignedRelease(&releaseAssignment{Version: rolloutTestPrevious, Rollback: true})
	m, err := publishedManifest(ctx, cp.srv.URL)
	if err != nil || m.Version != rolloutTestPrevious || !m.rollback {
		t.Fatalf("a rollback assigned over the link: %s rollback=%v %v", m.Version, m.rollback, err)
	}
	setLinkAssignedRelease(&releaseAssignment{Version: rolloutTestPrevious})
	if m, err = publishedManifest(ctx, cp.srv.URL); err != nil || m.Version != rolloutTestPrevious || m.rollback {
		t.Fatalf("the previous release assigned over the link: %s rollback=%v %v", m.Version, m.rollback, err)
	}
	if held, ok := heldByRollout(); !ok || held != rolloutTestLatest {
		t.Errorf("held back from %q (%v), want %s", held, ok, rolloutTestLatest)
	}
	setLinkAssignedRelease(&releaseAssignment{Version: rolloutTestLatest})
	if m, err = publishedManifest(ctx, cp.srv.URL); err != nil || m.Version != rolloutTestLatest {
		t.Fatalf("the latest assigned over the link: %s %v", m.Version, err)
	}
	if n := len(cp.seen("/api/runner/release")); n != 0 {
		t.Errorf("the control plane was asked %d times with the link's assignment in hand", n)
	}
	setLinkAssignedRelease(&releaseAssignment{Version: "0.9.999"})
	if _, err := publishedManifest(ctx, cp.srv.URL); err == nil || !strings.Contains(err.Error(), "does not publish") {
		t.Errorf("an assignment /dl does not publish: %v", err)
	}
	setLinkAssignedRelease(nil)
	if _, err := publishedManifest(ctx, cp.srv.URL); err != nil {
		t.Fatal(err)
	}
	if n := len(cp.seen("/api/runner/release")); n != 1 {
		t.Errorf("without the link's assignment the control plane was asked %d times, want 1", n)
	}
}

// doctor's lines on the daemon's work: whether a call goes through the link, or why the link cannot carry it.
func TestDoctorChecksTheLinkMode(t *testing.T) {
	t.Run("MODE_LINK", func(t *testing.T) {
		g := newFakeWorkGateway(t)
		g.welcome = func(c *fakeWorkConn, w *linkpb.Welcome) { w.Release = &linkpb.AssignedRelease{Version: "0.1.999"} }
		cp := newFakeLinkControlPlane(t, g.linkURL())
		p := probeRunnerLink(context.Background(), cp.URL, "runner-token", linkNoProxy, g.roots())
		report := strings.Join(p.report(), "\n")
		t.Log("\n" + report)
		for _, want := range []string{"mode:   MODE_LINK — the runner's daemon calls go over this link",
			"call:   GET /runner/me answered 200 over the link in ", "token:  lives 1h0m0s", "update: the link assigns release 0.1.999"} {
			if !strings.Contains(report, want) {
				t.Errorf("the report does not say %q", want)
			}
		}
		if calls := g.rpcsTo("/runner/me"); len(calls) != 1 || !strings.HasPrefix(calls[0].requestID, "doctor:") {
			t.Errorf("doctor's call over the link: %+v", calls)
		}
	})
	t.Run("a call that gets no answer", func(t *testing.T) {
		g := newFakeWorkGateway(t)
		g.backend = func(c *fakeWorkConn, rpc *linkpb.Rpc) *linkpb.RpcResult {
			return fakeWorkFailure(rpc, "BACKEND_UNAVAILABLE", true, 1000)
		}
		cp := newFakeLinkControlPlane(t, g.linkURL())
		report := strings.Join(probeRunnerLink(context.Background(), cp.URL, "runner-token", linkNoProxy, g.roots()).report(), "\n")
		if !strings.Contains(report, "✗ a daemon call over the link got no answer: GET /runner/me — the gateway answered BACKEND_UNAVAILABLE") {
			t.Errorf("the report:\n%s", report)
		}
	})
	t.Run("MODE_HTTP", func(t *testing.T) {
		g := newFakeLinkGateway(t)
		cp := newFakeLinkControlPlane(t, g.linkURL())
		report := strings.Join(probeRunnerLink(context.Background(), cp.URL, "runner-token", linkNoProxy, g.roots()).report(), "\n")
		if !strings.Contains(report, "✗ mode:   MODE_HTTP — the gateway forwards nothing, and this runner works only over the link") || strings.Contains(report, "call:") {
			t.Errorf("the report:\n%s", report)
		}
	})
	t.Run("not configured", func(t *testing.T) {
		g := newFakeLinkGateway(t)
		cp := newFakeLinkControlPlane(t, g.linkURL())
		cp.tokenStatus = http.StatusNotFound
		report := strings.Join(probeRunnerLink(context.Background(), cp.URL, "runner-token", linkNoProxy, g.roots()).report(), "\n")
		if !strings.Contains(report, "✗ not configured on this server") || !strings.Contains(report, "this runner works only over the link") {
			t.Errorf("the report:\n%s", report)
		}
	})
}

// The link's own fields of an HTTP answer: a TunnelResponse's retry_after_ms as the Retry-After an HTTPS answer
// carries, so callers that read one (wiki_retry.go) read the other.
func TestLinkRetryAfterReadsAsAnHTTPRetryAfter(t *testing.T) {
	for ms, want := range map[uint32]string{0: "", 1: "1", 999: "1", 1000: "1", 1001: "2", 30000: "30"} {
		if got := linkRetryAfterHeader(ms); got != want {
			t.Errorf("%dms reads as Retry-After %q, want %q", ms, got, want)
		}
	}
}
