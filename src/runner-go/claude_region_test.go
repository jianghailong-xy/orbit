package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// The region check's answers, as GET /api/runner/region-check spells them (ClaudeRegionCheckResponse).
const (
	regionAnswerAllowed = `{"verdict":"allowed","country":"US","regionCode":null,"name":"United States","viaProxy":false,"asOf":"2026-10-31"}`
	regionAnswerBlocked = `{"verdict":"blocked","country":"RU","regionCode":null,"name":"Russia","viaProxy":false,"asOf":"2026-10-31"}`
	regionAnswerUnknown = `{"verdict":"unknown","country":null,"regionCode":null,"name":null,"viaProxy":false,"asOf":"2026-10-31"}`
	// regionAnswerNotFound stands for a control plane without the route, which answers 404.
	regionAnswerNotFound = ""
)

// The refusal of a runner named atlas whose connection to Anthropic is in Russia, word for word (board 04,
// contract §9).
const atlasRussiaRefusal = "CLAUDE_REGION_UNSUPPORTED: atlas’s connection to Anthropic is in Russia, where Anthropic doesn’t offer Claude."

// isolateClaudeRegionEnv gives a test an environment of its own for everything the region check reads: no
// proxy and no NO_PROXY, no Anthropic endpoint and no Bedrock or Vertex switch, and a Claude Code config
// directory of its own, whose path it returns. This machine's own proxy and settings.json are never read.
func isolateClaudeRegionEnv(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CLAUDE_CONFIG_DIR", dir)
	for _, key := range append(append([]string{}, claudeProxyVars...),
		"no_proxy", "NO_PROXY", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX") {
		t.Setenv(key, "")
	}
	return dir
}

// writeClaudeSettingsEnv writes a settings.json into the Claude Code config directory dir whose `env` is env.
func writeClaudeSettingsEnv(t *testing.T, dir string, env map[string]interface{}) {
	t.Helper()
	b, err := json.Marshal(map[string]interface{}{"model": "opus", "env": env})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), b, 0o644); err != nil {
		t.Fatal(err)
	}
}

// regionStub is a control plane with the region check's route: GET /api/runner/region-check answers what
// answer holds, recording the viaProxy and the credential each check came with. regionRig serves a session's
// routes from it too.
type regionStub struct {
	t      *testing.T
	server *httptest.Server

	mu     sync.Mutex
	answer string
	checks []string
	tokens []string
	// What a session's supervisor sees and sends (regionRig): its inbox hands out what is queued, in order.
	inbox     []RunInboxResponse
	handedOut []string
	events    []RunEvent
	settled   []TurnCompleteRequest
	finalized []RunFinalizeRequest
	// status answers a turn-complete with the session's status after it. Nil answers as today's control
	// plane does: FAILED for a failed turn, which ends the session, and AWAITING_INPUT for any other.
	status func(TurnCompleteRequest) string
}

func newRegionStub(t *testing.T, answer string) *regionStub {
	t.Helper()
	s := &regionStub{t: t, answer: answer}
	s.server = httptest.NewServer(http.HandlerFunc(s.serve))
	t.Cleanup(s.server.Close)
	return s
}

func (s *regionStub) serve(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.URL.Path == "/api/runner/region-check":
		s.mu.Lock()
		s.checks = append(s.checks, r.URL.Query().Get("viaProxy"))
		s.tokens = append(s.tokens, r.Header.Get("authorization"))
		answer := s.answer
		s.mu.Unlock()
		if answer == regionAnswerNotFound {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"message":"Cannot GET /api/runner/region-check?viaProxy=0","error":"Not Found","statusCode":404}`))
			return
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(answer))
		return
	case strings.HasSuffix(r.URL.Path, "/inbox"):
		deadline := time.Now().Add(20 * time.Millisecond)
		for time.Now().Before(deadline) && r.Context().Err() == nil {
			s.mu.Lock()
			if len(s.inbox) > 0 {
				turn := s.inbox[0]
				s.inbox = s.inbox[1:]
				s.handedOut = append(s.handedOut, turn.TurnID)
				s.mu.Unlock()
				_ = json.NewEncoder(w).Encode(turn)
				return
			}
			s.mu.Unlock()
			time.Sleep(2 * time.Millisecond)
		}
	case strings.HasSuffix(r.URL.Path, "/events"):
		var batch RunEventBatch
		if json.NewDecoder(r.Body).Decode(&batch) == nil {
			s.mu.Lock()
			s.events = append(s.events, batch.Events...)
			s.mu.Unlock()
		}
	case strings.HasSuffix(r.URL.Path, "/turn-complete"):
		var req TurnCompleteRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		s.mu.Lock()
		s.settled = append(s.settled, req)
		status := s.status
		s.mu.Unlock()
		answer := stAwaitingInput
		switch {
		case status != nil:
			answer = status(req)
		case turnCompletionEndsSession(req):
			answer = stFailed
		}
		_ = json.NewEncoder(w).Encode(TurnCompleteResponse{OK: true, Status: answer})
		return
	case strings.HasSuffix(r.URL.Path, "/finalize"):
		var req RunFinalizeRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		s.mu.Lock()
		s.finalized = append(s.finalized, req)
		s.mu.Unlock()
		_, _ = w.Write([]byte(`{"keepCheckout":true}`))
		return
	}
	_, _ = w.Write([]byte(`{}`))
}

func (s *regionStub) setAnswer(answer string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.answer = answer
}

func (s *regionStub) checksSoFar() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.checks...)
}

// installRegionCheck makes this process's region check (claudeRegion) one that asks stub, as a runner named
// atlas, on clock, for the rest of the test.
func installRegionCheck(t *testing.T, stub *regionStub, clock *fakePoolClock) *claudeRegionCheck {
	t.Helper()
	check := newClaudeRegionCheck(NewTransport(stub.server.URL, "runner-token"), "atlas")
	check.now = clock.Now
	previous := claudeRegion.Swap(check)
	t.Cleanup(func() { claudeRegion.Store(previous) })
	return check
}

// forwardProxy is an HTTP proxy that records each request it is asked to forward, as the request line names
// it, and forwards it directly.
type forwardProxy struct {
	server *httptest.Server
	mu     sync.Mutex
	asked  []string
}

func newForwardProxy(t *testing.T) *forwardProxy {
	t.Helper()
	p := &forwardProxy{}
	p.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p.mu.Lock()
		p.asked = append(p.asked, r.Method+" "+r.RequestURI)
		p.mu.Unlock()
		if !r.URL.IsAbs() {
			http.Error(w, "not a proxy request", http.StatusBadRequest)
			return
		}
		out, err := http.NewRequestWithContext(r.Context(), r.Method, r.URL.String(), r.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		out.Header = r.Header.Clone()
		resp, err := (&http.Transport{}).RoundTrip(out)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()
		for key, values := range resp.Header {
			for _, v := range values {
				w.Header().Add(key, v)
			}
		}
		w.WriteHeader(resp.StatusCode)
		_, _ = io.Copy(w, resp.Body)
	}))
	t.Cleanup(p.server.Close)
	return p
}

func (p *forwardProxy) requests() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.asked...)
}

// The check leaves through the proxy Claude uses, though NO_PROXY lists the Orbit host the way `orbit register
// --proxy` writes it: the runner's own requests go around the proxy, and this one must not.
func TestClaudeRegionCheckGoesThroughClaudesProxy(t *testing.T) {
	isolateClaudeRegionEnv(t)
	stub := newRegionStub(t, regionAnswerAllowed)
	proxy := newForwardProxy(t)
	for _, v := range proxyServiceEnv(proxy.server.URL, stub.server.URL, "") {
		t.Setenv(v.K, v.V)
	}
	if !strings.Contains(os.Getenv("NO_PROXY"), hostOnly(stub.server.URL)) {
		t.Fatalf("NO_PROXY = %q does not list the Orbit host", os.Getenv("NO_PROXY"))
	}

	check := newClaudeRegionCheck(NewTransport(stub.server.URL, "runner-token"), "atlas")
	v := check.check(context.Background())
	if v.Verdict != claudeRegionAllowed || !v.ViaProxy || v.Name != "United States" || v.Country != "US" {
		t.Fatalf("check = %+v, want allowed in the United States through the proxy", v)
	}
	want := "GET " + stub.server.URL + "/api/runner/region-check?viaProxy=1"
	if got := proxy.requests(); len(got) != 1 || got[0] != want {
		t.Fatalf("the proxy was asked for %q, want just %q", got, want)
	}
	if got := stub.checksSoFar(); len(got) != 1 || got[0] != "1" {
		t.Fatalf("the route saw viaProxy %q, want [1]", got)
	}
	stub.mu.Lock()
	token := stub.tokens[0]
	stub.mu.Unlock()
	if token != "Bearer runner-token" {
		t.Fatalf("the check carried authorization %q, want the runner token", token)
	}
}

func TestClaudeRegionCheckGoesDirectlyWithNoProxy(t *testing.T) {
	isolateClaudeRegionEnv(t)
	stub := newRegionStub(t, regionAnswerBlocked)
	proxy := newForwardProxy(t) // there, and named by nothing

	check := newClaudeRegionCheck(NewTransport(stub.server.URL, "runner-token"), "atlas")
	v := check.check(context.Background())
	if v.Verdict != claudeRegionBlocked || v.ViaProxy || v.Name != "Russia" {
		t.Fatalf("check = %+v, want blocked in Russia, directly", v)
	}
	if got := stub.checksSoFar(); len(got) != 1 || got[0] != "0" {
		t.Fatalf("the route saw viaProxy %q, want [0]", got)
	}
	if got := proxy.requests(); len(got) != 0 {
		t.Fatalf("a check with no proxy went through one: %q", got)
	}
}

// The proxy comes from the process's environment, then from the `env` of Claude Code's settings.json.
func TestClaudeRegionCheckTakesTheProxyFromSettingsJSON(t *testing.T) {
	dir := isolateClaudeRegionEnv(t)
	stub := newRegionStub(t, regionAnswerAllowed)
	fromSettings, fromEnv := newForwardProxy(t), newForwardProxy(t)
	writeClaudeSettingsEnv(t, dir, map[string]interface{}{"HTTPS_PROXY": fromSettings.server.URL})

	check := newClaudeRegionCheck(NewTransport(stub.server.URL, "runner-token"), "atlas")
	if v := check.check(context.Background()); !v.ViaProxy || len(fromSettings.requests()) != 1 {
		t.Fatalf("check = %+v with settings.json naming a proxy; that proxy was asked %q", v, fromSettings.requests())
	}

	t.Setenv("https_proxy", fromEnv.server.URL)
	if v := check.check(context.Background()); !v.ViaProxy || len(fromEnv.requests()) != 1 || len(fromSettings.requests()) != 1 {
		t.Fatalf("with the environment naming a proxy too, the check went to env %q and settings %q, want the environment's",
			fromEnv.requests(), fromSettings.requests())
	}
}

func TestClaudeAnthropicProxy(t *testing.T) {
	for _, c := range []struct {
		name     string
		env      map[string]string
		settings map[string]interface{}
		want     string
	}{
		{"none", nil, nil, ""},
		{"https proxy", map[string]string{"HTTPS_PROXY": "http://proxy.corp:3128"}, nil, "http://proxy.corp:3128"},
		{"an http proxy serves https too", map[string]string{"http_proxy": "http://proxy.corp:3128"}, nil, "http://proxy.corp:3128"},
		{"the https one first", map[string]string{"HTTP_PROXY": "http://plain:1", "https_proxy": "http://secure:2"}, nil, "http://secure:2"},
		{"no scheme reads as http", map[string]string{"HTTPS_PROXY": "127.0.0.1:7890"}, nil, "http://127.0.0.1:7890"},
		{"NO_PROXY with the Orbit host only", map[string]string{"HTTPS_PROXY": "http://p:1", "NO_PROXY": "localhost,127.0.0.1,orbitd.io"}, nil, "http://p:1"},
		{"NO_PROXY exempting Anthropic", map[string]string{"HTTPS_PROXY": "http://p:1", "no_proxy": "localhost,.anthropic.com"}, nil, ""},
		{"NO_PROXY naming the API host", map[string]string{"HTTPS_PROXY": "http://p:1", "NO_PROXY": "api.anthropic.com:443"}, nil, ""},
		{"NO_PROXY star", map[string]string{"HTTPS_PROXY": "http://p:1", "NO_PROXY": "*"}, nil, ""},
		{"NO_PROXY look-alike", map[string]string{"HTTPS_PROXY": "http://p:1", "NO_PROXY": "myanthropic.com"}, nil, "http://p:1"},
		{"settings.json", nil, map[string]interface{}{"HTTPS_PROXY": "http://from-settings:8"}, "http://from-settings:8"},
		{"settings.json NO_PROXY", nil, map[string]interface{}{"HTTPS_PROXY": "http://s:8", "NO_PROXY": "anthropic.com"}, ""},
		{"the environment first", map[string]string{"HTTPS_PROXY": "http://env:1"}, map[string]interface{}{"HTTPS_PROXY": "http://s:8"}, "http://env:1"},
	} {
		t.Run(c.name, func(t *testing.T) {
			dir := isolateClaudeRegionEnv(t)
			for k, v := range c.env {
				t.Setenv(k, v)
			}
			if c.settings != nil {
				writeClaudeSettingsEnv(t, dir, c.settings)
			}
			if got := claudeAnthropicProxy(); got != c.want {
				t.Fatalf("claudeAnthropicProxy() = %q, want %q", got, c.want)
			}
		})
	}
}

// A 404 (a control plane without the route) and every failure are unknown, inside the check's budget.
func TestClaudeRegionCheckIsUnknownWhenItCannotDecide(t *testing.T) {
	isolateClaudeRegionEnv(t)
	previous := claudeRegionCheckBudget
	claudeRegionCheckBudget = 300 * time.Millisecond
	t.Cleanup(func() { claudeRegionCheckBudget = previous })

	hang := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	t.Cleanup(hang.Close)
	gone := httptest.NewServer(http.NotFoundHandler())
	gone.Close()
	garbage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("<html>bad gateway</html>"))
	}))
	t.Cleanup(garbage.Close)
	cases := map[string]string{
		"route not found":   newRegionStub(t, regionAnswerNotFound).server.URL,
		"verdict unknown":   newRegionStub(t, regionAnswerUnknown).server.URL,
		"no answer in time": hang.URL,
		"server gone":       gone.URL,
		"not JSON":          garbage.URL,
	}
	for name, server := range cases {
		check := newClaudeRegionCheck(NewTransport(server, "runner-token"), "atlas")
		began := time.Now()
		v := check.check(context.Background())
		if v.Verdict != claudeRegionUnknown || v.Name != "" {
			t.Errorf("%s: check = %+v, want unknown", name, v)
		}
		if took := time.Since(began); took > claudeRegionCheckBudget+2*time.Second {
			t.Errorf("%s: the check took %s, past its %s budget", name, took, claudeRegionCheckBudget)
		}
		if _, decided := check.lastDecided(""); decided {
			t.Errorf("%s: an unknown answer was kept as a decided verdict", name)
		}
	}
}

// A turn goes on an answer under a minute old, and asks again past that.
func TestClaudeRegionTurnGoesOnAFreshAnswerOrAsksNow(t *testing.T) {
	isolateClaudeRegionEnv(t)
	stub := newRegionStub(t, regionAnswerAllowed)
	clock := newFakePoolClock()
	check := newClaudeRegionCheck(NewTransport(stub.server.URL, "runner-token"), "atlas")
	check.now = clock.Now

	if v := check.forTurn(context.Background()); v.Verdict != claudeRegionAllowed {
		t.Fatalf("first turn: %+v, want allowed", v)
	}
	clock.Advance(claudeRegionFreshFor - time.Second)
	stub.setAnswer(regionAnswerBlocked)
	if v := check.forTurn(context.Background()); v.Verdict != claudeRegionAllowed || len(stub.checksSoFar()) != 1 {
		t.Fatalf("a turn 59 s on: %+v after %d checks, want the fresh allowed answer and no new check", v, len(stub.checksSoFar()))
	}
	clock.Advance(time.Second)
	if v := check.forTurn(context.Background()); v.Verdict != claudeRegionBlocked || len(stub.checksSoFar()) != 2 {
		t.Fatalf("a turn 60 s on: %+v after %d checks, want a new check answering blocked", v, len(stub.checksSoFar()))
	}
	// The periodic check is a check like any other: the turn after it goes on its answer.
	stub.setAnswer(regionAnswerAllowed)
	clock.Advance(5 * time.Minute)
	check.check(context.Background())
	if v := check.forTurn(context.Background()); v.Verdict != claudeRegionAllowed || len(stub.checksSoFar()) != 3 {
		t.Fatalf("a turn just after the periodic check: %+v after %d checks, want its answer", v, len(stub.checksSoFar()))
	}
}

// The last decided verdict is kept with its decidedAt, per proxy: an unknown answer leaves it standing, and an
// answer through another proxy is another connection's.
func TestClaudeRegionKeepsTheLastDecidedVerdictByProxy(t *testing.T) {
	isolateClaudeRegionEnv(t)
	stub := newRegionStub(t, regionAnswerBlocked)
	proxy := newForwardProxy(t)
	clock := newFakePoolClock()
	check := newClaudeRegionCheck(NewTransport(stub.server.URL, "runner-token"), "atlas")
	check.now = clock.Now

	decidedAt := clock.Now()
	check.check(context.Background())
	clock.Advance(5 * time.Minute)
	stub.setAnswer(regionAnswerNotFound)
	if v := check.check(context.Background()); v.Verdict != claudeRegionUnknown {
		t.Fatalf("second check = %+v, want unknown", v)
	}
	if v, ok := check.lastDecided(""); !ok || v.Verdict != claudeRegionBlocked || v.Name != "Russia" || !v.At.Equal(decidedAt) {
		t.Fatalf("last decided directly = %+v (%v), want blocked in Russia decided at %v", v, ok, decidedAt)
	}

	t.Setenv("HTTPS_PROXY", proxy.server.URL)
	stub.setAnswer(regionAnswerAllowed)
	clock.Advance(time.Minute)
	if v := check.check(context.Background()); v.Verdict != claudeRegionAllowed || !v.ViaProxy {
		t.Fatalf("check through the proxy = %+v, want allowed", v)
	}
	if v, ok := check.lastDecided(proxy.server.URL); !ok || v.Verdict != claudeRegionAllowed || !v.At.Equal(clock.Now()) {
		t.Fatalf("last decided through the proxy = %+v (%v), want allowed, decided now", v, ok)
	}
	if v, _ := check.lastDecided(""); v.Verdict != claudeRegionBlocked {
		t.Fatalf("the proxy's answer replaced the direct connection's verdict: %+v", v)
	}
	// Back to no proxy: the direct connection's newest answer is five minutes old, so a turn asks again
	// rather than go on the proxy's fresh one.
	t.Setenv("HTTPS_PROXY", "")
	before := len(stub.checksSoFar())
	if v := check.forTurn(context.Background()); v.ViaProxy || len(stub.checksSoFar()) != before+1 {
		t.Fatalf("a turn with no proxy went on %+v after %d new checks, want a new direct check", v, len(stub.checksSoFar())-before)
	}
}

func TestClaudeTurnIsAnthropicBound(t *testing.T) {
	const deepseek = "https://api.deepseek.com/anthropic"
	for _, c := range []struct {
		name     string
		session  map[string]string
		settings map[string]interface{}
		process  map[string]string
		want     bool
	}{
		{"Claude Code's own sign-in", nil, nil, nil, true},
		{"an Anthropic key", map[string]string{"ANTHROPIC_API_KEY": "sk-ant"}, nil, nil, true},
		{"Anthropic's API by name", map[string]string{"ANTHROPIC_BASE_URL": "https://api.anthropic.com"}, nil, nil, true},
		{"anthropic.com, any case, trailing dot", map[string]string{"ANTHROPIC_BASE_URL": "https://API.Anthropic.COM./v1"}, nil, nil, true},
		{"an empty base URL", map[string]string{"ANTHROPIC_BASE_URL": " "}, nil, nil, true},
		{"DeepSeek in the session", map[string]string{"ANTHROPIC_BASE_URL": deepseek}, nil, nil, false},
		{"a local vLLM", map[string]string{"ANTHROPIC_BASE_URL": "http://127.0.0.1:8000"}, nil, nil, false},
		{"a look-alike host", map[string]string{"ANTHROPIC_BASE_URL": "https://api.anthropic.com.example"}, nil, nil, false},
		{"another look-alike", map[string]string{"ANTHROPIC_BASE_URL": "https://myanthropic.com"}, nil, nil, false},
		{"DeepSeek in settings.json", nil, map[string]interface{}{"ANTHROPIC_BASE_URL": deepseek}, nil, false},
		{"DeepSeek in the process", nil, nil, map[string]string{"ANTHROPIC_BASE_URL": deepseek}, false},
		{"the session before settings.json", map[string]string{"ANTHROPIC_BASE_URL": "https://api.anthropic.com"},
			map[string]interface{}{"ANTHROPIC_BASE_URL": deepseek}, nil, true},
		{"settings.json before the process", nil, map[string]interface{}{"ANTHROPIC_BASE_URL": "https://api.anthropic.com"},
			map[string]string{"ANTHROPIC_BASE_URL": deepseek}, true},
		{"Bedrock in the session", map[string]string{"CLAUDE_CODE_USE_BEDROCK": "1"}, nil, nil, false},
		{"Bedrock in settings.json", nil, map[string]interface{}{"CLAUDE_CODE_USE_BEDROCK": 1}, nil, false},
		{"Vertex in the process", nil, nil, map[string]string{"CLAUDE_CODE_USE_VERTEX": "true"}, false},
		{"Bedrock off", map[string]string{"CLAUDE_CODE_USE_BEDROCK": "0"}, nil, nil, true},
		{"Bedrock switched off by the session", map[string]string{"CLAUDE_CODE_USE_BEDROCK": ""}, nil,
			map[string]string{"CLAUDE_CODE_USE_BEDROCK": "1"}, true},
	} {
		t.Run(c.name, func(t *testing.T) {
			dir := isolateClaudeRegionEnv(t)
			for k, v := range c.process {
				t.Setenv(k, v)
			}
			if c.settings != nil {
				writeClaudeSettingsEnv(t, dir, c.settings)
			}
			if got := claudeTurnIsAnthropicBound(c.session); got != c.want {
				t.Fatalf("claudeTurnIsAnthropicBound = %v, want %v", got, c.want)
			}
		})
	}

	// A session on an added account reads the settings.json in that account's own directory.
	isolateClaudeRegionEnv(t)
	account := t.TempDir()
	writeClaudeSettingsEnv(t, account, map[string]interface{}{"ANTHROPIC_BASE_URL": deepseek})
	if claudeTurnIsAnthropicBound(map[string]string{"CLAUDE_CONFIG_DIR": account}) {
		t.Fatal("a session whose account's settings.json points Claude Code at DeepSeek was counted as Anthropic-bound")
	}
}

// Only Claude turns that talk to Anthropic are asked about: another engine, another provider's key and a
// process with no check of its own are never refused, and never send a check.
func TestClaudeRegionRefusalAsksOnlyForAnthropicBoundClaude(t *testing.T) {
	isolateClaudeRegionEnv(t)
	stub := newRegionStub(t, regionAnswerBlocked)
	job := func(provider string, env map[string]string) *ClaimedSession {
		return &ClaimedSession{SessionID: "s", Provider: provider, Agent: AgentExecConfig{Provider: provider, Env: env}}
	}
	if got := claudeRegionRefusal(context.Background(), job(providerClaude, nil)); got != "" {
		t.Fatalf("with no check installed a turn was refused: %q", got)
	}
	installRegionCheck(t, stub, newFakePoolClock())
	for _, other := range []*ClaimedSession{
		job(providerCodex, nil),
		job(providerKimi, nil),
		job(providerClaude, map[string]string{"ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic"}),
	} {
		if got := claudeRegionRefusal(context.Background(), other); got != "" {
			t.Fatalf("%s %v was refused: %q", other.Provider, other.Agent.Env, got)
		}
	}
	if n := len(stub.checksSoFar()); n != 0 {
		t.Fatalf("turns that do not talk to Anthropic sent %d checks", n)
	}
	if got := claudeRegionRefusal(context.Background(), job(providerClaude, nil)); got != atlasRussiaRefusal {
		t.Fatalf("refusal = %q, want %q", got, atlasRussiaRefusal)
	}
}

// The owner's Check again is answered once per request, though the control plane repeats it on every heartbeat
// until a check is recorded.
func TestClaudeRegionCheckAgainOncePerRequest(t *testing.T) {
	var resp HeartbeatResponse
	if err := json.Unmarshal([]byte(`{"cancelSessionIds":[],"maxConcurrent":2,"regionCheckRequest":{"requestedAt":"2026-11-01T09:00:00.000Z"}}`), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.RegionCheckRequest == nil || resp.RegionCheckRequest.RequestedAt != "2026-11-01T09:00:00.000Z" {
		t.Fatalf("regionCheckRequest decoded as %+v", resp.RegionCheckRequest)
	}
	check := newClaudeRegionCheck(nil, "atlas")
	for _, c := range []struct {
		requestedAt string
		want        bool
	}{
		{"", false},
		{resp.RegionCheckRequest.RequestedAt, true},
		{resp.RegionCheckRequest.RequestedAt, false},
		{resp.RegionCheckRequest.RequestedAt, false},
		{"2026-11-01T09:05:00.000Z", true},
	} {
		if got := check.takeCheckAgain(c.requestedAt); got != c.want {
			t.Fatalf("takeCheckAgain(%q) = %v, want %v", c.requestedAt, got, c.want)
		}
	}
}

// The engine-health loop starts the region check when it starts, beside the probe and without waiting for it.
func TestEngineHealthLoopStartsTheRegionCheck(t *testing.T) {
	probing := make(chan struct{})
	checked := make(chan struct{}, 1)
	p := &engineHealthProbe{
		probe:       func() []EngineHealthReport { <-probing; return nil },
		checkRegion: func() { checked <- struct{}{} },
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	defer close(probing)
	go p.run(ctx)
	select {
	case <-checked:
	case <-time.After(fakeClaudeTimeout):
		t.Fatal("the region check did not start while the engine probe was still running")
	}
}

// The runner declares the check in the words the control plane asks for, and its code and subtype are the
// shared ones.
func TestTheRunnerDeclaresTheClaudeRegionCheck(t *testing.T) {
	if !strings.Contains(","+runnerCapabilitiesV1+",", ","+claudeRegionCapabilityV1+",") {
		t.Fatalf("this runner does not declare %s: %q", claudeRegionCapabilityV1, runnerCapabilitiesV1)
	}
	shared, err := os.ReadFile(filepath.Join("..", "shared", "src", "dto.ts"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"CLAUDE_REGION_V1 = '" + claudeRegionCapabilityV1 + "'",
		"CLAUDE_REGION_UNSUPPORTED = '" + claudeRegionUnsupported + "'",
		"CLAUDE_REGION_REFUSED_SUBTYPE = '" + claudeRegionRefusedSubtype + "'",
		"export type ClaudeRegionVerdict = '" + claudeRegionAllowed + "' | '" + claudeRegionBlocked + "' | '" + claudeRegionUnknown + "';",
	} {
		if !strings.Contains(string(shared), want) {
			t.Errorf("@orbit/shared does not say %s", want)
		}
	}
}

// The refusal is the shared sentence, so the clients and the runner say the same thing.
func TestClaudeRegionRefusalIsTheSharedSentence(t *testing.T) {
	rules, err := os.ReadFile(filepath.Join("..", "shared", "src", "claude-region-check.ts"))
	if err != nil {
		t.Fatal(err)
	}
	sentence := strings.TrimPrefix(claudeRegionRefusedError("${machine}", "${region}"), claudeRegionUnsupported)
	if want := "return `${CLAUDE_REGION_UNSUPPORTED}" + sentence + "`;"; !strings.Contains(string(rules), want) {
		t.Fatalf("claude-region-check.ts does not write the refusal as the runner does: %s", want)
	}
	if got := claudeRegionRefusedError("atlas", "Russia"); got != atlasRussiaRefusal {
		t.Fatalf("refusal = %q", got)
	}
}
