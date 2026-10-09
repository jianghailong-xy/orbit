package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

const testManagedPodUID = "0b6f5f6e-6f0a-4c5e-9b9e-2a3c4d5e6f70"

// withManagedInstance runs a test as a managed runner's process: the two Downward API variables
// set, and the process-wide cache read afresh before and after.
func withManagedInstance(t *testing.T, generation, podUID string) {
	t.Helper()
	t.Setenv(envManagedRunnerGeneration, generation)
	t.Setenv(envManagedRunnerPodUID, podUID)
	resetManagedInstanceCache(t)
}

// withoutManagedInstance runs a test as a self-managed runner, whatever the host environment says.
func withoutManagedInstance(t *testing.T) {
	t.Helper()
	for _, key := range []string{envManagedRunnerGeneration, envManagedRunnerPodUID} {
		if value, ok := os.LookupEnv(key); ok {
			t.Setenv(key, value) // restored afterwards
			os.Unsetenv(key)
		}
	}
	resetManagedInstanceCache(t)
}

func resetManagedInstanceCache(t *testing.T) {
	t.Helper()
	managedInstanceOnce = sync.Once{}
	managedInstanceCached = nil
	t.Cleanup(func() {
		managedInstanceOnce = sync.Once{}
		managedInstanceCached = nil
		managedInstanceRevokedSeen.Store(false)
	})
}

func TestManagedInstanceIsReadFromTheDownwardAPIVariables(t *testing.T) {
	env := func(pairs map[string]string) func(string) (string, bool) {
		return func(key string) (string, bool) { v, ok := pairs[key]; return v, ok }
	}
	if got, err := managedRunnerInstanceFromEnv(env(nil)); got != nil || err != nil {
		t.Fatalf("a self-managed runner (neither variable) = %+v, %v; want none and no error", got, err)
	}
	got, err := managedRunnerInstanceFromEnv(env(map[string]string{
		envManagedRunnerGeneration: " 3 ",
		envManagedRunnerPodUID:     strings.ToUpper(testManagedPodUID),
	}))
	if err != nil || got == nil || got.Generation != "3" || got.PodUID != testManagedPodUID {
		t.Fatalf("managed instance = %+v, %v; want generation 3 and the lower-cased Pod UID", got, err)
	}
	// Said, but not readably: refused rather than run as though nothing was said.
	for name, pairs := range map[string]map[string]string{
		"generation only":    {envManagedRunnerGeneration: "3"},
		"Pod UID only":       {envManagedRunnerPodUID: testManagedPodUID},
		"generation zero":    {envManagedRunnerGeneration: "0", envManagedRunnerPodUID: testManagedPodUID},
		"generation garbage": {envManagedRunnerGeneration: "3a", envManagedRunnerPodUID: testManagedPodUID},
		"annotation missing": {envManagedRunnerGeneration: "", envManagedRunnerPodUID: testManagedPodUID},
		"Pod UID garbage":    {envManagedRunnerGeneration: "3", envManagedRunnerPodUID: "mr-pod"},
	} {
		if got, err := managedRunnerInstanceFromEnv(env(pairs)); err == nil {
			t.Errorf("%s: got %+v and no error; want a refusal", name, got)
		}
	}
}

// captured is every request a fake control plane saw, by path.
type captured struct {
	mu      sync.Mutex
	headers map[string]http.Header
}

func (c *captured) server(t *testing.T) *httptest.Server {
	t.Helper()
	c.headers = map[string]http.Header{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c.mu.Lock()
		c.headers[r.URL.Path] = r.Header.Clone()
		c.mu.Unlock()
		switch {
		case strings.HasSuffix(r.URL.Path, "/attachments"):
			w.Header().Set("content-type", "application/json")
			_, _ = w.Write([]byte(`{"id":"att-1"}`))
		case strings.Contains(r.URL.Path, "/attachments/"):
			_, _ = w.Write([]byte("png"))
		default:
			// An older control plane: unknown headers and capability tokens are simply not read.
			w.Header().Set("content-type", "application/json")
			_, _ = w.Write([]byte(`{}`))
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func (c *captured) get(path string) http.Header {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.headers[path]
}

func declares(header http.Header, capability string) bool {
	for _, token := range strings.Split(header.Get(runnerCapabilitiesHeader), ",") {
		if strings.TrimSpace(token) == capability {
			return true
		}
	}
	return false
}

// exerciseCredentialedRequests makes one request down each credentialed path of the transport: the
// JSON calls (heartbeat, claim, events, session leases all go through doVia), the attachment
// download and the attachment upload, which build their requests by hand.
func exerciseCredentialedRequests(t *testing.T, srv *httptest.Server) {
	t.Helper()
	tr := NewTransport(srv.URL, "runner-secret")
	if err := tr.do(context.Background(), "POST", "/runner/heartbeat", map[string]string{"status": "ONLINE"}, nil, 5*time.Second); err != nil {
		t.Fatalf("heartbeat: %v", err)
	}
	if err := tr.do(context.Background(), "GET", "/runner/sessions/claim", nil, nil, 5*time.Second); err != nil {
		t.Fatalf("claim: %v", err)
	}
	if err := tr.do(context.Background(), "POST", "/runner/sessions/s-1/events", map[string]any{"events": []any{}}, nil, 5*time.Second); err != nil {
		t.Fatalf("events: %v", err)
	}
	if err := tr.do(context.Background(), "POST", "/runner/sessions/s-1/release-leases", map[string]any{}, nil, 5*time.Second); err != nil {
		t.Fatalf("release leases: %v", err)
	}
	if _, err := tr.fetchAttachment(context.Background(), "s-1", "a-1"); err != nil {
		t.Fatalf("attachment download: %v", err)
	}
	upload := filepath.Join(t.TempDir(), "shot.png")
	if err := os.WriteFile(upload, []byte("png"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := tr.uploadSessionAttachment(context.Background(), "s-1", upload, "image/png"); err != nil {
		t.Fatalf("attachment upload: %v", err)
	}
}

var credentialedPaths = []string{
	"/api/runner/heartbeat",
	"/api/runner/sessions/claim",
	"/api/runner/sessions/s-1/events",
	"/api/runner/sessions/s-1/release-leases",
	"/api/runner/sessions/s-1/attachments/a-1",
	"/api/runner/sessions/s-1/attachments",
}

// A managed runner names its instance on every request it makes with its credential — and, against
// a control plane that predates the protocol, every request still succeeds (new runner, old server).
func TestManagedRunnerSendsItsInstanceWithEveryCredentialedRequest(t *testing.T) {
	withManagedInstance(t, "4", testManagedPodUID)
	var c captured
	exerciseCredentialedRequests(t, c.server(t))
	for _, path := range credentialedPaths {
		h := c.get(path)
		if h == nil {
			t.Fatalf("%s: no request seen", path)
		}
		if h.Get("authorization") != "Bearer runner-secret" {
			t.Errorf("%s: authorization = %q", path, h.Get("authorization"))
		}
		if h.Get(managedRunnerGenerationHeader) != "4" || h.Get(managedRunnerPodUIDHeader) != testManagedPodUID {
			t.Errorf("%s: instance headers = %q / %q, want 4 / %s", path, h.Get(managedRunnerGenerationHeader), h.Get(managedRunnerPodUIDHeader), testManagedPodUID)
		}
		if !declares(h, managedRunnerInstanceCapabilityV1) {
			t.Errorf("%s: capabilities %q do not declare %s", path, h.Get(runnerCapabilitiesHeader), managedRunnerInstanceCapabilityV1)
		}
	}
	// The fixed capability set is still declared beside it, not replaced by it.
	if !declares(c.get("/api/runner/heartbeat"), sessionWorktreeOpsV1) {
		t.Errorf("heartbeat capabilities lost the runner's own set: %q", c.get("/api/runner/heartbeat").Get(runnerCapabilitiesHeader))
	}
}

// A self-managed runner's protocol is unchanged: no instance headers, no new capability token.
func TestSelfManagedRunnerSendsNoInstance(t *testing.T) {
	withoutManagedInstance(t)
	var c captured
	exerciseCredentialedRequests(t, c.server(t))
	for _, path := range credentialedPaths {
		h := c.get(path)
		if h.Get(managedRunnerGenerationHeader) != "" || h.Get(managedRunnerPodUIDHeader) != "" || declares(h, managedRunnerInstanceCapabilityV1) {
			t.Errorf("%s: a self-managed runner sent instance headers: %v", path, h)
		}
	}
	if got := c.get("/api/runner/heartbeat").Get(runnerCapabilitiesHeader); got != runnerCapabilitiesV1 {
		t.Errorf("self-managed capabilities = %q, want exactly the existing set", got)
	}
}

// A request without a credential (device enrollment) names no instance either.
func TestUncredentialedRequestsNameNoInstance(t *testing.T) {
	withManagedInstance(t, "4", testManagedPodUID)
	var c captured
	srv := c.server(t)
	if err := NewTransport(srv.URL, "").do(context.Background(), "POST", "/runner/device/start", map[string]string{"name": "x"}, nil, 5*time.Second); err != nil {
		t.Fatal(err)
	}
	if h := c.get("/api/runner/device/start"); h.Get(managedRunnerGenerationHeader) != "" || h.Get(managedRunnerPodUIDHeader) != "" {
		t.Errorf("an uncredentialed request carried the instance: %v", h)
	}
}

func TestManagedInstanceRevocationIsRecognised(t *testing.T) {
	refusal := func(status int, code string) error {
		return &transportHTTPError{method: "POST", path: "/runner/heartbeat", statusCode: status, body: `{"code":"` + code + `","message":"x","retryable":false}`}
	}
	withManagedInstance(t, "2", testManagedPodUID)
	for _, revoked := range []error{
		refusal(http.StatusForbidden, managedInstanceSuperseded),
		refusal(http.StatusForbidden, managedInstanceFenced),
		refusal(http.StatusForbidden, managedInstanceNotAuthorized),
		refusal(http.StatusForbidden, managedInstanceRequired),
		// The manager replaces the credential when it fences or retires a generation.
		&transportHTTPError{method: "POST", path: "/runner/heartbeat", statusCode: http.StatusUnauthorized, body: `{"message":"invalid runner token"}`},
	} {
		if !isManagedInstanceRevoked(revoked) {
			t.Errorf("%v: not recognised as a revoked instance", revoked)
		}
	}
	for _, kept := range []error{
		// Not yet recorded by the manager: wait and retry.
		refusal(http.StatusServiceUnavailable, "MANAGED_RUNNER_INSTANCE_PENDING"),
		refusal(http.StatusForbidden, "SOMETHING_ELSE"),
		refusal(http.StatusConflict, managedInstanceFenced),
		context.DeadlineExceeded,
	} {
		if isManagedInstanceRevoked(kept) {
			t.Errorf("%v: taken for a revoked instance", kept)
		}
	}
	if isRetryableTransportError(refusal(http.StatusServiceUnavailable, "MANAGED_RUNNER_INSTANCE_PENDING")) == false {
		t.Error("a pending instance must be retried, not given up on")
	}

	// A self-managed runner is never told it was revoked: its 401/403 mean what they always did.
	withoutManagedInstance(t)
	if isManagedInstanceRevoked(refusal(http.StatusForbidden, managedInstanceSuperseded)) ||
		isManagedInstanceRevoked(&transportHTTPError{statusCode: http.StatusUnauthorized}) {
		t.Error("a self-managed runner treated a refusal as an instance revocation")
	}
}

// The run loop stops a revoked instance on either of the two calls it makes all the time: a
// heartbeat refused that way cancels the loop (draining, heartbeats kept, as any stop), and the
// claim path stops on its non-retryable refusal as it always has. `orbit run` exits non-zero then,
// so the Pod ends Failed — and refuses to start on an unreadable identity.
func TestRunLoopStopsARevokedManagedInstance(t *testing.T) {
	src, err := os.ReadFile("runloop.go")
	if err != nil {
		t.Fatal(err)
	}
	body := string(src)
	beat := body[strings.Index(body, `logln("heartbeat failed:", err)`):]
	beat = beat[:strings.Index(beat, "return\n")]
	for _, want := range []string{"isManagedInstanceRevoked(err)", "managedInstanceRevokedSeen.Store(true)", "loopCancel()"} {
		if !strings.Contains(beat, want) {
			t.Errorf("the heartbeat failure path does not %s", want)
		}
	}
	claim := body[strings.Index(body, `logln("claim failed:", err)`):]
	claim = claim[:strings.Index(claim, `logln("claim failure is permanent; stopping runner")`)]
	if !strings.Contains(claim, "isManagedInstanceRevoked(err)") || !strings.Contains(claim, "!isRetryableTransportError(err)") {
		t.Errorf("the claim failure path does not stop a revoked instance:\n%s", claim)
	}

	main, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	run := string(main)
	run = run[strings.Index(run, "func cmdRun() {"):]
	run = run[:strings.Index(run, "\n}\n")]
	check := strings.Index(run, "checkManagedRunnerInstance()")
	loop := strings.Index(run, "runWithSelfUpdates(")
	if check < 0 || loop < 0 || check > loop {
		t.Errorf("cmdRun must check the managed instance before it runs the loop:\n%s", run)
	}
	if !strings.Contains(run[loop:], "managedInstanceRevokedSeen.Load()") || !strings.Contains(run[loop:], "os.Exit(3)") {
		t.Errorf("cmdRun must exit non-zero after a revocation:\n%s", run)
	}
}

// Engines that hand `orbit mcp` an allowlisted environment are given the instance too: its MCP calls
// use the runner credential, which a managed runner's control plane refuses without it.
func TestManagedInstanceReachesOrbitMCPThroughAllowlistedEnvironments(t *testing.T) {
	for _, name := range []string{envManagedRunnerGeneration, envManagedRunnerPodUID} {
		if !strings.Contains(codexOrbitMCPEnvVarsConfig, `"`+name+`"`) {
			t.Errorf("Codex's orbit MCP allowlist does not forward %s", name)
		}
	}
	withManagedInstance(t, "7", testManagedPodUID)
	want := []string{envManagedRunnerGeneration + "=7", envManagedRunnerPodUID + "=" + testManagedPodUID}
	if got := managedInstanceEnv(); strings.Join(got, " ") != strings.Join(want, " ") {
		t.Fatalf("managedInstanceEnv() = %v, want %v", got, want)
	}
	job := &ClaimedSession{SessionID: "0b6f5f6e-6f0a-4c5e-9b9e-2a3c4d5e6f71"}
	dsh := map[string]string{}
	for _, entry := range dshOrbitMCPEnv(job) {
		dsh[entry["name"]] = entry["value"]
	}
	if dsh[envManagedRunnerGeneration] != "7" || dsh[envManagedRunnerPodUID] != testManagedPodUID {
		t.Errorf("DeepSeek Harness's declared orbit MCP env lacks the instance: %v", dsh)
	}
	// Inherited, never stripped: the runner's own children (Claude, Kimi, Antigravity, the CLI an
	// agent runs) get it from the runner's environment.
	for _, name := range []string{envManagedRunnerGeneration, envManagedRunnerPodUID} {
		if sessionContextEnvKey(name) || userCredentialEnvKey(name) {
			t.Errorf("%s is stripped from children's environments", name)
		}
	}
	inherited := map[string]bool{}
	for _, entry := range envWithAgent(nil) {
		inherited[entry] = true
	}
	for _, pair := range want {
		if !inherited[pair] {
			t.Errorf("envWithAgent drops %s", pair)
		}
	}

	withoutManagedInstance(t)
	if got := managedInstanceEnv(); got != nil {
		t.Errorf("a self-managed runner forwards %v", got)
	}
}
