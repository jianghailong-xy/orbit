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

// Runtime handshakes are independent: a Kimi-only command must not broaden Claude's
// allowlist, and vice versa. Kimi entries carry a provider tag so clients can filter the
// combined heartbeat payload without guessing from the command name.
func TestSlashRegistrySeparatesProviders(t *testing.T) {
	r := newSlashRegistry(filepath.Join(t.TempDir(), "reg.json"))
	r.learn([]string{"claude-only", "shared-name"}, []string{"claude-skill"})
	r.learnFor(providerKimi, []string{"kimi-only", "shared-name"}, []string{"kimi-skill"})

	claudeCommands, claudeSkills := r.extras(nil)
	eq(t, names(claudeCommands), []string{"claude-only", "shared-name"}, "Claude commands")
	eq(t, names(claudeSkills), []string{"claude-skill"}, "Claude skills")
	for _, item := range append(claudeCommands, claudeSkills...) {
		if item.Provider != "" {
			t.Fatalf("Claude item %q should be untagged for backwards compatibility: %+v", item.Name, item)
		}
	}

	kimiCommands, kimiSkills := r.extrasFor(providerKimi, nil)
	eq(t, names(kimiCommands), []string{"kimi-only", "shared-name"}, "Kimi commands")
	eq(t, names(kimiSkills), []string{"kimi-skill"}, "Kimi skills")
	for _, item := range append(kimiCommands, kimiSkills...) {
		if item.Provider != providerKimi {
			t.Fatalf("Kimi item %q should be provider-tagged: %+v", item.Name, item)
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
	r := newSlashRegistry(path)
	if !r.learn([]string{"loop"}, []string{"review"}) {
		t.Fatal("first learn should report a change")
	}
	if !r.learnFor(providerKimi, []string{"init"}, []string{"compact"}) {
		t.Fatal("first Kimi learn should report a change")
	}

	reloaded := newSlashRegistry(path)
	cmds, skills := reloaded.extras(nil)
	eq(t, names(cmds), []string{"loop"}, "reloaded commands")
	eq(t, names(skills), []string{"review"}, "reloaded skills")
	kimiCommands, kimiSkills := reloaded.extrasFor(providerKimi, nil)
	eq(t, names(kimiCommands), []string{"init"}, "reloaded Kimi commands")
	eq(t, names(kimiSkills), []string{"compact"}, "reloaded Kimi skills")
	if reloaded.learn([]string{"loop"}, []string{"review"}) {
		t.Fatal("re-learning known names should report no change")
	}
	if reloaded.learnFor(providerKimi, []string{"init"}, []string{"compact"}) {
		t.Fatal("re-learning known Kimi names should report no change")
	}
}

// emptyFor gates the start-up probe (see ensureClaudeSlashRegistry), so it has to be
// per-runtime: a Kimi handshake must not make a Claude-less registry look already-learned and
// skip the probe. It must also survive a restart via the persisted file — otherwise every
// runner restart would re-spawn a throwaway CLI instead of the intended once-per-machine.
func TestSlashRegistryEmptyForGatesTheProbe(t *testing.T) {
	path := filepath.Join(t.TempDir(), "reg.json")
	r := newSlashRegistry(path)
	if !r.emptyFor(providerClaude) || !r.emptyFor(providerKimi) {
		t.Fatal("a fresh registry should be empty for every runtime")
	}

	r.learnFor(providerKimi, []string{"init"}, nil)
	if !r.emptyFor(providerClaude) {
		t.Fatal("a Kimi handshake must not mark Claude as learned")
	}
	if r.emptyFor(providerKimi) {
		t.Fatal("Kimi should be learned after its handshake")
	}

	r.learn([]string{"loop"}, nil)
	if r.emptyFor(providerClaude) {
		t.Fatal("Claude should be learned after its handshake")
	}
	if newSlashRegistry(path).emptyFor(providerClaude) {
		t.Fatal("a restart should reload the learned set, not re-probe")
	}
}
