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

// shortenSessionWait makes a wait poll, and a release retry, in a millisecond for the test that calls it.
func shortenSessionWait(t *testing.T) {
	t.Helper()
	interval, retry := sessionWaitInterval, watchReleaseRetryInterval
	sessionWaitInterval, watchReleaseRetryInterval = time.Millisecond, time.Millisecond
	t.Cleanup(func() { sessionWaitInterval, watchReleaseRetryInterval = interval, retry })
}

// sessionWaitServer is the control plane one session_create(wait) talks to. It creates the child, records
// the watch, answers the child's polls with statuses and releases with outcomes, each in order with the
// last one repeating, and keeps every request it was sent.
type sessionWaitServer struct {
	t         *testing.T
	statuses  []string
	releases  []string
	watchCode int
	watchBody string
	// Cut the connection on every poll of the child, the way a control plane that went away does.
	dropPolls bool

	requests    []string
	watchBodies []map[string]interface{}
}

func (s *sessionWaitServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	request := r.Method + " " + r.URL.Path
	s.requests = append(s.requests, request)
	w.Header().Set("content-type", "application/json")
	switch request {
	case "POST /api/runner/sessions":
		_, _ = w.Write([]byte(`{"id":"child-session","status":"PENDING"}`))
	case "POST /api/runner/watches":
		var body map[string]interface{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		s.watchBodies = append(s.watchBodies, body)
		if s.watchCode != 0 {
			w.WriteHeader(s.watchCode)
			_, _ = w.Write([]byte(s.watchBody))
			return
		}
		_, _ = w.Write([]byte(`{"id":"watch-1","state":"ACTIVE"}`))
	case "GET /api/runner/sessions/child-session":
		if s.dropPolls {
			conn, _, err := w.(http.Hijacker).Hijack()
			if err != nil {
				s.t.Errorf("hijack: %v", err)
				return
			}
			_ = conn.Close()
			return
		}
		_, _ = w.Write([]byte(`{"id":"child-session","status":"` + nextScripted(&s.statuses) + `","result":"done"}`))
	case "POST /api/runner/watches/watch-1/release":
		_, _ = w.Write([]byte(`{"outcome":"` + nextScripted(&s.releases) + `"}`))
	default:
		s.t.Errorf("unexpected request %s", request)
		w.WriteHeader(http.StatusNotFound)
	}
}

func (s *sessionWaitServer) count(request string) int {
	n := 0
	for _, seen := range s.requests {
		if seen == request {
			n++
		}
	}
	return n
}

// nextScripted is the head of a script of answers; the last one keeps answering.
func nextScripted(script *[]string) string {
	head := (*script)[0]
	if len(*script) > 1 {
		*script = (*script)[1:]
	}
	return head
}

// runSessionCreateWait runs `orbit session create --wait --json` from inside an orchestrating session.
func runSessionCreateWait(t *testing.T, server *sessionWaitServer) (string, error) {
	t.Helper()
	srv := httptest.NewServer(server)
	t.Cleanup(srv.Close)
	configureCLITestRunner(t, srv.URL)
	t.Setenv(envMCPOrchestration, "true")
	t.Setenv("ORBIT_SESSION_ID", "caller-session")
	t.Setenv(envOrchestrationToken, "session-token")
	t.Setenv("ORBIT_AGENT_ID", "")
	t.Setenv("ORBIT_SERVICE_TOKEN", "")
	var out bytes.Buffer
	err := cmdSessionCLI([]string{"create", "--prompt", "work", "--wait", "--json"}, strings.NewReader(""), &out)
	return out.String(), err
}

type handedBackSession struct {
	ID     string           `json:"id"`
	Status string           `json:"status"`
	Watch  sessionWaitWatch `json:"watch"`
}

func decodeHandedBack(t *testing.T, out string) handedBackSession {
	t.Helper()
	var got handedBackSession
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("wait output is not JSON: %v\n%s", err, out)
	}
	return got
}

func TestSessionCreateWaitRecordsTheWatchBeforeItWaitsAndReleasesItWhenAnsweredInline(t *testing.T) {
	shortenSessionWait(t)
	server := &sessionWaitServer{t: t, statuses: []string{"RUNNING", "AWAITING_INPUT"}, releases: []string{"CANCELLED"}}
	out, err := runSessionCreateWait(t, server)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"POST /api/runner/sessions",
		"POST /api/runner/watches",
		"GET /api/runner/sessions/child-session",
		"GET /api/runner/sessions/child-session",
		"POST /api/runner/watches/watch-1/release",
	}
	if !reflect.DeepEqual(server.requests, want) {
		t.Fatalf("requests = %#v, want %#v", server.requests, want)
	}
	// The line session_create(wait) always waited for, a settled turn, now waking the calling session.
	wantWatch := map[string]interface{}{
		"predicateVersion": float64(1),
		"predicate":        map[string]interface{}{"kind": "ALL", "over": "ALL_TARGETS", "leaf": "SESSION_TURN_SETTLED"},
		"targets":          []interface{}{map[string]interface{}{"kind": "SESSION", "id": "child-session"}},
		"action":           "RESUME_SESSION",
		"idempotencyKey":   "session-create-wait:child-session",
	}
	if !reflect.DeepEqual(server.watchBodies[0], wantWatch) {
		t.Fatalf("watch = %#v, want %#v", server.watchBodies[0], wantWatch)
	}
	if want := "{\"id\":\"child-session\",\"status\":\"AWAITING_INPUT\",\"result\":\"done\"}\n"; out != want {
		t.Fatalf("an inline answer must print the session exactly as before: got %q, want %q", out, want)
	}
}

func TestSessionCreateWaitHandsBackTheWatchWhenItsTimeRunsOut(t *testing.T) {
	shortenSessionWait(t)
	t.Setenv(envSpawnDepth, "10")
	server := &sessionWaitServer{t: t, statuses: []string{"RUNNING"}}
	out, err := runSessionCreateWait(t, server)
	if err != nil {
		t.Fatal(err)
	}
	got := decodeHandedBack(t, out)
	if got.ID != "child-session" || got.Status != "RUNNING" {
		t.Fatalf("the session as last seen = %#v", got)
	}
	if got.Watch.ID != "watch-1" || got.Watch.HandedBack != "TIMEOUT" || got.Watch.Note == "" {
		t.Fatalf("watch = %#v, want watch-1 handed back on TIMEOUT with a note", got.Watch)
	}
	if polls := server.count("GET /api/runner/sessions/child-session"); polls != minSessionWaitPolls+1 {
		t.Fatalf("polls = %d, want the depth budget %d plus the final look", polls, minSessionWaitPolls+1)
	}
	// The watch is what keeps waiting, so nothing takes it back.
	if releases := server.count("POST /api/runner/watches/watch-1/release"); releases != 0 {
		t.Fatalf("a handed-back watch was released %d times", releases)
	}
}

func TestSessionCreateWaitHandsBackTheWatchWhenTheServerStopsAnswering(t *testing.T) {
	shortenSessionWait(t)
	server := &sessionWaitServer{t: t, dropPolls: true}
	out, err := runSessionCreateWait(t, server)
	// Before waits had watches this was an error, and the intent to be told went with it.
	if err != nil {
		t.Fatalf("a connection lost mid-wait must hand back the watch, not fail: %v", err)
	}
	got := decodeHandedBack(t, out)
	if got.ID != "child-session" || got.Status != "PENDING" {
		t.Fatalf("the session as last seen = %#v, want the created one", got)
	}
	if got.Watch.ID != "watch-1" || got.Watch.HandedBack != "TRANSPORT_ERROR" || got.Watch.Error == "" {
		t.Fatalf("watch = %#v, want watch-1 handed back on TRANSPORT_ERROR with the error", got.Watch)
	}
}

func TestSessionCreateWaitAsksAgainUntilTheWakeIsQueuedToWithdrawIt(t *testing.T) {
	shortenSessionWait(t)
	server := &sessionWaitServer{
		t:        t,
		statuses: []string{"SUCCEEDED"},
		releases: []string{"WAKE_NOT_QUEUED", "WAKE_NOT_QUEUED", "WAKE_WITHDRAWN"},
	}
	out, err := runSessionCreateWait(t, server)
	if err != nil {
		t.Fatal(err)
	}
	if releases := server.count("POST /api/runner/watches/watch-1/release"); releases != 3 {
		t.Fatalf("releases = %d, want two retries and the withdrawal", releases)
	}
	if want := "{\"id\":\"child-session\",\"status\":\"SUCCEEDED\",\"result\":\"done\"}\n"; out != want {
		t.Fatalf("output = %q, want the settled session alone", out)
	}
}

func TestSessionCreateWaitSaysSoWhenTheWakeCouldNotBeTakenBack(t *testing.T) {
	shortenSessionWait(t)
	attempts := watchReleaseAttempts
	watchReleaseAttempts = 3
	t.Cleanup(func() { watchReleaseAttempts = attempts })
	for _, outcome := range []string{"ALREADY_WOKEN", "WAKE_NOT_QUEUED"} {
		t.Run(outcome, func(t *testing.T) {
			server := &sessionWaitServer{t: t, statuses: []string{"SUCCEEDED"}, releases: []string{outcome}}
			out, err := runSessionCreateWait(t, server)
			if err != nil {
				t.Fatal(err)
			}
			got := decodeHandedBack(t, out)
			if got.Status != "SUCCEEDED" || got.Watch.ID != "watch-1" || got.Watch.Release != outcome || got.Watch.HandedBack != "" {
				t.Fatalf("output = %#v", got)
			}
			if !strings.Contains(got.Watch.Note, "already handled") {
				t.Fatalf("note does not say the late wake is already handled: %q", got.Watch.Note)
			}
			if outcome == "WAKE_NOT_QUEUED" && server.count("POST /api/runner/watches/watch-1/release") != 3 {
				t.Fatalf("a wake never queued was asked for %d times, want the 3 attempts", server.count("POST /api/runner/watches/watch-1/release"))
			}
		})
	}
}

func TestSessionCreateWaitAgainstAServerWithoutTheWatchDoorWaitsAsBefore(t *testing.T) {
	shortenSessionWait(t)
	server := &sessionWaitServer{
		t:         t,
		statuses:  []string{"SUCCEEDED"},
		watchCode: http.StatusNotFound,
		watchBody: `{"message":"Cannot POST /api/runner/watches","error":"Not Found","statusCode":404}`,
	}
	out, err := runSessionCreateWait(t, server)
	if err != nil {
		t.Fatal(err)
	}
	if want := "{\"id\":\"child-session\",\"status\":\"SUCCEEDED\",\"result\":\"done\"}\n"; out != want {
		t.Fatalf("output = %q, want %q", out, want)
	}
	if server.count("POST /api/runner/watches/watch-1/release") != 0 {
		t.Fatal("released a watch the server never made")
	}
}

func TestSessionWaitWithNoCallingSessionRecordsNoWatch(t *testing.T) {
	shortenSessionWait(t)
	server := &sessionWaitServer{t: t, statuses: []string{"SUCCEEDED"}}
	srv := httptest.NewServer(server)
	defer srv.Close()
	created := json.RawMessage(`{"id":"child-session","status":"PENDING"}`)
	wait, err := waitForSessionDurably(NewTransport(srv.URL, "service-token"), cliOrchestrationContext{}, created)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"GET /api/runner/sessions/child-session"}; !reflect.DeepEqual(server.requests, want) {
		t.Fatalf("requests = %#v, want %#v: a headless wait has no session a watch could wake", server.requests, want)
	}
	if wait.watch != nil || !wait.settled || string(wait.json()) != `{"id":"child-session","status":"SUCCEEDED","result":"done"}` {
		t.Fatalf("wait = %#v", wait)
	}
}

func TestMCPSessionCreateWaitTellsTheModelTheWaitIsNotLost(t *testing.T) {
	shortenSessionWait(t)
	t.Setenv(envSpawnDepth, "10")
	t.Setenv("ORBIT_HOME", t.TempDir())
	for _, tc := range []struct {
		name    string
		server  *sessionWaitServer
		phrases []string
	}{
		{
			name:    "handed back",
			server:  &sessionWaitServer{t: t, statuses: []string{"RUNNING"}},
			phrases: []string{"The wait is not lost", "watch watch-1", "End your turn now", `"handedBack": "TIMEOUT"`},
		},
		{
			name: "no watch door",
			server: &sessionWaitServer{
				t:         t,
				statuses:  []string{"RUNNING"},
				watchCode: http.StatusNotFound,
				watchBody: `{"message":"Cannot POST /api/runner/watches","error":"Not Found","statusCode":404}`,
			},
			phrases: []string{"this Orbit server predates watches", "session_await"},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(tc.server)
			defer srv.Close()
			mcp := &mcpServer{
				t:                  NewTransport(srv.URL, "runner-token"),
				sessionID:          "caller-session",
				orchestrationToken: "session-token",
				allowOrchestration: true,
			}
			result := mcp.callTool("session_create", map[string]interface{}{"prompt": "work", "wait": true})
			text := watchToolText(t, result)
			if result["isError"] == true {
				t.Fatalf("session_create(wait) failed: %s", text)
			}
			for _, phrase := range tc.phrases {
				if !strings.Contains(text, phrase) {
					t.Errorf("result does not say %q:\n%s", phrase, text)
				}
			}
		})
	}
}
