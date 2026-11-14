package main

import (
	"strings"
	"testing"
)

// The session lifecycle and spawn backpressure vectors ("session recovery: …" in
// contracts/recovery.fixtures.json, the server's own bodies from session-recovery.ts) and how an agent is
// told to treat each one, over a surface that exposes every reader and could resend anything. The
// disposition is what separates doing it now, waiting, a person's confirmation, a person's fix and
// stopping (docs/recovery-contract.md §9.2).
func TestRecoverySessionCodesRenderToTheirDisposition(t *testing.T) {
	want := map[string]struct{ step, disposition, tool string }{
		"ORCHESTRATION_DISABLED":       {recoveryNextAskUser, recoveryDispositionManual, ""},
		"CALLER_SESSION_NOT_LIVE":      {recoveryNextStop, recoveryDispositionStop, ""},
		"SPAWN_DEPTH_LIMIT":            {recoveryNextStop, recoveryDispositionStop, ""},
		"SPAWN_TREE_OUTSTANDING_LIMIT": {recoveryNextWait, recoveryDispositionWait, ""},
		"SPAWN_TREE_RATE_LIMIT":        {recoveryNextStop, recoveryDispositionStop, ""},
		"WORKSPACE_NAME_AMBIGUOUS":     {recoveryNextManual, recoveryDispositionManual, ""},
		"WORKSPACE_NAME_NOT_FOUND":     {recoveryNextManual, recoveryDispositionManual, ""},
		"ENGINE_SIGNED_OUT":            {recoveryNextAskUser, recoveryDispositionManual, ""},
		"MANAGED_RUNNER_FAILED":        {recoveryNextAskUser, recoveryDispositionManual, ""},
		"SESSION_TRASHED":              {recoveryNextAskUser, recoveryDispositionManual, ""},
		"SESSION_ENDING":               {recoveryNextWait, recoveryDispositionWait, ""},
		"SESSION_NOT_TERMINAL":         {recoveryNextWait, recoveryDispositionWait, ""},
		"SESSION_NOT_STARTED":          {recoveryNextManual, recoveryDispositionManual, ""},
		"SESSION_MISSING_CONTEXT":      {recoveryNextManual, recoveryDispositionManual, ""},
		"SESSION_NO_RUNNER":            {recoveryNextManual, recoveryDispositionManual, ""},
		"SESSION_RUNNER_OFFLINE":       {recoveryNextWait, recoveryDispositionWait, ""},
		"SESSION_ENDED":                {recoveryNextManual, recoveryDispositionManual, ""},
		"SESSION_NEXT_TURN_STARTING":   {recoveryNextInvoke, recoveryDispositionAutomatic, "the_same_tool"},
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
		for _, sent := range []bool{false, true} {
			n := renderRecoveryNext(env, everything, sent)
			if n.Type != w.step || n.Disposition != w.disposition || n.Tool != w.tool {
				t.Errorf("%s: got %s/%s/%q, want %s/%s/%q (%+v)", env.Code, n.Type, n.Disposition, n.Tool, w.step, w.disposition, w.tool, n)
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
