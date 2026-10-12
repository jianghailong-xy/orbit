package main

import (
	"reflect"
	"testing"
)

// A sign-in that lands re-probes its own engine only; the rest of the snapshot stays as it was.
func TestRefreshEngineProbesOnlyThatEngine(t *testing.T) {
	full := 0
	var asked []string
	signedIn := 0
	p := &engineHealthProbe{
		probe: func() []EngineHealthReport {
			full++
			return []EngineHealthReport{
				{Engine: providerClaude, Installed: true, Auth: "no"},
				{Engine: providerCodex, Installed: true, Auth: "yes", Version: "codex 1"},
			}
		},
		probeOne: func(engine string) []EngineHealthReport {
			asked = append(asked, engine)
			return []EngineHealthReport{{Engine: engine, Installed: true, Auth: "yes"}}
		},
		onSignIn: func() { signedIn++ },
	}
	p.refresh()

	p.refreshEngine(providerClaude)
	if full != 1 || !reflect.DeepEqual(asked, []string{providerClaude}) {
		t.Fatalf("full probes = %d, single probes = %v; want 1 and [claude]", full, asked)
	}
	want := []EngineHealthReport{
		{Engine: providerClaude, Installed: true, Auth: "yes"},
		{Engine: providerCodex, Installed: true, Auth: "yes", Version: "codex 1"},
	}
	if got := p.snapshotNow(); !reflect.DeepEqual(got, want) {
		t.Fatalf("snapshot = %+v, want %+v", got, want)
	}
	if signedIn != 1 {
		t.Fatalf("onSignIn calls = %d, want 1: the engine went from signed out to signed in", signedIn)
	}
}

// Before the first full probe there is no snapshot to splice into; the full probe runs instead.
func TestRefreshEngineBeforeTheFirstProbeRunsTheFullOne(t *testing.T) {
	full := 0
	p := &engineHealthProbe{
		probe: func() []EngineHealthReport {
			full++
			return []EngineHealthReport{{Engine: providerCodex, Installed: true, Auth: "yes"}}
		},
		probeOne: func(string) []EngineHealthReport {
			t.Fatal("probed one engine with no snapshot to put it in")
			return nil
		},
	}
	p.refreshEngine(providerCodex)
	if full != 1 || len(p.snapshotNow()) != 1 {
		t.Fatalf("full probes = %d, snapshot = %+v", full, p.snapshotNow())
	}
}
