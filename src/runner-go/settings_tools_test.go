package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
)

// settingsFakeServer answers the two settings routes as the apiserver does, records what it was sent, and answers a
// proposal with the refusal the test names (or files it).
type settingsFakeServer struct {
	method, path, session string
	body                  map[string]interface{}
	refuse                struct {
		status int
		body   string
	}
}

func newSettingsFakeServer(t *testing.T) (*settingsFakeServer, *httptest.Server) {
	t.Helper()
	fake := &settingsFakeServer{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fake.method, fake.path, fake.session = r.Method, r.URL.Path, r.Header.Get("X-Orbit-Session-Id")
		fake.body = nil
		_ = json.NewDecoder(r.Body).Decode(&fake.body)
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/runner/settings":
			_, _ = w.Write([]byte(`{"settings":[{"key":"translationEnabled","tier":1,"value":false,"title":"Translate replies","path":"/settings/general","link":"orbit-settings:translationEnabled"},{"key":"enableOrchestration","tier":3,"value":true,"title":"Let sessions orchestrate","path":"/settings/general","link":"orbit-settings:enableOrchestration"}]}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/runner/settings-proposals":
			if fake.refuse.status != 0 {
				w.WriteHeader(fake.refuse.status)
				_, _ = w.Write([]byte(fake.refuse.body))
				return
			}
			_, _ = w.Write([]byte(`{"id":"req-1","kind":"SETTINGS_CHANGE","state":"PENDING","title":"Change 1 setting?","why":"You asked.","created":true,"withdrawnRequestIds":[]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return fake, srv
}

func settingsReceipt(t *testing.T, res map[string]interface{}) toolReceipt {
	t.Helper()
	r, ok := res["structuredContent"].(toolReceipt)
	if !ok {
		t.Fatalf("the answer carries no receipt: %#v", res)
	}
	return r
}

// Both tools are in the catalogue as §7 declares them: settings_get a read, settings_propose a write that only puts a
// card in front of the owner, both ungated and both SessionOnly on the CLI.
func TestSettingsToolsAreCatalogued(t *testing.T) {
	built := operationCatalog()
	get, propose := built.ByTool["settings_get"], built.ByTool["settings_propose"]
	if get == nil || propose == nil {
		t.Fatalf("settings_get = %v, settings_propose = %v: both must be catalogued", get, propose)
	}
	if get.Mutates || get.Gate != gateAlways || get.Object != objectAccount || get.Idempotency != idempotencyRead || get.Plan != planRuns {
		t.Errorf("settings_get = mutates %v, gate %v, object %v, idempotency %v, plan %v; want a read, always listed", get.Mutates, get.Gate, get.Object, get.Idempotency, get.Plan)
	}
	if !propose.Mutates || propose.Gate != gateAlways || propose.Object != objectAccount || propose.Approval != approvalKindOwner || propose.Plan != planRuns {
		t.Errorf("settings_propose = mutates %v, gate %v, object %v, approval %v, plan %v; want a write to the owner, always listed, run in Plan", propose.Mutates, propose.Gate, propose.Object, propose.Approval, propose.Plan)
	}
	for _, op := range []*operation{get, propose} {
		if op.CLI == nil || !op.CLI.SessionOnly || op.CLI.RequiresOrchestration {
			t.Errorf("%s CLI = %+v, want SessionOnly and ungated", op.Tool, op.CLI)
		}
	}
	if got := strings.Join(get.CLI.Argv, " "); got != "orbit settings get" {
		t.Errorf("settings_get argv = %q", got)
	}
	if got := strings.Join(propose.CLI.Argv, " "); got != "orbit settings propose" || !propose.CLI.Mutates {
		t.Errorf("settings_propose argv = %q, mutates %v", got, propose.CLI.Mutates)
	}
	if required := propose.MCP.InputSchema["required"]; !reflect.DeepEqual(required, []string{"changes", "why"}) {
		t.Errorf("settings_propose requires %v, want changes and why", required)
	}
	desc := propose.MCP.Description
	for _, want := range []string{
		"Tiers", "1 personal", "2 defaults for new work", "applies to new sessions only", "3 agent reach",
		"SETTING_OWNER_ONLY", "SETTINGS_ALREADY_SET", "SETTINGS_CHANGE_DECLINED",
		"A declined card is a refusal: do not file it again", "orbit-settings:", "does NOT block", "as request_owner_action does",
	} {
		if !strings.Contains(desc, want) {
			t.Errorf("settings_propose's description does not say %q:\n%s", want, desc)
		}
	}
	for _, key := range settingsTierThreeKeys {
		if !strings.Contains(desc, key) {
			t.Errorf("settings_propose's description does not name tier-3 key %s", key)
		}
	}
	for _, want := range []string{"tier", "Tier 1 is personal", "tier 2 is defaults for new work", "tier 3 is agent reach", "Reads only"} {
		if !strings.Contains(get.MCP.Description, want) {
			t.Errorf("settings_get's description does not say %q", want)
		}
	}
}

// The tier-3 keys the description names are the shared table's, so the description cannot drift from what the server
// refuses.
func TestSettingsTierThreeKeysAreTheSharedTable(t *testing.T) {
	source, err := os.ReadFile(filepath.Join("..", "shared", "src", "settingsTiers.ts"))
	if err != nil {
		t.Fatal(err)
	}
	line := regexp.MustCompile(`(?m)^\s*3: \[([^\]]*)\]`).FindSubmatch(source)
	if line == nil {
		t.Fatal("settingsTiers.ts has no `3: [...]` line")
	}
	var keys []string
	for _, quoted := range regexp.MustCompile(`'([A-Za-z]+)'`).FindAllSubmatch(line[1], -1) {
		keys = append(keys, string(quoted[1]))
	}
	if !reflect.DeepEqual(keys, settingsTierThreeKeys) {
		t.Errorf("tier 3 is %v in the shared table, %v in settings_propose's description", keys, settingsTierThreeKeys)
	}
}

// Both tools are listed whether or not Session orchestration is on: turning orchestration off is itself a proposal.
func TestSettingsToolsAreListedWithOrchestrationOnAndOff(t *testing.T) {
	for _, orchestration := range []bool{true, false} {
		names := map[string]bool{}
		for _, d := range toolDescriptors(false, orchestration) {
			names[d["name"].(string)] = true
		}
		if !names["settings_get"] || !names["settings_propose"] {
			t.Errorf("orchestration %v: tools/list has settings_get %v, settings_propose %v", orchestration, names["settings_get"], names["settings_propose"])
		}
		if names["session_create"] != orchestration {
			t.Fatalf("orchestration %v: session_create listed %v, so the switch was not applied", orchestration, names["session_create"])
		}
	}
	// And the CLI: inside a session, with the switch on and off, both commands are offered and runnable; a terminal
	// outside a session is offered neither.
	for _, tc := range []struct {
		session, orchestration string
		want                   bool
	}{{"session-1", "true", true}, {"session-1", "", true}, {"", "true", false}} {
		configureCLITestRunner(t, "http://127.0.0.1:1")
		t.Setenv("ORBIT_SESSION_ID", tc.session)
		t.Setenv(envMCPOrchestration, tc.orchestration)
		t.Setenv(envOrchestrationToken, "")
		doc := buildCLICapabilities("/usr/local/bin/orbit")
		for _, id := range []string{"settings_get", "settings_propose"} {
			var found *cliCapability
			for i := range doc.Capabilities {
				if doc.Capabilities[i].ID == id {
					found = &doc.Capabilities[i]
				}
			}
			if (found != nil) != tc.want || (found != nil && !found.Available) {
				t.Errorf("session %q orchestration %q: %s offered = %v (%+v), want %v", tc.session, tc.orchestration, id, found != nil, found, tc.want)
			}
		}
	}
}

func TestMCPSettingsGetReadsTheSessionOwnersSettings(t *testing.T) {
	fake, srv := newSettingsFakeServer(t)
	for _, orchestration := range []bool{true, false} {
		mcp := &mcpServer{t: NewTransport(srv.URL, "runner-token"), sessionID: "caller-session", allowOrchestration: orchestration}
		res := mcp.invokeTool("settings_get", map[string]interface{}{})
		if res["isError"] == true {
			t.Fatalf("orchestration %v: settings_get failed: %#v", orchestration, res["content"])
		}
		if fake.method != http.MethodGet || fake.path != "/api/runner/settings" || fake.session != "caller-session" {
			t.Fatalf("settings_get sent %s %s as session %q", fake.method, fake.path, fake.session)
		}
		r := settingsReceipt(t, res)
		if !r.OK || r.Outcome != outcomeRead || r.Operation != "settings_get" {
			t.Errorf("settings_get receipt = ok %v outcome %q operation %q", r.OK, r.Outcome, r.Operation)
		}
		if !strings.Contains(string(r.Entity), `"link":"orbit-settings:enableOrchestration"`) || !strings.Contains(string(r.Entity), `"tier":3`) {
			t.Errorf("settings_get entity = %s", r.Entity)
		}
	}
}

// A proposal sends the changes and why as given and returns at once with the owner request's receipt: written,
// its id, PENDING, and the owner's answer pending.
func TestMCPSettingsProposeReturnsTheRequestsReceipt(t *testing.T) {
	fake, srv := newSettingsFakeServer(t)
	for _, orchestration := range []bool{true, false} {
		mcp := &mcpServer{t: NewTransport(srv.URL, "runner-token"), sessionID: "caller-session", allowOrchestration: orchestration}
		changes := map[string]interface{}{"translationEnabled": true, "translationLanguage": "zh-Hans", "subagentBlockedProviders": []interface{}{"codex"}}
		res := mcp.invokeTool("settings_propose", map[string]interface{}{"changes": changes, "why": " You asked to read replies in Chinese. "})
		if res["isError"] == true {
			t.Fatalf("orchestration %v: settings_propose failed: %#v", orchestration, res["content"])
		}
		if fake.method != http.MethodPost || fake.path != "/api/runner/settings-proposals" || fake.session != "caller-session" {
			t.Fatalf("settings_propose sent %s %s as session %q", fake.method, fake.path, fake.session)
		}
		if want := map[string]interface{}{"changes": changes, "why": "You asked to read replies in Chinese."}; !reflect.DeepEqual(fake.body, want) {
			t.Errorf("settings_propose body = %#v, want %#v", fake.body, want)
		}
		r := settingsReceipt(t, res)
		if !r.OK || r.Outcome != outcomeWritten || r.ID == nil || *r.ID != "req-1" || r.Status == nil || *r.Status != "PENDING" {
			t.Errorf("settings_propose receipt = ok %v outcome %q id %v status %v", r.OK, r.Outcome, r.ID, r.Status)
		}
		if r.Action != "propose" || r.EntityType != string(objectAccount) {
			t.Errorf("settings_propose receipt action %q entityType %q, want propose on the account", r.Action, r.EntityType)
		}
		if !r.Approval.Required || r.Approval.Outcome != approvalOutcomePending {
			t.Errorf("settings_propose approval = %+v, want the owner's answer pending", r.Approval)
		}
	}
}

// Every refusal the route answers reaches the agent as the receipt's error code, with the server's message, and
// nothing is retried.
func TestMCPSettingsProposePassesEachRefusalThrough(t *testing.T) {
	fake, srv := newSettingsFakeServer(t)
	mcp := &mcpServer{t: NewTransport(srv.URL, "runner-token"), sessionID: "caller-session"}
	for _, tc := range []struct {
		status    int
		code      string
		body      string
		retry     string
		inMessage string
	}{
		{http.StatusForbidden, "SETTING_OWNER_ONLY", `{"code":"SETTING_OWNER_ONLY","message":"\"Let sessions orchestrate\" gives agents more reach; only you can turn it on, in Settings.","settings":[{"key":"enableOrchestration","title":"Let sessions orchestrate","path":"/settings/general","link":"orbit-settings:enableOrchestration"}]}`, retryDoNot, "orbit-settings:enableOrchestration"},
		{http.StatusConflict, "SETTINGS_ALREADY_SET", `{"code":"SETTINGS_ALREADY_SET","message":"Every setting proposed already has that value; nothing was filed."}`, retryRereadFirst, "already has that value"},
		{http.StatusConflict, "SETTINGS_CHANGE_DECLINED", `{"code":"SETTINGS_CHANGE_DECLINED","message":"The owner declined this change on 2026-11-19; ask the person instead of filing it again.","requestId":"req-0","declinedAt":"2026-11-19T10:00:00.000Z","reason":"not now"}`, retryRereadFirst, "ask the person instead"},
	} {
		fake.refuse.status, fake.refuse.body = tc.status, tc.body
		res := mcp.invokeTool("settings_propose", map[string]interface{}{"changes": map[string]interface{}{"enableOrchestration": true}, "why": "asked"})
		if res["isError"] != true {
			t.Fatalf("%s: settings_propose did not fail: %#v", tc.code, res)
		}
		r := settingsReceipt(t, res)
		if r.OK || r.Outcome != outcomeRefused || r.Error == nil || r.Error.Code != tc.code || r.Error.HTTPStatus != tc.status || r.Error.Retry != tc.retry {
			t.Errorf("%s: receipt = ok %v outcome %q error %+v", tc.code, r.OK, r.Outcome, r.Error)
			continue
		}
		if !strings.Contains(r.Error.Message, tc.inMessage) {
			t.Errorf("%s: the message %q does not carry %q", tc.code, r.Error.Message, tc.inMessage)
		}
	}
}

// Refused before anything is sent: no session to act for, no changes, no reason.
func TestMCPSettingsToolsRefuseWhatTheyCannotSend(t *testing.T) {
	fake, srv := newSettingsFakeServer(t)
	for _, tc := range []struct {
		session, tool string
		args          map[string]interface{}
		want          string
	}{
		{"", "settings_get", map[string]interface{}{}, "no Orbit session here"},
		{"", "settings_propose", map[string]interface{}{"changes": map[string]interface{}{"theme": "dark"}, "why": "asked"}, "no Orbit session here"},
		{"s", "settings_propose", map[string]interface{}{"changes": map[string]interface{}{}, "why": "asked"}, "changes is required"},
		{"s", "settings_propose", map[string]interface{}{"changes": map[string]interface{}{"theme": "dark"}, "why": "  "}, "why is required"},
	} {
		fake.path = ""
		mcp := &mcpServer{t: NewTransport(srv.URL, "runner-token"), sessionID: tc.session}
		res := mcp.invokeTool(tc.tool, tc.args)
		if res["isError"] != true || !strings.Contains(mcpResultText(res), tc.want) || fake.path != "" {
			t.Errorf("%s %v: isError %v, text %q, request %q; want %q and nothing sent", tc.tool, tc.args, res["isError"], mcpResultText(res), fake.path, tc.want)
		}
	}
}

// The orchestration-off refusal links the Settings row instead of only describing where it is (design §6).
func TestOrchestrationOffMessageLinksTheSettingsRow(t *testing.T) {
	if !strings.Contains(orchestrationOffMsg, "[Let sessions orchestrate](orbit-settings:enableOrchestration)") {
		t.Errorf("orchestrationOffMsg = %q, want the orbit-settings:enableOrchestration link", orchestrationOffMsg)
	}
}

func TestSettingsCLISendsWhatTheToolSends(t *testing.T) {
	fake, srv := newSettingsFakeServer(t)
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_SESSION_ID", "cli-session")

	var out bytes.Buffer
	if err := cmdSettingsCLI([]string{"get", "--json"}, &out); err != nil {
		t.Fatal(err)
	}
	if fake.method != http.MethodGet || fake.path != "/api/runner/settings" || fake.session != "cli-session" || !strings.Contains(out.String(), "orbit-settings:translationEnabled") {
		t.Errorf("settings get sent %s %s as %q and printed %s", fake.method, fake.path, fake.session, out.String())
	}

	out.Reset()
	err := cmdSettingsCLI([]string{"propose", "--set", "translationEnabled=true", "--set", "translationLanguage=zh-Hans",
		"--set", `subagentBlockedProviders=["codex","kimi"]`, "--set", "cardFreeTaskCreates=3", "--why", "You asked.", "--json"}, &out)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]interface{}{
		"changes": map[string]interface{}{
			"translationEnabled": true, "translationLanguage": "zh-Hans",
			"subagentBlockedProviders": []interface{}{"codex", "kimi"}, "cardFreeTaskCreates": float64(3),
		},
		"why": "You asked.",
	}
	if fake.method != http.MethodPost || fake.path != "/api/runner/settings-proposals" || fake.session != "cli-session" || !reflect.DeepEqual(fake.body, want) {
		t.Errorf("settings propose sent %s %s as %q with %#v", fake.method, fake.path, fake.session, fake.body)
	}
	if !strings.Contains(out.String(), `"state":"PENDING"`) {
		t.Errorf("settings propose printed %s", out.String())
	}

	// A refusal is the command's error, with the server's code.
	fake.refuse.status, fake.refuse.body = http.StatusConflict, `{"code":"SETTINGS_ALREADY_SET","message":"Every setting proposed already has that value; nothing was filed."}`
	if err := cmdSettingsCLI([]string{"propose", "--set", "theme=dark", "--why", "x"}, &out); err == nil || !strings.Contains(err.Error(), "SETTINGS_ALREADY_SET") {
		t.Errorf("a refused proposal answered %v", err)
	}
}

func TestSettingsCLIRefusesAMalformedProposal(t *testing.T) {
	configureCLITestRunner(t, "http://127.0.0.1:1")
	t.Setenv("ORBIT_SESSION_ID", "cli-session")
	for _, tc := range []struct {
		args []string
		want string
	}{
		{[]string{"propose", "--why", "x"}, "--set KEY=VALUE is required"},
		{[]string{"propose", "--set", "theme=dark"}, "--why is required"},
		{[]string{"propose", "--set", "theme", "--why", "x"}, "--set takes KEY=VALUE"},
		{[]string{"propose", "--set", "theme=dark", "--set", "theme=light", "--why", "x"}, "names theme twice"},
		{[]string{"get", "extra"}, "unexpected"},
		{[]string{"nope"}, `unknown command "nope"`},
	} {
		var out bytes.Buffer
		err := cmdSettingsCLI(tc.args, &out)
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%v: error = %v, want %q", tc.args, err, tc.want)
		}
	}
	t.Setenv("ORBIT_SESSION_ID", "")
	var out bytes.Buffer
	if err := cmdSettingsCLI([]string{"get"}, &out); err == nil || !strings.Contains(err.Error(), "no Orbit session here") {
		t.Errorf("settings get outside a session answered %v", err)
	}
}
