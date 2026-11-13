package main

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// A private string the fake server hides in every body it can: the template, licence, system prompt and
// parameters /api/show returns, and the details /api/tags returns. No probe result may carry it.
const localProbePrivate = "PRIVATE-BODY-7f3a SYSTEM PROMPT sk-live-secret"

type fakeOllamaModel struct {
	name    string
	tools   bool
	context int
	removed bool // listed by /api/tags, 404 from /api/show
}

type fakeOllama struct {
	mu        sync.Mutex
	version   string
	models    []fakeOllamaModel
	override  map[string]http.HandlerFunc
	showCalls atomic.Int32
	showBody  sync.Map // the bodies /api/show was sent
}

func (f *fakeOllama) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	h := f.override[r.URL.Path]
	f.mu.Unlock()
	if h != nil {
		h(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/api/version":
		_ = json.NewEncoder(w).Encode(map[string]string{"version": f.version})
	case r.Method == http.MethodGet && r.URL.Path == "/api/tags":
		list := []map[string]any{}
		f.mu.Lock()
		for _, m := range f.models {
			list = append(list, map[string]any{
				"name": m.name, "model": m.name, "digest": "sha256:" + strings.Repeat("a", 12) + m.name,
				"size": 1234, "modified_at": "2026-11-01T00:00:00Z",
				"details": map[string]any{"parameter_size": "27.3B", "quantization_level": "Q4_K_M", "family": "qwen3", "format": "gguf", "parent_model": localProbePrivate},
			})
		}
		f.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"models": list})
	case r.Method == http.MethodPost && r.URL.Path == "/api/show":
		f.showCalls.Add(1)
		body, _ := io.ReadAll(r.Body)
		f.showBody.Store(string(body), true)
		var req struct {
			Model string `json:"model"`
		}
		_ = json.Unmarshal(body, &req)
		f.mu.Lock()
		defer f.mu.Unlock()
		for _, m := range f.models {
			if m.name != req.Model {
				continue
			}
			if m.removed {
				w.WriteHeader(http.StatusNotFound)
				_, _ = w.Write([]byte(`{"error":"model '` + m.name + `' not found ` + localProbePrivate + `"}`))
				return
			}
			caps := []string{"completion"}
			if m.tools {
				caps = append(caps, "tools")
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"license": localProbePrivate, "modelfile": localProbePrivate, "template": localProbePrivate,
				"system": localProbePrivate, "parameters": localProbePrivate,
				"capabilities": caps,
				"model_info":   map[string]any{"general.architecture": "qwen3", "qwen3.context_length": m.context, "general.basename": localProbePrivate},
			})
			return
		}
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":"not found"}`))
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func newFakeOllama(models ...fakeOllamaModel) *fakeOllama {
	return &fakeOllama{version: "0.40.16", models: models, override: map[string]http.HandlerFunc{}}
}

func (f *fakeOllama) set(path string, h http.HandlerFunc) {
	f.mu.Lock()
	f.override[path] = h
	f.mu.Unlock()
}

func startOn(t *testing.T, network, address string, h http.Handler) string {
	t.Helper()
	ln, err := net.Listen(network, address)
	if err != nil {
		t.Skipf("cannot listen on %s %s: %v", network, address, err)
	}
	srv := httptest.NewUnstartedServer(h)
	srv.Listener = ln
	srv.Start()
	t.Cleanup(srv.Close)
	return srv.URL
}

func loopbackProber() *localProber { return newLocalProber(parseLocalProbePolicy("")) }

func probeOnce(t *testing.T, p *localProber, baseURL string, models ...string) LocalProviderProbe {
	t.Helper()
	got := p.probe(context.Background(), LocalProviderTarget{ProviderID: "prov-1", BaseURL: baseURL, Models: models}, nil)
	raw, _ := json.Marshal(got)
	if strings.Contains(string(raw), "PRIVATE-BODY") || strings.Contains(string(raw), "sk-live") || strings.Contains(string(raw), "SYSTEM PROMPT") {
		t.Fatalf("a probe result carries the server's private body: %s", raw)
	}
	return got
}

var qwen = fakeOllamaModel{name: "qwen3.8:27b", tools: true, context: 131072}

func TestLocalProbeReadyReportsVersionLatencyAndCatalogue(t *testing.T) {
	fake := newFakeOllama(qwen, fakeOllamaModel{name: "embed/nomic-embed-text:v1.5", tools: false, context: 2048})
	url := startOn(t, "tcp4", "127.0.0.1:0", fake)
	got := probeOnce(t, loopbackProber(), url, "qwen3.8:27b")
	if got.State != localStateReady || got.Reason != "" {
		t.Fatalf("state = %s (%s), want READY", got.State, got.Reason)
	}
	if got.Version != "0.40.16" || got.LatencyMs == nil || *got.LatencyMs < 0 {
		t.Fatalf("version/latency = %q %v", got.Version, got.LatencyMs)
	}
	if _, err := time.Parse(time.RFC3339Nano, got.CheckedAt); err != nil {
		t.Fatalf("checkedAt %q: %v", got.CheckedAt, err)
	}
	if len(got.Models) != 2 {
		t.Fatalf("models = %+v", got.Models)
	}
	m := got.Models[0]
	if m.Value != "qwen3.8:27b" || m.ContextWindow != 131072 || m.Tools == nil || !*m.Tools || m.ParameterSize != "27.3B" || m.Quantization != "Q4_K_M" {
		t.Fatalf("model = %+v", m)
	}
	if e := got.Models[1]; e.Value != "embed/nomic-embed-text:v1.5" || e.Tools == nil || *e.Tools {
		t.Fatalf("a model name with a slash and colons = %+v", e)
	}
	// /api/show is sent the model's name and nothing else: no prompt.
	fake.showBody.Range(func(k, _ any) bool {
		if body := k.(string); !strings.HasPrefix(body, `{"model":`) || strings.Count(body, ":") > 3 {
			t.Errorf("show body = %s", body)
		}
		return true
	})
}

func TestLocalProbeIPv6LoopbackAndTrailingSlash(t *testing.T) {
	url := startOn(t, "tcp6", "[::1]:0", newFakeOllama(qwen))
	if !strings.Contains(url, "[::1]") {
		t.Fatalf("url = %s", url)
	}
	for _, base := range []string{url, url + "/", url + "//"} {
		if got := probeOnce(t, loopbackProber(), base, "qwen3.8:27b"); got.State != localStateReady {
			t.Fatalf("%s: state = %s (%s)", base, got.State, got.Reason)
		}
	}
	// localhost resolves to a loopback address and is dialled as one.
	v4 := startOn(t, "tcp4", "127.0.0.1:0", newFakeOllama(qwen))
	local := strings.Replace(v4, "127.0.0.1", "localhost", 1)
	if got := probeOnce(t, loopbackProber(), local+"/", "qwen3.8:27b"); got.State != localStateReady {
		t.Fatalf("localhost: state = %s (%s)", got.State, got.Reason)
	}
}

func TestLocalProbeModelNamesWithColons(t *testing.T) {
	fake := newFakeOllama(qwen, fakeOllamaModel{name: "llama3:latest", tools: true, context: 65536})
	url := startOn(t, "tcp4", "127.0.0.1:0", fake)
	// "llama3" is how Ollama spells llama3:latest.
	if got := probeOnce(t, loopbackProber(), url, "llama3", "qwen3.8:27b"); got.State != localStateReady {
		t.Fatalf("state = %s (%s)", got.State, got.Reason)
	}
	// A tag is part of the name: qwen3.8:8b is not qwen3.8:27b.
	if got := probeOnce(t, loopbackProber(), url, "qwen3.8:8b"); got.State != localStateModelMissing || got.Reason != "missing:qwen3.8:8b" {
		t.Fatalf("state = %s (%s)", got.State, got.Reason)
	}
}

func TestLocalProbeFailures(t *testing.T) {
	cases := []struct {
		name   string
		path   string
		h      http.HandlerFunc
		state  string
		reason string
	}{
		{"bad JSON", "/api/version", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"version": "0.40` + localProbePrivate))
		}, localStateMalformed, "bad_json"},
		{"bad JSON in tags", "/api/tags", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`<html>` + localProbePrivate))
		}, localStateMalformed, "bad_json"},
		{"not JSON at all", "/api/version", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "text/html")
			_, _ = w.Write([]byte(`<html>` + localProbePrivate))
		}, localStateMalformed, "content_type"},
		{"another charset", "/api/version", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json; charset=iso-8859-1")
			_, _ = w.Write([]byte(`{"version":"0.40.16"}`))
		}, localStateMalformed, "charset"},
		{"invalid UTF-8", "/api/version", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte("{\"version\":\"0.40\xff\"}"))
		}, localStateMalformed, "charset"},
		{"redirect", "/api/version", func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, "http://169.254.169.254/latest/meta-data/", http.StatusFound)
		}, localStateMalformed, "redirect"},
		{"oversized", "/api/tags", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"models":[],"pad":"` + strings.Repeat("x", localProbeTagsLimit+10) + `"}`))
		}, localStateMalformed, "too_large"},
		{"oversized without a length", "/api/version", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			for i := 0; i < 10; i++ {
				_, _ = w.Write([]byte(strings.Repeat(" ", 1024)))
				w.(http.Flusher).Flush()
			}
		}, localStateMalformed, "too_large"},
		{"compressed", "/api/version", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Content-Encoding", "gzip")
			_, _ = w.Write([]byte{0x1f, 0x8b})
		}, localStateMalformed, "encoding"},
		{"server error", "/api/version", func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(localProbePrivate))
		}, localStateUnreachable, "http_500"},
		{"no version", "/api/version", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"version":"` + strings.Repeat("v", 100) + `"}`))
		}, localStateMalformed, "no_version"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			fake := newFakeOllama(qwen)
			fake.set(c.path, c.h)
			got := probeOnce(t, loopbackProber(), startOn(t, "tcp4", "127.0.0.1:0", fake), "qwen3.8:27b")
			if got.State != c.state || got.Reason != c.reason {
				t.Fatalf("state = %s (%s), want %s (%s)", got.State, got.Reason, c.state, c.reason)
			}
			if c.state != localStateReady && len(got.Models) > 0 {
				t.Fatalf("a failed probe reported models: %+v", got.Models)
			}
		})
	}
}

func TestLocalProbeConnectionRefused(t *testing.T) {
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()
	got := probeOnce(t, loopbackProber(), "http://"+addr)
	if got.State != localStateUnreachable || got.Reason != "connection_refused" || got.LatencyMs != nil || got.Models != nil {
		t.Fatalf("got %+v", got)
	}
}

func TestLocalProbeTimeout(t *testing.T) {
	// Closed before the fake servers are (a cleanup registered later runs first), so their Close does not wait.
	release := make(chan struct{})
	var once sync.Once
	free := func() { once.Do(func() { close(release) }) }
	fake := newFakeOllama(qwen)
	fake.set("/api/version", func(_ http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		case <-time.After(10 * time.Second):
		}
	})
	url := startOn(t, "tcp4", "127.0.0.1:0", fake)
	t.Cleanup(free)
	started := time.Now()
	got := probeOnce(t, loopbackProber(), url)
	if got.State != localStateUnreachable || got.Reason != "timeout" {
		t.Fatalf("got %+v", got)
	}
	if elapsed := time.Since(started); elapsed > localProbeVersionTimout+2*time.Second {
		t.Fatalf("the probe waited %s", elapsed)
	}
	// /api/show hanging costs that model its facts, never the cycle.
	slow := newFakeOllama(qwen)
	slow.set("/api/show", func(_ http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		case <-time.After(10 * time.Second):
		}
	})
	p := loopbackProber()
	p.showTimeout = 200 * time.Millisecond
	slowURL := startOn(t, "tcp4", "127.0.0.1:0", slow)
	t.Cleanup(free)
	if got := probeOnce(t, p, slowURL, "qwen3.8:27b"); got.State != localStateCapabilityMissing || got.Reason != "capabilities_unknown:qwen3.8:27b" {
		t.Fatalf("got %s (%s)", got.State, got.Reason)
	}
}

func TestLocalProbeInventoryStates(t *testing.T) {
	t.Run("no models", func(t *testing.T) {
		got := probeOnce(t, loopbackProber(), startOn(t, "tcp4", "127.0.0.1:0", newFakeOllama()), "qwen3.8:27b")
		if got.State != localStateNoModels || got.Models == nil || len(got.Models) != 0 {
			t.Fatalf("got %+v", got)
		}
	})
	t.Run("only cloud models count as none", func(t *testing.T) {
		got := probeOnce(t, loopbackProber(), startOn(t, "tcp4", "127.0.0.1:0", newFakeOllama(fakeOllamaModel{name: "gpt-oss:20b-cloud", tools: true, context: 131072})))
		if got.State != localStateNoModels {
			t.Fatalf("got %+v", got)
		}
	})
	t.Run("model removed", func(t *testing.T) {
		fake := newFakeOllama(qwen)
		url := startOn(t, "tcp4", "127.0.0.1:0", fake)
		p := loopbackProber()
		if got := probeOnce(t, p, url, "qwen3.8:27b"); got.State != localStateReady {
			t.Fatalf("before: %s", got.State)
		}
		fake.mu.Lock()
		fake.models = []fakeOllamaModel{{name: "llama3:latest", tools: true, context: 65536}}
		fake.mu.Unlock()
		if got := probeOnce(t, p, url, "qwen3.8:27b"); got.State != localStateModelMissing || len(got.Models) != 1 {
			t.Fatalf("after removal: %+v", got)
		}
	})
	t.Run("removed between tags and show", func(t *testing.T) {
		gone := qwen
		gone.removed = true
		got := probeOnce(t, loopbackProber(), startOn(t, "tcp4", "127.0.0.1:0", newFakeOllama(gone, fakeOllamaModel{name: "llama3:latest", tools: true, context: 65536})), "qwen3.8:27b")
		if got.State != localStateModelMissing || len(got.Models) != 1 || got.Models[0].Value != "llama3:latest" {
			t.Fatalf("got %+v", got)
		}
	})
	t.Run("no tools", func(t *testing.T) {
		got := probeOnce(t, loopbackProber(), startOn(t, "tcp4", "127.0.0.1:0", newFakeOllama(fakeOllamaModel{name: "gemma3:4b", context: 131072})), "gemma3:4b")
		if got.State != localStateCapabilityMissing || got.Reason != "no_tools:gemma3:4b" {
			t.Fatalf("got %s (%s)", got.State, got.Reason)
		}
	})
	t.Run("context too small", func(t *testing.T) {
		got := probeOnce(t, loopbackProber(), startOn(t, "tcp4", "127.0.0.1:0", newFakeOllama(fakeOllamaModel{name: "qwen3:4b", tools: true, context: 32768})), "qwen3:4b")
		if got.State != localStateCapabilityMissing || got.Reason != "context:qwen3:4b:32768" {
			t.Fatalf("got %s (%s)", got.State, got.Reason)
		}
	})
	t.Run("no model named: ready with any model", func(t *testing.T) {
		if got := probeOnce(t, loopbackProber(), startOn(t, "tcp4", "127.0.0.1:0", newFakeOllama(qwen))); got.State != localStateReady {
			t.Fatalf("got %s", got.State)
		}
	})
}

func TestLocalProbeShowIsCachedByDigest(t *testing.T) {
	fake := newFakeOllama(qwen)
	url := startOn(t, "tcp4", "127.0.0.1:0", fake)
	p := loopbackProber()
	target := []LocalProviderTarget{{ProviderID: "a", BaseURL: url, Models: []string{"qwen3.8:27b"}}}
	p.probeAll(context.Background(), target)
	p.probeAll(context.Background(), target)
	if n := fake.showCalls.Load(); n != 1 {
		t.Fatalf("/api/show called %d times for one unchanged model", n)
	}
	p.probeAll(context.Background(), nil)
	if len(p.cache.entries) != 0 {
		t.Fatalf("the cache kept %d entries no target holds", len(p.cache.entries))
	}
}

func TestLocalProbeEndpointPolicy(t *testing.T) {
	loop := parseLocalProbePolicy("")
	refused := map[string]string{
		"ftp://127.0.0.1:11434":                   "scheme",
		"file:///etc/passwd":                      "bad_url",
		"127.0.0.1:11434":                         "bad_url",
		"gopher://127.0.0.1:11434":                "scheme",
		"http://user:pw@127.0.0.1:11434":          "bad_url",
		"http://127.0.0.1:11434/?x=1":             "bad_url",
		"http://127.0.0.1:11434/#frag":            "bad_url",
		"http://127.0.0.1:11434/v1":               "path",
		"http://127.0.0.1:11434/api/../../":       "path",
		"http://10.0.0.5:11434":                   "not_loopback",
		"http://192.168.1.10:11434":               "not_loopback",
		"http://169.254.169.254":                  "not_loopback",
		"http://[fd00::1]:11434":                  "not_loopback",
		"http://0.0.0.0:11434":                    "not_loopback",
		"http://ollama.example.com":               "not_loopback",
		"http://127.0.0.1.nip.io:11434":           "not_loopback",
		"http://127.0.0.1:99999":                  "bad_url",
		"http://[::ffff:169.254.169.254]:11434":   "not_loopback",
		"https://metadata.google.internal/":       "not_loopback",
		"http://localhost.attacker.example:11434": "not_loopback",
	}
	for raw, want := range refused {
		_, err := parseLocalEndpoint(raw, loop)
		r, ok := err.(*errLocalRefused)
		if !ok || r.reason != want {
			t.Errorf("%s: err = %v, want refused %s", raw, err, want)
		}
	}
	for _, raw := range []string{"http://127.0.0.1:11434", "http://127.0.0.2:11434/", "https://[::1]:11434", "http://localhost:11434", "HTTP://LOCALHOST:11434/"} {
		if _, err := parseLocalEndpoint(raw, loop); err != nil {
			t.Errorf("%s: %v", raw, err)
		}
	}
	// The runner's own configuration allows more, and only what it names.
	allow := parseLocalProbePolicy("gpu-box.lan, 10.1.0.0/16 192.168.7.7")
	for _, raw := range []string{"http://gpu-box.lan:11434", "http://10.1.2.3:11434", "http://192.168.7.7:11434"} {
		if _, err := parseLocalEndpoint(raw, allow); err != nil {
			t.Errorf("allowed %s: %v", raw, err)
		}
	}
	for _, raw := range []string{"http://10.2.0.1:11434", "http://192.168.7.8:11434", "http://other.lan"} {
		if _, err := parseLocalEndpoint(raw, allow); err == nil {
			t.Errorf("%s allowed", raw)
		}
	}
	got := probeOnce(t, loopbackProber(), "http://10.0.0.5:11434")
	if got.State != localStateRefused || got.Reason != "not_loopback" || got.LatencyMs != nil {
		t.Fatalf("got %+v", got)
	}
}

// "localhost" is a name: if it resolves somewhere else, the dial is refused at connect time.
func TestLocalProbeDialHoldsTheAddressToLoopback(t *testing.T) {
	ep := localEndpoint{origin: "http://203.0.113.9:11434"}
	client := localProbeClient(ep, parseLocalProbePolicy(""))
	var out map[string]any
	failed := localCall(context.Background(), client, ep.origin, http.MethodGet, "/api/version", nil, 1024, time.Second, &out)
	if failed == nil || failed.state != localStateRefused || failed.reason != "not_loopback" {
		t.Fatalf("got %+v", failed)
	}
}

// A proxy in the environment is never used: the probe speaks to the server directly.
func TestLocalProbeIgnoresProxyEnvironment(t *testing.T) {
	var proxied atomic.Bool
	proxy := startOn(t, "tcp4", "127.0.0.1:0", http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		proxied.Store(true)
		w.WriteHeader(http.StatusBadGateway)
	}))
	t.Setenv("HTTP_PROXY", proxy)
	t.Setenv("http_proxy", proxy)
	t.Setenv("NO_PROXY", "")
	if got := probeOnce(t, loopbackProber(), startOn(t, "tcp4", "127.0.0.1:0", newFakeOllama(qwen)), "qwen3.8:27b"); got.State != localStateReady {
		t.Fatalf("got %s (%s)", got.State, got.Reason)
	}
	if proxied.Load() {
		t.Fatal("the probe went through the environment's proxy")
	}
}

// Two providers on two servers are probed apart: each report names its own provider and its own models.
func TestLocalProbeLoopKeepsTargetsApart(t *testing.T) {
	a := startOn(t, "tcp4", "127.0.0.1:0", newFakeOllama(qwen))
	b := startOn(t, "tcp4", "127.0.0.1:0", newFakeOllama(fakeOllamaModel{name: "llama3:latest", tools: true, context: 65536}))
	loop := newLocalProviderProbe(loopbackProber(), time.Hour)
	if loop.snapshot() != nil {
		t.Fatal("a snapshot before any probe must be nil")
	}
	ctx, cancel := context.WithCancel(context.Background())
	go loop.run(ctx)
	defer func() { cancel(); loop.wait() }()
	loop.trigger([]LocalProviderTarget{
		{ProviderID: "pa", BaseURL: a, Models: []string{"qwen3.8:27b"}},
		{ProviderID: "pb", BaseURL: b, Models: []string{"llama3"}},
	})
	deadline := time.Now().Add(10 * time.Second)
	var snap []LocalProviderProbe
	for time.Now().Before(deadline) {
		if snap = loop.snapshot(); snap != nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if len(snap) != 2 {
		t.Fatalf("snapshot = %+v", snap)
	}
	for _, s := range snap {
		want := map[string]string{"pa": "qwen3.8:27b", "pb": "llama3:latest"}[s.ProviderID]
		if s.State != localStateReady || len(s.Models) != 1 || s.Models[0].Value != want {
			t.Fatalf("%s: %+v", s.ProviderID, s)
		}
	}
	// A target the control plane stops naming leaves the report at once, before it is probed again.
	loop.trigger([]LocalProviderTarget{{ProviderID: "pa", BaseURL: a, Models: []string{"qwen3.8:27b"}}})
	if snap := loop.snapshot(); len(snap) != 1 || snap[0].ProviderID != "pa" {
		t.Fatalf("snapshot after the target set shrank = %+v", snap)
	}
}

// The heartbeat body carries the probe as @orbit/shared LocalProviderProbe spells it.
func TestLocalProbeHeartbeatShape(t *testing.T) {
	latency := int64(3)
	tools := true
	body, _ := json.Marshal(HeartbeatRequest{LocalProviderProbes: []LocalProviderProbe{{
		ProviderID: "p", BaseURL: "http://127.0.0.1:11434", State: localStateReady, Version: "0.40.16",
		CheckedAt: "2026-11-14T00:00:00Z", LatencyMs: &latency,
		Models: []LocalInstanceModel{{Value: "qwen3.8:27b", ContextWindow: 131072, Tools: &tools, ParameterSize: "27.3B", Quantization: "Q4_K_M"}},
	}}})
	want := `"localProviderProbes":[{"providerId":"p","baseUrl":"http://127.0.0.1:11434","state":"READY","version":"0.40.16","checkedAt":"2026-11-14T00:00:00Z","latencyMs":3,"models":[{"value":"qwen3.8:27b","contextWindow":131072,"tools":true,"parameterSize":"27.3B","quantization":"Q4_K_M"}]}]`
	if !strings.Contains(string(body), want) {
		t.Fatalf("body = %s", body)
	}
	var resp HeartbeatResponse
	if err := json.Unmarshal([]byte(`{"localProviders":[{"providerId":"p","baseUrl":"http://127.0.0.1:11434","models":["qwen3.8:27b"]}]}`), &resp); err != nil || len(resp.LocalProviders) != 1 || resp.LocalProviders[0].Models[0] != "qwen3.8:27b" {
		t.Fatalf("resp = %+v, %v", resp, err)
	}
	if !strings.Contains(","+runnerCapabilitiesV1+",", ","+localProbeCapabilityV1+",") {
		t.Fatal("the runner does not declare ollama-probe/v1")
	}
}
