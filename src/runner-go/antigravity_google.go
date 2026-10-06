package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

func antigravityGoogleDir() string {
	return filepath.Join(machineHome(), "antigravity", "google")
}

func antigravityGoogleTokenPath() string {
	return antigravityTokenFile(antigravityGoogleDir())
}

// antigravityTokenFile is where agy keeps a Google sign-in in a Gemini directory (contract §16.2).
func antigravityTokenFile(geminiDir string) string {
	return filepath.Join(geminiDir, "antigravity-cli", "antigravity-oauth-token")
}

// antigravityGoogleSignInSaved is whether this runner keeps a Google sign-in for agy: a token file in
// its credential directory — or one it cannot even look at, which is no reason to fall back to a key
// either (probeAntigravityAuth).
func antigravityGoogleSignInSaved() bool {
	return antigravityGoogleSignInSavedIn(antigravityGoogleDir())
}

// antigravityGoogleSignInSavedIn is antigravityGoogleSignInSaved for one account's Gemini directory.
func antigravityGoogleSignInSavedIn(dir string) bool {
	info, err := os.Stat(antigravityTokenFile(dir))
	if err != nil {
		return !errors.Is(err, os.ErrNotExist)
	}
	return !info.IsDir()
}

// antigravityCredentialEnvKey is whether an environment variable carries a credential, or an endpoint,
// agy could run on instead of the Google sign-in Orbit gives it: API keys and tokens, OAuth settings,
// Google's application-default and gcloud credentials, Vertex, the Gemini endpoint override, and agy's
// hidden auth action. No agy that runs on the Google sign-in sees any of them.
func antigravityCredentialEnvKey(key string) bool {
	return strings.HasSuffix(key, "_API_KEY") || strings.HasSuffix(key, "_API_TOKEN") ||
		strings.HasSuffix(key, "_ACCESS_TOKEN") || strings.HasSuffix(key, "_REFRESH_TOKEN") ||
		strings.HasSuffix(key, "_AUTH_TOKEN") || strings.Contains(key, "OAUTH") ||
		strings.HasPrefix(key, "AGY_CLI_CDE_") || key == "GOOGLE_APPLICATION_CREDENTIALS" ||
		key == "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE" || key == "GOOGLE_GEMINI_BASE_URL" ||
		key == "GEMINI_TOKEN" || key == "GOOGLE_ACCESS_TOKEN" || key == "GOOGLE_GENAI_USE_VERTEXAI"
}

// antigravityGoogleCommand is the shared entry for login, auth/usage, and Google model reads.
// HOME, XDG and the empty working directory last only for this invocation; the Gemini directory
// persists — Default's, or the account's env names (antigravityGoogleDirIn). An unreachable private
// D-Bus socket keeps agy away from the system's shared keyring. Only the usage probe keeps agy's log,
// in this invocation's private temporary directory.
func antigravityGoogleCommand(ctx context.Context, binPath string, env []string, probeLog bool, args ...string) (*exec.Cmd, func(), error) {
	dir, err := filepath.Abs(antigravityGoogleDirIn(env))
	if err != nil {
		return nil, nil, err
	}
	configDir := filepath.Join(dir, "antigravity-cli")
	for _, path := range []string{dir, configDir} {
		if err := os.MkdirAll(path, machineHomePerm); err != nil {
			return nil, nil, err
		}
		if err := os.Chmod(path, machineHomePerm); err != nil {
			return nil, nil, err
		}
	}
	if err := os.Chmod(antigravityTokenFile(dir), 0o600); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, nil, err
	}
	settingsPath := filepath.Join(configDir, "settings.json")
	settings := map[string]interface{}{}
	if body, err := os.ReadFile(settingsPath); err == nil {
		if err := json.Unmarshal(body, &settings); err != nil {
			return nil, nil, err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, nil, err
	}
	if settings == nil {
		settings = map[string]interface{}{}
	}
	delete(settings, "modelProvider")
	settings["enableTelemetry"] = false
	settings["useG1Credits"] = false
	if err := writeAntigravityJSON(settingsPath, settings); err != nil {
		return nil, nil, err
	}
	root, err := os.MkdirTemp(filepath.Dir(dir), ".google-runtime-")
	if err != nil {
		return nil, nil, err
	}
	cleanup := func() { _ = os.RemoveAll(root) }
	for _, name := range []string{"home", "cwd", "config", "data", "cache", "state", "runtime"} {
		if err := os.Mkdir(filepath.Join(root, name), machineHomePerm); err != nil {
			cleanup()
			return nil, nil, err
		}
	}
	if env == nil {
		env = os.Environ()
	}
	cleanEnv := make([]string, 0, len(env))
	for _, entry := range env {
		key, _, _ := strings.Cut(entry, "=")
		if antigravityCredentialEnvKey(key) || key == antigravityAccountDirVar || key == "SSH_CONNECTION" ||
			key == "SSH_CLIENT" || key == "SSH_TTY" || key == "DISPLAY" || key == "WAYLAND_DISPLAY" || key == "XAUTHORITY" {
			continue
		}
		cleanEnv = append(cleanEnv, entry)
	}
	cleanEnv = replaceEnv(cleanEnv, map[string]string{
		"HOME": filepath.Join(root, "home"), "PWD": filepath.Join(root, "cwd"),
		"XDG_CONFIG_HOME": filepath.Join(root, "config"), "XDG_DATA_HOME": filepath.Join(root, "data"),
		"XDG_CACHE_HOME": filepath.Join(root, "cache"), "XDG_STATE_HOME": filepath.Join(root, "state"),
		"XDG_RUNTIME_DIR":             filepath.Join(root, "runtime"),
		"DBUS_SESSION_BUS_ADDRESS":    "unix:path=" + filepath.Join(root, "absent-dbus"),
		"AGY_CLI_DISABLE_AUTO_UPDATE": "true",
	})
	logFile := "/dev/null"
	if probeLog {
		logFile = filepath.Join(root, "probe.log")
	}
	argv := append([]string{"--gemini_dir=" + dir, "--log-file=" + logFile}, args...)
	cmd := exec.CommandContext(ctx, binPath, argv...)
	cmd.Env = cleanEnv
	cmd.Dir = filepath.Join(root, "cwd")
	configureSessionProcessTree(cmd)
	return cmd, cleanup, nil
}

type antigravityGoogleProbe struct {
	auth  authState
	usage *PlanUsage
}

func probeAntigravityGoogle(ctx context.Context, binPath string, env []string) antigravityGoogleProbe {
	cmd, cleanup, err := antigravityGoogleCommand(ctx, binPath, env, true, "--print=/usage", "--output-format", "stream-json")
	if err != nil {
		return antigravityGoogleProbe{auth: authUnknown}
	}
	defer cleanup()
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	// agy treats /dev/null stdin as an interactive OAuth wait. A real pipe (including EOF)
	// selects the recorded headless authentication-required path instead.
	cmd.Stdin = strings.NewReader("")
	_ = cmd.Run()
	if ctx.Err() != nil {
		return antigravityGoogleProbe{auth: authUnknown}
	}
	exitCode := -1
	if cmd.ProcessState != nil {
		exitCode = cmd.ProcessState.ExitCode()
	}
	probe := parseAntigravityGoogleProbe(stdout.Bytes(), stderr.String(), exitCode)
	if probe.auth == authNo && classifyAgyAuthEnd(exitCode, false, stderr.String(),
		readAgyLog(filepath.Join(filepath.Dir(cmd.Dir), "probe.log"))) == agyAuthEndNetwork {
		return antigravityGoogleProbe{auth: authUnknown}
	}
	return probe
}

// parseAntigravityGoogleProbe only retains the usage command's four public bucket fields.
// A generic ERROR or a failing exit is ambiguous; the recorded authentication-error combination
// and absence of init is the only negative answer (contract §16.4–16.6).
func parseAntigravityGoogleProbe(stdout []byte, stderr string, exitCode int) antigravityGoogleProbe {
	var sawInit, success bool
	var buckets []PlanUsageBucket
	dec := json.NewDecoder(bytes.NewReader(stdout))
	for {
		var event struct {
			Event   string                         `json:"event"`
			Command *antigravityGoogleUsageCommand `json:"command"`
			Result  struct {
				Status  string                         `json:"status"`
				Command *antigravityGoogleUsageCommand `json:"command"`
			} `json:"result"`
		}
		if err := dec.Decode(&event); errors.Is(err, io.EOF) {
			break
		} else if err != nil {
			return antigravityGoogleProbe{auth: authUnknown}
		}
		sawInit = sawInit || event.Event == "init"
		if event.Event == "result" && event.Result.Status == "SUCCESS" {
			success = true
		}
		command := event.Command
		if event.Event == "result" && event.Result.Command != nil {
			command = event.Result.Command
		}
		if command != nil && command.Name == "usage" {
			buckets = nil
			for _, group := range command.Data.Groups {
				for _, bucket := range group.Buckets {
					buckets = append(buckets, PlanUsageBucket{
						ID: bucket.ID, Window: bucket.Window,
						RemainingFraction: bucket.RemainingFraction, ResetTime: bucket.ResetTime,
					})
				}
			}
		}
	}
	if success {
		return antigravityGoogleProbe{auth: authYes, usage: &PlanUsage{
			Provider: providerAntigravity, Buckets: buckets, FetchedAt: time.Now().UTC().Format(time.RFC3339),
		}}
	}
	lower := strings.ToLower(stderr)
	if exitCode == 1 && !sawInit && strings.Contains(lower, "authentication required") &&
		strings.Contains(lower, "authentication failed or timed out") {
		return antigravityGoogleProbe{auth: authNo}
	}
	return antigravityGoogleProbe{auth: authUnknown}
}

type antigravityGoogleUsageCommand struct {
	Name string `json:"name"`
	Data struct {
		Groups []struct {
			Buckets []struct {
				ID                string  `json:"id"`
				Window            string  `json:"window"`
				RemainingFraction float64 `json:"remaining_fraction"`
				ResetTime         string  `json:"reset_time"`
			} `json:"buckets"`
		} `json:"groups"`
	} `json:"data"`
}

func probeAntigravityAuth(ctx context.Context, binPath string, env []string) (authState, string, *PlanUsage) {
	if info, err := os.Stat(antigravityTokenFile(antigravityGoogleDirIn(env))); err == nil && !info.IsDir() {
		result := probeAntigravityGoogle(ctx, binPath, env)
		return result.auth, "google", result.usage
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return authUnknown, "google", nil
	}
	if env == nil {
		env = os.Environ()
	}
	if strings.TrimSpace(envValue(env, "GEMINI_API_KEY")) != "" {
		return authYes, "env_key", nil
	}
	return authNo, "", nil
}
