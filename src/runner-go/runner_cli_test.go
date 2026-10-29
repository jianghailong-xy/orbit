package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"
)

// What GET /api/runner/runners answers: the runner's id is the one --runner-id takes.
const runnerListBody = `[{"id":"349tsNoHC7biW3WXF1ddp","publicId":"349tsNoHC7biW3WXF1ddp","name":"instance-20261027-071926","displayName":null,"online":true,"status":"ONLINE","version":"0.9.1","lastHeartbeatAt":"2026-10-27T07:40:00.000Z","maxConcurrent":16,"os":"linux","engines":[{"engine":"claude","auth":"yes"}],"workspaceCount":0}]`

func TestRunnerCLIListsTheAccountsRunners(t *testing.T) {
	var method, path string
	requests := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		method, path = r.Method, r.URL.Path
		if id := r.Header.Get("X-Orbit-Session-Id"); id != "caller-session" {
			t.Errorf("X-Orbit-Session-Id = %q", id)
		}
		if token := r.Header.Get("X-Orbit-Session-Token"); token != "session-token" {
			t.Errorf("X-Orbit-Session-Token = %q", token)
		}
		_, _ = w.Write([]byte(runnerListBody))
	}))
	defer srv.Close()

	configureCLITestRunner(t, srv.URL)
	t.Setenv(envMCPOrchestration, "true")
	t.Setenv("ORBIT_SESSION_ID", "caller-session")
	t.Setenv(envOrchestrationToken, "session-token")

	var out bytes.Buffer
	if err := cmdRunnerCLI([]string{"list", "--json"}, &out); err != nil {
		t.Fatalf("runner list --json: %v", err)
	}
	if method != http.MethodGet || path != "/api/runner/runners" {
		t.Fatalf("runner list hit %s %s", method, path)
	}
	if out.String() != runnerListBody+"\n" {
		t.Fatalf("runner list --json output = %q", out.String())
	}

	// Without --json, the same answer for a person to read: every field, indented.
	out.Reset()
	if err := cmdRunnerCLI([]string{"list"}, &out); err != nil {
		t.Fatalf("runner list: %v", err)
	}
	for _, want := range []string{`"id": "349tsNoHC7biW3WXF1ddp"`, `"name": "instance-20261027-071926"`, `"online": true`, "\n  {\n"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("runner list output does not contain %q: %s", want, out.String())
		}
	}
	if requests != 2 {
		t.Fatalf("requests = %d, want 2", requests)
	}
}

// The runner list is an orchestration verb, as the agent verbs whose --runner-id it answers for are:
// no service-token scope names it, and outside a session there is no calling agent to authorize it.
func TestRunnerCLIRequiresALiveOrchestrationSession(t *testing.T) {
	requests := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		_, _ = w.Write([]byte(`[]`))
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)

	for _, tc := range []struct {
		name      string
		env       map[string]string
		wantError string
	}{
		{
			name:      "headless",
			env:       map[string]string{"ORBIT_SESSION_ID": "", envMCPOrchestration: "true", envOrchestrationToken: ""},
			wantError: "requires ORBIT_SESSION_ID context",
		},
		{
			name:      "orchestration disabled",
			env:       map[string]string{"ORBIT_SESSION_ID": "caller-session", envMCPOrchestration: "", envOrchestrationToken: ""},
			wantError: orchestrationOffMsg,
		},
		{
			name: "service token",
			env: map[string]string{
				"ORBIT_SESSION_ID": "", envMCPOrchestration: "true", envOrchestrationToken: "",
				envServiceToken: fakeServiceToken(t, []string{"session:create", "session:get", "session:list"}, "agent-1", time.Hour),
			},
			wantError: "no service token can grant it",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for key, value := range tc.env {
				t.Setenv(key, value)
			}
			for _, args := range [][]string{
				{"list"},
				{"install", "--runner-id", "runner-2", "--engine", "claude"},
				{"install-status", "--runner-id", "runner-2"},
				{"delete", "--runner-id", "runner-2"},
			} {
				var out bytes.Buffer
				err := cmdRunnerCLI(args, &out)
				if err == nil || !strings.Contains(err.Error(), tc.wantError) {
					t.Fatalf("runner %s error = %v, want containing %q", args[0], err, tc.wantError)
				}
			}
		})
	}
	if requests != 0 {
		t.Fatalf("a refused runner command still made %d requests", requests)
	}
}

func TestRunnerCLIValidatesArguments(t *testing.T) {
	requests := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		_, _ = w.Write([]byte(`[]`))
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)
	t.Setenv(envMCPOrchestration, "true")
	t.Setenv("ORBIT_SESSION_ID", "caller-session")
	t.Setenv(envOrchestrationToken, "session-token")

	for _, tc := range []struct {
		name      string
		args      []string
		wantError string
	}{
		{name: "unknown command", args: []string{"remove"}, wantError: "unknown command"},
		{name: "trailing argument", args: []string{"list", "runner-2"}, wantError: "unexpected arguments: runner-2"},
		{name: "unknown flag", args: []string{"list", "--all"}, wantError: "flag provided but not defined: -all"},
		{name: "delete without a runner", args: []string{"delete"}, wantError: "--runner-id is required"},
		{name: "delete of an id that is not one", args: []string{"delete", "--runner-id", "../sessions"}, wantError: "runner "},
		{name: "delete with a stray argument", args: []string{"delete", "--runner-id", "runner-2", "now"}, wantError: "unexpected arguments: now"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var out bytes.Buffer
			err := cmdRunnerCLI(tc.args, &out)
			if err == nil || !strings.Contains(err.Error(), tc.wantError) {
				t.Fatalf("error = %v, want containing %q", err, tc.wantError)
			}
		})
	}
	if requests != 0 {
		t.Fatalf("a rejected runner command still made %d requests", requests)
	}
}

func TestRunnerListHelpNamesWhatTheIDIsFor(t *testing.T) {
	var out bytes.Buffer
	if err := cmdRunnerCLI([]string{"list", "--help"}, &out); err != nil {
		t.Fatalf("runner list --help: %v", err)
	}
	for _, want := range []string{"orbit runner list [--json]", "--runner-id", "orbit agent create", "orbit agent update", "online"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("runner list --help does not mention %q: %q", want, out.String())
		}
	}
	if !ownsLeafHelp("runner") {
		t.Fatal("main does not route orbit runner list --help to the leaf command")
	}
	if help := helpFor("runner"); help != runnerHelp {
		t.Fatalf("orbit help runner = %q", help)
	}
	if !strings.Contains(usage, "orbit runner <command>") {
		t.Fatal("orbit's usage does not list the runner command")
	}
	// The agent verbs that take a runner id point at the list that has them.
	for _, action := range []string{"create", "update"} {
		if !strings.Contains(agentActionHelp[action], "'orbit runner list' shows the ids") {
			t.Errorf("orbit agent %s --help does not point --runner-id at orbit runner list", action)
		}
	}
}

// The capability document is what an agent reads to discover the CLI: the runner verbs are there under
// the orchestration gate the agent verbs ride — the list and the status read-only, the install marked as
// the write it is — each described and shaped as its MCP tool is, and never outside that gate.
func TestRunnerCLICapabilitiesFollowTheOrchestrationGate(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	t.Setenv(envOrchestrationToken, "session-token")
	t.Setenv(envServiceToken, "")

	t.Setenv("ORBIT_SESSION_ID", "caller-session")
	t.Setenv(envMCPOrchestration, "true")
	on := buildCLICapabilities("/opt/orbit")
	verbs := []struct {
		tool, action, usage string
		mutates             bool
	}{
		{tool: "runner_list", action: "list", usage: "orbit runner list [--json]"},
		{tool: "runner_engine_install", action: "install", usage: "orbit runner install --runner-id ID --engine ENGINE [--update] [--wait] [--json]", mutates: true},
		{tool: "runner_engine_install_status", action: "install-status", usage: "orbit runner install-status --runner-id ID [--json]"},
		{tool: "runner_delete", action: "delete", usage: "orbit runner delete --runner-id ID [--json]", mutates: true},
	}
	for _, verb := range verbs {
		var descriptor map[string]interface{}
		for _, d := range toolDescriptors(false, true) {
			if d["name"] == verb.tool {
				descriptor = d
			}
		}
		if descriptor == nil {
			t.Fatalf("no %s MCP tool with orchestration enabled", verb.tool)
		}
		capability := sessionCLICapabilityByID(on.Capabilities, verb.tool)
		if capability == nil {
			t.Fatalf("%s missing from orbit capabilities with orchestration enabled", verb.tool)
		}
		if !reflect.DeepEqual(capability.Argv, []string{"/opt/orbit", "runner", verb.action}) {
			t.Errorf("%s argv = %#v", verb.tool, capability.Argv)
		}
		if capability.Usage != verb.usage {
			t.Errorf("%s usage = %q", verb.tool, capability.Usage)
		}
		if capability.Description != descriptor["description"] {
			t.Errorf("%s description diverged from the MCP descriptor", verb.tool)
		}
		if !reflect.DeepEqual(capability.MCPInputSchema, descriptor["inputSchema"]) {
			t.Errorf("%s schema diverged from the MCP descriptor", verb.tool)
		}
		if capability.Mutates != verb.mutates {
			t.Errorf("%s mutates = %v, want %v", verb.tool, capability.Mutates, verb.mutates)
		}
		if !capability.Available {
			t.Errorf("%s unavailable in an orchestrating session: %q", verb.tool, capability.UnavailableReason)
		}
	}

	// Orchestration off, and headless with a service token: not in either document.
	t.Setenv(envMCPOrchestration, "")
	off := buildCLICapabilities("/opt/orbit")
	t.Setenv("ORBIT_SESSION_ID", "")
	t.Setenv(envServiceToken, fakeServiceToken(t, []string{"session:create", "session:get"}, "agent-1", time.Hour))
	headless := buildCLICapabilities("/opt/orbit")
	for _, verb := range verbs {
		for _, doc := range []cliCapabilitiesDocument{off, headless} {
			if sessionCLICapabilityByID(doc.Capabilities, verb.tool) != nil {
				t.Fatalf("%s advertised without an orchestration-enabled session", verb.tool)
			}
		}

		// And pre-approved exactly where it is advertised.
		rule := "Bash(/opt/orbit runner " + verb.action + " *)"
		if !contains(orbitCLIAllowedTools("/opt/orbit", true), rule) {
			t.Errorf("an orchestrating session is not pre-approved %s", rule)
		}
		if contains(orbitCLIAllowedTools("/opt/orbit", false), rule) {
			t.Errorf("a session without the grant is pre-approved %s", rule)
		}
	}
}

// The runner the install tests aim at, as 'orbit runner list' spells its id.
const installRunnerID = "349tsNoHC7biW3WXF1ddp"

const (
	relayPending       = `{"status":"pending","engine":"claude","command":null,"message":null,"mode":"install"}`
	relayInstalling    = `{"status":"installing","engine":"claude","command":"curl -fsSL https://claude.ai/install.sh | bash","message":null,"mode":"install"}`
	relayFailed        = `{"status":"failed","engine":"claude","command":"curl -fsSL https://claude.ai/install.sh | bash","message":"exit status 1: curl: (6) Could not resolve host: claude.ai\nTry instead: npm i -g @anthropic-ai/claude-code","mode":"install"}`
	relayDone          = `{"status":"done","engine":"claude","command":"curl -fsSL https://claude.ai/install.sh | bash","message":null,"mode":"install"}`
	relayIdle          = `{"status":null,"engine":null,"command":null,"message":null,"mode":null}`
	relayUpdatePending = `{"status":"pending","engine":null,"command":null,"message":null,"mode":"update"}`
	relayUpdateDone    = `{"status":"done","engine":null,"command":"orbit engine-update","message":"Claude Code — up to date (2.1.0)","mode":"update"}`
)

// engineRelayServer is the runner door as `orbit runner install` reaches it: the POST answers `asked`, each
// GET of the relay answers the next of `polls` (the last one again once they run out), and the runner list
// answers `runners`. It records every request, the POST's body, and the session headers each carried.
type engineRelayServer struct {
	asked, runners string
	polls          []string
	requests       []string
	body           map[string]interface{}
	sessions       []string
}

func (f *engineRelayServer) start(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.requests = append(f.requests, r.Method+" "+r.URL.Path)
		f.sessions = append(f.sessions, r.Header.Get("X-Orbit-Session-Id")+"/"+r.Header.Get("X-Orbit-Session-Token"))
		switch {
		case r.URL.Path == "/api/runner/runners" && r.Method == http.MethodGet:
			_, _ = w.Write([]byte(f.runners))
		case r.URL.Path == "/api/runner/runners/"+installRunnerID+"/engine-install" && r.Method == http.MethodPost:
			if err := json.NewDecoder(r.Body).Decode(&f.body); err != nil {
				t.Errorf("POST body: %v", err)
			}
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(f.asked))
		case r.URL.Path == "/api/runner/runners/"+installRunnerID+"/engine-install" && r.Method == http.MethodGet:
			answer := f.polls[0]
			if len(f.polls) > 1 {
				f.polls = f.polls[1:]
			}
			_, _ = w.Write([]byte(answer))
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
			http.Error(w, "unexpected", http.StatusTeapot)
		}
	}))
	t.Cleanup(srv.Close)
	configureCLITestRunner(t, srv.URL)
	t.Setenv(envMCPOrchestration, "true")
	t.Setenv("ORBIT_SESSION_ID", "caller-session")
	t.Setenv(envOrchestrationToken, "session-token")
	return srv
}

// quickEngineRelayWait makes --wait poll at once, and give up after `limit`.
func quickEngineRelayWait(t *testing.T, limit time.Duration) {
	t.Helper()
	interval, max := engineInstallWaitInterval, engineInstallWaitLimit
	engineInstallWaitInterval, engineInstallWaitLimit = time.Millisecond, limit
	t.Cleanup(func() { engineInstallWaitInterval, engineInstallWaitLimit = interval, max })
}

// `orbit runner install` asks the runner door for the engine and the mode — nothing that could be a command —
// as the calling session, and prints the relay it answers; install-status reads the same relay back.
func TestRunnerCLIInstallAsksTheRunnerDoorForAnEngineAndAMode(t *testing.T) {
	for _, tc := range []struct {
		name string
		args []string
		mode string
	}{
		{name: "install", args: []string{"install", "--runner-id", installRunnerID, "--engine", "claude", "--json"}, mode: "install"},
		{name: "update", args: []string{"install", "--runner-id", installRunnerID, "--engine", "claude", "--update", "--json"}, mode: "update"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := &engineRelayServer{asked: relayPending}
			f.start(t)
			var out bytes.Buffer
			if err := cmdRunnerCLI(tc.args, &out); err != nil {
				t.Fatalf("runner %s: %v", strings.Join(tc.args, " "), err)
			}
			if !reflect.DeepEqual(f.requests, []string{"POST /api/runner/runners/" + installRunnerID + "/engine-install"}) {
				t.Fatalf("requests = %v", f.requests)
			}
			if want := map[string]interface{}{"engine": "claude", "mode": tc.mode}; !reflect.DeepEqual(f.body, want) {
				t.Fatalf("body = %#v, want %#v", f.body, want)
			}
			if f.sessions[0] != "caller-session/session-token" {
				t.Fatalf("sent as %q, want the calling session and its credential", f.sessions[0])
			}
			if out.String() != relayPending+"\n" {
				t.Fatalf("output = %q", out.String())
			}
		})
	}

	f := &engineRelayServer{polls: []string{relayInstalling}}
	f.start(t)
	var out bytes.Buffer
	if err := cmdRunnerCLI([]string{"install-status", "--runner-id", installRunnerID}, &out); err != nil {
		t.Fatalf("runner install-status: %v", err)
	}
	if !reflect.DeepEqual(f.requests, []string{"GET /api/runner/runners/" + installRunnerID + "/engine-install"}) {
		t.Fatalf("requests = %v", f.requests)
	}
	for _, want := range []string{`"status": "installing"`, `"command": "curl -fsSL https://claude.ai/install.sh | bash"`, "\n  \""} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("install-status output does not contain %q: %s", want, out.String())
		}
	}
}

// --wait polls the relay until the runner has reported an outcome and prints what it reported: the command
// it ran and what came of it, with a failure exiting non-zero.
func TestRunnerCLIInstallWaitPrintsWhatTheRunnerReported(t *testing.T) {
	for _, tc := range []struct {
		name      string
		args      []string
		asked     string
		polls     []string
		runners   string
		want      string
		wantError string
		requests  int
	}{
		{name: "done", asked: relayPending, polls: []string{relayPending, relayInstalling, relayDone}, want: relayDone, requests: 4},
		{name: "failed", asked: relayPending, polls: []string{relayInstalling, relayFailed}, want: relayFailed, wantError: "the runner reports the install failed", requests: 3},
		{
			// The usual end: the heartbeat that reports the engine installed retires the finished install before a
			// poll sees "done", and the runner list confirms it is there.
			name: "retired once installed", asked: relayPending, polls: []string{relayInstalling, relayIdle},
			runners: `[{"id":"other","engines":[{"engine":"claude","auth":"yes"}]},{"id":"` + installRunnerID + `","publicId":"` + installRunnerID + `","engines":[{"engine":"codex","auth":"no"},{"engine":"claude","auth":"no"}]}]`,
			want:    strings.Replace(relayInstalling, `"installing"`, `"done"`, 1), requests: 4,
		},
		{
			name: "dismissed before it finished", asked: relayPending, polls: []string{relayInstalling, relayIdle},
			runners: `[{"id":"` + installRunnerID + `","engines":[{"engine":"codex","auth":"no"}]}]`,
			want:    relayIdle, wantError: "the install was dismissed in the Orbit app before the runner reported an outcome", requests: 4,
		},
		{
			name: "an update's outcome stays until dismissed", args: []string{"--update"}, asked: relayUpdatePending,
			polls: []string{relayUpdatePending, relayUpdateDone}, want: relayUpdateDone, requests: 3,
		},
		{
			name: "an update dismissed", args: []string{"--update"}, asked: relayUpdatePending, polls: []string{relayIdle},
			want: relayIdle, wantError: "the update was dismissed in the Orbit app", requests: 2,
		},
		{
			name: "taken by another request", asked: relayPending, polls: []string{strings.Replace(relayPending, `"claude"`, `"codex"`, 1)},
			want:      strings.Replace(relayPending, `"claude"`, `"codex"`, 1),
			wantError: "taken by another request", requests: 2,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			quickEngineRelayWait(t, time.Minute)
			f := &engineRelayServer{asked: tc.asked, polls: tc.polls, runners: tc.runners}
			f.start(t)
			var out bytes.Buffer
			args := append([]string{"install", "--runner-id", installRunnerID, "--engine", "claude", "--wait", "--json"}, tc.args...)
			err := cmdRunnerCLI(args, &out)
			if tc.wantError == "" && err != nil {
				t.Fatalf("runner install --wait: %v", err)
			}
			if tc.wantError != "" && (err == nil || !strings.Contains(err.Error(), tc.wantError)) {
				t.Fatalf("runner install --wait error = %v, want containing %q", err, tc.wantError)
			}
			var got, want interface{}
			if jsonErr := json.Unmarshal(out.Bytes(), &got); jsonErr != nil {
				t.Fatalf("output is not one JSON answer: %q", out.String())
			}
			_ = json.Unmarshal([]byte(tc.want), &want)
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("output = %s, want %s", out.String(), tc.want)
			}
			if len(f.requests) != tc.requests {
				t.Fatalf("requests = %v, want %d of them", f.requests, tc.requests)
			}
			for _, sent := range f.sessions {
				if sent != "caller-session/session-token" {
					t.Fatalf("a poll was sent as %q, not as the calling session", sent)
				}
			}
		})
	}

	t.Run("a runner that never reports", func(t *testing.T) {
		quickEngineRelayWait(t, 20*time.Millisecond)
		f := &engineRelayServer{asked: relayPending, polls: []string{relayPending}}
		f.start(t)
		var out bytes.Buffer
		err := cmdRunnerCLI([]string{"install", "--runner-id", installRunnerID, "--engine", "claude", "--wait"}, &out)
		if err == nil || !strings.Contains(err.Error(), "no outcome from the runner") || !strings.Contains(err.Error(), "orbit runner install-status --runner-id "+installRunnerID) {
			t.Fatalf("error = %v, want the wait's limit and where to look next", err)
		}
		if !strings.Contains(out.String(), `"status": "pending"`) {
			t.Fatalf("output = %q, want where it stood", out.String())
		}
	})
}

func TestRunnerCLIInstallValidatesArguments(t *testing.T) {
	f := &engineRelayServer{asked: relayPending, polls: []string{relayIdle}}
	f.start(t)
	for _, tc := range []struct {
		name      string
		args      []string
		wantError string
	}{
		{name: "no runner", args: []string{"install", "--engine", "claude"}, wantError: "--runner-id is required"},
		{name: "blank runner", args: []string{"install", "--runner-id", " ", "--engine", "claude"}, wantError: "--runner-id is required"},
		{name: "no engine", args: []string{"install", "--runner-id", installRunnerID}, wantError: "--engine is required: one of claude, codex, kimi, antigravity, opencode, dsh, cursor"},
		{name: "an id that is no path segment", args: []string{"install", "--runner-id", "../agents", "--engine", "claude"}, wantError: "single safe path segment"},
		{name: "a command is no flag", args: []string{"install", "--runner-id", installRunnerID, "--engine", "claude", "--command", "rm -rf /"}, wantError: "flag provided but not defined: -command"},
		{name: "trailing argument", args: []string{"install", "--runner-id", installRunnerID, "--engine", "claude", "now"}, wantError: "unexpected arguments: now"},
		{name: "status with no runner", args: []string{"install-status"}, wantError: "--runner-id is required"},
		{name: "status trailing argument", args: []string{"install-status", "--runner-id", installRunnerID, "claude"}, wantError: "unexpected arguments: claude"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var out bytes.Buffer
			err := cmdRunnerCLI(tc.args, &out)
			if err == nil || !strings.Contains(err.Error(), tc.wantError) {
				t.Fatalf("error = %v, want containing %q", err, tc.wantError)
			}
		})
	}
	if len(f.requests) != 0 {
		t.Fatalf("a rejected runner command still made requests: %v", f.requests)
	}
}

// The help says what the command runs and where, what it does not take, the boundary it draws, and what
// --update and --wait mean; the status help says how a finished install reads.
func TestRunnerInstallHelpSaysWhatRunsWhereAndWho(t *testing.T) {
	for _, tc := range []struct {
		action string
		want   []string
	}{
		{action: "install", want: []string{
			"orbit runner install --runner-id ID --engine ENGINE [--update] [--wait] [--json]",
			"own recommended installer", "pressing Install", "no command is taken from here", "must be online",
			"every engine CLI installed on that machine is updated", "every runner of the account",
			"claude, codex, kimi, antigravity, opencode, dsh or cursor", "'orbit runner list' shows the ids", "exits non-zero",
		}},
		{action: "install-status", want: []string{
			"orbit runner install-status --runner-id ID [--json]", "pending", "installing", "done or failed",
			"back to null", "'orbit runner list' then shows it",
		}},
	} {
		var out bytes.Buffer
		if err := cmdRunnerCLI([]string{tc.action, "--help"}, &out); err != nil {
			t.Fatalf("runner %s --help: %v", tc.action, err)
		}
		text := strings.Join(strings.Fields(out.String()), " ")
		for _, want := range tc.want {
			if !strings.Contains(text, strings.Join(strings.Fields(want), " ")) {
				t.Errorf("runner %s --help does not say %q:\n%s", tc.action, want, out.String())
			}
		}
		if !strings.Contains(runnerHelp, "orbit runner "+tc.action+" --runner-id ID") {
			t.Errorf("orbit runner --help does not list %s", tc.action)
		}
	}
}
