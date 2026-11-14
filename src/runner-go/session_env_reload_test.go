package main

import (
	"testing"
	"time"
)

// A restart from the session's Settings (POST /sessions/:id/restart) is a `reload` that names no
// provider and carries the session's freshly resolved environment. The engine has to be replaced
// with that environment — not only on a provider switch — so the variables a person just saved
// reach the process that runs their next turn, and a variable they removed is gone from it.
func TestSessionRespawnsTheEngineWithTheEnvironmentAReloadCarries(t *testing.T) {
	reload := reloadTurn("restart-1", `{"env":true}`)
	reload.turn.Env = map[string]string{fakeSpawnProbeEnv: "after-restart"}
	// The restart reaches a session whose engine is already running. Handed over at once, the
	// reload races the spawn: the runner reads its inbox while the engine is still being started,
	// and a reload that kills the process before the CLI has exec'd leaves no spawn to assert on.
	spawned := make(chan struct{})
	reload.afterHeld = spawned

	first := runDeliverySessionWith(t, []fakeStep{{Await: "user"}}, []scriptedTurn{reload}, nil,
		deliveryOptions{
			claim: func(job *ClaimedSession) {
				job.Agent.Env = map[string]string{fakeSpawnProbeEnv: "before-restart", "REMOVED_BY_RESTART": "1"}
			},
			started: func(r *deliverySession) {
				go func() {
					defer close(spawned)
					for deadline := time.Now().Add(fakeClaudeTimeout); time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
						if len(r.fake.readLines("spawns.jsonl")) > 0 {
							return
						}
					}
				}()
			},
		})

	if !first.reload {
		t.Fatal("a reload carrying an environment did not ask for a re-spawn, so the running engine keeps the old one")
	}
	if spawns := first.fake.Spawns(); len(spawns) != 1 || spawns[0].Probe != "before-restart" {
		t.Fatalf("the engine before the restart was spawned with %#v, want one spawn on the claimed env", spawns)
	}
	if _, kept := first.job.Agent.Env["REMOVED_BY_RESTART"]; kept || first.job.Agent.Env[fakeSpawnProbeEnv] != "after-restart" {
		t.Fatalf("the claim after the reload holds env %#v, want exactly the reload's", first.job.Agent.Env)
	}

	// The re-spawn: the outer loop starts the engine again from the same claim.
	second := runDeliverySessionWith(t, []fakeStep{{Await: "user"}}, nil, func(r *deliverySession) bool {
		return len(r.fake.Spawns()) == 1
	}, deliveryOptions{claim: func(job *ClaimedSession) { job.Agent.Env = first.job.Agent.Env }})

	if spawns := second.fake.Spawns(); len(spawns) != 1 || spawns[0].Probe != "after-restart" {
		t.Fatalf("the re-spawned engine was started with %#v, want the reload's environment", spawns)
	}
}
