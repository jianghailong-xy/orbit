package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync/atomic"
)

// Where an owner-request secret may be written as a file (docs/design/owner-request-secrets.md §5.2). `orbit mcp`
// checks these rules before it files a SECRET request, and the runner checks them again when it writes the file; the
// write itself then goes down one directory at a time and refuses a link anywhere (writeSecretFile), so a link put in
// place after this check cannot move the write either.

// secretEnvVarPattern is the shape of an env-var secret's name, as the control plane checks it.
var secretEnvVarPattern = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,63}$`)

// secretFilePathMax is the longest filePath the control plane accepts.
const secretFilePathMax = 1000

// secretEngineConfigDirs are the coding engines' own directories under the home. A secret written there would sit
// beside the engine's credentials and settings, which the engine reads as its own.
var secretEngineConfigDirs = []string{
	".claude", ".codex", ".kimi", ".cursor", ".gemini", ".opencode", ".dsh", ".antigravity",
	filepath.Join(".config", "opencode"), filepath.Join(".local", "share", "opencode"),
}

// secretWorkspaceDirs are the workspaces' working directories this runner was last told about (the heartbeat's
// AgentDirs). A secret in one would be swept into the workspace by the end of a turn.
var secretWorkspaceDirs atomic.Pointer[[]string]

func setSecretWorkspaceDirs(targets []AgentDirTarget) {
	dirs := make([]string, 0, len(targets))
	for _, target := range targets {
		if target.WorkDir != "" {
			dirs = append(dirs, expandTilde(target.WorkDir))
		}
	}
	secretWorkspaceDirs.Store(&dirs)
}

func knownSecretWorkspaceDirs() []string {
	if dirs := secretWorkspaceDirs.Load(); dirs != nil {
		return *dirs
	}
	return nil
}

// checkSecretEnvVar refuses an env-var name the control plane would refuse, saying why.
func checkSecretEnvVar(name string) error {
	if !secretEnvVarPattern.MatchString(name) {
		return fmt.Errorf("secretSpec.envVar %q must match ^[A-Z][A-Z0-9_]{0,63}$", name)
	}
	if secretEnvVarReserved(name) {
		return fmt.Errorf("secretSpec.envVar %q is reserved: Orbit, the shell or a language runtime already gives it a meaning", name)
	}
	return nil
}

// secretEnvVarReserved names what a secret may not be called: the session's own context, the person's credential,
// and the variables that change how a shell, the loader or a runtime starts a program.
func secretEnvVarReserved(name string) bool {
	if sessionContextEnvKey(name) || userCredentialEnvKey(name) {
		return true
	}
	switch name {
	case "PATH", "HOME", "BASH_ENV", "ENV", "NODE_OPTIONS":
		return true
	}
	for _, prefix := range []string{"ORBIT_", "LD_", "DYLD_", "PYTHON"} {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}

// secretPathError is a refusal of a filePath, worded for the agent that asked for it.
type secretPathError struct {
	code string
	msg  string
}

func (e *secretPathError) Error() string { return "secretSpec.filePath " + e.msg }

const (
	secretPathCodeShape   = "SECRET_PATH_INVALID"
	secretPathCodeRefused = "SECRET_PATH_REFUSED"
	secretPathCodeLink    = "SECRET_PATH_SYMLINK"
	secretPathCodeExists  = "SECRET_PATH_EXISTS"
)

func secretPathRefusal(code, format string, args ...interface{}) error {
	return &secretPathError{code: code, msg: fmt.Sprintf(format, args...)}
}

// secretFileTarget is a filePath that passed the rules: the absolute path, the home it is under, its components below
// that home, and the directories below the home that do not exist yet and would be created.
type secretFileTarget struct {
	path    string
	home    string
	rel     []string
	missing []string
}

// checkSecretFilePath applies every rule of §5.2 to raw, as the agent wrote it. workDirs are the workspaces' working
// directories known here; Orbit's own directory and the engines' are added to them.
func checkSecretFilePath(raw string, workDirs []string) (*secretFileTarget, error) {
	if raw == "" {
		return nil, secretPathRefusal(secretPathCodeShape, "is empty")
	}
	if strings.ContainsRune(raw, 0) {
		return nil, secretPathRefusal(secretPathCodeShape, "contains a NUL byte")
	}
	if len(raw) > secretFilePathMax {
		return nil, secretPathRefusal(secretPathCodeShape, "is longer than %d characters", secretFilePathMax)
	}
	if !filepath.IsAbs(raw) && !strings.HasPrefix(raw, "~/") {
		return nil, secretPathRefusal(secretPathCodeShape, "%q must be absolute or start with ~/", raw)
	}
	for _, part := range strings.Split(raw, "/") {
		if part == ".." {
			return nil, secretPathRefusal(secretPathCodeShape, "%q must not contain a .. segment", raw)
		}
	}
	userDir := userHome()
	if userDir == "" {
		return nil, secretPathRefusal(secretPathCodeRefused, "cannot be checked: the runner user's home directory is unknown")
	}
	path := filepath.Clean(expandTilde(raw))
	// The home may itself be reached through a link (/home -> /usr/home); what is below it may not.
	home := ""
	var rest string
	for _, candidate := range []string{filepath.Clean(userDir), realPath(userDir)} {
		if rel, err := filepath.Rel(candidate, path); err == nil && rel != "." && rel != ".." &&
			!strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			home, rest = candidate, rel
			break
		}
	}
	if home == "" {
		return nil, secretPathRefusal(secretPathCodeRefused, "%q must be under the runner user's home directory (%s)", raw, userDir)
	}
	rel := strings.Split(rest, string(filepath.Separator))

	// No link and nothing but directories on the way down; the leaf must not exist at all.
	target := &secretFileTarget{path: path, home: home, rel: rel}
	at := home
	exists := true
	for i, part := range rel {
		at = filepath.Join(at, part)
		if !exists {
			if i < len(rel)-1 {
				target.missing = append(target.missing, at)
			}
			continue
		}
		info, err := os.Lstat(at)
		if errors.Is(err, fs.ErrNotExist) {
			exists = false
			if i < len(rel)-1 {
				target.missing = append(target.missing, at)
			}
			continue
		}
		if err != nil {
			return nil, secretPathRefusal(secretPathCodeRefused, "cannot be checked at %s: %v", at, err)
		}
		if i == len(rel)-1 {
			return nil, secretPathRefusal(secretPathCodeExists,
				"%q already exists: Orbit writes a secret only to a file that does not exist yet, so nothing of yours is overwritten", raw)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return nil, secretPathRefusal(secretPathCodeLink, "%q goes through a symbolic link at %s", raw, at)
		}
		if !info.IsDir() {
			return nil, secretPathRefusal(secretPathCodeRefused, "%q goes through %s, which is not a directory", raw, at)
		}
	}

	// Below the home nothing is a link, so the path as written is where it is.
	if pathInsideAny(path, absPath(machineHome()), realPath(machineHome())) {
		return nil, secretPathRefusal(secretPathCodeRefused, "%q is inside Orbit's own directory (%s)", raw, machineHome())
	}
	for _, dir := range workDirs {
		// A workspace at / or at the home itself would refuse every path; the .git rule below still holds there.
		if dir == "" || !usableAsARoot(dir) {
			continue
		}
		if pathInsideAny(path, absPath(dir), realPath(dir)) {
			return nil, secretPathRefusal(secretPathCodeRefused, "%q is inside a workspace's working directory (%s)", raw, dir)
		}
	}
	for _, name := range secretEngineConfigDirs {
		dir := filepath.Join(home, name)
		if pathInsideAny(path, dir) {
			return nil, secretPathRefusal(secretPathCodeRefused, "%q is inside a coding engine's configuration directory (%s)", raw, dir)
		}
	}
	// Up to the home and no further: the path is under it, and what this keeps the value out of is a checkout's
	// `git add -A`, a repository at or below the home (the home's own .git included). Above it is not this user's.
	for dir := filepath.Dir(path); ; dir = filepath.Dir(dir) {
		if _, err := os.Lstat(filepath.Join(dir, ".git")); err == nil {
			return nil, secretPathRefusal(secretPathCodeRefused, "%q is inside a git repository (%s has a .git)", raw, dir)
		}
		if parent := filepath.Dir(dir); parent == dir || dir == home {
			break
		}
	}
	return target, nil
}

// checkSecretSpec is what `orbit mcp` checks of a SECRET request's destination before filing it.
func checkSecretSpec(spec interface{}) error {
	fields, ok := spec.(map[string]interface{})
	if !ok {
		return nil // the server says what shape it takes
	}
	if envVar, ok := fields["envVar"].(string); ok && envVar != "" {
		if err := checkSecretEnvVar(envVar); err != nil {
			return err
		}
	}
	if filePath, ok := fields["filePath"].(string); ok && filePath != "" {
		workDirs := knownSecretWorkspaceDirs()
		if cwd, err := os.Getwd(); err == nil {
			workDirs = append(workDirs, cwd)
		}
		if _, err := checkSecretFilePath(filePath, workDirs); err != nil {
			return err
		}
	}
	return nil
}
