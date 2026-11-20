package main

import (
	"context"
	"slices"
	"testing"
)

// One Claude probe reading that settles on Default must never take Auto away from a model's
// catalog row: the server lowers every Auto claim on the runner from that row. Auto goes only when
// claudeAutoWithdrawReadings trusted readings in a row agree, and comes back on the first reading
// that has it. Each round here goes through mergeModelCatalog, the path refreshModelCatalog takes.

const probedModel = "claude-opus-5-5"

var (
	readingAuto    = claudeModelPermissionModes(true)  // the init frame settled on auto
	readingDefault = claudeModelPermissionModes(false) // the init frame settled on default
	modesWithAuto  = allPermissionModes
)

// probeRound runs one catalog refresh whose Claude probe read `reading` for probedModel (nil: the
// probe could not say) and returns the catalog the heartbeat would report.
func probeRound(prev *ModelCatalog, reading []string) *ModelCatalog {
	next := &ModelCatalog{Claude: []ModelInfo{{Value: probedModel, Label: "Opus 5.5", PermissionModes: reading}}}
	return mergeModelCatalog(prev, next, map[string]bool{})
}

func reportedModes(t *testing.T, catalog *ModelCatalog) []string {
	t.Helper()
	for _, m := range catalog.Claude {
		if m.Value == probedModel {
			return m.PermissionModes
		}
	}
	t.Fatalf("catalog has no %s row: %#v", probedModel, catalog.Claude)
	return nil
}

func TestOneDefaultReadingNeverWithdrawsAuto(t *testing.T) {
	if claudeAutoWithdrawReadings != 3 {
		t.Fatalf("claudeAutoWithdrawReadings = %d; this test walks the threshold of 3", claudeAutoWithdrawReadings)
	}
	steps := []struct {
		name    string
		reading []string
		want    []string
	}{
		{"good reading", readingAuto, modesWithAuto},
		{"one default after a good one keeps Auto", readingDefault, modesWithAuto},
		{"two defaults in a row still keep Auto", readingDefault, modesWithAuto},
		{"third default in a row withdraws Auto", readingDefault, readingDefault},
		{"further defaults keep reporting no Auto", readingDefault, readingDefault},
		{"an unknown reading keeps the confirmed no", nil, readingDefault},
		{"recovery restores Auto at once", readingAuto, modesWithAuto},
		{"one default after the recovery keeps Auto", readingDefault, modesWithAuto},
		{"a good reading resets the count", readingAuto, modesWithAuto},
		{"default 1 of 3 after the reset", readingDefault, modesWithAuto},
		{"default 2 of 3 after the reset", readingDefault, modesWithAuto},
		{"default 3 of 3 withdraws again", readingDefault, readingDefault},
	}
	var catalog *ModelCatalog
	for i, step := range steps {
		catalog = probeRound(catalog, step.reading)
		if got := reportedModes(t, catalog); !slices.Equal(got, step.want) {
			t.Fatalf("round %d (%s): permissionModes = %v, want %v", i+1, step.name, got, step.want)
		}
	}
}

func TestUnknownReadingsNeitherCountNorResetTheStreak(t *testing.T) {
	catalog := probeRound(nil, readingAuto)
	for i, reading := range [][]string{readingDefault, nil, readingDefault, nil} {
		catalog = probeRound(catalog, reading)
		if got := reportedModes(t, catalog); !slices.Equal(got, modesWithAuto) {
			t.Fatalf("round %d: permissionModes = %v, want Auto kept (two trusted defaults so far)", i+2, got)
		}
	}
	// A failed round (the Claude list came back empty) carries the row, count included.
	catalog = mergeModelCatalog(catalog, &ModelCatalog{}, map[string]bool{})
	if got := reportedModes(t, catalog); !slices.Equal(got, modesWithAuto) {
		t.Fatalf("after a failed round: permissionModes = %v, want Auto kept", got)
	}
	catalog = probeRound(catalog, readingDefault)
	if got := reportedModes(t, catalog); !slices.Equal(got, readingDefault) {
		t.Fatalf("third trusted default: permissionModes = %v, want Auto withdrawn", got)
	}
}

func TestModelTrulyWithoutAutoStillReportsNone(t *testing.T) {
	// From a runner start: the first two defaults leave the row unknown (nil keeps the clients on
	// their static fallback) rather than reporting a "no" one reading made; the third reports none.
	var catalog *ModelCatalog
	for i, want := range [][]string{nil, nil, readingDefault, readingDefault} {
		catalog = probeRound(catalog, readingDefault)
		if got := reportedModes(t, catalog); !slices.Equal(got, want) {
			t.Fatalf("round %d: permissionModes = %v, want %v", i+1, got, want)
		}
	}
	if slices.Contains(reportedModes(t, catalog), "auto") {
		t.Fatal("a model every reading finds without Auto must report none")
	}
}

func TestProbeRunThatDidNotFinishCleanlyIsUnknown(t *testing.T) {
	initDefault := `{"type":"system","subtype":"init","model":"claude-opus-5-5","permissionMode":"default"}`
	for name, out := range map[string]string{
		"errored result": initDefault + "\n" + `{"type":"result","subtype":"success","is_error":true,"result":"You've hit your 5-hour limit"}`,
		"no result":      initDefault + "\n",
	} {
		if caps := parseClaudeModelCapabilities([]byte(out)); caps.permissionModes != nil {
			t.Errorf("%s: permissionModes = %v, want nil (unknown)", name, caps.permissionModes)
		}
	}
	clean := initDefault + "\n" + `{"type":"result","subtype":"success","is_error":false,"result":"Fast mode OFF (this session only)"}`
	if caps := parseClaudeModelCapabilities([]byte(clean)); !slices.Equal(caps.permissionModes, readingDefault) {
		t.Errorf("clean run: permissionModes = %v, want %v", caps.permissionModes, readingDefault)
	}
}

func TestSignedOutProbeCannotSayNoAuto(t *testing.T) {
	cli := &fakeCatalogCLI{}
	cli.answer([]ModelInfo{
		{Value: "claude-opus-5-5", PermissionModes: readingDefault},
		{Value: "claude-sonnet-5-5", PermissionModes: readingAuto},
	}, nil)
	signedOut := func(engine string) bool { return engine == providerClaude }
	catalog, _ := readModelCatalog(context.Background(), []catalogRuntime{cli.runtime(providerClaude)}, signedOut, func(...interface{}) {})
	if got := catalog.Claude[0].PermissionModes; got != nil {
		t.Errorf("signed-out default reading: permissionModes = %v, want nil (unknown)", got)
	}
	if got := catalog.Claude[1].PermissionModes; !slices.Equal(got, readingAuto) {
		t.Errorf("signed-out auto reading: permissionModes = %v, want %v", got, readingAuto)
	}
}
