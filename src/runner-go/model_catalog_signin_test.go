package main

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

// What the model catalog does with an engine the engine probe has found signed out, and with one
// that signs in. Nothing here runs a CLI: the runtimes are fakeCatalogCLIs and the engine probe
// answers from the test, so the machine running these tests is never asked what it has installed.

// fakeCatalogCLI is one runtime's CLI as the catalog refresh sees it: installed nowhere, answering
// whatever the test last told it to.
type fakeCatalogCLI struct {
	mu     sync.Mutex
	models []ModelInfo
	err    error
}

func (f *fakeCatalogCLI) answer(models []ModelInfo, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.models, f.err = models, err
}

func (f *fakeCatalogCLI) runtime(engine string) catalogRuntime {
	return catalogRuntime{
		engine:    engine,
		available: func() bool { return true },
		fetch: func(context.Context) ([]ModelInfo, error) {
			f.mu.Lock()
			defer f.mu.Unlock()
			return f.models, f.err
		},
	}
}

// catalogLog collects what a refresh logs, in place of the runner's stdout.
type catalogLog struct {
	mu    sync.Mutex
	lines []string
}

func (l *catalogLog) logf(args ...interface{}) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lines = append(l.lines, strings.TrimSpace(fmt.Sprintln(args...)))
}

func (l *catalogLog) all() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.lines...)
}

// probedEngines is an engine probe that answers from the test instead of the machine's CLIs,
// already refreshed once with reports.
func probedEngines(reports ...EngineHealthReport) *engineHealthProbe {
	p := &engineHealthProbe{probe: func() []EngineHealthReport { return reports }}
	p.refresh()
	return p
}

// refreshCatalog is one pass of runLoop's refreshModelCatalog, over the given runtimes and probe.
func refreshCatalog(prev *ModelCatalog, runtimes []catalogRuntime, health *engineHealthProbe, log *catalogLog) *ModelCatalog {
	next, signedOut := readModelCatalog(context.Background(), runtimes, health.signedOut, log.logf)
	return mergeModelCatalog(prev, next, signedOut)
}

var (
	kimiModels   = []ModelInfo{{Value: "kimi-code/kimi-for-coding", Label: "Kimi for Coding", ContextWindow: 262_144}}
	codexModels  = []ModelInfo{{Value: "gpt-6-sol", Label: "GPT-6-Sol", ContextWindow: 372_000}}
	claudeModels = []ModelInfo{{Value: "claude-opus-5-5", Label: "Opus 5.5"}}
	// What `kimi provider list --json` says on a machine nobody signed Kimi into:
	// {"providers":{},"models":{}}, which parseKimiModelCatalog turns into this.
	errKimiNoModels = errors.New("kimi provider list --json reported no models")
)

// husong's runner on vmi3129740: Kimi 2.1.1 installed, never signed in, and the engine probe has
// said so on every heartbeat. Every refresh still logged "kimi model catalog refresh failed" when
// Kimi had nothing to list — hourly, about something the runner page already showed. The runner
// knew; the line told nobody anything.
func TestCatalogRefreshKeepsASignedOutEngineEmptyAndQuiet(t *testing.T) {
	health := probedEngines(
		EngineHealthReport{Engine: providerCodex, Installed: true, Auth: "yes"},
		EngineHealthReport{Engine: providerKimi, Installed: true, Version: "2.1.1", Auth: "no"},
	)
	codex, kimi := &fakeCatalogCLI{models: codexModels}, &fakeCatalogCLI{err: errKimiNoModels}
	runtimes := []catalogRuntime{codex.runtime(providerCodex), kimi.runtime(providerKimi)}

	t.Run("signed out from the start", func(t *testing.T) {
		var log catalogLog
		var catalog *ModelCatalog
		for pass := 0; pass < 3; pass++ {
			catalog = refreshCatalog(catalog, runtimes, health, &log)
		}
		if lines := log.all(); len(lines) != 0 {
			t.Fatalf("logged %q — a signed-out engine with nothing to list is not a failure", lines)
		}
		if catalog == nil || len(catalog.Kimi) != 0 || !reflect.DeepEqual(catalog.Codex, codexModels) {
			t.Fatalf("catalog = %+v, want Codex's list and nothing for Kimi", catalog)
		}
	})

	// The case carrying over was built to cover, turned against it: a runtime that came back empty
	// keeps its last good list, which for an engine that has since signed out is the list of models
	// nobody on this machine can run any more.
	t.Run("signed out after it had models", func(t *testing.T) {
		var log catalogLog
		prev := &ModelCatalog{Codex: []ModelInfo{{Value: "gpt-5.6-sol"}}, Kimi: kimiModels}
		catalog := refreshCatalog(prev, runtimes, health, &log)
		if len(catalog.Kimi) != 0 {
			t.Fatalf("Kimi = %+v, want empty — carried over from before the sign-out", catalog.Kimi)
		}
		if !reflect.DeepEqual(catalog.Codex, codexModels) {
			t.Fatalf("Codex = %+v, want this round's list", catalog.Codex)
		}
		if lines := log.all(); len(lines) != 0 {
			t.Fatalf("logged %q, want nothing", lines)
		}
	})

	// Even a round in which nothing else answered: the heartbeat still has to stop offering the
	// signed-out engine's old models, while every other runtime keeps what it had.
	t.Run("signed out while every other runtime failed", func(t *testing.T) {
		var log catalogLog
		codexDown := &fakeCatalogCLI{err: errors.New("codex debug models: signal: killed")}
		prev := &ModelCatalog{Codex: codexModels, Kimi: kimiModels}
		catalog := refreshCatalog(prev, []catalogRuntime{codexDown.runtime(providerCodex), kimi.runtime(providerKimi)}, health, &log)
		if len(catalog.Kimi) != 0 {
			t.Fatalf("Kimi = %+v, want empty", catalog.Kimi)
		}
		if !reflect.DeepEqual(catalog.Codex, codexModels) {
			t.Fatalf("Codex = %+v, want its last good list carried over", catalog.Codex)
		}
		// Codex is signed in, so its failure is a real one and says so.
		if lines := log.all(); len(lines) != 1 || !strings.HasPrefix(lines[0], "codex model catalog refresh failed:") {
			t.Fatalf("logged %q, want Codex's failure and only that", lines)
		}
	})

	// A first round with nothing to report still reports nothing, as it did before: an empty
	// catalog would replace the server's stored one wholesale.
	t.Run("nothing read on the first round", func(t *testing.T) {
		var log catalogLog
		if catalog := refreshCatalog(nil, []catalogRuntime{kimi.runtime(providerKimi)}, health, &log); catalog != nil {
			t.Fatalf("catalog = %+v, want none to report", catalog)
		}
		if lines := log.all(); len(lines) != 0 {
			t.Fatalf("logged %q, want nothing", lines)
		}
	})
}

// Signed out doesn't mean the CLI has nothing to list. Claude Code resolves its aliases and Codex
// prints its models with nobody signed in, and a configured Anthropic or OpenAI provider — running
// on that same CLI with its own key — takes its picker from exactly this list. Blanking it because
// the machine's own login is missing would put those providers back on the fallback list shipped in
// the preset, a generation behind.
func TestCatalogRefreshKeepsWhatASignedOutEngineStillLists(t *testing.T) {
	health := probedEngines(
		EngineHealthReport{Engine: providerClaude, Installed: true, Auth: "no"},
		EngineHealthReport{Engine: providerCodex, Installed: true, Auth: "no",
			Accounts: []EngineAccountReport{{ID: codexAccountDefaultSlot, Auth: "no"}}},
	)
	claude, codex := &fakeCatalogCLI{models: claudeModels}, &fakeCatalogCLI{models: codexModels}
	var log catalogLog
	catalog := refreshCatalog(&ModelCatalog{}, []catalogRuntime{claude.runtime(providerClaude), codex.runtime(providerCodex)}, health, &log)
	if !reflect.DeepEqual(catalog.Claude, claudeModels) || !reflect.DeepEqual(catalog.Codex, codexModels) {
		t.Fatalf("catalog = %+v, want what both CLIs listed", catalog)
	}
	if lines := log.all(); len(lines) != 0 {
		t.Fatalf("logged %q, want nothing", lines)
	}
}

// Only the probe's conclusive "no" quiets a failure. An engine that is signed in, or whose probe
// wouldn't say, or that hasn't been probed yet, and still can't list its models is broken, and the
// log line is how anyone finds out — exactly as it was. So is its last good list, carried over.
func TestCatalogRefreshStillLogsAFailureOfAnEngineNotKnownSignedOut(t *testing.T) {
	for _, tc := range []struct {
		name   string
		engine string
		health *engineHealthProbe
	}{
		{"signed in", providerKimi, probedEngines(EngineHealthReport{Engine: providerKimi, Installed: true, Auth: "yes"})},
		// OpenCode on husong's runner: its probe can't tell, and that must not read as signed out.
		{"sign-in unknown", providerOpenCode, probedEngines(EngineHealthReport{Engine: providerOpenCode, Installed: true, Auth: "unknown"})},
		{"not probed yet", providerKimi, &engineHealthProbe{}},
		{"Codex with Default signed out but another account signed in", providerCodex, probedEngines(EngineHealthReport{
			Engine: providerCodex, Installed: true, Auth: "no",
			Accounts: []EngineAccountReport{{ID: codexAccountDefaultSlot, Auth: "no"}, {ID: "work", Auth: "yes"}},
		})},
		{"Codex with Default signed out and another account unknown", providerCodex, probedEngines(EngineHealthReport{
			Engine: providerCodex, Installed: true, Auth: "no",
			Accounts: []EngineAccountReport{{ID: codexAccountDefaultSlot, Auth: "no"}, {ID: "work", Auth: "unknown"}},
		})},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cli := &fakeCatalogCLI{err: errors.New("exit status 1")}
			last := []ModelInfo{{Value: "last-good"}}
			prev := &ModelCatalog{}
			*prev.models(tc.engine) = last
			var log catalogLog
			catalog := refreshCatalog(prev, []catalogRuntime{cli.runtime(tc.engine)}, tc.health, &log)

			want := tc.engine + " model catalog refresh failed: exit status 1"
			if lines := log.all(); len(lines) != 1 || lines[0] != want {
				t.Fatalf("logged %q, want %q", lines, want)
			}
			if got := *catalog.models(tc.engine); !reflect.DeepEqual(got, last) {
				t.Fatalf("%s = %+v, want the last good list carried over", tc.engine, got)
			}
		})
	}
}

// The other half: an engine that was signed out and now isn't has its list re-read at once. The
// catalog can be holding nothing for it, and the hourly timer would keep its models out of the
// picker for up to an hour after the sign-in that was meant to make them appear.
func TestEngineProbeAsksForTheCatalogWhenASignedOutEngineSignsIn(t *testing.T) {
	kimiAuth := func(auth string) []EngineHealthReport {
		return []EngineHealthReport{{Engine: providerKimi, Installed: true, Auth: auth}}
	}
	codexAccounts := func(def, work string) []EngineHealthReport {
		return []EngineHealthReport{{Engine: providerCodex, Installed: true, Auth: def, Accounts: []EngineAccountReport{
			{ID: codexAccountDefaultSlot, Auth: def}, {ID: "work", Auth: work},
		}}}
	}
	for _, tc := range []struct {
		name   string
		probes [][]EngineHealthReport
		want   int
	}{
		{"signed out, then in", [][]EngineHealthReport{kimiAuth("no"), kimiAuth("yes")}, 1},
		{"signed in on the next probe after an unknown", [][]EngineHealthReport{kimiAuth("no"), kimiAuth("unknown"), kimiAuth("yes")}, 1},
		{"signed in, and stays in", [][]EngineHealthReport{kimiAuth("no"), kimiAuth("yes"), kimiAuth("yes")}, 1},
		{"out, in, out, in", [][]EngineHealthReport{kimiAuth("no"), kimiAuth("yes"), kimiAuth("no"), kimiAuth("yes")}, 2},
		// The first catalog pass after a start asks every engine, so there's nothing to catch up on.
		{"signed in at the first probe", [][]EngineHealthReport{kimiAuth("yes")}, 0},
		{"unknown, then signed in", [][]EngineHealthReport{kimiAuth("unknown"), kimiAuth("yes")}, 0},
		{"still signed out", [][]EngineHealthReport{kimiAuth("no"), kimiAuth("no")}, 0},
		{"signed out, then unknown", [][]EngineHealthReport{kimiAuth("no"), kimiAuth("unknown")}, 0},
		{"signing out", [][]EngineHealthReport{kimiAuth("yes"), kimiAuth("no")}, 0},
		{"a second Codex account signs in", [][]EngineHealthReport{codexAccounts("no", "no"), codexAccounts("no", "yes")}, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var next int
			var asked int
			p := &engineHealthProbe{
				probe: func() []EngineHealthReport {
					reports := tc.probes[next]
					next++
					return reports
				},
				onSignIn: func() { asked++ },
			}
			for range tc.probes {
				p.refresh()
			}
			if asked != tc.want {
				t.Fatalf("asked for the catalog %d time(s), want %d", asked, tc.want)
			}
		})
	}
}

// End to end, wired the way runLoop wires it: the probe's sign-in hook starts the same coalescing
// refresh the hourly timer does, and nothing else is called.
func TestSigningInPutsAnEnginesModelsInTheCatalogAtOnce(t *testing.T) {
	var authMu sync.Mutex
	kimiAuth := "no"
	health := &engineHealthProbe{probe: func() []EngineHealthReport {
		authMu.Lock()
		defer authMu.Unlock()
		return []EngineHealthReport{
			{Engine: providerCodex, Installed: true, Auth: "yes"},
			{Engine: providerKimi, Installed: true, Version: "2.1.1", Auth: kimiAuth},
		}
	}}
	codex, kimi := &fakeCatalogCLI{models: codexModels}, &fakeCatalogCLI{err: errKimiNoModels}
	runtimes := []catalogRuntime{codex.runtime(providerCodex), kimi.runtime(providerKimi)}

	var log catalogLog
	var catalogMu sync.Mutex
	var catalog *ModelCatalog
	published := make(chan *ModelCatalog, 8)
	refreshModelCatalog := coalescingRefresh(func() {
		next, signedOut := readModelCatalog(context.Background(), runtimes, health.signedOut, log.logf)
		catalogMu.Lock()
		catalog = mergeModelCatalog(catalog, next, signedOut)
		out := catalog
		catalogMu.Unlock()
		published <- out
	})
	health.onSignIn = func() { go refreshModelCatalog() }

	health.refresh()
	refreshModelCatalog()
	if got := <-published; got == nil || len(got.Kimi) != 0 {
		t.Fatalf("catalog = %+v, want Kimi empty while it is signed out", got)
	}

	// Someone signs Kimi in — from the web, or in a terminal on that machine. Its CLI has models now,
	// and the next probe (the one the web's sign-in forces, or the five-minute one) sees it.
	kimi.answer(kimiModels, nil)
	authMu.Lock()
	kimiAuth = "yes"
	authMu.Unlock()
	health.refresh()

	select {
	case got := <-published:
		if !reflect.DeepEqual(got.Kimi, kimiModels) || !reflect.DeepEqual(got.Codex, codexModels) {
			t.Fatalf("catalog = %+v, want Kimi's models beside Codex's", got)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("the probe found Kimi signed in and the catalog was never refreshed")
	}
	if lines := log.all(); len(lines) != 0 {
		t.Fatalf("logged %q, want nothing", lines)
	}
}
