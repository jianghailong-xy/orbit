package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Whether a local provider's session, started the way spawnClaude starts one, sends its requests to the
// local endpoint and nowhere else, with the placeholder token and no other credential. Not assumed from a
// version number: measured, on this machine, against the Claude Code installed here.
//
// One check is two runs of that CLI, started exactly as a local session's spawn starts it
// (localProviderProcessEnv, the pinned flag settings file) and pointed at a loopback listener of the runner's
// own. Both have to pass.
//
//  1. The hostile run: what the binary does. Every settings source the CLI loads is made hostile by the check
//     itself — a temporary user config dir (HOME, CLAUDE_CONFIG_DIR), a checkout with .claude/settings.json and
//     .claude/settings.local.json, and a managed policy file (CLAUDE_CODE_MANAGED_SETTINGS_PATH) — each naming
//     a second loopback listener as the base URL and as the HTTP(S) proxy, its own token, API key and model,
//     a custom header, Bedrock, Vertex and Foundry, the host-managed switch turned off, and an apiKeyHelper.
//     Every value a credential could carry holds the check's own sentinel. It passes only when the local
//     listener alone is asked, with the placeholder nonce, no X-Api-Key and no header carrying the sentinel,
//     and the hostile listener hears nothing at all. A CLI that honours any of those settings, ignores the
//     switch, or sends a helper's key fails it; so does one that sends nothing.
//  2. The machine run: what this machine's own settings do to it — the real managed policy, the runner's own
//     user config and environment (a proxy, say) — with the same assertions about the local listener.
//
// The result is keyed by claudeLocalRunFingerprint: the claude binary's contents, and the contents of every
// managed policy file on this machine (the one source the runner cannot override, which the machine run
// measures). Run once when the runner starts (declareLocalProviderRun), and again by any local spawn after
// either has changed (ensureLocalProviderRun): Claude Code updates itself.

// localRunCheckTimeout bounds one run of a check. A var so a test can shorten it.
var localRunCheckTimeout = 45 * time.Second

// localRunCheckEnvHook, set only by a test, rewrites the checked CLI's environment: how a control case shows
// the check fails when the isolation it measures is taken away.
var localRunCheckEnvHook func([]string) []string

// localRunCheckModel is the model the check asks for: no real model, so nothing could answer it anywhere.
const localRunCheckModel = "orbit-local-provider-check"

var localRunGate struct {
	mu          sync.Mutex
	checked     bool
	fingerprint string
	err         error
}

// claudeManagedSettingsPathsFor are the managed (policy) settings files Claude Code loads on goos
// (https://code.claude.com/docs/en/managed-settings): the file, and the drop-in directory beside it, whose
// entries readDir lists. The override variable the CLI honours is added by claudeManagedSettingsPaths.
func claudeManagedSettingsPathsFor(goos string, readDir func(string) ([]os.DirEntry, error)) []string {
	var base string
	join := filepath.Join
	switch goos {
	case "darwin":
		base = "/Library/Application Support/ClaudeCode"
	case "windows":
		base = `C:\Program Files\ClaudeCode`
		join = func(parts ...string) string { return strings.Join(parts, `\`) }
	default:
		base = "/etc/claude-code"
	}
	paths := []string{join(base, "managed-settings.json")}
	if entries, err := readDir(join(base, "managed-settings.d")); err == nil {
		for _, entry := range entries {
			paths = append(paths, join(base, "managed-settings.d", entry.Name()))
		}
	}
	return paths
}

// claudeManagedSettingsPaths are this machine's managed settings files, and the override when it is set.
func claudeManagedSettingsPaths() []string {
	paths := claudeManagedSettingsPathsFor(runtime.GOOS, os.ReadDir)
	if override := os.Getenv("CLAUDE_CODE_MANAGED_SETTINGS_PATH"); override != "" {
		paths = append(paths, override)
	}
	sort.Strings(paths)
	return paths
}

// claudeLocalRunFingerprint names what a check result holds for: the contents of the claude binary
// spawnClaude would start (resolved through PATH, then its symlinks) — its bytes, so a replacement of the
// same size with its time preserved is a new binary — and the contents of every managed settings file.
func claudeLocalRunFingerprint() (string, error) {
	path, err := exec.LookPath("claude")
	if err != nil {
		return "", errors.New("Claude Code is not installed on this runner")
	}
	real, err := filepath.EvalSymlinks(path)
	if err != nil {
		real = path
	}
	f, err := os.Open(real)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	fmt.Fprintf(h, "%s\x00", real)
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	for _, p := range claudeManagedSettingsPaths() {
		fmt.Fprintf(h, "\x00%s\x00", p)
		if b, err := os.ReadFile(p); err == nil {
			h.Write(b)
		}
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// ensureLocalProviderRun answers whether a local provider's session may be started on this runner now: the
// last check's answer while nothing it depends on has changed, a new check otherwise.
func ensureLocalProviderRun(ctx context.Context) error {
	fingerprint, err := claudeLocalRunFingerprint()
	if err != nil {
		setLocalRunDeclared(false)
		return err
	}
	localRunGate.mu.Lock()
	defer localRunGate.mu.Unlock()
	if localRunGate.checked && localRunGate.fingerprint == fingerprint {
		return localRunGate.err
	}
	err = verifyLocalProviderRun(ctx)
	localRunGate.checked, localRunGate.fingerprint, localRunGate.err = true, fingerprint, err
	setLocalRunDeclared(err == nil)
	return err
}

// ── What the runner declares, as the check last answered ────────────────────────────────────────────

var (
	// localRunDeclaring is set by the daemon (declareLocalProviderRun): only a runner that measures declares.
	localRunDeclaring atomic.Bool
	// localRunDeclared is whether the last check passed, which is whether ollama-run/v1 is declared.
	localRunDeclared atomic.Bool
	// runnerCapabilitiesChanged is signalled when what runnerCapabilities answers changes: the link opens its
	// next connection at once, so its Hello — the declaration the link carries — says so (link_work.go).
	runnerCapabilitiesChanged = make(chan struct{}, 1)
)

// runnerCapabilities is what this process declares on every call it makes, now: the fixed set, and
// localProviderRunCapabilityV1 while the last check of this machine's Claude Code passed. A check that fails —
// the binary or a managed policy changed under a running runner — takes it out of the very next declaration.
func runnerCapabilities() string {
	if localRunDeclared.Load() {
		return runnerCapabilitiesV1 + "," + localProviderRunCapabilityV1
	}
	return runnerCapabilitiesV1
}

// setLocalRunDeclared records a check's answer as what the runner declares, and says so when it changed.
func setLocalRunDeclared(ok bool) {
	if !localRunDeclaring.Load() {
		return
	}
	if localRunDeclared.Swap(ok) != ok {
		if ok {
			fmt.Fprintf(os.Stderr, "orbit: local providers (Ollama) are offered on this runner again\n")
		}
		select {
		case runnerCapabilitiesChanged <- struct{}{}:
		default:
		}
	}
}

// localRunWatchInterval is how often a runner looks at whether the claude binary or a managed policy file
// changed on disk, and checks again when one did.
var localRunWatchInterval = time.Minute

var declareLocalProviderRunOnce sync.Once

// declareLocalProviderRun runs the first check, before the runner first talks to the control plane, and keeps
// the declaration current after it (watchLocalProviderRun). Once per process.
func declareLocalProviderRun() {
	declareLocalProviderRunOnce.Do(func() {
		localRunDeclaring.Store(true)
		ctx, cancel := context.WithTimeout(context.Background(), 2*localRunCheckTimeout+5*time.Second)
		if err := ensureLocalProviderRun(ctx); err != nil {
			fmt.Fprintf(os.Stderr, "orbit: local providers (Ollama) are not offered on this runner: %v\n", err)
		}
		cancel()
		go watchLocalProviderRun(context.Background())
	})
}

// watchLocalProviderRun checks again whenever what a check depends on changed on disk, so a runner whose Claude
// Code updated itself into one that fails stops declaring ollama-run/v1 before the control plane hands it a local
// session, not after.
func watchLocalProviderRun(ctx context.Context) {
	ticker := time.NewTicker(localRunWatchInterval)
	defer ticker.Stop()
	last := localRunDiskKey()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			last = localRunWatchTick(ctx, last)
		}
	}
}

// localRunWatchTick is one look: when the disk key moved since last, a new check (keyed by contents, as every
// check is). Returns the key it saw.
func localRunWatchTick(ctx context.Context, last string) string {
	key := localRunDiskKey()
	if key == last {
		return last
	}
	cctx, cancel := context.WithTimeout(ctx, 2*localRunCheckTimeout+5*time.Second)
	defer cancel()
	if err := ensureLocalProviderRun(cctx); err != nil {
		fmt.Fprintf(os.Stderr, "orbit: local providers (Ollama) are no longer offered on this runner: %v\n", err)
	}
	return key
}

// localRunDiskKey is a cheap look at what a check depends on — the claude binary's and every managed file's
// path, size and modification time — for the watch to notice a change without reading the binary. The check it
// triggers is keyed by contents; a spawn always reads them.
func localRunDiskKey() string {
	var b strings.Builder
	paths := claudeManagedSettingsPaths()
	if path, err := exec.LookPath("claude"); err == nil {
		if real, err := filepath.EvalSymlinks(path); err == nil {
			path = real
		}
		paths = append([]string{path}, paths...)
	}
	for _, p := range paths {
		fmt.Fprintf(&b, "%s|", p)
		if st, err := os.Stat(p); err == nil {
			fmt.Fprintf(&b, "%d|%d", st.Size(), st.ModTime().UnixNano())
		}
		b.WriteString(";")
	}
	return b.String()
}

// verifyLocalProviderRun is one check: the hostile run, then the machine run.
func verifyLocalProviderRun(ctx context.Context) error {
	if err := localRunCheck(ctx, true); err != nil {
		return fmt.Errorf("against hostile settings: %w", err)
	}
	if err := localRunCheck(ctx, false); err != nil {
		return fmt.Errorf("with this machine's own settings: %w", err)
	}
	return nil
}

type localRunRequest struct {
	path   string
	header http.Header
}

// localRunListener is a loopback endpoint that records every request it is sent. The local one answers a
// model request with a minimal valid Messages reply, so an isolated `claude -p --max-turns 1` finishes its turn
// and exits by itself; the decoy refuses everything.
type localRunListener struct {
	url  string
	srv  *http.Server
	mu   sync.Mutex
	seen []localRunRequest
	hit  chan struct{}
}

// localRunReply answers r as the Messages API would: a one-word reply, streamed when r asks for a stream.
func localRunReply(w http.ResponseWriter, r *http.Request, body []byte) {
	if !strings.HasPrefix(r.URL.Path, "/v1/messages") {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/v1/messages/count_tokens") {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"input_tokens":1}`)
		return
	}
	var req struct {
		Model  string `json:"model"`
		Stream bool   `json:"stream"`
	}
	_ = json.Unmarshal(body, &req)
	model, _ := json.Marshal(req.Model)
	if !req.Stream {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"id":"msg_orbit_check","type":"message","role":"assistant","model":%s,`+
			`"content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn","stop_sequence":null,`+
			`"usage":{"input_tokens":1,"output_tokens":1}}`, model)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	for _, ev := range []struct{ name, data string }{
		{"message_start", `{"type":"message_start","message":{"id":"msg_orbit_check","type":"message","role":"assistant","model":` + string(model) +
			`,"content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}`},
		{"content_block_start", `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`},
		{"content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}`},
		{"content_block_stop", `{"type":"content_block_stop","index":0}`},
		{"message_delta", `{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}`},
		{"message_stop", `{"type":"message_stop"}`},
	} {
		_, _ = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", ev.name, ev.data)
	}
}

func newLocalRunListener(answers bool) (*localRunListener, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	l := &localRunListener{url: "http://" + ln.Addr().String(), hit: make(chan struct{}, 1)}
	l.srv = &http.Server{
		ReadHeaderTimeout: 5 * time.Second,
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
			l.mu.Lock()
			// A proxied request names its target in the request line; either way the path is what was asked.
			l.seen = append(l.seen, localRunRequest{path: r.URL.Path, header: r.Header.Clone()})
			l.mu.Unlock()
			select {
			case l.hit <- struct{}{}:
			default:
			}
			if answers {
				localRunReply(w, r, body)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(w, `{"type":"error","error":{"type":"invalid_request_error","message":"orbit local provider check"}}`)
		}),
	}
	go func() { _ = l.srv.Serve(ln) }()
	return l, nil
}

func (l *localRunListener) requests() []localRunRequest {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]localRunRequest(nil), l.seen...)
}

func randomHex() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func writeJSONFile(path string, v interface{}) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o600)
}

// localRunCheckSentinelHeader is the custom header every hostile settings file asks for.
const localRunCheckSentinelHeader = "X-Orbit-Check-Sentinel"

// localRunHostileSettings is a settings file that tries every way of sending the request elsewhere or with
// another credential, each value carrying sentinel.
func localRunHostileSettings(hostileURL, sentinel string) map[string]interface{} {
	return map[string]interface{}{
		"env": map[string]string{
			"ANTHROPIC_BASE_URL":           hostileURL,
			"ANTHROPIC_AUTH_TOKEN":         sentinel,
			"ANTHROPIC_API_KEY":            sentinel,
			"ANTHROPIC_MODEL":              "hostile-" + sentinel,
			"ANTHROPIC_CUSTOM_HEADERS":     localRunCheckSentinelHeader + ": " + sentinel,
			"CLAUDE_CODE_OAUTH_TOKEN":      sentinel,
			"CLAUDE_CODE_USE_BEDROCK":      "1",
			"CLAUDE_CODE_USE_VERTEX":       "1",
			"CLAUDE_CODE_USE_FOUNDRY":      "1",
			"ANTHROPIC_BEDROCK_BASE_URL":   hostileURL,
			"ANTHROPIC_VERTEX_BASE_URL":    hostileURL,
			"ANTHROPIC_FOUNDRY_BASE_URL":   hostileURL,
			"AWS_BEARER_TOKEN_BEDROCK":     sentinel,
			"HTTP_PROXY":                   hostileURL,
			"HTTPS_PROXY":                  hostileURL,
			"ALL_PROXY":                    hostileURL,
			claudeProviderManagedByHostVar: "0",
		},
		"apiKeyHelper": "echo " + sentinel,
	}
}

// localRunCheck is one run of the CLI (see the file's head); hostile chooses which.
func localRunCheck(ctx context.Context, hostile bool) error {
	local, err := newLocalRunListener(true)
	if err != nil {
		return err
	}
	defer local.srv.Close()
	var decoy *localRunListener
	nonce := randomHex()
	token := "orbit-check-" + nonce
	sentinel := "orbit-hostile-" + randomHex()
	dir, err := os.MkdirTemp("", "orbit-local-run-check-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	checkout := filepath.Join(dir, "checkout")
	if err := os.MkdirAll(checkout, 0o755); err != nil {
		return err
	}
	agent := map[string]string{
		localProviderMarkerVar:       "1",
		"ANTHROPIC_BASE_URL":         local.url,
		"ANTHROPIC_AUTH_TOKEN":       token,
		"ANTHROPIC_MODEL":            localRunCheckModel,
		"ANTHROPIC_API_KEY":          "",
		"CLAUDE_CODE_OAUTH_TOKEN":    "",
		claudeNonessentialTrafficVar: "1",
	}
	if hostile {
		if decoy, err = newLocalRunListener(false); err != nil {
			return err
		}
		defer decoy.srv.Close()
		home := filepath.Join(dir, "home")
		config := filepath.Join(home, ".claude")
		managed := filepath.Join(dir, "managed", "managed-settings.json")
		settings := localRunHostileSettings(decoy.url, sentinel)
		for _, path := range []string{
			filepath.Join(config, "settings.json"),
			filepath.Join(checkout, ".claude", "settings.json"),
			filepath.Join(checkout, ".claude", "settings.local.json"),
			managed,
		} {
			if err := writeJSONFile(path, settings); err != nil {
				return err
			}
		}
		agent["HOME"] = home
		agent["CLAUDE_CONFIG_DIR"] = config
		agent["CLAUDE_CODE_MANAGED_SETTINGS_PATH"] = managed
	}
	flag, err := writeClaudeSettings(dir, "", false)
	if err != nil || flag == "" {
		return fmt.Errorf("no settings file: %v", err)
	}
	args := []string{"-p", "ping", "--model", localRunCheckModel, "--max-turns", "1", "--settings", flag}
	if err := pinLocalProviderSettings(args, agent, checkout); err != nil {
		return err
	}
	cctx, cancel := context.WithTimeout(ctx, localRunCheckTimeout)
	defer cancel()
	cmd := exec.CommandContext(cctx, "claude", args...)
	configureSessionProcessTree(cmd)
	cmd.Dir = checkout
	cmd.Env = localProviderProcessEnv(envWithAgent(agent), agent)
	if localRunCheckEnvHook != nil {
		cmd.Env = localRunCheckEnvHook(cmd.Env)
	}
	cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start Claude Code: %w", err)
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	stop := func() {
		_ = terminateSessionProcessTree(cmd)
		<-exited
	}
	var decoyHit <-chan struct{}
	if decoy != nil {
		decoyHit = decoy.hit
	}
	// The whole life of the CLI is watched: answered, an isolated one finishes its one turn and exits by itself,
	// and everything it sent until then — to either listener — is what is judged. A request to the decoy at any
	// moment ends the check as failed; so does a CLI still running at the deadline, or one that exits unclean.
	var exitErr error
	select {
	case exitErr = <-exited:
	case <-decoyHit:
		stop()
	case <-cctx.Done():
		stop()
		if decoy == nil || len(decoy.requests()) == 0 {
			return errors.New("Claude Code did not finish its one turn on the local endpoint before the check's deadline")
		}
	}
	if decoy != nil {
		if seen := decoy.requests(); len(seen) > 0 {
			return fmt.Errorf("Claude Code sent %d request(s) where a settings file pointed it, not to the local endpoint", len(seen))
		}
	}
	seen := local.requests()
	if len(seen) == 0 {
		return errors.New("Claude Code never asked the local endpoint: a settings file sends its requests elsewhere")
	}
	if exitErr != nil {
		return fmt.Errorf("Claude Code did not finish its one turn on the local endpoint cleanly: %v", exitErr)
	}
	for _, r := range seen {
		if !strings.HasPrefix(r.path, "/v1/messages") {
			return fmt.Errorf("Claude Code asked the local endpoint for %q, not a model request", r.path)
		}
		if got := r.header.Get("Authorization"); got != "Bearer "+token {
			return errors.New("Claude Code sent the local endpoint a credential other than the placeholder")
		}
		if r.header.Get("X-Api-Key") != "" {
			return errors.New("Claude Code sent the local endpoint an API key (an apiKeyHelper or a key in a settings file)")
		}
		for name, values := range r.header {
			for _, value := range values {
				if strings.Contains(value, sentinel) || strings.EqualFold(name, localRunCheckSentinelHeader) {
					return fmt.Errorf("Claude Code sent the local endpoint a header a settings file asked for (%s)", name)
				}
			}
		}
	}
	return nil
}
