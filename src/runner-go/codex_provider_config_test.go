package main

// Whether the provider block Orbit hands codex for a configured (BYOK) provider is one the
// installed codex will even load.
//
// It was not, for months, and nothing noticed: `codexProviderArgs` wrote `wire_api = "chat"`, and
// every codex release on this fleet — measured on 0.149.0 through 0.154.0 — refuses that at config
// load ("`wire_api = "chat"` is no longer supported") and exits before making a single request. A
// unit test of the argv would have gone on asserting the spelling that kills the session. So this
// asks the engine: production's own `codexProviderArgs`, pointed at a local recorder, on both ways
// Orbit starts codex, and the only thing that counts is a request reaching the recorder — proof the
// config loaded and a turn was built. No login, no network, no tokens; it skips without a codex.

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

func TestCodexProviderArgsLoadInTheInstalledCodex(t *testing.T) {
	for _, path := range []string{"exec", "app-server"} {
		t.Run(path, func(t *testing.T) {
			exe, err := exec.LookPath("codex")
			if err != nil {
				t.Skip("no codex on PATH; this check needs the real engine")
			}
			rec := newCodexProviderRecorder()
			api := httptest.NewServer(rec)
			t.Cleanup(api.Close)
			// Exactly what the apiserver injects for a codex-runtime provider (custom-provider.ts
			// injectedEnv): the endpoint and the key, nothing else.
			agentEnv := map[string]string{"OPENAI_BASE_URL": api.URL + "/v1", "OPENAI_API_KEY": "sk-orbit-probe"}
			providerArgs := codexProviderArgs(agentEnv)
			if len(providerArgs) == 0 {
				t.Fatal("codexProviderArgs returned nothing for an injected OPENAI_BASE_URL")
			}
			env, home := isolatedCodexProbeEnv(t)
			env = envWithValue(env, "OPENAI_API_KEY", agentEnv["OPENAI_API_KEY"])
			state := []string{"-c", fmt.Sprintf("sqlite_home=%q", filepath.Join(home, "state"))}
			job := &ClaimedSession{Agent: AgentExecConfig{Model: "gpt-5.5", Env: agentEnv}}
			dir := t.TempDir()

			ctx, cancel := context.WithCancel(context.Background())
			t.Cleanup(cancel)
			var output strings.Builder
			var outputMu sync.Mutex
			logged := func() string {
				outputMu.Lock()
				defer outputMu.Unlock()
				return output.String()
			}
			var cmd *exec.Cmd
			switch path {
			case "exec":
				// Production's own exec argv already carries codexProviderArgs; only the state dir
				// is added, ahead of the trailing "-" that reads the prompt from stdin.
				args := codexExecCommandArgs(job, dir, dir, nil, "")
				args = append(append(args[:len(args)-1:len(args)-1], state...), "-")
				cmd = exec.CommandContext(ctx, exe, args...)
				cmd.Stdin = strings.NewReader("Say DONE.")
			case "app-server":
				// Production's own app-server argv (which appends codexProviderArgs) minus the Orbit
				// MCP server, so no helper process is launched.
				args := codexAppServerCommandArgs(job, filepath.Join(home, "state"), "")
				cmd = exec.CommandContext(ctx, exe, args...)
			}
			cmd.Env = env
			cmd.Stderr = codexProbeWriter{&output, &outputMu}
			var stdin io.WriteCloser
			var stdout io.ReadCloser
			if path == "app-server" {
				stdin, _ = cmd.StdinPipe()
				stdout, _ = cmd.StdoutPipe()
			} else {
				cmd.Stdout = codexProbeWriter{&output, &outputMu}
			}
			if err := cmd.Start(); err != nil {
				t.Fatalf("starting codex %s: %v", path, err)
			}
			exited := make(chan struct{})
			go func() { _ = cmd.Wait(); close(exited) }()
			t.Cleanup(func() { cancel(); <-exited })

			if path == "app-server" {
				driveCodexProviderAppServer(t, stdin, stdout, job, dir, exited, logged)
			}
			select {
			case <-rec.first:
			case <-exited:
				t.Fatalf("codex %s exited before sending any request with Orbit's provider config:\n%s", path, logged())
			case <-time.After(90 * time.Second):
				t.Fatalf("codex %s sent no request within 90s:\n%s", path, logged())
			}
			if got := rec.path(); !strings.HasSuffix(got, "/responses") {
				t.Errorf("codex %s called %q; Orbit's provider block is meant to put it on the Responses API", path, got)
			}
		})
	}
}

// codexProbeWriter lets the engine's stderr be read while it is still being written.
type codexProbeWriter struct {
	b  *strings.Builder
	mu *sync.Mutex
}

func (w codexProbeWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.b.Write(p)
}

// driveCodexProviderAppServer initializes the app-server and starts one turn with production's own
// thread and turn params. A config the engine refused never gets this far: it has already exited.
func driveCodexProviderAppServer(t *testing.T, stdin io.WriteCloser, stdout io.Reader, job *ClaimedSession, dir string, exited <-chan struct{}, logged func() string) {
	t.Helper()
	lines := make(chan []byte, 64)
	go func() {
		rd := bufio.NewReaderSize(stdout, 1<<20)
		for {
			line, err := rd.ReadBytes('\n')
			if err != nil {
				close(lines)
				return
			}
			lines <- line
		}
	}()
	next := 0
	request := func(method string, params map[string]interface{}) map[string]interface{} {
		next++
		id := next
		b, _ := json.Marshal(map[string]interface{}{"id": id, "method": method, "params": params})
		if _, err := stdin.Write(append(b, '\n')); err != nil {
			t.Fatalf("codex app-server is gone before %s (its config was refused?):\n%s", method, logged())
		}
		for {
			select {
			case line, ok := <-lines:
				if !ok {
					t.Fatalf("codex app-server exited during %s:\n%s", method, logged())
				}
				var msg map[string]interface{}
				if json.Unmarshal(line, &msg) != nil {
					continue
				}
				if _, isNotification := msg["method"]; isNotification {
					continue
				}
				if fmt.Sprint(msg["id"]) == fmt.Sprint(id) {
					if e, bad := msg["error"]; bad {
						t.Fatalf("%s: %v", method, e)
					}
					result, _ := msg["result"].(map[string]interface{})
					return result
				}
			case <-exited:
				t.Fatalf("codex app-server exited during %s:\n%s", method, logged())
			case <-time.After(90 * time.Second):
				t.Fatalf("no answer to %s within 90s:\n%s", method, logged())
			}
		}
	}
	request("initialize", map[string]interface{}{
		"clientInfo":   map[string]interface{}{"name": "orbit-test", "title": "Orbit", "version": "0.1.0"},
		"capabilities": map[string]interface{}{"experimentalApi": true},
	})
	b, _ := json.Marshal(map[string]interface{}{"method": "initialized", "params": map[string]interface{}{}})
	_, _ = stdin.Write(append(b, '\n'))
	threadID := threadIDFromResult(request("thread/start", codexThreadParams(job, dir, dir)))
	if threadID == "" {
		t.Fatal("thread/start returned no thread id")
	}
	request("turn/start", codexTurnParams(threadID, job, dir, dir, "orbit-provider-probe-turn", "Say DONE.", nil, codexTurnContextOptions{}))
}

// codexProviderRecorder notes the path of the first POST it receives and fails every request, which
// ends the turn without codex needing a real answer.
type codexProviderRecorder struct {
	mu    sync.Mutex
	first chan struct{}
	once  sync.Once
	seen  string
}

func newCodexProviderRecorder() *codexProviderRecorder {
	return &codexProviderRecorder{first: make(chan struct{})}
}

func (rec *codexProviderRecorder) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	_, _ = io.ReadAll(r.Body)
	if r.Method == http.MethodPost {
		rec.once.Do(func() {
			rec.mu.Lock()
			rec.seen = r.URL.Path
			rec.mu.Unlock()
			close(rec.first)
		})
	}
	w.WriteHeader(http.StatusInternalServerError)
	_, _ = w.Write([]byte(`{"error":{"message":"orbit provider config probe"}}`))
}

func (rec *codexProviderRecorder) path() string {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	return rec.seen
}
