package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// browser_open and `orbit browser open [--url]` (browser_tools.go), and the runner's half of it (browser_open.go):
//   - the tool and the command exist only with ORBIT_BROWSER on;
//   - they ask POST /runner/browser/open as their session, with the url when one is given, and answer the tab's
//     address once the runner reports the browser running; a 404 (switch off) is "off", a 403 (another account's
//     session) and a 409 (another session holds the browser) are failures;
//   - the command opens the tab on this machine, or prints it when there is nothing to open it with;
//   - the runner starts the browser without taking the lease, and opens the page through DevTools only while no other
//     session holds the browser.

// browserOpenServer is the apiserver's two browser routes for a session: POST /runner/browser/open answers openStatus
// and openBody; GET /runner/browser answers the browser running, reported after the open.
type browserOpenServer struct {
	srv        *httptest.Server
	mu         sync.Mutex
	openStatus int
	openBody   string
	opens      []map[string]interface{}
	sessions   []string
	statusRead int
}

func newBrowserOpenServer(t *testing.T, openStatus int, openBody string) *browserOpenServer {
	t.Helper()
	s := &browserOpenServer{openStatus: openStatus, openBody: openBody}
	s.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/runner/browser/open":
			raw, _ := io.ReadAll(r.Body)
			var body map[string]interface{}
			_ = json.Unmarshal(raw, &body)
			s.opens = append(s.opens, body)
			s.sessions = append(s.sessions, r.Header.Get("X-Orbit-Session-Id"))
			w.WriteHeader(s.openStatus)
			_, _ = w.Write([]byte(s.openBody))
		case r.Method == http.MethodGet && r.URL.Path == "/api/runner/browser":
			s.statusRead++
			// The first read is the beat before the open; the runner reports the browser running after it.
			if s.statusRead == 1 {
				_, _ = w.Write([]byte(`{"enabled":true,"runnerId":"R1","state":"IDLE","running":false,"viewers":0,"reportedAt":"2026-11-19T08:59:00.000Z"}`))
				return
			}
			_, _ = w.Write([]byte(`{"enabled":true,"runnerId":"R1","state":"RUNNING","running":true,"viewers":0,"reportedAt":"2026-11-19T09:00:01.000Z"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(s.srv.Close)
	return s
}

func (s *browserOpenServer) asked() ([]map[string]interface{}, []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]map[string]interface{}(nil), s.opens...), append([]string(nil), s.sessions...)
}

const browserOpenAnswer = `{"runnerId":"R1","tabUrl":"https://orbit.test/runners/R1/browser","url":"https://example.test/login",` +
	`"requestedAt":"2026-11-19T09:00:00.000Z"}`

func fastBrowserOpenPoll(t *testing.T) {
	t.Helper()
	wait, poll := browserOpenRunningWait, browserOpenPoll
	browserOpenRunningWait, browserOpenPoll = 2*time.Second, 5*time.Millisecond
	t.Cleanup(func() { browserOpenRunningWait, browserOpenPoll = wait, poll })
}

func TestBrowserOpenIsPresentOnlyWithTheSwitchOn(t *testing.T) {
	srv := newBrowserOpenServer(t, http.StatusAccepted, browserOpenAnswer)
	catalogFullestCLIContext(t)
	configureCLITestRunner(t, srv.srv.URL)
	t.Setenv("ORBIT_SESSION_ID", "sess-asking")

	t.Setenv(envBrowser, "on")
	if !listsTool(&mcpServer{sessionID: "s", browserOn: browserToolsEnabledFromEnv()}, "browser_open") {
		t.Error("switch on: browser_open is not listed")
	}
	if offered, code := offersCommand(t, "browser_open"); !offered {
		t.Errorf("switch on: `orbit capabilities` does not offer browser_open (%s)", code)
	}
	for _, env := range []string{"", "off"} {
		t.Setenv(envBrowser, env)
		if listsTool(&mcpServer{sessionID: "s", browserOn: browserToolsEnabledFromEnv()}, "browser_open") {
			t.Errorf("ORBIT_BROWSER=%q: browser_open is listed", env)
		}
		if offered, code := offersCommand(t, "browser_open"); offered || code != "" {
			t.Errorf("ORBIT_BROWSER=%q: browser_open offered=%v code=%q, want in neither list", env, offered, code)
		}
		err := runOrbitCLI([]string{"browser", "open", "--url", "https://example.test/login"}, strings.NewReader(""), &bytes.Buffer{}, &bytes.Buffer{})
		if err == nil || !strings.HasPrefix(err.Error(), "unknown command: browser") {
			t.Errorf("ORBIT_BROWSER=%q: `orbit browser open` = %v, want an unknown command", env, err)
		}
		// Spawned with the switch off, a stray tools/call reaches nothing either.
		s := &mcpServer{t: NewTransport(srv.srv.URL, "tok"), sessionID: "s", browserOn: false}
		if result := s.callTool("browser_open", map[string]interface{}{"url": "https://example.test/login"}); result["isError"] != true {
			t.Errorf("ORBIT_BROWSER=%q: a stray browser_open call = %#v", env, result)
		}
	}
	if opens, _ := srv.asked(); len(opens) != 0 {
		t.Fatalf("with the switch off the server was asked to open the browser: %v", opens)
	}
}

func TestBrowserOpenToolAsksAsItsSessionAndAnswersTheTab(t *testing.T) {
	fastBrowserOpenPoll(t)
	srv := newBrowserOpenServer(t, http.StatusAccepted, browserOpenAnswer)
	s := &mcpServer{t: NewTransport(srv.srv.URL, "tok"), sessionID: "sess-asking", browserOn: true}
	result := s.callTool("browser_open", map[string]interface{}{"url": "https://example.test/login"})
	if result["isError"] == true {
		t.Fatalf("browser_open failed: %v", result["content"])
	}
	opens, sessions := srv.asked()
	if len(opens) != 1 || opens[0]["url"] != "https://example.test/login" || sessions[0] != "sess-asking" {
		t.Fatalf("asked %v as %v, want the url once as sess-asking", opens, sessions)
	}
	data, _ := result["structuredContent"].(*browserOpenResult)
	if data == nil || !data.Enabled || !data.Running || data.TabURL == nil || *data.TabURL != "https://orbit.test/runners/R1/browser" ||
		data.URL == nil || *data.URL != "https://example.test/login" || data.OpenedLocally != nil {
		t.Fatalf("structuredContent = %#v", result["structuredContent"])
	}

	// Without a url the body names none: the browser is only started.
	srv2 := newBrowserOpenServer(t, http.StatusAccepted, `{"runnerId":"R1","tabUrl":"https://orbit.test/runners/R1/browser","url":null,"requestedAt":"2026-11-19T09:00:00.000Z"}`)
	s.t = NewTransport(srv2.srv.URL, "tok")
	if result = s.callTool("browser_open", map[string]interface{}{}); result["isError"] == true {
		t.Fatalf("browser_open without a url failed: %v", result["content"])
	}
	if opens, _ := srv2.asked(); len(opens) != 1 || len(opens[0]) != 0 {
		t.Fatalf("without a url the body was %v", opens)
	}

	// The switch turned off on the server since the spawn: 404, answered as off.
	off := newBrowserOpenServer(t, http.StatusNotFound, `{"message":"Cannot POST /api/runner/browser/open","statusCode":404}`)
	s.t = NewTransport(off.srv.URL, "tok")
	result = s.callTool("browser_open", map[string]interface{}{})
	if data, _ := result["structuredContent"].(*browserOpenResult); result["isError"] == true || data == nil || data.Enabled {
		t.Fatalf("a 404 is not reported as off: %#v", result)
	}

	// Another account's session (403) and another session holding the browser (409) are failures, as the server says.
	for _, refusal := range []struct {
		status int
		body   string
	}{
		{http.StatusForbidden, `{"message":"X-Orbit-Session-Id names no session this runner hosts","statusCode":403}`},
		{http.StatusConflict, `{"message":"The browser is in use by session S2; try again after it finishes","statusCode":409}`},
	} {
		refused := newBrowserOpenServer(t, refusal.status, refusal.body)
		s.t = NewTransport(refused.srv.URL, "tok")
		result = s.callTool("browser_open", map[string]interface{}{"url": "https://example.test/login"})
		if result["isError"] != true {
			t.Errorf("%d is not a failure: %#v", refusal.status, result)
		}
	}
}

func TestOrbitBrowserOpenOpensTheTabHereOrPrintsIt(t *testing.T) {
	fastBrowserOpenPoll(t)
	srv := newBrowserOpenServer(t, http.StatusAccepted, browserOpenAnswer)
	catalogFullestCLIContext(t)
	configureCLITestRunner(t, srv.srv.URL)
	t.Setenv("ORBIT_SESSION_ID", "sess-asking")
	t.Setenv(envBrowser, "on")
	var openedHere []string
	opener := true
	saved := openTabLocally
	openTabLocally = func(link string) bool {
		openedHere = append(openedHere, link)
		return opener
	}
	t.Cleanup(func() { openTabLocally = saved })

	run := func(args ...string) (string, map[string]interface{}) {
		t.Helper()
		var out bytes.Buffer
		if err := runOrbitCLI(append([]string{"browser", "open"}, args...), strings.NewReader(""), &out, &bytes.Buffer{}); err != nil {
			t.Fatalf("orbit browser open %v: %v", args, err)
		}
		text := out.String()
		var got map[string]interface{}
		if i := strings.Index(text, "{"); i >= 0 {
			_ = json.Unmarshal([]byte(text[i:]), &got)
		}
		return text, got
	}

	_, got := run("--url", "https://example.test/login", "--json")
	if len(openedHere) != 1 || openedHere[0] != "https://orbit.test/runners/R1/browser" {
		t.Fatalf("opened here %v, want the tab once", openedHere)
	}
	if got["openedLocally"] != true || got["tabUrl"] != "https://orbit.test/runners/R1/browser" || got["running"] != true {
		t.Fatalf("output %v", got)
	}
	if opens, sessions := srv.asked(); opens[0]["url"] != "https://example.test/login" || sessions[0] != "sess-asking" {
		t.Fatalf("asked %v as %v", opens, sessions)
	}

	// Nothing to open it with here: the address is printed to open by hand.
	opener = false
	text, got := run()
	if !strings.HasPrefix(text, "Open the browser tab: https://orbit.test/runners/R1/browser\n") || got["openedLocally"] != false {
		t.Fatalf("with no opener the output is %q", text)
	}

	// --no-open: printed, and no browser started here.
	openedHere = nil
	opener = true
	if text, got = run("--no-open"); len(openedHere) != 0 || got["openedLocally"] != false ||
		!strings.HasPrefix(text, "Open the browser tab: ") {
		t.Fatalf("--no-open opened %v and printed %q", openedHere, text)
	}
}

// The runner's half: started as Open browser starts it, without the lease; a page only under no other session's lease.
func TestRunnerBrowserOpenStartsAndOpensThePageOnlyWhenNotHeldByAnother(t *testing.T) {
	var navigated []string
	savedNav, savedReady := browserNavigate, browserDevToolsReady
	browserNavigate = func(_ context.Context, endpoint, target string) error {
		navigated = append(navigated, endpoint+" "+target)
		return nil
	}
	browserDevToolsReady = func(string) {}
	t.Cleanup(func() { browserNavigate, browserDevToolsReady = savedNav, savedReady })

	r := newBrowserRig(t)
	if r.b.Running() {
		t.Fatal("started before anything asked")
	}
	if err := handleBrowserOpen(context.Background(), r.b, BrowserOpenCommand{SessionID: "sess-a"}); err != nil {
		t.Fatalf("open: %v", err)
	}
	if !r.b.Running() || r.b.Holder() != "" || len(navigated) != 0 {
		t.Fatalf("running=%v holder=%q navigated=%v, want started, no lease, no page", r.b.Running(), r.b.Holder(), navigated)
	}

	if err := handleBrowserOpen(context.Background(), r.b, BrowserOpenCommand{SessionID: "sess-a", URL: "https://example.test/login"}); err != nil {
		t.Fatalf("open a page: %v", err)
	}
	if len(navigated) != 1 || navigated[0] != "http://127.0.0.1:9222 https://example.test/login" || r.b.Holder() != "" {
		t.Fatalf("navigated %v holder %q", navigated, r.b.Holder())
	}

	// Another session holds the browser: its page is not taken from it.
	if err := r.b.Acquire("sess-holder", "Export"); err != nil {
		t.Fatal(err)
	}
	if err := handleBrowserOpen(context.Background(), r.b, BrowserOpenCommand{SessionID: "sess-a", URL: "https://example.test/other"}); err == nil {
		t.Fatal("a page was opened under another session's lease")
	}
	if len(navigated) != 1 || r.b.Holder() != "sess-holder" {
		t.Fatalf("navigated %v holder %q", navigated, r.b.Holder())
	}
	// The holder itself may.
	if err := handleBrowserOpen(context.Background(), r.b, BrowserOpenCommand{SessionID: "sess-holder", URL: "https://example.test/mine"}); err != nil || len(navigated) != 2 {
		t.Fatalf("the holder's own open: %v, navigated %v", err, navigated)
	}

	// The server no longer offers the browser: nothing starts.
	off := newBrowserRig(t)
	off.b.SetOffered(false)
	if err := handleBrowserOpen(context.Background(), off.b, BrowserOpenCommand{SessionID: "sess-a"}); !errors.Is(err, errBrowserUnavailable) || off.b.Running() {
		t.Fatalf("not offered: %v running=%v", err, off.b.Running())
	}
}

// navigateBrowserPage against a fake DevTools: the shown tab is navigated with Page.navigate; with no tab, one is
// opened on the page with PUT /json/new; anything but http(s) is refused before DevTools is asked.
func TestNavigateBrowserPageThroughDevTools(t *testing.T) {
	var mu sync.Mutex
	var calls []string
	pages := true
	mux := http.NewServeMux()
	mux.HandleFunc("/json/list", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		list := []map[string]string{{"type": "page", "url": "devtools://devtools/inspector.html", "webSocketDebuggerUrl": "ws://" + r.Host + "/devtools/page/inspector"}}
		if pages {
			list = append(list, map[string]string{"type": "page", "url": "about:blank", "webSocketDebuggerUrl": "ws://" + r.Host + "/devtools/page/shown"})
		}
		_ = json.NewEncoder(w).Encode(list)
	})
	mux.HandleFunc("/json/new", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		calls = append(calls, r.Method+" new "+r.URL.RawQuery)
		mu.Unlock()
		_, _ = w.Write([]byte(`{}`))
	})
	mux.HandleFunc("/devtools/page/", func(w http.ResponseWriter, r *http.Request) {
		page := strings.TrimPrefix(r.URL.Path, "/devtools/page/")
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		for {
			_, data, err := c.Read(r.Context())
			if err != nil {
				return
			}
			var cmd struct {
				ID     int            `json:"id"`
				Method string         `json:"method"`
				Params map[string]any `json:"params"`
			}
			_ = json.Unmarshal(data, &cmd)
			mu.Lock()
			u, _ := cmd.Params["url"].(string)
			calls = append(calls, page+" "+cmd.Method+" "+u)
			mu.Unlock()
			_ = c.Write(r.Context(), websocket.MessageText, []byte(`{"method":"Page.frameStartedLoading","params":{}}`))
			out, _ := json.Marshal(map[string]any{"id": cmd.ID, "result": map[string]any{"frameId": "F"}})
			_ = c.Write(r.Context(), websocket.MessageText, out)
		}
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	if err := navigateBrowserPage(context.Background(), srv.URL, "https://example.test/login?next=%2Fhome"); err != nil {
		t.Fatalf("navigate: %v", err)
	}
	mu.Lock()
	got := strings.Join(calls, "|")
	calls = nil
	pages = false
	mu.Unlock()
	if got != "shown Page.bringToFront |shown Page.navigate https://example.test/login?next=%2Fhome" {
		t.Fatalf("calls %q", got)
	}

	if err := navigateBrowserPage(context.Background(), srv.URL, "https://example.test/a b"); err != nil {
		t.Fatalf("navigate with no tab: %v", err)
	}
	mu.Lock()
	got = strings.Join(calls, "|")
	calls = nil
	mu.Unlock()
	if got != "PUT new https%3A%2F%2Fexample.test%2Fa%2520b" {
		t.Fatalf("calls %q", got)
	}

	for _, bad := range []string{"file:///etc/passwd", "javascript:alert(1)", "chrome://settings"} {
		if err := navigateBrowserPage(context.Background(), srv.URL, bad); err == nil || strings.Contains(err.Error(), bad) {
			t.Errorf("%s: %v, want a refusal that does not quote it", bad, err)
		}
	}
	if len(calls) != 0 {
		t.Fatalf("a refused page reached DevTools: %v", calls)
	}
}
