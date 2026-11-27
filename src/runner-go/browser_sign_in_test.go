package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// browser_request_sign_in (browser_tools.go; board docs/mocks/runner-browser/03-agent-tools.html ①, Q1 and Q2 = A).

// signInServer is the apiserver's half: the filing door, and the owner request the call reads until it is answered.
// answerAfter is how many reads of the card stay PENDING before it reads state.
type signInServer struct {
	mu          sync.Mutex
	srv         *httptest.Server
	filed       map[string]interface{}
	filedHeader string
	reads       int
	answerAfter int
	state       string
	note        string
	fileStatus  int
	fileBody    string
	// events is the order of what happened, with the lease's moves written in by fakeSignInLease.
	events *[]string
}

func newSignInServer(t *testing.T, events *[]string) *signInServer {
	t.Helper()
	s := &signInServer{state: "DONE", answerAfter: 2, fileStatus: http.StatusCreated, events: events}
	s.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/runner/browser/sign-in-requests":
			raw, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(raw, &s.filed)
			s.filedHeader = r.Header.Get("X-Orbit-Session-Id")
			*s.events = append(*s.events, "card filed")
			w.WriteHeader(s.fileStatus)
			if s.fileBody != "" {
				_, _ = w.Write([]byte(s.fileBody))
				return
			}
			_, _ = w.Write([]byte(`{"id":"REQ1","kind":"BROWSER_SIGN_IN","state":"PENDING","title":"Sign in to github.com","browserSite":"github.com","created":true}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/runner/owner-requests/REQ1":
			s.reads++
			state := "PENDING"
			if s.reads > s.answerAfter {
				state = s.state
				*s.events = append(*s.events, "owner answered "+state)
			} else {
				*s.events = append(*s.events, "card read PENDING")
			}
			body := map[string]interface{}{"id": "REQ1", "state": state, "browserSite": "github.com"}
			if s.note != "" && state != "PENDING" {
				body["resolutionNote"] = s.note
			}
			_ = json.NewEncoder(w).Encode(body)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(s.srv.Close)
	return s
}

// fakeSignInLease records the lease's moves beside the server's events, over a real supervisor.
type fakeSignInLease struct {
	b       *browserSupervisor
	session string
	events  *[]string
}

func (l fakeSignInLease) yield() (bool, error) {
	held, err := l.b.YieldForSignIn(l.session, "")
	if err == nil {
		*l.events = append(*l.events, "lease released")
	}
	return held, err
}

func (l fakeSignInLease) end(retake bool) error {
	err := l.b.EndSignIn(l.session, "", retake)
	if err == nil && retake {
		*l.events = append(*l.events, "lease taken back")
	}
	return err
}

func TestBrowserSignInListedOnlyOnTheOrbitCloudRunnerWithTheSwitchOn(t *testing.T) {
	cases := []struct {
		browser, generation string
		want                bool
	}{
		{"on", "3", true},
		{"on", "", false},   // a self-managed runner: no Orbit Cloud browser to sign in to
		{"off", "3", false}, // the switch off: every browser tool absent
		{"", "", false},
	}
	for _, c := range cases {
		t.Setenv(envBrowser, c.browser)
		t.Setenv(envManagedRunnerGeneration, c.generation)
		s := &mcpServer{sessionID: "s", browserOn: browserToolsEnabledFromEnv()}
		if got := listsTool(s, browserRequestSignInTool); got != c.want {
			t.Errorf("ORBIT_BROWSER=%q generation=%q: listed = %v, want %v", c.browser, c.generation, got, c.want)
		}
		if c.browser == "on" && !listsTool(s, "browser_status") {
			t.Errorf("generation=%q: browser_status is not listed beside it (Q3 = A: any session)", c.generation)
		}
		if got := browserOpAbsent(operationCatalog().ByTool[browserRequestSignInTool]); got == c.want {
			t.Errorf("ORBIT_BROWSER=%q generation=%q: catalogue absent = %v", c.browser, c.generation, got)
		}
	}
}

func TestBrowserSignInCommandOnlyOnTheOrbitCloudRunner(t *testing.T) {
	catalogFullestCLIContext(t)
	t.Setenv(envBrowser, "on")
	t.Setenv(envManagedRunnerGeneration, "3")
	if offered, code := offersCommand(t, browserRequestSignInTool); !offered {
		t.Fatalf("Orbit Cloud runner: request-sign-in not offered (%s)", code)
	}
	var help bytes.Buffer
	if err := runOrbitCLI([]string{"browser", "request-sign-in", "--help"}, strings.NewReader(""), &help, &bytes.Buffer{}); err != nil ||
		!strings.Contains(help.String(), "--site HOST --reason TEXT") {
		t.Fatalf("help = %v %q", err, help.String())
	}
	t.Setenv(envManagedRunnerGeneration, "")
	if offered, code := offersCommand(t, browserRequestSignInTool); offered || code != "" {
		t.Fatalf("another runner: request-sign-in offered=%v code=%q, want in neither list", offered, code)
	}
	if offered, _ := offersCommand(t, "browser_status"); !offered {
		t.Fatal("another runner: browser_status went with it")
	}
	err := runOrbitCLI([]string{"browser", "request-sign-in", "--site", "github.com", "--reason", "r"}, strings.NewReader(""), &bytes.Buffer{}, &bytes.Buffer{})
	if err == nil || !strings.Contains(err.Error(), `unknown command "request-sign-in"`) {
		t.Fatalf("another runner: the command = %v, want unknown", err)
	}
}

// A session not on the Orbit Cloud runner that calls the tool anyway is refused before anything is filed; and if the
// runner's environment says managed but the server knows better, the server's 403 is the answer and the session takes
// its lease back.
func TestBrowserSignInRefusedOffTheOrbitCloudRunner(t *testing.T) {
	var events []string
	srv := newSignInServer(t, &events)
	t.Setenv(envManagedRunnerGeneration, "")
	s := &mcpServer{t: NewTransport(srv.srv.URL, "tok"), sessionID: "sess-a", browserOn: true}
	res := s.callTool(browserRequestSignInTool, map[string]interface{}{"site": "github.com", "reason": "r"})
	if res["isError"] != true || !strings.Contains(toolText(t, res), "only for sessions on the account's Orbit Cloud runner") {
		t.Fatalf("off the Orbit Cloud runner: %#v", res)
	}
	if srv.filed != nil {
		t.Fatal("a refused call filed a card")
	}

	r := newBrowserRig(t)
	_ = r.b.Acquire("sess-a", "")
	srv.fileStatus = http.StatusForbidden
	srv.fileBody = `{"code":"BROWSER_SIGN_IN_NOT_ORBIT_CLOUD","message":"browser_request_sign_in is only for sessions on the account's Orbit Cloud runner","statusCode":403}`
	_, err := runBrowserRequestSignIn(NewTransport(srv.srv.URL, "tok"), "sess-a", "github.com", "r",
		fakeSignInLease{b: r.b, session: "sess-a", events: &events}, time.Millisecond)
	if err == nil || !strings.Contains(err.Error(), "BROWSER_SIGN_IN_NOT_ORBIT_CLOUD") {
		t.Fatalf("the server's refusal = %v", err)
	}
	if r.b.Holder() != "sess-a" || r.b.SignInWaiting() != "" {
		t.Fatalf("after a refused filing: holder %q, waiting %q; want the lease back and no wait", r.b.Holder(), r.b.SignInWaiting())
	}
}

// The call waits for the owner's answer (Q1 = A), with the lease released from before the card is filed until after
// the answer (Q2 = A), and returns which answer it was.
func TestBrowserSignInWaitsForTheAnswerWithTheLeaseReleased(t *testing.T) {
	for _, c := range []struct{ state, note, answer, says string }{
		{"DONE", "", "SIGNED_IN", "The owner signed in to github.com"},
		{"DECLINED", "Not now", "NOT_NOW", "Decide your next step"},
	} {
		t.Run(c.answer, func(t *testing.T) {
			var events []string
			srv := newSignInServer(t, &events)
			srv.state, srv.note = c.state, c.note
			r := newBrowserRig(t)
			if err := r.b.Acquire("sess-a", "Export the monthly report"); err != nil {
				t.Fatal(err)
			}
			started := len(r.starter.started)
			lease := fakeSignInLease{b: r.b, session: "sess-a", events: &events}
			// While the call waits, another call of the asker's (or anyone's) is refused, and nobody holds the lease.
			var duringWait []string
			out, err := runBrowserRequestSignIn(NewTransport(srv.srv.URL, "tok"), "sess-a", "https://github.com/login",
				"Sign in to the account that owns acme/billing, so I can export the report.",
				probingLease{fakeSignInLease: lease, probe: func() {
					duringWait = append(duringWait, "holder="+r.b.Holder())
					if err := r.b.Acquire("sess-a", ""); err != nil {
						duringWait = append(duringWait, "asker refused")
					}
				}}, time.Millisecond)
			if err != nil {
				t.Fatal(err)
			}
			want := []string{"lease released", "card filed", "card read PENDING", "card read PENDING", "owner answered " + c.state, "lease taken back"}
			if strings.Join(events, " | ") != strings.Join(want, " | ") {
				t.Fatalf("events:\n  %s\nwant\n  %s", strings.Join(events, " | "), strings.Join(want, " | "))
			}
			if strings.Join(duringWait, ",") != "holder=,asker refused" {
				t.Fatalf("during the wait: %v; want no holder and the asker's own call refused", duringWait)
			}
			if out.Answer != c.answer || !strings.Contains(out.Message, c.says) || out.RequestID != "REQ1" || out.Site != "github.com" ||
				!out.LeaseReleased || !out.LeaseRetaken {
				t.Fatalf("result = %#v", out)
			}
			if r.b.Holder() != "sess-a" || len(r.starter.started) != started {
				t.Fatal("after the answer the asker does not hold the same browser (its page) again")
			}
			// Only the site and the reason are sent; nothing of the page.
			if srv.filedHeader != "sess-a" || srv.filed["site"] != "https://github.com/login" ||
				srv.filed["reason"] != "Sign in to the account that owns acme/billing, so I can export the report." {
				t.Fatalf("filed %#v as %q", srv.filed, srv.filedHeader)
			}
			for k := range srv.filed {
				if k != "site" && k != "reason" && k != "clientRequestId" {
					t.Errorf("the filing carries %q", k)
				}
			}
		})
	}
}

// probingLease runs probe once the lease is released, i.e. while the owner is being asked.
type probingLease struct {
	fakeSignInLease
	probe func()
}

func (l probingLease) yield() (bool, error) {
	held, err := l.fakeSignInLease.yield()
	if err == nil {
		l.probe()
	}
	return held, err
}

func TestBrowserSignInToolResultAndArguments(t *testing.T) {
	t.Setenv(envManagedRunnerGeneration, "3")
	s := &mcpServer{sessionID: "sess-a", browserOn: true}
	for _, args := range []map[string]interface{}{{"reason": "r"}, {"site": "github.com"}, {"site": " ", "reason": "r"}} {
		if res := s.callTool(browserRequestSignInTool, args); res["isError"] != true {
			t.Errorf("%v: not refused", args)
		}
	}
	if _, err := runBrowserRequestSignIn(nil, "", "github.com", "r", nil, time.Millisecond); err == nil ||
		!strings.Contains(err.Error(), "ORBIT_SESSION_ID") {
		t.Fatalf("outside a session: %v", err)
	}
	// An engine with its own call deadline hands the wait to a runner-hosted job, as for every owner wait.
	if !waitsForTheOwner(browserRequestSignInTool, nil) {
		t.Fatal("browser_request_sign_in is not a call that waits for the owner")
	}
}
