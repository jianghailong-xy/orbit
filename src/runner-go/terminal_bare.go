package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
)

// Bare `orbit` on a TTY (docs/terminal-session-design.md, "Flow of orbit"; board-1 ②, board-2): this
// terminal's credential, the workspace on this machine's runner that holds the cwd, a new session there
// that runs in the cwd itself with no worktree (D4: `worktree: false` on POST /sessions, and `workSubdir`, the
// cwd relative to the workspace's directory, when the cwd is below it), and the Orbit TUI on it. `--engine`/`--model` name the engine and model; `--pick` opens the picker.

// noRunnerMessage is what bare `orbit` says on a machine with no runner (board-2): the session runs on
// this machine's runner, so without one there is nowhere for it to run.
const noRunnerMessage = "No runner is registered on this machine, so a session cannot run in this folder. Run `orbit register` first."

// newSessionRequest is what the command line asked of the new session.
type newSessionRequest struct {
	Engine string
	Model  string
	Pick   bool
}

// isBareOrbit says whether the arguments are bare `orbit`'s: none, or only its own flags.
func isBareOrbit(args []string) bool {
	if len(args) == 0 {
		return true
	}
	a := args[0]
	return a == "--pick" || a == "--engine" || a == "--model" ||
		strings.HasPrefix(a, "--engine=") || strings.HasPrefix(a, "--model=")
}

// parseBareOrbitArgs reads `--engine ENGINE`, `--model MODEL` and `--pick`, in any order.
func parseBareOrbitArgs(args []string) (newSessionRequest, error) {
	var req newSessionRequest
	for i := 0; i < len(args); i++ {
		a := args[i]
		name, value, hasValue := strings.Cut(a, "=")
		switch name {
		case "--pick":
			if hasValue {
				return req, errors.New("--pick takes no value")
			}
			req.Pick = true
		case "--engine", "--model":
			if !hasValue {
				if i+1 >= len(args) || strings.HasPrefix(args[i+1], "-") {
					return req, fmt.Errorf("%s needs a value", name)
				}
				i++
				value = args[i]
			}
			value = strings.TrimSpace(value)
			if value == "" {
				return req, fmt.Errorf("%s needs a value", name)
			}
			if name == "--engine" {
				req.Engine = value
			} else {
				req.Model = value
			}
		default:
			return req, fmt.Errorf("unknown argument %q", a)
		}
	}
	if req.Pick && (req.Engine != "" || req.Model != "") {
		return req, errors.New("--pick chooses the engine and model itself; pass either --pick or --engine/--model")
	}
	return req, nil
}

// stdioIsTerminal says whether a person is at both ends: stdin can answer (interactive) and stdout is a
// terminal the TUI can draw on rather than a pipe or a file.
func stdioIsTerminal() bool {
	if !interactive() {
		return false
	}
	fi, err := os.Stdout.Stat()
	return err == nil && fi.Mode()&os.ModeCharDevice != 0
}

// bareOpenNewSession is what bare `orbit` opens once the dispatch has let it through: a variable so the
// dispatch tests can see it chosen without a server.
var bareOpenNewSession = openNewSessionTUI

// cmdBareOrbit is `orbit` with no command. Off a terminal it is the help text it always was, exit 0.
func cmdBareOrbit(args []string, tty bool, out, errOut io.Writer) int {
	if !tty {
		if len(args) == 0 {
			fmt.Fprint(out, usage)
			return 0
		}
		fmt.Fprintln(errOut, "orbit: "+strings.Join(args, " ")+" opens the Orbit terminal client, which needs a terminal. Run 'orbit help' for the commands.")
		return 2
	}
	req, err := parseBareOrbitArgs(args)
	if err != nil {
		fmt.Fprintln(errOut, "orbit:", err)
		fmt.Fprintln(errOut, "Usage: orbit [--engine ENGINE] [--model MODEL] | orbit --pick")
		return 2
	}
	if cfg := loadConfig(); cfg == nil || cfg.RunnerToken == "" {
		fmt.Fprintln(errOut, tuiRed+"✗"+tuiReset+" "+noRunnerMessage)
		return 1
	}
	cwd, err := os.Getwd()
	if err != nil {
		fmt.Fprintln(errOut, "orbit: reading the current folder:", err)
		return 1
	}
	if err := bareOpenNewSession(req, cwd, os.Stdin, out); err != nil {
		if errors.Is(err, errPickerCancelled) || errors.Is(err, errFirstMessageCancelled) {
			fmt.Fprintln(out, err.Error())
			return 0
		}
		fmt.Fprintln(errOut, "orbit:", err)
		return 1
	}
	return 0
}

// tuiWorkspace is one row of GET /workspaces, as much of it as the cwd lookup reads.
type tuiWorkspace struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	WorkDir string `json:"workDir"`
	Enabled *bool  `json:"enabled"`
}

// workspaces is GET /workspaces: for a TERMINAL credential, the workspaces on its own runner alone.
func (c *tuiClient) workspaces(ctx context.Context) ([]tuiWorkspace, error) {
	data, err := c.do(ctx, http.MethodGet, "/workspaces", nil)
	if err != nil {
		return nil, err
	}
	var list []tuiWorkspace
	if err := json.Unmarshal(data, &list); err != nil {
		return nil, fmt.Errorf("reading this machine's workspaces: %w", err)
	}
	return list, nil
}

// workspaceForDir is the workspace whose directory holds dir: the deepest one, when one sits inside
// another. A disabled workspace starts no session, so it is passed over.
func workspaceForDir(list []tuiWorkspace, dir string) (tuiWorkspace, bool) {
	dir = resolvedDir(dir)
	var best tuiWorkspace
	bestLen := -1
	for _, w := range list {
		if w.WorkDir == "" || (w.Enabled != nil && !*w.Enabled) {
			continue
		}
		root := resolvedDir(w.WorkDir)
		rel, err := filepath.Rel(root, dir)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
			continue
		}
		if len(root) > bestLen {
			best, bestLen = w, len(root)
		}
	}
	return best, bestLen >= 0
}

// resolvedDir is dir with its symlinks resolved where it exists, so /tmp and /private/tmp are one folder.
func resolvedDir(dir string) string {
	dir = filepath.Clean(expandHome(dir))
	if real, err := filepath.EvalSymlinks(dir); err == nil {
		return real
	}
	return dir
}

// workSubdirFor is cwd relative to the workspace's directory, `/`-separated, as POST /sessions takes it: "" when
// cwd is that directory itself. workspaceForDir chose ws because it holds cwd, so the path never steps up.
func workSubdirFor(ws tuiWorkspace, cwd string) string {
	rel, err := filepath.Rel(resolvedDir(ws.WorkDir), resolvedDir(cwd))
	if err != nil || rel == "." {
		return ""
	}
	return filepath.ToSlash(rel)
}

func expandHome(p string) string {
	if p == "~" || strings.HasPrefix(p, "~/") {
		if home := userHome(); home != "" {
			return filepath.Join(home, strings.TrimPrefix(p, "~"))
		}
	}
	return p
}

// newSessionBody is POST /sessions for a terminal's session, without its prompt: the workspace, this
// machine's runner, no worktree, the folder below the workspace's directory cwd is in (none at the workspace's
// own directory), and the engine and model the command line named (none: the server's default, where the
// workspace last started, on its runtime's default model).
func newSessionBody(ws tuiWorkspace, runnerID, cwd string, req newSessionRequest) map[string]any {
	body := map[string]any{
		"workspaceId":      ws.ID,
		"assignedRunnerId": runnerID,
		"worktree":         false,
	}
	if sub := workSubdirFor(ws, cwd); sub != "" {
		body["workSubdir"] = sub
	}
	if req.Engine != "" {
		body["engine"] = req.Engine
	}
	if req.Model != "" {
		body["model"] = req.Model
	}
	return body
}

// openNewSessionTUI is bare `orbit` on a terminal: this terminal's credential, a new session in the workspace
// that holds cwd, and the TUI on it.
func openNewSessionTUI(req newSessionRequest, cwd string, in io.Reader, out io.Writer) error {
	cred, err := ensureTerminalCredential(out)
	if err != nil {
		return err
	}
	client := newTUIClient(cred.ServerURL, cred.Token)
	id, prompt, err := startSessionInDir(context.Background(), client, cred, req, cwd, in, out)
	if err != nil {
		return err
	}
	return runSessionTUI(tuiOptions{
		Server: cred.ServerURL, Token: cred.Token, SessionID: id,
		Machine: cred.MachineName, In: in, Out: out, Sent: []string{prompt},
	})
}

// startSessionInDir finds the workspace that holds cwd on the credential's runner, asks for the engine when
// --pick says so, takes the first message and creates the session with it: the app's New Session screen
// also creates a session by its first message. It answers the session's id and that message.
func startSessionInDir(ctx context.Context, client *tuiClient, cred *terminalCredential, req newSessionRequest, cwd string, in io.Reader, out io.Writer) (string, string, error) {
	list, err := client.workspaces(ctx)
	if err != nil {
		return "", "", err
	}
	ws, ok := workspaceForDir(list, cwd)
	var body map[string]any
	if ok {
		body = newSessionBody(ws, cred.RunnerID, cwd, req)
	} else {
		// board-2 ⑧: a folder in no workspace on this machine becomes one, made with the session by POST
		// /sessions `newWorkspace` (sessions/new-workspace.ts), on this machine's runner.
		machine := cred.MachineName
		if machine == "" {
			machine = "this machine"
		}
		fmt.Fprintf(out, "%s is not in a workspace on %s.\nAdd it as a workspace? [Y/n] ", cwd, machine)
		if !readYesDefault(in) {
			return "", "", errWorkspaceDeclined
		}
		ws = tuiWorkspace{Name: filepath.Base(filepath.Clean(cwd)), WorkDir: cwd}
		body = newSessionBody(ws, cred.RunnerID, cwd, req)
		delete(body, "workspaceId")
		body["newWorkspace"] = map[string]any{"workDir": cwd}
	}
	label := []string{ws.Name, cred.MachineName}
	if req.Pick {
		choice, err := pickEngineAndModel(ctx, client, cred.RunnerID, in, out)
		if err != nil {
			return "", "", err
		}
		choice.applyTo(body)
		label = append(label, engineDisplayName(choice.Engine), choice.Model)
	} else {
		label = append(label, engineLabelOrEmpty(req.Engine), req.Model)
	}

	prompt, err := readFirstMessage(ctx, label, in, out)
	if err != nil {
		return "", "", err
	}
	body["prompt"] = prompt
	id, err := client.createSession(ctx, body)
	if err != nil {
		return "", "", fmt.Errorf("starting a session in %s: %w", ws.Name, err)
	}
	return id, prompt, nil
}

// errWorkspaceDeclined is answering n to `Add it as a workspace?`: nothing was sent, and `orbit` exits non-zero.
var errWorkspaceDeclined = errors.New("The folder was not added as a workspace; no session was created.")

// readYesDefault reads one answer line from in, a byte at a time so nothing past it is taken from the
// programs that read in next: empty (Enter), y or yes is yes; anything else, or no line at all, is no.
func readYesDefault(in io.Reader) bool {
	var line []byte
	b := make([]byte, 1)
	for {
		n, err := in.Read(b)
		if n == 1 {
			if b[0] == '\n' || b[0] == '\r' {
				break
			}
			line = append(line, b[0])
		}
		if err != nil {
			if len(line) == 0 {
				return false
			}
			break
		}
	}
	s := strings.ToLower(strings.TrimSpace(string(line)))
	return s == "" || s == "y" || s == "yes"
}

func engineLabelOrEmpty(engine string) string {
	if engine == "" {
		return ""
	}
	return engineDisplayName(engine)
}

// errFirstMessageCancelled is what leaving before the first message answers: nothing was created.
var errFirstMessageCancelled = errors.New("Left before the first message; no session was created.")

// tuiFirstMessageModel is the composer a new session opens with: the session is created by its first
// message, as the app's New Session screen creates one.
type tuiFirstMessageModel struct {
	header   string
	text     []rune
	done     bool
	canceled bool
}

func (m *tuiFirstMessageModel) Init() tea.Cmd { return nil }

func (m *tuiFirstMessageModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	k, ok := msg.(tea.KeyMsg)
	if !ok {
		return m, nil
	}
	switch k.Type {
	case tea.KeyCtrlC, tea.KeyCtrlD, tea.KeyEsc:
		m.canceled = true
		return m, tea.Quit
	case tea.KeyEnter:
		if k.Paste {
			m.text = append(m.text, '\n')
			return m, nil
		}
		if strings.TrimSpace(string(m.text)) == "" {
			return m, nil
		}
		m.done = true
		return m, tea.Quit
	case tea.KeyBackspace:
		if len(m.text) > 0 {
			m.text = m.text[:len(m.text)-1]
		}
	case tea.KeySpace:
		m.text = append(m.text, ' ')
	case tea.KeyRunes:
		m.text = append(m.text, k.Runes...)
	}
	return m, nil
}

func (m *tuiFirstMessageModel) View() string {
	if m.done || m.canceled {
		return ""
	}
	return m.header + "\n\n" + "› " + string(m.text) + "█\n" +
		tuiGrey + "enter send · esc or ctrl-d leave (nothing is created)" + tuiReset
}

// readFirstMessage asks for the new session's first message under its status line.
func readFirstMessage(ctx context.Context, label []string, in io.Reader, out io.Writer) (string, error) {
	var parts []string
	for _, p := range label {
		if strings.TrimSpace(p) != "" {
			parts = append(parts, p)
		}
	}
	m := &tuiFirstMessageModel{header: tuiBlue + "◆ Orbit" + tuiReset + " " + tuiGrey + strings.Join(parts, " · ") + tuiReset}
	final, err := tea.NewProgram(m, tea.WithInput(in), tea.WithOutput(out), tea.WithContext(ctx)).Run()
	if err != nil && !errors.Is(err, tea.ErrInterrupted) {
		return "", err
	}
	if fm, ok := final.(*tuiFirstMessageModel); ok && fm.done {
		return strings.TrimSpace(string(fm.text)), nil
	}
	return "", errFirstMessageCancelled
}
