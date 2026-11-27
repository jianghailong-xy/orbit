package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The browser tools' one gate (browser_tools.go): with ORBIT_BROWSER on, browser_status is in `orbit mcp`'s tool list,
// `orbit browser status` is offered by `orbit capabilities` and runs; with it off or unset, the tool is not listed, the
// command is not offered and `orbit browser` is an unknown command, rather than an error from the server.

func listsTool(s *mcpServer, name string) bool {
	for _, tool := range s.listedToolDescriptors() {
		if tool["name"] == name {
			return true
		}
	}
	return false
}

func offersCommand(t *testing.T, tool string) (offered bool, unavailableCode string) {
	t.Helper()
	doc := buildCLICapabilities("/usr/local/bin/orbit")
	for _, c := range doc.Capabilities {
		if c.ID == tool {
			return c.Available, c.UnavailableCode
		}
	}
	for _, c := range doc.UnavailableCapabilities {
		if c.ID == tool {
			return false, c.UnavailableCode
		}
	}
	return false, ""
}

func browserStatusServer(t *testing.T, status int, body string, seen *http.Request) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if seen != nil {
			*seen = *r.Clone(r.Context())
		}
		if r.Method != http.MethodGet || r.URL.Path != "/api/runner/browser" {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv
}

const browserStatusHeld = `{"enabled":true,"runnerId":"R1","state":"RUNNING","running":true,"holderSessionId":"sess-holder",` +
	`"holderTitle":"Export the monthly report","viewers":2,"savedLogins":true,"reportedAt":"2026-11-19T08:00:00.000Z"}`

func TestBrowserStatusToolIsListedOnlyWithTheSwitchOn(t *testing.T) {
	for _, env := range []string{"on", "1", "true"} {
		t.Setenv(envBrowser, env)
		if !listsTool(&mcpServer{sessionID: "s", browserOn: browserToolsEnabledFromEnv()}, "browser_status") {
			t.Errorf("ORBIT_BROWSER=%s: browser_status is not listed", env)
		}
	}
	for _, env := range []string{"", "off", "0", "false", "yes please"} {
		t.Setenv(envBrowser, env)
		if listsTool(&mcpServer{sessionID: "s", browserOn: browserToolsEnabledFromEnv()}, "browser_status") {
			t.Errorf("ORBIT_BROWSER=%q: browser_status is listed", env)
		}
	}
	os.Unsetenv(envBrowser)
	if browserToolsEnabledFromEnv() {
		t.Error("an engine spawned by a runner that predates ORBIT_BROWSER has the browser tools")
	}
}

func TestOrbitBrowserStatusCommandIsPresentOnlyWithTheSwitchOn(t *testing.T) {
	var seen http.Request
	srv := browserStatusServer(t, http.StatusOK, browserStatusHeld, &seen)
	catalogFullestCLIContext(t)
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_SESSION_ID", "sess-asking")

	t.Setenv(envBrowser, "on")
	if offered, code := offersCommand(t, "browser_status"); !offered {
		t.Fatalf("switch on: `orbit capabilities` does not offer browser_status (%s)", code)
	}
	var out bytes.Buffer
	if err := runOrbitCLI([]string{"browser", "status", "--json"}, strings.NewReader(""), &out, &bytes.Buffer{}); err != nil {
		t.Fatalf("switch on: orbit browser status: %v", err)
	}
	if seen.Header.Get("X-Orbit-Session-Id") != "sess-asking" {
		t.Errorf("the command did not ask as its session: %q", seen.Header.Get("X-Orbit-Session-Id"))
	}
	var got map[string]interface{}
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatalf("output is not JSON: %v (%s)", err, out.String())
	}
	want := map[string]interface{}{"enabled": true, "runnerId": "R1", "state": "RUNNING", "running": true,
		"holderSessionId": "sess-holder", "holderTitle": "Export the monthly report", "viewers": float64(2),
		"savedLogins": true, "reportedAt": "2026-11-19T08:00:00.000Z"}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %#v, want %#v", k, got[k], v)
		}
	}
	if len(got) != len(want) {
		t.Errorf("the status says more than its fields: %s", out.String())
	}

	for _, env := range []string{"", "off"} {
		t.Setenv(envBrowser, env)
		if offered, code := offersCommand(t, "browser_status"); offered || code != "" {
			t.Errorf("ORBIT_BROWSER=%q: browser_status offered=%v code=%q, want in neither list", env, offered, code)
		}
		seen = http.Request{}
		out.Reset()
		err := runOrbitCLI([]string{"browser", "status"}, strings.NewReader(""), &out, &bytes.Buffer{})
		if err == nil || !strings.HasPrefix(err.Error(), "unknown command: browser") {
			t.Errorf("ORBIT_BROWSER=%q: `orbit browser status` = %v, want an unknown command", env, err)
		}
		if seen.URL != nil {
			t.Errorf("ORBIT_BROWSER=%q: the command reached the server", env)
		}
	}
}

func TestBrowserStatusToolAnswersTheFields(t *testing.T) {
	var seen http.Request
	srv := browserStatusServer(t, http.StatusOK, browserStatusHeld, &seen)
	s := &mcpServer{t: NewTransport(srv.URL, "tok"), sessionID: "sess-asking", browserOn: true}
	result := s.callTool("browser_status", map[string]interface{}{})
	if result["isError"] == true {
		t.Fatalf("browser_status failed: %v", result["content"])
	}
	if seen.Header.Get("X-Orbit-Session-Id") != "sess-asking" {
		t.Errorf("session header = %q", seen.Header.Get("X-Orbit-Session-Id"))
	}
	data, _ := result["structuredContent"].(*browserStatus)
	if data == nil || !data.Enabled || !data.Running || data.Viewers != 2 || data.SavedLogins == nil || !*data.SavedLogins ||
		data.HolderSessionID == nil || *data.HolderSessionID != "sess-holder" || data.RunnerID == nil || *data.RunnerID != "R1" {
		t.Fatalf("structuredContent = %#v", result["structuredContent"])
	}

	// The switch turned off on the server since this engine was spawned: the route is a 404, and the tool says off.
	off := browserStatusServer(t, http.StatusNotFound, `{"message":"Cannot GET /api/runner/browser","statusCode":404}`, nil)
	s.t = NewTransport(off.URL, "tok")
	result = s.callTool("browser_status", map[string]interface{}{})
	if data, _ := result["structuredContent"].(*browserStatus); result["isError"] == true || data == nil || data.Enabled {
		t.Fatalf("a 404 is not reported as off: %#v", result)
	}

	// Another account's session is the server's to refuse (403), and the tool reports the refusal as a failure.
	refused := browserStatusServer(t, http.StatusForbidden, `{"message":"X-Orbit-Session-Id names no session this runner hosts","statusCode":403}`, nil)
	s.t = NewTransport(refused.URL, "tok")
	if result = s.callTool("browser_status", map[string]interface{}{}); result["isError"] != true {
		t.Fatalf("a refusal is not a failure: %#v", result)
	}

	// Spawned with the switch off, a stray call reaches nothing.
	s.browserOn = false
	seen = http.Request{}
	s.t = NewTransport(srv.URL, "tok")
	if result = s.callTool("browser_status", map[string]interface{}{}); result["isError"] != true || seen.URL != nil {
		t.Fatalf("switch off: %#v (reached the server: %v)", result, seen.URL != nil)
	}
}

func TestBrowserReportSaysOnlyWhetherSavedLoginsExist(t *testing.T) {
	home := t.TempDir()
	b := newRunnerBrowser(managedEnv, home, newFakePoolClock(), &fakeBrowserStarter{}, nil)
	if b.Report().SavedLogins {
		t.Fatal("no profile: saved logins reported")
	}
	store := filepath.Join(b.ProfileDir(), "Default", "Network", "Cookies")
	if err := os.MkdirAll(filepath.Dir(store), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(store, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if b.Report().SavedLogins {
		t.Fatal("an empty cookie store: saved logins reported")
	}
	if err := os.WriteFile(store, []byte("SQLite format 3\x00 cookies for some-site.example"), 0o600); err != nil {
		t.Fatal(err)
	}
	r := b.Report()
	if !r.SavedLogins {
		t.Fatal("a cookie store: no saved logins reported")
	}
	body, _ := json.Marshal(r)
	if strings.Contains(string(body), "some-site") {
		t.Fatalf("the report names a site: %s", body)
	}
	if err := b.ClearProfile(); err != nil {
		t.Fatal(err)
	}
	if b.Report().SavedLogins {
		t.Fatal("cleared: saved logins still reported")
	}
}

// Off means absent in every listing a session reads, not only in tools/list and the CLI's routing: the capabilities
// document (both lists), its --summary, --family and --id views, `orbit mcp help`, Claude Code's pre-approved CLI rules,
// and the agent tools report's families. With the switch on, each of them names the browser.
func TestBrowserIsAbsentFromEveryListingWithTheSwitchOff(t *testing.T) {
	catalogFullestCLIContext(t)
	const exe = "/usr/local/bin/orbit"
	rule := "Bash(" + exe + " browser status *)"
	for _, on := range []bool{true, false} {
		env := map[bool]string{true: "on", false: ""}[on]
		t.Setenv(envBrowser, env)
		where := fmt.Sprintf("ORBIT_BROWSER=%q", env)
		names := func(what string, present bool) {
			t.Helper()
			if present != on {
				t.Errorf("%s: %s names the browser: %v, want %v", where, what, present, on)
			}
		}

		doc := buildCLICapabilities(exe)
		inDoc := false
		for _, c := range append(append([]cliCapability{}, doc.Capabilities...), doc.UnavailableCapabilities...) {
			inDoc = inDoc || c.ID == "browser_status"
		}
		names("`orbit capabilities --json`", inDoc)

		d := newCLIDiscovery(exe)
		summary, _ := json.Marshal(d.summary())
		names("`orbit capabilities --summary`", strings.Contains(string(summary), "browser"))
		_, familyErr := d.family("browser")
		names("`orbit capabilities --family browser`", familyErr == nil)
		_, idErr := d.id("browser_status")
		names("`orbit capabilities --id browser_status`", idErr == nil)

		names("`orbit mcp help`", strings.Contains(mcpHelp(), "Orbit Cloud browser"))
		names("tools/list", listsTool(&mcpServer{sessionID: "s", browserOn: browserToolsEnabledFromEnv()}, "browser_status"))

		allowed := false
		for _, r := range orbitCLIAllowedTools(exe, true, on) {
			allowed = allowed || r == rule
		}
		names("Claude Code's pre-approved CLI rules", allowed)

		job := agentToolsJob()
		job.BrowserEnabled = on
		family := false
		for _, f := range newAgentToolsReport(job, providerClaude, carrierAppendSystemPrompt).Families {
			family = family || f.ID == "browser"
		}
		names("the agent tools report's families", family)
	}
}

// browser_clear_logins and `orbit browser clear-logins` (browser_tools.go): the card first, filed under
// orbit_browser_clear_logins with nothing of the asker's in it (the server writes what the owner reads); the clear
// (POST /runner/browser/clear, naming the card) only on the owner's yes; a declined or expired card sends no clear.
func TestBrowserClearLoginsClearsOnlyOnTheOwnersYes(t *testing.T) {
	for _, tc := range []struct {
		name, decision, outcome string
		cleared                 bool
	}{
		{"confirmed", `{"id":"ap1","status":"ALLOWED","behavior":"allow","decidedById":"owner"}`, "CONFIRMED", true},
		{"declined", `{"id":"ap1","status":"DENIED","behavior":"deny","decidedById":"owner"}`, "DECLINED", false},
		{"expired", `{"id":"ap1","status":"ABANDONED","behavior":"deny"}`, "EXPIRED", false},
	} {
		for _, door := range []string{"mcp", "cli"} {
			t.Run(tc.name+"/"+door, func(t *testing.T) {
				var hits []string
				filed := map[string]interface{}{}
				clearBody := map[string]interface{}{}
				var clearSession string
				srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					hits = append(hits, r.Method+" "+r.URL.Path)
					switch {
					case strings.Contains(r.URL.Path, "/approvals/"):
						_, _ = w.Write([]byte(tc.decision))
					case strings.HasSuffix(r.URL.Path, "/approvals"):
						_ = json.NewDecoder(r.Body).Decode(&filed)
						_, _ = w.Write([]byte(`{"id":"ap1","status":"PENDING"}`))
					case r.URL.Path == "/api/runner/browser/clear":
						clearSession = r.Header.Get("X-Orbit-Session-Id")
						_ = json.NewDecoder(r.Body).Decode(&clearBody)
						w.WriteHeader(http.StatusAccepted)
						_, _ = w.Write([]byte(`{"runnerId":"R1","approvalId":"ap1","requestedAt":"2026-11-19T12:00:00.000Z"}`))
					default:
						http.NotFound(w, r)
					}
				}))
				defer srv.Close()

				var got browserClearLogins
				if door == "mcp" {
					t.Setenv(envBgJobID, "")
					s := &mcpServer{t: NewTransport(srv.URL, "tok"), sessionID: "sess-asking", browserOn: true}
					result := s.callTool("browser_clear_logins", map[string]interface{}{})
					if result["isError"] == true {
						t.Fatalf("failed: %v", result["content"])
					}
					data, _ := result["structuredContent"].(*browserClearLogins)
					if data == nil {
						t.Fatalf("structuredContent = %#v", result["structuredContent"])
					}
					got = *data
				} else {
					catalogFullestCLIContext(t)
					configureCLITestRunner(t, srv.URL)
					t.Setenv(envBrowser, "on")
					t.Setenv("ORBIT_SESSION_ID", "sess-asking")
					t.Setenv(envBgJobID, "")
					var out bytes.Buffer
					if err := runOrbitCLI([]string{"browser", "clear-logins", "--json"}, strings.NewReader(""), &out, &bytes.Buffer{}); err != nil {
						t.Fatalf("orbit browser clear-logins: %v", err)
					}
					if err := json.Unmarshal(out.Bytes(), &got); err != nil {
						t.Fatalf("output %q: %v", out.String(), err)
					}
				}

				if len(hits) < 2 || hits[0] != "POST /api/runner/sessions/sess-asking/approvals" {
					t.Fatalf("the card was not filed first: %v", hits)
				}
				if filed["toolName"] != browserClearApprovalToolName {
					t.Errorf("card toolName = %v", filed["toolName"])
				}
				if input, _ := filed["input"].(map[string]interface{}); len(input) != 0 {
					t.Errorf("the card carries the asker's words: %v", filed["input"])
				}
				sentClear := hits[len(hits)-1] == "POST /api/runner/browser/clear"
				if sentClear != tc.cleared {
					t.Fatalf("clear sent = %v, want %v: %v", sentClear, tc.cleared, hits)
				}
				if got.Outcome != tc.outcome || got.Cleared != tc.cleared {
					t.Fatalf("answer = %+v, want outcome %s cleared %v", got, tc.outcome, tc.cleared)
				}
				if tc.cleared {
					if clearSession != "sess-asking" || clearBody["approvalId"] != "ap1" {
						t.Errorf("clear sent as session %q with %v", clearSession, clearBody)
					}
					if got.RequestedAt == nil || got.RunnerID == nil || *got.RunnerID != "R1" {
						t.Errorf("answer = %+v", got)
					}
				} else if !strings.Contains(got.Message, "nothing was cleared") {
					t.Errorf("message = %q", got.Message)
				}
			})
		}
	}
}

// Headless there is nobody to ask: the clear is refused before anything reaches the server, and a switched-off session
// reaches nothing either.
func TestBrowserClearLoginsNeedsASessionAndTheSwitch(t *testing.T) {
	var reached bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reached = true }))
	defer srv.Close()
	s := &mcpServer{t: NewTransport(srv.URL, "tok"), sessionID: "", browserOn: true}
	if result := s.callTool("browser_clear_logins", map[string]interface{}{}); result["isError"] != true || reached {
		t.Fatalf("headless: %#v (reached the server: %v)", result, reached)
	}
	s = &mcpServer{t: NewTransport(srv.URL, "tok"), sessionID: "sess", browserOn: false}
	if result := s.callTool("browser_clear_logins", map[string]interface{}{}); result["isError"] != true || reached {
		t.Fatalf("switch off: %#v (reached the server: %v)", result, reached)
	}
	if !waitsForTheOwner("browser_clear_logins", map[string]interface{}{}) {
		t.Fatal("browser_clear_logins is not handed off as a wait for the owner")
	}
}
