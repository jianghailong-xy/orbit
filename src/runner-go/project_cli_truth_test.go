package main

import (
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"
)

func sortedBoolSetKeys(values map[string]bool) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// The project command used to advertise status/blockers/verifications in family usage while leaf
// help and the dispatcher rejected them. Lock all four public truths to the same verb set.
func TestProjectUsageHelpDispatcherAndCapabilitiesNameTheSameActions(t *testing.T) {
	help := map[string]bool{}
	for action := range projectActionHelp {
		help[action] = true
	}

	usage := map[string]bool{}
	usageRE := regexp.MustCompile(`(?m)^  orbit project ([a-z][a-z-]*)\b`)
	for _, match := range usageRE.FindAllStringSubmatch(projectHelp, -1) {
		usage[match[1]] = true
	}

	capabilities := map[string]bool{}
	for _, spec := range projectCLICapabilities {
		if len(spec.Argv) != 3 || strings.Join(spec.Argv[:2], " ") != "orbit project" {
			t.Fatalf("malformed project capability argv: %#v", spec.Argv)
		}
		capabilities[spec.Argv[2]] = true
	}

	source, err := os.ReadFile("project_cli.go")
	if err != nil {
		t.Fatal(err)
	}
	dispatch := map[string]bool{}
	dispatchSource := string(source)
	start := strings.Index(dispatchSource, "switch action {")
	end := strings.Index(dispatchSource, "\nfunc cliProjectGet")
	if start < 0 || end < start {
		t.Fatal("cannot locate cmdProjectCLI dispatcher switch")
	}
	caseRE := regexp.MustCompile(`(?m)^\tcase "([a-z][a-z-]*)":$`)
	for _, match := range caseRE.FindAllStringSubmatch(dispatchSource[start:end], -1) {
		dispatch[string(match[1])] = true
	}

	want := strings.Join(sortedBoolSetKeys(help), ",")
	for name, set := range map[string]map[string]bool{
		"family usage":      usage,
		"dispatcher switch": dispatch,
		"capabilities":      capabilities,
	} {
		if got := strings.Join(sortedBoolSetKeys(set), ","); got != want {
			t.Errorf("%s actions = %s; projectActionHelp = %s", name, got, want)
		}
	}
}
