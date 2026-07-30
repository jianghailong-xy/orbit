package main

import (
	"path/filepath"
	"testing"
)

func names(items []SlashCommandInfo) []string {
	out := make([]string, 0, len(items))
	for _, it := range items {
		out = append(out, it.Name)
	}
	return out
}

func eq(t *testing.T, got, want []string, what string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%s = %v, want %v", what, got, want)
	}
	for i := range got {
		if got[i] != want[i] {
			t.Fatalf("%s = %v, want %v", what, got, want)
		}
	}
}

// A name the CLI reports as a skill must be filed under skills only (never duplicated as a
// command), `__`-prefixed internals are dropped, and everything already found on disk is
// left to the scan — extras carries only what the scan can't see.
func TestSlashRegistryExtras(t *testing.T) {
	r := newSlashRegistry(filepath.Join(t.TempDir(), "reg.json"))
	r.learn(
		[]string{"loop", "commit", "clear", "ns:hello", "__remote-workflow"},
		[]string{"loop", "release"},
	)

	cmds, skills := r.extras(map[string]bool{"commit": true, "release": true})
	eq(t, names(cmds), []string{"clear", "ns:hello"}, "extra commands")
	eq(t, names(skills), []string{"loop"}, "extra skills")
	for _, it := range append(cmds, skills...) {
		if !it.Builtin || it.AgentID != "" {
			t.Fatalf("%q should be a host-level builtin, got %+v", it.Name, it)
		}
	}
}

// End to end: a session's init handshake teaches the registry, and the next heartbeat
// carries the CLI-only names alongside the disk scan — which is what stops the composer
// from rejecting `/loop` as an unsupported command.
func TestInitHandshakeReachesHeartbeat(t *testing.T) {
	home, agent := t.TempDir(), t.TempDir()
	t.Setenv("HOME", home)
	mkSkill(t, agent, "release")

	prev := slashReg
	slashReg = newSlashRegistry(filepath.Join(t.TempDir(), "reg.json"))
	defer func() { slashReg = prev }()

	handleMessage(map[string]interface{}{
		"type":           "system",
		"subtype":        "init",
		"slash_commands": []interface{}{"loop", "clear", "release", "__internal"},
		"skills":         []interface{}{"loop"},
	}, func(string, map[string]interface{}) {}, nil)

	commands, skills := slashAssetsForHeartbeat([]assetRoot{{base: agent, agentID: "a1"}})
	eq(t, names(commands), []string{"clear"}, "heartbeat commands")
	// `release` is on disk, so it stays the agent-scoped scan result rather than being
	// re-reported host-level; `loop` is CLI-only and rides along as a builtin.
	eq(t, names(skills), []string{"release", "loop"}, "heartbeat skills")
	if skills[0].AgentID != "a1" || skills[0].Builtin {
		t.Fatalf("disk skill should stay agent-scoped: %+v", skills[0])
	}
	if !skills[1].Builtin {
		t.Fatalf("loop should be reported as a builtin: %+v", skills[1])
	}
}

// The set survives a restart: a runner that has learned the CLI's registry must not blank
// the composer's allowlist until the next session boots.
func TestSlashRegistryPersists(t *testing.T) {
	path := filepath.Join(t.TempDir(), "reg.json")
	if !newSlashRegistry(path).learn([]string{"loop"}, []string{"review"}) {
		t.Fatal("first learn should report a change")
	}

	reloaded := newSlashRegistry(path)
	cmds, skills := reloaded.extras(nil)
	eq(t, names(cmds), []string{"loop"}, "reloaded commands")
	eq(t, names(skills), []string{"review"}, "reloaded skills")
	if reloaded.learn([]string{"loop"}, []string{"review"}) {
		t.Fatal("re-learning known names should report no change")
	}
}
