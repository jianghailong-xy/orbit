package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// agentTool is a coding-agent CLI the runner can detect (and install) on this
// machine.
type agentTool struct {
	key     string   // stable id persisted in config
	label   string   // shown to the user
	bin     string   // executable looked up on PATH
	install []string // argv run to install it when missing
	cmdHint string   // the install command shown to the user before running it
}

// knownAgents is the ordered set `orbit register` offers. Install commands are
// the officially recommended ones (Claude Code: native installer; Codex: npm).
var knownAgents = []agentTool{
	{
		key: "claude", label: "Claude Code", bin: "claude",
		install: []string{"sh", "-c", "curl -fsSL https://claude.ai/install.sh | bash"},
		cmdHint: "curl -fsSL https://claude.ai/install.sh | bash",
	},
	{
		key: "codex", label: "Codex", bin: "codex",
		install: []string{"npm", "install", "-g", "@openai/codex"},
		cmdHint: "npm install -g @openai/codex",
	},
}

// agentPath resolves an agent's binary: PATH first, then the native installer's
// ~/.local/bin (where a just-installed `claude` lands before a new shell picks
// it up on PATH).
func agentPath(bin string) (string, bool) {
	if p, err := exec.LookPath(bin); err == nil {
		return p, true
	}
	if home, err := os.UserHomeDir(); err == nil {
		cand := filepath.Join(home, ".local", "bin", bin)
		if fi, err := os.Stat(cand); err == nil && !fi.IsDir() {
			return cand, true
		}
	}
	return "", false
}

func isInstalled(a agentTool) bool {
	_, ok := agentPath(a.bin)
	return ok
}

// detectAgents returns the known agents already installed on this machine.
func detectAgents() []agentTool {
	var found []agentTool
	for _, a := range knownAgents {
		if isInstalled(a) {
			found = append(found, a)
		}
	}
	return found
}

// selectAgents asks which agents to register. Interactively it lists every
// known agent with its install status and defaults to all; a non-interactive
// caller (no TTY) can't be prompted, so it gets the installed agents unchanged.
func selectAgents() []agentTool {
	if !interactive() {
		return detectAgents()
	}

	fmt.Println("\nAgents:")
	for i, a := range knownAgents {
		state := "not installed"
		if isInstalled(a) {
			state = "installed"
		}
		fmt.Printf("  %d. [x] %s (%s)\n", i+1, a.label, state)
	}
	for {
		fmt.Print("Press Enter to register all, or type the numbers to register (e.g. 1,2): ")
		line, _ := stdinReader.ReadString('\n')
		idx, ok := parseAgentSelection(line, len(knownAgents))
		if !ok {
			fmt.Println("  please enter numbers from the list (e.g. 1,2), or press Enter for all")
			continue
		}
		out := make([]agentTool, 0, len(idx))
		for _, i := range idx {
			out = append(out, knownAgents[i])
		}
		return out
	}
}

// ensureAgentsReady makes the selected agents usable before registration: it
// installs any that are missing (with the user's consent) and confirms Claude
// Code is logged in. It aborts registration if a missing agent isn't installed
// (consent declined or the install failed). A non-interactive caller can't be
// prompted or guided, so this is a no-op there.
func ensureAgentsReady(selected []agentTool) {
	if !interactive() {
		return
	}
	for _, a := range selected {
		if isInstalled(a) {
			continue
		}
		if !confirm(fmt.Sprintf("\n%s isn't installed. Install it now with `%s`? [Y/n] ", a.label, a.cmdHint), true) {
			abortRegister(a.label + " is required but wasn't installed")
		}
		fmt.Printf("Installing %s …\n", a.label)
		cmd := exec.Command(a.install[0], a.install[1:]...)
		cmd.Stdout, cmd.Stderr, cmd.Stdin = os.Stdout, os.Stderr, os.Stdin
		if err := cmd.Run(); err != nil {
			abortRegister(fmt.Sprintf("installing %s failed (%s)", a.label, firstLine(err.Error())))
		}
		if !isInstalled(a) {
			abortRegister(fmt.Sprintf("%s still isn't on PATH after install — open a new shell (or add ~/.local/bin to PATH) and re-run `orbit register`", a.label))
		}
		fmt.Printf("✓ %s installed.\n", a.label)
	}
	// Claude Code drives the runner's jobs, so make sure it's actually logged in.
	for _, a := range selected {
		if a.key == "claude" {
			waitForClaudeLogin()
		}
	}
}

// waitForClaudeLogin confirms Claude Code is authenticated, guiding the user to
// log in and blocking until they do. Auth is satisfied by a non-interactive
// token (ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN) or `claude auth status`.
func waitForClaudeLogin() {
	claude, ok := agentPath("claude")
	if !ok {
		return
	}
	if claudeAuthed(claude) {
		fmt.Println("✓ Claude Code is logged in.")
		return
	}
	fmt.Println("\nClaude Code isn't logged in yet. In another terminal, run:")
	fmt.Println("    claude        then type:  /login")
	fmt.Println("  (or `claude setup-token`, or set CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY)")
	fmt.Println("Waiting for Claude Code login… press Ctrl-C to abort.")
	for {
		time.Sleep(3 * time.Second)
		if claudeAuthed(claude) {
			fmt.Println("✓ Claude Code is logged in.")
			return
		}
	}
}

// claudeAuthed reports whether Claude Code has usable credentials: a token in
// the environment, or `claude auth status` exiting 0.
func claudeAuthed(claudePath string) bool {
	if os.Getenv("ANTHROPIC_API_KEY") != "" || os.Getenv("CLAUDE_CODE_OAUTH_TOKEN") != "" {
		return true
	}
	return exec.Command(claudePath, "auth", "status").Run() == nil
}

func abortRegister(msg string) {
	fmt.Fprintln(os.Stderr, "\nregistration aborted — "+msg)
	os.Exit(1)
}

func agentKeys(as []agentTool) []string {
	out := make([]string, len(as))
	for i, a := range as {
		out[i] = a.key
	}
	return out
}

// parseAgentSelection turns a user's reply into 0-based indices into a list of n
// items. Empty input selects all (the default). Returns ok=false on input that
// names no valid item, so the caller can re-prompt.
func parseAgentSelection(line string, n int) ([]int, bool) {
	s := strings.TrimSpace(line)
	if s == "" {
		all := make([]int, n)
		for i := range all {
			all[i] = i
		}
		return all, true
	}
	seen := map[int]bool{}
	out := []int{}
	for _, f := range strings.FieldsFunc(s, func(r rune) bool { return r == ',' || r == ' ' }) {
		num, err := strconv.Atoi(f)
		if err != nil || num < 1 || num > n {
			return nil, false
		}
		if !seen[num-1] {
			seen[num-1] = true
			out = append(out, num-1)
		}
	}
	if len(out) == 0 {
		return nil, false
	}
	return out, true
}
