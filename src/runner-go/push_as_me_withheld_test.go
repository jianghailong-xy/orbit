//go:build linux || darwin

package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The Push as me token never reaches the agent (docs/design/protected-branch-landing.md §5): it is in one git
// command's environment (networkGitCommandEnv) and nowhere an engine, a checkout's git configuration or a hook sees.
// Same shape as TestAgentEnvironmentsWithholdUserCredentials: every place that builds an agent's environment is built
// for real, with the token in the runner's own environment and in the agent's configuration.
func TestAgentEnvironmentsWithholdPushAsMeToken(t *testing.T) {
	const raw = `{"workspaceId":"w","protocol":"https","host":"github.com","path":"owner/repo","username":"x-access-token","password":"` + pushAsMeOwnerToken + `"}`
	for _, c := range userTokenEnvCases() {
		t.Run(c.name, func(t *testing.T) {
			dir := t.TempDir()
			t.Setenv("ORBIT_HOME", filepath.Join(dir, "orbit-home"))
			t.Setenv(orbitGitCredentialEnv, raw)
			t.Setenv("PAT_TEST_RUNNER_VALUE", "runner")
			t.Setenv(envRunnerChild, "")
			job := &ClaimedSession{
				SessionID: userTokenSessionID, SessionUUID: userTokenSessionID,
				AgentID: "31111111-2222-4333-8444-555555555555", TaskID: "21111111-2222-4333-8444-555555555555",
				Agent: AgentExecConfig{Model: "model", PermissionMode: "dontAsk", Env: map[string]string{
					orbitGitCredentialEnv:  raw,
					"PAT_TEST_AGENT_VALUE": "agent",
					envRunnerChild:         "",
				}},
			}
			env := c.env(t, job, dir)
			for _, want := range c.holds {
				if !containsString(env, want) {
					t.Fatalf("the environment lacks %q, so it is not the one this site builds: %q", want, env)
				}
			}
			for _, entry := range env {
				if key, _, _ := strings.Cut(entry, "="); strings.EqualFold(key, orbitGitCredentialEnv) || strings.Contains(entry, pushAsMeOwnerToken) {
					t.Errorf("the environment carries the Push as me token: %.40q", entry)
				}
			}
		})
	}
}

// A real Push as me landing with hooks planted in the checkout: the push runs none of them, so none sees the token,
// and the checkout's configuration and the runner's environment hold none either.
func TestPushAsMeLandingHooksNeverSeeTheToken(t *testing.T) {
	fx := newPushAsMeFixture(t)
	r := fx.repo(t)
	cmd := pushAsMeJob(t, r)
	fx.githubAnswersMain(t, bypassWords, "0")
	seen := filepath.Join(fx.dir, "hook-env")
	hook := "#!/bin/sh\nenv >> " + shellQuote(seen) + "\n"
	for _, dir := range []string{filepath.Join(fx.work, ".git", "hooks")} {
		_ = os.MkdirAll(dir, 0o755)
		for _, name := range []string{"pre-push", "reference-transaction", "post-checkout", "post-merge", "pre-commit", "post-commit"} {
			_ = os.WriteFile(filepath.Join(dir, name), []byte(hook), 0o755)
		}
	}
	result := runIntegrationJobUntilWithProgress(context.Background(), cmd, silent, fx.sender(nil))
	if result.State != "LANDED" || result.PushedAs != "OWNER" {
		t.Fatalf("result = %s/%s %s %v pushedAs %q, want LANDED as the owner", result.State, result.Phase, result.ErrorCode, result.ErrorDetail, result.PushedAs)
	}
	if got, _ := os.ReadFile(seen); strings.Contains(string(got), pushAsMeOwnerToken) || strings.Contains(string(got), orbitGitCredentialEnv) {
		t.Errorf("a hook saw the Push as me token")
	}
	checkTokenStaysInThePush(t, fx)
	// The canary search: every file the landing could have written — the checkout, the server's repository, the
	// scratch worktrees, the runner's home (its logs and link spool) — and the runner's captured output.
	for _, root := range []string{fx.dir, os.Getenv("ORBIT_HOME")} {
		_ = filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
			if err != nil || info.IsDir() || info.Size() > 8<<20 {
				return nil
			}
			if raw, err := os.ReadFile(path); err == nil && strings.Contains(string(raw), pushAsMeOwnerToken) {
				t.Errorf("%s holds the canary token", path)
			}
			return nil
		})
	}
}
