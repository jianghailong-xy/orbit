package main

import (
	"encoding/json"
	"reflect"
	"regexp"
	"strings"
	"testing"
)

// One turn's events as the session's emit path carries them: a discovery read, an MCP write and its receipt, the
// CLI's read, the engine's private plan, and a call that is not Orbit's.
func telemetryTurnEvents(exe string) []evalEvent {
	receipt := `{"receiptVersion":1,"ok":true,"outcome":"written","operation":"task_create","id":"34AsInvented","status":"OPEN"}`
	refused := `{"receiptVersion":1,"ok":false,"outcome":"refused","operation":"task_update","error":{"code":"SESSION_IN_PLAN_MODE","retry":"wait","message":"no"}}`
	return []evalEvent{
		{Type: evToolUse, Payload: map[string]interface{}{"id": "a", "name": "mcp__orbit__guide", "input": map[string]interface{}{"topic": "task-create"}}},
		{Type: evToolResult, Payload: map[string]interface{}{"toolUseId": "a", "content": strings.Repeat("g", 120)}},
		{Type: evToolUse, Payload: map[string]interface{}{"id": "b", "name": "mcp__orbit__task_create", "input": map[string]interface{}{"title": "t"}}},
		{Type: evToolResult, Payload: map[string]interface{}{"toolUseId": "b", "content": []interface{}{map[string]interface{}{"type": "text", "text": receipt}}}},
		{Type: evToolUse, Payload: map[string]interface{}{"id": "c", "name": "Bash", "input": map[string]interface{}{"command": exe + " task list --json"}}},
		{Type: evToolResult, Payload: map[string]interface{}{"toolUseId": "c", "content": `[{"id":"x"}]`}},
		{Type: evToolUse, Payload: map[string]interface{}{"id": "d", "name": "orbit__task_update", "input": map[string]interface{}{"taskId": "x"}}},
		{Type: evToolResult, Payload: map[string]interface{}{"toolUseId": "d", "content": refused, "isError": false}},
		{Type: evToolUse, Payload: map[string]interface{}{"id": "e", "name": "update_plan", "input": map[string]interface{}{"plan": []interface{}{
			map[string]interface{}{"step": "one"}, map[string]interface{}{"step": "two"}, map[string]interface{}{"step": "three"}}}}},
		{Type: evToolUse, Payload: map[string]interface{}{"id": "f", "name": "Read", "input": map[string]interface{}{"file_path": "/etc/hosts"}}},
		{Type: evToolUse, Payload: map[string]interface{}{"id": "g", "name": "Bash", "input": map[string]interface{}{"command": "orbit task get x"}}},
	}
}

func observeTurn(obs *agentContractTelemetry, events []evalEvent) map[string]interface{} {
	for _, ev := range events {
		if got := obs.observe("turn-1", ev.Type, ev.Payload); got != nil {
			return map[string]interface{}{"early": got}
		}
	}
	return obs.observe("turn-1", evTurnEnd, map[string]interface{}{"subtype": "success"})
}

func TestAgentContractTelemetrySummarisesHowATurnUsedOrbit(t *testing.T) {
	t.Setenv(agentContractTelemetryEnv, "")
	exe := "/opt/orbit/bin/orbit"
	obs := newAgentContractTelemetry(providerClaude, exe, func() string { return "default" }, true, 4321)
	payload := observeTurn(obs, telemetryTurnEvents(exe))
	if payload == nil || payload["subtype"] != agentContractTelemetrySubtype {
		t.Fatalf("payload = %#v", payload)
	}
	raw, _ := json.Marshal(payload["agentContractTelemetry"])
	var got agentContractTurnTelemetry
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	first := 2
	want := agentContractTurnTelemetry{Version: 1, Contract: agentContractVersion, Primer: agentPrimerVersion, Catalog: operationCatalogVersion,
		Engine: providerClaude, Mode: "default", Orchestration: true, ToolCalls: 7, OrbitCalls: 5, OrbitCallsCLI: 2, OrbitWrites: 1,
		FirstOrbitSuccessStep: &first, DiscoveryCalls: 1, DiscoveryBytes: 120, InstructionBytes: 4321,
		Operations: map[string]int{"guide": 1, "task_create": 1, "task_list": 1, "task_update": 1, "task_get": 1},
		Outcomes:   map[string]int{"written": 1, "read": 2, "refused": 1},
		Failures:   map[string]int{"SESSION_IN_PLAN_MODE": 1}, PrivatePlanCalls: 1, PrivatePlanItems: 3, BareOrbitCalls: 1}
	if !reflect.DeepEqual(got, want) {
		gotJSON, _ := json.Marshal(got)
		wantJSON, _ := json.Marshal(want)
		t.Fatalf("summary\n got %s\nwant %s", gotJSON, wantJSON)
	}
	// The turn is forgotten once summarised.
	if again := obs.observe("turn-1", evTurnEnd, map[string]interface{}{}); again != nil {
		t.Errorf("a second turn_end summarised the turn again: %#v", again)
	}
}

func TestAgentContractTelemetryIsQuietForATurnThatDidNotTouchOrbit(t *testing.T) {
	t.Setenv(agentContractTelemetryEnv, "")
	obs := newAgentContractTelemetry(providerCodex, "/x/orbit", nil, false, 0)
	obs.observe("t", evToolUse, map[string]interface{}{"id": "a", "name": "Bash", "input": map[string]interface{}{"command": "ls -la"}})
	obs.observe("t", evToolResult, map[string]interface{}{"toolUseId": "a", "content": "total 0"})
	obs.observe("t", evAssistant, map[string]interface{}{"text": "done"})
	if got := obs.observe("t", evTurnEnd, map[string]interface{}{}); got != nil {
		t.Fatalf("a turn without Orbit produced %#v", got)
	}
	// A sub-agent's calls are the sub-agent's.
	obs.observe("t2", evToolUse, map[string]interface{}{"id": "s", "name": "mcp__orbit__task_get", "input": map[string]interface{}{}, "parentToolUseId": "toolu_1"})
	if got := obs.observe("t2", evTurnEnd, map[string]interface{}{}); got != nil {
		t.Fatalf("a sub-agent's call was summarised as the turn's: %#v", got)
	}
}

func TestAgentContractTelemetryOffSwitch(t *testing.T) {
	for _, off := range []string{"off", "0", "false", "OFF"} {
		t.Setenv(agentContractTelemetryEnv, off)
		obs := newAgentContractTelemetry(providerClaude, "/x/orbit", nil, false, 0)
		if obs != nil {
			t.Fatalf("%s=%s left the telemetry on", agentContractTelemetryEnv, off)
		}
		if got := obs.observe("t", evTurnEnd, map[string]interface{}{}); got != nil {
			t.Fatalf("a nil observer answered %#v", got)
		}
	}
}

// The summary holds no argument value, no answer text, no reply, no id, no path and no credential: every string in it
// is a version, the engine, a permission mode, a catalogue operation, a receipt outcome or an error code.
func TestAgentContractTelemetryCarriesNoCredentialsOrText(t *testing.T) {
	t.Setenv(agentContractTelemetryEnv, "")
	secrets := []string{"sk-ant-api03-SECRETSECRET", "Bearer eyJhbGciOiJIUzI1NiJ9.SECRET", "ghp_SECRETSECRETSECRET",
		"person@example.com", "rotate the staging API key", "/home/person/project", "34AsLeakedTaskId0000", "orbit-gw-SECRET"}
	exe := "/home/person/.orbit/bin/orbit"
	obs := newAgentContractTelemetry(providerClaude, exe, func() string { return "default" }, false, 10)
	leak := strings.Join(secrets, " ")
	events := []evalEvent{
		{Type: evUser, Payload: map[string]interface{}{"text": leak}},
		{Type: evToolUse, Payload: map[string]interface{}{"id": "a", "name": "mcp__orbit__task_create", "input": map[string]interface{}{"title": leak, "description": leak, "secret": leak}}},
		{Type: evToolResult, Payload: map[string]interface{}{"toolUseId": "a", "content": `{"receiptVersion":1,"ok":false,"outcome":"refused","error":{"code":"` + leak + `","message":"` + leak + `"}}`}},
		{Type: evToolUse, Payload: map[string]interface{}{"id": "b", "name": "Bash", "input": map[string]interface{}{"command": "ORBIT_TOKEN=" + secrets[0] + " " + exe + " task create --title '" + leak + "'"}}},
		{Type: evToolResult, Payload: map[string]interface{}{"toolUseId": "b", "content": leak, "isError": true}},
		{Type: evToolUse, Payload: map[string]interface{}{"id": "c", "name": "mcp__orbit__" + "sk-ant-api03-SECRETSECRET", "input": map[string]interface{}{}}},
		{Type: evToolUse, Payload: map[string]interface{}{"id": "d", "name": "ExitPlanMode", "input": map[string]interface{}{"plan": "1. " + leak + "\n2. " + leak}}},
		{Type: evAssistant, Payload: map[string]interface{}{"text": leak}},
	}
	payload := observeTurn(obs, events)
	raw, err := json.Marshal(payload)
	if err != nil || payload == nil {
		t.Fatalf("payload %v (%v)", payload, err)
	}
	for _, secret := range secrets {
		if strings.Contains(string(raw), secret) {
			t.Errorf("the summary carries %q: %s", secret, raw)
		}
	}
	allowed := map[string]bool{agentContractTelemetrySubtype: true, agentContractVersion: true, agentPrimerVersion: true,
		operationCatalogVersion: true, providerClaude: true, "default": true, "other": true, "OTHER": true, "UNREADABLE_ANSWER": true}
	for _, op := range operationCatalog().Ops {
		allowed[op.Tool] = true
	}
	for _, o := range receiptOutcomes {
		allowed[o] = true
	}
	code := regexp.MustCompile(`^[A-Z][A-Z0-9_]{1,63}$`)
	var walk func(v interface{})
	walk = func(v interface{}) {
		switch x := v.(type) {
		case map[string]interface{}:
			for k, child := range x {
				if !allowed[k] && !regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9_]*$`).MatchString(k) {
					t.Errorf("key %q is not a field name", k)
				}
				walk(child)
			}
		case []interface{}:
			for _, child := range x {
				walk(child)
			}
		case string:
			if !allowed[x] && !code.MatchString(x) {
				t.Errorf("string %q is not a version, engine, mode, operation, outcome or code", x)
			}
		}
	}
	var doc interface{}
	_ = json.Unmarshal(raw, &doc)
	walk(doc)
}

// A command handed to a shell is read inside: Codex reports its commands as `/bin/bash -lc '…'`.
func TestOrbitCLIInvocationReadsInsideAShell(t *testing.T) {
	exe := "/opt/orbit/bin/orbit"
	cases := []struct {
		command string
		want    string
		bare    bool
	}{
		{exe + " task create --title x", "task create --title x", false},
		{"/bin/bash -lc '" + exe + " task list --json'", "task list --json", false},
		{`bash -c "cd /tmp && ` + exe + ` project get P1 --receipt"`, "project get P1 --receipt", false},
		{"ORBIT_X=1 env " + exe + " guide --json", "guide --json", false},
		{"sh -lc 'orbit task get T1'", "task get T1", true},
		{"ls -la && " + exe + " capabilities --summary --json", "capabilities --summary --json", false},
	}
	for _, c := range cases {
		args, bare, ok := orbitCLIInvocation(c.command, exe)
		if !ok || strings.Join(args, " ") != c.want || bare != c.bare {
			t.Errorf("%q: %v bare=%v ok=%v, want %q bare=%v", c.command, args, bare, ok, c.want, c.bare)
		}
	}
	for _, none := range []string{"ls -la", "bash -lc 'git status'", "echo orbit-task:abc", "cat orbit.txt"} {
		if args, _, ok := orbitCLIInvocation(none, exe); ok {
			t.Errorf("%q read as an Orbit command: %v", none, args)
		}
	}
}

func TestAgentContractTelemetryRecordsTheInstructionManifest(t *testing.T) {
	t.Setenv(agentContractTelemetryEnv, "")
	shape := SessionShape{Role: roleTaskRun, InsideRecordedWork: true, Watches: true, Wiki: true, CLI: "/usr/local/bin/orbit"}
	m := composeManifest(shape, claudeCodeProfile)
	if m.Hash == "" || len(m.UnitIDs) == 0 || len(m.UnitIDs) != len(m.UnitHashes) {
		t.Fatalf("manifest = %#v", m)
	}
	if !reflect.DeepEqual(m, composeManifest(shape, claudeCodeProfile)) {
		t.Errorf("the manifest is not deterministic")
	}
	// A shape served fewer units has fewer ids and another hash.
	other := composeManifest(SessionShape{Role: roleSubAgent, CLI: shape.CLI}, claudeCodeProfile)
	if other.Hash == m.Hash {
		t.Errorf("two shapes share manifest hash %s", m.Hash)
	}
	// An empty CLI path leaves no system text, so no manifest.
	if none := composeManifest(SessionShape{Role: roleTaskRun}, claudeCodeProfile); none.Hash != "" || len(none.UnitIDs) != 0 {
		t.Errorf("a shape with no CLI path has manifest %#v", none)
	}

	exe := "/opt/orbit/bin/orbit"
	obs := newAgentContractTelemetry(providerClaude, exe, nil, true, 10)
	obs.manifest = m
	payload := observeTurn(obs, telemetryTurnEvents(exe))
	raw, _ := json.Marshal(payload["agentContractTelemetry"])
	var got agentContractTurnTelemetry
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if got.InstructionManifestHash != m.Hash || !reflect.DeepEqual(got.InstructionUnits, m.UnitIDs) {
		t.Errorf("telemetry recorded %q %v, want %q %v", got.InstructionManifestHash, got.InstructionUnits, m.Hash, m.UnitIDs)
	}
}
