package main

import "testing"

func TestParseSetModelName(t *testing.T) {
	cases := map[string]string{
		"Set model to Opus 5 for this session only":                             "Opus 5",
		"Set model to Sonnet 5 for this session only":                           "Sonnet 5",
		"Set model to Haiku 4.5 for this session only":                          "Haiku 4.5",
		"  Set model to Opus 5 for this session only\n":                         "Opus 5",
		"Set model to Opus in plan mode, else Sonnet for this session only":     "Opus in plan mode, else Sonnet",
		"noise before\nSet model to Fable 5 for this session only\nnoise after": "Fable 5",
		"Usage: /model <name>. Available: sonnet, opus, haiku":                  "", // no "set model" line
		"": "",
	}
	for in, want := range cases {
		if got := parseSetModelName([]byte(in)); got != want {
			t.Errorf("parseSetModelName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestClaudeModelID(t *testing.T) {
	cases := map[string]string{
		"Opus 5":    "claude-opus-5",
		"Sonnet 5":  "claude-sonnet-5",
		"Haiku 4.5": "claude-haiku-4-5",
		"Opus 4.8":  "claude-opus-4-8",
		"Fable 5":   "claude-fable-5",
		" Opus 5 ":  "claude-opus-5", // trims + collapses whitespace
	}
	for in, want := range cases {
		if got := claudeModelID(in); got != want {
			t.Errorf("claudeModelID(%q) = %q, want %q", in, got, want)
		}
	}
}
