package main

import "testing"

// Every on-disk (and on-ref) key derived from a session id has to survive the server changing
// which spelling it sends. The failure this guards is silent: a live session's uploads, scratch
// dir or base ref would still exist under the other name, so nothing errors — the diff just
// re-bases on the wrong commit and the uploads look lost.
// Mirrors the web's transcriptStore.storageKey test.
func TestSessionKeysNormalizeBothSpellings(t *testing.T) {
	const uuid = "019fcbf3-0fa8-7f83-9302-46b25389cb16"
	// The same id as the web puts in a URL.
	const b62 = "341DOGTVEs0Fk0gAn1mje"

	if got := decodeSessionID(b62); got != uuid {
		t.Fatalf("test fixture is wrong: decodeSessionID(%q) = %q, want %q", b62, got, uuid)
	}

	for _, tc := range []struct {
		name string
		fn   func(string) string
	}{
		{"uploadsDir", uploadsDir},
		{"baseRefName", baseRefName},
		{"runDir", runDir},
	} {
		if a, b := tc.fn(uuid), tc.fn(b62); a != b {
			t.Errorf("%s: spellings diverge:\n  uuid -> %s\n  b62  -> %s", tc.name, a, b)
		}
	}
}
