package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A Cursor User API Key goes in through provider_create and `orbit provider create --runtime cursor` as the
// web's connect form puts one in (project P2 follow-up): under the Cursor preset, on Cursor's own API, with
// no model list — its models are Cursor CLI's own on each runner — so a label and the key are all it takes.
// provider_update and `orbit provider update` replace its key, or move a key onto its protocol. The key
// reaches the write and never the owner's confirmation card. scripts/test-cursor-key-check.mjs runs every
// test here by name.

const cursorPresetKey = "key_p2f-cli-0f3c9a7e51d24b88a6e0c4d29b17f3aa"

// cursorKeyBody is the create body a Cursor key's label and key come to.
func cursorKeyBody(label, key string) map[string]interface{} {
	return map[string]interface{}{
		"label": label, "runtime": "cursor", "apiKey": key, "presetSlug": cursorKeyPreset, "baseUrl": cursorAPIBaseURL,
	}
}

func TestMCPProviderCreatesAndUpdatesACursorKey(t *testing.T) {
	srv, hits, filed, writes := providerWriteServer(t, `{"status":"ALLOWED"}`)
	mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}

	res := mcp.callTool("provider_create", map[string]interface{}{"label": "Cursor", "runtime": "cursor", "apiKey": cursorPresetKey})
	if res["isError"] == true {
		t.Fatalf("provider_create of a Cursor key: %#v", res["content"])
	}
	if last := (*hits)[len(*hits)-1]; last != "POST /api/runner/providers" {
		t.Fatalf("hits = %v", *hits)
	}
	if got, want := mustJSON(t, (*writes)[0]), mustJSON(t, cursorKeyBody("Cursor", cursorPresetKey)); got != want {
		t.Fatalf("create body = %s, want %s", got, want)
	}
	card, _ := json.Marshal(filed["input"])
	if strings.Contains(string(card), cursorPresetKey) || !strings.Contains(string(card), cursorKeyPreset) {
		t.Fatalf("card = %s, want the Cursor preset and no key", card)
	}

	res = mcp.callTool("provider_update", map[string]interface{}{"slug": "cursor-api", "runtime": "cursor", "apiKey": cursorPresetKey + "-2"})
	if res["isError"] == true {
		t.Fatalf("provider_update of a Cursor key: %#v", res["content"])
	}
	if last := (*hits)[len(*hits)-1]; last != "PATCH /api/runner/providers/cursor-api" {
		t.Fatalf("hits = %v", *hits)
	}
	if got, want := mustJSON(t, (*writes)[1]), mustJSON(t, map[string]interface{}{"runtime": "cursor", "apiKey": cursorPresetKey + "-2"}); got != want {
		t.Fatalf("update body = %s, want %s", got, want)
	}
	card, _ = json.Marshal(filed["input"])
	if strings.Contains(string(card), cursorPresetKey) {
		t.Fatalf("the replacement key reached the card: %s", card)
	}

	// A Cursor key still needs its key; every other key still names its endpoint and its models.
	for _, c := range []struct {
		args map[string]interface{}
		want string
	}{
		{map[string]interface{}{"label": "Cursor", "runtime": "cursor"}, "apiKey is required"},
		{map[string]interface{}{"label": "Local", "runtime": "claude", "apiKey": "k", "models": []interface{}{map[string]interface{}{"value": "m"}}}, "baseUrl is required"},
		{map[string]interface{}{"label": "Local", "baseUrl": "http://127.0.0.1:8000", "apiKey": "k"}, "models is required"},
	} {
		res := mcp.callTool("provider_create", c.args)
		if res["isError"] != true || !strings.Contains(resultText(res), c.want) {
			t.Errorf("%v: %#v, want %q", c.args, res["content"], c.want)
		}
	}
	if len(*writes) != 2 {
		t.Fatalf("a refused create was written: %v", *writes)
	}
}

func TestCLIProviderCreatesAndUpdatesACursorKey(t *testing.T) {
	srv, hits, _, writes := providerWriteServer(t, `{"status":"ALLOWED"}`)
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_SESSION_ID", "")
	t.Setenv(envBgJobID, "")

	var out bytes.Buffer
	if err := cmdProviderCLI([]string{"create", "--label", "Cursor", "--runtime", "cursor", "--api-key-file", "-", "--json"},
		strings.NewReader(cursorPresetKey+"\n"), &out); err != nil {
		t.Fatalf("orbit provider create --runtime cursor: %v", err)
	}
	if got, want := mustJSON(t, (*writes)[0]), mustJSON(t, cursorKeyBody("Cursor", cursorPresetKey)); got != want {
		t.Fatalf("create body = %s, want %s", got, want)
	}
	// An endpoint given is the one kept.
	if err := cmdProviderCLI([]string{"create", "--label", "Cursor 2", "--runtime", "cursor", "--base-url", "https://api2.cursor.sh/",
		"--api-key", cursorPresetKey}, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}
	if (*writes)[1]["baseUrl"] != "https://api2.cursor.sh/" || (*writes)[1]["presetSlug"] != cursorKeyPreset {
		t.Fatalf("create body = %v", (*writes)[1])
	}
	if err := cmdProviderCLI([]string{"update", "cursor-api", "--runtime", "cursor", "--api-key", cursorPresetKey + "-2", "--json"},
		strings.NewReader(""), &out); err != nil {
		t.Fatalf("orbit provider update --runtime cursor: %v", err)
	}
	if last := (*hits)[len(*hits)-1]; last != "PATCH /api/runner/providers/cursor-api" {
		t.Fatalf("hits = %v", *hits)
	}
	if got, want := mustJSON(t, (*writes)[2]), mustJSON(t, map[string]interface{}{"runtime": "cursor", "apiKey": cursorPresetKey + "-2"}); got != want {
		t.Fatalf("update body = %s, want %s", got, want)
	}
	for _, c := range []struct {
		argv []string
		want string
	}{
		{[]string{"create", "--label", "Cursor", "--runtime", "cursor"}, "--api-key or --api-key-file is required"},
		{[]string{"create", "--label", "Local", "--runtime", "claude", "--api-key", "k", "--models", vllmModels}, "--base-url is required"},
	} {
		if err := cmdProviderCLI(c.argv, strings.NewReader(""), &out); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%v: err = %v, want %q", c.argv, err, c.want)
		}
	}
	if len(*writes) != 3 {
		t.Fatalf("a refused command was written: %v", *writes)
	}

	// The help says so, wherever --runtime is.
	help := func(args ...string) string {
		var text bytes.Buffer
		if err := cmdProviderCLI(args, strings.NewReader(""), &text); err != nil {
			t.Fatal(err)
		}
		return text.String()
	}
	for name, text := range map[string]string{
		"provider --help": help("--help"), "create --help": help("create", "--help"), "update --help": help("update", "--help"),
	} {
		if !strings.Contains(text, "cursor") {
			t.Errorf("orbit %s does not name the cursor protocol:\n%s", name, text)
		}
	}
	if create := help("create", "--help"); !strings.Contains(create, "--runtime cursor") || !strings.Contains(create, "only Cursor CLI for a") {
		t.Errorf("orbit provider create --help does not say how a Cursor key goes in:\n%s", create)
	}
	for _, spec := range providerCLICapabilities {
		if spec.Tool == "provider_create" && !strings.Contains(strings.Join(spec.Arguments, " "), "required but for --runtime cursor") {
			t.Errorf("provider_create capability arguments = %v", spec.Arguments)
		}
	}
}

// The preset and endpoint a Cursor key goes in under are @orbit/shared's Cursor preset, read from its
// source: a renamed preset or a moved endpoint there fails here.
func TestCursorKeyPresetIsTheSharedOne(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "shared", "src", "providerPresets.ts"))
	if err != nil {
		t.Fatal(err)
	}
	source := string(data)
	at := strings.Index(source, fmt.Sprintf("slug: '%s'", cursorKeyPreset))
	if at < 0 {
		t.Fatalf("@orbit/shared has no preset %q", cursorKeyPreset)
	}
	preset := source[at:]
	if next := strings.Index(preset[1:], "slug: '"); next >= 0 {
		preset = preset[:next+1]
	}
	for _, want := range []string{"runtime: 'cursor'", fmt.Sprintf("baseUrl: '%s'", cursorAPIBaseURL), "models: []"} {
		if !strings.Contains(preset, want) {
			t.Errorf("the shared %s preset does not say %s:\n%s", cursorKeyPreset, want, preset)
		}
	}
}
