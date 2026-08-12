package main

import (
	"encoding/json"
	"testing"
)

// A reload that moved the session to another provider on the same runtime replaces the whole
// environment, so the account it was switched away from leaves no variable behind.
func TestApplyProviderEnvReplacesTheOutgoingProvidersVariables(t *testing.T) {
	job := &ClaimedSession{Agent: AgentExecConfig{Env: map[string]string{
		"ANTHROPIC_BASE_URL":   "https://first.example",
		"ANTHROPIC_AUTH_TOKEN": "first-account",
		"MY_AGENT_VAR":         "kept-by-the-server",
	}}}

	if !applyProviderEnv(job, &RunInboxResponse{Env: map[string]string{
		"ANTHROPIC_BASE_URL":   "https://second.example",
		"ANTHROPIC_AUTH_TOKEN": "second-account",
	}}) {
		t.Fatal("a reload carrying an environment must ask for a re-spawn")
	}
	if job.Agent.Env["ANTHROPIC_AUTH_TOKEN"] != "second-account" {
		t.Fatalf("env = %#v", job.Agent.Env)
	}
	if _, stale := job.Agent.Env["MY_AGENT_VAR"]; stale {
		t.Fatalf("the replacement must be wholesale, got %#v", job.Agent.Env)
	}
}

// Moving onto a built-in engine injects nothing — it signs in for itself — and arrives as an
// empty map. That still has to clear the key the session was running on.
func TestApplyProviderEnvTreatsAnEmptyMapAsAMove(t *testing.T) {
	job := &ClaimedSession{Agent: AgentExecConfig{Env: map[string]string{
		"ANTHROPIC_AUTH_TOKEN": "byok-key",
	}}}

	var resp RunInboxResponse
	if err := json.Unmarshal([]byte(`{"kind":"reload","env":{}}`), &resp); err != nil {
		t.Fatal(err)
	}
	if !applyProviderEnv(job, &resp) {
		t.Fatal("an empty environment is a move, not an absent one")
	}
	if len(job.Agent.Env) != 0 {
		t.Fatalf("env = %#v", job.Agent.Env)
	}
}

// Every other reload — model, permission mode, effort — leaves the environment alone, so the
// long-lived runtimes keep the process they have.
func TestApplyProviderEnvIgnoresAReloadWithoutOne(t *testing.T) {
	job := &ClaimedSession{Agent: AgentExecConfig{Env: map[string]string{"ANTHROPIC_AUTH_TOKEN": "key"}}}

	var resp RunInboxResponse
	if err := json.Unmarshal([]byte(`{"kind":"reload","content":"{\"model\":\"claude-haiku-4-5\"}"}`), &resp); err != nil {
		t.Fatal(err)
	}
	if applyProviderEnv(job, &resp) {
		t.Fatal("a model-only reload must not restart the engine")
	}
	if job.Agent.Env["ANTHROPIC_AUTH_TOKEN"] != "key" {
		t.Fatalf("env = %#v", job.Agent.Env)
	}
}

// The two changes travel together: the model the new provider resolved is in the payload, the
// credential is in the envelope, and both land before the re-spawn reads job.Agent.
func TestReloadAppliesTheSwitchedModelAndEnvironmentTogether(t *testing.T) {
	job := &ClaimedSession{Agent: AgentExecConfig{
		Model: "claude-opus-5",
		Env:   map[string]string{"ANTHROPIC_AUTH_TOKEN": "first"},
	}}
	resp := &RunInboxResponse{
		Content: `{"model":"glm-5","permissionMode":"default","provider":"zhipu"}`,
		Env:     map[string]string{"ANTHROPIC_BASE_URL": "https://zhipu.example", "ANTHROPIC_AUTH_TOKEN": "second"},
	}

	applyRuntimeReload(job, resp.Content)
	respawn := applyProviderEnv(job, resp)

	if job.Agent.Model != "glm-5" || job.Agent.Env["ANTHROPIC_AUTH_TOKEN"] != "second" || !respawn {
		t.Fatalf("agent = %#v respawn = %v", job.Agent, respawn)
	}
}
