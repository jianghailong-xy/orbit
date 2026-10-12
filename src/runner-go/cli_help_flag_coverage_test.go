package main

import (
	"regexp"
	"strings"
	"testing"
)

// Every flag a command advertises must also appear in the help a person gets.
//
// The argument list exists twice: once in `orbit capabilities` (read by an agent) and once in the
// family's per-action help text (read by whoever typed --help). Nothing connected them, so adding
// a flag to one and not the other is invisible — `--label` shipped documented in capabilities and
// absent from `orbit task create --help`, which is how a flag comes to exist that nobody can find.
// The parity test next door checks capabilities against the MCP schema; this checks it against the
// text, closing the other half of the same gap.
func TestPerActionHelpDocumentsEveryAdvertisedFlag(t *testing.T) {
	helpByFamily := map[string]map[string]string{
		"task":      taskActionHelp,
		"task-list": taskListActionHelp,
		"project":   projectActionHelp,
		"session":   sessionActionHelp,
		"provider":  providerActionHelp,
		"agent":     agentActionHelp,
		"watch":     watchActionHelp,
		"wiki":      wikiActionHelp,
	}
	flagRe := regexp.MustCompile(`--[a-z][a-z0-9-]*`)

	for _, list := range [][]cliCapabilitySpec{
		baseCLICapabilities, providerCLICapabilities, projectCLICapabilities,
		notifyCLICapabilities, sessionCLICapabilities, agentCLICapabilities,
		watchCLICapabilities, wikiCLICapabilities, wikiImportCLICapabilities, wikiPlanCLICapabilities,
		userCLICapabilities,
	} {
		for _, spec := range list {
			help, ok := "", false
			if len(spec.Argv) < 3 {
				// A single-command family (`orbit notify`, `orbit whoami`) has one help text: the one
				// `orbit <cmd> --help` prints.
				if help, ok = cmdHelp[spec.Argv[1]]; !ok {
					t.Errorf("`orbit %s --help` has no help text, and capabilities advertises it", spec.Argv[1])
					continue
				}
			} else if help, ok = helpByFamily[spec.Argv[1]][spec.Argv[2]]; !ok {
				continue
			}
			seen := map[string]bool{}
			for _, argument := range spec.Arguments {
				for _, flag := range flagRe.FindAllString(argument, -1) {
					if seen[flag] {
						continue
					}
					seen[flag] = true
					if !strings.Contains(help, flag) {
						t.Errorf("`%s --help` does not document %s, which capabilities advertises",
							strings.Join(spec.Argv, " "), flag)
					}
				}
			}
		}
	}
}

// T5: the engine flags reach the help of every command that takes them, with the six engines a person
// can pass named by the CLI they are — the overview's usage line included, which is where a reader of
// `orbit task --help` first sees batch-pin's shape.
func TestEngineFlagsAreInTheHelpOfEveryCommandThatTakesThem(t *testing.T) {
	for _, tc := range []struct {
		command string
		help    string
		want    []string
	}{
		{command: "orbit session create", help: sessionActionHelp["create"], want: []string{"--engine ENGINE", "PROVIDER_ENGINE_INCOMPATIBLE", "DEEPSEEK_KEY_REQUIRED"}},
		{command: "orbit task create", help: taskActionHelp["create"], want: []string{"--engine ENGINE", "PROVIDER_ENGINE_INCOMPATIBLE"}},
		{command: "orbit task update", help: taskActionHelp["update"], want: []string{"--engine ENGINE | --clear-engine"}},
		{command: "orbit task batch-pin", help: taskActionHelp["batch-pin"], want: []string{"(--engine ENGINE | --clear-engine)", "--clear-engine"}},
		{command: "orbit task", help: taskHelp, want: []string{"(--engine E | --clear-engine)"}},
	} {
		for _, want := range tc.want {
			if !strings.Contains(tc.help, want) {
				t.Errorf("`%s --help` does not say %q", tc.command, want)
			}
		}
	}
	for _, help := range []string{sessionActionHelp["create"], taskActionHelp["create"]} {
		for _, name := range []string{"Claude Code", "Codex", "Kimi Code", "Antigravity CLI", "OpenCode", "DeepSeek Harness"} {
			if !strings.Contains(strings.Join(strings.Fields(help), " "), name) {
				t.Errorf("an --engine help does not name %s:\n%s", name, help)
			}
		}
	}
}
