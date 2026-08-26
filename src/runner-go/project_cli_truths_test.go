package main

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"testing"
)

// A project command used to be advertised by the top-level usage while absent from all three
// executable registries. Keep the four independently edited truths mechanically equal: overview
// usage, per-action help, switch dispatch, and the capabilities document exposed to engines.
func projectUsageActions(help string) []string {
	var actions []string
	for _, line := range strings.Split(help, "\n") {
		if !strings.HasPrefix(line, "  orbit project ") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) >= 3 {
			actions = append(actions, fields[2])
		}
	}
	return sortedUnique(actions)
}

func projectHelpActions() []string {
	actions := make([]string, 0, len(projectActionHelp))
	for action := range projectActionHelp {
		actions = append(actions, action)
	}
	return sortedUnique(actions)
}

func projectCapabilityActions() []string {
	actions := make([]string, 0, len(projectCLICapabilities))
	for _, capability := range projectCLICapabilities {
		if len(capability.Argv) >= 3 && capability.Argv[0] == "orbit" && capability.Argv[1] == "project" {
			actions = append(actions, capability.Argv[2])
		}
	}
	return sortedUnique(actions)
}

func projectSwitchActions(t *testing.T) []string {
	t.Helper()
	_, testFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate project CLI source")
	}
	source, err := os.ReadFile(filepath.Join(filepath.Dir(testFile), "project_cli.go"))
	if err != nil {
		t.Fatalf("read project_cli.go: %v", err)
	}
	text := string(source)
	start := strings.Index(text, "switch action {")
	if start < 0 {
		t.Fatal("cannot find cmdProjectCLI switch")
	}
	endMarker := "\n}\n\nfunc cliProjectGet"
	end := strings.Index(text[start:], endMarker)
	if end < 0 {
		t.Fatal("cannot isolate cmdProjectCLI switch")
	}
	block := text[start : start+end]
	matches := regexp.MustCompile(`case "([^"]+)":`).FindAllStringSubmatch(block, -1)
	actions := make([]string, 0, len(matches))
	for _, match := range matches {
		actions = append(actions, match[1])
	}
	return sortedUnique(actions)
}

func sortedUnique(values []string) []string {
	set := map[string]struct{}{}
	for _, value := range values {
		set[value] = struct{}{}
	}
	result := make([]string, 0, len(set))
	for value := range set {
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}

func assertProjectCommandTruths(usage, help, dispatch, capabilities []string) error {
	want := help
	for name, got := range map[string][]string{
		"overview usage":  usage,
		"switch dispatch": dispatch,
		"capabilities":    capabilities,
	} {
		if !reflect.DeepEqual(got, want) {
			return fmt.Errorf("%s = %v, per-action help = %v", name, got, want)
		}
	}
	return nil
}

func TestProjectCLIUsageHelpDispatchAndCapabilitiesStayInParity(t *testing.T) {
	dispatch := projectSwitchActions(t)
	if err := assertProjectCommandTruths(
		projectUsageActions(projectHelp), projectHelpActions(), dispatch, projectCapabilityActions(),
	); err != nil {
		t.Fatal(err)
	}

	// Negative control: prove the assertion notices the exact historical mutation — advertising a
	// command in usage without wiring it through help, dispatch and capabilities.
	mutated := strings.Replace(
		projectHelp,
		"\nRun 'orbit project <command> --help'",
		"\n  orbit project ghost PROJECT_ID [--json]\n\nRun 'orbit project <command> --help'",
		1,
	)
	if err := assertProjectCommandTruths(
		projectUsageActions(mutated), projectHelpActions(), dispatch, projectCapabilityActions(),
	); err == nil {
		t.Fatal("truth-parity assertion accepted a usage-only ghost command")
	}
}
