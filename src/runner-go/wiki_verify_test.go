package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// `orbit wiki verify` against a fake Orbit runner door (contract `agentSurface.verify`,
// `reviewModes.verification.servedBy`): the door lists what the calling session proposed — as the server
// that verifies itself lists it, with nothing but how many of its ops wait, or as an older server listed it,
// op by op for the session to verify — and records every ask of the request route.

// fakeVerifyDoor is the runner door's verification routes: the list, and the request.
type fakeVerifyDoor struct {
	URL      string
	mu       sync.Mutex
	items    []map[string]interface{}
	listMode string
	// The server's own verification: servedBy and waiting as the gated list answers them, requests as the
	// request route records them, and what waiting becomes once that route was asked (0: the worker verified
	// them by the time it answered). An empty servedBy is a server that predates it: its list is the ops.
	servedBy         string
	waiting          int
	waitAfterRequest int
	requests         []string
	// Every other request: none should come.
	others []string
}

func newFakeVerifyDoor(t *testing.T, items []map[string]interface{}) *fakeVerifyDoor {
	t.Helper()
	door := &fakeVerifyDoor{items: items, listMode: "automatic"}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		door.mu.Lock()
		defer door.mu.Unlock()
		w.Header().Set("content-type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/runner/wiki/spaces/space-1/verifications":
			// Where this deployment verifies on the server, the list is empty and says so, with the number
			// of the session's ops that wait (contract `reviewModes.verification.servedBy`).
			page := map[string]interface{}{"spaceId": "space-1", "mode": door.listMode, "items": door.items, "next": nil}
			if door.servedBy != "" {
				page["items"], page["servedBy"], page["waiting"] = []map[string]interface{}{}, door.servedBy, door.waiting
			}
			out, _ := json.Marshal(page)
			_, _ = w.Write(out)
		case r.Method == http.MethodPost && r.URL.Path == "/api/runner/wiki/spaces/space-1/verifications/request":
			door.requests = append(door.requests, r.URL.Path)
			// What the worker's verdict does to the real list: by the time the ask is answered the ops are
			// the worker's to verify, so what this door reports waiting next is the test's waitAfterRequest.
			door.waiting = door.waitAfterRequest
			out, _ := json.Marshal(map[string]interface{}{"spaceId": "space-1", "servedBy": "server", "jobId": "job-1"})
			_, _ = w.Write(out)
		default:
			door.others = append(door.others, r.Method+" "+r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"message":"Cannot ` + r.Method + `"}`))
		}
	}))
	t.Cleanup(srv.Close)
	door.URL = srv.URL
	return door
}

// Requests is every ask the request route recorded, in order (contract
// `reviewModes.verification.routes.request`).
func (d *fakeVerifyDoor) Requests() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string{}, d.requests...)
}

// Others is every request to a route the command has no business calling.
func (d *fakeVerifyDoor) Others() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string{}, d.others...)
}

// verifyItem is one op as an older server listed it for the session to verify, citing one record.
func verifyItem(opID, title string) map[string]interface{} {
	return map[string]interface{}{
		"opId": opID, "changesetId": "cs-1", "op": "add", "entryId": nil,
		"entry": map[string]interface{}{
			"kind": "pitfall", "title": title, "summary": "What " + strings.ToLower(title) + " means.",
			"fields": map[string]interface{}{"symptom": "It went wrong.", "fix": "Do the other thing."}, "topics": []string{}, "aliases": []string{},
		},
		"sources": []map[string]interface{}{{
			"kind": "tool_call", "ref": "tc-" + opID, "quote": "it went wrong",
			"text": "The build said: it went wrong, and " + title + " was the reason.", "truncated": false,
		}},
		"similar": []map[string]interface{}{},
	}
}

func fourOps() []map[string]interface{} {
	return []map[string]interface{}{
		verifyItem("op-1", "Supported claim"),
		verifyItem("op-2", "Partial claim"),
		verifyItem("op-3", "Unsupported claim"),
		verifyItem("op-4", "Duplicate claim"),
	}
}

// wikiVerifySession points the CLI at the door, from inside the session that proposed the ops. Nothing of
// a model is set: the command needs none.
func wikiVerifySession(t *testing.T, door *fakeVerifyDoor) {
	t.Helper()
	home := t.TempDir()
	if err := os.Chmod(home, 0o700); err != nil {
		t.Fatal(err)
	}
	config := `{"serverUrl":` + strconv.Quote(door.URL) + `,"runnerId":"r1","runnerToken":"runner-token","name":"test"}`
	if err := os.WriteFile(filepath.Join(home, "config.json"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ORBIT_HOME", home)
	t.Setenv("ORBIT_SESSION_ID", "caller-session")
	t.Setenv(envWiki, "on")
	for _, name := range []string{"ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL", "ANTHROPIC_API_KEY"} {
		t.Setenv(name, "")
	}
}

// withVerifyWait shortens how long a run waits for the server's verdicts, and how often it looks.
func withVerifyWait(t *testing.T, wait, poll time.Duration) {
	t.Helper()
	previousWait, previousPoll := wikiVerifyServerWaitFor, wikiVerifyServerPollFor
	wikiVerifyServerWaitFor, wikiVerifyServerPollFor = wait, poll
	t.Cleanup(func() { wikiVerifyServerWaitFor, wikiVerifyServerPollFor = previousWait, previousPoll })
}

// ── The copy ────────────────────────────────────────────────────────────────────────────────────

// The precondition, word for word, before the mechanics — the wiki_propose rule, for the one wiki
// verb a model could be tempted to do by hand.
func TestWikiVerifyDescriptionIsAPrecondition(t *testing.T) {
	verify := wikiSurface(t)["verify"].(map[string]interface{})
	if verify["precondition"] != wikiVerifyPrecondition {
		t.Fatalf("the precondition this binary ships is not the contract's:\n here: %q\n there: %q", wikiVerifyPrecondition, verify["precondition"])
	}
	if verify["cli"] != "orbit wiki verify" {
		t.Errorf("the contract names %v as the command", verify["cli"])
	}
	var spec cliCapabilitySpec
	for _, candidate := range wikiCLICapabilities {
		if candidate.Tool == "wiki_verify" {
			spec = candidate
		}
	}
	if spec.Tool == "" || !reflect.DeepEqual(spec.Argv, []string{"orbit", "wiki", "verify"}) || !spec.SessionOnly || !spec.Mutates {
		t.Fatalf("the capability is %#v", spec)
	}
	if !strings.HasPrefix(spec.Description, wikiVerifyPrecondition) {
		t.Errorf("the capability's description does not lead with the precondition: %q", spec.Description)
	}
	// No tool stands beside it, so its schema is its own: exactly the flags its parser takes.
	properties, _ := spec.InputSchema["properties"].(map[string]interface{})
	names := []string{}
	for name := range properties {
		names = append(names, name)
		if !writtenFlagIsParsed("verify", name) {
			t.Errorf("the schema names --%s, which `orbit wiki verify` does not take", name)
		}
	}
	sort.Strings(names)
	if !reflect.DeepEqual(names, []string{"space"}) || !reflect.DeepEqual(spec.InputSchema["required"], []string{"space"}) {
		t.Errorf("the schema = %#v", spec.InputSchema)
	}
	help := wikiActionHelp["verify"]
	for _, sentence := range strings.Split(wikiVerifyPrecondition, ": ") {
		if !strings.Contains(spec.Description, sentence) || !strings.Contains(help, sentence) {
			t.Errorf("the description or the help does not carry %q", sentence)
		}
	}
	if mechanics := strings.Index(help, "It asks the Orbit server"); mechanics < 0 || strings.Index(help, wikiVerifyPrecondition) > mechanics {
		t.Error("the help states the mechanics before the precondition")
	}
	for _, phrase := range []string{
		"never write a verdict yourself",
		"a verdict that cannot be read is reported as nothing",
		"asks the Orbit server to verify the ops this session proposed",
		"supported, partial, unsupported or duplicate",
		"No model of this session's is asked",
		"exits non-zero when the wait runs out with any op still without a verdict",
	} {
		if !strings.Contains(spec.Description, phrase) {
			t.Errorf("the description does not say %q", phrase)
		}
	}
	if wikiToolNames["wiki_verify"] {
		t.Error("verify is a command's wait, and no MCP tool")
	}
}

// ── The server's own verification ───────────────────────────────────────────────────────────────

// Where this deployment verifies on the server (contract `reviewModes.verification.servedBy`), the command
// asks for a verification and waits for the worker's verdict, and what it prints says who verified.
func TestWikiVerifyWaitsForTheServersOwnVerification(t *testing.T) {
	door := newFakeVerifyDoor(t, fourOps())
	door.mu.Lock()
	door.servedBy, door.waiting = "server", 4
	door.mu.Unlock()
	wikiVerifySession(t, door)
	withVerifyWait(t, 30*time.Second, time.Millisecond)

	var out strings.Builder
	if err := cmdWikiCLI([]string{"verify", "--space", "space-1"}, strings.NewReader(""), &out); err != nil {
		t.Fatalf("orbit wiki verify where the server verifies: %v\n%s", err, out.String())
	}
	if got := door.Requests(); len(got) != 1 {
		t.Errorf("the door was asked to verify %v, want exactly one ask", got)
	}
	if got := door.Others(); len(got) != 0 {
		t.Errorf("the command called %v besides the list and the request", got)
	}
	for _, phrase := range []string{
		"The server verifies the ops this session proposed in space space-1: waiting for 4 ops to be verified (no model is asked here).",
		"The server verified 4 ops in space space-1.",
		"Verified 4 of 4 by the server's own worker in space space-1. No model of this session's was asked.",
	} {
		if !strings.Contains(out.String(), phrase) {
			t.Errorf("the run does not say %q:\n%s", phrase, out.String())
		}
	}

	// The same run, as JSON: the summary says who verified, so a caller reads it rather than the prose.
	door.mu.Lock()
	door.waiting = 2
	door.mu.Unlock()
	var jsonOut strings.Builder
	if err := cmdWikiCLI([]string{"verify", "--space", "space-1", "--json"}, strings.NewReader(""), &jsonOut); err != nil {
		t.Fatalf("orbit wiki verify --json where the server verifies: %v\n%s", err, jsonOut.String())
	}
	var summary wikiVerifySummary
	if err := json.Unmarshal([]byte(jsonOut.String()), &summary); err != nil {
		t.Fatalf("--json printed something that is not the summary: %v (%q)", err, jsonOut.String())
	}
	if summary.ServedBy != "server" || summary.Looked != 2 || summary.Verified != 2 || summary.Failed != 0 || summary.Mode != "automatic" {
		t.Errorf("summary = %+v, want the server's own verification of both ops", summary)
	}
}

// An op the server has not verified by the time the wait runs out is reported as one left without a verdict
// — the session asked, waited, and says so — and the command exits non-zero so the next run tries again.
func TestWikiVerifyReportsOpsTheServerHasNotVerifiedYet(t *testing.T) {
	door := newFakeVerifyDoor(t, fourOps())
	door.mu.Lock()
	door.servedBy, door.waiting, door.waitAfterRequest = "server", 3, 3
	door.mu.Unlock()
	wikiVerifySession(t, door)
	withVerifyWait(t, 20*time.Millisecond, time.Millisecond)

	var out strings.Builder
	err := cmdWikiCLI([]string{"verify", "--space", "space-1"}, strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "3 ops were left without a verdict") {
		t.Fatalf("a wait that ran out = %v, want the command to fail naming them", err)
	}
	if !strings.Contains(err.Error(), "the server is still verifying them") {
		t.Errorf("the failure does not say what it waited for: %v", err)
	}
	if !strings.Contains(out.String(), "Verified 0 of 3 by the server's own worker in space space-1; 3 still waiting for its verdict.") {
		t.Errorf("the run says nothing about what is still waiting:\n%s", out.String())
	}
}

// A server whose list does not say it verifies itself is one from before the server's own verification: this
// build has no verifier of its own to fall back to, so it says the server is too old, and asks nothing more —
// no request, no verdict, and the ops the old server listed stay as they are.
func TestWikiVerifyRefusesAServerThatDoesNotVerifyItself(t *testing.T) {
	door := newFakeVerifyDoor(t, fourOps())
	wikiVerifySession(t, door)
	withVerifyWait(t, 30*time.Second, time.Millisecond)

	var out strings.Builder
	err := cmdWikiCLI([]string{"verify", "--space", "space-1"}, strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "this Orbit server does not verify what this session proposed in space space-1 itself") ||
		!strings.Contains(err.Error(), "too old") || !strings.Contains(err.Error(), "Upgrade the Orbit server") {
		t.Fatalf("a server that leaves the verifying to the session = %v, want the refusal that says it is too old", err)
	}
	if got := door.Requests(); len(got) != 0 {
		t.Errorf("the command asked a server that does not verify to verify: %v", got)
	}
	if got := door.Others(); len(got) != 0 {
		t.Errorf("the command called %v of a server it refused", got)
	}
	if out.Len() != 0 {
		t.Errorf("a refused run printed a summary:\n%s", out.String())
	}
	// Its flags are the space and --json alone: the model, its effort and a cap on the ops were the local
	// verifier's, and are gone with it.
	for _, gone := range []string{"--model", "--effort", "--max"} {
		if err := cmdWikiCLI([]string{"verify", "--space", "space-1", gone, "x"}, strings.NewReader(""), &out); err == nil ||
			!strings.Contains(err.Error(), "flag provided but not defined") {
			t.Errorf("orbit wiki verify %s = %v, want the flag refused", gone, err)
		}
	}
}

// What the session is told after proposing where the server verifies: the verdict arrives by itself, there
// is nothing for it to run, and no model of its provider is asked. The wording for a server that does not
// say it verifies — one older than this command, which `orbit wiki verify` then refuses — is unchanged.
func TestWikiProposeSaysTheServerVerifies(t *testing.T) {
	ops := []map[string]interface{}{{"seq": float64(0), "status": "pending", "waitsFor": "verification", "opId": "op-1"}}
	names := []string{"A pitfall"}
	server := describeWikiPropose(wikiProposeAnswer{ChangesetID: "cs-1", Ops: ops, ServedBy: "server"}, names, false)
	for _, phrase := range []string{
		"the deployment's own worker verifies what waits for its verification",
		"the verdict arrives by itself",
		"nothing for this session to run, and no model of this session's is asked",
	} {
		if !strings.Contains(server, phrase) {
			t.Errorf("the server-mode answer does not say %q:\n%s", phrase, server)
		}
	}
	if strings.Contains(server, "orbit wiki verify") {
		t.Errorf("the server-mode answer still asks the session to run the command:\n%s", server)
	}
	if line := describeWikiOp(ops[0], names, true); line != "op 0 A pitfall: pending — the deployment's own worker verifies it, not live yet" {
		t.Errorf("the op line where the server verifies reads %q", line)
	}
	// Where the server does not say it verifies, word for word as it was: the command, and the op line naming it.
	plain := describeWikiPropose(wikiProposeAnswer{ChangesetID: "cs-1", Ops: ops}, names, false)
	if !strings.Contains(plain, "goes live only when `orbit wiki verify` reports a verdict for it") {
		t.Errorf("the answer where the server does not verify changed:\n%s", plain)
	}
	if line := describeWikiOp(ops[0], names, false); line != "op 0 A pitfall: pending — waiting for its verification (orbit wiki verify), not live yet" {
		t.Errorf("the op line where the server does not verify reads %q", line)
	}
}
