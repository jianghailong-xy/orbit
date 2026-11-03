//go:build linux || darwin

package main

import (
	"strings"
	"testing"
)

// integrationOutput.text, the end of a command's output as it may leave this machine, with the writes
// laid out by hand: what a real command does to the pipe does not place a trim exactly where it hurts.
// (integrate_check_tail_secrets_test.go holds the same behaviour to real commands.)

// TestIntegrationOutputTextDropsWhatItsTrimCut: Write trims as the output goes by, before anything can
// be redacted, so what it keeps may start anywhere. A secret it cut in half is not a secret any rule
// can recognise, and the back half must not leave with the rest.
func TestIntegrationOutputTextDropsWhatItsTrimCut(t *testing.T) {
	const kept = integrationOutputTail + integrationOutputCarryMax
	cases := []struct {
		name, printed, secret, after string
	}{
		{name: "an address's password", printed: tailAddress, secret: tailPassword, after: "@db/orbit"},
		{name: "a literal secret", printed: "token " + tailToken, secret: tailToken},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			redactor := newIntegrationOutputRedactor(tailToken)
			at := strings.Index(tc.printed, tc.secret)
			// Every place the trim can fall, from the front of what was printed to the secret's last
			// few bytes. One write of more than twice the tail is what trims it to `kept`.
			for start := 0; start < at+len(tc.secret)-3; start++ {
				rest := tc.printed[start:]
				filler := strings.Repeat("x", kept-len(rest))
				out := newIntegrationOutput()
				if _, err := out.Write([]byte(strings.Repeat("y", 2*integrationOutputTail) + tc.printed + filler)); err != nil {
					t.Fatalf("write: %v", err)
				}
				if int64(len(out.tail)) != kept || !strings.HasPrefix(string(out.tail), rest) {
					t.Fatalf("the trim kept %d bytes starting %q, want %d starting %q",
						len(out.tail), string(out.tail[:20]), kept, rest)
				}
				text := out.text(redactor)
				secretRest := tc.secret
				if start > at {
					secretRest = tc.secret[start-at:]
				}
				if strings.Contains(text, secretRest+tc.after) {
					t.Fatalf("cut %d bytes into %q, the tail holds %q: it starts %q", start, tc.printed, secretRest, text[:40])
				}
				// A marker is shorter than what it replaces here, so the tail can come up that much short.
				if len(text) > integrationOutputTail || len(text) < integrationOutputTail-len(tc.secret) {
					t.Fatalf("the tail is %d bytes, want it within %d of %d", len(text), len(tc.secret), integrationOutputTail)
				}
			}
		})
	}

	t.Run("however much redaction shortens what follows", func(t *testing.T) {
		// Enough secrets behind the cut that, redacted, everything kept fits in the tail: the window
		// reaches the very front of what the trim kept, and nothing but the front's own removal
		// keeps the back half of the first secret out of it.
		redactor := newIntegrationOutputRedactor(tailToken)
		printed := "token " + tailToken + " "
		rest := tailToken[10:] + " "
		secrets := strings.Repeat(tailToken+" ", (kept-len(rest))/(len(tailToken)+1))
		out := newIntegrationOutput()
		output := strings.Repeat("y", 2*integrationOutputTail) + printed + secrets
		if _, err := out.Write([]byte(output + strings.Repeat("z", kept-len(rest)-len(secrets)))); err != nil {
			t.Fatalf("write: %v", err)
		}
		if !strings.HasPrefix(string(out.tail), rest) {
			t.Fatalf("the trim kept %q, want it to start %q", string(out.tail[:40]), rest)
		}
		if text := out.text(redactor); strings.Contains(text, tailToken[10:]) {
			t.Fatalf("the tail holds the back half of a secret: it starts %q", text[:60])
		}
	})
}

// TestIntegrationOutputTextIsWhatWasPrinted: nothing else moves. Output that was never trimmed loses no
// byte of its front, a long run with no whitespace in it stays a tail rather than vanishing, and the
// cut still answers exactly the last 16 KB when there is that much to answer with.
func TestIntegrationOutputTextIsWhatWasPrinted(t *testing.T) {
	redactor := urlOnlyRedactor()
	text := func(t *testing.T, writes ...string) string {
		t.Helper()
		out := newIntegrationOutput()
		for _, write := range writes {
			if _, err := out.Write([]byte(write)); err != nil {
				t.Fatalf("write: %v", err)
			}
		}
		return out.text(redactor)
	}

	t.Run("short", func(t *testing.T) {
		const printed = "someone@example.invalid is the first thing printed\nand this the last"
		if got := text(t, printed); got != printed {
			t.Fatalf("text = %q, want it as it was printed", got)
		}
	})
	t.Run("exactly the tail", func(t *testing.T) {
		printed := strings.Repeat("a", integrationOutputTail)
		if got := text(t, printed); got != printed {
			t.Fatalf("text is %d bytes, want the %d printed", len(got), len(printed))
		}
	})
	t.Run("more than a tail, never trimmed", func(t *testing.T) {
		printed := strings.Repeat("a", integrationOutputTail+100) + "THE-END"
		got := text(t, printed)
		if len(got) != integrationOutputTail || !strings.HasSuffix(got, "THE-END") {
			t.Fatalf("text is %d bytes ending %q, want exactly %d ending THE-END", len(got), lastBytes(got, 10), integrationOutputTail)
		}
	})
	t.Run("trimmed many times over", func(t *testing.T) {
		var writes []string
		for i := 0; i < 64; i++ {
			writes = append(writes, strings.Repeat("a line of ordinary test output\n", 1024))
		}
		got := text(t, append(writes, "THE-END")...)
		if len(got) != integrationOutputTail || !strings.HasSuffix(got, "THE-END") {
			t.Fatalf("text is %d bytes ending %q, want exactly %d ending THE-END", len(got), lastBytes(got, 10), integrationOutputTail)
		}
	})
	t.Run("NUL goes, wherever it is", func(t *testing.T) {
		if got := text(t, "a\x00b", "\x00c"); got != "abc" {
			t.Fatalf("text = %q, want %q", got, "abc")
		}
	})
	t.Run("NUL goes before anything reads the text", func(t *testing.T) {
		out := newIntegrationOutput()
		if _, err := out.Write([]byte("token the-runners-secret\x00-token-0123456789\n")); err != nil {
			t.Fatalf("write: %v", err)
		}
		if got, want := out.text(newIntegrationOutputRedactor(tailToken)), "token "+integrationOutputRedacted+"\n"; got != want {
			t.Fatalf("text = %q, want %q", got, want)
		}
	})
	t.Run("the tail ends where the output does, across writes", func(t *testing.T) {
		// A secret that arrives in two writes is one secret by the time it is read.
		got := text(t, "dial postgres://app:s3cr", "et-pass@db/orbit\n")
		if got != "dial "+tailRedacted+"\n" {
			t.Fatalf("text = %q", got)
		}
	})
}
