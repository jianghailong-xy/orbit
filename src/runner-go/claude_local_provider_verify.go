package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
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
	"time"
)

// Whether a local provider's session, started the way spawnClaude starts one, sends its requests to the
// local endpoint and nowhere else, with the placeholder token and no other credential. Not assumed from a
// version number: measured, on this machine, against the Claude Code installed here and every settings
// file it would load (the managed policy file above all, which outranks anything the runner can write).
//
// The check starts that CLI exactly as a local session's spawn does (localProviderProcessEnv, the pinned
// flag settings file) pointed at a loopback listener of the runner's own, and passes only when the first
// model request arrives there with the check's own token and no X-Api-Key. A managed or user setting that
// sends the request elsewhere, an apiKeyHelper or a settings-file key that adds a credential, a CLI that
// ignores the switch: each fails it, and then the runner does not declare localProviderRunCapabilityV1, so the
// control plane hands it no local session; and a local session that reaches it anyway is not started.
//
// It is run once when the runner starts (declareLocalProviderRun) and again by any local spawn after the CLI
// binary or a managed settings file has changed (ensureLocalProviderRun): Claude Code updates itself.

// localRunCheckTimeout bounds one check. A var so a test can shorten it.
var localRunCheckTimeout = 45 * time.Second

// localRunCheckEnvHook, set only by a test, rewrites the checked CLI's environment: how the control case
// shows the check fails when the isolation it measures is taken away.
var localRunCheckEnvHook func([]string) []string

// localRunCheckModel is the model the check asks for: no real model, so nothing could answer it anywhere.
const localRunCheckModel = "orbit-local-provider-check"

var localRunGate struct {
	mu          sync.Mutex
	checked     bool
	fingerprint string
	err         error
}

// claudeManagedSettingsPaths are the managed (policy) settings files Claude Code loads on this OS, and the
// override it honours.
func claudeManagedSettingsPaths() []string {
	var base string
	switch runtime.GOOS {
	case "darwin":
		base = "/Library/Application Support/ClaudeCode"
	case "windows":
		base = `C:\ProgramData\ClaudeCode`
	default:
		base = "/etc/claude-code"
	}
	paths := []string{filepath.Join(base, "managed-settings.json")}
	if entries, err := os.ReadDir(filepath.Join(base, "managed-settings.d")); err == nil {
		for _, entry := range entries {
			paths = append(paths, filepath.Join(base, "managed-settings.d", entry.Name()))
		}
	}
	if override := os.Getenv("CLAUDE_CODE_MANAGED_SETTINGS_PATH"); override != "" {
		paths = append(paths, override)
	}
	sort.Strings(paths)
	return paths
}

// claudeLocalRunFingerprint names what a check result holds for: the claude binary spawnClaude would start
// (resolved through PATH, then its symlinks) and the contents of every managed settings file. Either
// changing makes the last result no answer.
func claudeLocalRunFingerprint() (string, error) {
	path, err := exec.LookPath("claude")
	if err != nil {
		return "", errors.New("Claude Code is not installed on this runner")
	}
	real, err := filepath.EvalSymlinks(path)
	if err != nil {
		real = path
	}
	st, err := os.Stat(real)
	if err != nil {
		return "", err
	}
	h := sha256.New()
	fmt.Fprintf(h, "%s\x00%d\x00%d\x00", real, st.Size(), st.ModTime().UnixNano())
	for _, p := range claudeManagedSettingsPaths() {
		fmt.Fprintf(h, "%s\x00", p)
		if b, err := os.ReadFile(p); err == nil {
			h.Write(b)
		}
		h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// ensureLocalProviderRun answers whether a local provider's session may be started on this runner now: the
// last check's answer while nothing it depends on has changed, a new check otherwise.
func ensureLocalProviderRun(ctx context.Context) error {
	fingerprint, err := claudeLocalRunFingerprint()
	if err != nil {
		return err
	}
	localRunGate.mu.Lock()
	defer localRunGate.mu.Unlock()
	if localRunGate.checked && localRunGate.fingerprint == fingerprint {
		return localRunGate.err
	}
	err = verifyLocalProviderRun(ctx)
	localRunGate.checked, localRunGate.fingerprint, localRunGate.err = true, fingerprint, err
	return err
}

var declareLocalProviderRunOnce sync.Once

// declareLocalProviderRun adds localProviderRunCapabilityV1 to what this runner declares, once, when the check
// passes. Run before the runner first talks to the control plane, so every declaration it makes is the same.
func declareLocalProviderRun() {
	declareLocalProviderRunOnce.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), localRunCheckTimeout+5*time.Second)
		defer cancel()
		if err := ensureLocalProviderRun(ctx); err != nil {
			fmt.Fprintf(os.Stderr, "orbit: local providers (Ollama) are not offered on this runner: %v\n", err)
			return
		}
		runnerCapabilitiesV1 += "," + localProviderRunCapabilityV1
	})
}

type localRunCapture struct {
	path   string
	auth   string
	apiKey string
}

// verifyLocalProviderRun is one check (see the file's head).
func verifyLocalProviderRun(ctx context.Context) error {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("local provider check: %w", err)
	}
	got := make(chan localRunCapture, 1)
	srv := &http.Server{
		ReadHeaderTimeout: 5 * time.Second,
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = io.Copy(io.Discard, io.LimitReader(r.Body, 1<<20))
			select {
			case got <- localRunCapture{path: r.URL.Path, auth: r.Header.Get("Authorization"), apiKey: r.Header.Get("X-Api-Key")}:
			default:
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(w, `{"type":"error","error":{"type":"invalid_request_error","message":"orbit local provider check"}}`)
		}),
	}
	go func() { _ = srv.Serve(ln) }()
	defer srv.Close()

	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		return err
	}
	token := "orbit-check-" + hex.EncodeToString(nonce)
	dir, err := os.MkdirTemp("", "orbit-local-run-check-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	agent := map[string]string{
		localProviderMarkerVar:       "1",
		"ANTHROPIC_BASE_URL":         "http://" + ln.Addr().String(),
		"ANTHROPIC_AUTH_TOKEN":       token,
		"ANTHROPIC_MODEL":            localRunCheckModel,
		"ANTHROPIC_API_KEY":          "",
		"CLAUDE_CODE_OAUTH_TOKEN":    "",
		claudeNonessentialTrafficVar: "1",
	}
	settings, err := writeClaudeSettings(dir, "", false)
	if err != nil || settings == "" {
		return fmt.Errorf("local provider check: no settings file: %v", err)
	}
	args := []string{"-p", "ping", "--model", localRunCheckModel, "--max-turns", "1", "--settings", settings}
	if err := pinLocalProviderSettings(args, agent, dir); err != nil {
		return fmt.Errorf("local provider check: %w", err)
	}
	cctx, cancel := context.WithTimeout(ctx, localRunCheckTimeout)
	defer cancel()
	cmd := exec.CommandContext(cctx, "claude", args...)
	configureSessionProcessTree(cmd)
	cmd.Dir = dir
	cmd.Env = localProviderProcessEnv(envWithAgent(agent), agent)
	if localRunCheckEnvHook != nil {
		cmd.Env = localRunCheckEnvHook(cmd.Env)
	}
	cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("local provider check: start Claude Code: %w", err)
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	stop := func() {
		_ = terminateSessionProcessTree(cmd)
		<-exited
	}
	select {
	case c := <-got:
		stop()
		if !strings.HasPrefix(c.path, "/v1/messages") {
			return fmt.Errorf("Claude Code asked the local endpoint for %q, not a model request", c.path)
		}
		if c.auth != "Bearer "+token {
			return errors.New("Claude Code sent the local endpoint a credential other than the placeholder (a settings file or a login supplies one)")
		}
		if c.apiKey != "" {
			return errors.New("Claude Code sent the local endpoint an API key (an apiKeyHelper or a key in a settings file)")
		}
		return nil
	case <-exited:
		return errors.New("Claude Code never asked the local endpoint: a settings file on this machine sends its requests elsewhere")
	case <-cctx.Done():
		stop()
		return errors.New("Claude Code did not ask the local endpoint in time: a settings file on this machine may send its requests elsewhere")
	}
}
