package main

import (
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

// The recovery notes (docs/agent-instructions-design.md §3, kind D, step 4): what an answer means and what to do
// next is said in the receipt of the call that met it, so the always-on instructions need not carry it. Each case is
// the path a real engine takes, a tools/call into `orbit mcp`, except the pending card, whose hand-off needs a
// runner-hosted job service and is built from the call record the hand-off fills in.

func TestReceiptNotesSayWhatACardsAnswerMeans(t *testing.T) {
	for _, tc := range cardWrites {
		t.Run(tc.tool, func(t *testing.T) {
			preview := func(r *http.Request, _ map[string]interface{}) (int, string) {
				if strings.Contains(r.URL.Path, "batch-preview") {
					return 200, `{"tasks":1}`
				}
				return 200, `{"id":"x"}`
			}
			_, srv := newContractServer(t, `{"status":"DENIED","decidedById":"owner-1"}`, preview)
			_, declined := rpcCall(t, contractMCP(srv.URL), tc.tool, tc.args)
			if declined.Outcome != outcomeDeclined || !reflect.DeepEqual(declined.Notes, []string{declinedNote}) {
				t.Errorf("declined: outcome %q notes %q, want %q", declined.Outcome, declined.Notes, declinedNote)
			}
			_, srv = newContractServer(t, `{"status":"DENIED","message":"Call it [SEC] first.","decidedById":"owner-1"}`, preview)
			_, chat := rpcCall(t, contractMCP(srv.URL), tc.tool, tc.args)
			if chat.Outcome != outcomeChat || !reflect.DeepEqual(chat.Notes, []string{chatNote}) {
				t.Errorf("chat: outcome %q notes %q, want %q", chat.Outcome, chat.Notes, chatNote)
			}
		})
	}
	for _, phrase := range []string{"final on every surface", "the CLI"} {
		if !strings.Contains(declinedNote, phrase) {
			t.Errorf("the declined note does not say %q: %q", phrase, declinedNote)
		}
	}
	if !strings.Contains(chatNote, "Not a no") || !strings.Contains(chatNote, "call the tool again, changed as agreed") {
		t.Errorf("the chat note = %q", chatNote)
	}

	// A card still waiting for the owner: the call was handed to a runner-hosted job (handOffOwnerWait).
	rec := newCallRecord(lookupCatalogOperation("task_create"), map[string]interface{}{"title": "a"})
	rec.waitingForOwner("bgj_1", json.RawMessage(`{"jobId":"bgj_1"}`))
	pending := rec.receipt("Not done yet", false)
	if pending.Outcome != outcomePending || pending.Error == nil || pending.Error.Retry != retryWait ||
		!reflect.DeepEqual(pending.Notes, []string{pendingCardNote}) {
		t.Errorf("pending: outcome %q error %+v notes %q", pending.Outcome, pending.Error, pending.Notes)
	}
	if !strings.Contains(pendingCardNote, "not a no") || !strings.Contains(pendingCardNote, "end your turn") {
		t.Errorf("the pending note = %q", pendingCardNote)
	}
}

// A question only the owner answers (settings_propose, request_owner_action, …) is written at once and its answer
// is pending: the receipt says it is never the agent's to answer.
func TestReceiptNoteSaysAnOwnerOnlyAnswerIsNotTheAgents(t *testing.T) {
	_, srv := newSettingsFakeServer(t)
	mcp := &mcpServer{t: NewTransport(srv.URL, "runner-token"), sessionID: "caller-session"}
	r := settingsReceipt(t, mcp.invokeTool("settings_propose", map[string]interface{}{"changes": map[string]interface{}{"theme": "dark"}, "why": "asked"}))
	if !r.OK || r.Approval.Outcome != approvalOutcomePending || !contains(r.Notes, ownerAnswersNote) {
		t.Errorf("receipt = ok %v approval %+v notes %q, want the owner-answers note", r.OK, r.Approval, r.Notes)
	}
	if !strings.Contains(ownerAnswersNote, "never answer it yourself") {
		t.Errorf("the owner-answers note = %q", ownerAnswersNote)
	}
}

// A report against a revision that moved is read again, not resent: the receipt's retry rule and its note say so.
func TestReceiptNoteForAProgressRevisionConflict(t *testing.T) {
	_, srv := newContractServer(t, `{"status":"ALLOWED"}`, func(*http.Request, map[string]interface{}) (int, string) {
		return 409, `{"code":"PROGRESS_REVISION_CONFLICT","message":"The progress is at revision 4, not 3."}`
	})
	result, r := rpcCall(t, contractMCP(srv.URL), "task_progress_report", map[string]interface{}{"current": 2, "total": 3, "expectedRevision": 3})
	if result["isError"] != true || r.Error == nil || r.Error.Code != errorCodeProgressRevisionConflict || r.Error.Retry != retryRereadFirst {
		t.Fatalf("receipt = %+v error %+v", r, r.Error)
	}
	if !reflect.DeepEqual(r.Notes, []string{progressConflictNote}) {
		t.Errorf("notes = %q, want %q", r.Notes, progressConflictNote)
	}
	if !strings.Contains(progressConflictNote, "read it again") || !strings.Contains(progressConflictNote, "against the revision it shows") {
		t.Errorf("the conflict note = %q", progressConflictNote)
	}
}

// A settings key only the owner may change comes back with its row's link ready to put in the reply; a change the
// owner declined is not proposed again.
func TestReceiptNotesForARefusedSettingsKey(t *testing.T) {
	fake, srv := newSettingsFakeServer(t)
	mcp := &mcpServer{t: NewTransport(srv.URL, "runner-token"), sessionID: "caller-session"}
	propose := func() toolReceipt {
		return settingsReceipt(t, mcp.invokeTool("settings_propose", map[string]interface{}{"changes": map[string]interface{}{"enableOrchestration": true}, "why": "asked"}))
	}
	fake.refuse.status = http.StatusForbidden
	fake.refuse.body = `{"code":"SETTING_OWNER_ONLY","message":"\"Let sessions orchestrate\" gives agents more reach; only you can turn it on, in Settings.","settings":[{"key":"enableOrchestration","title":"Let sessions orchestrate","path":"/settings/general","link":"orbit-settings:enableOrchestration"}]}`
	r := propose()
	if r.Error == nil || r.Error.Code != errorCodeSettingOwnerOnly || len(r.Notes) != 1 ||
		!strings.HasPrefix(r.Notes[0], settingOwnerOnlyNote) || !strings.Contains(r.Notes[0], "[Let sessions orchestrate](orbit-settings:enableOrchestration)") {
		t.Errorf("SETTING_OWNER_ONLY: error %+v notes %q, want the row's link", r.Error, r.Notes)
	}
	fake.refuse.status = http.StatusConflict
	fake.refuse.body = `{"code":"SETTINGS_CHANGE_DECLINED","message":"The owner declined this change.","requestId":"req-0"}`
	if r := propose(); r.Error == nil || r.Error.Code != errorCodeSettingsChangeDeclined || !reflect.DeepEqual(r.Notes, []string{settingsChangeDeclinedNote}) {
		t.Errorf("SETTINGS_CHANGE_DECLINED: error %+v notes %q", r.Error, r.Notes)
	}
}

// With orchestration off, a session tool is refused, and the receipt says what to do instead: start the recorded
// work or record it, point the user to the switch, and claim no delegation.
func TestReceiptNoteForTheOrchestrationOffRefusal(t *testing.T) {
	cs, srv := newContractServer(t, `{"status":"ALLOWED"}`, entityAnswer)
	mcp := contractMCP(srv.URL)
	mcp.allowOrchestration = false
	_, r := rpcCall(t, mcp, "session_create", map[string]interface{}{"prompt": "fix the flaky test"})
	if r.Error == nil || r.Error.Code != errorCodeOrchestrationOff || r.Error.Retry != retryDoNot {
		t.Fatalf("receipt = %+v error %+v", r, r.Error)
	}
	if !reflect.DeepEqual(r.Notes, []string{orchestrationOffNote}) {
		t.Errorf("notes = %q, want %q", r.Notes, orchestrationOffNote)
	}
	if len(cs.writes()) != 0 {
		t.Errorf("a refused session tool sent %+v", cs.writes())
	}
	for _, phrase := range []string{"orbit session", "task_start", "task_list", "Settings -> Session orchestration", "never claim a delegation"} {
		if !strings.Contains(orchestrationOffNote, phrase) {
			t.Errorf("the orchestration-off note does not say %q", phrase)
		}
	}
}

// A receipt whose answer is a task, a session, a project or a task list carries the link a reply names it by, and
// a batch carries one per item. An answer that is not that object (a comment on a task) carries none.
func TestReceiptCarriesAReadyMadeLink(t *testing.T) {
	_, srv := newContractServer(t, `{"status":"ALLOWED"}`, func(r *http.Request, body map[string]interface{}) (int, string) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/comments"):
			return 200, `{"id":"c1","body":"done"}`
		case strings.HasSuffix(r.URL.Path, "/execute") || strings.HasSuffix(r.URL.Path, "/start"):
			return 200, `{"ok":true,"sessionId":"s7"}`
		}
		return entityAnswer(r, body)
	})
	mcp := contractMCP(srv.URL)
	for _, tc := range []struct {
		tool string
		args map[string]interface{}
		link string
	}{
		{"task_create", map[string]interface{}{"title": "a", "completionCriterion": "EVIDENCE_JUDGMENT"}, "orbit-task:t1"},
		{"task_get", map[string]interface{}{"taskId": "t1"}, "orbit-task:t1"},
		{"project_create", map[string]interface{}{"title": "P"}, "orbit-project:p1"},
		{"tasklist_create", map[string]interface{}{"title": "Release"}, "orbit-list:l1"},
		{"task_start", map[string]interface{}{"taskId": "t1"}, "orbit-session:s7"},
		{"task_comment", map[string]interface{}{"taskId": "t1", "body": "done"}, ""},
	} {
		_, r := rpcCall(t, mcp, tc.tool, tc.args)
		if r.Link != tc.link {
			t.Errorf("%s: link = %q, want %q (receipt %+v)", tc.tool, r.Link, tc.link, r)
		}
	}
	_, batch := rpcCall(t, mcp, "task_create_batch", map[string]interface{}{"tasks": []interface{}{
		map[string]interface{}{"title": "a", "completionCriterion": "EVIDENCE_JUDGMENT"},
		map[string]interface{}{"title": "b", "completionCriterion": "EVIDENCE_JUDGMENT"},
	}})
	if len(batch.Items) != 2 || batch.Items[0].Link != "orbit-task:t1" || batch.Items[1].Link != "orbit-task:t2" || batch.Link != "" {
		t.Errorf("batch: link %q items %+v", batch.Link, batch.Items)
	}
}
