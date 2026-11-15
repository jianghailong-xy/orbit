package main

import (
	"encoding/json"
	"fmt"
	"testing"
)

// The client half of contracts/project-task-refusals.contract.json: every Project and Task refusal the
// API states a recovery block for reads back here as the same decision the server stated, and renders
// to the step its disposition asks for. A stale revision and a dependency refusal read first (the
// project, the graph); a delete or a crossing asks the user; a retired or aggregate-only task stops.

type projectTaskRefusal struct {
	Code           string      `json:"code"`
	RequiredAction string      `json:"requiredAction"`
	Status         int         `json:"status"`
	Endpoints      []string    `json:"endpoints"`
	Resources      [][2]string `json:"resources"`
	Recovery       struct {
		Effect           string  `json:"effect"`
		RetryPolicy      string  `json:"retryPolicy"`
		ActionCode       *string `json:"actionCode"`
		Actor            string  `json:"actor"`
		UserConfirmation string  `json:"userConfirmation"`
		Disposition      string  `json:"disposition"`
	} `json:"recovery"`
}

func loadProjectTaskRefusals(t *testing.T) []projectTaskRefusal {
	t.Helper()
	var file struct {
		RecoveryContractVersion int                  `json:"recoveryContractVersion"`
		Refusals                []projectTaskRefusal `json:"refusals"`
	}
	loadRecoveryJSON(t, "../../contracts/project-task-refusals.contract.json", &file)
	if file.RecoveryContractVersion != recoveryContractVersion || len(file.Refusals) == 0 {
		t.Fatalf("project-task refusals: version %d, %d entries", file.RecoveryContractVersion, len(file.Refusals))
	}
	return file.Refusals
}

// servedRefusal is the body the API serves for one entry: its code, a token requiredAction where the
// entry narrows to one, and the stated block with one public id per resource.
func servedRefusal(e projectTaskRefusal) string {
	resources := []map[string]string{}
	for i, r := range e.Resources {
		resources = append(resources, map[string]string{"type": r[0], "id": fmt.Sprintf("Id%d", i+1)})
	}
	block := map[string]interface{}{
		"effect": e.Recovery.Effect, "retryPolicy": e.Recovery.RetryPolicy, "actor": e.Recovery.Actor,
		"userConfirmation": e.Recovery.UserConfirmation, "disposition": e.Recovery.Disposition, "resources": resources,
	}
	if e.Recovery.ActionCode != nil {
		block["actionCode"] = *e.Recovery.ActionCode
	}
	body := map[string]interface{}{"statusCode": e.Status, "code": e.Code, "message": "prose", "recovery": block}
	if e.RequiredAction != "" {
		body["requiredAction"] = e.RequiredAction
	}
	data, _ := json.Marshal(body)
	return string(data)
}

func TestProjectTaskRefusalsReadBackAsStated(t *testing.T) {
	everything := fakeRecoverySurface{readable: map[string]bool{
		"task_get": true, "session_get": true, "project_get": true, "task_dependency_graph": true,
	}, canAgain: true}
	seen := map[string]bool{}
	for _, e := range loadProjectTaskRefusals(t) {
		name := e.Code + "/" + e.RequiredAction
		env, ok := parseRecovery(recoveryObservation{Source: "HTTP", Status: e.Status, Body: servedRefusal(e)})
		if !ok {
			t.Fatalf("%s: not read as a failure", name)
		}
		action := ""
		if env.ActionCode != nil {
			action = *env.ActionCode
		}
		want := ""
		if e.Recovery.ActionCode != nil {
			want = *e.Recovery.ActionCode
		}
		if env.Effect != e.Recovery.Effect || env.Retry.Policy != e.Recovery.RetryPolicy || action != want ||
			env.Actor != e.Recovery.Actor || env.UserConfirmation != e.Recovery.UserConfirmation ||
			env.Disposition != e.Recovery.Disposition {
			t.Errorf("%s: read back as %+v, stated %+v", name, env, e.Recovery)
		}
		seen[env.Disposition] = true

		next := renderRecoveryNext(env, everything, false)
		switch {
		case action == "REREAD_AND_DECIDE":
			r := env.Resources[0]
			if next.Type != recoveryNextInvoke || next.Tool != recoveryReaders[r.Type][0] || next.Input[recoveryReaders[r.Type][1]] != r.ID {
				t.Errorf("%s: a re-read reads %s %s first, got %+v", name, r.Type, r.ID, next)
			}
		case action == "READ_GRAPH_AND_REPLAN":
			if next.Type != recoveryNextInvoke || next.Tool != "task_dependency_graph" || next.Input["taskId"] != env.Resources[0].ID {
				t.Errorf("%s: a dependency refusal reads the graph first, got %+v", name, next)
			}
		case env.Disposition == "STOP":
			if next.Type != recoveryNextStop {
				t.Errorf("%s: STOP renders %+v", name, next)
			}
		case env.Disposition == "CONFIRM_THEN_RUN" || env.Disposition == "HUMAN":
			if next.Type != recoveryNextAskUser {
				t.Errorf("%s: %s renders %+v", name, env.Disposition, next)
			}
		case env.Disposition == "WAIT":
			if next.Type != recoveryNextWait {
				t.Errorf("%s: WAIT renders %+v", name, next)
			}
		case env.Disposition == "AUTOMATIC":
			// The caller changes its own request: never the identical write sent again.
			if next.Type == recoveryNextInvoke || next.Type == recoveryNextAskUser {
				t.Errorf("%s: AUTOMATIC renders %+v", name, next)
			}
		}
		if next.Type == recoveryNextInvoke && next.Tool == "the_same_tool" {
			t.Errorf("%s: a refusal is never answered by the identical request", name)
		}
	}
	for _, d := range recoveryDispositions {
		if !seen[d] {
			t.Errorf("no entry is %s", d)
		}
	}
}
