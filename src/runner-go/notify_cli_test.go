package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestNotifyPostsTheMessageAndCarriesTheSession(t *testing.T) {
	var method, path, session, body string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method, path = r.Method, r.URL.Path
		session = r.Header.Get("X-Orbit-Session-Id")
		b, _ := io.ReadAll(r.Body)
		body = string(b)
		_, _ = w.Write([]byte(`{"delivered":true,"devices":2}`))
	}))
	defer srv.Close()

	configureCLITestRunner(t, srv.URL)
	// Orchestration off: reaching your own owner is not an orchestration power, so this must
	// work in the state a plain single-session agent is actually in.
	t.Setenv(envMCPOrchestration, "")
	t.Setenv("ORBIT_SESSION_ID", "sess-1")

	var out bytes.Buffer
	if err := cmdNotifyCLI([]string{"--message", "Need the staging DB password to continue", "--json"}, &out); err != nil {
		t.Fatalf("notify: %v", err)
	}
	if method != http.MethodPost || path != "/api/runner/notify" {
		t.Fatalf("notify hit %s %s", method, path)
	}
	// The session is what titles the alert and routes a tap back into this run.
	if session != "sess-1" {
		t.Fatalf("notify session header = %q", session)
	}
	var sent struct{ Message string }
	if err := json.Unmarshal([]byte(body), &sent); err != nil {
		t.Fatalf("notify body is not JSON: %v (%s)", err, body)
	}
	if sent.Message != "Need the staging DB password to continue" {
		t.Fatalf("notify body = %q", body)
	}
	if out.String() != "{\"delivered\":true,\"devices\":2}\n" {
		t.Fatalf("notify output = %q", out.String())
	}
}

func TestNotifyHeadlessSendsNoSessionHeader(t *testing.T) {
	sawSessionHeader := true
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, sawSessionHeader = r.Header["X-Orbit-Session-Id"]
		_, _ = w.Write([]byte(`{"delivered":true,"devices":1}`))
	}))
	defer srv.Close()

	configureCLITestRunner(t, srv.URL)
	// A cron job has no session. The runner's own name titles the alert instead — but only if the
	// header is absent rather than empty, which the server would try to look up as a session.
	t.Setenv("ORBIT_SESSION_ID", "")

	var out bytes.Buffer
	if err := cmdNotifyCLI([]string{"--message", "Nightly backup finished"}, &out); err != nil {
		t.Fatalf("notify: %v", err)
	}
	if sawSessionHeader {
		t.Fatal("headless notify sent a session header")
	}
}

// Nothing was delivered, but the call worked — the agent has to read that out of the result rather
// than out of an error, or a "nobody has a device registered" reads as a bug to work around.
func TestNotifyReportsUndeliveredWithoutFailing(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"delivered":false,"reason":"no devices are registered for this account"}`))
	}))
	defer srv.Close()

	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_SESSION_ID", "sess-1")

	var out bytes.Buffer
	if err := cmdNotifyCLI([]string{"--message", "done"}, &out); err != nil {
		t.Fatalf("undelivered notify reported an error: %v", err)
	}
	if !strings.Contains(out.String(), "no devices are registered") {
		t.Fatalf("notify output = %q", out.String())
	}
}

func TestNotifyRequiresAMessage(t *testing.T) {
	configureCLITestRunner(t, "http://127.0.0.1:1")
	var out bytes.Buffer
	// Caught before the round-trip: an empty alert is not something to ask a server about.
	if err := cmdNotifyCLI([]string{"--json"}, &out); err == nil {
		t.Fatal("notify without --message was accepted")
	}
}

func TestNotifyHelpNamesTheLimitAndTheUndeliveredCase(t *testing.T) {
	var out bytes.Buffer
	if err := cmdNotifyCLI([]string{"--help"}, &out); err != nil {
		t.Fatalf("notify --help: %v", err)
	}
	for _, want := range []string{"one per session per minute", "delivered"} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("notify --help does not mention %q: %s", want, out.String())
		}
	}
}

// The tool is ungated: an agent with no orchestration grant is exactly the one with no other way
// to reach a human, so it must be in the list a plain session sees.
func TestNotifyToolIsExposedWithoutOrchestration(t *testing.T) {
	var found map[string]interface{}
	for _, d := range toolDescriptors(false, false) {
		if name, _ := d["name"].(string); name == "notify" {
			found = d
		}
	}
	if found == nil {
		t.Fatal("notify is missing from the ungated tool list")
	}
	schema, _ := found["inputSchema"].(map[string]interface{})
	required, _ := schema["required"].([]string)
	if len(required) != 1 || required[0] != "message" {
		t.Fatalf("notify requires %#v", schema["required"])
	}
}
