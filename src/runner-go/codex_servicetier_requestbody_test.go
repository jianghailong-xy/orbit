package main

// Whether Orbit's Codex fast lane actually reaches the Responses API, read off the requests a real
// `codex` makes.
//
// Here for the reason codex_steer_protocol_test.go gives for asking the installed engine rather
// than trusting a comment, and one more: codex does not refuse a service tier it will not use. A
// tier the model's catalogue does not advertise is logged ("… will be omitted from requests") and
// dropped, with the thread/turn request still answered OK. So a suite that only read Orbit's own
// params would stay green on a tier id that never reaches the API — which is exactly what `flex`
// below does.
//
// The probe stands where the API is: a custom model provider (the same `model_providers` door
// Orbit's BYOK path uses, on the `responses` wire) points at a local recorder that captures the
// first POST /v1/responses and answers 500. Nothing needs a login, nothing reaches the network,
// and nothing costs tokens — the request body is built and sent before any answer matters. Every
// arm drives production's own builders (codexThreadParams, codexTurnParams, codexExecCommandArgs),
// so what is measured is Orbit's bytes and not a re-typing of them. It skips without a `codex` on
// PATH, like every other real-engine test here.

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// A model whose catalogue row advertises the priority tier. Any listed model does today; the probe
// names one so a catalogue change that dropped the tier would read as a failure of this row, not
// as an unexplained silence.
const codexTierProbeModel = "gpt-6-astra"

// codexTierAbsent is what a request that names no tier reads as.
const codexTierAbsent = "<absent>"

// A session in fast mode sends `service_tier: "priority"` on both Codex paths, and one that is not
// sends no tier at all.
func TestRealCodexFastServiceTierReachesTheResponsesRequest(t *testing.T) {
	for _, tc := range []struct {
		name string
		fast bool
		want string
	}{
		{name: "fast mode on", fast: true, want: codexFastServiceTier},
		{name: "fast mode off", fast: false, want: codexTierAbsent},
	} {
		t.Run(tc.name+" over app-server", func(t *testing.T) {
			job := &ClaimedSession{Agent: AgentExecConfig{Model: codexTierProbeModel, FastMode: tc.fast}}
			if got := driveCodexAppServerTierProbe(t, job, nil); got != tc.want {
				t.Fatalf("the Responses request carried service_tier %q, want %q", got, tc.want)
			}
		})
		t.Run(tc.name+" over exec", func(t *testing.T) {
			job := &ClaimedSession{Agent: AgentExecConfig{Model: codexTierProbeModel, FastMode: tc.fast}}
			if got := driveCodexExecTierProbe(t, job); got != tc.want {
				t.Fatalf("the Responses request carried service_tier %q, want %q", got, tc.want)
			}
		})
	}
}

// Why the id Orbit sends is the catalogue's and not a spelling that happens to work: codex accepts
// the `fast` alias today, but it quietly drops any tier the catalogue does not advertise. `flex` is
// the control that proves the recorder can see a DROPPED tier as absent — without it, "the request
// said priority" could not be told apart from "the request says priority whatever you send".
func TestRealCodexDropsATierTheCatalogueDoesNotAdvertise(t *testing.T) {
	for _, tc := range []struct{ sent, want string }{
		{sent: "fast", want: codexFastServiceTier},
		{sent: "flex", want: codexTierAbsent},
	} {
		t.Run(tc.sent, func(t *testing.T) {
			job := &ClaimedSession{Agent: AgentExecConfig{Model: codexTierProbeModel}}
			override := tc.sent
			if got := driveCodexAppServerTierProbe(t, job, &override); got != tc.want {
				t.Fatalf("serviceTier %q went out as %q, want %q", tc.sent, got, tc.want)
			}
		})
	}
}

// codexTierRecorder captures the first Responses request's service_tier and answers every request
// with a 500, which ends the turn without codex ever needing a real reply.
type codexTierRecorder struct {
	mu    sync.Mutex
	tier  string
	seen  bool
	first chan struct{}
	once  sync.Once
}

func newCodexTierRecorder() *codexTierRecorder {
	return &codexTierRecorder{first: make(chan struct{})}
}

func (rec *codexTierRecorder) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/responses") {
		var req map[string]interface{}
		_ = json.Unmarshal(body, &req)
		rec.mu.Lock()
		if !rec.seen {
			rec.seen = true
			rec.tier = codexTierAbsent
			if v, ok := req["service_tier"].(string); ok {
				rec.tier = v
			}
		}
		rec.mu.Unlock()
		rec.once.Do(func() { close(rec.first) })
	}
	w.WriteHeader(http.StatusInternalServerError)
	_, _ = w.Write([]byte(`{"error":{"message":"orbit service tier probe"}}`))
}

func (rec *codexTierRecorder) wait(t *testing.T) string {
	t.Helper()
	select {
	case <-rec.first:
	case <-time.After(90 * time.Second):
		t.Fatal("codex sent no Responses request within 90s")
	}
	rec.mu.Lock()
	defer rec.mu.Unlock()
	return rec.tier
}

// codexTierProbeConfig is the provider block that points codex at the recorder. It stands in for
// the account a real session signs in with; everything Orbit itself decides stays production's.
func codexTierProbeConfig(t *testing.T, apiURL string) (args, env []string) {
	t.Helper()
	env, home := isolatedCodexProbeEnv(t)
	env = envWithValue(env, "ORBIT_TIER_PROBE_KEY", "sk-orbit-probe")
	return []string{
		"-c", fmt.Sprintf("sqlite_home=%q", filepath.Join(home, "state")),
		"-c", `model_providers.orbitprobe.name="Orbit tier probe"`,
		"-c", fmt.Sprintf("model_providers.orbitprobe.base_url=%q", apiURL+"/v1"),
		"-c", `model_providers.orbitprobe.env_key="ORBIT_TIER_PROBE_KEY"`,
		"-c", `model_providers.orbitprobe.wire_api="responses"`,
		"-c", `model_provider="orbitprobe"`,
	}, env
}

// driveCodexAppServerTierProbe opens a thread and starts one turn with production's params, and
// returns the tier the resulting Responses request carried. `override` replaces the serviceTier
// Orbit would have sent, for the controls that measure codex rather than Orbit.
func driveCodexAppServerTierProbe(t *testing.T, job *ClaimedSession, override *string) string {
	t.Helper()
	exe, err := exec.LookPath("codex")
	if err != nil {
		t.Skip("no codex on PATH; this probe needs a real app-server")
	}
	rec := newCodexTierRecorder()
	api := httptest.NewServer(rec)
	t.Cleanup(api.Close)
	config, env := codexTierProbeConfig(t, api.URL)
	cmd := exec.Command(exe, append([]string{"app-server", "--stdio"}, config...)...)
	cmd.Env = env
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Skipf("cannot run %s app-server: %v", exe, err)
	}
	t.Cleanup(func() { stdin.Close(); _ = cmd.Process.Kill(); _ = cmd.Wait() })
	p := &codexAppServerProbe{t: t, cmd: cmd, out: bufio.NewReaderSize(stdout, 1<<20)}
	send := func(msg map[string]interface{}) {
		b, _ := json.Marshal(msg)
		if _, err := stdin.Write(append(b, '\n')); err != nil {
			t.Fatalf("write %v: %v", msg["method"], err)
		}
	}
	request := func(method string, params map[string]interface{}) codexRPCMessage {
		p.next++
		id := p.next
		send(map[string]interface{}{"id": id, "method": method, "params": params})
		for {
			line, err := p.out.ReadBytes('\n')
			if err != nil {
				t.Fatalf("reading the response to %s: %v", method, err)
			}
			var msg codexRPCMessage
			if json.Unmarshal(line, &msg) != nil {
				continue
			}
			if msg.Method == "" && fmt.Sprint(msg.ID) == fmt.Sprint(id) {
				return msg
			}
		}
	}
	request("initialize", map[string]interface{}{
		"clientInfo":   map[string]interface{}{"name": "orbit-test", "title": "Orbit", "version": "0.1.0"},
		"capabilities": map[string]interface{}{"experimentalApi": true},
	})
	send(map[string]interface{}{"method": "initialized", "params": map[string]interface{}{}})

	dir := t.TempDir()
	thread := codexThreadParams(job, dir, dir)
	turn := codexTurnParams("", job, dir, dir, "orbit-tier-probe-turn", "Say DONE.", nil, codexTurnContextOptions{})
	if override != nil {
		turn["serviceTier"] = *override
	}
	started := request("thread/start", thread)
	if started.Error != nil {
		t.Fatalf("thread/start: %v", started.Error.Message)
	}
	threadID := threadIDFromResult(rawObject(started.Result))
	if threadID == "" {
		t.Fatalf("thread/start returned no thread id: %s", started.Result)
	}
	turn["threadId"] = threadID
	if resp := request("turn/start", turn); resp.Error != nil {
		t.Fatalf("turn/start: %v", resp.Error.Message)
	}
	return rec.wait(t)
}

// driveCodexExecTierProbe runs production's exec argv against the recorder and returns the tier
// its Responses request carried.
func driveCodexExecTierProbe(t *testing.T, job *ClaimedSession) string {
	t.Helper()
	exe, err := exec.LookPath("codex")
	if err != nil {
		t.Skip("no codex on PATH; this probe needs a real codex")
	}
	rec := newCodexTierRecorder()
	api := httptest.NewServer(rec)
	t.Cleanup(api.Close)
	config, env := codexTierProbeConfig(t, api.URL)
	dir := t.TempDir()
	// Production's argv with no Orbit executable (so no MCP server is launched) and the probe's
	// provider block spliced in ahead of the trailing "-" that reads the prompt from stdin.
	args := codexExecCommandArgs(job, dir, dir, nil, "")
	args = append(append(args[:len(args)-1:len(args)-1], config...), "-")
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	cmd := exec.CommandContext(ctx, exe, args...)
	cmd.Env = env
	cmd.Stdin = strings.NewReader("Say DONE.")
	cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
	if err := cmd.Start(); err != nil {
		t.Skipf("cannot run %s exec: %v", exe, err)
	}
	t.Cleanup(func() { cancel(); _ = cmd.Wait() })
	return rec.wait(t)
}
