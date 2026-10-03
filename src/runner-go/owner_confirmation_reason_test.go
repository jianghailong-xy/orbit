package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The server's 409 when a session declares OWNER_CONFIRMED outside an Automatic project and names
// no reason (apiserver tasks/owner-confirmation-reason.ts), trimmed to the fields a terminal reads.
const ownerReasonRequiredJSON = `{
  "code":"OWNER_CONFIRMATION_REASON_REQUIRED",
  "kind":"REFUSAL",
  "requiredAction":"DECLARE_EVIDENCE_JUDGMENT_THE_DISPATCHING_SESSION_SETTLES",
  "suggestedCriterion":"EVIDENCE_JUDGMENT",
  "reasonField":"ownerConfirmationReason",
  "message":"Only the account owner can settle an OWNER_CONFIRMED task; declare EVIDENCE_JUDGMENT."
}`

// ownerReasonServer answers 409 for an OWNER_CONFIRMED declaration that names no reason, as the
// server does, and records every body it was sent.
func ownerReasonServer(t *testing.T, bodies *[]map[string]interface{}) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		*bodies = append(*bodies, body)
		if body["completionCriterion"] == "OWNER_CONFIRMED" && body["ownerConfirmationReason"] == nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(ownerReasonRequiredJSON))
			return
		}
		_, _ = w.Write([]byte(`{"id":"task-1","tasks":[]}`))
	}))
}

func TestCLITaskCreateForwardsTheOwnerReasonAndShowsTheRefusalWithout(t *testing.T) {
	var bodies []map[string]interface{}
	srv := ownerReasonServer(t, &bodies)
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)

	base := []string{"create", "--title", "ship 1.4", "--completion-criterion", "OWNER_CONFIRMED", "--json"}
	var out bytes.Buffer
	err := cmdTaskCLI(base, strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "refused: OWNER_CONFIRMATION_REASON_REQUIRED") ||
		!strings.Contains(err.Error(), "do:      DECLARE_EVIDENCE_JUDGMENT_THE_DISPATCHING_SESSION_SETTLES") {
		t.Fatalf("a declaration with no reason = %v", err)
	}

	withReason := append([]string{}, base[:len(base)-1]...)
	withReason = append(withReason,
		"--owner-confirmation-reason", "DEPLOY",
		"--owner-confirmation-reason-note", "  ships 1.4 to the App Store  ",
		"--json")
	out.Reset()
	if err := cmdTaskCLI(withReason, strings.NewReader(""), &out); err != nil {
		t.Fatalf("a declaration with a reason: %v", err)
	}
	last := bodies[len(bodies)-1]
	if last["ownerConfirmationReason"] != "DEPLOY" || last["ownerConfirmationReasonNote"] != "ships 1.4 to the App Store" {
		t.Fatalf("forwarded body = %#v", last)
	}

	// Refused before any request: a reason that is not one of the four, and a blank sentence.
	sent := len(bodies)
	for _, bad := range [][]string{
		{"--owner-confirmation-reason", "BECAUSE"},
		{"--owner-confirmation-reason", "deploy"},
		{"--owner-confirmation-reason", "DEPLOY", "--owner-confirmation-reason-note", "   "},
	} {
		args := append(append([]string{}, base[:len(base)-1]...), bad...)
		if err := cmdTaskCLI(args, strings.NewReader(""), &out); err == nil {
			t.Fatalf("%v was accepted", bad)
		}
	}
	if len(bodies) != sent {
		t.Fatalf("a malformed reason reached the server: %d requests", len(bodies)-sent)
	}
}

func TestCLITaskUpdateForwardsAndClearsTheOwnerReason(t *testing.T) {
	var bodies []map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		bodies = append(bodies, body)
		_, _ = w.Write([]byte(`{"id":"task-1"}`))
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	if err := cmdTaskCLI([]string{"update", "task-1", "--owner-confirmation-reason", "OWNER_TRADE_OFF", "--json"},
		strings.NewReader(""), &out); err != nil {
		t.Fatalf("update with a reason: %v", err)
	}
	if bodies[0]["ownerConfirmationReason"] != "OWNER_TRADE_OFF" {
		t.Fatalf("update body = %#v", bodies[0])
	}
	if err := cmdTaskCLI([]string{"update", "task-1", "--clear-owner-confirmation-reason", "--json"},
		strings.NewReader(""), &out); err != nil {
		t.Fatalf("update clearing the reason: %v", err)
	}
	if value, ok := bodies[1]["ownerConfirmationReason"]; !ok || value != nil {
		t.Fatalf("clearing must send an explicit null, got %#v", bodies[1])
	}
	if err := cmdTaskCLI([]string{"update", "task-1", "--clear-owner-confirmation-reason",
		"--owner-confirmation-reason", "DEPLOY", "--json"}, strings.NewReader(""), &out); err == nil {
		t.Fatal("clearing and setting the reason in one write was accepted")
	}
	if len(bodies) != 2 {
		t.Fatalf("the contradictory update reached the server: %d requests", len(bodies))
	}
}

func TestMCPTaskToolsForwardTheOwnerReasonAtEveryDoor(t *testing.T) {
	var bodies []map[string]interface{}
	srv := ownerReasonServer(t, &bodies)
	defer srv.Close()
	mcp := &mcpServer{t: NewTransport(srv.URL, "tok")}

	result := mcp.callTool("task_create", map[string]interface{}{
		"title": "ship 1.4", "completionCriterion": "OWNER_CONFIRMED",
	})
	text := criterionAdviceText(t, result)
	if result["isError"] != true || !strings.Contains(text, "refused: OWNER_CONFIRMATION_REASON_REQUIRED") {
		t.Fatalf("MCP refusal = %#v", result)
	}

	result = mcp.callTool("task_create", map[string]interface{}{
		"title": "ship 1.4", "completionCriterion": "OWNER_CONFIRMED",
		"ownerConfirmationReason": "DEPLOY", "ownerConfirmationReasonNote": "ships 1.4",
	})
	if result["isError"] == true || bodies[1]["ownerConfirmationReason"] != "DEPLOY" ||
		bodies[1]["ownerConfirmationReasonNote"] != "ships 1.4" {
		t.Fatalf("MCP create = %#v, body = %#v", result, bodies[1])
	}

	result = mcp.callTool("task_create_batch", map[string]interface{}{
		"tasks": []interface{}{map[string]interface{}{
			"title": "drop the old table", "completionCriterion": "OWNER_CONFIRMED",
			"ownerConfirmationReason": "IRREVERSIBLE",
		}},
		"dryRun": true,
	})
	items, _ := bodies[2]["tasks"].([]interface{})
	item, _ := items[0].(map[string]interface{})
	if result["isError"] == true || item["ownerConfirmationReason"] != "IRREVERSIBLE" {
		t.Fatalf("MCP batch = %#v, body = %#v", result, bodies[2])
	}

	result = mcp.callTool("task_update", map[string]interface{}{
		"taskId": "task-1", "ownerConfirmationReason": nil, "ownerConfirmationReasonNote": nil,
	})
	if result["isError"] == true {
		t.Fatalf("MCP update = %#v", result)
	}
	if value, ok := bodies[3]["ownerConfirmationReason"]; !ok || value != nil {
		t.Fatalf("an explicit null must reach the server, body = %#v", bodies[3])
	}
}

func TestOwnerReasonSchemaIsTheServersFourOnEveryTaskTool(t *testing.T) {
	tools := toolDescriptors(false, false)
	enumOf := func(prop interface{}) []string {
		values := []string{}
		raw, _ := prop.(map[string]interface{})["enum"]
		switch list := raw.(type) {
		case []string:
			values = append(values, list...)
		case []interface{}:
			for _, value := range list {
				if s, ok := value.(string); ok {
					values = append(values, s)
				}
			}
		}
		return values
	}
	want := strings.Join(ownerConfirmationReasons, ",")
	if want != "DEPLOY,IRREVERSIBLE,OWNER_DEVICE_OR_ACCOUNT,OWNER_TRADE_OFF" {
		t.Fatalf("the reasons drifted from the server's: %s", want)
	}
	create := mcpToolProps(tools, "task_create")
	update := mcpToolProps(tools, "task_update")
	batch, _ := mcpToolProps(tools, "task_create_batch")["tasks"].(map[string]interface{})
	batchItems, _ := batch["items"].(map[string]interface{})
	batchProps, _ := batchItems["properties"].(map[string]interface{})
	for name, props := range map[string]map[string]interface{}{
		"task_create": create, "task_create_batch item": batchProps, "task_update": update,
	} {
		reason := props["ownerConfirmationReason"]
		if reason == nil || props["ownerConfirmationReasonNote"] == nil {
			t.Fatalf("%s omits the owner-confirmation reason fields", name)
		}
		if got := strings.Join(enumOf(reason), ","); got != want {
			t.Fatalf("%s enum = %s", name, got)
		}
		description, _ := reason.(map[string]interface{})["description"].(string)
		for _, words := range []string{"OWNER_CONFIRMATION_REASON_REQUIRED", "EVIDENCE_JUDGMENT", "task_evidence_decide", "30 minutes"} {
			if !strings.Contains(description, words) {
				t.Fatalf("%s reason description does not say %q", name, words)
			}
		}
	}
	// The edit door can take it back.
	types, _ := update["ownerConfirmationReason"].(map[string]interface{})["type"].([]string)
	if strings.Join(types, ",") != "string,null" {
		t.Fatalf("task_update reason type = %#v", update["ownerConfirmationReason"])
	}
}
