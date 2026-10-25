package main

// Preparing a Cursor CLI session's process (docs/cursor-runtime-contract.md §16.2, §16.3): the
// boundary between what the runner sets up and the ACP driver that runs the session.
//
// Each session has Cursor CLI state of its own, kept in the session's scratch directory, which
// outlives every process the session runs and is reused when it resumes — so the conversation store
// survives a restart of the CLI or of the runner:
//
//	<runs>/<session>/cursor/config/   CURSOR_CONFIG_DIR: cli-config.json, the conversation store acp-sessions/
//	<runs>/<session>/cursor/data/     CURSOR_DATA_DIR: projects/<slug>/
//	<runs>/<session>/cursor/home/     the CLI's HOME
//
// Only HOME moves what the CLI writes and reads under ~/.cursor — its state file, the skills it syncs,
// its code-tracking database, the user's own MCP servers, hooks and rules (§8.1, §8.4) — so the CLI runs
// with a HOME of the session's, and the runner user's ~/.cursor and ~/.config/cursor are never touched.
// The commands the agent runs are another matter: they inherit the CLI's whole environment, and must
// see what a session of any other engine shows them. The CLI runs every command, and the login-shell
// snapshot before it, in $SHELL when that path names bash and not zsh (§8.3), so SHELL is the session's
// orbit-bash (writeCursorShellWrapper), a wrapper that puts the real HOME back, gives back the XDG
// directories and the variables Orbit sets only for the CLI as any other engine's session has them, and
// drops the CLI's credentials and directories before it execs bash: approach A of D4, which P0c measured
// on the pinned CLI with a real prompt (§8.4).
//
// The environment comes in three layers, each over the ones before (§16.3): the allowlist of the
// runner's own (cursorBaseEnv), of which nothing else is passed on; the session's agent environment —
// its workspace's variables — as every engine gets it, less the variables that are the runner's to read;
// and what the contract fixes, over anything the workspace set: the session's directories, credentials
// held in memory only (AGENT_CLI_CREDENTIAL_STORE=memory, so no auth.json is ever written), no browser,
// no direnv, no debug log, the session's own Orbit variables, and the credential Orbit chose for it
// (cursorLaunchCredential). The agent's commands see the workspace's variables too: orbit-bash takes away
// only the CLI's own.
//
// A session dispatched onto one of the runner's Cursor CLI accounts (ORBIT_CURSOR_ACCOUNT_DIR) borrows that
// account's login: the token its sign-in saved, handed over as CURSOR_AUTH_TOKEN and held in memory
// (cursor_account_slot.go). Nothing else of the account's directory is the session's: its conversation
// store and the CLI's settings stay in the session's own directories, whichever account it runs on.
//
// A Cursor API key saved in Orbit arrives as ORBIT_CURSOR_API_KEY (cursorAPIKeyVar), and the CLI gets
// it as its own CURSOR_API_KEY (§16.3), held in memory: it trades the key for a token itself and writes
// neither to disk (§8.2). Before the CLI starts on it, the key is checked the way §9 measured: `agent
// models` asked with it, which tells a key Cursor refuses from a Cursor API that could not be reached —
// the ACP handshake succeeds either way. The answer goes to the control plane, which keeps it on the
// key; a refused key ends the session's start with CURSOR_API_KEY_INVALID, and starts nothing.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// cursorAPIKeyVar is the variable a session's Cursor API key arrives in from the control plane (the
// apiserver's injectedEnv). The CLI gets the key as CURSOR_API_KEY; this variable never reaches it.
const cursorAPIKeyVar = "ORBIT_CURSOR_API_KEY"

// cursorAccountDirVar names the runner's Cursor CLI account a session runs on (§16.2), for the runner to
// read; it never reaches the CLI.
const cursorAccountDirVar = "ORBIT_CURSOR_ACCOUNT_DIR"

// What `agent models` asked with a Cursor API key answered, as the control plane keeps it on the key
// (@orbit/shared CURSOR_KEY_CHECK_STATES): Cursor accepted it, refused it, or could not be reached.
const (
	cursorKeyValid       = "VALID"
	cursorKeyInvalid     = "INVALID"
	cursorKeyUnreachable = "UNREACHABLE"
)

// CursorKeyCheckReport is what the runner tells the control plane after checking a session's Cursor
// API key (POST /runner/sessions/:id/cursor-key-check): the answer, and the key it was about by its
// fingerprint, never the key.
type CursorKeyCheckReport struct {
	State          string `json:"state"`
	KeyFingerprint string `json:"keyFingerprint"`
}

// cursorKeyReporter sends a CursorKeyCheckReport for a session (Transport.cursorKeyCheck).
type cursorKeyReporter func(sessionID string, report CursorKeyCheckReport) error

// cursorSessionKey is the Cursor API key the session was dispatched with, "" when it runs on a login.
func cursorSessionKey(job *ClaimedSession) string {
	return strings.TrimSpace(job.Agent.Env[cursorAPIKeyVar])
}

// cursorKeyFingerprint names a key without carrying it: the first 16 hex digits of the SHA-256 of the
// trimmed key, as the control plane names one (providers/provider-engine-resolution.ts keyFingerprint).
func cursorKeyFingerprint(key string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(key)))
	return hex.EncodeToString(sum[:])[:16]
}

// checkCursorAPIKey asks the pinned CLI whether Cursor accepts key, as §9 measured it: `agent models`
// exits 0 for a key that works, prints "The provided API key is invalid." for one Cursor refuses, and
// "Failed to reach the Cursor API" when it could not ask. "" for any other answer, which says nothing
// either way. Never the ACP handshake: `initialize` succeeds signed out, and `session/new` refuses an
// invalid key and an unreachable API with the same -32603 (§2.3, §12).
func checkCursorAPIKey(ctx context.Context, exe, key string) string {
	out, err := cursorModels(ctx, exe, "CURSOR_API_KEY="+key)
	if err == nil {
		return cursorKeyValid
	}
	var exit *exec.ExitError
	if !errors.As(err, &exit) {
		return ""
	}
	text := strings.ToLower(out)
	switch {
	case strings.Contains(text, "the provided api key is invalid"):
		return cursorKeyInvalid
	case strings.Contains(text, "failed to reach the cursor api"):
		return cursorKeyUnreachable
	}
	return ""
}

// cursorAPIKeyInvalidMessage is how a session whose Cursor API key Cursor refused ends its start.
const cursorAPIKeyInvalidMessage = "CURSOR_API_KEY_INVALID: Cursor refused this session's API key (\"The provided API key is invalid.\"); " +
	"save a new key for it in Orbit, then try again"

// checkCursorSessionKey checks the session's Cursor API key before its CLI starts, tells the control
// plane what Cursor answered (report; nil tells nobody), and refuses a key Cursor refused. A Cursor API
// it could not reach, or an answer it cannot read, is no verdict on the key: the session starts, and the
// CLI says what it finds.
func checkCursorSessionKey(ctx context.Context, exe string, job *ClaimedSession, key string, report cursorKeyReporter) error {
	state := checkCursorAPIKey(ctx, exe, key)
	if state != "" && report != nil {
		if err := report(job.SessionID, CursorKeyCheckReport{State: state, KeyFingerprint: cursorKeyFingerprint(key)}); err != nil {
			logln("cursor:", job.SessionID+":", "could not report the API key check:", err)
		}
	}
	if state == cursorKeyInvalid {
		return errors.New(cursorAPIKeyInvalidMessage)
	}
	return nil
}

// CursorLaunchSpec is one Cursor CLI session process: the pinned build's entry point, the arguments
// and environment it starts with, the session's checkout, and the session's own directories. Env will
// carry the session's credential, so the spec never prints or serializes it.
type CursorLaunchSpec struct {
	Executable string
	Args       []string
	Env        []string
	Cwd        string
	ConfigDir  string // CURSOR_CONFIG_DIR
	DataDir    string // CURSOR_DATA_DIR
	Home       string // the CLI's HOME, never the runner user's
	Version    string
}

func (s CursorLaunchSpec) String() string {
	return fmt.Sprintf("Cursor CLI %s (cwd=%s, CURSOR_CONFIG_DIR=%s)", s.Version, s.Cwd, s.ConfigDir)
}

func (s CursorLaunchSpec) GoString() string { return s.String() }

func (s CursorLaunchSpec) MarshalJSON() ([]byte, error) {
	return json.Marshal(map[string]interface{}{
		"Executable": s.Executable, "Args": s.Args, "Cwd": s.Cwd,
		"ConfigDir": s.ConfigDir, "DataDir": s.DataDir, "Home": s.Home, "Version": s.Version,
	})
}

// cursorACPArgs are the arguments every `agent acp` Orbit starts carries (§16.3): no self-update — ACP
// runs no update check today (§1.1), and the flag keeps it so whatever a later build adds — and no
// codebase indexing, D1's default, which uploads whole files from some accounts (§14.3). The flags a
// permission mode adds follow them (cursorPermissionArgs).
func cursorACPArgs() []string {
	return []string{"acp", "--disable-auto-update", "--disable-indexing"}
}

var cursorSessionIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]*$`)

// cursorSessionDir is where a session's Cursor CLI state lives, inside its scratch directory.
func cursorSessionDir(sessionID string) (string, error) {
	// Decoded, a blank id would be the all-zero UUID: a directory no session owns.
	id := decodeSessionID(sessionID)
	if strings.TrimSpace(sessionID) == "" || !cursorSessionIDPattern.MatchString(id) {
		return "", errors.New("CURSOR_CONFIG_CONFLICT: invalid Orbit session identity")
	}
	return filepath.Join(runDir(id), "cursor"), nil
}

// PrepareCursorSessionLaunch prepares the session's process on the pinned build, installing the build
// first when this runner may. A session dispatched with a Cursor API key has the key checked first
// (checkCursorSessionKey), and what Cursor answered goes to the control plane through report.
func PrepareCursorSessionLaunch(ctx context.Context, job *ClaimedSession, execDir string, report cursorKeyReporter) (CursorLaunchSpec, error) {
	if msg := ensureEngine(ctx, providerCursor, func(string) {}); msg != "" {
		return CursorLaunchSpec{}, errors.New(msg)
	}
	exe, err := cursorExecutablePath()
	if err != nil {
		return CursorLaunchSpec{}, err
	}
	dir, err := cursorSessionDir(job.SessionID)
	if err != nil {
		return CursorLaunchSpec{}, err
	}
	if key := cursorSessionKey(job); key != "" {
		if err := checkCursorSessionKey(ctx, exe, job, key, report); err != nil {
			return CursorLaunchSpec{}, err
		}
	}
	return prepareCursorLaunch(job, execDir, exe, dir)
}

// prepareCursorLaunch lays out dir for the session and builds its launch on exe. Everything the CLI
// keeps there is left as it is: preparing again — the next process of the same session — finds the
// conversation store where the last one left it.
func prepareCursorLaunch(job *ClaimedSession, execDir, exe, dir string) (CursorLaunchSpec, error) {
	if !filepath.IsAbs(exe) {
		return CursorLaunchSpec{}, errors.New("CURSOR_VERSION_INCOMPATIBLE: the Cursor CLI entry point must be an absolute path")
	}
	cwd, err := filepath.Abs(execDir)
	if err == nil {
		cwd, err = filepath.EvalSymlinks(cwd)
	}
	if err != nil {
		return CursorLaunchSpec{}, errors.New("CURSOR_CONFIG_CONFLICT: the session's working directory is unavailable")
	}
	if info, err := os.Stat(cwd); err != nil || !info.IsDir() {
		return CursorLaunchSpec{}, errors.New("CURSOR_CONFIG_CONFLICT: the session's working directory must be a directory")
	}
	spec := CursorLaunchSpec{
		Executable: exe, Args: append(cursorACPArgs(), cursorPermissionArgs(job.Agent.PermissionMode)...), Cwd: cwd,
		ConfigDir: filepath.Join(dir, "config"), DataDir: filepath.Join(dir, "data"), Home: filepath.Join(dir, "home"),
		Version: cursorSupportedVersion,
	}
	for _, d := range []string{dir, spec.ConfigDir, spec.DataDir, spec.Home} {
		if err := ensurePrivateDir(d); err != nil {
			return CursorLaunchSpec{}, fmt.Errorf("CURSOR_CONFIG_CONFLICT: the session's Cursor CLI directory must be private and not a link: %w", err)
		}
	}
	if err := writeCursorSessionConfig(spec.ConfigDir); err != nil {
		return CursorLaunchSpec{}, err
	}
	shell, err := writeCursorShellWrapper(dir, job.Agent.Env)
	if err != nil {
		return CursorLaunchSpec{}, fmt.Errorf("CURSOR_CONFIG_CONFLICT: cannot write the shell Cursor CLI runs commands in: %w", err)
	}
	credential, value, err := cursorLaunchCredential(job)
	if err != nil {
		return CursorLaunchSpec{}, err
	}
	// The workspace's variables over the allowlist, but those that are the runner's: its session context
	// and the variables the control plane hands the runner to read.
	agent := map[string]string{}
	for key, value := range job.Agent.Env {
		if !sessionContextEnvKey(key) && !strings.EqualFold(key, "ORBIT_HOME") && key != cursorAPIKeyVar && key != cursorAccountDirVar {
			agent[key] = value
		}
	}
	fixed := map[string]string{
		"HOME":                           spec.Home,
		"SHELL":                          shell,
		"CURSOR_CONFIG_DIR":              spec.ConfigDir,
		"CURSOR_DATA_DIR":                spec.DataDir,
		"AGENT_CLI_CREDENTIAL_STORE":     "memory",
		"NO_OPEN_BROWSER":                "1",
		"DIRENV_DISABLE":                 "1",
		"CURSOR_AGENT_DISABLE_DEBUG_LOG": "1",
		"ORBIT_SESSION_ID":               publicID(job.SessionID),
		"ORBIT_AGENT_ID":                 publicID(job.AgentID),
		"ORBIT_TASK_ID":                  publicID(job.TaskID),
		"ORBIT_ALLOW_ORCHESTRATION":      orchestrationEnv(job.AllowOrchestration),
		envWatches:                       watchesEnv(job.WatchesDisabled),
		envWiki:                          wikiEnv(job.WikiDisabled),
		envSpawnDepth:                    strconv.Itoa(job.SpawnDepth),
	}
	for _, pair := range bgJobEnvPairs(job.SessionID) {
		key, value, _ := strings.Cut(pair, "=")
		fixed[key] = value
	}
	spec.Env = cursorOverlay(runnerChildEnv(cursorOverlay(cursorBaseEnv(), agent)), fixed)
	if credential != "" {
		// Orbit's choice replaces whatever key or token the workspace set, under the CLI's own name and
		// in memory only (§8.2, §16.3).
		kept := spec.Env[:0]
		for _, entry := range spec.Env {
			if key, _, _ := strings.Cut(entry, "="); key != "CURSOR_API_KEY" && key != "CURSOR_AUTH_TOKEN" {
				kept = append(kept, entry)
			}
		}
		spec.Env = append(kept, credential+"="+value)
	}
	return spec, nil
}

// cursorOverlay sets values over env, a key at a time in a fixed order, each replacing what env held.
func cursorOverlay(env []string, values map[string]string) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		env = envWithValue(env, key, values[key])
	}
	return env
}

// cursorLaunchCredential is the credential Orbit chooses for the session's CLI, as the variable the CLI
// reads it from and its value (§2.3, §16.3): the Cursor API key the session was dispatched (P2), else the
// login of the added account it was dispatched onto, as a token — either one Orbit's choice, over any key
// or token of the workspace's; none of Orbit's when the workspace's own variables bring a CURSOR_API_KEY
// or a CURSOR_AUTH_TOKEN, as the control plane's sign-in preflight counts them (hasInjectedCredentials
// reads the same); else the login saved for the runner's Default account (§16.2), as a token. Nothing at
// all is a session that cannot sign in, which the driver refuses before anything starts. An added account
// that is not signed in, or whose sign-in has expired, refuses the session: it never falls back to another
// account's login.
func cursorLaunchCredential(job *ClaimedSession) (string, string, error) {
	if key := cursorSessionKey(job); key != "" {
		return "CURSOR_API_KEY", key, nil
	}
	env := job.Agent.Env
	dir, err := cursorSessionAccountDir(env)
	if err != nil {
		return "", "", errors.New("Failed to authenticate: " + err.Error())
	}
	if def, err := filepath.Abs(cursorDefaultAccountDir()); err != nil || dir != def {
		token, err := cursorAccountLogin(dir)
		if err != nil {
			return "", "", errors.New("Failed to authenticate: the Cursor CLI account this session runs on " + err.Error() +
				" — sign it in again from here, or pick another account")
		}
		return "CURSOR_AUTH_TOKEN", token, nil
	}
	if strings.TrimSpace(env["CURSOR_API_KEY"]) != "" || strings.TrimSpace(env["CURSOR_AUTH_TOKEN"]) != "" {
		return "", "", nil
	}
	token, err := cursorStoredLogin(cursorDefaultAccountDir())
	if err != nil {
		return "", "", errors.New("Failed to authenticate: " + err.Error())
	}
	if token == "" || cursorTokenExpired(token, time.Now()) {
		return "", "", nil
	}
	return "CURSOR_AUTH_TOKEN", token, nil
}

// cursorSignedOutMessage is how a session that has no credential to run Cursor CLI on ends: no key of its
// own, and the Default account not signed in.
func cursorSignedOutMessage() string {
	return "Failed to authenticate: Cursor CLI is not signed in on this runner, and this session brings no Cursor API key. " +
		"Sign in with: " + cursorLoginHint()
}

// writeCursorSessionConfig sets what Orbit owns in the session's cli-config.json and leaves the rest —
// the model it last ran, the CLI's own preferences — as the CLI wrote it. `channel: static` turns the
// CLI's update check off; ACP runs none today (§1.1), and this keeps a later build that brings one into
// ACP from running it (unmeasured, §17.1 item 9). The pinned build keeps the value and fills in its own
// defaults around it (measured). What decides that something runs unasked is Orbit's as well
// (cursor_permissions.go): the allowlist goes back to the CLI's own default — `ls`, no deny rules — with
// approval by allowlist and no web search accepted unasked (§5.3), so no rule that did not come from a
// person's answer on Orbit's card lets a command, a tool or a search run unasked. Orbit never answers with
// Cursor's allow-always, so the CLI never adds one of its own.
func writeCursorSessionConfig(configDir string) error {
	path := filepath.Join(configDir, "cli-config.json")
	config := map[string]interface{}{}
	data, err := os.ReadFile(path)
	switch {
	case err == nil:
		if json.Unmarshal(data, &config) != nil || config == nil {
			return fmt.Errorf("CURSOR_CONFIG_CONFLICT: the session's %s is not a JSON object; it is left as it is", path)
		}
	case errors.Is(err, os.ErrNotExist):
		config["version"] = 1
	default:
		return fmt.Errorf("CURSOR_CONFIG_CONFLICT: the session's %s cannot be read: %w", path, err)
	}
	owned := map[string]interface{}{
		"channel":             "static",
		"permissions":         map[string]interface{}{"allow": []interface{}{"Shell(ls)"}, "deny": []interface{}{}},
		"approvalMode":        "allowlist",
		"autoAcceptWebSearch": false,
	}
	changed := false
	for key, value := range owned {
		if !reflect.DeepEqual(config[key], value) {
			config[key], changed = value, true
		}
	}
	if !changed {
		return nil
	}
	out, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomically(path, append(out, '\n'), configFilePerm)
}

// cursorCommandRestored are variables the CLI's environment holds for the CLI's own sake, which a command
// the agent runs gets back as a session of any other engine has them: Orbit's settings for the CLI (§16.3)
// and the compile cache Cursor's launcher points into the CLI's HOME (§8.4). SHELL is not among them: it
// stays orbit-bash, so a command that starts $SHELL gets the same environment back.
var cursorCommandRestored = []string{"AGENT_CLI_CREDENTIAL_STORE", "CURSOR_AGENT_DISABLE_DEBUG_LOG", "DIRENV_DISABLE",
	"NODE_COMPILE_CACHE", "NO_OPEN_BROWSER"}

// cursorCommandXDG are the XDG base-directory variables, which the CLI's allowlist leaves out: restored for
// a command whether or not anything sets them, beside every other XDG_ variable the runner or the
// workspace sets.
var cursorCommandXDG = []string{"XDG_CACHE_HOME", "XDG_CONFIG_DIRS", "XDG_CONFIG_HOME", "XDG_DATA_DIRS", "XDG_DATA_HOME",
	"XDG_RUNTIME_DIR", "XDG_STATE_HOME"}

// cursorCommandDropped are the CLI's credentials and directories, which no command gets (§8.4).
var cursorCommandDropped = []string{"CURSOR_API_KEY", "CURSOR_AUTH_TOKEN", "CURSOR_CONFIG_DIR", "CURSOR_DATA_DIR"}

var shellNamePattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// cursorCommandEnv is what orbit-bash gives a command of the variables it restores: the names, sorted,
// and the value of each that a session of any other engine has (envWithAgent) — the workspace's, else
// the runner's own; one in neither is left unset.
func cursorCommandEnv(agentEnv map[string]string) ([]string, map[string]string) {
	names := map[string]bool{}
	for _, name := range append(append([]string(nil), cursorCommandRestored...), cursorCommandXDG...) {
		names[name] = true
	}
	for _, entry := range os.Environ() {
		if name, _, _ := strings.Cut(entry, "="); strings.HasPrefix(name, "XDG_") {
			names[name] = true
		}
	}
	for name := range agentEnv {
		if strings.HasPrefix(name, "XDG_") {
			names[name] = true
		}
	}
	keys := make([]string, 0, len(names))
	values := map[string]string{}
	for name := range names {
		if !shellNamePattern.MatchString(name) {
			continue
		}
		keys = append(keys, name)
		if value, ok := agentEnv[name]; ok {
			values[name] = value
		} else if value, ok := os.LookupEnv(name); ok {
			values[name] = value
		}
	}
	sort.Strings(keys)
	return keys, values
}

// cursorShellPathUsable is whether the CLI runs its commands through a shell at path: it takes $SHELL only
// when the path names bash, and treats it as zsh first when the path names zsh anywhere (§8.3; index.js
// checks the whole path with includes("zsh") before includes("bash")).
func cursorShellPathUsable(path string) bool {
	return strings.Contains(path, "bash") && !strings.Contains(path, "zsh")
}

// writeCursorShellWrapper writes the session's orbit-bash, the shell the CLI runs the agent's commands in
// (see the top of this file), in the session's Cursor CLI directory dir, and returns its path. The real
// HOME is the runner user's; what else it restores is the session's (cursorCommandEnv), so each session
// has a wrapper of its own. A path the CLI would not take as bash is refused: the CLI would run the
// commands in a bash of its own choosing, on the CLI's HOME and with its credentials.
func writeCursorShellWrapper(dir string, agentEnv map[string]string) (string, error) {
	home := userHome()
	if home == "" {
		return "", errors.New("the runner user's home directory is unknown")
	}
	bin := filepath.Join(dir, "bin")
	path := filepath.Join(bin, "orbit-bash")
	if !cursorShellPathUsable(path) {
		return "", fmt.Errorf("Cursor CLI would not run commands through %s: it takes $SHELL only when that path names bash and not zsh", path)
	}
	if err := ensurePrivateDir(bin); err != nil {
		return "", err
	}
	keys, values := cursorCommandEnv(agentEnv)
	var script strings.Builder
	script.WriteString("#!/bin/sh\n" +
		"# Orbit: the shell Cursor CLI runs this session's commands in. The CLI runs with a HOME of the\n" +
		"# session's own; its commands get the real one back, the environment a session of any other engine\n" +
		"# gives them, and none of the CLI's credentials or directories.\n" +
		"HOME=" + shellQuote(home) + "\n" +
		"export HOME\n" +
		"unset " + strings.Join(cursorCommandDropped, " ") + " " + strings.Join(keys, " ") + "\n")
	for _, key := range keys {
		if value, ok := values[key]; ok {
			script.WriteString(key + "=" + shellQuote(value) + "\n" + "export " + key + "\n")
		}
	}
	script.WriteString("exec " + shellQuote(cursorBash()) + " \"$@\"\n")
	if current, err := os.ReadFile(path); err == nil && string(current) == script.String() {
		return path, nil
	}
	if err := writeFileAtomically(path, []byte(script.String()), 0o700); err != nil {
		return "", err
	}
	return path, nil
}

// cursorBash is the bash orbit-bash hands commands to.
func cursorBash() string {
	if info, err := os.Stat("/bin/bash"); err == nil && !info.IsDir() {
		return "/bin/bash"
	}
	if path, ok := lookPathIn("bash", serviceLoginPath()); ok {
		return path
	}
	return "/bin/bash"
}
