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
		"session":   sessionActionHelp,
		"provider":  providerActionHelp,
		"agent":     agentActionHelp,
	}
	flagRe := regexp.MustCompile(`--[a-z][a-z0-9-]*`)

	for _, list := range [][]cliCapabilitySpec{
		baseCLICapabilities, providerCLICapabilities, notifyCLICapabilities,
		sessionCLICapabilities, agentCLICapabilities,
	} {
		for _, spec := range list {
			// Single-command families (`orbit notify`) have one help text, not a per-action map.
			if len(spec.Argv) < 3 {
				continue
			}
			help, ok := helpByFamily[spec.Argv[1]][spec.Argv[2]]
			if !ok {
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
						t.Errorf("`orbit %s %s --help` does not document %s, which capabilities advertises",
							spec.Argv[1], spec.Argv[2], flag)
					}
				}
			}
		}
	}
}
