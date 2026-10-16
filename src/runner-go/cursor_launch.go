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
// see the real HOME. The CLI runs every command, and the login-shell snapshot before it, in $SHELL
// when that path names bash (§8.3), so SHELL is orbit-bash, a wrapper that puts the real HOME back and
// drops the CLI's own variables before it execs bash: approach A of D4 (§8.4). That the pinned CLI
// picks the wrapper up is still to be measured with a real prompt (§17.1, item 3).
//
// The environment is the allowlist (cursorBaseEnv) plus what the contract names: the session's
// directories, credentials held in memory only (AGENT_CLI_CREDENTIAL_STORE=memory, so no auth.json is
// ever written), no browser, no direnv, no debug log, and the session's own Orbit variables. The
// credential itself arrives with the session — an API key (P2) or an account's login (P4b) — and
// nothing of the runner's own is passed on.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

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
// permission mode adds are the driver's.
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
// first when this runner may.
func PrepareCursorSessionLaunch(ctx context.Context, job *ClaimedSession, execDir string) (CursorLaunchSpec, error) {
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
		Executable: exe, Args: cursorACPArgs(), Cwd: cwd,
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
	shell, err := writeCursorShellWrapper()
	if err != nil {
		return CursorLaunchSpec{}, fmt.Errorf("CURSOR_CONFIG_CONFLICT: cannot write the shell Cursor CLI runs commands in: %w", err)
	}
	spec.Env = append(cursorBaseEnv(),
		"HOME="+spec.Home,
		"SHELL="+shell,
		"CURSOR_CONFIG_DIR="+spec.ConfigDir,
		"CURSOR_DATA_DIR="+spec.DataDir,
		"AGENT_CLI_CREDENTIAL_STORE=memory",
		"NO_OPEN_BROWSER=1",
		"DIRENV_DISABLE=1",
		"CURSOR_AGENT_DISABLE_DEBUG_LOG=1",
		"ORBIT_SESSION_ID="+publicID(job.SessionID),
		"ORBIT_AGENT_ID="+publicID(job.AgentID),
		"ORBIT_TASK_ID="+publicID(job.TaskID),
		"ORBIT_ALLOW_ORCHESTRATION="+orchestrationEnv(job.AllowOrchestration),
		envWatches+"="+watchesEnv(job.WatchesDisabled),
		envWiki+"="+wikiEnv(job.WikiDisabled),
		envSpawnDepth+"="+strconv.Itoa(job.SpawnDepth),
	)
	spec.Env = append(spec.Env, bgJobEnvPairs(job.SessionID)...)
	return spec, nil
}

// writeCursorSessionConfig sets what Orbit owns in the session's cli-config.json and leaves the rest —
// the allow-always rules the CLI saves there, the model it last ran — as the CLI wrote it. `channel:
// static` turns the CLI's update check off; ACP runs none today (§1.1), and this keeps a later build
// that brings one into ACP from running it (unmeasured, §17.1 item 9). The pinned build keeps the
// value and fills in its own defaults around it (measured).
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
	if config["channel"] == "static" {
		return nil
	}
	config["channel"] = "static"
	out, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomically(path, append(out, '\n'), configFilePerm)
}

// writeCursorShellWrapper writes orbit-bash, the shell the CLI runs an agent's commands in (see the top
// of this file), and returns its path, which has to name bash or the CLI looks for bash on PATH
// instead (§8.3). The real HOME is the runner user's, written into the script.
func writeCursorShellWrapper() (string, error) {
	home := userHome()
	if home == "" {
		return "", errors.New("the runner user's home directory is unknown")
	}
	dir := filepath.Join(cursorRoot(), "bin")
	if err := ensurePrivateDir(dir); err != nil {
		return "", err
	}
	script := "#!/bin/sh\n" +
		"# Orbit: the shell Cursor CLI runs an agent's commands in. The CLI itself runs with a HOME of\n" +
		"# the session's own; its commands get the real one back, without the CLI's own variables.\n" +
		"HOME=" + shellQuote(home) + "\n" +
		"export HOME\n" +
		"unset CURSOR_API_KEY CURSOR_AUTH_TOKEN XDG_CONFIG_HOME CURSOR_CONFIG_DIR CURSOR_DATA_DIR\n" +
		"exec " + shellQuote(cursorBash()) + " \"$@\"\n"
	path := filepath.Join(dir, "orbit-bash")
	if current, err := os.ReadFile(path); err == nil && string(current) == script {
		return path, nil
	}
	if err := writeFileAtomically(path, []byte(script), 0o700); err != nil {
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
