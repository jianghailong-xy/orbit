package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestProviderListReadsTheRunnerRouteWithoutOrchestration(t *testing.T) {
	var method, path, sessionHeader string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method, path = r.Method, r.URL.Path
		sessionHeader = r.Header.Get("X-Orbit-Session-Id")
		_, _ = w.Write([]byte(`[{"slug":"claude","builtin":true},{"slug":"deepseek","builtin":false}]`))
	}))
	defer srv.Close()

	configureCLITestRunner(t, srv.URL)
	// Orchestration off and no calling session: the state a plain agent (or a cron job) is in.
	// The list still has to answer, because --provider works there too.
	t.Setenv(envMCPOrchestration, "")
	t.Setenv("ORBIT_SESSION_ID", "")

	var out bytes.Buffer
	if err := cmdProviderCLI([]string{"list", "--json"}, strings.NewReader(""), &out); err != nil {
		t.Fatalf("provider list: %v", err)
	}
	if method != http.MethodGet || path != "/api/runner/providers" {
		t.Fatalf("provider list hit %s %s", method, path)
	}
	if sessionHeader != "" {
		t.Fatalf("provider list sent an orchestration session header: %q", sessionHeader)
	}
	if out.String() != "[{\"slug\":\"claude\",\"builtin\":true},{\"slug\":\"deepseek\",\"builtin\":false}]\n" {
		t.Fatalf("provider list output = %q", out.String())
	}
}

func TestProviderCLIHelpAndUnknownCommand(t *testing.T) {
	var out bytes.Buffer
	if err := cmdProviderCLI([]string{"list", "--help"}, strings.NewReader(""), &out); err != nil {
		t.Fatalf("provider list --help: %v", err)
	}
	// The refusal string an agent will actually hit is the point of the help text.
	if !strings.Contains(out.String(), "provider not available") {
		t.Fatalf("provider list --help = %q", out.String())
	}

	out.Reset()
	if err := cmdProviderCLI([]string{"nope"}, strings.NewReader(""), &out); err == nil {
		t.Fatal("unknown provider command was accepted")
	}
}

// providerWriteServer answers the approval poll with `decision` and a write with `{"slug":"local-vllm"}`,
// recording every request in order, the card it was asked with, and the body of each write.
func providerWriteServer(t *testing.T, decision string) (*httptest.Server, *[]string, map[string]interface{}, *[]map[string]interface{}) {
	t.Helper()
	var hits []string
	var writes []map[string]interface{}
	filed := map[string]interface{}{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits = append(hits, r.Method+" "+r.URL.Path)
		switch {
		case strings.Contains(r.URL.Path, "/approvals/"):
			_, _ = w.Write([]byte(decision))
		case strings.HasSuffix(r.URL.Path, "/approvals"):
			_ = json.NewDecoder(r.Body).Decode(&filed)
			_, _ = w.Write([]byte(`{"id":"ap1","status":"PENDING"}`))
		default:
			body := map[string]interface{}{}
			raw, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(raw, &body)
			writes = append(writes, body)
			_, _ = w.Write([]byte(`{"slug":"local-vllm","hasApiKey":true}`))
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &hits, filed, &writes
}

const vllmModels = `[{"value":"qwen3.8-27b-fp8","label":"Qwen3.8 27B FP8","contextWindow":131072,"reasoningLevels":["low","medium","xhigh"]}]`

// The card is stored, pushed to every client of the account and drawn as it stands — so a provider's
// key goes to the write and nowhere near the card, which says only that one is being set.
func TestMCPProviderCreateAsksBeforeWritingWithTheKeyOffTheCard(t *testing.T) {
	srv, hits, filed, writes := providerWriteServer(t, `{"status":"ALLOWED"}`)
	mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}
	var models []interface{}
	_ = json.Unmarshal([]byte(vllmModels), &models)

	res := mcp.callTool("provider_create", map[string]interface{}{
		"label": "Local vLLM", "runtime": "claude", "baseUrl": "http://127.0.0.1:8000",
		"apiKey": "sk-do-not-show", "models": models,
	})

	if res["isError"] == true {
		t.Fatalf("provider_create returned an error: %#v", res["content"])
	}
	if len(*hits) < 3 ||
		(*hits)[0] != "POST /api/runner/sessions/sess-1/approvals" ||
		(*hits)[len(*hits)-1] != "POST /api/runner/providers" {
		t.Fatalf("call order = %v", *hits)
	}
	if filed["toolName"] != providerCreateApprovalToolName {
		t.Fatalf("filed as %v", filed["toolName"])
	}
	card, _ := json.Marshal(filed["input"])
	if strings.Contains(string(card), "sk-do-not-show") {
		t.Fatalf("the key reached the card: %s", card)
	}
	input, _ := filed["input"].(map[string]interface{})
	if input["baseUrl"] != "http://127.0.0.1:8000" || input["label"] != "Local vLLM" || input["apiKey"] != "(set — not shown)" {
		t.Fatalf("card input = %s", card)
	}
	if len(*writes) != 1 || (*writes)[0]["apiKey"] != "sk-do-not-show" || (*writes)[0]["baseUrl"] != "http://127.0.0.1:8000" {
		t.Fatalf("write bodies = %#v", *writes)
	}
}

func TestMCPProviderWritesWriteNothingWithoutAYes(t *testing.T) {
	for _, tc := range []struct {
		tool     string
		args     map[string]interface{}
		toolName string
	}{
		{"provider_create", map[string]interface{}{"label": "L", "baseUrl": "http://127.0.0.1:8000", "apiKey": "k", "models": []interface{}{map[string]interface{}{"value": "m"}}}, providerCreateApprovalToolName},
		{"provider_update", map[string]interface{}{"slug": "local-vllm", "baseUrl": "http://127.0.0.1:8001"}, providerUpdateApprovalToolName},
		{"provider_delete", map[string]interface{}{"slug": "local-vllm"}, providerDeleteApprovalToolName},
	} {
		t.Run(tc.tool, func(t *testing.T) {
			srv, hits, filed, _ := providerWriteServer(t, `{"status":"DENIED","message":"不要这个"}`)
			mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}

			res := mcp.callTool(tc.tool, tc.args)

			if wroteAnything(*hits) {
				t.Fatalf("wrote without a yes: %v", *hits)
			}
			if filed["toolName"] != tc.toolName {
				t.Fatalf("filed as %v", filed["toolName"])
			}
			if res["isError"] == true || !strings.Contains(fmt.Sprintf("%v", res["content"]), "不要这个") {
				t.Fatalf("a refusal is an answer carrying its reason: %#v", res["content"])
			}
		})
	}
}

// Headless — the owner at their own terminal — there is nobody else to ask, and the key can come from
// stdin rather than argv, where it would sit in the shell's history.
func TestCLIProviderCreateHeadlessReadsTheKeyFromStdin(t *testing.T) {
	srv, hits, _, writes := providerWriteServer(t, `{"status":"DENIED"}`)
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_SESSION_ID", "")
	t.Setenv(envBgJobID, "")

	var out bytes.Buffer
	err := cmdProviderCLI([]string{
		"create", "--label", "Local vLLM", "--runtime", "claude", "--base-url", "http://127.0.0.1:8000",
		"--api-key-file", "-", "--models", vllmModels, "--json",
	}, strings.NewReader("vllm-token\n"), &out)
	if err != nil {
		t.Fatalf("provider create: %v", err)
	}
	if len(*hits) != 1 || (*hits)[0] != "POST /api/runner/providers" {
		t.Fatalf("hits = %v, want the write alone", *hits)
	}
	w := (*writes)[0]
	if w["label"] != "Local vLLM" || w["runtime"] != "claude" || w["baseUrl"] != "http://127.0.0.1:8000" || w["apiKey"] != "vllm-token" {
		t.Fatalf("write body = %#v", w)
	}
	models, _ := w["models"].([]interface{})
	model, _ := models[0].(map[string]interface{})
	if len(models) != 1 || model["value"] != "qwen3.8-27b-fp8" || model["contextWindow"] != float64(131072) {
		t.Fatalf("models = %#v", w["models"])
	}
	if levels, _ := model["reasoningLevels"].([]interface{}); len(levels) != 3 {
		t.Fatalf("reasoningLevels = %#v", model["reasoningLevels"])
	}
	if out.String() != "{\"slug\":\"local-vllm\",\"hasApiKey\":true}\n" {
		t.Fatalf("output = %q", out.String())
	}
}

func TestCLIProviderWritesInsideASessionAskFirst(t *testing.T) {
	for _, tc := range []struct {
		name     string
		argv     []string
		toolName string
		write    string
		body     map[string]interface{}
	}{
		{"create", []string{"create", "--label", "Local vLLM", "--base-url", "http://127.0.0.1:8000", "--api-key", "sk-do-not-show", "--models", vllmModels, "--json"},
			providerCreateApprovalToolName, "POST /api/runner/providers", nil},
		{"update", []string{"update", "local-vllm", "--base-url", "http://127.0.0.1:8001", "--json"},
			providerUpdateApprovalToolName, "PATCH /api/runner/providers/local-vllm", map[string]interface{}{"baseUrl": "http://127.0.0.1:8001"}},
		{"delete", []string{"delete", "local-vllm", "--json"},
			providerDeleteApprovalToolName, "DELETE /api/runner/providers/local-vllm", map[string]interface{}{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv, hits, filed, writes := providerWriteServer(t, `{"status":"ALLOWED"}`)
			configureCLITestRunner(t, srv.URL)
			t.Setenv("ORBIT_SESSION_ID", "sess-1")
			t.Setenv(envBgJobID, "")

			var out bytes.Buffer
			if err := cmdProviderCLI(tc.argv, strings.NewReader(""), &out); err != nil {
				t.Fatal(err)
			}
			if filed["toolName"] != tc.toolName {
				t.Fatalf("filed as %v; hits = %v", filed["toolName"], *hits)
			}
			if last := (*hits)[len(*hits)-1]; last != tc.write {
				t.Fatalf("last hit = %q, want the write after the card; hits = %v", last, *hits)
			}
			if card, _ := json.Marshal(filed["input"]); strings.Contains(string(card), "sk-do-not-show") {
				t.Fatalf("the key reached the card: %s", card)
			}
			if tc.body != nil {
				if got, _ := json.Marshal((*writes)[0]); string(got) != mustJSON(t, tc.body) {
					t.Fatalf("write body = %s", got)
				}
			}
		})
	}
}

func TestCLIProviderWritesRefuseWhatTheServerCouldNotUse(t *testing.T) {
	srv, hits, _, _ := providerWriteServer(t, `{"status":"ALLOWED"}`)
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_SESSION_ID", "")

	for _, tc := range []struct {
		argv []string
		want string
	}{
		{[]string{"create", "--label", "L", "--base-url", "http://127.0.0.1:8000", "--api-key", "k"}, "--models is required"},
		{[]string{"create", "--label", "L", "--base-url", "http://127.0.0.1:8000", "--models", vllmModels}, "--api-key or --api-key-file is required"},
		{[]string{"create", "--label", "L", "--base-url", "http://127.0.0.1:8000", "--api-key", "k", "--models", `{"value":"m"}`}, "--models must be a non-empty JSON array"},
		{[]string{"create", "--label", "L", "--base-url", "", "--api-key", "k", "--models", vllmModels}, "--base-url cannot be empty"},
		{[]string{"create", "--label", "L", "--base-url", "http://x", "--api-key", "k", "--api-key-file", "-", "--models", vllmModels}, "cannot be used together"},
		{[]string{"update", "local-vllm"}, "no fields to update"},
		{[]string{"update", "--label", "x"}, "provider slug is required"},
		{[]string{"delete"}, "provider slug is required"},
	} {
		var out bytes.Buffer
		err := cmdProviderCLI(tc.argv, strings.NewReader(""), &out)
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%v: err = %v, want %q", tc.argv, err, tc.want)
		}
	}
	if len(*hits) != 0 {
		t.Fatalf("a refused command reached the server: %v", *hits)
	}
}

func mustJSON(t *testing.T, v interface{}) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// Defining per-action help is not enough: main answers `orbit <cmd> --help` itself with the
// family overview unless the family is named as owning its leaf help, and a family that forgets
// to say so compiles, tests green through its own handler, and ships help nobody can print. Both
// `provider` (0.1.122) and `agent` did exactly that.
func TestEveryFamilyWithPerActionHelpOwnsItsLeafHelp(t *testing.T) {
	for family, actions := range map[string]map[string]string{
		"provider": providerActionHelp,
		"agent":    agentActionHelp,
		"project":  projectActionHelp,
	} {
		if len(actions) == 0 {
			t.Fatalf("%s has no per-action help to route", family)
		}
		if !ownsLeafHelp(family) {
			t.Errorf("%s defines per-action help but main answers its --help with the family overview", family)
		}
	}
}

// usableProvidersWithEngines is GET /runner/providers as the T3 control plane answers it: each entry
// with the engines it runs, the default first (docs/provider-engine-contract.md §6.3).
const usableProvidersWithEngines = `[{"slug":"claude","runtime":"claude","engines":["claude"],"builtin":true},` +
	`{"slug":"dsh","runtime":"dsh","engines":["dsh"],"builtin":true},` +
	`{"slug":"deepseek-2","label":"DeepSeek 2","runtime":"claude","models":[{"value":"deepseek-v4","label":"DeepSeek V4"}],"defaultModel":"deepseek-v4","engines":["claude","opencode","dsh"],"builtin":false},` +
	`{"slug":"team-codex","label":"Team Codex","runtime":"codex","engines":["codex"],"builtin":false}]`

// T5: `orbit provider list` and provider_list hand the server's list on as it came, so every entry's
// `engines` reaches the reader — in both the CLI's output forms and the tool's answer.
func TestProviderCLIListPrintsTheEnginesEachProviderRuns(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/runner/providers" {
			t.Errorf("request = %s %s", r.Method, r.URL.Path)
		}
		_, _ = w.Write([]byte(usableProvidersWithEngines))
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_SESSION_ID", "")

	var served []map[string]interface{}
	if err := json.Unmarshal([]byte(usableProvidersWithEngines), &served); err != nil {
		t.Fatal(err)
	}
	engines := func(t *testing.T, output string) {
		t.Helper()
		var listed []map[string]interface{}
		if err := json.Unmarshal([]byte(output), &listed); err != nil {
			t.Fatalf("output is not the server's JSON list: %v\n%s", err, output)
		}
		if !reflect.DeepEqual(listed, served) {
			t.Fatalf("listed = %#v\nwant the server's list as it came: %#v", listed, served)
		}
		key := listed[2]
		if !reflect.DeepEqual(key["engines"], []interface{}{"claude", "opencode", "dsh"}) {
			t.Fatalf("the DeepSeek key's engines = %#v", key["engines"])
		}
	}
	for _, args := range [][]string{{"list", "--json"}, {"list"}} {
		var out bytes.Buffer
		if err := cmdProviderCLI(args, strings.NewReader(""), &out); err != nil {
			t.Fatalf("orbit provider %v: %v", args, err)
		}
		engines(t, out.String())
	}
	mcp := &mcpServer{t: NewTransport(srv.URL, "runner-token")}
	res := mcp.callTool("provider_list", map[string]interface{}{})
	if res["isError"] == true {
		t.Fatalf("provider_list returned an error: %#v", res["content"])
	}
	engines(t, resultText(res))
}

// The provider help says what a provider is now: a credential whose `--runtime` is the protocol its
// endpoint speaks (the flag keeps its name), listed with the engines it runs, and whose deletion
// moves nothing onto the runner's Claude sign-in.
func TestProviderCLIHelpSpeaksOfProtocolsAndEngines(t *testing.T) {
	help := func(action string) string {
		var out bytes.Buffer
		if err := cmdProviderCLI([]string{action, "--help"}, strings.NewReader(""), &out); err != nil {
			t.Fatalf("provider %s --help: %v", action, err)
		}
		return out.String()
	}
	list := help("list")
	for _, want := range []string{`"engines"`, "credential", "Claude Code", "Codex", "Kimi Code", "Antigravity CLI", "OpenCode", "DeepSeek Harness", "provider not available"} {
		if !strings.Contains(list, want) {
			t.Fatalf("provider list --help does not say %q:\n%s", want, list)
		}
	}
	for _, action := range []string{"create", "update"} {
		text := help(action)
		if !strings.Contains(text, "--runtime PROTOCOL") || !strings.Contains(text, "antigravity") ||
			strings.Contains(text, "The coding engine that drives it") {
			t.Fatalf("provider %s --help does not describe --runtime as the protocol:\n%s", action, text)
		}
	}
	deletion := help("delete")
	if strings.Contains(deletion, "built-in claude") || !strings.Contains(deletion, "keep") ||
		!strings.Contains(deletion, "cannot start again until it is re-pinned") {
		t.Fatalf("provider delete --help:\n%s", deletion)
	}
	for _, spec := range providerCLICapabilities {
		if spec.Tool != "provider_create" && spec.Tool != "provider_update" {
			continue
		}
		if !strings.Contains(strings.Join(spec.Arguments, " "), "--runtime <claude|codex|kimi|antigravity> (the protocol") {
			t.Fatalf("%s capability arguments = %v", spec.Tool, spec.Arguments)
		}
	}
}
