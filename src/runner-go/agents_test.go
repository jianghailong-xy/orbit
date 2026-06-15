package main

import (
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
)

func TestDetectAgents(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("PATH executable-bit lookup is unix-specific")
	}
	// Point PATH at a temp dir and drop in fake CLIs to assert detection +
	// ordering (knownAgents order, not install order).
	dir := t.TempDir()
	t.Setenv("PATH", dir)
	fake := func(name string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}

	if got := agentKeys(detectAgents()); len(got) != 0 {
		t.Fatalf("no CLIs on PATH: got %v, want none", got)
	}
	fake("codex")
	if got := agentKeys(detectAgents()); !reflect.DeepEqual(got, []string{"codex"}) {
		t.Fatalf("codex only: got %v", got)
	}
	fake("claude")
	if got := agentKeys(detectAgents()); !reflect.DeepEqual(got, []string{"claude", "codex"}) {
		t.Fatalf("both present: got %v, want [claude codex]", got)
	}
}

func TestParseAgentSelection(t *testing.T) {
	cases := []struct {
		name   string
		line   string
		n      int
		want   []int
		wantOK bool
	}{
		{"empty selects all", "", 2, []int{0, 1}, true},
		{"whitespace selects all", "  \n", 2, []int{0, 1}, true},
		{"single", "1", 2, []int{0}, true},
		{"comma separated", "1,2", 2, []int{0, 1}, true},
		{"space separated", "1 2", 2, []int{0, 1}, true},
		{"order preserved", "2,1", 2, []int{1, 0}, true},
		{"surrounding spaces", " 1 , 2 ", 2, []int{0, 1}, true},
		{"dedupes", "1,1", 2, []int{0}, true},
		{"zero is invalid", "0", 2, nil, false},
		{"too high is invalid", "3", 2, nil, false},
		{"non-numeric is invalid", "abc", 2, nil, false},
		{"mixed valid+invalid is invalid", "1,x", 2, nil, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, ok := parseAgentSelection(c.line, c.n)
			if ok != c.wantOK {
				t.Fatalf("ok = %v, want %v", ok, c.wantOK)
			}
			if ok && !reflect.DeepEqual(got, c.want) {
				t.Fatalf("got %v, want %v", got, c.want)
			}
		})
	}
}
