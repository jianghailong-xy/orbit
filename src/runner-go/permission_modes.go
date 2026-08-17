package main

import "strings"

// allPermissionModes is every mode a session can be created with, in the order the pickers show
// them. Mirrors PermissionMode in shared/enums.ts.
var allPermissionModes = []string{
	"default",
	"acceptEdits",
	"plan",
	"auto",
	"dontAsk",
	"bypassPermissions",
}

// rootRefusedPermissionModes are the modes claude will not run when its process is root: it prints
// "--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons"
// and exits inside its own startup, before any stream-json message, so the session dies on its
// first turn having produced nothing. Mirrors ROOT_REFUSED_PERMISSION_MODES in
// shared/permissionSemantics.ts. Every other mode starts normally as root, which is why this is one
// entry and not "the unsafe ones".
var rootRefusedPermissionModes = map[string]bool{"bypassPermissions": true}

// offeredPermissionModesFor is allPermissionModes minus what the machine cannot run.
//
// This is what the CLI help and the MCP tool schema advertise, and advertising is the point: the
// failure this closes was an agent reading `bypassPermissions` out of the session_create enum on a
// root runner and picking it, which is the one mode that could not work there. A model chooses from
// what it is shown, so a mode the machine refuses has no business being in the list.
//
// Deliberately NOT a local rejection of the flag as well. The mode is checked server-side, where the
// TARGET runner is known — an agent on a root runner may legitimately spawn a session on a non-root
// one, and only the control plane can tell. This narrows what gets suggested; it does not decide.
func offeredPermissionModesFor(root bool) []string {
	if !root {
		return allPermissionModes
	}
	out := make([]string, 0, len(allPermissionModes))
	for _, mode := range allPermissionModes {
		if !rootRefusedPermissionModes[mode] {
			out = append(out, mode)
		}
	}
	return out
}

// offeredPermissionModes answers for THIS process, which is the right scope for both callers: the
// MCP server and the `orbit` CLI both run as children of the session, so their euid is the euid
// claude was spawned with.
func offeredPermissionModes() []string { return offeredPermissionModesFor(runsAsRoot) }

// permissionModeFlagSpec renders the modes as `orbit capabilities` documents a closed flag:
// "--permission-mode <default|acceptEdits|...>".
func permissionModeFlagSpec() string {
	return "--permission-mode <" + strings.Join(offeredPermissionModes(), "|") + ">"
}

// permissionModeProse renders them for prose help: "a, b or c".
func permissionModeProse() string {
	modes := offeredPermissionModes()
	if len(modes) < 2 {
		return strings.Join(modes, "")
	}
	return strings.Join(modes[:len(modes)-1], ", ") + " or " + modes[len(modes)-1]
}

// rootWithheldPermissionModeNote explains an absence, so neither a human reading --help nor a model
// reading the tool schema has to guess why a mode it has seen elsewhere is missing here. Empty when
// nothing is withheld.
func rootWithheldPermissionModeNote() string {
	if !runsAsRoot {
		return ""
	}
	return "This runner is deployed as root, so \"bypassPermissions\" is not offered: " +
		"claude refuses it under root and the session would exit before its first turn. " +
		"\"dontAsk\" also never asks."
}

// rootWithheldPermissionModeNoteBlock is the same note as its own paragraph in `--help`, or nothing
// at all when no mode is withheld — so the ordinary help text is byte-for-byte what it always was.
func rootWithheldPermissionModeNoteBlock() string {
	note := rootWithheldPermissionModeNote()
	if note == "" {
		return ""
	}
	return "\n" + note + "\n"
}
