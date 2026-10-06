package main

import "strings"

// userCredentialEnvKey reports the variables that carry a person's own credential: ORBIT_USER_TOKEN,
// the personal access token the `orbit` CLI acts as its user with (docs/personal-access-token-design.md
// §7.1). Signing in on a runner machine is supported, so the runner's own environment may hold one, and
// no agent process is handed it — not from that environment, not from the agent's configuration (§8).
// An agent acts as its session, and inside one the CLI is to ignore a personal token (§7.2), so all the
// variable could do there is be read. Unlike sessionContextEnvKey, nothing puts these back.
//
// A credential of the same kind is added here and nowhere else: envWithAgent and every spawn handed
// its environment by a caller drop what this names, and TestAgentEnvironmentsWithholdUserCredentials
// holds each place that builds an agent's environment to it.
func userCredentialEnvKey(key string) bool {
	switch strings.ToUpper(key) {
	case "ORBIT_USER_TOKEN":
		return true
	default:
		return false
	}
}

// runnerChildEnv is env as the runner hands it to a process it starts: without its userCredentialEnvKey
// entries, and marked envRunnerChild whatever env said of that, so the CLI there never acts as the
// person whose login is saved on the machine either (§7.2). envWithAgent ends in it, and a spawn handed
// its base environment instead applies it where the session's ORBIT_* go on, so the spawn does not
// depend on every caller having done so first. An environment built from nothing has no credential to
// drop and says envRunnerChild itself; TestAgentEnvironmentsWithholdUserCredentials holds every place
// that builds one to both.
func runnerChildEnv(env []string) []string {
	kept := make([]string, 0, len(env)+1)
	for _, entry := range env {
		key, _, _ := strings.Cut(entry, "=")
		if !userCredentialEnvKey(key) && !strings.EqualFold(key, envRunnerChild) {
			kept = append(kept, entry)
		}
	}
	return append(kept, envRunnerChild+"=1")
}
