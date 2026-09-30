package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// The wiki door's retry (wiki_retry.go), against fake doors and a transport that fails the way a deploy
// window and the edge fail a runner: the gateway answering 502 in the server's place, and an answer lost on
// its way back after the server took the request — a connection cut (EOF), or the HTTP/2 stream the edge
// reset. The backoff waits on a clock of the test's own.

// ── The clock ───────────────────────────────────────────────────────────────────────────────────

// fakeWikiRetry is a clock that moves only when a call waits, and the lines the calls wrote as they waited.
type fakeWikiRetry struct {
	mu    sync.Mutex
	now   time.Time
	waits []time.Duration
	log   strings.Builder
}

// withFakeWikiRetry gives the wiki calls the production backoff on the fake clock, without jitter.
func withFakeWikiRetry(t *testing.T) *fakeWikiRetry {
	t.Helper()
	f := &fakeWikiRetry{now: time.Date(2026, 9, 29, 14, 33, 0, 0, time.UTC)}
	previous := wikiRetry
	wikiRetry = wikiRetryPolicy{first: previous.first, max: previous.max, budget: previous.budget, now: f.clock, sleep: f.sleep,
		jitter: func(d time.Duration) time.Duration { return d }, log: f}
	t.Cleanup(func() { wikiRetry = previous })
	return f
}

func (f *fakeWikiRetry) clock() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.now
}

func (f *fakeWikiRetry) sleep(d time.Duration) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.waits = append(f.waits, d)
	f.now = f.now.Add(d)
}

func (f *fakeWikiRetry) Write(p []byte) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.log.Write(p)
}

func (f *fakeWikiRetry) waited() []time.Duration {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]time.Duration{}, f.waits...)
}

func (f *fakeWikiRetry) lines() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, line := range strings.Split(f.log.String(), "\n") {
		if line != "" {
			out = append(out, line)
		}
	}
	return out
}

// ── The failures ────────────────────────────────────────────────────────────────────────────────

// wikiFault is what one send of a call meets. A status is the gateway's answer in the server's place: the
// request never reaches the server. lost is what the send meets on its way back after the server took the
// request and answered it: the answer never reaches the caller.
type wikiFault struct {
	status     int
	retryAfter string
	lost       error
}

var (
	// wikiAnswerCut is the connection cut before the answer came back.
	wikiAnswerCut = io.EOF
	// wikiStreamReset is the edge resetting the stream, word for word as the runner's net/http (go1.27.1) said
	// it on 09-29 for POST …/articles/ui-design. net/http keeps the error's type to itself — and the toolchain
	// these tests build with retries a peer's PROTOCOL_ERROR inside its own transport — so it is handed over by
	// its words, where a client's transport returns it.
	wikiStreamReset = errors.New("stream error: stream ID 1; PROTOCOL_ERROR; received from peer")
)

// flakyWikiTransport stands where http.DefaultTransport does, between the calls of a test and its fake door:
// the sends of each route it has a plan for meet their faults in order, and everything else goes through.
type flakyWikiTransport struct {
	next  http.RoundTripper
	mu    sync.Mutex
	plan  map[string][]wikiFault
	sends map[string]int
}

func withFlakyWikiTransport(t *testing.T, plan map[string][]wikiFault) *flakyWikiTransport {
	t.Helper()
	f := &flakyWikiTransport{next: http.DefaultTransport, plan: plan, sends: map[string]int{}}
	http.DefaultTransport = f
	t.Cleanup(func() { http.DefaultTransport = f.next })
	return f
}

// wikiRoute is a request as a plan names it: its method and its path inside the space (or its whole path),
// and " (dry run)" for a proposal that only checks.
func wikiRoute(r *http.Request) string {
	route := r.Method + " " + strings.TrimPrefix(r.URL.Path, "/api/runner/wiki/spaces/space-1/")
	if r.Body == nil {
		return route
	}
	raw, _ := io.ReadAll(r.Body)
	_ = r.Body.Close()
	r.Body = io.NopCloser(bytes.NewReader(raw))
	var body struct {
		DryRun bool `json:"dryRun"`
	}
	if json.Unmarshal(raw, &body) == nil && body.DryRun {
		route += " (dry run)"
	}
	return route
}

func (f *flakyWikiTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	route := wikiRoute(r)
	f.mu.Lock()
	f.sends[route]++
	var fault wikiFault
	if faults := f.plan[route]; f.sends[route] <= len(faults) {
		fault = faults[f.sends[route]-1]
	}
	f.mu.Unlock()
	if fault.status != 0 {
		if r.Body != nil {
			_ = r.Body.Close()
		}
		body := fmt.Sprintf("error code: %d", fault.status)
		header := http.Header{"Content-Type": {"text/plain; charset=UTF-8"}}
		if fault.retryAfter != "" {
			header.Set("Retry-After", fault.retryAfter)
		}
		return &http.Response{Status: fmt.Sprintf("%d %s", fault.status, http.StatusText(fault.status)), StatusCode: fault.status,
			Proto: "HTTP/1.1", ProtoMajor: 1, ProtoMinor: 1, Header: header, Body: io.NopCloser(strings.NewReader(body)),
			ContentLength: int64(len(body)), Request: r}, nil
	}
	resp, err := f.next.RoundTrip(r)
	if err != nil || fault.lost == nil {
		return resp, err
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
	return nil, fault.lost
}

func (f *flakyWikiTransport) sent(route string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.sends[route]
}

// faults is n of the same fault: a failure that does not clear.
func faults(n int, fault wikiFault) []wikiFault {
	out := make([]wikiFault, n)
	for i := range out {
		out[i] = fault
	}
	return out
}

// retryDoor is a door that answers each send with what answer says for it (the first send is 1), and counts them.
func retryDoor(t *testing.T, answer func(send int) (status int, retryAfter, body string)) (*Transport, func() int) {
	t.Helper()
	var mu sync.Mutex
	sends := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		sends++
		n := sends
		mu.Unlock()
		status, retryAfter, body := answer(n)
		if retryAfter != "" {
			w.Header().Set("Retry-After", retryAfter)
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return NewTransport(srv.URL, "runner-token"), func() int {
		mu.Lock()
		defer mu.Unlock()
		return sends
	}
}

// ── A run through a deploy window ───────────────────────────────────────────────────────────────

// 09-29, both runs at once: a page whose answer was cut, the proposal whose answer the edge's reset stream
// took, and the 502s of a deploy on the verdicts and on the run's end. Each call is sent again, the run
// goes on to the end and advances the cursor, and the proposal — which landed twice — is recorded once.
func TestWikiRetryCarriesAMaintenanceRunThroughA502AndAProtocolError(t *testing.T) {
	f := newMaintainFixture(t)
	door := newFakeMaintainDoor(t)
	door.context = maintainContext(f, "automatic", 0, "tok-expect")
	door.pages[""] = maintainPage("tok-1", true, portDossier("session-a"), werewolfDossier("session-b"))
	door.pages["tok-1"] = maintainPage("tok-expect", false)
	door.propose = pendingForVerification
	door.verifications = `{"spaceId":"space-1","mode":"automatic","items":[` +
		`{"opId":"op-0","op":"add","entryId":"e-0","entry":{"kind":"convention","title":"fixture 不写死端口","summary":"s","fields":{}},"sources":[{"kind":"turn","ref":"turn-1","quote":"以后 fixture 里不要写死端口","text":"以后 fixture 里不要写死端口，一律从 fixture 的返回值里取。","truncated":false}],"similar":[]},` +
		`{"opId":"op-1","op":"add","entryId":"e-1","entry":{"kind":"pitfall","title":"PORT","summary":"s","fields":{}},"sources":[{"kind":"tool_call","ref":"call-2","quote":null,"text":"connect ECONNREFUSED 127.0.0.1:9000","truncated":false}],"similar":[]}` +
		`],"next":""}`
	vllm := newFakeVLLM(t, extractorAnswers)
	fakeVerifyClaude(t)
	wikiMaintainSession(t, door.URL, vllm)
	clock := withFakeWikiRetry(t)
	flaky := withFlakyWikiTransport(t, map[string][]wikiFault{
		"GET dossiers":                {{lost: wikiAnswerCut}},
		"POST maintenance/changesets": {{lost: wikiStreamReset}},
		"POST verifications":          {{status: http.StatusBadGateway}},
		"POST maintenance/finish":     {{status: http.StatusBadGateway}},
	})

	summary, err := runMaintainCLI(t)
	if err != nil {
		t.Fatalf("orbit wiki maintain through a deploy window: %v\n%+v\n%s", err, summary, strings.Join(clock.lines(), "\n"))
	}
	if summary.Outcome != "succeeded" || !summary.Advanced || summary.Cursor != "tok-expect" {
		t.Errorf("summary = %+v, want a run that succeeded and advanced the cursor", summary)
	}
	r := summary.Report
	if r.Ops.Recorded != 2 || r.Ops.Refused != 0 || r.Verification == nil || r.Verification.Verified != 2 {
		t.Errorf("ops %+v, verification %+v: want both ops recorded and verified", r.Ops, r.Verification)
	}

	// The proposal landed twice, both times under one key: the server keeps one changeset per key, and
	// answers the second landing with what the first recorded.
	var landed []string
	for _, proposal := range door.of(http.MethodPost, "maintenance/changesets") {
		if proposal.body["dryRun"] != true {
			key, _ := proposal.body["idempotencyKey"].(string)
			landed = append(landed, key)
		}
	}
	if len(landed) != 2 || landed[0] == "" || landed[0] != landed[1] {
		t.Errorf("the proposal landed under keys %q: want twice under one key, which the server records once", landed)
	}
	// The 502s were the gateway's: those sends never reached the server, and each call landed once.
	if got := len(door.of(http.MethodPost, "verifications")); got != 2 || flaky.sent("POST verifications") != 3 {
		t.Errorf("the verdicts landed %d times over %d sends: want one each, the first send met the 502", got, flaky.sent("POST verifications"))
	}
	if end := finished(t, door); end["outcome"] != "succeeded" || end["to"] != "tok-expect" {
		t.Errorf("the run ended %v", end)
	}
	if got := len(door.of(http.MethodGet, "dossiers")); got != 3 {
		t.Errorf("the pages were read %d times: want the cut one twice and the next once", got)
	}

	// One line a retry: the method, the path, why, and which retry — each after the first wait, 2 seconds.
	lines := clock.lines()
	want := [][]string{
		{"GET /runner/wiki/spaces/space-1/dossiers?", "(EOF)", "retry 1 in 2s"},
		{"POST /runner/wiki/spaces/space-1/maintenance/changesets", "(stream error: stream ID 1; PROTOCOL_ERROR; received from peer)", "retry 1 in 2s"},
		{"POST /runner/wiki/spaces/space-1/verifications", "(502 Bad Gateway)", "retry 1 in 2s"},
		{"POST /runner/wiki/spaces/space-1/maintenance/finish", "(502 Bad Gateway)", "retry 1 in 2s"},
	}
	if len(lines) != len(want) {
		t.Fatalf("the retries said:\n%s\nwant %d lines", strings.Join(lines, "\n"), len(want))
	}
	for i, words := range want {
		for _, word := range words {
			if !strings.HasPrefix(lines[i], "orbit wiki: ") || !strings.Contains(lines[i], word) {
				t.Errorf("retry line %d = %q, want it to say %q", i+1, lines[i], word)
			}
		}
	}
	if waits := clock.waited(); !reflect.DeepEqual(waits, []time.Duration{2 * time.Second, 2 * time.Second, 2 * time.Second, 2 * time.Second}) {
		t.Errorf("waits = %v", waits)
	}
}

// 09-29's first run: the edge reset the stream of POST …/articles/ui-design after the server had written
// it. The write is sent again, the server finds the articles it holds written from the same entries and
// writes nothing, and no topic is left unwritten.
func TestWikiRetryWritesAnArticleWhoseStreamTheEdgeReset(t *testing.T) {
	door := newFakeArticlesDoor(t, []map[string]interface{}{planTopic("ui-design", 3, true)},
		map[string]map[string]interface{}{"ui-design": topicInput("ui-design", smallTopic("ui-design", 3))})
	// The server's rule: a topic's articles are stored once per entry set, and the same set again is unchanged.
	stored, written := map[string]string{}, 0
	door.answer = func(slug string, body wikiArticleWrite) (int, string) {
		if stored[slug] == body.EntrySetSha256 {
			return http.StatusOK, `{"spaceId":"space-1","slug":"` + slug + `","written":false,"unchanged":true,"reason":null,"parts":[],"stats":{}}`
		}
		stored[slug] = body.EntrySetSha256
		written++
		return http.StatusOK, ""
	}
	vllm := newFakeVLLM(t, articleAnswers)
	fakeVerifyClaude(t)
	wikiArticlesSession(t, door.URL, vllm)
	clock := withFakeWikiRetry(t)
	flaky := withFlakyWikiTransport(t, map[string][]wikiFault{"POST articles/ui-design": {{lost: wikiStreamReset}}})

	var out strings.Builder
	if err := cmdWikiCLI([]string{"articles", "--space", "space-1"}, strings.NewReader(""), &out); err != nil {
		t.Fatalf("orbit wiki articles: %v\n%s", err, out.String())
	}
	door.mu.Lock()
	writes := written
	door.mu.Unlock()
	if flaky.sent("POST articles/ui-design") != 2 || writes != 1 {
		t.Errorf("the write was sent %d times and written %d: want twice, and written once", flaky.sent("POST articles/ui-design"), writes)
	}
	if strings.Contains(out.String(), "not written") {
		t.Errorf("a topic was left unwritten: %s", out.String())
	}
	if lines := clock.lines(); len(lines) != 1 || !strings.Contains(lines[0], "POST /runner/wiki/spaces/space-1/articles/ui-design failed (stream error: stream ID 1; PROTOCOL_ERROR; received from peer); retry 1 in 2s") {
		t.Errorf("the retry said %q", lines)
	}
}

// ── The budget ──────────────────────────────────────────────────────────────────────────────────

// A failure that does not clear is sent again from 2 seconds, doubling to 30, for 5 minutes — a retry only
// while the budget has time left for it after its wait — and then comes back to the caller exactly as the
// transport returned it: the caller fails as it did before.
func TestWikiRetryGivesUpOnceTheBudgetIsSpentWithTheOriginalError(t *testing.T) {
	tr, sends := retryDoor(t, func(int) (int, string, string) { return http.StatusBadGateway, "", "error code: 502" })
	clock := withFakeWikiRetry(t)
	_, err := tr.writeWikiArticles("maintenance-session", "space-1", "ui-design", map[string]interface{}{"entrySetSha256": "sha"})
	var httpErr *transportHTTPError
	if !errors.As(err, &httpErr) || httpErr.statusCode != http.StatusBadGateway ||
		err.Error() != "POST /runner/wiki/spaces/space-1/articles/ui-design -> 502 error code: 502" {
		t.Fatalf("after the budget = %v, want the 502 as the transport returned it", err)
	}
	waits := clock.waited()
	want := []time.Duration{2 * time.Second, 4 * time.Second, 8 * time.Second, 16 * time.Second}
	for len(want) < 12 {
		want = append(want, 30*time.Second)
	}
	var total time.Duration
	for _, wait := range waits {
		total += wait
	}
	// The thirteenth send fails with 30 seconds of the budget left, which the next wait would take whole.
	if !reflect.DeepEqual(waits, want) || total != 4*time.Minute+30*time.Second || sends() != 13 {
		t.Errorf("waited %v (%s in all) over %d sends: want %v, 4m30s, 13 sends", waits, total, sends(), want)
	}
	lines := clock.lines()
	if len(lines) != 13 || !strings.Contains(lines[11], "retry 12 in 30s, 1m0s of the 5m0s budget left") ||
		lines[12] != "orbit wiki: POST /runner/wiki/spaces/space-1/articles/ui-design failed (502 Bad Gateway) on send 13; the 5m0s retry budget is spent, so the failure stands" {
		t.Errorf("the retries said:\n%s", strings.Join(lines, "\n"))
	}

	// A reset that does not clear either: the caller gets the transport's own error, and can still read it.
	withFakeWikiRetry(t)
	withFlakyWikiTransport(t, map[string][]wikiFault{"GET maintenance/run": faults(20, wikiFault{lost: wikiStreamReset})})
	door := newFakeMaintainDoor(t)
	_, err = NewTransport(door.URL, "runner-token").wikiMaintainRunContext("maintenance-session", "space-1")
	var urlErr *url.Error
	if !errors.As(err, &urlErr) || !errors.Is(err, wikiStreamReset) {
		t.Errorf("after the budget = %#v, want the transport's own error", err)
	}

	// And a command fails as it did before, only later: the topic is left unwritten, saying why.
	articles := newFakeArticlesDoor(t, []map[string]interface{}{planTopic("ui-design", 3, true)},
		map[string]map[string]interface{}{"ui-design": topicInput("ui-design", smallTopic("ui-design", 3))})
	fakeVerifyClaude(t)
	wikiArticlesSession(t, articles.URL, newFakeVLLM(t, articleAnswers))
	withFakeWikiRetry(t)
	withFlakyWikiTransport(t, map[string][]wikiFault{"POST articles/ui-design": faults(20, wikiFault{status: http.StatusBadGateway})})
	var out strings.Builder
	err = cmdWikiCLI([]string{"articles", "--space", "space-1"}, strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "1 topic was left unwritten") ||
		!strings.Contains(out.String(), "topic ui-design: not written — orbit wiki articles: POST /runner/wiki/spaces/space-1/articles/ui-design -> 502 error code: 502") {
		t.Errorf("a write the budget gave up on = %v\n%s", err, out.String())
	}
}

// ── What is never sent again ────────────────────────────────────────────────────────────────────

// A 4xx is the server's answer to the request, and so is a 500: sent once, and handed back as it came — a
// 429 among them when it does not say when to come back, which is what the door's own quota refusals are.
func TestWikiRetryNeverResendsA4xx(t *testing.T) {
	for _, status := range []int{http.StatusBadRequest, http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound,
		http.StatusConflict, http.StatusUnprocessableEntity, http.StatusTooManyRequests, http.StatusInternalServerError} {
		body := fmt.Sprintf(`{"code":"WIKI_TEST","message":"answered %d"}`, status)
		tr, sends := retryDoor(t, func(int) (int, string, string) { return status, "", body })
		clock := withFakeWikiRetry(t)
		for _, call := range []func() error{
			func() error { _, err := tr.wikiMaintainRunContext("maintenance-session", "space-1"); return err },
			func() error {
				_, err := tr.writeWikiArticles("maintenance-session", "space-1", "ui-design", map[string]interface{}{"entrySetSha256": "sha"})
				return err
			},
		} {
			err := call()
			var httpErr *transportHTTPError
			if !errors.As(err, &httpErr) || httpErr.statusCode != status || httpErr.body != body {
				t.Errorf("%d = %v, want it handed back as it came", status, err)
			}
		}
		if sends() != 2 || len(clock.waited()) != 0 || len(clock.lines()) != 0 {
			t.Errorf("%d: %d sends of two calls, waits %v, lines %q: want each sent once", status, sends(), clock.waited(), clock.lines())
		}
	}
}

// A 429 that says when to come back is sent again then — not at the backoff's 2 seconds — and one that asks
// for more than the budget has left is not sent again at all.
func TestWikiRetryWaitsWhatRetryAfterSays(t *testing.T) {
	clock := withFakeWikiRetry(t)
	later := clock.clock().Add(45 * time.Second).Format(http.TimeFormat)
	for _, c := range []struct {
		retryAfter string
		wait       time.Duration
	}{{"7", 7 * time.Second}, {later, 45 * time.Second}, {"0", time.Second}} {
		clock := withFakeWikiRetry(t)
		tr, sends := retryDoor(t, func(n int) (int, string, string) {
			if n == 1 {
				return http.StatusTooManyRequests, c.retryAfter, `{"message":"slow down"}`
			}
			return http.StatusOK, "", `{"spaceId":"space-1"}`
		})
		if _, err := tr.wikiMaintainRunContext("maintenance-session", "space-1"); err != nil {
			t.Fatalf("Retry-After %s: %v", c.retryAfter, err)
		}
		lines := clock.lines()
		if sends() != 2 || !reflect.DeepEqual(clock.waited(), []time.Duration{c.wait}) || len(lines) != 1 ||
			!strings.Contains(lines[0], "(429 Too Many Requests, Retry-After "+c.retryAfter+"); retry 1 in "+c.wait.String()) {
			t.Errorf("Retry-After %s: %d sends, waits %v, lines %q: want one wait of %s", c.retryAfter, sends(), clock.waited(), lines, c.wait)
		}
	}

	clock = withFakeWikiRetry(t)
	tr, sends := retryDoor(t, func(int) (int, string, string) {
		return http.StatusTooManyRequests, "600", `{"message":"come back later"}`
	})
	_, err := tr.wikiMaintainRunContext("maintenance-session", "space-1")
	if !isTransportHTTPStatus(err, http.StatusTooManyRequests) || sends() != 1 || len(clock.waited()) != 0 {
		t.Errorf("Retry-After past the budget = %v after %d sends and waits %v: want the 429 at once", err, sends(), clock.waited())
	}
	if lines := clock.lines(); len(lines) != 1 || !strings.Contains(lines[0], "the 5m0s retry budget is spent") {
		t.Errorf("lines = %q", lines)
	}
}

// ── Only what may land twice ────────────────────────────────────────────────────────────────────

// wikiLedger is a door that keeps what each landing records by the rule the server records it by — so the
// same request landing twice records once where the server's rule says so — and counts the landings.
type wikiLedger struct {
	mu       sync.Mutex
	landings map[string]int
	effects  map[string]bool
}

func newWikiLedger(t *testing.T) (*wikiLedger, string) {
	t.Helper()
	l := &wikiLedger{landings: map[string]int{}, effects: map[string]bool{}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &body)
		route := r.Method + " " + strings.TrimPrefix(r.URL.Path, "/api/runner/wiki/spaces/space-1/")
		l.mu.Lock()
		l.landings[route]++
		if effect := wikiEffectOf(route, body, l.landings[route]); effect != "" {
			l.effects[effect] = true
		}
		l.mu.Unlock()
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"recorded":true}`))
	}))
	t.Cleanup(srv.Close)
	return l, srv.URL
}

// wikiEffectOf is what a landing records, named as the server's rule for the route names it — so that what
// the rule records once is one name however often it lands — or "" for a landing that records nothing.
func wikiEffectOf(route string, body map[string]interface{}, landing int) string {
	str := func(key string) string { s, _ := body[key].(string); return s }
	once := func(parts ...string) string { return route + " " + strings.Join(parts, " ") }
	each := func() string { return fmt.Sprintf("%s, landing %d", route, landing) }
	switch {
	case body["dryRun"] == true:
		return "" // a dry run records nothing
	case strings.HasSuffix(route, "changesets") || strings.HasSuffix(route, "imports"):
		if key := str("idempotencyKey"); key != "" {
			return once(key) // UNIQUE (owner_id, idempotency_key): a second landing is answered from the first
		}
		return each() // with no key, each landing is another changeset
	case strings.HasSuffix(route, "plan/drafts"):
		if key := str("idempotencyKey"); key != "" {
			return once(key) // UNIQUE (owner_id, idempotency_key): a second landing is answered with the version the first stored
		}
		return each() // with no key, a second landing is WIKI_PLAN_STALE, its base no longer the newest
	case strings.HasSuffix(route, "verifications"):
		verdicts, _ := body["verdicts"].([]interface{})
		verdict, _ := verdicts[0].(map[string]interface{})
		return once(fmt.Sprint(verdict["opId"]), fmt.Sprint(verdict["verdict"])) // recorded while the op still waits
	case strings.HasSuffix(route, "notes"):
		return once(str("text")) // UNIQUE (space_id, content_sha256)
	case strings.HasPrefix(route, "POST articles/"):
		return once(str("entrySetSha256")) // replaced whole, and only from another entry set
	case strings.HasSuffix(route, "anchor-checks"):
		return once(str("ref")) // anchors set to what was found; a challenge only while none is open
	case strings.HasSuffix(route, "article-plan"):
		return once() // the default topics, for a space with none
	case strings.HasSuffix(route, "cursor") || strings.HasSuffix(route, "maintenance/finish"):
		if outcome := str("outcome"); outcome != "" && outcome != "succeeded" {
			return each() // one more consecutive failure each time it lands
		}
		return once(str("to")) // a cursor that stands at the token already moves nothing
	}
	return each()
}

func (l *wikiLedger) counts() (landings, effects int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, n := range l.landings {
		landings += n
	}
	return landings, len(l.effects)
}

// Every write lands once, and its answer is cut on the way back. The ones the server records at most once
// are sent again, and record once; the rest — a failed or truncated run's report, a proposal or a plan draft
// with no key — are sent once, and their failure is the caller's, as before.
func TestWikiRetryResendsOnlyTheWritesTheServerRecordsOnce(t *testing.T) {
	proposal := func(extra map[string]interface{}) map[string]interface{} {
		body := map[string]interface{}{"ops": []interface{}{map[string]interface{}{"op": "add"}}, "rationale": "why"}
		for k, v := range extra {
			body[k] = v
		}
		return body
	}
	for _, c := range []struct {
		name, route string
		// resent is whether the call is sent again, and records what landing twice records then.
		resent  bool
		records int
		call    func(tr *Transport) error
	}{
		{"a proposal under a key", "POST /api/runner/wiki/changesets", true, 1, func(tr *Transport) error {
			_, err := tr.proposeWikiChangeset("s", proposal(map[string]interface{}{"idempotencyKey": "k-1"}))
			return err
		}},
		{"a dry run", "POST /api/runner/wiki/changesets (dry run)", true, 0, func(tr *Transport) error {
			_, err := tr.proposeWikiChangeset("s", proposal(map[string]interface{}{"dryRun": true}))
			return err
		}},
		{"a proposal with no key", "POST /api/runner/wiki/changesets", false, 0, func(tr *Transport) error {
			_, err := tr.proposeWikiChangeset("s", proposal(nil))
			return err
		}},
		{"a maintenance run's proposal", "POST maintenance/changesets", true, 1, func(tr *Transport) error {
			_, err := tr.proposeWikiMaintenance("s", "space-1", proposal(map[string]interface{}{"idempotencyKey": "wiki-maintain-1"}))
			return err
		}},
		{"an import's proposal", "POST imports", true, 1, func(tr *Transport) error {
			_, err := tr.importWikiChangeset("s", "space-1", proposal(map[string]interface{}{"idempotencyKey": "wiki-import:1"}))
			return err
		}},
		{"a plan draft under its key", "POST plan/drafts", true, 1, func(tr *Transport) error {
			_, err := tr.submitWikiPlanDraft("s", "space-1", wikiPlanDraftRequest{Plan: wikiPlanDraft{}, IdempotencyKey: "wiki-plan-1"})
			return err
		}},
		{"a plan draft with no key", "POST plan/drafts", false, 0, func(tr *Transport) error {
			_, err := tr.submitWikiPlanDraft("s", "space-1", wikiPlanDraftRequest{Plan: wikiPlanDraft{}})
			return err
		}},
		{"a verdict", "POST verifications", true, 1, func(tr *Transport) error {
			_, err := tr.reportWikiVerifications("s", "space-1", map[string]interface{}{"verdicts": []interface{}{
				map[string]interface{}{"opId": "op-1", "verdict": "supported", "reason": "it says so", "model": "m"}}})
			return err
		}},
		{"a note", "POST notes", true, 1, func(tr *Transport) error {
			_, _, err := tr.registerWikiNote("s", "space-1", map[string]interface{}{"path": "memory/a.md", "text": "a fact"})
			return err
		}},
		{"a topic's articles", "POST articles/ui-design", true, 1, func(tr *Transport) error {
			_, err := tr.writeWikiArticles("s", "space-1", "ui-design", map[string]interface{}{"entrySetSha256": "sha-1"})
			return err
		}},
		{"the article plan", "POST article-plan", true, 1, func(tr *Transport) error {
			_, err := tr.planWikiArticles("s", "space-1")
			return err
		}},
		{"the anchors' checks", "POST anchor-checks", true, 1, func(tr *Transport) error {
			_, err := tr.reportWikiAnchorChecks("s", "space-1", map[string]interface{}{"ref": strings.Repeat("a", 40), "entries": []interface{}{}})
			return err
		}},
		{"a succeeded run's cursor", "POST cursor", true, 1, func(tr *Transport) error {
			_, err := tr.advanceWikiCursor("s", "space-1", map[string]interface{}{"outcome": "succeeded", "to": "tok-1"})
			return err
		}},
		{"a failed run's cursor", "POST cursor", false, 0, func(tr *Transport) error {
			_, err := tr.advanceWikiCursor("s", "space-1", map[string]interface{}{"outcome": "failed", "error": "it broke"})
			return err
		}},
		{"a truncated run's cursor", "POST cursor", false, 0, func(tr *Transport) error {
			_, err := tr.advanceWikiCursor("s", "space-1", map[string]interface{}{"outcome": "truncated", "error": "cut short"})
			return err
		}},
		{"a succeeded run's end", "POST maintenance/finish", true, 1, func(tr *Transport) error {
			_, err := tr.finishWikiMaintenance("s", "space-1", map[string]interface{}{"outcome": "succeeded", "to": "tok-1", "report": map[string]interface{}{}})
			return err
		}},
		{"a failed run's end", "POST maintenance/finish", false, 0, func(tr *Transport) error {
			_, err := tr.finishWikiMaintenance("s", "space-1", map[string]interface{}{"outcome": "failed", "error": "it broke", "report": map[string]interface{}{}})
			return err
		}},
	} {
		t.Run(c.name, func(t *testing.T) {
			ledger, doorURL := newWikiLedger(t)
			clock := withFakeWikiRetry(t)
			flaky := withFlakyWikiTransport(t, map[string][]wikiFault{c.route: {{lost: wikiAnswerCut}}})
			err := c.call(NewTransport(doorURL, "runner-token"))
			landings, effects := ledger.counts()
			if c.resent {
				if err != nil || flaky.sent(c.route) != 2 || landings != 2 || len(clock.lines()) != 1 {
					t.Errorf("%v after %d sends and %d landings, lines %q: want it sent again and answered", err, flaky.sent(c.route), landings, clock.lines())
				}
				if effects != c.records {
					t.Errorf("landed twice and recorded %d times: want %d", effects, c.records)
				}
				return
			}
			if !errors.Is(err, io.EOF) || flaky.sent(c.route) != 1 || landings != 1 || effects != 1 || len(clock.lines()) != 0 {
				t.Errorf("%v after %d sends (%d landings, %d recorded), lines %q: want it sent once and its failure handed back",
					err, flaky.sent(c.route), landings, effects, clock.lines())
			}
		})
	}
}

// A note the server already holds, answered to a registration that had to be sent twice, is the first send's:
// it landed and its answer was cut. The file is read and proposed from, not left out as imported before.
func TestWikiRetryReadsANoteWhoseFirstSendLanded(t *testing.T) {
	library := memoryLibrary(t, map[string][2]string{"feedback-1.md": {"feedback", "fact one"}})
	door := newFakeImportDoor(t, "tiered")
	vllm := newFakeVLLM(t, scripted(map[string]string{"memory/feedback-1.md": manyEntries("One", 1)}))
	fakeVerifyClaude(t)
	wikiImportSession(t, door, vllm)
	clock := withFakeWikiRetry(t)
	flaky := withFlakyWikiTransport(t, map[string][]wikiFault{
		"POST notes":   {{lost: wikiAnswerCut}},
		"POST imports": {{status: http.StatusServiceUnavailable}},
	})

	summary, err := importSummary(t, "--from", library, "--space", "space-1")
	if err != nil || summary.Proposed != 1 || summary.NewNotes != 1 || summary.KnownNotes != 0 || summary.Remaining != 0 {
		t.Fatalf("an import whose note's answer was cut = %v, %+v: want the note read and its entry proposed", err, summary)
	}
	if registrations := door.Registrations(); len(registrations) != 2 || len(door.notes) != 1 {
		t.Errorf("registrations %v, notes %d: want the note sent twice and kept once", registrations, len(door.notes))
	}
	if len(door.proposed()) != 1 || flaky.sent("POST imports") != 2 {
		t.Errorf("proposed %d ops over %d sends: want the one entry, sent again after the 503", len(door.proposed()), flaky.sent("POST imports"))
	}
	if lines := clock.lines(); len(lines) != 2 || !strings.Contains(lines[0], "POST /runner/wiki/spaces/space-1/notes failed (EOF)") ||
		!strings.Contains(lines[1], "POST /runner/wiki/spaces/space-1/imports failed (503 Service Unavailable)") {
		t.Errorf("the retries said %q", lines)
	}

	// The same text under another name is still the note already there, sent twice or not: the note the
	// server holds is another path's.
	raw, err := os.ReadFile(filepath.Join(library, "feedback-1.md"))
	if err != nil {
		t.Fatal(err)
	}
	copies := filepath.Join(t.TempDir(), "memory")
	if err := os.MkdirAll(copies, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(copies, "feedback-copy.md"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	withFlakyWikiTransport(t, map[string][]wikiFault{"POST notes": {{status: http.StatusBadGateway}}})
	summary, err = importSummary(t, "--from", copies, "--space", "space-1")
	if err != nil || summary.KnownNotes != 1 || summary.Proposed != 0 || len(door.notes) != 1 {
		t.Errorf("a copy under another name = %v, %+v: want it known as the note already there", err, summary)
	}
}

// ── Which failures ──────────────────────────────────────────────────────────────────────────────

// Each failure as this machine's own net/http returns it — a refused connection, a cut one, a reset one, a
// request that timed out — and the gateway's and the edge's answers, told apart from the server's own.
func TestWikiRetryKnowsATransientFailureFromAnAnswer(t *testing.T) {
	transient := func(err error) bool {
		_, _, ok := wikiTransient(err, http.MethodGet, "/runner/wiki/spaces/space-1/anchors", time.Now())
		return ok
	}
	get := func(url string, timeout time.Duration) error {
		var out json.RawMessage
		return NewTransport(url, "runner-token").doHeaders(nil, http.MethodGet, "/runner/wiki/spaces/space-1/anchors", nil, &out, timeout, nil)
	}

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	closed := "http://" + listener.Addr().String()
	_ = listener.Close()
	refused := get(closed, time.Second)

	hangUp := func(reset bool) error {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			conn, _, err := w.(http.Hijacker).Hijack()
			if err != nil {
				return
			}
			if reset {
				_ = conn.(*net.TCPConn).SetLinger(0)
			}
			_ = conn.Close()
		}))
		defer srv.Close()
		return get(srv.URL, time.Second)
	}
	cut, reset := hangUp(false), hangUp(true)

	release := make(chan struct{})
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-release }))
	timedOut := get(slow.URL, 50*time.Millisecond)
	close(release)
	slow.Close()

	html := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("<html>")) }))
	notJSON := get(html.URL, time.Second)
	html.Close()

	status := func(code int, retryAfter string) error {
		return &transportHTTPError{method: http.MethodGet, path: "/runner/wiki/spaces/space-1/anchors", statusCode: code, body: "error code", retryAfter: retryAfter}
	}
	edge := func(words string) error {
		return &url.Error{Op: "Post", URL: "https://orbitd.io/api/runner/wiki/spaces/space-1/articles/ui-design", Err: errors.New(words)}
	}
	for _, c := range []struct {
		name string
		err  error
		want bool
	}{
		{"a refused connection", refused, true},
		{"a connection cut before the answer", cut, true},
		{"a connection reset", reset, true},
		{"a request that timed out", timedOut, true},
		{"502", status(http.StatusBadGateway, ""), true},
		{"503", status(http.StatusServiceUnavailable, ""), true},
		{"504", status(http.StatusGatewayTimeout, ""), true},
		{"the edge's 520", status(520, ""), true},
		{"the edge's 524", status(524, ""), true},
		{"a stream the edge reset", edge(wikiStreamReset.Error()), true},
		{"a stream the edge refused", edge("stream error: stream ID 3; REFUSED_STREAM; received from peer"), true},
		{"a GOAWAY", edge(`http2: server sent GOAWAY and closed the connection; LastStreamID=1, ErrCode=NO_ERROR, debug=""`), true},
		{"a graceful shutdown", edge("http2: Transport received Server's graceful shutdown GOAWAY"), true},
		{"a connection the client found broken", edge("connection error: PROTOCOL_ERROR"), true},
		{"a 429 that says when", status(http.StatusTooManyRequests, "3"), true},
		{"a 429 that does not", status(http.StatusTooManyRequests, ""), false},
		{"500", status(http.StatusInternalServerError, ""), false},
		{"400", status(http.StatusBadRequest, ""), false},
		{"404", status(http.StatusNotFound, ""), false},
		{"409", status(http.StatusConflict, ""), false},
		{"422", status(http.StatusUnprocessableEntity, ""), false},
		{"a call its caller cancelled", &url.Error{Op: "Get", URL: closed, Err: context.Canceled}, false},
		{"a redirect off the server", edge("refusing cross-origin redirect to https://elsewhere.example/"), false},
		{"an answer that is not JSON", notJSON, false},
	} {
		if c.err == nil {
			t.Errorf("%s: the failure did not happen", c.name)
			continue
		}
		if got := transient(c.err); got != c.want {
			t.Errorf("%s (%v): transient = %v, want %v", c.name, c.err, got, c.want)
		}
	}
	if !errors.Is(refused, syscall.ECONNREFUSED) || !errors.Is(timedOut, context.DeadlineExceeded) {
		t.Errorf("refused = %v, timed out = %v: not the failures they stand for", refused, timedOut)
	}
}
