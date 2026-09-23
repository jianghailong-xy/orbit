package main

import (
	"context"
	"os"
	"path/filepath"
	"slices"
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

// The two frames the capability probe reads, verbatim in shape from `claude -p
// --output-format stream-json --verbose --permission-mode auto --settings <fastMode> --model <id>
// "/fast"` on CLI 2.1.280. Trimmed to the fields the parser looks at plus enough neighbours to
// prove it is not just taking the first thing it sees.
func claudeCapabilityProbeOutput(permissionMode, fastResult string) []byte {
	return []byte(strings.Join([]string{
		`{"type":"system","subtype":"init","cwd":"/root","session_id":"3f09bb5c","model":"claude-opus-5-5",` +
			`"permissionMode":"` + permissionMode + `","claude_code_version":"2.1.280","fast_mode_state":"off"}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"` + fastResult + `"}]}}`,
		`{"type":"result","subtype":"success","is_error":false,"result":"` + fastResult + `","session_id":"3f09bb5c"}`,
	}, "\n"))
}

func TestParseClaudeModelCapabilities(t *testing.T) {
	// Opus 5.5 on a CLI that has it: Auto survives `--permission-mode auto` and `/fast` toggles
	// rather than refusing. This is the pair the static tables got wrong on release day.
	caps := parseClaudeModelCapabilities(
		claudeCapabilityProbeOutput("auto", "Fast mode OFF (this session only)"))
	if !slices.Contains(caps.permissionModes, "auto") {
		t.Errorf("permissionModes = %v, want it to contain auto", caps.permissionModes)
	}
	if !slices.Equal(caps.permissionModes, allPermissionModes) {
		t.Errorf("permissionModes = %v, want every mode %v", caps.permissionModes, allPermissionModes)
	}
	if caps.fastMode == nil || !*caps.fastMode {
		t.Errorf("fastMode = %v, want true", caps.fastMode)
	}

	// Haiku: the CLI takes `--permission-mode auto` without a word and starts in `default`, and
	// refuses the fast lane out loud. Both are answers, not silence.
	caps = parseClaudeModelCapabilities(
		claudeCapabilityProbeOutput("default", "Fast mode unavailable: Fast mode requires usage credits"))
	if slices.Contains(caps.permissionModes, "auto") {
		t.Errorf("permissionModes = %v, want auto withheld", caps.permissionModes)
	}
	if len(caps.permissionModes) != len(allPermissionModes)-1 {
		t.Errorf("permissionModes = %v, want every mode but auto", caps.permissionModes)
	}
	if caps.fastMode == nil || *caps.fastMode {
		t.Errorf("fastMode = %v, want an explicit false", caps.fastMode)
	}
}

func TestParseClaudeModelCapabilitiesUnknownStaysNil(t *testing.T) {
	// A CLI too old to have `/fast`, and one whose output isn't stream-json at all. Neither may
	// come back as "no": nil is what keeps the clients on their static fallback for that model.
	for name, out := range map[string][]byte{
		"no /fast":   claudeCapabilityProbeOutput("auto", "Unknown slash command: /fast"),
		"plain text": []byte("Fast mode OFF (this session only)\n"),
		"empty":      nil,
	} {
		caps := parseClaudeModelCapabilities(out)
		if caps.fastMode != nil {
			t.Errorf("%s: fastMode = %v, want nil (unknown)", name, *caps.fastMode)
		}
	}
	if caps := parseClaudeModelCapabilities([]byte("Fast mode OFF\n")); caps.permissionModes != nil {
		t.Errorf("plain text: permissionModes = %v, want nil (unknown)", caps.permissionModes)
	}
}

func TestParseFastModeVerdict(t *testing.T) {
	cases := map[string]struct {
		fast, said bool
	}{
		// Accepted, so the lane exists — which of the two states it landed in says nothing.
		"Fast mode OFF (this session only)": {true, true},
		"Fast mode ON (this session only)":  {true, true},
		"fast mode on":                      {true, true},
		// Refused. The reason varies with the account; the refusal is the answer.
		"Fast mode unavailable: Fast mode requires usage credits":            {false, true},
		"Fast mode unavailable: Fast mode is not available in the Agent SDK": {false, true},
		// Said neither → unknown, never "no".
		"Unknown slash command: /fast": {false, false},
		"":                             {false, false},
	}
	for in, want := range cases {
		fast, said := parseFastModeVerdict(in)
		if fast != want.fast || said != want.said {
			t.Errorf("parseFastModeVerdict(%q) = (%v, %v), want (%v, %v)", in, fast, said, want.fast, want.said)
		}
	}
}

func TestFetchClaudeModelCatalogReportsPerModelCapabilities(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "claude")
	// A CLI that answers all three probes: the alias resolution, `/context`, and `/fast`. Only
	// Opus has the fast lane, and only Haiku lacks Auto — which is what the real 2.1.280 reports.
	script := `#!/bin/sh
prompt=""
model=""
previous=""
settings=""
permission=""
for arg in "$@"; do
  case "$previous" in
    --model) model="$arg" ;;
    --settings) settings="$arg" ;;
    --permission-mode) permission="$arg" ;;
  esac
  case "$arg" in /model*|/context|/fast) prompt="$arg" ;; esac
  previous="$arg"
done
case "$prompt" in
  "/model opus") echo "Set model to Opus 5.5 for this session only" ;;
  "/model fable") echo "Set model to Fable 5 for this session only" ;;
  "/model sonnet") echo "Set model to Sonnet 5 for this session only" ;;
  "/model haiku") echo "Set model to Haiku 4.5 for this session only" ;;
  "/context") echo "**Tokens:** 18.2k / 1m (2%)" ;;
  "/fast")
    # The fast lane is asked for through the FLAG settings layer, never a flag; a probe that
    # skipped the file would make every model look fast-less. Read with shell builtins only:
    # PATH is the fake CLI own dir, so grep and cat are not there to be run.
    asked=""
    [ -n "$settings" ] && read -r asked < "$settings"
    case "$asked" in *'"fastMode":true'*) ;; *) exit 4 ;; esac
    settled="$permission"
    [ "$model" = "claude-haiku-4-5" ] && settled="default"
    printf '{"type":"system","subtype":"init","permissionMode":"%s"}\n' "$settled"
    if [ "$model" = "claude-opus-5-5" ]; then
      printf '{"type":"result","subtype":"success","result":"Fast mode OFF (this session only)"}\n'
    else
      printf '{"type":"result","subtype":"success","result":"Fast mode unavailable: Fast mode requires usage credits"}\n'
    fi
    ;;
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
	want := map[string]struct {
		auto bool
		fast bool
	}{
		"claude-opus-5-5":  {auto: true, fast: true},
		"claude-fable-5":   {auto: true, fast: false},
		"claude-sonnet-5":  {auto: true, fast: false},
		"claude-haiku-4-5": {auto: false, fast: false},
	}
	if len(models) != len(want) {
		t.Fatalf("len(models) = %d, want %d: %#v", len(models), len(want), models)
	}
	for _, model := range models {
		expected, known := want[model.Value]
		if !known {
			t.Fatalf("unexpected model %q", model.Value)
		}
		if got := slices.Contains(model.PermissionModes, "auto"); got != expected.auto {
			t.Errorf("%s: auto = %v, want %v (modes %v)", model.Value, got, expected.auto, model.PermissionModes)
		}
		if model.FastMode == nil {
			t.Fatalf("%s: FastMode = nil, want an answer", model.Value)
		}
		if *model.FastMode != expected.fast {
			t.Errorf("%s: FastMode = %v, want %v", model.Value, *model.FastMode, expected.fast)
		}
	}
}
