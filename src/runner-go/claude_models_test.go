package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFetchClaudeModelCatalogMatchesClaudeCodePicker(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "claude")
	script := `#!/bin/sh
prompt=""
no_persistence=0
user_settings=0
previous=""
for arg in "$@"; do
  [ "$arg" = "--no-session-persistence" ] && no_persistence=1
  [ "$previous" = "--setting-sources" ] && [ "$arg" = "user" ] && user_settings=1
  case "$arg" in /model*) prompt="$arg" ;; esac
  previous="$arg"
done
[ "$no_persistence" = 1 ] && [ "$user_settings" = 1 ] || exit 3
case "$prompt" in
  "/model opus") echo "Set model to Opus 5 for this session only" ;;
  "/model fable") echo "Set model to Fable 5 for this session only" ;;
  "/model sonnet") echo "Set model to Sonnet 5 for this session only" ;;
  "/model haiku") echo "Set model to Haiku 4.5 for this session only" ;;
  *) exit 2 ;;
esac
`
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)

	models, err := fetchClaudeModelCatalog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	want := []struct{ value, label string }{
		{"claude-opus-5", "Opus 5"},
		{"claude-fable-5", "Fable 5"},
		{"claude-sonnet-5", "Sonnet 5"},
		{"claude-haiku-4-5", "Haiku 4.5"},
	}
	if len(models) != len(want) {
		t.Fatalf("len(models) = %d, want %d: %#v", len(models), len(want), models)
	}
	for i, expected := range want {
		got := models[i]
		if got.Value != expected.value || got.Label != expected.label {
			t.Errorf("models[%d] = {%q, %q}, want {%q, %q}", i, got.Value, got.Label, expected.value, expected.label)
		}
		if got.Priority == nil || *got.Priority != i {
			t.Errorf("models[%d].Priority = %v, want %d", i, got.Priority, i)
		}
	}
}

func TestParseSetModelName(t *testing.T) {
	cases := map[string]string{
		"Set model to Opus 5 for this session only":                             "Opus 5",
		"Set model to Sonnet 5 for this session only":                           "Sonnet 5",
		"Set model to Haiku 4.5 for this session only":                          "Haiku 4.5",
		"  Set model to Opus 5 for this session only\n":                         "Opus 5",
		"Set model to Opus in plan mode, else Sonnet for this session only":     "Opus in plan mode, else Sonnet",
		"noise before\nSet model to Fable 5 for this session only\nnoise after": "Fable 5",
		"Set model to `Opus 5` for this session only":                           "Opus 5", // newer CLI wraps the name in backticks
		"Set model to `Sonnet 5` for this session only":                         "Sonnet 5",
		"Usage: /model <name>. Available: sonnet, opus, haiku":                  "", // no "set model" line
		"": "",
	}
	for in, want := range cases {
		if got := parseSetModelName([]byte(in)); got != want {
			t.Errorf("parseSetModelName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestFetchClaudeDefaultModelPreservesExactUserAlias(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", dir)
	t.Setenv("ANTHROPIC_MODEL", "")
	if err := os.WriteFile(
		filepath.Join(dir, "settings.json"),
		[]byte(`{"model":"opus[1m]"}`),
		0o600,
	); err != nil {
		t.Fatal(err)
	}

	model, err := fetchClaudeDefaultModel()
	if err != nil {
		t.Fatal(err)
	}
	if model != "opus[1m]" {
		t.Fatalf("model = %q, want opus[1m]", model)
	}
}

func TestFetchClaudeDefaultModelHonorsEnvironmentPriority(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", dir)
	t.Setenv("ANTHROPIC_MODEL", "gateway-exact-id")
	if err := os.WriteFile(
		filepath.Join(dir, "settings.json"),
		[]byte(`{"model":"opusplan"}`),
		0o600,
	); err != nil {
		t.Fatal(err)
	}

	model, err := fetchClaudeDefaultModel()
	if err != nil {
		t.Fatal(err)
	}
	if model != "gateway-exact-id" {
		t.Fatalf("model = %q, want gateway-exact-id", model)
	}
}

func TestClaudeModelID(t *testing.T) {
	cases := map[string]string{
		"Opus 5":    "claude-opus-5",
		"Sonnet 5":  "claude-sonnet-5",
		"Haiku 4.5": "claude-haiku-4-5",
		"Opus 4.8":  "claude-opus-4-8",
		"Fable 5":   "claude-fable-5",
		" Opus 5 ":  "claude-opus-5", // trims + collapses whitespace
	}
	for in, want := range cases {
		if got := claudeModelID(in); got != want {
			t.Errorf("claudeModelID(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestParseContextWindow(t *testing.T) {
	// Real `claude -p "/context"` output: the headline reading, then a table whose rows also
	// carry token counts and percentages the regex must not pick up.
	full := []byte(strings.Join([]string{
		"## Context Usage",
		"",
		"**Model:** claude-opus-5  ",
		"**Tokens:** 18.2k / 1m (2%)",
		"",
		"| Category | Tokens | Percentage |",
		"|----------|--------|------------|",
		"| System prompt | 3.2k | 0.3% |",
		"| Free space | 981.8k | 98.2% |",
	}, "\n"))
	if got := parseContextWindow(full); got != 1_000_000 {
		t.Fatalf("parseContextWindow(full) = %d, want 1000000", got)
	}

	cases := map[string]int{
		"**Tokens:** 29.3k / 967k (3%)": 967_000,
		"Tokens: 1000 / 200k":           200_000,
		"**Tokens:** 5k / 1M":           1_000_000,
		// Nothing to read: an older CLI that doesn't know /context, or a changed layout. 0 is a
		// valid answer — it travels as "no reading" rather than as a wrong denominator.
		"Unknown slash command: /context": 0,
		"":                                0,
		// A window under 1k is the CLI having printed something that isn't one.
		"**Tokens:** 1 / 8": 0,
	}
	for in, want := range cases {
		if got := parseContextWindow([]byte(in)); got != want {
			t.Errorf("parseContextWindow(%q) = %d, want %d", in, got, want)
		}
	}
}
