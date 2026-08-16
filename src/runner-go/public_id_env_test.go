package main

import (
	"crypto/rand"
	"fmt"
	"os"
	"regexp"
	"strings"
	"testing"
)

// publicID is the spelling every id has by the time an agent can see it. It is the inverse of
// decodeSessionID, which is the property that matters: the runner keeps keying its disk by the
// UUID while the model reads the short form, and the two have to name the same row.
func TestPublicIDRoundTrips(t *testing.T) {
	const uuid = "019fcbf3-0fa8-7f83-9302-46b25389cb16"
	const b62 = "341DOGTVEs0Fk0gAn1mje"

	if got := publicID(uuid); got != b62 {
		t.Fatalf("publicID(%q) = %q, want %q", uuid, got, b62)
	}
	// Idempotent, so it is safe at a boundary that does not know which spelling arrived — and so
	// applying it twice (a re-exec, a nested spawn) cannot mangle an id.
	if got := publicID(b62); got != b62 {
		t.Fatalf("publicID is not idempotent: %q -> %q", b62, got)
	}
	// Absent is legitimate: a session with no task, or a headless caller with no agent. Neither
	// may turn into a literal "0" or an error string.
	if got := publicID(""); got != "" {
		t.Fatalf("publicID(\"\") = %q, want empty", got)
	}

	for i := 0; i < 2000; i++ {
		var b [16]byte
		if _, err := rand.Read(b[:]); err != nil {
			t.Fatal(err)
		}
		u := fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
		if got := decodeSessionID(publicID(u)); got != u {
			t.Fatalf("round trip broke: %q -> %q -> %q", u, publicID(u), got)
		}
	}
}

// Leading-zero ids are the boundary the two directions are most likely to disagree on: the encoder
// strips them and the decoder has to re-pad to a full 32 hex digits. @orbit/shared's codec makes
// the same promise, and the two implementations must agree or a link built on one side stops
// resolving on the other.
func TestPublicIDHandlesLeadingZeros(t *testing.T) {
	for _, uuid := range []string{
		"00000000-0000-0000-0000-000000000000",
		"00000000-0000-0000-0000-000000000001",
		"00000000-0000-7000-8000-000000000000",
		"ffffffff-ffff-ffff-ffff-ffffffffffff",
	} {
		if got := decodeSessionID(publicID(uuid)); got != uuid {
			t.Errorf("round trip broke for %q: -> %q -> %q", uuid, publicID(uuid), got)
		}
	}
}

// Every engine hands its agent process the same session context, and the whole point of the flip
// is that a model never reads a raw UUID — so an engine that missed it regresses to nothing worse
// than "the ids look different under codex", which nobody reports.
//
// A source scan, for the same reason the apiserver's body-coverage spec is one: the thing being
// asserted is that a call site exists in a particular shape. Each engine builds its environment
// inside a function that also spawns a process, so there is no seam to read the value back out
// of — but the sixth engine added later will be a sixth literal in this package, and it has to
// wrap it like the other five.
func TestEveryEngineInjectsPublicIDs(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	// `KEY=` + string concat (most engines) and `"KEY":` + map value (opencode) — the two shapes
	// an engine writes the context in.
	sites := regexp.MustCompile(`"ORBIT_(?:SESSION|AGENT|TASK)_ID(?:="\s*\+|"\s*:)\s*([^,\n]+)`)
	found := 0
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		src, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range sites.FindAllStringSubmatch(string(src), -1) {
			found++
			if !strings.HasPrefix(strings.TrimSpace(m[1]), "publicID(") {
				t.Errorf("%s: session context injected unencoded: %s", name, strings.TrimSpace(m[0]))
			}
		}
	}
	// Guards the guard: a regex that matches nothing passes silently forever.
	if found < 15 {
		t.Fatalf("found only %d injection sites; the scan has stopped matching", found)
	}
}
