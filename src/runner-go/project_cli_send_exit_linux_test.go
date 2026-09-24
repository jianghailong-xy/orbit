package main

import (
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
