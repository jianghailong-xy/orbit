package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// THE NAME ONE task_start CARRIES, over real HTTP.
//
// `POST /runner/tasks/:id/execute` keys this request's receipt on the `triggerId` in its body
// (src/apiserver/src/tasks/task-run-identity.ts), which is what makes a delivery the server has
// already answered one run rather than a second. The server cannot decide that for itself — a
// retry and a fresh call are the same bytes — so the runner has to carry it, and carry it from the
// INVOCATION rather than from the HTTP attempt. These tests are about that distinction, and none
// of them is decidable from the type system: what is asserted is the bytes on the wire.

// startTaskRecorder answers every POST once with a 307 to the same route, so a single invocation
// reaches the handler TWICE with a body http.Client replayed on its own. That is the resend
// nothing above the transport can see or re-name — the one that would start a second run if the
// token were drawn per attempt.
func startTaskRecorder(t *testing.T, redirectFirst bool) (*httptest.Server, *[]map[string]interface{}) {
	t.Helper()
	var bodies []map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		body := map[string]interface{}{}
		if len(raw) > 0 {
			if err := json.Unmarshal(raw, &body); err != nil {
				t.Errorf("body is not JSON: %v (%q)", err, raw)
			}
		} else {
			body = nil
		}
		bodies = append(bodies, body)
		if redirectFirst && len(bodies) == 1 {
			http.Redirect(w, r, r.URL.Path, http.StatusTemporaryRedirect)
			return
		}
		_, _ = w.Write([]byte(`{"ok":true,"sessionId":"s1"}`))
	}))
	t.Cleanup(srv.Close)
	return srv, &bodies
}

// requestToken pulls the one field under test out of a recorded body, failing loudly on anything
// the server would refuse: a missing token is no idempotency at all, and one that is not Base62
// is a 400 from `@IsPublicId` rather than a run.
func requestToken(t *testing.T, body map[string]interface{}) string {
	t.Helper()
	token, _ := body["triggerId"].(string)
	if token == "" {
		t.Fatalf("no triggerId on the wire: %#v", body)
	}
	if decoded := decodeSessionID(token); !uuidRE.MatchString(decoded) {
		t.Fatalf("triggerId %q is not a Base62 public id (decoded %q)", token, decoded)
	}
	if strings.ContainsAny(token, "-_ ") {
		t.Fatalf("triggerId %q is not Base62", token)
	}
	return token
}

func TestMCPTaskStartNamesTheInvocationAndReusesItAcrossARedirect(t *testing.T) {
	srv, bodies := startTaskRecorder(t, true)

	mcp := &mcpServer{taskID: "t1", t: NewTransport(srv.URL, "tok")}
	if res := mcp.callTool("task_start", map[string]interface{}{}); res["isError"] == true {
		t.Fatalf("task_start returned an error: %#v", res["content"])
	}

	if len(*bodies) != 2 {
		t.Fatalf("expected the redirect to replay the POST, got %d request(s)", len(*bodies))
	}
	first, second := requestToken(t, (*bodies)[0]), requestToken(t, (*bodies)[1])
	if first != second {
		// A token drawn inside `do` would differ here, and the two deliveries of ONE tool call
		// would be two differently-named requests — which is two runs.
		t.Fatalf("one invocation sent two names: %q then %q", first, second)
	}
}

func TestMCPTaskStartDrawsANewNameForTheNextInvocation(t *testing.T) {
	// The other half, and the one that must keep working: two deliberate tool calls are two runs.
	srv, bodies := startTaskRecorder(t, false)

	mcp := &mcpServer{taskID: "t1", t: NewTransport(srv.URL, "tok")}
	mcp.callTool("task_start", map[string]interface{}{})
	mcp.callTool("task_start", map[string]interface{}{})

	if len(*bodies) != 2 {
		t.Fatalf("expected 2 requests, got %d", len(*bodies))
	}
	if first, second := requestToken(t, (*bodies)[0]), requestToken(t, (*bodies)[1]); first == second {
		t.Fatalf("two invocations shared one name: %q", first)
	}
}

func TestTaskCLIStartNamesTheInvocationAndReusesItAcrossARedirect(t *testing.T) {
	srv, bodies := startTaskRecorder(t, true)
	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	if err := cmdTaskCLI([]string{"start", "task-1", "--json"}, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}

	if len(*bodies) != 2 {
		t.Fatalf("expected the redirect to replay the POST, got %d request(s)", len(*bodies))
	}
	if first, second := requestToken(t, (*bodies)[0]), requestToken(t, (*bodies)[1]); first != second {
		t.Fatalf("one `orbit task start` sent two names: %q then %q", first, second)
	}
}

func TestTaskCLIStartDrawsANewNameForTheNextInvocation(t *testing.T) {
	srv, bodies := startTaskRecorder(t, false)
	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	for range 2 {
		if err := cmdTaskCLI([]string{"start", "task-1", "--json"}, strings.NewReader(""), &out); err != nil {
			t.Fatal(err)
		}
	}

	if len(*bodies) != 2 {
		t.Fatalf("expected 2 requests, got %d", len(*bodies))
	}
	if first, second := requestToken(t, (*bodies)[0]), requestToken(t, (*bodies)[1]); first == second {
		t.Fatalf("two invocations shared one name: %q", first)
	}
}

func TestStartTaskRefusesToStartAnUnnamedRun(t *testing.T) {
	// FAIL CLOSED, and at the transport rather than only at the two call sites. The server still
	// accepts the bodiless POST every deployed runner sends — that compatibility is pinned on the
	// server side (runner-tasks.controller.spec.ts, task-run-trigger-wire.spec.ts) — but a binary
	// that CAN name its request must never silently send one that cannot be retried.
	srv, bodies := startTaskRecorder(t, false)

	_, err := NewTransport(srv.URL, "tok").startTask("t1", "")

	if err == nil {
		t.Fatalf("an unnamed start was allowed out")
	}
	if !strings.Contains(err.Error(), "unnamed") {
		t.Fatalf("refusal does not say what is wrong: %v", err)
	}
	if len(*bodies) != 0 {
		t.Fatalf("expected nothing on the wire, got %#v", *bodies)
	}
}

// failingEntropy is the machine having no CSPRNG left — the only condition under which a run
// request cannot be named.
type failingEntropy struct{}

func (failingEntropy) Read([]byte) (int, error) { return 0, errors.New("entropy pool exhausted") }

func withFailingEntropy(t *testing.T) {
	t.Helper()
	previous := runRequestEntropy
	runRequestEntropy = failingEntropy{}
	t.Cleanup(func() { runRequestEntropy = previous })
}

func TestNewRunRequestTokenFailsClosedWithoutEntropy(t *testing.T) {
	withFailingEntropy(t)

	token, err := newRunRequestToken()

	if err == nil {
		t.Fatalf("a name was drawn from a broken CSPRNG: %q", token)
	}
	if token != "" {
		t.Fatalf("a failed draw still produced %q", token)
	}
}

func TestMCPTaskStartRefusesRatherThanStartingUnnamedWithoutEntropy(t *testing.T) {
	// Not "degrade to the legacy wire". The runner would be starting a run it cannot ask about
	// again, at the moment something is already wrong with the machine, and telling nobody.
	srv, bodies := startTaskRecorder(t, false)
	withFailingEntropy(t)

	res := (&mcpServer{taskID: "t1", t: NewTransport(srv.URL, "tok")}).
		callTool("task_start", map[string]interface{}{})

	if res["isError"] != true {
		t.Fatalf("task_start did not report the failure: %#v", res)
	}
	if len(*bodies) != 0 {
		t.Fatalf("expected nothing on the wire, got %#v", *bodies)
	}
}

func TestTaskCLIStartRefusesRatherThanStartingUnnamedWithoutEntropy(t *testing.T) {
	srv, bodies := startTaskRecorder(t, false)
	configureCLITestRunner(t, srv.URL)
	withFailingEntropy(t)

	var out bytes.Buffer
	err := cmdTaskCLI([]string{"start", "task-1", "--json"}, strings.NewReader(""), &out)

	if err == nil {
		t.Fatalf("`orbit task start` reported success without naming its request")
	}
	if len(*bodies) != 0 {
		t.Fatalf("expected nothing on the wire, got %#v", *bodies)
	}
}

func TestNewRunRequestTokenIsAFreshBase62PublicIDEveryTime(t *testing.T) {
	seen := map[string]bool{}
	for range 256 {
		token, err := newRunRequestToken()
		if err != nil {
			t.Fatal(err)
		}
		if decoded := decodeSessionID(token); !uuidRE.MatchString(decoded) {
			t.Fatalf("token %q is not a Base62 public id (decoded %q)", token, decoded)
		}
		if seen[token] {
			t.Fatalf("token %q was drawn twice", token)
		}
		seen[token] = true
	}
}

// hijackRecorder answers the FIRST POST by killing the connection after reading its body — the
// server has the request, the client never gets an answer — and the second normally. That is the
// exact shape the resend exists for: a run may well have been committed, and a caller that gives up
// here starts a second one under a new name the next time somebody presses the button.
func hijackRecorder(t *testing.T, dropFirst int) (*httptest.Server, *[]map[string]interface{}) {
	t.Helper()
	var bodies []map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		body := map[string]interface{}{}
		if len(raw) > 0 {
			_ = json.Unmarshal(raw, &body)
		} else {
			body = nil
		}
		bodies = append(bodies, body)
		if len(bodies) <= dropFirst {
			conn, _, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Errorf("hijack: %v", err)
				return
			}
			_ = conn.Close() // the answer is lost; the request was not
			return
		}
		_, _ = w.Write([]byte(`{"ok":true,"sessionId":"s1"}`))
	}))
	t.Cleanup(srv.Close)
	return srv, &bodies
}

func TestStartTaskResendsTheSameNameWhenTheAnswerIsLost(t *testing.T) {
	srv, bodies := hijackRecorder(t, 1)

	raw, err := NewTransport(srv.URL, "tok").startTask("t1", "341DOGTVEs0Fk0gAn1mje")

	if err != nil {
		t.Fatalf("a lost answer was not resent: %v", err)
	}
	if len(*bodies) != 2 {
		t.Fatalf("expected one resend, got %d request(s)", len(*bodies))
	}
	// Byte-identical, and identical to what the caller asked for: the resend is the SAME request,
	// which is the only reason the server may answer it from the first delivery's receipt.
	for i, body := range *bodies {
		if got := requestToken(t, body); got != "341DOGTVEs0Fk0gAn1mje" {
			t.Fatalf("attempt %d carried %q", i, got)
		}
	}
	if !strings.Contains(string(raw), "s1") {
		t.Fatalf("the resend's answer did not reach the caller: %s", raw)
	}
}

func TestStartTaskResendIsBounded(t *testing.T) {
	// Bounded, and it fails when the bound is spent. An unbounded resend would grind against an
	// outage and hold the tool call open for as long as it lasted.
	srv, bodies := hijackRecorder(t, runRequestResendAttempts+5)

	_, err := NewTransport(srv.URL, "tok").startTask("t1", "341DOGTVEs0Fk0gAn1mje")

	if err == nil {
		t.Fatalf("a request that never got an answer reported success")
	}
	if len(*bodies) != runRequestResendAttempts {
		t.Fatalf("sent %d attempts, want exactly %d", len(*bodies), runRequestResendAttempts)
	}
}

// inProgressThenAnswer says "being answered right now" to the first `n` deliveries and hands back
// the original answer after that — the control plane's own behaviour while the first delivery still
// holds the lease.
func inProgressThenAnswer(t *testing.T, refusals int) (*httptest.Server, *[]map[string]interface{}) {
	t.Helper()
	var bodies []map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		body := map[string]interface{}{}
		_ = json.Unmarshal(raw, &body)
		bodies = append(bodies, body)
		if len(bodies) <= refusals {
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"statusCode":409,"code":"TASK_RUN_REQUEST_IN_PROGRESS",` +
				`"message":"this run request is being answered right now"}`))
			return
		}
		_, _ = w.Write([]byte(`{"ok":true,"sessionId":"s1"}`))
	}))
	t.Cleanup(srv.Close)
	return srv, &bodies
}

func TestStartTaskReadsTheAnswerBackThroughInProgress(t *testing.T) {
	// The response-loss window in full. The first delivery is still committing when the resend
	// arrives, so the resend is told "ask again with the same triggerId". Stopping there would
	// fail the invocation while its run starts, and the next `orbit task start` — a NEW name —
	// would start a second one.
	srv, bodies := inProgressThenAnswer(t, 2)

	raw, err := NewTransport(srv.URL, "tok").startTask("t1", "341DOGTVEs0Fk0gAn1mje")

	if err != nil {
		t.Fatalf("the answer was never read back: %v", err)
	}
	if len(*bodies) != 3 {
		t.Fatalf("expected 3 deliveries, got %d", len(*bodies))
	}
	for i, body := range *bodies {
		if got := requestToken(t, body); got != "341DOGTVEs0Fk0gAn1mje" {
			t.Fatalf("delivery %d carried %q — the readback must be the SAME request", i, got)
		}
	}
	if !strings.Contains(string(raw), "s1") {
		t.Fatalf("the original answer did not reach the caller: %s", raw)
	}
}

func TestStartTaskSurfacesTheRealInProgressOnceTheAttemptsAreSpent(t *testing.T) {
	// The real last answer, not a summary of it.
	srv, bodies := inProgressThenAnswer(t, runRequestResendAttempts+5)

	_, err := NewTransport(srv.URL, "tok").startTask("t1", "341DOGTVEs0Fk0gAn1mje")

	if err == nil {
		t.Fatalf("an unread answer was reported as success")
	}
	if !strings.Contains(err.Error(), taskRunRequestInProgress) {
		t.Fatalf("the control plane's own refusal did not reach the caller: %v", err)
	}
	if len(*bodies) != runRequestResendAttempts {
		t.Fatalf("sent %d deliveries, want exactly %d", len(*bodies), runRequestResendAttempts)
	}
}

func TestTheTwoConflictsAreToldApartByCodeNotByStatus(t *testing.T) {
	// `TASK_RUN_REQUEST_MISMATCH` is the same status from the same door and means the opposite:
	// this id already names a different request, and asking again can only repeat it. Retrying on
	// the 409 alone would loop on it until the bound ran out.
	inProgress := &transportHTTPError{statusCode: http.StatusConflict,
		body: `{"code":"TASK_RUN_REQUEST_IN_PROGRESS"}`}
	mismatch := &transportHTTPError{statusCode: http.StatusConflict,
		body: `{"code":"TASK_RUN_REQUEST_MISMATCH"}`}
	bare := &transportHTTPError{statusCode: http.StatusConflict, body: `something not JSON`}
	elsewhere := &transportHTTPError{statusCode: http.StatusInternalServerError,
		body: `{"code":"TASK_RUN_REQUEST_IN_PROGRESS"}`}

	if inProgress.code() != taskRunRequestInProgress || !isResendableRunFailure(inProgress) {
		t.Fatalf("IN_PROGRESS was not recognised: %q", inProgress.code())
	}
	for _, err := range []*transportHTTPError{mismatch, bare, elsewhere} {
		if isResendableRunFailure(err) {
			t.Fatalf("%v was resent", err)
		}
	}
	if !isResendableRunFailure(errors.New("connection reset")) {
		t.Fatalf("a lost answer was not resendable")
	}
}

func TestStartTaskDoesNotResendAnAnswer(t *testing.T) {
	// A 409 TASK_RUN_REQUEST_MISMATCH, a 400, a 403 — the server ANSWERED, and an answer is the
	// result. Resending it would turn one structured refusal into three and change nothing.
	var attempts int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"code":"TASK_RUN_REQUEST_MISMATCH"}`))
	}))
	defer srv.Close()

	_, err := NewTransport(srv.URL, "tok").startTask("t1", "341DOGTVEs0Fk0gAn1mje")

	if err == nil {
		t.Fatalf("a 409 was reported as success")
	}
	if attempts != 1 {
		t.Fatalf("a structured refusal was resent %d times", attempts)
	}
	if !strings.Contains(err.Error(), "TASK_RUN_REQUEST_MISMATCH") {
		t.Fatalf("the refusal did not reach the caller whole: %v", err)
	}
}

func TestUnnamedAndEntropylessStartsAreNeverResentBecauseTheyAreNeverSent(t *testing.T) {
	// The two fail-closed paths do not interact with the resend at all: nothing goes out, so there
	// is nothing to resend. Pinned because a resend loop wrapped around the wrong guard would turn
	// one refusal into three attempts at an unnamed run.
	srv, bodies := hijackRecorder(t, 99)
	withFailingEntropy(t)

	if _, err := NewTransport(srv.URL, "tok").startTask("t1", ""); err == nil {
		t.Fatalf("an unnamed start was allowed out")
	}
	token, err := newRunRequestToken()
	if err == nil {
		t.Fatalf("a name was drawn from a broken CSPRNG: %q", token)
	}
	if len(*bodies) != 0 {
		t.Fatalf("expected nothing on the wire, got %#v", *bodies)
	}
}
