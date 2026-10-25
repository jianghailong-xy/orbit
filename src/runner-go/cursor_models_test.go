package main

import (
	"context"
	"errors"
	"strings"
	"syscall"
	"testing"
	"time"
)

func cursorModelByValue(t *testing.T, models []ModelInfo, value string) ModelInfo {
	t.Helper()
	for _, model := range models {
		if model.Value == value {
			return model
		}
	}
	t.Fatalf("the catalogue has no %q", value)
	return ModelInfo{}
}

func cursorParameter(t *testing.T, model ModelInfo, id string) ModelParameter {
	t.Helper()
	for _, parameter := range model.Parameters {
		if parameter.ID == id {
			return parameter
		}
	}
	t.Fatalf("%s has no parameter %q: %+v", model.Value, id, model.Parameters)
	return ModelParameter{}
}

func cursorParameterValues(parameter ModelParameter) string {
	values := make([]string, 0, len(parameter.Values))
	for _, value := range parameter.Values {
		values = append(values, value.Value)
	}
	return strings.Join(values, ",")
}

// The catalogue is the P0a recording's cursor/list_available_models, read as the CLI listed it: every
// model by its bare name with Auto first, every parameter a model takes — the effort under the model's
// own id, context, fast, thinking — with its values and default, the effort also as reasoning levels,
// and no context window anywhere.
func TestCursorModelCatalogParsesVariants(t *testing.T) {
	models, err := parseCursorModelCatalog(recordedCursorResult(t, 7))
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 46 {
		t.Fatalf("the recording lists 46 models, the catalogue %d", len(models))
	}
	if auto := models[0]; auto.Value != "default" || auto.Label != "Auto" || len(auto.Parameters) != 0 || auto.ReasoningLevels != nil {
		t.Fatalf("first model = %+v, want Auto with nothing to set", auto)
	}
	for _, model := range models {
		if model.ContextWindow != 0 {
			t.Fatalf("%s reports a context window, which ACP never gives", model.Value)
		}
	}

	opus := cursorModelByValue(t, models, "claude-opus-5-5")
	if opus.Label != "Claude Opus 5.5" || len(opus.Parameters) != 3 {
		t.Fatalf("claude-opus-5-5 = %+v", opus)
	}
	for id, want := range map[string]struct{ values, def, category string }{
		"context": {"300k,1m", "300k", "model_config"},
		"effort":  {"low,medium,high,xhigh,max", "medium", "thought_level"},
		"fast":    {"false,true", "false", "model_config"},
	} {
		parameter := cursorParameter(t, opus, id)
		if cursorParameterValues(parameter) != want.values || parameter.Default != want.def || parameter.Category != want.category {
			t.Fatalf("claude-opus-5-5 %s = %+v", id, parameter)
		}
	}
	if strings.Join(opus.ReasoningLevels, ",") != "low,medium,high,xhigh,max" || opus.DefaultReasoningLevel != "medium" {
		t.Fatalf("claude-opus-5-5 effort = %v / %q", opus.ReasoningLevels, opus.DefaultReasoningLevel)
	}
	if fast := cursorParameter(t, opus, "fast"); fast.Values[1].Label != "Fast" {
		t.Fatalf("the zero-width padding of %q was kept", fast.Values[1].Label)
	}

	// The effort is whatever the model calls it, and an on/off thinking switch is a parameter, not one.
	for value, want := range map[string]struct{ id, levels, def string }{
		"grok-4.7":          {"reasoning_effort", "low,medium,high,xhigh", "high"},
		"gpt-5.5":           {"reasoning", "none,low,medium,high,extra-high", "medium"},
		"claude-opus-5":     {"effort", "low,medium,high,xhigh,max", "high"},
		"claude-sonnet-4-6": {"effort", "low,medium,high,max", "medium"},
	} {
		model := cursorModelByValue(t, models, value)
		if strings.Join(model.ReasoningLevels, ",") != want.levels || model.DefaultReasoningLevel != want.def ||
			cursorParameterValues(cursorParameter(t, model, want.id)) != want.levels {
			t.Fatalf("%s effort = %v / %q, want %s from %s", value, model.ReasoningLevels, model.DefaultReasoningLevel, want.levels, want.id)
		}
	}
	thinking := cursorModelByValue(t, models, "claude-opus-4-5")
	if thinking.ReasoningLevels != nil || cursorParameterValues(cursorParameter(t, thinking, "thinking")) != "false,true" {
		t.Fatalf("claude-opus-4-5 = %+v: thinking on/off is no effort scale", thinking)
	}
	if composer := cursorModelByValue(t, models, "composer-2.5"); composer.ReasoningLevels != nil || len(composer.Parameters) != 1 {
		t.Fatalf("composer-2.5 = %+v", composer)
	}

	for name, raw := range map[string]string{
		"not-json":   `{"models":`,
		"no-models":  `{"models":[]}`,
		"no-values":  `{"models":[{"value":"","name":"Blank"}]}`,
		"wrong-type": `{"models":{"value":"default"}}`,
	} {
		if _, err := parseCursorModelCatalog([]byte(raw)); err == nil {
			t.Fatalf("%s: a catalogue with no usable model was accepted", name)
		}
	}
}

// The catalogue comes from the pinned build over ACP, with the Default account's login in memory and a
// throwaway home, and the probe ends the process itself; signed out there is none to read, which the
// catalogue refresh takes as the answer rather than a failure. The context gauge stays unavailable.
func TestCursorModelCatalogProbe(t *testing.T) {
	t.Run("signed-out", func(t *testing.T) {
		useCursorRealHome(t)
		r := newFakeCursorRelease(t)
		installFakeCursor(t)
		if _, err := fetchCursorModelCatalog(context.Background()); !errors.Is(err, errCursorSignedOut) {
			t.Fatalf("signed-out catalogue = %v", err)
		}
		if len(callsWith(r.calls(t), "acp")) != 0 {
			t.Fatal("a signed-out catalogue started the CLI")
		}
		catalog, empty := readModelCatalog(context.Background(), cursorCatalogRuntime(t), func(engine string) bool { return engine == providerCursor },
			func(...interface{}) { t.Fatal("a signed-out Cursor CLI was logged as a failure") })
		if len(catalog.Cursor) != 0 || !empty[providerCursor] {
			t.Fatalf("signed-out catalogue = %v, empty = %v", catalog.Cursor, empty)
		}
	})

	t.Run("default-account", func(t *testing.T) {
		home := useCursorRealHome(t)
		r := newFakeCursorRelease(t)
		installFakeCursor(t)
		token := cursorTestToken(t, time.Now().Add(time.Hour))
		signInCursorDefault(t, token)
		catalog, empty := readModelCatalog(context.Background(), cursorCatalogRuntime(t), func(string) bool { return false },
			func(args ...interface{}) { t.Fatalf("catalogue refresh failed: %v", args) })
		if len(catalog.Cursor) != 46 || len(empty) != 0 || cursorModelByValue(t, catalog.Cursor, "default").Label != "Auto" {
			t.Fatalf("catalogue = %d models, empty = %v", len(catalog.Cursor), empty)
		}
		acp := callsWith(r.calls(t), "acp")
		if len(acp) != 1 {
			t.Fatalf("ACP starts = %v", acp)
		}
		call := acp[0]
		if strings.Join(call.Args, " ") != "acp --disable-auto-update --disable-indexing" {
			t.Fatalf("the catalogue probe ran %v", call.Args)
		}
		if got, _ := call.env("CURSOR_AUTH_TOKEN"); got != token {
			t.Fatal("the catalogue was not read with the Default account's login")
		}
		assertProbeHome(t, call, home)
		if err := syscall.Kill(call.PID, 0); !errors.Is(err, syscall.ESRCH) {
			t.Fatalf("the probe left `agent acp` (pid %d) running: %v", call.PID, err)
		}
		// Ended with SIGTERM, which the CLI handles by exiting: the in-use marker it keeps in its version
		// directory while it runs is gone with it, not left behind as SIGKILL leaves it.
		if markers := cursorInUseMarkers(t, cursorVersionDir()); len(markers) != 0 {
			t.Fatalf("the probe left in-use markers %v in the version directory", markers)
		}
		publishModelCatalog(catalog)
		t.Cleanup(func() { publishModelCatalog(nil) })
		job := &ClaimedSession{Provider: providerCursor, Agent: AgentExecConfig{Model: "claude-opus-5-5"}}
		if window := modelContextWindow(providerCursor, "claude-opus-5-5"); window != 0 {
			t.Fatalf("Cursor CLI context window = %d, want none", window)
		}
		if payload := withContextWindow(map[string]interface{}{}, job); payload["contextWindow"] != nil {
			t.Fatalf("a Cursor CLI reading carries a window: %v", payload)
		}
		assertNoCursorStateIn(t, home)
	})

	t.Run("login-refused", func(t *testing.T) {
		useCursorRealHome(t)
		r := newFakeCursorRelease(t)
		installFakeCursor(t)
		signInCursorDefault(t, cursorTestToken(t, time.Now().Add(time.Hour)))
		r.behave(t, "catalog-rejected", "yes")
		if _, err := fetchCursorModelCatalog(context.Background()); !errors.Is(err, errCursorSignedOut) {
			t.Fatalf("a refused login's catalogue = %v", err)
		}
	})

	t.Run("not-installed", func(t *testing.T) {
		useCursorRealHome(t)
		newFakeCursorRelease(t)
		if cursorCLIAvailable() {
			t.Fatal("Cursor CLI reads as available with nothing installed")
		}
		if _, err := fetchCursorModelCatalog(context.Background()); err == nil || !strings.HasPrefix(err.Error(), "CURSOR_NOT_INSTALLED:") {
			t.Fatalf("catalogue with nothing installed = %v", err)
		}
	})
}

// cursorCatalogRuntime is the catalogue refresh's own entry for Cursor CLI.
func cursorCatalogRuntime(t *testing.T) []catalogRuntime {
	t.Helper()
	for _, rt := range catalogRuntimes {
		if rt.engine == providerCursor {
			return []catalogRuntime{rt}
		}
	}
	t.Fatalf("catalogRuntimes has no %s entry", providerCursor)
	return nil
}
