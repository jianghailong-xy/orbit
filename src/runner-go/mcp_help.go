package main

import (
	"fmt"
	"sort"
	"strings"
)

// `orbit mcp help`: what the server is, for whom and over what. The runtimes and the objects are read
// from the tables that decide them — providerRuntimes, which every one of them is started with this
// server by, and the operation catalogue that tools/list is projected from — so the help cannot
// name an engine the runner no longer runs or miss an object a tool was added for
// (TestOrbitMCPHelpMatchesTheRuntimesAndTheCatalogue).

// mcpHelpObjects is how the help names each object an MCP tool acts on, in the order it lists them.
var mcpHelpObjects = []struct {
	object operationObject
	label  string
}{
	{objectTask, "tasks"},
	{objectTaskList, "task lists"},
	{objectProject, "projects"},
	{objectSession, "sessions"},
	{objectAgent, "agents"},
	{objectRunner, "runners"},
	{objectProvider, "providers"},
	{objectWatch, "watches"},
	{objectWiki, "the wiki"},
	{objectFile, "files"},
	{objectOwner, "the account owner"},
	{objectBackgroundJob, "background jobs"},
	{objectPermission, "engine permission prompts"},
	{objectMergeReceipt, "merge receipts"},
}

// mcpHelpRuntimes is every engine the runner runs a session on, in `orbit doctor`'s order.
func mcpHelpRuntimes() []string {
	var names []string
	for _, spec := range engineSpecs {
		if _, ok := providerRuntimes[spec.bin]; ok {
			names = append(names, spec.name)
		}
	}
	return names
}

// mcpHelpServedObjects is the labels of the objects an MCP tool acts on.
func mcpHelpServedObjects(ops []*operation) []string {
	var labels []string
	for _, named := range mcpHelpObjects {
		for _, op := range ops {
			if op.MCP != nil && op.Object == named.object {
				labels = append(labels, named.label)
				break
			}
		}
	}
	return labels
}

// mcpHelpOrchestratedTools is the MCP tools the account's Session orchestration switch gates: a
// family as `prefix_*` when every tool of that prefix is gated, otherwise each tool by its name.
func mcpHelpOrchestratedTools(ops []*operation) []string {
	gated, ungated := map[string][]string{}, map[string]bool{}
	for _, op := range ops {
		if op.MCP == nil {
			continue
		}
		prefix, _, _ := strings.Cut(op.Tool, "_")
		if op.Gate == gateOrchestration {
			gated[prefix] = append(gated[prefix], op.Tool)
		} else {
			ungated[prefix] = true
		}
	}
	var names []string
	for prefix, tools := range gated {
		if ungated[prefix] {
			names = append(names, tools...)
		} else {
			names = append(names, prefix+"_*")
		}
	}
	sort.Strings(names)
	return names
}

func mcpHelp() string {
	ops := operationCatalog().Ops
	served := mcpHelpServedObjects(ops)
	orchestrated := mcpHelpOrchestratedTools(ops)
	paragraphs := []string{
		"The runner starts this server inside every session, on each engine it runs: " +
			englishList(mcpHelpRuntimes()) + ". It speaks JSON-RPC on stdin and stdout and writes diagnostics to " +
			"stderr, so it is not meant to be run by hand.",
		fmt.Sprintf("initialize answers with the Orbit agent primer as the server's instructions: primer %s, "+
			"written from Agent Contract %s, at most %d characters, of which the first %d stand alone. The runner "+
			"writes the same primer into each engine's own instructions too, for an engine that does not show a "+
			"server's instructions.", agentPrimerVersion, agentContractVersion, agentPrimerMaxBytes, agentPrimerLeadMaxChars),
		"tools/list is the operation catalogue's MCP side, for " + englishList(served) + "; `orbit capabilities " +
			"--json` is its CLI side. The tools " + englishList(orchestrated) + " are listed only while the account's " +
			"Session orchestration is on, the watch and wiki tools follow their own switches, and " +
			"permission_prompt is served to Claude Code alone.",
		"It reads the runner credential from config.json under ORBIT_HOME, and the session from the environment " +
			"the runner sets: ORBIT_SESSION_ID, ORBIT_AGENT_ID, ORBIT_TASK_ID, ORBIT_ALLOW_ORCHESTRATION, " +
			"ORBIT_WATCHES, ORBIT_WIKI, ORBIT_MCP_PERMISSION_PROMPT, ORBIT_MCP_TOOLS and " +
			"ORBIT_MCP_CALL_TIMEOUT_SECONDS.",
	}
	var b strings.Builder
	b.WriteString("orbit mcp — serve Orbit's agent tools to a coding engine over MCP (stdio)\n\n")
	b.WriteString("Usage:\n  orbit mcp\n  orbit mcp help\n")
	for _, paragraph := range paragraphs {
		b.WriteString("\n" + wrapHelpText(paragraph, 92) + "\n")
	}
	return b.String()
}

// englishList joins items as a sentence does: "a", "a and b", "a, b and c".
func englishList(items []string) string {
	switch len(items) {
	case 0:
		return ""
	case 1:
		return items[0]
	}
	return strings.Join(items[:len(items)-1], ", ") + " and " + items[len(items)-1]
}

// wrapHelpText breaks a paragraph into lines of at most width characters, between words.
func wrapHelpText(text string, width int) string {
	var lines []string
	line := ""
	for _, word := range strings.Fields(text) {
		if line != "" && len(line)+1+len(word) > width {
			lines = append(lines, line)
			line = word
			continue
		}
		if line == "" {
			line = word
		} else {
			line += " " + word
		}
	}
	if line != "" {
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n")
}
