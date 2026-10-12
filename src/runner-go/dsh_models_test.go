package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

const dshTestModelDirectory = `{"sessionId":"catalog-session","configOptions":[
  {"id":"model","type":"select","currentValue":"opaque/model-a","options":[
    {"group":"vendor","name":"A provider","options":[
      {"value":"[\"fictional-provider\",\"custom-model\"]","name":"Runtime model A"},
      {"value":"  opaque:model-B ?#  ","name":"Runtime model B"}]}]},
  {"id":"reasoning_effort","type":"select","currentValue":"deliberate/custom","options":[
    {"group":"levels","options":[{"value":"disabled/custom","name":"Off"},{"value":"deliberate/custom","name":"Think"}]}]}
]}`

func TestDshModelCatalogOpaqueGroupedDirectory(t *testing.T) {
	models, err := parseDshModelCatalog([]byte(dshTestModelDirectory))
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 2 || models[0].Value != `["fictional-provider","custom-model"]` || models[1].Value != "  opaque:model-B ?#  " {
		t.Fatalf("opaque runtime model directory changed: %#v", models)
	}
	for _, model := range models {
		if model.ContextWindow != 0 || !reflect.DeepEqual(model.ReasoningLevels, []string{"disabled/custom", "deliberate/custom"}) || model.DefaultReasoningLevel != "deliberate/custom" {
			t.Fatalf("runtime reasoning directory or unknown context window changed: %#v", model)
		}
	}
	publishModelCatalog(&ModelCatalog{Claude: []ModelInfo{{Value: models[0].Value, ContextWindow: 123456}}, Dsh: models})
	t.Cleanup(func() { publishModelCatalog(nil) })
	if modelContextWindow(providerDsh, models[0].Value) != 0 {
		t.Fatal("Harness inherited a guessed context window from another runtime")
	}
	if got := mergeModelCatalog(nil, &ModelCatalog{Dsh: models}, nil); got == nil || len(got.Dsh) != 2 {
		t.Fatal("dsh-only catalogue was discarded")
	}
	if got := carryOverModelCatalog(&ModelCatalog{Dsh: models}, &ModelCatalog{}); len(got.Dsh) != 2 {
		t.Fatal("transient catalogue failure discarded the last directory")
	}
	for _, bad := range []string{"", "not-json", `{}`, `{"configOptions":[{"id":"model","type":"select","options":[{"value":""}]}]}`} {
		if _, err := parseDshModelCatalog([]byte(bad)); err == nil {
			t.Fatalf("accepted missing or invalid directory: %q", bad)
		}
	}
}

type dshModelProbeCapture struct {
	Home       string   `json:"home"`
	DshHome    string   `json:"dshHome"`
	Key        string   `json:"key"`
	AmbientKey bool     `json:"ambientKey"`
	Permission string   `json:"permission"`
	Methods    []string `json:"methods"`
	PatchArgs  []string `json:"patchArgs"`
}

func dshModelProbeFixture(t *testing.T, mode string) (string, string) {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	capture := filepath.Join(dir, "capture.json")
	executable := filepath.Join(dir, "fake-dsh")
	script := "#!/bin/sh\nexec " + shellQuote(self) + " -test.run='^TestDshModelProbeHelper$' -- dsh-model-probe " + shellQuote(mode) + " " + shellQuote(capture) + " \"$@\"\n"
	if err := os.WriteFile(executable, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	return executable, capture
}

func TestDshModelCatalogCredentiallessProbe(t *testing.T) {
	userHome := t.TempDir()
	t.Setenv("HOME", userHome)
	t.Setenv("DEEPSEEK_API_KEY", "opaque ambient deepseek credential")
	t.Setenv("ANTHROPIC_API_KEY", "opaque ambient anthropic credential")
	t.Setenv("ORBIT_DSH_API_KEY", "opaque ambient orbit credential")
	t.Setenv("DSH_HOME", filepath.Join(userHome, ".dsh"))
	if err := os.Mkdir(filepath.Join(userHome, ".dsh"), 0700); err != nil {
		t.Fatal(err)
	}
	userConfig := filepath.Join(userHome, ".dsh", "cordis.patch.yml")
	before := []byte("preserve user's real Harness profile\n")
	if err := os.WriteFile(userConfig, before, 0600); err != nil {
		t.Fatal(err)
	}
	executable, capturePath := dshModelProbeFixture(t, "success")
	models, err := fetchDshModelCatalogWithExecutable(context.Background(), executable)
	if err != nil || len(models) != 2 || !dshCatalogReadable() {
		t.Fatalf("catalogue read = %#v, %v; readable=%v", models, err, dshCatalogReadable())
	}
	data, err := os.ReadFile(capturePath)
	if err != nil {
		t.Fatal(err)
	}
	var capture dshModelProbeCapture
	if err := json.Unmarshal(data, &capture); err != nil {
		t.Fatal(err)
	}
	if capture.Home != userHome || capture.DshHome == filepath.Join(userHome, ".dsh") || capture.Key != "" || capture.AmbientKey || capture.Permission != "read-only" {
		t.Fatalf("credentialless probe environment = %#v", capture)
	}
	if !reflect.DeepEqual(capture.Methods, []string{"initialize", "session/new", "session/close"}) {
		t.Fatalf("probe must not authenticate or prompt: %#v", capture.Methods)
	}
	if len(capture.PatchArgs) != 4 || capture.PatchArgs[0] != "--profile" || capture.PatchArgs[1] != "acp" || capture.PatchArgs[2] != "--patch" || !filepath.IsAbs(capture.PatchArgs[3]) {
		t.Fatalf("ACP profile launch args = %#v", capture.PatchArgs)
	}
	if _, err := os.Stat(capture.DshHome); !os.IsNotExist(err) {
		t.Fatalf("disposable probe state remains: %v", err)
	}
	after, err := os.ReadFile(userConfig)
	if err != nil || string(after) != string(before) {
		t.Fatalf("user Harness profile changed: %q, %v", after, err)
	}
}

func TestDshModelCatalogRejectsStartupAndProtocolFailures(t *testing.T) {
	for _, mode := range []string{"missing-executable", "non-json", "protocol-version", "session-new-error", "startup-diagnostic", "empty-catalogue", "exit-after-close"} {
		t.Run(mode, func(t *testing.T) {
			executable, _ := dshModelProbeFixture(t, mode)
			if mode == "missing-executable" {
				executable += "-does-not-exist"
			}
			models, err := fetchDshModelCatalogWithExecutable(context.Background(), executable)
			if err == nil || len(models) != 0 || dshCatalogReadable() {
				t.Fatalf("failed probe accepted: %#v, %v; readable=%v", models, err, dshCatalogReadable())
			}
			if strings.Contains(err.Error(), "opaque diagnostic credential") || strings.Contains(err.Error(), "sk-fixture-secret") {
				t.Fatalf("ordinary catalogue diagnostic exposed a credential: %v", err)
			}
			if (mode == "session-new-error" || mode == "startup-diagnostic") && !strings.Contains(err.Error(), "DSH_SANDBOX_UNAVAILABLE") {
				t.Fatalf("missing sandbox startup diagnostic: %v", err)
			}
		})
	}
}

// Runs only as the explicitly launched fake CLI. It never invokes a real engine.
func TestDshModelProbeHelper(t *testing.T) {
	marker := -1
	for i, arg := range os.Args {
		if arg == "dsh-model-probe" {
			marker = i
			break
		}
	}
	if marker < 0 {
		return
	}
	mode, capturePath := os.Args[marker+1], os.Args[marker+2]
	capture := dshModelProbeCapture{
		Home: os.Getenv("HOME"), DshHome: os.Getenv("DSH_HOME"), Key: os.Getenv("ORBIT_DSH_API_KEY"),
		AmbientKey: os.Getenv("DEEPSEEK_API_KEY") != "" || os.Getenv("ANTHROPIC_API_KEY") != "",
		Permission: os.Getenv("DSH_PERMISSION_MODE"), PatchArgs: os.Args[marker+3:],
	}
	if mode == "non-json" {
		fmt.Fprintln(os.Stderr, "opaque diagnostic credential sk-fixture-secret")
		fmt.Fprintln(os.Stdout, "startup text that is not ACP")
		os.Exit(0)
	}
	if mode == "startup-diagnostic" {
		fmt.Fprintln(os.Stderr, "SANDBOX_UNAVAILABLE opaque diagnostic credential")
	}
	scanner, encoder := bufio.NewScanner(os.Stdin), json.NewEncoder(os.Stdout)
	for scanner.Scan() {
		var request struct {
			ID     int    `json:"id"`
			Method string `json:"method"`
		}
		if json.Unmarshal(scanner.Bytes(), &request) != nil {
			os.Exit(2)
		}
		capture.Methods = append(capture.Methods, request.Method)
		var result interface{}
		switch request.Method {
		case "initialize":
			version := 1
			if mode == "protocol-version" {
				version = 2
			}
			result = map[string]interface{}{"protocolVersion": version, "agentInfo": map[string]string{"version": "0.0.1"}}
		case "session/new":
			if mode == "session-new-error" {
				_ = encoder.Encode(map[string]interface{}{"jsonrpc": "2.0", "id": request.ID, "error": map[string]interface{}{"code": -32603, "message": "SANDBOX_UNAVAILABLE opaque diagnostic credential"}})
				continue
			}
			result = json.RawMessage(dshTestModelDirectory)
			if mode == "empty-catalogue" {
				result = map[string]interface{}{"sessionId": "catalog-session"}
			}
		case "session/close":
			result = map[string]interface{}{}
		default:
			os.Exit(3)
		}
		_ = encoder.Encode(map[string]interface{}{"jsonrpc": "2.0", "id": request.ID, "result": result})
	}
	data, _ := json.Marshal(capture)
	_ = os.WriteFile(capturePath, data, 0600)
	if mode == "exit-after-close" {
		os.Exit(4)
	}
	os.Exit(0)
}
