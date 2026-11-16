package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// `orbit status` prints, under each workspace, what its unattended work starts on exactly as
// `GET /runner/me` carries it (runner-api.controller.ts workspaceRunsWith, which reads the same
// SessionsService.taskRunsWith as the task payload's runsWith): the workspace's own answer for a task
// outside any project, then one line per open project with work here.
func TestStatusPrintsTheServersRunsWith(t *testing.T) {
	body := runnerMeBody(`[{"id":"0b7e4f2c-8a1d-4f63-b5c9-2e7d1a9c3f80","name":"orbit-develop","provider":"codex","workDir":"/srv/orbit",` +
		`"runsWith":{"engine":"codex","provider":"codex","providerBuiltin":true,"source":"WORKSPACE","anchorSessionId":null,"refusal":null},` +
		`"projects":[` +
		`{"id":"p1","title":"Unattended work","runsWith":{"engine":"claude","provider":"claude","providerBuiltin":true,"source":"PROJECT_COORDINATOR","anchorSessionId":"c1","refusal":null}},` +
		`{"id":"p2","title":"Keyed","runsWith":{"engine":"claude","provider":"anthropic-key","providerBuiltin":false,"source":"PROJECT_COORDINATOR","anchorSessionId":"c2","refusal":"the project's coordinator session \"Keyed\" runs on a credential that is no longer available (disabled)."}}` +
		`]},` +
		`{"id":"9d3a6c1e-5f2b-4e87-a0d4-7c8b2e6f1a95","name":"old-server","workDir":"/srv/old"}]`)
	var me MeResponse
	if err := json.Unmarshal([]byte(body), &me); err != nil {
		t.Fatal(err)
	}
	var out strings.Builder
	printStatusAgents(&out, me.Agents)
	want := "agents:\n" +
		"  • orbit-develop → /srv/orbit\n" +
		"      runs with: codex · codex (the newest session a person opened here)\n" +
		"      project \"Unattended work\": claude · claude (the project's coordinator session)\n" +
		"      project \"Keyed\": claude · anthropic-key (the project's coordinator session) — a start would be refused: " +
		"the project's coordinator session \"Keyed\" runs on a credential that is no longer available (disabled).\n" +
		// An apiserver without runsWith: the line it always printed, nothing invented.
		"  • old-server → /srv/old\n"
	if got := out.String(); got != want {
		t.Errorf("orbit status agents =\n%s\nwant\n%s", got, want)
	}
}
