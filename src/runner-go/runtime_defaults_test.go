package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestHeartbeatRuntimeDefaultsDistinguishPendingProbeFromEmptySnapshot(t *testing.T) {
	pending, err := json.Marshal(HeartbeatRequest{})
	if err != nil {
		t.Fatal(err)
	}
	empty, err := json.Marshal(HeartbeatRequest{RuntimeDefaultModels: map[string]string{}})
	if err != nil {
		t.Fatal(err)
	}
	if string(pending) != `{"status":"","idleCapacity":0,"runtimeDefaultModels":null}` {
		t.Fatalf("pending heartbeat = %s", pending)
	}
	if string(empty) != `{"status":"","idleCapacity":0,"runtimeDefaultModels":{}}` {
		t.Fatalf("empty snapshot heartbeat = %s", empty)
	}
}

func TestFetchCodexDefaultModelUsesCodexHome(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	config := `# user selection
model = "gpt-5.6-terra" # keep this comment

[profiles.review]
model = "gpt-should-not-win"
`
	if err := os.WriteFile(filepath.Join(dir, "config.toml"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := fetchCodexDefaultModel()
	if err != nil {
		t.Fatal(err)
	}
	if got != "gpt-5.6-terra" {
		t.Fatalf("default = %q, want gpt-5.6-terra", got)
	}
}

func TestFetchKimiDefaultModelUsesCodeHome(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("KIMI_CODE_HOME", dir)
	t.Setenv("KIMI_MODEL_NAME", "")
	t.Setenv("KIMI_MODEL_API_KEY", "")
	config := `default_model = 'kimi-code/kimi-for-coding'

[models.other]
model = "other"
`
	if err := os.WriteFile(filepath.Join(dir, "config.toml"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := fetchKimiDefaultModel()
	if err != nil {
		t.Fatal(err)
	}
	if got != "kimi-code/kimi-for-coding" {
		t.Fatalf("default = %q, want kimi-code/kimi-for-coding", got)
	}
}

func TestFetchKimiDefaultModelHonorsCompleteProcessEnvironment(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("KIMI_CODE_HOME", dir)
	t.Setenv("KIMI_MODEL_NAME", "env-kimi-model")
	t.Setenv("KIMI_MODEL_API_KEY", "sk-test")
	if err := os.WriteFile(
		filepath.Join(dir, "config.toml"),
		[]byte(`default_model = "config-kimi-model"`),
		0o600,
	); err != nil {
		t.Fatal(err)
	}

	got, err := fetchKimiDefaultModel()
	if err != nil {
		t.Fatal(err)
	}
	if got != "env-kimi-model" {
		t.Fatalf("default = %q, want env-kimi-model", got)
	}
}

func TestFetchKimiDefaultModelIgnoresIncompleteProcessEnvironment(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("KIMI_CODE_HOME", dir)
	t.Setenv("KIMI_MODEL_NAME", "incomplete-env-model")
	t.Setenv("KIMI_MODEL_API_KEY", "")
	if err := os.WriteFile(
		filepath.Join(dir, "config.toml"),
		[]byte(`default_model = "config-kimi-model"`),
		0o600,
	); err != nil {
		t.Fatal(err)
	}

	got, err := fetchKimiDefaultModel()
	if err != nil {
		t.Fatal(err)
	}
	if got != "config-kimi-model" {
		t.Fatalf("default = %q, want config-kimi-model", got)
	}
}

func TestMergeRuntimeDefaultModelsWaitsForReliableFirstSnapshot(t *testing.T) {
	results := []runtimeDefaultProbeResult{
		{runtime: providerClaude, err: errors.New("temporary settings read failure")},
		{runtime: providerCodex, model: "gpt-new"},
		{runtime: providerKimi},
	}
	if got := mergeRuntimeDefaultModels(nil, results); got != nil {
		t.Fatalf("first failed snapshot = %#v, want nil", got)
	}

	results[0] = runtimeDefaultProbeResult{runtime: providerClaude, model: "claude-new"}
	want := map[string]string{providerClaude: "claude-new", providerCodex: "gpt-new"}
	if got := mergeRuntimeDefaultModels(nil, results); !reflect.DeepEqual(got, want) {
		t.Fatalf("first reliable snapshot = %#v, want %#v", got, want)
	}
}

func TestMergeRuntimeDefaultModelsPreservesOnlyFailedRuntimeAfterInitialization(t *testing.T) {
	previous := map[string]string{
		providerClaude: "claude-old",
		providerCodex:  "gpt-old",
		providerKimi:   "kimi-old",
	}
	results := []runtimeDefaultProbeResult{
		{runtime: providerClaude, err: errors.New("temporary settings read failure")},
		{runtime: providerCodex, model: " gpt-new "},
		{runtime: providerKimi},
	}
	want := map[string]string{providerClaude: "claude-old", providerCodex: "gpt-new"}
	got := mergeRuntimeDefaultModels(previous, results)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("merged snapshot = %#v, want %#v", got, want)
	}
	if previous[providerCodex] != "gpt-old" || previous[providerKimi] != "kimi-old" {
		t.Fatalf("merge mutated previous snapshot: %#v", previous)
	}
}

func TestProbeRuntimeDefaultModelsClearsRuntimesWhoseCLIsAreUnavailable(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PATH", dir)
	t.Setenv("ANTHROPIC_MODEL", "claude-should-not-be-read")
	t.Setenv("CODEX_HOME", dir)
	t.Setenv("KIMI_MODEL_NAME", "kimi-should-not-be-read")
	t.Setenv("KIMI_MODEL_API_KEY", "sk-test")
	if err := os.WriteFile(
		filepath.Join(dir, "config.toml"),
		[]byte(`model = "gpt-should-not-be-read"`),
		0o600,
	); err != nil {
		t.Fatal(err)
	}

	results := probeRuntimeDefaultModels()
	for _, result := range results {
		if result.err != nil || result.model != "" {
			t.Fatalf("unavailable %s probe = %#v, want successful clear", result.runtime, result)
		}
	}
	previous := map[string]string{
		providerClaude: "claude-old",
		providerCodex:  "gpt-old",
		providerKimi:   "kimi-old",
	}
	if got := mergeRuntimeDefaultModels(previous, results); len(got) != 0 {
		t.Fatalf("snapshot after unavailable CLIs = %#v, want empty", got)
	}
}

func TestProbeRuntimeDefaultModelsReadsOnlyAvailableCLI(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, providerCodex), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	t.Setenv("ANTHROPIC_MODEL", "claude-should-not-be-read")
	t.Setenv("CODEX_HOME", dir)
	t.Setenv("KIMI_MODEL_NAME", "kimi-should-not-be-read")
	t.Setenv("KIMI_MODEL_API_KEY", "sk-test")
	if err := os.WriteFile(
		filepath.Join(dir, "config.toml"),
		[]byte(`model = "gpt-from-codex-config"`),
		0o600,
	); err != nil {
		t.Fatal(err)
	}

	results := probeRuntimeDefaultModels()
	got := make(map[string]runtimeDefaultProbeResult, len(results))
	for _, result := range results {
		got[result.runtime] = result
	}
	if result := got[providerCodex]; result.err != nil || result.model != "gpt-from-codex-config" {
		t.Fatalf("available Codex probe = %#v", result)
	}
	for _, runtime := range []string{providerClaude, providerKimi} {
		if result := got[runtime]; result.err != nil || result.model != "" {
			t.Fatalf("unavailable %s probe = %#v, want successful clear", runtime, result)
		}
	}
}

func TestReadTopLevelTOMLStringDoesNotReadNestedKey(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(path, []byte("[profile]\nmodel = \"nested\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := readTopLevelTOMLString(path, "model")
	if err != nil {
		t.Fatal(err)
	}
	if got != "" {
		t.Fatalf("default = %q, want unavailable", got)
	}
}

func TestReadTopLevelTOMLStringMissingFileIsUnavailable(t *testing.T) {
	got, err := readTopLevelTOMLString(filepath.Join(t.TempDir(), "missing.toml"), "model")
	if err != nil {
		t.Fatal(err)
	}
	if got != "" {
		t.Fatalf("default = %q, want unavailable", got)
	}
}
