//go:build linux

package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// googleSignInPlaceholder is a Google sign-in in the shape agy 1.2.16 keeps one — the shape
// google-auth-credential-file.json records, types only — with every value a placeholder. "consumer" is
// the auth_method agy takes as a Google OAuth sign-in (it refuses any other before asking Google
// anything), and the expiry is long past, so agy has to refresh it: Google refuses the placeholder
// refresh token (testdata/antigravity/google-session-auth-failures.json).
func googleSignInPlaceholder(t *testing.T) []byte {
	t.Helper()
	body, err := os.ReadFile(filepath.Join("..", "..", "docs", "evidence", "antigravity-cli-1.2.16", "google-auth-credential-file.json"))
	if err != nil {
		t.Fatal(err)
	}
	var recorded struct {
		Shape map[string]interface{} `json:"token_structure_types_only"`
	}
	if err := json.Unmarshal(body, &recorded); err != nil || len(recorded.Shape) == 0 {
		t.Fatalf("recorded credential shape: %v", err)
	}
	var fill func(map[string]interface{}) map[string]interface{}
	fill = func(shape map[string]interface{}) map[string]interface{} {
		out := map[string]interface{}{}
		for key, kind := range shape {
			switch kind := kind.(type) {
			case map[string]interface{}:
				out[key] = fill(kind)
			case string:
				if kind != "str" {
					t.Fatalf("recorded field %s is a %s", key, kind)
				}
				out[key] = "orbit-placeholder-" + key
			}
		}
		return out
	}
	token := fill(recorded.Shape)
	inner, ok := token["token"].(map[string]interface{})
	if !ok {
		t.Fatal("the recorded shape has no token object")
	}
	token["auth_method"] = "consumer"
	inner["token_type"] = "Bearer"
	inner["expiry"] = "2000-01-01T00:00:00Z"
	out, err := json.Marshal(token)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// saveGoogleSignIn puts a placeholder sign-in where the runner keeps its own, and returns it.
func saveGoogleSignIn(t *testing.T) []byte {
	t.Helper()
	token := googleSignInPlaceholder(t)
	if err := os.MkdirAll(filepath.Dir(antigravityGoogleTokenPath()), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(antigravityGoogleTokenPath(), token, 0o600); err != nil {
		t.Fatal(err)
	}
	return token
}

// countEngineSignOuts stands in for the run loop's re-probe (noteEngineSignedOut) and counts its calls.
func countEngineSignOuts(t *testing.T) *atomic.Int32 {
	t.Helper()
	var n atomic.Int32
	seen := func() { n.Add(1) }
	previous := engineSignedOutSeen.Load()
	engineSignedOutSeen.Store(&seen)
	t.Cleanup(func() { engineSignedOutSeen.Store(previous) })
	return &n
}

// captureRunnerLog sends what logln writes to a file for the rest of the test.
func captureRunnerLog(t *testing.T) func() string {
	t.Helper()
	f, err := os.CreateTemp(t.TempDir(), "runner-log")
	if err != nil {
		t.Fatal(err)
	}
	previous := os.Stdout
	os.Stdout = f
	t.Cleanup(func() { os.Stdout = previous; _ = f.Close() })
	return func() string {
		body, _ := os.ReadFile(f.Name())
		return string(body)
	}
}

type googleSessionFailures struct {
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	ExitCode int    `json:"exit_code"`
	Cases    map[string]struct {
		LogLines []string `json:"log_lines"`
	} `json:"cases"`
}

func loadGoogleSessionFailures(t *testing.T) googleSessionFailures {
	t.Helper()
	body, err := os.ReadFile(filepath.Join("testdata", "antigravity", "google-session-auth-failures.json"))
	if err != nil {
		t.Fatal(err)
	}
	var measured googleSessionFailures
	if err := json.Unmarshal(body, &measured); err != nil {
		t.Fatal(err)
	}
	return measured
}

func TestAntigravityGoogleSessionClassifiesHowAgyEnded(t *testing.T) {
	invalid := loadGoogleProbeRecording(t, "google-auth-invalid-refresh.json")
	held := loadGoogleProbeRecording(t, "google-auth-held-stream.json")
	measured := loadGoogleSessionFailures(t)
	logOf := func(name string) []byte {
		lines := measured.Cases[name].LogLines
		if len(lines) == 0 {
			t.Fatalf("no log lines recorded for %s", name)
		}
		return []byte(strings.Join(lines, "\n"))
	}
	for _, test := range []struct {
		name        string
		exitCode    int
		initialized bool
		stderr      string
		log         []byte
		want        agyAuthEnd
	}{
		{"invalid-refresh", invalid.ExitCode, false, invalid.Stderr, nil, agyAuthEndRefused},
		{"held-stream", held.ExitCode, false, held.Stderr, nil, agyAuthEndRefused},
		{"refused-per-log", measured.ExitCode, false, measured.Stderr, logOf("refused"), agyAuthEndRefused},
		// The same three outputs, put down to the network by agy's own log.
		{"proxy-refused", measured.ExitCode, false, measured.Stderr, logOf("network_proxy_refused"), agyAuthEndNetwork},
		{"dns", measured.ExitCode, false, measured.Stderr, logOf("network_dns"), agyAuthEndNetwork},
		{"after-init", invalid.ExitCode, true, invalid.Stderr, nil, agyAuthEndOther},
		{"model-error-exit", 3, false, invalid.Stderr, nil, agyAuthEndOther},
		{"exit-zero", 0, false, invalid.Stderr, nil, agyAuthEndOther},
		{"killed", -1, false, invalid.Stderr, nil, agyAuthEndOther},
		{"one-message", 1, false, "error: authentication failed or timed out", nil, agyAuthEndOther},
	} {
		if got := classifyAgyAuthEnd(test.exitCode, test.initialized, test.stderr, test.log); got != test.want {
			t.Errorf("%s: classified %d, want %d", test.name, got, test.want)
		}
	}
}

func TestAntigravityGoogleSessionAuthSource(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	t.Setenv("GEMINI_API_KEY", "")
	builtIn := &ClaimedSession{SessionID: "s", Provider: providerAntigravity}
	provider := &ClaimedSession{SessionID: "s", Provider: providerAntigravity, Agent: AgentExecConfig{Env: map[string]string{"GEMINI_API_KEY": "provider-key"}}}
	blank := &ClaimedSession{SessionID: "s", Provider: providerAntigravity, Agent: AgentExecConfig{Env: map[string]string{"GEMINI_API_KEY": " "}}}
	check := func(job *ClaimedSession, want string) {
		t.Helper()
		if got := antigravitySessionAuth(job); got != want {
			t.Fatalf("auth source = %q, want %q", got, want)
		}
	}
	check(builtIn, antigravityAuthNone)
	check(provider, antigravityAuthSessionKey)
	t.Setenv("GEMINI_API_KEY", "runner-key")
	check(builtIn, antigravityAuthEnvKey)
	saveGoogleSignIn(t)
	// The runner's sign-in comes before its key, as in its engine health; a key the session brings
	// comes before both: a Gemini provider never runs on the runner's account.
	check(builtIn, antigravityAuthGoogle)
	check(blank, antigravityAuthGoogle)
	check(provider, antigravityAuthSessionKey)
	if err := os.Remove(antigravityGoogleTokenPath()); err != nil {
		t.Fatal(err)
	}
	check(builtIn, antigravityAuthEnvKey)
}

func TestAntigravityGoogleSessionSettingsInBothModes(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ORBIT_HOME", t.TempDir())
	token := saveGoogleSignIn(t)
	job := &ClaimedSession{SessionID: "s1", TaskID: "task-1", Agent: AgentExecConfig{
		PermissionMode:     "default",
		AppendSystemPrompt: "Answer in haiku.",
		AllowedTools:       []string{"Bash(git status:*)"},
		DisallowedTools:    []string{"Read(/etc/shadow)"},
		McpConfig:          map[string]interface{}{"docs": map[string]interface{}{"command": "docs-mcp", "args": []interface{}{"--stdio"}}},
	}}
	type written struct {
		settings   map[string]interface{}
		mcp, rules string
	}
	read := func(dir string) written {
		t.Helper()
		var w written
		readJSONFile(t, filepath.Join(dir, "antigravity-cli", "settings.json"), &w.settings)
		mcp, err := os.ReadFile(filepath.Join(dir, "config", "mcp_config.json"))
		if err != nil {
			t.Fatal(err)
		}
		rules, err := os.ReadFile(filepath.Join(dir, "GEMINI.md"))
		if err != nil {
			t.Fatal(err)
		}
		w.mcp, w.rules = string(mcp), string(rules)
		return w
	}
	googleScratch := t.TempDir()
	apiDir, err := prepareAntigravityGeminiDir(t.TempDir(), job, "/opt/orbit/bin/orbit", false)
	if err != nil {
		t.Fatal(err)
	}
	googleDir, err := prepareAntigravityGeminiDir(googleScratch, job, "/opt/orbit/bin/orbit", true)
	if err != nil {
		t.Fatal(err)
	}
	api, google := read(apiDir), read(googleDir)
	if api.settings["modelProvider"] != "gemini" {
		t.Fatalf("API-key settings = %v", api.settings)
	}
	if _, ok := api.settings["useG1Credits"]; ok {
		t.Fatalf("API-key settings changed: %v", api.settings)
	}
	if _, ok := google.settings["modelProvider"]; ok || google.settings["useG1Credits"] != false {
		t.Fatalf("Google settings = %v, want no modelProvider and useG1Credits false", google.settings)
	}
	delete(api.settings, "modelProvider")
	delete(google.settings, "useG1Credits")
	if !reflect.DeepEqual(api.settings, google.settings) || google.settings["enableTelemetry"] != false || google.settings["permissions"] == nil {
		t.Fatalf("the modes differ beyond the sign-in:\nAPI    %v\nGoogle %v", api.settings, google.settings)
	}
	if api.mcp != google.mcp || api.rules != google.rules {
		t.Fatal("MCP servers or rules differ between the modes")
	}
	copyPath := antigravityTokenFile(googleDir)
	if info, err := os.Stat(copyPath); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("Google mode's sign-in copy: %v %v", info, err)
	}
	if got, _ := os.ReadFile(copyPath); string(got) != string(token) {
		t.Fatal("the copy is not the runner's sign-in")
	}
	if info, err := os.Lstat(copyPath); err != nil || info.Mode()&os.ModeSymlink != 0 {
		t.Fatal("the copy must be a file of its own, not a link")
	}
	if _, err := os.Stat(antigravityTokenFile(apiDir)); !os.IsNotExist(err) {
		t.Fatalf("an API-key spawn got a sign-in copy: %v", err)
	}
	// The same session back on a key — a reload onto a Gemini provider — keeps no copy.
	if _, err := prepareAntigravityGeminiDir(googleScratch, job, "/opt/orbit/bin/orbit", false); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(copyPath); !os.IsNotExist(err) {
		t.Fatalf("a spawn on a key left the Google sign-in copy in place: %v", err)
	}
	if got, err := os.ReadFile(antigravityGoogleTokenPath()); err != nil || string(got) != string(token) {
		t.Fatal("preparing a session touched the runner's own sign-in")
	}
}

func TestAntigravityGoogleSessionLeftoverCopiesAreRemoved(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	token := saveGoogleSignIn(t)
	var copies []string
	for _, id := range []string{"session-a", "session-b"} {
		path := antigravityTokenFile(filepath.Join(runDir(id), "antigravity"))
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, token, 0o600); err != nil {
			t.Fatal(err)
		}
		copies = append(copies, path)
	}
	settings := filepath.Join(runDir("session-a"), "antigravity", "antigravity-cli", "settings.json")
	if err := os.WriteFile(settings, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(runsDir(), "not-a-session"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	pruneAntigravityTokenCopies()
	for _, path := range copies {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("leftover copy %s: %v", path, err)
		}
	}
	if _, err := os.Stat(settings); err != nil {
		t.Fatal("the prune removed more than sign-in copies")
	}
	if got, err := os.ReadFile(antigravityGoogleTokenPath()); err != nil || string(got) != string(token) {
		t.Fatal("the prune touched the runner's own sign-in")
	}
}

// fakeGoogleAgy stands in for agy in the session tests here. Each start appends what it was started
// with to $AGY_FAKE_DIR/starts — its argv, whether stdin is a pipe, the sign-in copy in its Gemini
// directory (mode and content), the credential and D-Bus variables it inherited — then speaks just
// enough stream-json: an init, and a reply and a result for each stdin line, exiting when stdin
// closes. From start number $AGY_FAKE_REFUSE_FROM on it instead ends as $AGY_FAKE_DIR/{stdout,stderr,
// exit} say, having written $AGY_FAKE_DIR/agy.log, when there is one, to its --log-file.
const fakeGoogleAgy = `gd=""; logfile=""
for a in "$@"; do case "$a" in --gemini_dir=*) gd="${a#*=}" ;; --log-file=*) logfile="${a#*=}" ;; esac; done
n=$(( $(cat "$AGY_FAKE_DIR/count" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$AGY_FAKE_DIR/count"
tok="$gd/antigravity-cli/antigravity-oauth-token"
pipe=no; [ -p /dev/stdin ] && pipe=yes
{
  printf 'start %s\n' "$n"
  printf 'argv %s\n' "$*"
  printf 'stdin-pipe %s\n' "$pipe"
  printf 'copy-mode %s\n' "$(ls -ln "$tok" 2>/dev/null | cut -c1-10)"
  printf 'copy %s\n' "$(cat "$tok" 2>/dev/null)"
  printf 'GEMINI_API_KEY=%s GOOGLE_GEMINI_BASE_URL=%s OPENAI_API_KEY=%s\n' "$GEMINI_API_KEY" "$GOOGLE_GEMINI_BASE_URL" "$OPENAI_API_KEY"
  printf 'DBUS_SESSION_BUS_ADDRESS=%s\n' "$DBUS_SESSION_BUS_ADDRESS"
  printf 'end %s\n' "$n"
} >> "$AGY_FAKE_DIR/starts"
if [ "$n" -ge "${AGY_FAKE_REFUSE_FROM:-999}" ]; then
  if [ -n "$logfile" ] && [ -f "$AGY_FAKE_DIR/agy.log" ]; then cat "$AGY_FAKE_DIR/agy.log" > "$logfile"; fi
  cat "$AGY_FAKE_DIR/stdout"
  cat "$AGY_FAKE_DIR/stderr" >&2
  exit "$(cat "$AGY_FAKE_DIR/exit")"
fi
echo '{"event":"init","conversation_id":"fake-conv","init":{"cwd":"x","tools":[],"permission_mode":"request-review"}}'
while IFS= read -r line; do
  echo '{"event":"step_update","step_update":{"conversation_id":"fake-conv","step_index":1,"state":"DONE","step_type":"user_input"}}'
  echo '{"event":"step_update","step_update":{"conversation_id":"fake-conv","step_index":2,"state":"DONE","step_type":"agent_response","text_delta":"reply","usage":{"input_tokens":10,"output_tokens":2,"cache_read_tokens":0,"total_tokens":12}}}'
  echo '{"event":"result","result":{"conversation_id":"fake-conv","status":"SUCCESS","response":"reply","num_turns":1}}'
done`

type googleAgySession struct {
	dir         string
	scratch     string
	inbox       chan RunInboxResponse
	completions chan TurnCompleteRequest
	done        chan struct{}
	status      string

	mu     sync.Mutex
	events []agyRecorded
}

// startGoogleAgySession runs a session against fakeGoogleAgy, which end, when given, sets up to end the
// way an agy did (googleAgyEnds). ORBIT_HOME is the caller's to set, before the session's first spawn.
func startGoogleAgySession(t *testing.T, job *ClaimedSession, end func(dir string)) *googleAgySession {
	t.Helper()
	bin := t.TempDir()
	writeFakeBin(t, bin, agyExecutable, fakeGoogleAgy)
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	s := &googleAgySession{
		dir:         t.TempDir(),
		scratch:     t.TempDir(),
		inbox:       make(chan RunInboxResponse, 8),
		completions: make(chan TurnCompleteRequest, 8),
		done:        make(chan struct{}),
	}
	if job.Agent.Env == nil {
		job.Agent.Env = map[string]string{}
	}
	job.Agent.Env["AGY_FAKE_DIR"] = s.dir
	if end != nil {
		end(s.dir)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/inbox") {
			http.NotFound(w, r)
			return
		}
		select {
		case resp := <-s.inbox:
			_ = json.NewEncoder(w).Encode(resp)
		case <-time.After(10 * time.Second):
			_, _ = w.Write([]byte(`{}`))
		case <-r.Context().Done():
		}
	}))
	t.Cleanup(srv.Close)
	ctx, cancel := context.WithCancel(context.Background())
	emit := func(kind string, payload map[string]interface{}) {
		s.mu.Lock()
		s.events = append(s.events, agyRecorded{kind: kind, payload: payload})
		s.mu.Unlock()
	}
	go func() {
		defer close(s.done)
		s.status, _, _ = runAntigravitySessionProcess(ctx, context.Background(), NewTransport(srv.URL, "token"), job, "", s.scratch, s.scratch,
			emit, func(string, string, map[string]interface{}) {}, func(string) {}, false, nil,
			func(req TurnCompleteRequest, _ ...context.Context) error { s.completions <- req; return nil },
			func(context.Context) bool { return true }, func(error) {})
	}()
	t.Cleanup(func() {
		cancel()
		<-s.done
	})
	return s
}

// googleAgyEnds has fakeGoogleAgy end the way an agy was recorded ending, from its start number from.
func googleAgyEnds(t *testing.T, job *ClaimedSession, from int, stdout, stderr string, exitCode int, agyLog []string) func(string) {
	t.Helper()
	if job.Agent.Env == nil {
		job.Agent.Env = map[string]string{}
	}
	job.Agent.Env["AGY_FAKE_REFUSE_FROM"] = strconv.Itoa(from)
	return func(dir string) {
		files := map[string]string{"stdout": stdout, "stderr": stderr, "exit": strconv.Itoa(exitCode)}
		if len(agyLog) > 0 {
			files["agy.log"] = strings.Join(agyLog, "\n") + "\n"
		}
		for name, body := range files {
			if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
				t.Fatal(err)
			}
		}
	}
}

// start is what fakeGoogleAgy recorded of its start number n, by field, waiting for it.
func (s *googleAgySession) start(t *testing.T, n int) map[string]string {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		raw, _ := os.ReadFile(filepath.Join(s.dir, "starts"))
		text := string(raw)
		if i := strings.Index(text, "start "+strconv.Itoa(n)+"\n"); i >= 0 {
			if j := strings.Index(text[i:], "end "+strconv.Itoa(n)+"\n"); j >= 0 {
				fields := map[string]string{}
				for _, line := range strings.Split(text[i:i+j], "\n") {
					if key, value, ok := strings.Cut(line, " "); ok && !strings.Contains(key, "=") {
						fields[key] = value
					} else if line != "" {
						fields["env"] += line + "\n"
					}
				}
				return fields
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("agy start %d never recorded: %q", n, raw)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func (s *googleAgySession) starts() int {
	raw, _ := os.ReadFile(filepath.Join(s.dir, "count"))
	n, _ := strconv.Atoi(strings.TrimSpace(string(raw)))
	return n
}

func (s *googleAgySession) completion(t *testing.T, turnID string) TurnCompleteRequest {
	t.Helper()
	select {
	case req := <-s.completions:
		if req.TurnID != turnID {
			t.Fatalf("turn %s completed while waiting for %s: %+v", req.TurnID, turnID, req)
		}
		return req
	case <-time.After(10 * time.Second):
		t.Fatalf("turn %s never completed", turnID)
	}
	return TurnCompleteRequest{}
}

func (s *googleAgySession) wait(t *testing.T) string {
	t.Helper()
	select {
	case <-s.done:
		return s.status
	case <-time.After(10 * time.Second):
		t.Fatal("the session loop did not return")
	}
	return ""
}

func (s *googleAgySession) eventsOf(kind string) []map[string]interface{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	return agyKinds(s.events, kind)
}

func (s *googleAgySession) geminiDir(t *testing.T) string {
	t.Helper()
	dir, err := antigravityGeminiDir(s.scratch)
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestAntigravityGoogleSessionTokenCopyLifecycle(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	token := saveGoogleSignIn(t)
	// None of these may reach an agy on the Google sign-in, nor the commands its agent runs.
	t.Setenv("GEMINI_API_KEY", "runner-key")
	t.Setenv("GOOGLE_GEMINI_BASE_URL", "https://example.invalid")
	t.Setenv("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/0/bus")
	logs := captureRunnerLog(t)
	job := &ClaimedSession{SessionID: "s-google", Provider: providerAntigravity, Agent: AgentExecConfig{
		PermissionMode: "dontAsk", Env: map[string]string{"OPENAI_API_KEY": "agent-key"},
	}}
	s := startGoogleAgySession(t, job, nil)
	gd := s.geminiDir(t)
	copyPath := antigravityTokenFile(gd)

	first := s.start(t, 1)
	if first["copy-mode"] != "-rw-------" || first["copy"] != string(token) {
		t.Fatalf("agy started without its private copy of the sign-in: mode %q", first["copy-mode"])
	}
	if want := "GEMINI_API_KEY= GOOGLE_GEMINI_BASE_URL= OPENAI_API_KEY=\nDBUS_SESSION_BUS_ADDRESS=unix:path=" + filepath.Join(gd, "absent-dbus") + "\n"; first["env"] != want {
		t.Fatalf("Google-mode environment =\n%s\nwant\n%s", first["env"], want)
	}
	if _, err := os.Stat(filepath.Join(gd, "absent-dbus")); !os.IsNotExist(err) {
		t.Fatalf("the D-Bus address must reach nothing: %v", err)
	}
	for _, flag := range []string{"--gemini_dir=" + gd + " ", "--log-file=" + antigravityGoogleLogFile(gd)} {
		if !strings.Contains(first["argv"]+" ", flag) {
			t.Fatalf("argv %q lacks %q", first["argv"], flag)
		}
	}
	var settings map[string]interface{}
	readJSONFile(t, filepath.Join(gd, "antigravity-cli", "settings.json"), &settings)
	if _, ok := settings["modelProvider"]; ok || settings["useG1Credits"] != false {
		t.Fatalf("settings = %v", settings)
	}
	if info, err := os.Stat(copyPath); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("the copy while agy runs: %v %v", info, err)
	}

	s.inbox <- RunInboxResponse{TurnID: "t1", Kind: "message", Content: "first"}
	if got := s.completion(t, "t1"); got.Status != stSucceeded {
		t.Fatalf("t1 = %+v", got)
	}
	// A reload retires the process: the copy goes as it exits, before the next agy is started.
	s.inbox <- RunInboxResponse{TurnID: "r1", Kind: "reload", Content: `{"permissionMode":"bypassPermissions"}`}
	waitGone(t, "the sign-in copy of an agy that exited", func() bool {
		_, err := os.Stat(copyPath)
		return os.IsNotExist(err)
	})
	if n := s.starts(); n != 1 {
		t.Fatalf("agy started %d times before the next turn", n)
	}
	s.inbox <- RunInboxResponse{TurnID: "t2", Kind: "message", Content: "second"}
	if got := s.completion(t, "t2"); got.Status != stSucceeded {
		t.Fatalf("t2 = %+v", got)
	}
	if second := s.start(t, 2); second["copy-mode"] != "-rw-------" || second["copy"] != string(token) {
		t.Fatal("the next agy started without a copy of its own")
	}
	s.inbox <- RunInboxResponse{TurnID: "e1", Kind: "end"}
	if status := s.wait(t); status != stSucceeded {
		t.Fatalf("session ended %s", status)
	}
	if _, err := os.Stat(copyPath); !os.IsNotExist(err) {
		t.Fatalf("the copy outlived the session's agy: %v", err)
	}
	if got, err := os.ReadFile(antigravityGoogleTokenPath()); err != nil || string(got) != string(token) {
		t.Fatal("the session touched the runner's own sign-in")
	}
	// One line per spawn names where the sign-in came from, and nothing the credential says.
	log := logs()
	if n := strings.Count(log, "s-google: starting agy, auth source google"); n != 2 {
		t.Fatalf("auth source logged %d times, want once per spawn:\n%s", n, log)
	}
	if strings.Contains(log, "orbit-placeholder") {
		t.Fatal("credential content reached the runner log")
	}
}

func TestAntigravityGoogleSessionAPIKeyModeIsUnchanged(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	saveGoogleSignIn(t)
	t.Setenv("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/0/bus")
	t.Setenv("OPENAI_API_KEY", "")
	logs := captureRunnerLog(t)
	// A Gemini provider's session, on a runner that keeps a Google sign-in.
	job := &ClaimedSession{SessionID: "s-provider", Provider: providerAntigravity, Agent: AgentExecConfig{
		PermissionMode: "dontAsk", Env: map[string]string{"GEMINI_API_KEY": "provider-key", "GOOGLE_GEMINI_BASE_URL": "https://gemini.example"},
	}}
	s := startGoogleAgySession(t, job, nil)
	gd := s.geminiDir(t)
	// A copy an earlier Google-mode process left behind goes too.
	stale := antigravityTokenFile(gd)
	first := s.start(t, 1)
	if first["copy"] != "" || strings.Contains(first["argv"], "--log-file") {
		t.Fatalf("an API-key agy got the Google sign-in or its log: %v", first)
	}
	if want := "GEMINI_API_KEY=provider-key GOOGLE_GEMINI_BASE_URL=https://gemini.example OPENAI_API_KEY=\nDBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/0/bus\n"; first["env"] != want {
		t.Fatalf("API-key environment =\n%s\nwant\n%s", first["env"], want)
	}
	var settings map[string]interface{}
	readJSONFile(t, filepath.Join(gd, "antigravity-cli", "settings.json"), &settings)
	if settings["modelProvider"] != "gemini" {
		t.Fatalf("settings = %v", settings)
	}
	if err := os.WriteFile(stale, []byte("left by a crash"), 0o600); err != nil {
		t.Fatal(err)
	}
	s.inbox <- RunInboxResponse{TurnID: "r1", Kind: "reload", Content: `{"permissionMode":"bypassPermissions"}`}
	s.inbox <- RunInboxResponse{TurnID: "t1", Kind: "message", Content: "first"}
	if got := s.completion(t, "t1"); got.Status != stSucceeded {
		t.Fatalf("t1 = %+v", got)
	}
	if second := s.start(t, 2); second["copy"] != "" {
		t.Fatal("a leftover sign-in copy reached an API-key agy")
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatalf("the next spawn kept a leftover copy: %v", err)
	}
	if !strings.Contains(logs(), "s-provider: starting agy, auth source session_key") {
		t.Fatal("the spawn did not log its auth source")
	}
}

// What agy 1.2.16 was recorded doing on a sign-in it cannot use, replayed at the session's first agy
// and at a later turn's: the turn, or the session, fails with the sign-in card's error, the session
// ends, and the runner is told to re-probe.
func TestAntigravityGoogleSessionSignedOutFromTheRecordings(t *testing.T) {
	for _, name := range []string{"google-auth-invalid-refresh.json", "google-auth-held-stream.json"} {
		recording := loadGoogleProbeRecording(t, name)
		for _, at := range []struct {
			name string
			from int
		}{{"first-agy", 1}, {"turn", 2}} {
			t.Run(name+"/"+at.name, func(t *testing.T) {
				t.Setenv("ORBIT_HOME", t.TempDir())
				t.Setenv("GEMINI_API_KEY", "")
				saveGoogleSignIn(t)
				signOuts := countEngineSignOuts(t)
				job := &ClaimedSession{SessionID: "s-out", Provider: providerAntigravity, Agent: AgentExecConfig{PermissionMode: "bypassPermissions"}}
				s := startGoogleAgySession(t, job, googleAgyEnds(t, job, at.from, recording.Stdout, recording.Stderr, recording.ExitCode, nil))
				if at.from == 2 {
					s.start(t, 1)
					// Retire the first agy, so the turn starts the one that refuses.
					s.inbox <- RunInboxResponse{TurnID: "r1", Kind: "reload", Content: `{"permissionMode":"auto"}`}
					s.inbox <- RunInboxResponse{TurnID: "t1", Kind: "message", Content: "hello"}
					got := s.completion(t, "t1")
					if got.Status != stFailed || got.Error != antigravityGoogleSignedOutMessage || !isAuthError(got.Error) {
						t.Fatalf("t1 = %+v", got)
					}
				}
				if status := s.wait(t); status != stFailed {
					t.Fatalf("session ended %s, want failed", status)
				}
				errs := s.eventsOf(evError)
				if len(errs) != 1 || errs[0]["message"] != antigravityGoogleSignedOutMessage {
					t.Fatalf("errors = %v", errs)
				}
				for _, e := range s.eventsOf(evSystem) {
					if strings.Contains(asString(e["stderr"]), "Run 'agy' to log in") {
						t.Fatalf("agy's own sign-in advice reached the transcript: %v", e)
					}
				}
				if n := signOuts.Load(); n != 1 {
					t.Fatalf("re-probe asked %d times", n)
				}
				if refusing := s.start(t, at.from); refusing["copy-mode"] != "-rw-------" {
					t.Fatal("the refusing agy did not run on the session's copy")
				}
				if _, err := os.Stat(antigravityTokenFile(s.geminiDir(t))); !os.IsNotExist(err) {
					t.Fatalf("the copy outlived the agy that refused it: %v", err)
				}
			})
		}
	}
}

// The same ending, which agy's own log puts down to the network, is no sign-out.
func TestAntigravityGoogleSessionNetworkFailureIsNotSignedOut(t *testing.T) {
	measured := loadGoogleSessionFailures(t)
	for _, network := range []string{"network_proxy_refused", "network_dns"} {
		t.Run(network, func(t *testing.T) {
			t.Setenv("ORBIT_HOME", t.TempDir())
			t.Setenv("GEMINI_API_KEY", "")
			saveGoogleSignIn(t)
			signOuts := countEngineSignOuts(t)
			job := &ClaimedSession{SessionID: "s-offline", Provider: providerAntigravity, Agent: AgentExecConfig{PermissionMode: "bypassPermissions"}}
			s := startGoogleAgySession(t, job, googleAgyEnds(t, job, 1, measured.Stdout, measured.Stderr, measured.ExitCode, measured.Cases[network].LogLines))
			s.start(t, 1)
			s.inbox <- RunInboxResponse{TurnID: "t1", Kind: "message", Content: "hello"}
			got := s.completion(t, "t1")
			if got.Status != stFailed || got.Error != antigravityGoogleUnreachableMessage || isAuthError(got.Error) {
				t.Fatalf("t1 = %+v", got)
			}
			s.inbox <- RunInboxResponse{TurnID: "e1", Kind: "end"}
			if status := s.wait(t); status != stSucceeded {
				t.Fatalf("session ended %s: a network failure must not end it", status)
			}
			for _, e := range s.eventsOf(evError) {
				if isAuthError(asString(e["message"])) {
					t.Fatalf("a network failure was reported as a sign-out: %v", e)
				}
			}
			if n := signOuts.Load(); n != 0 {
				t.Fatalf("re-probe asked %d times for a network failure", n)
			}
			if _, err := os.Stat(antigravityTokenFile(s.geminiDir(t))); !os.IsNotExist(err) {
				t.Fatalf("the copy outlived its agy: %v", err)
			}
		})
	}
}

// In the modes that ask, agy's first start is the approval gate's `--print=/hooks`, which checks the
// Google sign-in too: from a pipe (not /dev/null), with no key, and with the session's log.
func TestAntigravityGoogleSessionApprovalCheckSignedOut(t *testing.T) {
	invalid := loadGoogleProbeRecording(t, "google-auth-invalid-refresh.json")
	measured := loadGoogleSessionFailures(t)
	t.Run("refused", func(t *testing.T) {
		t.Setenv("ORBIT_HOME", t.TempDir())
		t.Setenv("GEMINI_API_KEY", "")
		saveGoogleSignIn(t)
		signOuts := countEngineSignOuts(t)
		job := &ClaimedSession{SessionID: "s-gate", Provider: providerAntigravity, Agent: AgentExecConfig{PermissionMode: "default"}}
		s := startGoogleAgySession(t, job, googleAgyEnds(t, job, 1, invalid.Stdout, invalid.Stderr, invalid.ExitCode, nil))
		if status := s.wait(t); status != stFailed {
			t.Fatalf("session ended %s", status)
		}
		check := s.start(t, 1)
		gd := s.geminiDir(t)
		if !strings.Contains(check["argv"], "--print=/hooks") || !strings.Contains(check["argv"], "--log-file="+antigravityGoogleLogFile(gd)) ||
			check["stdin-pipe"] != "yes" || check["copy-mode"] != "-rw-------" || !strings.HasPrefix(check["env"], "GEMINI_API_KEY= ") {
			t.Fatalf("approval check on the Google sign-in = %v", check)
		}
		if n := s.starts(); n != 1 {
			t.Fatalf("agy started %d times: the session's own must not start behind a refused check", n)
		}
		if errs := s.eventsOf(evError); len(errs) != 1 || errs[0]["message"] != antigravityGoogleSignedOutMessage {
			t.Fatalf("errors = %v", errs)
		}
		if n := signOuts.Load(); n != 1 {
			t.Fatalf("re-probe asked %d times", n)
		}
		if _, err := os.Stat(antigravityTokenFile(gd)); !os.IsNotExist(err) {
			t.Fatalf("a refused check left the copy behind: %v", err)
		}
	})
	t.Run("network", func(t *testing.T) {
		t.Setenv("ORBIT_HOME", t.TempDir())
		t.Setenv("GEMINI_API_KEY", "")
		saveGoogleSignIn(t)
		signOuts := countEngineSignOuts(t)
		job := &ClaimedSession{SessionID: "s-gate-offline", Provider: providerAntigravity, Agent: AgentExecConfig{PermissionMode: "acceptEdits"}}
		s := startGoogleAgySession(t, job, googleAgyEnds(t, job, 1, measured.Stdout, measured.Stderr, measured.ExitCode, measured.Cases["network_proxy_refused"].LogLines))
		s.start(t, 1)
		s.inbox <- RunInboxResponse{TurnID: "t1", Kind: "message", Content: "hello"}
		if got := s.completion(t, "t1"); got.Status != stFailed || got.Error != antigravityGoogleUnreachableMessage {
			t.Fatalf("t1 = %+v", got)
		}
		s.inbox <- RunInboxResponse{TurnID: "e1", Kind: "end"}
		if status := s.wait(t); status != stSucceeded {
			t.Fatalf("session ended %s", status)
		}
		if n := signOuts.Load(); n != 0 {
			t.Fatalf("re-probe asked %d times for a network failure", n)
		}
		if _, err := os.Stat(antigravityTokenFile(s.geminiDir(t))); !os.IsNotExist(err) {
			t.Fatalf("an unchecked sign-in left the copy behind: %v", err)
		}
	})
}

func TestAntigravityGoogleSessionPreflightLeavesTheCheckToAgy(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	t.Setenv("GEMINI_API_KEY", "")
	probed := filepath.Join(t.TempDir(), "probed")
	bin := t.TempDir()
	writeFakeBin(t, bin, agyExecutable, "touch "+shellQuote(probed)+"; exit 1")
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	saveGoogleSignIn(t)
	if msg := engineAuthPreflight(providerAntigravity, nil); msg != "" {
		t.Fatalf("a saved Google sign-in was refused before agy could check it: %q", msg)
	}
	if _, err := os.Stat(probed); !os.IsNotExist(err) {
		t.Fatal("the preflight ran agy: the session's own agy is what checks the sign-in")
	}
	if err := os.Remove(antigravityGoogleTokenPath()); err != nil {
		t.Fatal(err)
	}
	msg := engineAuthPreflight(providerAntigravity, nil)
	if !isAuthError(msg) || !strings.Contains(msg, "GEMINI_API_KEY") || !strings.Contains(msg, "sign in to Google") || strings.Contains(msg, "not supported") {
		t.Fatalf("no sign-in and no key = %q", msg)
	}
}

func TestAntigravityGoogleSessionModelCatalog(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	t.Setenv("GEMINI_API_KEY", "")
	signedIn := loadGoogleProbeRecording(t, "google-auth-signedin-models.json")
	api := loadGoogleProbeRecording(t, "google-auth-api-models.json")
	signedOut := loadGoogleProbeRecording(t, "google-auth-google-models.json")
	dir := t.TempDir()
	files := map[string]string{"signed-in": signedIn.Stdout, "api": api.Stdout, "signed-out-stderr": signedOut.Stderr}
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	bin := t.TempDir()
	writeFakeBin(t, bin, agyExecutable, `gd=""
for a in "$@"; do case "$a" in --gemini_dir=*) gd="${a#*=}" ;; esac; done
pipe=no; [ -p /dev/stdin ] && pipe=yes
printf '%s|GEMINI_API_KEY=%s|stdin-pipe=%s\n' "$*" "$GEMINI_API_KEY" "$pipe" >> "$AGY_FAKE_DIR/calls"
case " $* " in *" models "*) ;; *) exit 9 ;; esac
if [ "$gd" = "$AGY_GOOGLE_DIR" ]; then
  if [ -f "$AGY_FAKE_DIR/signed-out" ]; then cat "$AGY_FAKE_DIR/signed-out-stderr" >&2; exit 1; fi
  cat "$AGY_FAKE_DIR/signed-in"
else
  cat "$AGY_FAKE_DIR/api"
fi`)
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("AGY_FAKE_DIR", dir)
	t.Setenv("AGY_GOOGLE_DIR", antigravityGoogleDir())
	values := func(models []ModelInfo) []string {
		var out []string
		for _, m := range models {
			out = append(out, m.Value+"["+strings.Join(m.ReasoningLevels, ",")+"]")
		}
		return out
	}
	apiList := []string{"gemini-3.8-flash[low,medium,high]", "gemini-3.7-flash[low,medium,high]", "gemini-3.6-flash[low,medium,high]", "gemini-3.1-pro[low,high]"}
	fetch := func() []string {
		t.Helper()
		models, err := fetchAntigravityModelCatalog(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		return values(models)
	}
	if got := fetch(); !reflect.DeepEqual(got, apiList) {
		t.Fatalf("no sign-in: %v", got)
	}
	saveGoogleSignIn(t)
	models, err := fetchAntigravityModelCatalog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	want := append(append([]string{}, apiList...), "claude-opus-5-5[low,medium,high]", "claude-sonnet-5-5[low,medium,high]", "gpt-oss-120b[medium]")
	if got := values(models); !reflect.DeepEqual(got, want) {
		t.Fatalf("Google catalog = %v\nwant %v", got, want)
	}
	for _, m := range models {
		if m.Value == "claude-opus-5-5" && (m.Label != "Claude Opus 5.5" || m.DefaultReasoningLevel != "high") {
			t.Fatalf("Claude row = %+v", m)
		}
		if m.Value == "gpt-oss-120b" && (m.Label != "GPT-OSS 120B" || m.DefaultReasoningLevel != "medium") {
			t.Fatalf("GPT-OSS row = %+v", m)
		}
	}
	calls, _ := os.ReadFile(filepath.Join(dir, "calls"))
	lines := strings.Split(strings.TrimSpace(string(calls)), "\n")
	google := lines[len(lines)-1]
	if google != "--gemini_dir="+antigravityGoogleDir()+" --log-file=/dev/null models|GEMINI_API_KEY=|stdin-pipe=yes" {
		t.Fatalf("Google-mode agy models = %q, want the credential directory through the shared entry", google)
	}
	var settings map[string]interface{}
	readJSONFile(t, filepath.Join(antigravityGoogleDir(), "antigravity-cli", "settings.json"), &settings)
	if _, ok := settings["modelProvider"]; ok {
		t.Fatalf("the credential directory's settings select API-key mode: %v", settings)
	}
	// A sign-in that cannot list — refused, offline — leaves the list a Gemini provider still runs on.
	if err := os.WriteFile(filepath.Join(dir, "signed-out"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if got := fetch(); !reflect.DeepEqual(got, apiList) {
		t.Fatalf("signed out: %v", got)
	}
}
