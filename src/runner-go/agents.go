package main

import (
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

// agentTool is a coding-agent CLI the runner can detect on this machine.
type agentTool struct {
	key   string // stable id persisted in config
	label string // shown to the user
	bin   string // executable looked up on PATH
}

// knownAgents is the ordered set `orbit register` probes for.
var knownAgents = []agentTool{
	{key: "claude", label: "Claude Code", bin: "claude"},
	{key: "codex", label: "Codex", bin: "codex"},
}

// detectAgents returns the known agents whose CLI is on PATH.
func detectAgents() []agentTool {
	var found []agentTool
	for _, a := range knownAgents {
		if _, err := exec.LookPath(a.bin); err == nil {
			found = append(found, a)
		}
	}
	return found
}

// selectAgents detects installed agents and asks which to register. The default
// — pressing Enter, or any non-interactive caller — is all of them. Returns the
// stable agent keys to persist in the runner config.
func selectAgents() []string {
	found := detectAgents()
	if len(found) == 0 {
		fmt.Println("\nNo supported agents detected (looked for: claude, codex) — registering with none.")
		return []string{}
	}
	if !interactive() {
		return agentKeys(found)
	}

	fmt.Println("\nAgents found on this machine:")
	for i, a := range found {
		fmt.Printf("  %d. [x] %s\n", i+1, a.label)
	}
	for {
		fmt.Print("Press Enter to register all, or type the numbers to register (e.g. 1,2): ")
		line, _ := stdinReader.ReadString('\n')
		idx, ok := parseAgentSelection(line, len(found))
		if !ok {
			fmt.Println("  please enter numbers from the list (e.g. 1,2), or press Enter for all")
			continue
		}
		out := make([]string, 0, len(idx))
		for _, i := range idx {
			out = append(out, found[i].key)
		}
		return out
	}
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
