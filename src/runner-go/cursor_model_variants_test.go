package main

// A Cursor CLI session's model value names the context size and fast lane it runs its model with, the way
// Cursor writes a variant (`claude-opus-5-5[context=1m,fast=true]`; contract §10, shared cursorModels.ts):
// configure selects the bare model, then each of those settings the model lists — the one named, else the
// model's default from the runner's catalogue — then the effort. The parameterized picker's P0 recording
// (testdata/cursor/parameterized-model-picker) is replayed — what it recorded, Opus 5.5 selected and then its
// 1M context, as recorded, and the rest the way the recording shows the CLI answering
// (fakeCursorACPScript.Config) — with the catalogue its cursor/list_available_models answer lists published
// as the runner's own. scripts/test-cursor-model-variants.mjs runs every case below by name.

import (
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

const cursorPickerRecording = "parameterized-model-picker/acp"

// cursorSelection is one session/set_config_option the runner sent.
type cursorSelection struct{ ConfigID, Value string }

// cursorSelections is every session/set_config_option the runner sent the CLI, in order.
func cursorSelections(t *testing.T, fake *cursorReplay) []cursorSelection {
	t.Helper()
	var selections []cursorSelection
	for _, line := range fake.requests(t, "session/set_config_option") {
		params := mapValue(line.Message["params"])
		if firstString(params, "sessionId") != "<UUID_1>" {
			t.Fatalf("set_config_option on %v, not the session session/new opened", params["sessionId"])
		}
		selections = append(selections, cursorSelection{firstString(params, "configId"), firstString(params, "value")})
	}
	return selections
}

// publishCursorPickerCatalog makes the recording's own catalogue the runner's, as a refresh would.
func publishCursorPickerCatalog(t *testing.T) {
	t.Helper()
	models, err := parseCursorModelCatalog(recordedCursorResult(t, 7))
	if err != nil {
		t.Fatal(err)
	}
	publishModelCatalog(&ModelCatalog{Cursor: models})
	t.Cleanup(func() { publishModelCatalog(nil) })
}

// configureCursorModel runs a session on the recording with this model value and effort, then ends it,
// and returns what it selected and what the runner logged. The runner's catalogue is the recording's.
func configureCursorModel(t *testing.T, model, effort string, more ...RunInboxResponse) ([]cursorSelection, string) {
	t.Helper()
	publishCursorPickerCatalog(t)
	return configureCursorModelOn(t, model, effort, more...)
}

// configureCursorModelOn is configureCursorModel with whatever catalogue the runner has.
func configureCursorModelOn(t *testing.T, model, effort string, more ...RunInboxResponse) ([]cursorSelection, string) {
	t.Helper()
	var run cursorRun
	logs := captureLogs(t, func() {
		run = runCursorSession(t, cursorRunOptions{recording: cursorPickerRecording,
			script: func(s *fakeCursorACPScript) { s.Config = true },
			first:  append(more, RunInboxResponse{TurnID: "end-session", Kind: "end"}),
			agent:  func(agent *AgentExecConfig) { agent.Model, agent.Effort = model, effort }})
	})
	if run.status != stSucceeded || !run.ended {
		t.Fatalf("run = (%s, ended=%v), errors %v", run.status, run.ended, run.of("", evError))
	}
	return cursorSelections(t, run.fake), logs
}

func wantSelections(t *testing.T, got []cursorSelection, want ...cursorSelection) {
	t.Helper()
	if len(got) != len(want) || (len(want) > 0 && !reflect.DeepEqual(got, want)) {
		t.Fatalf("set_config_option = %v, want %v", got, want)
	}
}

func TestCursorModelVariants(t *testing.T) {
	t.Run("context-and-fast", func(t *testing.T) {
		got, logs := configureCursorModel(t, "claude-opus-5-5[context=1m,fast=true]", "high")
		wantSelections(t, got,
			cursorSelection{"model", "claude-opus-5-5"},
			cursorSelection{"context", "1m"},
			cursorSelection{"fast", "true"},
			cursorSelection{"effort", "high"})
		// The model and its context are what P0 sent the real CLI, word for word.
		recorded, err := readFakeCursorJSONL(filepath.Join("testdata", "cursor", cursorPickerRecording, "stdin.jsonl"))
		if err != nil {
			t.Fatal(err)
		}
		var sent []cursorSelection
		for _, msg := range recorded {
			if msg["method"] == "session/set_config_option" {
				params := mapValue(msg["params"])
				sent = append(sent, cursorSelection{firstString(params, "configId"), firstString(params, "value")})
			}
		}
		if len(sent) < 2 || !reflect.DeepEqual(got[:2], sent[:2]) {
			t.Fatalf("the model and context = %v, want the recording's %v", got[:2], sent)
		}
		if strings.Contains(logs, "cursor: the session's model") || strings.Contains(logs, "Auto takes") {
			t.Fatalf("a model that takes both settings logged a refusal:\n%s", logs)
		}
	})
	t.Run("setting-the-model-lacks", func(t *testing.T) {
		// Composer 2.5 has a fast lane and no context sizes.
		got, logs := configureCursorModel(t, "composer-2.5[context=1m,fast=false]", "")
		wantSelections(t, got, cursorSelection{"model", "composer-2.5"}, cursorSelection{"fast", "false"})
		if !strings.Contains(logs, "cursor: the session's model takes no context; ignoring 1m") {
			t.Fatalf("no log of the context left at the model's own:\n%s", logs)
		}
	})
	t.Run("value-the-model-lacks", func(t *testing.T) {
		got, logs := configureCursorModel(t, "claude-opus-5-5[context=2m,fast=true]", "")
		wantSelections(t, got, cursorSelection{"model", "claude-opus-5-5"}, cursorSelection{"fast", "true"})
		if !strings.Contains(logs, "cursor: the session's model does not offer context 2m; leaving it at the model's own 300k") {
			t.Fatalf("no log of the context left at the model's own:\n%s", logs)
		}
	})
	t.Run("auto", func(t *testing.T) {
		// A new session is on Auto already, and Auto has no settings to set, whatever its value names.
		for _, model := range []string{"default", ""} {
			got, _ := configureCursorModel(t, model, "")
			wantSelections(t, got)
		}
		got, logs := configureCursorModel(t, "default[context=1m,fast=true]", "high")
		wantSelections(t, got)
		for _, line := range []string{"cursor: Auto takes no model settings; ignoring context=1m", "cursor: Auto takes no model settings; ignoring fast=true",
			"cursor: the session's model takes no effort; ignoring high"} {
			if !strings.Contains(logs, line) {
				t.Fatalf("no log %q of Auto's settings left alone:\n%s", line, logs)
			}
		}
	})
	t.Run("only-context-and-fast", func(t *testing.T) {
		// The mode is the permission mode's and the effort the effort field's: a model value sets neither.
		got, logs := configureCursorModel(t, "claude-opus-5-5[effort=max,mode=ask,fast=true]", "low")
		wantSelections(t, got, cursorSelection{"model", "claude-opus-5-5"}, cursorSelection{"fast", "true"}, cursorSelection{"effort", "low"})
		for _, ignored := range []string{"effort=max", "mode=ask"} {
			if !strings.Contains(logs, "cursor: a model value sets only the context and fast lane; ignoring "+ignored) {
				t.Fatalf("no log of %s ignored:\n%s", ignored, logs)
			}
		}
	})
	t.Run("settings-already-current", func(t *testing.T) {
		// Opus 5.5 starts on 300K and its fast lane off: nothing to set beyond the model.
		got, _ := configureCursorModel(t, "claude-opus-5-5[context=300k,fast=false]", "")
		wantSelections(t, got, cursorSelection{"model", "claude-opus-5-5"})
	})
	t.Run("unnamed-settings-take-the-default", func(t *testing.T) {
		// A value that names a setting no longer — it went back to the model's own — sets the default the
		// runner's catalogue lists, whatever the process was left on.
		reload := func(id, model string) RunInboxResponse {
			return RunInboxResponse{TurnID: id, Kind: "reload", Content: `{"model":"` + model + `"}`}
		}
		got, _ := configureCursorModel(t, "claude-opus-5-5[context=1m,fast=true]", "",
			reload("reload-context", "claude-opus-5-5[fast=true]"), reload("reload-bare", "claude-opus-5-5"))
		wantSelections(t, got,
			cursorSelection{"model", "claude-opus-5-5"},
			cursorSelection{"context", "1m"},
			cursorSelection{"fast", "true"},
			cursorSelection{"context", "300k"},
			cursorSelection{"fast", "false"})
	})
	t.Run("no-catalogue", func(t *testing.T) {
		// With no catalogue to say what the model starts on, a setting the value does not name is left as the
		// process has it; what it names is still set.
		publishModelCatalog(nil)
		reload := RunInboxResponse{TurnID: "reload-bare", Kind: "reload", Content: `{"model":"claude-opus-5-5"}`}
		got, _ := configureCursorModelOn(t, "claude-opus-5-5[context=1m]", "", reload)
		wantSelections(t, got, cursorSelection{"model", "claude-opus-5-5"}, cursorSelection{"context", "1m"})
	})
	t.Run("reload", func(t *testing.T) {
		// A live session told its new value sets only what moved, and back on Auto sets the model alone.
		reload := func(id, model string) RunInboxResponse {
			return RunInboxResponse{TurnID: id, Kind: "reload", Content: `{"model":"` + model + `"}`}
		}
		got, _ := configureCursorModel(t, "claude-opus-5-5[context=1m]", "",
			reload("reload-fast", "claude-opus-5-5[context=1m,fast=true]"), reload("reload-auto", "default"))
		wantSelections(t, got,
			cursorSelection{"model", "claude-opus-5-5"},
			cursorSelection{"context", "1m"},
			cursorSelection{"fast", "true"},
			cursorSelection{"model", "default"})
	})
	t.Run("decode", func(t *testing.T) {
		// The same reading as shared's decodeCursorModel (cursor-model-variants.spec.ts).
		type decoded struct {
			model    string
			settings []cursorModelSetting
		}
		for value, want := range map[string]decoded{
			"claude-opus-5-5[context=1m,fast=true]":              {"claude-opus-5-5", []cursorModelSetting{{"context", "1m"}, {"fast", "true"}}},
			" gpt-5.5[context=272k,reasoning=medium,fast=false]": {"gpt-5.5", []cursorModelSetting{{"context", "272k"}, {"reasoning", "medium"}, {"fast", "false"}}},
			"claude-opus-5-5":                          {"claude-opus-5-5", nil},
			"default[]":                                {"default[]", nil},
			"no-such-model[]":                          {"no-such-model[]", nil},
			"":                                         {"", nil},
			"claude-opus-5[1m]":                        {"claude-opus-5[1m]", nil},
			`["deepseek", "deepseek-v4-pro"]`:          {`["deepseek", "deepseek-v4-pro"]`, nil},
			"[context=1m]":                             {"[context=1m]", nil},
			"claude-opus-5-5[context=1m":               {"claude-opus-5-5[context=1m", nil},
			"claude-opus-5-5[context=1m]x":             {"claude-opus-5-5[context=1m]x", nil},
			"claude-opus-5-5[context=1m][fast=true]":   {"claude-opus-5-5[context=1m][fast=true]", nil},
			"claude-opus-5-5[context]":                 {"claude-opus-5-5[context]", nil},
			"claude-opus-5-5[context=]":                {"claude-opus-5-5[context=]", nil},
			"claude-opus-5-5[context=1m,]":             {"claude-opus-5-5[context=1m,]", nil},
			"claude-opus-5-5[context=1m,context=300k]": {"claude-opus-5-5[context=1m,context=300k]", nil},
			"claude-opus-5-5[context=1=m]":             {"claude-opus-5-5[context=1=m]", nil},
		} {
			model, settings := decodeCursorModel(value)
			if model != want.model || !reflect.DeepEqual(settings, want.settings) {
				t.Errorf("decodeCursorModel(%q) = %q %v, want %q %v", value, model, settings, want.model, want.settings)
			}
		}
	})
}
