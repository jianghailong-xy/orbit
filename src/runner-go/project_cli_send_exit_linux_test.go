package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"
)

// The environment turns the entry point below into the real CLI rather than a test that passes.
const projectSendChildEnv = "ORBIT_TEST_PROJECT_SEND_CHILD"

// And, when set, the --client-turn-id that CLI is run with.
const projectSendChildKeyEnv = "ORBIT_TEST_PROJECT_SEND_CHILD_KEY"

// TestProjectSendChildRunsMain is the child half of the test below rather than a test of its own:
// re-executed, it runs the real CLI so the real exit status can be observed.
func TestProjectSendChildRunsMain(t *testing.T) {
	if os.Getenv(projectSendChildEnv) != "1" {
		// The assertion lives in TestProjectSendRefusalExitsNonZero, which re-executes this entry
		// point. A normal suite pass has no child payload to run.
		return
	}
	os.Args = []string{"orbit", "project", "send", "343dlzsYWKo5z8l2M8tsA",
		"--message", "the shard is red", "--json"}
	if key := os.Getenv(projectSendChildKeyEnv); key != "" {
		os.Args = append(os.Args, "--client-turn-id", key)
	}
	main()
}

// What a shell actually sees when the delivery is refused with the one code that asks for a PERSON:
// a non-zero exit and the requiredAction on the error line. The unit test next door proves the
// command returns the refusal; this proves the process a script branches on does not come back 0 —
// which is the whole difference between "hand this to the owner" and a caller that reads success
// and moves on believing its message was delivered.
func TestProjectSendRefusalExitsNonZero(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"statusCode":409,"error":"Conflict","code":"COORDINATOR_UNAVAILABLE",` +
			`"message":"its coordination workspace is disabled — its coordinator cannot be opened anywhere else",` +
			`"owner":"USER","requiredAction":"` + ensureCoordinatorRequiredAction + `"}`))
	}))
	defer srv.Close()

	configureCLITestRunner(t, srv.URL)

	cmd := exec.Command(reachableTestBinary(t), "-test.run=^TestProjectSendChildRunsMain$")
	cmd.Env = projectSendChildEnvVars(os.Getenv("ORBIT_HOME"))
	out, err := cmd.CombinedOutput()

	var exit *exec.ExitError
	if !errors.As(err, &exit) {
		t.Fatalf("a refused project send must exit non-zero, got %v:\n%s", err, out)
	}
	if exit.ExitCode() == 0 {
		t.Errorf("exit code %d, want non-zero:\n%s", exit.ExitCode(), out)
	}
	if !strings.Contains(string(out), ensureCoordinatorRequiredAction) {
		t.Errorf("the CLI must print the action the refusal names, got:\n%s", out)
	}
}

// A key under the reserved `watch:` prefix is the server's to refuse, not this command's: the route
// judges it with the same rule every door that takes a turn key applies, so the CLI sends the key as
// it was given and a shell sees the refusal itself — a non-zero exit with the server's sentence —
// rather than a local copy of the rule that could drift from it.
func TestProjectSendReservedKeyIsRefusedByTheServer(t *testing.T) {
	// The sentence and the 400 as the route raises them (watch-turn-key.ts).
	const reserved = `clientTurnId must not start with \"watch:\" — that prefix is reserved for the Watch ` +
		`wakes the server queues itself (docs/watch-contract.md §6). Choose your own key, such as a UUID.`
	var sent interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		sent = body["clientTurnId"]
		if key, _ := sent.(string); strings.HasPrefix(key, "watch:") {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"message":"` + reserved + `","error":"Bad Request","statusCode":400}`))
			return
		}
		_, _ = w.Write([]byte(projectSendDeliveredJSON))
	}))
	defer srv.Close()

	configureCLITestRunner(t, srv.URL)

	cmd := exec.Command(reachableTestBinary(t), "-test.run=^TestProjectSendChildRunsMain$")
	cmd.Env = append(projectSendChildEnvVars(os.Getenv("ORBIT_HOME")), projectSendChildKeyEnv+"=watch:w-1:1")
	out, err := cmd.CombinedOutput()

	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() == 0 {
		t.Fatalf("a refused key must exit non-zero, got %v:\n%s", err, out)
	}
	if sent != "watch:w-1:1" {
		t.Errorf("the key did not reach the server as given: %#v\n%s", sent, out)
	}
	if !strings.Contains(string(out), "that prefix is reserved for the Watch wakes the server queues itself") {
		t.Errorf("the CLI must print the server's refusal, got:\n%s", out)
	}
}

// projectSendChildEnvVars is the child's whole environment: the fake server's home and the one
// session context this door needs. Everything else ORBIT_ is dropped rather than inherited — a
// child that picked up the machine's own runner credential, session or service token could reach a
// real control plane, which is exactly what the environment prefix on a local `go test` avoids.
func projectSendChildEnvVars(home string) []string {
	env := []string{}
	for _, kv := range os.Environ() {
		if strings.HasPrefix(kv, "ORBIT_") {
			continue
		}
		env = append(env, kv)
	}
	return append(env,
		"ORBIT_HOME="+home,
		"ORBIT_SESSION_ID=343dlzsYWKo5z8l2M8tsB",
		envOrchestrationToken+"=session-token",
		envMCPOrchestration+"=1",
		projectSendChildEnv+"=1",
	)
}
