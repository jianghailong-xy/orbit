package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

func configureWatchCLISession(t *testing.T, serverURL string) {
	t.Helper()
	configureCLITestRunner(t, serverURL)
	t.Setenv("ORBIT_SESSION_ID", "caller-session")
	t.Setenv(envOrchestrationToken, "session-token")
	t.Setenv(envMCPOrchestration, "true")
	t.Setenv("ORBIT_SERVICE_TOKEN", "")
	t.Setenv("ORBIT_AGENT_ID", "")
	t.Setenv("ORBIT_TASK_ID", "")
}

func TestTaskAwaitCLIIsOneCommandForAllTerminalOrAnyFailed(t *testing.T) {
	srv, requests := watchDoor(t, http.StatusCreated, activeWatchReply)
	configureWatchCLISession(t, srv.URL)
	var out bytes.Buffer
	if err := cmdTaskCLI([]string{"await", "--task-id", "t1,t2", "--task-id", "t3", "--json"}, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}
	if len(*requests) != 1 {
		t.Fatalf("requests = %#v, want one create", *requests)
	}
	request := (*requests)[0]
	if request.method != http.MethodPost || request.uri != "/api/runner/watches" || request.session != "caller-session" {
		t.Fatalf("request = %#v", request)
	}
	want := map[string]interface{}{
		"predicateVersion": float64(1),
		"predicate":        headlineWatchPredicate(t),
		"targets": []interface{}{
			map[string]interface{}{"kind": "TASK", "id": "t1"},
			map[string]interface{}{"kind": "TASK", "id": "t2"},
			map[string]interface{}{"kind": "TASK", "id": "t3"},
		},
		"action": "RESUME_SESSION",
	}
	if !reflect.DeepEqual(request.body, want) {
		t.Fatalf("body = %#v\nwant %#v", request.body, want)
	}
	// A script reads the watch the server made, as it came.
	var printed map[string]interface{}
	if err := json.Unmarshal(out.Bytes(), &printed); err != nil || printed["id"] != "watch-7" {
		t.Fatalf("output = %q (%v)", out.String(), err)
	}
}

func TestWatchCLICommandsReachTheirRoutes(t *testing.T) {
	cases := []struct {
		name        string
		run         func(in io.Reader, out io.Writer) error
		stdin       string
		method, uri string
		body        map[string]interface{}
	}{
		{
			name: "create",
			run: func(in io.Reader, out io.Writer) error {
				return cmdWatchCLI([]string{"create", "--target", "task:t1", "--target", "SESSION:s1", "--predicate-file", "-",
					"--action", "notify_user", "--ttl-seconds", "600", "--idempotency-key", "k1", "--json"}, in, out)
			},
			stdin:  `{"kind":"ANY","over":"ALL_TARGETS","leaf":"TASK_FAILED"}`,
			method: http.MethodPost,
			uri:    "/api/runner/watches",
			body: map[string]interface{}{
				"predicateVersion": float64(1),
				"predicate":        map[string]interface{}{"kind": "ANY", "over": "ALL_TARGETS", "leaf": "TASK_FAILED"},
				"targets": []interface{}{
					map[string]interface{}{"kind": "TASK", "id": "t1"},
					map[string]interface{}{"kind": "SESSION", "id": "s1"},
				},
				"action":         "NOTIFY_USER",
				"ttlSeconds":     float64(600),
				"idempotencyKey": "k1",
			},
		},
		{
			name:   "get",
			run:    func(in io.Reader, out io.Writer) error { return cmdWatchCLI([]string{"get", "w1", "--json"}, in, out) },
			method: http.MethodGet,
			uri:    "/api/runner/watches/w1",
		},
		{
			name: "list",
			run: func(in io.Reader, out io.Writer) error {
				return cmdWatchCLI([]string{"list", "--state", "matched", "--json"}, in, out)
			},
			method: http.MethodGet,
			uri:    "/api/runner/watches?state=MATCHED",
		},
		{
			name: "update",
			run: func(in io.Reader, out io.Writer) error {
				return cmdWatchCLI([]string{"update", "w1", "--ttl-seconds", "900", "--json"}, in, out)
			},
			method: http.MethodPatch,
			uri:    "/api/runner/watches/w1",
			body:   map[string]interface{}{"ttlSeconds": float64(900)},
		},
		{
			name: "cancel",
			run: func(in io.Reader, out io.Writer) error {
				return cmdWatchCLI([]string{"cancel", "w1", "--json"}, in, out)
			},
			method: http.MethodPost,
			uri:    "/api/runner/watches/w1/cancel",
		},
		{
			name: "session await",
			run: func(in io.Reader, out io.Writer) error {
				return cmdSessionCLI([]string{"await", "--session-id", "s1,s2", "--until", "all_run_terminal", "--json"}, in, out)
			},
			method: http.MethodPost,
			uri:    "/api/runner/watches",
			body: map[string]interface{}{
				"predicateVersion": float64(1),
				"predicate":        map[string]interface{}{"kind": "ALL", "over": "ALL_TARGETS", "leaf": "SESSION_RUN_TERMINAL"},
				"targets": []interface{}{
					map[string]interface{}{"kind": "SESSION", "id": "s1"},
					map[string]interface{}{"kind": "SESSION", "id": "s2"},
				},
				"action": "RESUME_SESSION",
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv, requests := watchDoor(t, http.StatusOK, activeWatchReply)
			configureWatchCLISession(t, srv.URL)
			var out bytes.Buffer
			if err := tc.run(strings.NewReader(tc.stdin), &out); err != nil {
				t.Fatal(err)
			}
			if len(*requests) != 1 {
				t.Fatalf("requests = %#v, want one", *requests)
			}
			got := (*requests)[0]
			if got.method != tc.method || got.uri != tc.uri || got.session != "caller-session" {
				t.Fatalf("request = %s %s (session %q), want %s %s from caller-session", got.method, got.uri, got.session, tc.method, tc.uri)
			}
			if !reflect.DeepEqual(got.body, tc.body) {
				t.Fatalf("body = %#v\nwant %#v", got.body, tc.body)
			}
		})
	}
}

func TestWatchCLIOutsideASessionSaysWhyAndSendsNothing(t *testing.T) {
	srv, requests := watchDoor(t, http.StatusOK, activeWatchReply)
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_SESSION_ID", "")
	t.Setenv("ORBIT_SERVICE_TOKEN", "")
	t.Setenv(envMCPOrchestration, "true")
	for name, run := range map[string]func() error{
		"watch list": func() error { return cmdWatchCLI([]string{"list", "--json"}, strings.NewReader(""), io.Discard) },
		"task await": func() error {
			return cmdTaskCLI([]string{"await", "--task-id", "t1"}, strings.NewReader(""), io.Discard)
		},
	} {
		if err := run(); err == nil || !strings.Contains(err.Error(), "ORBIT_SESSION_ID") {
			t.Errorf("%s outside a session = %v, want an error naming ORBIT_SESSION_ID", name, err)
		}
	}
	// session await rides the session gate, where a headless runner credential reaches only get, list and send.
	if err := cmdSessionCLI([]string{"await", "--session-id", "s1"}, strings.NewReader(""), io.Discard); err == nil ||
		!strings.Contains(err.Error(), "requires ORBIT_SESSION_ID") {
		t.Errorf("session await outside a session = %v", err)
	}
	if len(*requests) != 0 {
		t.Fatalf("a command with no session to act for reached the server: %#v", *requests)
	}
}

func TestWatchCLIRefusesMalformedFlagsWithoutSending(t *testing.T) {
	srv, requests := watchDoor(t, http.StatusOK, activeWatchReply)
	configureWatchCLISession(t, srv.URL)
	cases := []struct {
		args []string
		says string
	}{
		{[]string{"create", "--predicate", `{"kind":"ALL","over":"ALL_TARGETS","leaf":"TASK_DONE"}`}, "--target is required"},
		{[]string{"create", "--target", "t1", "--predicate", "{}"}, `--target "t1" is not KIND:ID`},
		{[]string{"create", "--target", "TASK:t1"}, "--predicate or --predicate-file - is required"},
		{[]string{"create", "--target", "TASK:t1", "--predicate", "ALL TASK_DONE"}, "--predicate must be a JSON object"},
		{[]string{"create", "--target", "TASK:t1", "--predicate", "{}", "--ttl-seconds", "30"}, "--ttl-seconds must be"},
		{[]string{"list", "--state", "NOPE"}, "--state must be one of"},
		{[]string{"update", "w1"}, "nothing to update"},
		{[]string{"get"}, "watch id is required"},
	}
	for _, tc := range cases {
		if err := cmdWatchCLI(tc.args, strings.NewReader(""), io.Discard); err == nil || !strings.Contains(err.Error(), tc.says) {
			t.Errorf("orbit watch %v = %v, want an error saying %q", tc.args, err, tc.says)
		}
	}
	if err := cmdTaskCLI([]string{"await", "--task-id", "t1", "--until", "later"}, strings.NewReader(""), io.Discard); err == nil ||
		!strings.Contains(err.Error(), "--until must be one of") {
		t.Errorf("task await --until later = %v", err)
	}
	if err := cmdTaskCLI([]string{"await"}, strings.NewReader(""), io.Discard); err == nil || !strings.Contains(err.Error(), "--task-id is required") {
		t.Errorf("task await with no ids = %v", err)
	}
	if len(*requests) != 0 {
		t.Fatalf("a refused command reached the server: %#v", *requests)
	}
}

func TestWatchCommandsAreAdvertisedOnlyWhereTheyCanAct(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	t.Setenv("ORBIT_SERVICE_TOKEN", "")
	t.Setenv(envOrchestrationToken, "")
	advertised := func() map[string]bool {
		ids := map[string]bool{}
		for _, capability := range buildCLICapabilities("/opt/orbit").Capabilities {
			ids[capability.ID] = true
		}
		return ids
	}
	watchIDs := []string{"watch_create", "watch_get", "watch_list", "watch_update", "watch_cancel", "task_await"}

	t.Setenv("ORBIT_SESSION_ID", "session-1")
	t.Setenv(envMCPOrchestration, "")
	plain := advertised()
	for _, id := range watchIDs {
		if !plain[id] {
			t.Errorf("%s is not advertised inside a session", id)
		}
	}
	if plain["session_await"] {
		t.Error("session_await is advertised to a session without orchestration")
	}

	t.Setenv(envMCPOrchestration, "true")
	if !advertised()["session_await"] {
		t.Error("session_await is not advertised to an orchestrating session")
	}

	t.Setenv("ORBIT_SESSION_ID", "")
	headless := advertised()
	for _, id := range append(watchIDs, "session_await") {
		if headless[id] {
			t.Errorf("%s is advertised outside any session, where it has nothing to wake", id)
		}
	}
}

func TestWatchHelpIsReachableFromEveryDoor(t *testing.T) {
	if !ownsLeafHelp("watch") || !strings.Contains(helpFor("watch"), "orbit watch create") || !strings.Contains(usage, "orbit watch <command>") {
		t.Fatal("orbit watch is missing from the top-level help")
	}
	var out bytes.Buffer
	if err := cmdWatchCLI([]string{"create", "--help"}, strings.NewReader(""), &out); err != nil || !strings.Contains(out.String(), "--predicate-file -") {
		t.Fatalf("orbit watch create --help = %q (%v)", out.String(), err)
	}
	for name, run := range map[string]func(io.Writer) error{
		"task await":    func(w io.Writer) error { return cmdTaskCLI([]string{"await", "--help"}, strings.NewReader(""), w) },
		"session await": func(w io.Writer) error { return cmdSessionCLI([]string{"await", "--help"}, strings.NewReader(""), w) },
	} {
		out.Reset()
		if err := run(&out); err != nil {
			t.Fatalf("%s --help: %v", name, err)
		}
		presets := taskAwaitPresets
		if name == "session await" {
			presets = sessionAwaitPresets
		}
		for _, preset := range presets {
			if !strings.Contains(out.String(), preset.until) {
				t.Errorf("%s --help does not name %s:\n%s", name, preset.until, out.String())
			}
		}
	}
}

func TestAgentInstructionsSendOrbitWaitsToWatches(t *testing.T) {
	const exe = "/usr/local/bin/orbit"
	instructions := orbitCLIInstructions(exe, true, true)
	for _, phrase := range []string{"do not poll", "task_await", "session_await", "end your turn"} {
		if !strings.Contains(instructions, phrase) {
			t.Errorf("instructions do not say %q", phrase)
		}
	}
	for i := 0; i < len(orbitWaitInstructions); i++ {
		if orbitWaitInstructions[i] > 127 {
			t.Fatalf("the wait paragraph must stay ASCII for codex's context value; byte %d is %q", i, orbitWaitInstructions[i])
		}
	}
	plain := strings.Join(orbitCLIAllowedTools(exe, false), "\n")
	for _, rule := range []string{"Bash(" + exe + " task await *)", "Bash(" + exe + " watch create *)", "Bash(" + exe + " watch cancel *)"} {
		if !strings.Contains(plain, rule) {
			t.Errorf("allowed tools miss %q", rule)
		}
	}
	if strings.Contains(plain, " session await *)") {
		t.Error("a session without orchestration was pre-approved for session await")
	}
	if !strings.Contains(strings.Join(orbitCLIAllowedTools(exe, true), "\n"), "Bash("+exe+" session await *)") {
		t.Error("an orchestrating session is not pre-approved for session await")
	}
}
