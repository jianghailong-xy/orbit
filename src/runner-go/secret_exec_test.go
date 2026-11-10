//go:build linux || darwin

package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// secretExecFixture is a runner's session socket with a store behind it, found the way the engine's shell finds it:
// from ORBIT_HOME and ORBIT_SESSION_ID alone.
type secretExecFixture struct {
	t         *testing.T
	sessionID string
	api       *fakeSecretAPI
	store     *secretStore
	stop      func()
}

const secretExecSession = "343dlzsYWKo5z8l2M8tsB"

func newSecretExecFixture(t *testing.T, expires time.Time) *secretExecFixture {
	t.Helper()
	// Short: a unix socket path is bounded (bgSocketPathCap).
	home, err := os.MkdirTemp("", "osx")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(home) })
	t.Setenv("ORBIT_HOME", home)
	t.Setenv("ORBIT_SESSION_ID", secretExecSession)
	t.Setenv(envBgSocket, "")
	t.Setenv(envBgToken, "")
	oldRetry, oldGrace := secretExecRetryEvery, secretExecKillGrace
	secretExecRetryEvery, secretExecKillGrace = 50*time.Millisecond, 2*time.Second
	t.Cleanup(func() { secretExecRetryEvery, secretExecKillGrace = oldRetry, oldGrace })

	f := &secretExecFixture{t: t, sessionID: secretExecSession, api: newFakeSecretAPI()}
	grant := envGrant("g1", "CANARY_KEY", decodeSessionID(secretExecSession), "", expires)
	f.api.grants[grant.ID] = grant
	f.store = newSecretStore(f.api, filepath.Join(home, "ledger.json"))
	f.store.reconcile(refs(grant), nil)
	f.serve(f.store)
	return f
}

// serve starts the session's socket service with a fresh token, as a runner (re)starting does.
func (f *secretExecFixture) serve(store *secretStore) {
	f.t.Helper()
	token, err := newBgSessionToken()
	if err != nil {
		f.t.Fatal(err)
	}
	svc := &bgJobService{token: token, sessionID: f.sessionID, secrets: store}
	stop, err := startBgJobService(context.Background(), svc, bgSocketPath(f.sessionID), bgTokenPath(f.sessionID))
	if err != nil {
		f.t.Fatal(err)
	}
	f.stop = stop
	f.t.Cleanup(stop)
}

type secretExecRun struct {
	code           int
	stdout, stderr string
	took           time.Duration
}

func runSecretCLI(args ...string) secretExecRun {
	var stdout, stderr bytes.Buffer
	start := time.Now()
	code := cmdSecret(args, strings.NewReader(""), &stdout, &stderr)
	return secretExecRun{code: code, stdout: stdout.String(), stderr: stderr.String(), took: time.Since(start)}
}

func TestSecretExecGivesTheCommandTheValueAndScrubsItsOutput(t *testing.T) {
	newSecretExecFixture(t, time.Now().Add(time.Hour))
	run := runSecretCLI("exec", "CANARY_KEY", "--", "sh", "-c",
		`printf '%s\n' "$CANARY_KEY"; printf '%s' "$CANARY_KEY" | base64; printf '%s' "$CANARY_KEY" | od -An -tx1 | tr -d ' \n'; echo; echo "len=${#CANARY_KEY}" >&2; exit 3`)
	if run.code != 3 {
		t.Fatalf("exit %d, stderr %q", run.code, run.stderr)
	}
	if strings.Contains(run.stdout+run.stderr, testSecretValue) {
		t.Fatalf("the value reached the output: %q %q", run.stdout, run.stderr)
	}
	if strings.Count(run.stdout, "[redacted]") != 3 {
		t.Fatalf("stdout = %q", run.stdout)
	}
	if !strings.Contains(run.stderr, "len=26") {
		t.Fatalf("the command did not get the value: %q", run.stderr)
	}
	if os.Getenv("CANARY_KEY") != "" {
		t.Fatal("the value reached the CLI's own environment")
	}
}

func TestSecretExecRefusesAGrantOfAnotherSession(t *testing.T) {
	f := newSecretExecFixture(t, time.Now().Add(time.Hour))
	other := envGrant("g2", "OTHER_KEY", "another-session", "", time.Now().Add(time.Hour))
	f.api.grants[other.ID] = other
	f.store.reconcile(refs(f.api.grants["g1"], other), nil)
	run := runSecretCLI("exec", "OTHER_KEY", "--", "true")
	if run.code != 1 || !strings.Contains(run.stderr, "another session or task") {
		t.Fatalf("exit %d, stderr %q", run.code, run.stderr)
	}
	if run := runSecretCLI("exec", "lower", "--", "true"); run.code != 2 {
		t.Fatalf("a malformed NAME: exit %d", run.code)
	}
}

func TestSecretExecStopsTheCommandOnRevocation(t *testing.T) {
	f := newSecretExecFixture(t, time.Now().Add(time.Hour))
	go func() {
		time.Sleep(500 * time.Millisecond)
		f.store.reconcile(refs(), nil)
	}()
	run := runSecretCLI("exec", "CANARY_KEY", "--", "sh", "-c", "sleep 30; echo finished")
	if run.code != 128+15 || strings.Contains(run.stdout, "finished") || run.took > 10*time.Second {
		t.Fatalf("exit %d after %v, stdout %q, stderr %q", run.code, run.took, run.stdout, run.stderr)
	}
	if !strings.Contains(run.stderr, "removed from this runner") {
		t.Fatalf("stderr = %q", run.stderr)
	}
}

// A runner that restarts is asked again on its new socket and token; the command carries on.
func TestSecretExecReconnectsAfterARunnerRestart(t *testing.T) {
	f := newSecretExecFixture(t, time.Now().Add(time.Hour))
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		time.Sleep(300 * time.Millisecond)
		f.stop()
		time.Sleep(400 * time.Millisecond)
		f.serve(f.store)
	}()
	run := runSecretCLI("exec", "CANARY_KEY", "--", "sh", "-c", "sleep 1.5; echo finished")
	wg.Wait()
	if run.code != 0 || !strings.Contains(run.stdout, "finished") {
		t.Fatalf("exit %d, stdout %q, stderr %q", run.code, run.stdout, run.stderr)
	}
}

// Asked again after a restart, a runner that no longer holds the grant stops the command.
func TestSecretExecStopsWhenTheRestartedRunnerRefuses(t *testing.T) {
	f := newSecretExecFixture(t, time.Now().Add(time.Hour))
	go func() {
		time.Sleep(300 * time.Millisecond)
		f.stop()
		empty := newSecretStore(newFakeSecretAPI(), filepath.Join(t.TempDir(), "ledger.json"))
		empty.markReady()
		f.serve(empty)
	}()
	run := runSecretCLI("exec", "CANARY_KEY", "--", "sh", "-c", "sleep 30; echo finished")
	if run.code != 128+15 || run.took > 10*time.Second || !strings.Contains(run.stderr, "holds no secret") {
		t.Fatalf("exit %d after %v, stderr %q", run.code, run.took, run.stderr)
	}
}

// With no runner to answer, the command stops at the grant's expiry.
func TestSecretExecStopsAtExpiryWithNoAnswer(t *testing.T) {
	f := newSecretExecFixture(t, time.Now().Add(1500*time.Millisecond))
	go func() {
		time.Sleep(200 * time.Millisecond)
		f.stop()
	}()
	run := runSecretCLI("exec", "CANARY_KEY", "--", "sh", "-c", "sleep 30; echo finished")
	if run.code != 128+15 || run.took > 8*time.Second || !strings.Contains(run.stderr, "expired") {
		t.Fatalf("exit %d after %v, stderr %q", run.code, run.took, run.stderr)
	}
}

func TestSecretExecSaysWhatToDoWithoutASocket(t *testing.T) {
	home, _ := os.MkdirTemp("", "osx")
	defer os.RemoveAll(home)
	t.Setenv("ORBIT_HOME", home)
	t.Setenv("ORBIT_SESSION_ID", secretExecSession)
	t.Setenv(envBgSocket, "")
	t.Setenv(envBgToken, "fallback")
	run := runSecretCLI("exec", "CANARY_KEY", "--", "true")
	if run.code != 1 || !strings.Contains(run.stderr, "bg_run") {
		t.Fatalf("exit %d, stderr %q", run.code, run.stderr)
	}
	t.Setenv("ORBIT_SESSION_ID", "")
	if run := runSecretCLI("exec", "CANARY_KEY", "--", "true"); run.code != 1 || !strings.Contains(run.stderr, "ORBIT_SESSION_ID") {
		t.Fatalf("exit %d, stderr %q", run.code, run.stderr)
	}
}
