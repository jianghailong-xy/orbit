package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The bridge argv is the whole spawn contract for a DSH session: the session
// UUID as the recovery key, the agent's model as an optional --model, and never
// the user's prompt (every turn rides stdin as a `user` frame).
func TestDSHCommandArgs(t *testing.T) {
	job := &ClaimedSession{SessionUUID: "sess-1", Agent: AgentExecConfig{Model: "deepseek-chat"}}
	args := dshCommandArgs(job)
	if len(args) != 4 || args[0] != "--session-id" || args[1] != "sess-1" ||
		args[2] != "--model" || args[3] != "deepseek-chat" {
		t.Fatalf("args = %q, want [--session-id sess-1 --model deepseek-chat]", args)
	}

	noModel := dshCommandArgs(&ClaimedSession{SessionUUID: "sess-2"})
	if len(noModel) != 2 || noModel[0] != "--session-id" || noModel[1] != "sess-2" {
		t.Fatalf("args without model = %q, want [--session-id sess-2]", noModel)
	}
}

// DSH_ORBIT_BRIDGE names the bridge wherever it was deployed; without it the
// runner looks next to its own executable.
func TestDSHBridgePath(t *testing.T) {
	dir := t.TempDir()
	bridge := filepath.Join(dir, "dsh-orbit-bridge.mjs")
	if err := os.WriteFile(bridge, []byte("#!/usr/bin/env node\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DSH_ORBIT_BRIDGE", bridge)
	if got := dshBridgePath(); got != bridge {
		t.Fatalf("DSH_ORBIT_BRIDGE = %q, want %q", got, bridge)
	}
	t.Setenv("DSH_ORBIT_BRIDGE", "")
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cand := filepath.Join(filepath.Dir(exe), "dsh-orbit-bridge.mjs")
	if err := os.WriteFile(cand, []byte("#!/usr/bin/env node\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	defer os.Remove(cand)
	if got := dshBridgePath(); got != cand {
		t.Fatalf("exe-dir fallback = %q, want %q", got, cand)
	}
}

// The default-model probe is what the runtime-defaults heartbeat reports: the
// composed headless default, overridable per runner via DSH_ORBIT_MODEL.
func TestDSHDefaultModel(t *testing.T) {
	t.Setenv("DSH_ORBIT_MODEL", "my-model")
	if model, err := fetchDSHDefaultModel(); err != nil || model != "my-model" {
		t.Fatalf("DSH_ORBIT_MODEL override = (%q, %v), want my-model", model, err)
	}
	t.Setenv("DSH_ORBIT_MODEL", "")
	model, err := fetchDSHDefaultModel()
	if err != nil || model == "" || !strings.Contains(model, "/") {
		t.Fatalf("default model = (%q, %v), want the composed headless default", model, err)
	}
}
