package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
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

// The link mode's switch (D15) and what it decides: which transport each call goes over, and what changes it.

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
	if _, err := tr.claimSession(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := tr.inbox(ctx, "session-a", "gen-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := tr.waitForWake(ctx); err != nil {
		t.Fatal(err)
	}
	batch := linkTestEvents(1, 3, 10)
	for i := range batch.Events {
		batch.Events[i].TS = "2026-10-25T00:00:00.000Z" // the same in every workout, which are compared byte for byte
	}
	if err := tr.postEvents(ctx, "session-a", batch); err != nil {
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
	var agents json.RawMessage
	if err := tr.do(ctx, http.MethodGet, "/runner/agents", nil, &agents, 10*time.Second); err != nil {
		t.Fatal(err)
	}
}

// While the control plane has not asked for the link, a transport with a link mode makes exactly the requests a
// transport without one makes: the same methods, paths, bodies and headers, all over HTTPS, and the gateway hears
// nothing. That is what "the switch is off" means.
func TestTheLinkIsNotUsedUntilTheControlPlaneAsks(t *testing.T) {
	plain, linked := newRecordingControlPlane(t), newRecordingControlPlane(t)
	g := newFakeWorkGateway(t)
	a := NewTransport(plain.URL, "runner-token")
	b := NewTransport(linked.URL, "runner-token")
	b.leaseOwner = a.leaseOwner
	b.link = newLinkMode(b, (&linkTestLog{}).log)
	t.Cleanup(b.link.close)
	linkDaemonWorkout(t, a)
	linkDaemonWorkout(t, b)
	got, want := linked.requests(), plain.requests()
	if len(got) != len(want) || len(want) < 10 {
		t.Fatalf("%d requests with a link mode, %d without", len(got), len(want))
	}
	for i := range want {
		if !reflect.DeepEqual(got[i], want[i]) {
			t.Errorf("request %d differs:\n with a link mode: %+v\n without:          %+v", i, got[i], want[i])
		}
	}
	if conns, rpcs, beats := g.snapshot(); len(conns)+len(rpcs)+len(beats) != 0 {
		t.Errorf("the gateway heard from a runner whose link is not in use: %d connections", len(conns))
	}
	if b.link.inUse() || b.link.work.running() {
		t.Error("the link came into use with nothing asking for it")
	}
}

// An HTTPS daemon call answered UPGRADE_REQUIRED puts the link in use and is made again over it, within its own
// timeout; from then on daemon calls go over the link and nothing else changes way: the agent tool API stays on
// HTTPS.
func TestUpgradeRequiredMovesTheWorkToTheLink(t *testing.T) {
	r := newLinkWorkRig(t)
	r.cp.status = func(path string) int {
		if path == "/api/runner/agents" {
			return 0
		}
		return http.StatusUpgradeRequired
	}
	r.g.backend = func(c *fakeWorkConn, rpc *linkpb.Rpc) *linkpb.RpcResult {
		return fakeWorkAnswer(rpc, 200, `{"id":"runner-1","name":"over-the-link"}`)
	}
	me, err := r.t.me()
	if err != nil {
		t.Fatalf("GET /runner/me after UPGRADE_REQUIRED: %v", err)
	}
	if me.Name != "over-the-link" {
		t.Errorf("answered %+v", me)
	}
	if !r.m.inUse() {
		t.Fatal("the link is not in use after UPGRADE_REQUIRED")
	}
	if err := r.t.postEvents(context.Background(), "session-a", linkTestEvents(1, 2, 10)); err != nil {
		t.Fatal(err)
	}
	if n := len(r.cp.requests("/api/runner/sessions/session-a/events")); n != 0 {
		t.Errorf("%d event batches went over HTTPS after the cutover", n)
	}
	if n := len(r.g.rpcsTo("/runner/sessions/session-a/events")); n != 1 {
		t.Errorf("%d event batches over the link", n)
	}
	var agents json.RawMessage
	if err := r.t.do(context.Background(), http.MethodGet, "/runner/agents", nil, &agents, 10*time.Second); err != nil {
		t.Fatal(err)
	}
	if n := len(r.cp.requests("/api/runner/agents")); n != 1 {
		t.Errorf("the agent tool API went over HTTPS %d times, want 1", n)
	}
	if n := len(r.g.rpcsTo("/runner/agents")); n != 0 {
		t.Errorf("the agent tool API went over the link")
	}
	if !strings.Contains(strings.Join(r.logs.all(), "\n"), "UPGRADE_REQUIRED") {
		t.Errorf("the log does not say why the link came into use: %v", r.logs.all())
	}
}

// A call answered UPGRADE_REQUIRED while the link cannot come up fails as a network failure, which callers retry,
// never as the 426, which they read as permanent.
func TestUpgradeRequiredWithNoLinkYetFailsAsRetryable(t *testing.T) {
	r := newLinkWorkRig(t)
	r.cp.status = func(string) int { return http.StatusUpgradeRequired }
	r.g.refuse = func(*http.Request) (int, string, string) {
		return http.StatusServiceUnavailable, `{"code":"DRAINING"}`, "30"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	_, err := r.t.claimSession(ctx)
	if err == nil {
		t.Fatal("a claim with neither way open succeeded")
	}
	if !isRetryableTransportError(err) {
		t.Errorf("%v is not retryable: the claim loop would stop the runner", err)
	}
}

// The control plane sends the work back to HTTPS by saying MODE_HTTP: in a HeartbeatAck, which hands the beat to
// HTTPS, in a Welcome, which is not adopted, and in a call refused for MODE_HTTP, which goes over HTTPS instead.
func TestTheControlPlaneSendsTheWorkBackToHTTPS(t *testing.T) {
	t.Run("HeartbeatAck", func(t *testing.T) {
		r := newLinkWorkRig(t)
		conn := r.useLink(t)
		r.g.setMode(linkpb.Mode_MODE_HTTP)
		if _, err := r.t.heartbeat(HeartbeatRequest{Status: "ONLINE", LeaseOwner: r.t.leaseOwner}); err != nil {
			t.Fatal(err)
		}
		if n := len(r.cp.requests("/api/runner/heartbeat")); n != 1 {
			t.Errorf("the beat answered MODE_HTTP went over HTTPS %d times", n)
		}
		if r.m.inUse() {
			t.Fatal("still in link mode after MODE_HTTP")
		}
		linkWaitFor(t, 5*time.Second, "the work connection to close", func() bool { return len(r.g.open()) == 0 })
		if _, err := r.t.me(); err != nil {
			t.Fatal(err)
		}
		if n := len(r.cp.requests("/api/runner/me")); n != 1 {
			t.Errorf("GET /runner/me went over HTTPS %d times after MODE_HTTP", n)
		}
		_ = conn
	})
	t.Run("Welcome", func(t *testing.T) {
		r := newLinkWorkRig(t)
		r.g.setMode(linkpb.Mode_MODE_HTTP)
		r.m.observe(linkpb.Mode_MODE_LINK, "the test")
		r.g.waitWelcomed(t, 1)
		linkWaitFor(t, 5*time.Second, "the link to go out of use", func() bool { return !r.m.inUse() })
		if _, err := r.t.me(); err != nil {
			t.Fatal(err)
		}
		if n := len(r.cp.requests("/api/runner/me")); n != 1 {
			t.Errorf("GET /runner/me went over HTTPS %d times", n)
		}
		linkWaitFor(t, 5*time.Second, "the connection welcomed in MODE_HTTP to close", func() bool { return len(r.g.open()) == 0 })
	})
	t.Run("LINK_MODE_HTTP", func(t *testing.T) {
		r := newLinkWorkRig(t)
		r.useLink(t)
		r.g.setMode(linkpb.Mode_MODE_HTTP) // its Rpcs are refused LINK_MODE_HTTP from now on
		if _, err := r.t.me(); err != nil {
			t.Fatal(err)
		}
		if n := len(r.cp.requests("/api/runner/me")); n != 1 {
			t.Errorf("the refused call went over HTTPS %d times", n)
		}
		if r.m.inUse() {
			t.Error("still in link mode after LINK_MODE_HTTP")
		}
	})
}

// ORBIT_LINK_MODE=off, or "linkMode": "off", keeps every call on HTTPS: no link mode at all, and an UPGRADE_REQUIRED
// is the caller's to read.
func TestLinkModeOffKeepsEveryCallOnHTTPS(t *testing.T) {
	t.Setenv(linkShadowEnv, "0")
	t.Setenv(linkModeEnv, "off")
	cp := newRecordingControlPlane(t)
	cp.answer = func(*http.Request) (int, string) { return http.StatusUpgradeRequired, `{"code":"UPGRADE_REQUIRED"}` }
	tr := NewTransport(cp.URL, "runner-token")
	stop := startLink(&RunnerConfig{}, tr)
	defer stop()
	if tr.link != nil {
		t.Fatal("ORBIT_LINK_MODE=off attached a link mode")
	}
	if _, err := tr.me(); !isTransportHTTPStatus(err, http.StatusUpgradeRequired) {
		t.Errorf("GET /runner/me answered %v", err)
	}
	os.Unsetenv(linkModeEnv)
	if off, why := linkModeOff(&RunnerConfig{LinkMode: "off"}); !off || !strings.Contains(why, `"linkMode": "off"`) {
		t.Errorf("the config's linkMode off reads as %v %q", off, why)
	}
	if off, _ := linkModeOff(&RunnerConfig{}); off {
		t.Error("an absent linkMode reads as off")
	}
}

// The shadow gives way: a gateway saying MODE_LINK on the shadow's connection puts the work on the link, the shadow
// closes its connection and sends no mirror on it, and the process holds one connection, the work's. When the work
// goes back to HTTPS, the shadow connects again.
func TestTheShadowGivesWayToTheWorkConnection(t *testing.T) {
	r := newLinkWorkRig(t)
	logs := &linkTestLog{}
	s := newLinkShadow(newLinkTestClient(r.cp, r.t.leaseOwner, r.g.roots(), nil), logs.log)
	s.pingEvery = 200 * time.Millisecond
	s.coord = r.m
	if err := installLinkShadowTap(r.t, s); err != nil {
		t.Fatal(err)
	}
	stop := s.start()
	defer stop()
	shadowConn := r.g.waitWelcomed(t, 1)
	work := r.g.waitWelcomed(t, 2)
	linkWaitFor(t, 5*time.Second, "one connection for the process", func() bool { return len(r.g.open()) == 1 })
	if open := r.g.open(); open[0] != work || !r.m.inUse() {
		t.Fatalf("the open connection is %s, the work's is %s", open[0].id, work.id)
	}
	if !strings.EqualFold(shadowConn.hello.GetProcessId(), work.hello.GetProcessId()) {
		t.Error("the shadow and the work connect as different processes")
	}
	if _, err := r.t.heartbeat(linkTestHeartbeat(r.t.leaseOwner)); err != nil {
		t.Fatal(err)
	}
	_, rpcs, beats := r.g.snapshot()
	for _, b := range beats {
		if b.conn == shadowConn.id {
			t.Errorf("the shadow sent a heartbeat on a connection in MODE_LINK")
		}
	}
	for _, c := range rpcs {
		if strings.HasPrefix(c.requestID, linkShadowPrefix) {
			t.Errorf("the shadow mirrored on a connection in MODE_LINK: %s", c.requestID)
		}
	}
	// Back to HTTPS: the shadow takes the process's connection again.
	r.g.setMode(linkpb.Mode_MODE_HTTP)
	if _, err := r.t.heartbeat(linkTestHeartbeat(r.t.leaseOwner)); err != nil {
		t.Fatal(err)
	}
	again := r.g.waitWelcomed(t, 3)
	if !strings.EqualFold(again.hello.GetProcessId(), r.t.leaseOwner) {
		t.Errorf("connection %s after MODE_HTTP is process %s", again.id, again.hello.GetProcessId())
	}
	linkWaitFor(t, 5*time.Second, "the shadow alone to hold the process's connection", func() bool {
		open := r.g.open()
		return len(open) == 1 && open[0] == again
	})
}

// With the link mode off, a shadow whose gateway says MODE_LINK mirrors nothing there: in MODE_LINK the gateway
// forwards a Heartbeat and stores an EventBatch, and a mirror is neither. Each one is counted as dropped.
func TestTheShadowMirrorsNothingOnAConnectionInModeLink(t *testing.T) {
	g := newFakeWorkGateway(t)
	cp := newFakeLinkControlPlane(t, g.linkURL())
	tr := NewTransport(cp.URL, "runner-token")
	logs := &linkTestLog{}
	s := newLinkShadow(newLinkTestClient(cp, tr.leaseOwner, g.roots(), nil), logs.log)
	if err := installLinkShadowTap(tr, s); err != nil {
		t.Fatal(err)
	}
	stop := s.start()
	defer stop()
	g.waitWelcomed(t, 1)
	if _, err := tr.heartbeat(linkTestHeartbeat(tr.leaseOwner)); err != nil {
		t.Fatal(err)
	}
	if err := tr.postEvents(context.Background(), "session-a", linkTestEvents(1, 2, 10)); err != nil {
		t.Fatal(err)
	}
	linkWaitFor(t, 5*time.Second, "both mirrors to be dropped", func() bool {
		return s.counts[linkMirrorHeartbeat].dropped[linkDropLinkMode].Load() == 1 && s.counts[linkMirrorEvents].dropped[linkDropLinkMode].Load() == 1
	})
	if _, rpcs, beats := g.snapshot(); len(rpcs)+len(beats) != 0 {
		t.Errorf("the gateway in MODE_LINK received %d mirrored Rpcs and %d heartbeats", len(rpcs), len(beats))
	}
	if !strings.Contains(strings.Join(logs.all(), "\n"), "link mode off") {
		t.Errorf("the shadow did not say why it mirrors nothing: %v", logs.all())
	}
}

// The daemon's transport names no caller on any request; every other transport made with the runner credential
// names its caller on every request (runnerCallerHeader).
func TestTheDaemonNeverSaysWhoIsCalling(t *testing.T) {
	t.Setenv(linkShadowEnv, "0")
	cp := newRecordingControlPlane(t)
	daemon := newCallerTransport(cp.URL, "runner-token", runnerCallerCLI)
	stop := startLink(&RunnerConfig{}, daemon) // what runLoop does with its transport
	defer stop()
	linkDaemonWorkout(t, daemon)
	_, _ = daemon.fetchAttachment(context.Background(), "session-a", "att-1")
	for _, r := range cp.requests() {
		if v := r.Header.Get(runnerCallerHeader); v != "" {
			t.Errorf("the daemon's %s %s says %s: %s", r.Method, r.URI, runnerCallerHeader, v)
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
			_, _ = tr.uploadSessionAttachment(context.Background(), "session-a", file, "text/plain")
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

// Every transport outside the daemon is made by newCallerTransport naming its caller, so the cutover can tell it from
// the daemon: NewTransport appears only where the daemon builds its own, where no runner credential is held, or where a
// request is no daemon route's or deliberately asks as the daemon would.
func TestOnlyTheDaemonBuildsAnUnmarkedTransport(t *testing.T) {
	allowed := map[string]string{
		"runloop.go":     "t := NewTransport(cfg.ServerURL, cfg.RunnerToken)",                            // the daemon's own
		"transport.go":   "t := NewTransport(baseURL, token)",                                            // newCallerTransport
		"main.go":        `t := NewTransport(server, "")`,                                                // registration, no credential
		"selfupdate.go":  `err = NewTransport(server, token).do(ctx, http.MethodGet, "/runner/release?"`, // not a daemon route
		"link_doctor.go": "_, err := NewTransport(serverURL, runnerToken).me()",                          // asks as the daemon would
	}
	callers := map[string]string{
		"mcp.go": "runnerCallerMCP", "antigravity_approval.go": "runnerCallerAntigravityHook",
		"main.go": "runnerCallerCLI", "task_cli.go": "runnerCallerCLI", "session_cli.go": "runnerCallerCLI",
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
	if want := []string{"POST /runner/device/poll", "POST /runner/device/start", "POST /runner/register"}; !reflect.DeepEqual(open, want) {
		t.Errorf("the controller's routes without the runner guard are %v, want %v", open, want)
	}
	if n := len(guarded) + len(open); n != 49 {
		t.Errorf("the controller has %d routes; 49 were counted on 2026-10-25", n)
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

// doctor's link mode lines: which way the daemon calls go, and, on the link, whether one goes through it.
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
	t.Run("cutover", func(t *testing.T) {
		g := newFakeWorkGateway(t)
		cp := newFakeLinkControlPlane(t, g.linkURL())
		cp.status = func(path string) int {
			if path == "/api/runner/me" {
				return http.StatusUpgradeRequired
			}
			return 0
		}
		p := probeRunnerLink(context.Background(), cp.URL, "runner-token", linkNoProxy, g.roots())
		p.localOff = linkModeEnv + "=off"
		report := strings.Join(p.report(), "\n")
		t.Log("\n" + report)
		for _, want := range []string{"HTTPS:  the control plane answers daemon calls over HTTPS with UPGRADE_REQUIRED",
			"✗ link mode is off on this machine (ORBIT_LINK_MODE=off), but the control plane asks for the link"} {
			if !strings.Contains(report, want) {
				t.Errorf("the report does not say %q", want)
			}
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
		if !strings.Contains(report, "mode:   MODE_HTTP — the runner's daemon calls go over HTTPS") || strings.Contains(report, "call:") {
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
	if !linkUpgradeRequired(&transportHTTPError{statusCode: 426}) ||
		!linkUpgradeRequired(&transportHTTPError{statusCode: 400, body: `{"code":"UPGRADE_REQUIRED"}`}) ||
		linkUpgradeRequired(&transportHTTPError{statusCode: 409, body: `{"code":"CONFLICT"}`}) ||
		linkUpgradeRequired(fmt.Errorf("network")) {
		t.Error("UPGRADE_REQUIRED is read wrong")
	}
}
