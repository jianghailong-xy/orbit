package main

import (
	"strings"
	"testing"
)

// The failure this closes: an agent on a root runner called session_create with
// permissionMode "bypassPermissions" — the one mode claude refuses under root — because the tool
// schema listed it. claude printed "--dangerously-skip-permissions cannot be used with root/sudo
// privileges" and exited during startup, and the session finished FAILED in 5s with zero turns.
// A model picks from what it is shown, so the list it is shown is the fix.
func TestOfferedPermissionModes(t *testing.T) {
	if got := offeredPermissionModesFor(false); len(got) != len(allPermissionModes) {
		t.Errorf("a non-root runner must offer every mode, got %#v", got)
	}

	root := offeredPermissionModesFor(true)
	for _, mode := range root {
		if mode == "bypassPermissions" {
			t.Errorf("a root runner must not offer bypassPermissions, got %#v", root)
		}
	}
	// Only that one. Every other mode reaches claude's system/init message as uid 0 (verified
	// against 2.1.233), so withholding more would remove modes that work.
	if len(root) != len(allPermissionModes)-1 {
		t.Errorf("a root runner withheld more than bypassPermissions: %#v", root)
	}
	for _, want := range []string{"default", "acceptEdits", "plan", "auto", "dontAsk"} {
		found := false
		for _, mode := range root {
			found = found || mode == want
		}
		if !found {
			t.Errorf("a root runner must still offer %q, got %#v", want, root)
		}
	}
}

// A model picks a mode from these words. Told that Don't Ask "never asks", it uses Don't Ask for
// unattended work, and there every command it runs is refused: the words have to say so, and say
// where such work goes instead. On a root runner, where the mode it would have picked is withheld,
// more than anywhere.
func TestDontAskIsDescribedAsWhatItDoes(t *testing.T) {
	restore := runsAsRoot
	t.Cleanup(func() { runsAsRoot = restore })
	oneLine := func(text string) string { return strings.Join(strings.Fields(text), " ") }

	for _, root := range []bool{false, true} {
		runsAsRoot = root
		schema, _ := mcpToolProps(toolDescriptors(false, true), "session_create")["permissionMode"].(map[string]interface{})
		described, _ := schema["description"].(string)
		for _, want := range []string{
			`"dontAsk" never asks but refuses anything not already approved, commands and background jobs included`,
			`"auto" lets the model decide when to ask and is the mode for unattended work that has to run commands`,
		} {
			if !strings.Contains(described, want) {
				t.Errorf("root=%v: session_create's permissionMode does not say %q: %s", root, want, described)
			}
		}
		if strings.Contains(described, `"dontAsk"/"bypassPermissions" never ask`) {
			t.Errorf("root=%v: session_create's permissionMode still calls the two the same: %s", root, described)
		}

		note := rootWithheldPermissionModeNote()
		if !root {
			if note != "" {
				t.Errorf("a non-root runner withholds nothing, and says %q", note)
			}
			continue
		}
		for _, want := range []string{
			`For unattended work that has to run commands, use "auto".`,
			`"dontAsk" never asks either, but it refuses anything not already approved.`,
		} {
			if !strings.Contains(note, want) {
				t.Errorf("the root note does not say %q: %s", want, note)
			}
			if !strings.Contains(described, want) {
				t.Errorf("session_create on a root runner does not say %q: %s", want, described)
			}
		}
		if strings.Contains(note, "also never asks") {
			t.Errorf("the root note offers Don't Ask as the way to run unattended: %s", note)
		}
	}

	help := oneLine(sessionActionHelp["create"])
	for _, want := range []string{
		"dontAsk never asks but refuses anything not already approved, commands and background jobs included",
		"for unattended work that has to run commands, use auto",
	} {
		if !strings.Contains(help, want) {
			t.Errorf("orbit session create --help does not say %q: %s", want, help)
		}
	}
}

// `orbit capabilities` is what an agent reads to find the CLI door, and --help is what a human
// reads. Both have to render the machine's real list, or they re-advertise what the schema just
// withdrew.
func TestPermissionModeDocsFollowWhatIsOffered(t *testing.T) {
	spec, prose := permissionModeFlagSpec(), permissionModeProse()
	for _, mode := range offeredPermissionModes() {
		if !strings.Contains(spec, mode) {
			t.Errorf("capability spec %q omits offered mode %q", spec, mode)
		}
		if !strings.Contains(prose, mode) {
			t.Errorf("help prose %q omits offered mode %q", prose, mode)
		}
	}
	if runsAsRoot {
		if strings.Contains(spec, "bypassPermissions") || strings.Contains(prose, "bypassPermissions") {
			t.Errorf("a root runner still documents bypassPermissions: %q / %q", spec, prose)
		}
		// An absence with no explanation reads as a missing feature, so --help says why.
		if !strings.Contains(sessionActionHelp["create"], "deployed as root") {
			t.Error("create --help does not explain the withheld mode on a root runner")
		}
	} else if !strings.Contains(spec, "bypassPermissions") {
		t.Errorf("a non-root runner must still document bypassPermissions: %q", spec)
	}
}
