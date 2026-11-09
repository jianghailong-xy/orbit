package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"
)

const cursorShellCommand = "internal-cursor-shell"

var cursorShellCLIDir = filepath.Dir

// Kept byte-for-byte: an unknown loader never gets an escape grant.
const cursorCommandLoader = `IFS= builtin read -r -d '' __cursor_command <&5 2>/dev/null || { builtin printf '%s\n' 'The command did not run: a shell startup file ($BASH_ENV or .zshenv) closed or replaced file descriptor 5, which carries the command. Run it again; this shell now passes commands as arguments.' >&2; builtin exit 126; }; exec 5<&-; builtin set -- "$__cursor_command"; builtin unset __cursor_command; snap=$(command cat <&3) && builtin shopt -s extglob && builtin eval -- "$snap" && { builtin set +u 2>/dev/null || true; builtin eval "${__CURSOR_SANDBOX_ENV_RESTORE:-}" 2>/dev/null; builtin eval "${__CURSOR_SANDBOX_TEMP_RESTORE:-}" 2>/dev/null; builtin export PWD="$(builtin pwd)"; builtin shopt -s expand_aliases 2>/dev/null; builtin eval "$1" < /dev/null; }; COMMAND_EXIT_CODE=$?; dump_bash_state >&4; builtin exit $COMMAND_EXIT_CODE`

type cursorShellConfig struct {
	Binary, Platform, Socket, Helper string
	Roots, Sealed, Hidden            []string
	Locked, Reopened                 []string
}

type cursorGrantKey struct{ Conversation, Cwd, Command string }
type cursorGrant struct {
	key     cursorGrantKey
	expires time.Time
}

// The ledger lives in the runner, never in a workspace, env variable, or file.
type cursorGrantBroker struct {
	mu         sync.Mutex
	listener   net.Listener
	grants     map[string]cursorGrant
	seen       map[string]bool
	cliPID     int
	helper     string
	cliDir     string
	closed     bool
	configPath string
	socketPath string
	cliStart   string
}

func (b *cursorGrantBroker) add(request string, key cursorGrantKey) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed || b.seen[request] || key.Conversation == "" || key.Cwd == "" || key.Command == "" || strings.ContainsRune(key.Command, 0) {
		return
	}
	b.seen[request] = true
	b.grants[request] = cursorGrant{key, time.Now().Add(time.Minute)}
}

func (b *cursorGrantBroker) consume(key cursorGrantKey) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return false
	}
	for id, grant := range b.grants {
		if !time.Now().Before(grant.expires) {
			delete(b.grants, id)
			continue
		}
		if grant.key == key {
			delete(b.grants, id)
			return true
		}
	}
	return false
}

func (b *cursorGrantBroker) revoke() {
	b.mu.Lock()
	b.grants = map[string]cursorGrant{}
	b.mu.Unlock()
}

func (b *cursorGrantBroker) close() {
	b.mu.Lock()
	b.closed = true
	b.grants = map[string]cursorGrant{}
	b.mu.Unlock()
	_ = b.listener.Close()
	_ = os.Remove(b.socketPath)
}

func startCursorGrantBroker(spec CursorLaunchSpec) (*cursorGrantBroker, error) {
	var config cursorShellConfig
	data, err := os.ReadFile(spec.shellConfig)
	if err != nil {
		return nil, err
	}
	if err = json.Unmarshal(data, &config); err != nil {
		return nil, err
	}
	_ = os.Remove(config.Socket) // A new process generation has an empty ledger.
	socketPath, release, err := cursorShellSocketPath(config.Socket)
	if err != nil {
		return nil, err
	}
	defer release()
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		return nil, err
	}
	listener.(*net.UnixListener).SetUnlinkOnClose(false)
	b := &cursorGrantBroker{listener: listener, grants: map[string]cursorGrant{}, seen: map[string]bool{}, helper: config.Helper, cliDir: cursorShellCLIDir(spec.Executable), configPath: spec.shellConfig, socketPath: config.Socket}
	return b, nil
}

func (b *cursorGrantBroker) serve() {
	for {
		conn, err := b.listener.Accept()
		if err != nil {
			return
		}
		go func() {
			defer conn.Close()
			_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
			// Check kernel identity before trusting any client-supplied fields.
			cwd, conversation, ok := cursorShellPeer(conn, b.cliPID, b.helper, b.cliDir, b.configPath, b.cliStart)
			if !ok {
				return
			}
			var key cursorGrantKey
			if json.NewDecoder(io.LimitReader(conn, 1<<20)).Decode(&key) != nil || key.Cwd != cwd || key.Conversation != conversation {
				return
			}
			allowed := b.consume(key)
			// Lost responses consume the grant too; they are never rolled back.
			_ = json.NewEncoder(conn).Encode(allowed)
		}()
	}
}

func prepareCursorShellSandbox(job *ClaimedSession, spec *CursorLaunchSpec, dir string) error {
	if job.Agent.PermissionMode != "auto" {
		return nil
	}
	sandbox, _ := detectCursorSandbox(context.Background(), job, spec.Cwd)
	if sandbox == nil {
		return nil
	} // Keep today's policy when detection fails.
	helper, err := os.Executable()
	if err != nil {
		return err
	}
	helper, err = filepath.EvalSymlinks(helper)
	if err != nil {
		return err
	}
	control := filepath.Join(dir, "control")
	if err = ensurePrivateDir(control); err != nil {
		return err
	}
	configPath := filepath.Join(dir, "bin", "sandbox.json")
	sandbox.sealed = []string{filepath.Join(dir, "bin"), filepath.Dir(helper), cursorShellCLIDir(spec.Executable)}
	workspace, err := filepath.EvalSymlinks(spec.Cwd)
	if err != nil {
		return err
	}
	// Seal the topmost directory below a writable root too: otherwise a command
	// could rename a writable ancestor and replace the protected launch files.
	for i, path := range sandbox.sealed {
		path, err = filepath.EvalSymlinks(path)
		if err != nil {
			return err
		}
		original := path
		rel, _ := filepath.Rel(workspace, path)
		if rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))) {
			return fmt.Errorf("Auto sandbox launch files must be outside the workspace")
		}
		for _, root := range sandbox.roots {
			rel, err := filepath.Rel(root, path)
			if err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
				path = filepath.Join(root, strings.Split(rel, string(filepath.Separator))[0])
			}
		}
		rel, _ = filepath.Rel(original, workspace)
		if rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))) {
			return fmt.Errorf("Auto sandbox launch files must be outside the workspace")
		}
		sandbox.locked = append(sandbox.locked, path)
		for _, root := range sandbox.roots {
			rel, _ := filepath.Rel(path, root)
			if rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
				sandbox.reopened = append(sandbox.reopened, root)
			}
		}
		sandbox.sealed[i] = original
	}
	sandbox.hidden = []string{control}
	config := cursorShellConfig{Binary: sandbox.binary, Platform: sandbox.platform, Roots: sandbox.roots, Sealed: sandbox.sealed, Hidden: sandbox.hidden, Locked: sandbox.locked, Reopened: sandbox.reopened,
		Socket: filepath.Join(control, "grants.sock"), Helper: helper}
	data, err := json.Marshal(config)
	if err != nil {
		return err
	}
	if err = writeFileAtomically(configPath, data, 0600); err != nil {
		return err
	}
	if _, err = writeCursorShellWrapper(dir, job.Agent.Env, []string{helper, cursorShellCommand, configPath}); err != nil {
		return err
	}
	spec.shellConfig = configPath
	return nil
}

// init also supports the Go test executable used by replay and real-CLI tests.
func init() {
	if len(os.Args) > 2 && os.Args[1] == cursorShellCommand {
		os.Exit(runCursorShell(os.Args[2], os.Args[3:]))
	}
}

func cursorLoaderArgs(args []string) bool {
	return len(args) == 5 && args[0] == "-O" && args[1] == "extglob" && args[2] == "-c" && args[3] == cursorCommandLoader && args[4] == "--"
}

func runCursorShell(configPath string, args []string) int {
	var config cursorShellConfig
	data, err := os.ReadFile(configPath)
	if err != nil || json.Unmarshal(data, &config) != nil {
		fmt.Fprintln(os.Stderr, "Orbit's Auto sandbox could not load its launcher; the command did not run.")
		return 126
	}
	sandbox := &cursorSandbox{binary: config.Binary, platform: config.Platform, roots: config.Roots, sealed: config.Sealed, hidden: config.Hidden, locked: config.Locked, reopened: config.Reopened}
	var payload []byte
	if cursorLoaderArgs(args) {
		// Read through EOF, not just the first NUL: additional bytes must fail closed.
		payload, err = io.ReadAll(io.LimitReader(os.NewFile(5, "command"), (1<<20)+1))
		if err != nil || len(payload) == 0 || len(payload) > 1<<20 || !utf8.Valid(payload) || payload[len(payload)-1] != 0 || bytes.Count(payload, []byte{0}) != 1 {
			fmt.Fprintln(os.Stderr, "Orbit's Auto sandbox could not identify the command payload; the command did not run.")
			return 126
		}
		cwd, _ := os.Getwd()
		key := cursorGrantKey{os.Getenv("CURSOR_CONVERSATION_ID"), cwd, string(payload[:len(payload)-1])}
		socketPath, release, pathErr := cursorShellSocketPath(config.Socket)
		var conn net.Conn
		err = pathErr
		if err == nil {
			conn, err = net.DialTimeout("unix", socketPath, time.Second)
			release()
		}
		allowed := false
		if err == nil {
			_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
			if json.NewEncoder(conn).Encode(key) == nil {
				_ = json.NewDecoder(conn).Decode(&allowed)
			}
			_ = conn.Close()
		}
		// Only Linux has a verified peer/process authentication backend. Refuse
		// escapes on other platforms even if a substituted broker answers true.
		if allowed && runtime.GOOS == "linux" {
			return runCursorFreshCommand(key.Command, cwd)
		}
	}
	cmd := exec.Command(cursorBash(), args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	// Snapshot invocations have no command/status fds. Preserve all three for loaders.
	if cursorLoaderArgs(args) {
		r, w, err := os.Pipe()
		if err != nil {
			return 126
		}
		defer r.Close()
		go func() { _, _ = w.Write(payload); _ = w.Close() }()
		cmd.ExtraFiles = []*os.File{os.NewFile(3, "snapshot"), os.NewFile(4, "status"), r}
	}
	sandbox.wrap(cmd)
	code := cursorShellExit(cmd.Run())
	if code != 0 {
		fmt.Fprintln(os.Stderr, "This command ran in Orbit's Auto sandbox, which blocks writes outside the workspace and other writable roots. If this command needs an outside write, request approval in Orbit.")
	}
	return code
}

func cursorShellExit(err error) int {
	if err == nil {
		return 0
	}
	if exit, ok := err.(*exec.ExitError); ok {
		if code := exit.ExitCode(); code >= 0 {
			return code
		}
		if status, ok := exit.Sys().(syscall.WaitStatus); ok && status.Signaled() {
			return 128 + int(status.Signal())
		}
	}
	return 126
}

func runCursorFreshCommand(command, cwd string) int {
	// Drain and relay the snapshot as inert bytes. Never eval it, including its cwd.
	snapshot, err := io.ReadAll(io.LimitReader(os.NewFile(3, "snapshot"), (16<<20)+1))
	if err != nil || len(snapshot) > 16<<20 {
		return 126
	}
	cmd := exec.Command(cursorBash(), "--noprofile", "--norc", "-c", command)
	cmd.Dir = cwd
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if key == "BASH_ENV" || key == "ENV" || key == "SHELLOPTS" || key == "BASHOPTS" || strings.HasPrefix(key, "BASH_FUNC_") || strings.HasPrefix(key, "__CURSOR_") {
			continue
		}
		cmd.Env = append(cmd.Env, entry)
	}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = nil, os.Stdout, os.Stderr
	code := cursorShellExit(cmd.Run())
	status := os.NewFile(4, "status")
	_, _ = fmt.Fprintf(status, "__CURSOR_BASH_STATE_START__\n%s\n%s\n__CURSOR_BASH_STATE_END__\n", cwd, snapshot)
	_ = status.Close()
	return code
}
