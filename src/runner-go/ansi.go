package main

import (
	"regexp"
	"strings"
)

// Engines colour their stderr: codex's tracing layer writes "\x1b[31mERROR\x1b[0m
// \x1b[2mcodex_core::util\x1b[0m: …" on every line it logs. Nothing downstream is a terminal —
// the ESC byte is invisible in HTML and in a SwiftUI Text, so what survives is the literal
// "[31m"/"[2m"/"[0m" around every word, on a line a client already renders in red.
//
// Stripped here, where the stderr of every engine is read, so neither the stored run_event nor
// any of the three clients has to carry them.
//
// Matches real ESC-prefixed CSI sequences only, so a log line's own "arr[0]" survives untouched.
// Mirrors src/web/src/lib/ansi.ts, which still has to run on every event already stored.
var ansiCSI = regexp.MustCompile("\x1b\\[[0-9;?]*[ -/]*[@-~]")

func stripANSI(s string) string {
	if !strings.Contains(s, "\x1b") {
		return s // the common case: a scan, not a rewrite
	}
	return ansiCSI.ReplaceAllString(s, "")
}
