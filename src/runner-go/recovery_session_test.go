package main

import (
	"strings"
	"testing"
)

// The session lifecycle and spawn backpressure vectors ("session recovery: …" in
// contracts/recovery.fixtures.json, the server's own bodies from session-recovery.ts) and how an agent is
// told to treat each one, over a surface that exposes every reader and could resend anything. The
// envelope's disposition — the one the server states, and the one the contract rules derive — is what
// separates doing it now, waiting, a person's fix and stopping (docs/recovery-contract.md §11.2).
func TestRecoverySessionCodesRenderToTheirDisposition(t *testing.T) {
	want := map[string]struct{ step, disposition, tool string }{
		"ORCHESTRATION_DISABLED":       {recoveryNextAskUser, "HUMAN", ""},
		"CALLER_SESSION_NOT_LIVE":      {recoveryNextStop, "STOP", ""},
		"SPAWN_DEPTH_LIMIT":            {recoveryNextStop, "STOP", ""},
		"SPAWN_TREE_OUTSTANDING_LIMIT": {recoveryNextWait, "WAIT", ""},
		"SPAWN_TREE_RATE_LIMIT":        {recoveryNextStop, "STOP", ""},
		"WORKSPACE_NAME_AMBIGUOUS":     {recoveryNextManual, "AUTOMATIC", ""},
		"WORKSPACE_NAME_NOT_FOUND":     {recoveryNextManual, "AUTOMATIC", ""},
		"ENGINE_SIGNED_OUT":            {recoveryNextAskUser, "HUMAN", ""},
		"MANAGED_RUNNER_FAILED":        {recoveryNextAskUser, "HUMAN", ""},
		"RUNNER_DISK_BELOW_FLOOR":      {recoveryNextAskUser, "HUMAN", ""},
		"SESSION_TRASHED":              {recoveryNextAskUser, "HUMAN", ""},
		"SESSION_ENDING":               {recoveryNextWait, "WAIT", ""},
		"SESSION_NOT_TERMINAL":         {recoveryNextWait, "WAIT", ""},
		"SESSION_NOT_STARTED":          {recoveryNextManual, "AUTOMATIC", ""},
		"SESSION_MISSING_CONTEXT":      {recoveryNextManual, "AUTOMATIC", ""},
		"SESSION_NO_RUNNER":            {recoveryNextManual, "AUTOMATIC", ""},
		"SESSION_RUNNER_OFFLINE":       {recoveryNextWait, "WAIT", ""},
		"SESSION_ENDED":                {recoveryNextManual, "AUTOMATIC", ""},
		"SESSION_NEXT_TURN_STARTING":   {recoveryNextInvoke, "AUTOMATIC", "the_same_tool"},
	}
	everything := fakeRecoverySurface{readable: map[string]bool{"task_get": true, "session_get": true, "project_get": true}, canAgain: true}
	seen := map[string]bool{}
	for _, c := range loadRecoveryFixtures(t) {
		if !strings.HasPrefix(c.Name, "session recovery: ") {
			continue
		}
		env, ok := parseRecovery(c.Input)
		if !ok {
			t.Fatalf("%s: no envelope", c.Name)
		}
		w, known := want[env.Code]
		if !known {
			t.Fatalf("%s: no expectation for %s", c.Name, env.Code)
		}
		seen[env.Code] = true
		if env.Disposition != w.disposition || recoveryDispositionOf(env, "") != w.disposition {
			t.Errorf("%s: disposition %s (derived %s), want %s", env.Code, env.Disposition, recoveryDispositionOf(env, ""), w.disposition)
		}
		for _, sent := range []bool{false, true} {
			n := renderRecoveryNext(env, everything, sent)
			if n.Type != w.step || n.Tool != w.tool {
				t.Errorf("%s: got %s/%q, want %s/%q (%+v)", env.Code, n.Type, n.Tool, w.step, w.tool, n)
			}
			// Nothing but the next-turn race is ever sent again as it was; a poll waits the seconds it names.
			if n.Tool == "the_same_tool" && env.Code != "SESSION_NEXT_TURN_STARTING" {
				t.Errorf("%s: offered a resend", env.Code)
			}
			if *env.ActionCode == "POLL_STATE" && (n.AfterSeconds == nil || *n.AfterSeconds != 5 || env.Resources[0].ID != "SESSION_FIXTURE_1") {
				t.Errorf("%s: poll %+v", env.Code, n)
			}
		}
	}
	for code := range want {
		if !seen[code] {
			t.Errorf("no vector for %s", code)
		}
	}
}
