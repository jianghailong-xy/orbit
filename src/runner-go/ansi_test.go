package main

import "testing"

func TestStripANSI(t *testing.T) {
	// One real line off codex's stderr, as its tracing layer colours it.
	const colored = "\x1b[2m2026-08-12T15:31:40.112363Z\x1b[0m \x1b[31mERROR\x1b[0m " +
		"\x1b[2mcodex_core::util\x1b[0m\x1b[2m:\x1b[0m Custom tool call output is missing for " +
		"call id: call_5zNG2EzSkoBdXdpN7OYM9Gol"
	const want = "2026-08-12T15:31:40.112363Z ERROR codex_core::util: Custom tool call output " +
		"is missing for call id: call_5zNG2EzSkoBdXdpN7OYM9Gol"
	if got := stripANSI(colored); got != want {
		t.Errorf("stripANSI(codex line) = %q, want %q", got, want)
	}

	// Brackets an engine wrote itself are not escape sequences: nothing is dropped without ESC.
	const literal = "panic: index out of range [3] with length 2 \x1b[0m"
	if got := stripANSI(literal); got != "panic: index out of range [3] with length 2 " {
		t.Errorf("stripANSI(literal brackets) = %q", got)
	}

	// Erase-line / cursor-move sequences a progress spinner leaves behind go too.
	if got := stripANSI("loading\x1b[2K\x1b[Gdone"); got != "loadingdone" {
		t.Errorf("stripANSI(spinner) = %q, want %q", got, "loadingdone")
	}

	if got := stripANSI("plain line"); got != "plain line" {
		t.Errorf("stripANSI(plain) = %q", got)
	}
}
