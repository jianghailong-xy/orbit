package main

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestParseOpenCodeModelCatalog(t *testing.T) {
	raw := []byte(`opencode/big-pickle
{
  "id": "big-pickle",
  "providerID": "opencode",
  "name": "Big Pickle",
  "limit": {"context": 200000, "output": 32000},
  "variants": {"high": {}, "low": {}, "medium": {}, "max": {"disabled": true}}
}
anthropic/claude-sonnet-4-5
{
  "id": "claude-sonnet-4-5",
  "providerID": "anthropic",
  "name": "Claude Sonnet 4.5",
  "limit": {"context": 1000000},
  "variants": {}
}
`)
	models, err := parseOpenCodeModelCatalog(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 2 {
		t.Fatalf("models = %#v, want 2", models)
	}
	if got := models[0]; got.Value != "opencode/big-pickle" || got.Label != "opencode · Big Pickle" || got.ContextWindow != 200000 {
		t.Fatalf("first model = %#v", got)
	}
	if got, want := models[0].ReasoningLevels, []string{"low", "medium", "high"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("variants = %#v, want %#v", got, want)
	}
	if models[1].Value != "anthropic/claude-sonnet-4-5" || models[1].Label != "anthropic · Claude Sonnet 4.5" {
		t.Fatalf("second model = %#v", models[1])
	}
}

func TestParseOpenCodeModelCatalogRejectsEmptyOutput(t *testing.T) {
	if _, err := parseOpenCodeModelCatalog([]byte("warning: no providers\n")); err == nil {
		t.Fatal("expected an error")
	}
}

func TestFetchGlobalOpenCodeModelCatalogUsesPrivateMachineDirectory(t *testing.T) {
	binDir := t.TempDir()
	machineDir := t.TempDir()
	if err := os.Chmod(machineDir, 0o700); err != nil {
		t.Fatal(err)
	}
	pwdPath := filepath.Join(binDir, "pwd")
	argsPath := filepath.Join(binDir, "args")
	flagPath := filepath.Join(binDir, "project-config-disabled")
	writeFakeBin(t, binDir, providerOpenCode, `printf '%s\n' "$@" > "$CAPTURE_ARGS"
pwd > "$CAPTURE_PWD"
printf '%s' "$OPENCODE_DISABLE_PROJECT_CONFIG" > "$CAPTURE_PROJECT_CONFIG"
printf '%s\n' 'provider/model' '{"id":"model","providerID":"provider","name":"Model","limit":{"context":123},"variants":{}}'`)
	t.Setenv("PATH", binDir+":"+os.Getenv("PATH"))
	t.Setenv("CAPTURE_PWD", pwdPath)
	t.Setenv("CAPTURE_ARGS", argsPath)
	t.Setenv("CAPTURE_PROJECT_CONFIG", flagPath)
	t.Setenv("ORBIT_HOME", machineDir)

	models, err := fetchGlobalOpenCodeModelCatalog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 1 || models[0].Value != "provider/model" {
		t.Fatalf("models = %#v", models)
	}
	args, err := os.ReadFile(argsPath)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := strings.TrimSpace(string(args)), "--pure\nmodels\n--verbose"; got != want {
		t.Fatalf("OpenCode model args = %q, want %q", got, want)
	}
	pwd, err := os.ReadFile(pwdPath)
	if err != nil {
		t.Fatal(err)
	}
	neutralDir := strings.TrimSpace(string(pwd))
	if want := filepath.Join(machineDir, "opencode-model-catalog"); neutralDir != want {
		t.Fatalf("catalog directory = %q, want %q", neutralDir, want)
	}
	if info, err := os.Stat(neutralDir); err != nil {
		t.Fatal(err)
	} else if info.Mode().Perm() != 0o700 {
		t.Fatalf("catalog directory mode = %04o, want 0700", info.Mode().Perm())
	}
	flag, err := os.ReadFile(flagPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(flag) != "1" {
		t.Fatalf("OPENCODE_DISABLE_PROJECT_CONFIG = %q, want 1", flag)
	}
}
