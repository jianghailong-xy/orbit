package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
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
