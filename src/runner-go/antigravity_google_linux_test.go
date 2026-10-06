//go:build linux

package main

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestAntigravityGooglePrivateCommand(t *testing.T) {
	root := t.TempDir()
	t.Setenv("ORBIT_HOME", filepath.Join(root, "orbit"))
	if err := os.MkdirAll(antigravityGoogleDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(antigravityGoogleDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	configDir := filepath.Join(antigravityGoogleDir(), "antigravity-cli")
	if err := os.Mkdir(configDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := writeAntigravityJSON(filepath.Join(configDir, "settings.json"), map[string]interface{}{
		"modelProvider": "gemini", "theme": "dark", "enableTelemetry": true, "useG1Credits": true,
	}); err != nil {
		t.Fatal(err)
	}
	userHome := filepath.Join(root, "user-home")
	env := []string{"HOME=" + userHome, "PATH=/usr/bin:/bin", "HTTPS_PROXY=http://example.invalid",
		"GEMINI_API_KEY=fake-key", "GOOGLE_API_KEY=fake-key", "OPENAI_API_KEY=fake-key", "ANTHROPIC_API_KEY=fake-key",
		"GOOGLE_OAUTH_ACCESS_TOKEN=fake-token", "GOOGLE_APPLICATION_CREDENTIALS=/private/creds", "AGY_CLI_CDE_AUTH_ACTION=login",
		"GOOGLE_GEMINI_BASE_URL=https://example.invalid", "DBUS_SESSION_BUS_ADDRESS=unix:path=/existing/socket"}
	cmd, cleanup, err := antigravityGoogleCommand(context.Background(), "/fake/agy", env, false, "models")
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	if got := cmd.Args; len(got) != 4 || got[1] != "--gemini_dir="+antigravityGoogleDir() || got[2] != "--log-file=/dev/null" || got[3] != "models" {
		t.Fatalf("wrong Google argv: %v", got)
	}
	for _, key := range []string{"GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_OAUTH_ACCESS_TOKEN", "GOOGLE_APPLICATION_CREDENTIALS", "AGY_CLI_CDE_AUTH_ACTION", "GOOGLE_GEMINI_BASE_URL"} {
		if envValue(cmd.Env, key) != "" {
			t.Fatalf("Google command inherited %s", key)
		}
	}
	if envValue(cmd.Env, "AGY_CLI_DISABLE_AUTO_UPDATE") != "true" || envValue(cmd.Env, "HTTPS_PROXY") != "http://example.invalid" || envValue(cmd.Env, "PATH") != "/usr/bin:/bin" {
		t.Fatal("Google command lost update/proxy/PATH policy")
	}
	for _, path := range []string{antigravityGoogleDir(), cmd.Dir, envValue(cmd.Env, "HOME"), envValue(cmd.Env, "XDG_CONFIG_HOME"), envValue(cmd.Env, "XDG_DATA_HOME"), envValue(cmd.Env, "XDG_CACHE_HOME"), envValue(cmd.Env, "XDG_STATE_HOME"), envValue(cmd.Env, "XDG_RUNTIME_DIR")} {
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() != 0o700 {
			t.Fatalf("private directory %s: %v, %v", path, info, err)
		}
	}
	entries, err := os.ReadDir(cmd.Dir)
	if err != nil || len(entries) != 0 || envValue(cmd.Env, "PWD") != cmd.Dir || envValue(cmd.Env, "HOME") == userHome {
		t.Fatalf("working directory/HOME is not private and empty: %v, %v", entries, err)
	}
	dbusPath := strings.TrimPrefix(envValue(cmd.Env, "DBUS_SESSION_BUS_ADDRESS"), "unix:path=")
	if _, err := os.Stat(dbusPath); !errors.Is(err, os.ErrNotExist) || filepath.Dir(dbusPath) != filepath.Dir(cmd.Dir) {
		t.Fatalf("D-Bus does not use a nonexistent private socket: %q", dbusPath)
	}
	body, err := os.ReadFile(filepath.Join(antigravityGoogleDir(), "antigravity-cli", "settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	var settings map[string]interface{}
	if err := json.Unmarshal(body, &settings); err != nil {
		t.Fatal(err)
	}
	if _, exists := settings["modelProvider"]; exists || settings["enableTelemetry"] != false || settings["useG1Credits"] != false {
		t.Fatalf("Google settings must select account auth and disable credits: %v", settings)
	}
	if settings["theme"] != "dark" {
		t.Fatal("Google command overwrote persisted onboarding settings")
	}
	cleanup()
	if _, err := os.Stat(cmd.Dir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("temporary working directory remains: %v", err)
	}
	if _, err := os.Stat(antigravityGoogleDir()); err != nil {
		t.Fatalf("cleanup removed persistent Google credentials directory: %v", err)
	}
	if _, err := os.Stat(filepath.Join(userHome, ".gemini")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("Google command touched the user's .gemini: %v", err)
	}
}

func TestAntigravityGooglePrivateProbeCommand(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	cmd, cleanup, err := antigravityGoogleCommand(context.Background(), "/fake/agy", nil, true, "--print=/usage", "--output-format", "stream-json")
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	root := filepath.Dir(cmd.Dir)
	logFile := filepath.Join(root, "probe.log")
	if got := cmd.Args; len(got) != 6 || got[2] != "--log-file="+logFile {
		t.Fatalf("probe must have one private log argument: %v", got)
	}
	if info, err := os.Stat(root); err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("probe log directory is not private: %v %v", info, err)
	}
	if err := os.WriteFile(logFile, []byte("private agy log"), 0o600); err != nil {
		t.Fatal(err)
	}
	cleanup()
	if _, err := os.Stat(root); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("probe log directory survived cleanup: %v", err)
	}
}

func replayGoogleProbe(t *testing.T, recording googleProbeRecording, logLines ...string) string {
	t.Helper()
	dir := t.TempDir()
	stdout, stderr := filepath.Join(dir, "stdout"), filepath.Join(dir, "stderr")
	agyLog := filepath.Join(dir, "agy.log")
	if err := os.WriteFile(stdout, []byte(recording.Stdout), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(stderr, []byte(recording.Stderr), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(agyLog, []byte(strings.Join(logLines, "\n")), 0o600); err != nil {
		t.Fatal(err)
	}
	return writeFakeBin(t, dir, "agy", `
if [ "$1" = "--version" ]; then echo 1.2.16; exit 0; fi
case "$1" in --gemini_dir=*) ;; *) exit 9 ;; esac
case "$2" in --log-file=*) log_file="${2#--log-file=}" ;; *) exit 9 ;; esac
[ "$3" = "--print=/usage" ] || exit 9
[ "$4" = "--output-format" ] || exit 9
[ "$5" = "stream-json" ] || exit 9
[ -p /dev/stdin ] || exit 9
[ -z "$GEMINI_API_KEY" ] || exit 9
cat `+shellQuote(agyLog)+` > "$log_file" || exit 9
cat `+shellQuote(stdout)+`
cat `+shellQuote(stderr)+` >&2
exit `+strconv.Itoa(recording.ExitCode))
}

func TestAntigravityGoogleProbeReplay(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	for _, test := range []struct {
		name string
		want authState
	}{
		{"google-auth-print-usage.json", authYes},
		{"google-auth-invalid-refresh.json", authNo},
	} {
		t.Run(test.name, func(t *testing.T) {
			bin := replayGoogleProbe(t, loadGoogleProbeRecording(t, test.name))
			ctx, cancel := context.WithTimeout(context.Background(), time.Second*5)
			defer cancel()
			if result := probeAntigravityGoogle(ctx, bin, []string{"PATH=" + os.Getenv("PATH"), "GEMINI_API_KEY=fake-key"}); result.auth != test.want || (test.want == authNo && result.usage != nil) {
				t.Fatalf("recording replay auth = %s, want %s", authWord(result.auth), authWord(test.want))
			}
		})
	}
}

func TestAntigravityGoogleProbeNetworkFailureIsUnknown(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	measured := loadGoogleSessionFailures(t)
	for _, network := range []string{"network_proxy_refused", "network_dns"} {
		t.Run(network, func(t *testing.T) {
			lines := measured.Cases[network].LogLines
			if len(lines) == 0 {
				t.Fatalf("no log lines recorded for %s", network)
			}
			bin := replayGoogleProbe(t, googleProbeRecording{
				Stdout: measured.Stdout, Stderr: measured.Stderr, ExitCode: measured.ExitCode,
			}, lines...)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if result := probeAntigravityGoogle(ctx, bin, nil); result.auth != authUnknown || result.usage != nil {
				t.Fatalf("network failure probe = %+v, want unknown without quota", result)
			}
		})
	}
}

func TestAntigravityGoogleContractProbeNetworkFailureIsUnknown(t *testing.T) {
	path, err := exec.LookPath(agyExecutable)
	if err != nil {
		t.Fatal("real agy is required for the Linux Google contract tests:", err)
	}
	t.Setenv("ORBIT_HOME", t.TempDir())
	saveGoogleSignIn(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	proxy := "http://" + listener.Addr().String()
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	env := replaceEnv(os.Environ(), map[string]string{
		"HTTPS_PROXY": proxy, "https_proxy": proxy, "HTTP_PROXY": proxy, "http_proxy": proxy,
		"NO_PROXY": "", "no_proxy": "",
	})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	result := probeAntigravityGoogle(ctx, path, env)
	if ctx.Err() != nil {
		t.Fatal("real agy proxy refused probe did not finish:", ctx.Err())
	}
	if result.auth != authUnknown || result.usage != nil {
		t.Fatalf("real agy proxy refused probe = %+v, want unknown without quota", result)
	}
}

func TestAntigravityGoogleAuthSourceAndHealth(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	t.Setenv("GEMINI_API_KEY", "")
	bin := replayGoogleProbe(t, loadGoogleProbeRecording(t, "google-auth-print-usage.json"))
	ctx, cancel := context.WithTimeout(context.Background(), time.Second*5)
	defer cancel()
	if auth, source, usage := probeAntigravityAuth(ctx, "/must-not-run", nil); auth != authNo || source != "" || usage != nil {
		t.Fatalf("no token and no key = %s %q %v", authWord(auth), source, usage)
	}
	if auth, source, usage := probeAntigravityAuth(ctx, "/must-not-run", []string{"GEMINI_API_KEY=fake-key"}); auth != authYes || source != "env_key" || usage != nil {
		t.Fatalf("environment key fallback = %s %q %v", authWord(auth), source, usage)
	}
	if err := os.MkdirAll(filepath.Dir(antigravityGoogleTokenPath()), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(antigravityGoogleTokenPath(), []byte("fake-token-not-read-by-probe"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GEMINI_API_KEY", "fake-key")
	if got := probeAuthIn(ctx, providerAntigravity, bin, nil); got != authYes {
		t.Fatalf("Google token should select Google probe even with key: %s", authWord(got))
	}
	info, err := os.Stat(antigravityGoogleTokenPath())
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("existing token permissions not corrected: %v %v", info, err)
	}
	reports := probeEngines([]engineSpec{{name: "Antigravity", bin: providerAntigravity, exe: "agy"}}, filepath.Dir(bin))
	if len(reports) != 1 || reports[0].Auth != "yes" || reports[0].AuthSource != "google" || reports[0].PlanUsage == nil || len(reports[0].PlanUsage.Buckets) != 4 {
		t.Fatalf("health lost Google source or quota: %+v", reports)
	}
	failed := replayGoogleProbe(t, loadGoogleProbeRecording(t, "google-auth-invalid-refresh.json"))
	if auth, source, usage := probeAntigravityAuth(ctx, failed, nil); auth != authNo || source != "google" || usage != nil {
		t.Fatalf("invalid Google token must not fall back to a key: %s %q %v", authWord(auth), source, usage)
	}
}

func TestAntigravityGoogleProbeTimeout(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	bin := writeFakeBin(t, t.TempDir(), "agy", "sleep 30")
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if result := probeAntigravityGoogle(ctx, bin, nil); result.auth != authUnknown || result.usage != nil {
		t.Fatalf("timeout must stay unknown: %+v", result)
	}
}
