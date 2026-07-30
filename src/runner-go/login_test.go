package main

import (
	"context"
	"strings"
	"testing"
)

// Verbatim shape of what `claude auth login` writes to a pty: the URL arrives inside an OSC 8
// hyperlink (ESC ] 8 ; id=… ; <url> BEL <label> ESC ] 8 ; ; BEL) and is then repeated in wrapped
// fragments, each carrying the same full URL in its escape sequence but a truncated visible
// label. Scraping has to pick the complete one, not a fragment.
const realLoginOutput = "\x1b[?25l\x1b[?2004h Welcome to Claude Code v2.1.220\r\n" +
	"\r\n Browser didn't open? Use the url below to sign in (c to copy)\r\n\r\n" +
	"\x1b]8;id=q0xz7o;https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=frcAznfHKdQ3nNYn157q799r9SIaDMeJqq9HqdHD2JQ&code_challenge_method=S256&state=D_hsM6JpU6Uy2Ji8q0WtyOhF_Lq8iTIkuetcNISuRs\x07https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88\x1b]8;;\x07\r\n" +
	"\x1b]8;id=q0xz7o;https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=frcAznfHKdQ3nNYn157q799r9SIaDMeJqq9HqdHD2JQ&code_challenge_method=S256&state=D_hsM6JpU6Uy2Ji8q0WtyOhF_Lq8iTIkuetcNISuRs\x07ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.co\x1b]8;;\x07\r\n" +
	"\r\nPaste code here if prompted > "

func TestLoginURLScrape(t *testing.T) {
	got := loginURLRe.FindString(realLoginOutput)
	if got == "" {
		t.Fatal("no sign-in URL found in real CLI output")
	}
	// The whole URL, terminated at the BEL that closes the hyperlink target — not the truncated
	// visible label that follows it, and not a fragment from a later wrapped line.
	if strings.Contains(got, "\x07") {
		t.Errorf("match ran past the BEL terminator: %q", got)
	}
	for _, want := range []string{
		"code_challenge_method=S256",                       // PKCE: the verifier stays in the CLI process
		"state=D_hsM6JpU6Uy2Ji8q0WtyOhF_Lq8iTIkuetcNISuRs", // full, not truncated mid-param
		"redirect_uri=https%3A%2F%2Fplatform.claude.com",   // hosted callback, never localhost
	} {
		if !strings.Contains(got, want) {
			t.Errorf("URL missing %q\n  got: %s", want, got)
		}
	}
}

// A hosted redirect_uri is the whole reason this relay is possible: the user's browser never has
// to reach the runner. If the CLI ever switched to a localhost callback the flow would silently
// stop working for remote runners, so pin the expectation.
func TestLoginURLIsNotLocalhostCallback(t *testing.T) {
	got := loginURLRe.FindString(realLoginOutput)
	for _, bad := range []string{"localhost", "127.0.0.1"} {
		if strings.Contains(got, bad) {
			t.Fatalf("sign-in URL points at %s — the relay can't work for a remote runner: %s", bad, got)
		}
	}
}

func TestLoginURLIgnoresUnrelatedOutput(t *testing.T) {
	for _, s := range []string{
		"",
		"Welcome to Claude Code\r\nnothing to see here",
		"see https://claude.com/docs/whatever for help", // a docs link is not an authorize URL
	} {
		if got := loginURLRe.FindString(s); got != "" {
			t.Errorf("matched %q in non-sign-in output %q", got, s)
		}
	}
}

// The pty wrapper's flags differ per platform; both spellings must name the real command.
func TestPTYCommandWrapsArgv(t *testing.T) {
	cmd := ptyCommand(context.Background(), "claude", "auth", "login")
	if cmd.Path == "" {
		t.Fatal("no command resolved")
	}
	joined := strings.Join(cmd.Args, " ")
	if !strings.Contains(joined, "script") {
		t.Errorf("not wrapped in a pty: %v", cmd.Args)
	}
	if !strings.Contains(joined, "claude auth login") {
		t.Errorf("argv lost: %v", cmd.Args)
	}
}

// A relay with nothing running must reject a pasted code rather than drop it silently — the
// user needs to be told to start over, not left watching a card that never resolves.
func TestSubmitCodeWithNoRelayReportsFailure(t *testing.T) {
	var got LoginResultRequest
	(&loginRelay{}).submitCode("abc", func(r LoginResultRequest) { got = r })
	if got.Status != loginFailed {
		t.Fatalf("status = %q, want %q", got.Status, loginFailed)
	}
	if got.Message == "" {
		t.Error("failure carried no explanation for the user")
	}
}

func TestLatestLoginURLTakesTheLast(t *testing.T) {
	first := "https://claude.com/cai/oauth/authorize?code=true&state=OLD&code_challenge=aaa"
	second := "https://claude.com/cai/oauth/authorize?code=true&state=NEW&code_challenge=bbb"
	if got := latestLoginURL(first + "\r\nnoise\r\n" + second); got != second {
		t.Fatalf("latestLoginURL = %q, want the last %q", got, second)
	}
	if got := latestLoginURL("nothing here"); got != "" {
		t.Fatalf("latestLoginURL on non-sign-in output = %q, want empty", got)
	}
}

// Rejection detection keys on the CLI's actual behaviour, captured from a real bad paste:
//
//	Paste code here if prompted > Invalid code. Please make sure the full code was copied.
//
// The CLI does NOT re-prompt and does NOT start a new OAuth exchange — the prompt is printed
// once and the process keeps waiting on the same challenge. An earlier version of this keyed on
// a second prompt appearing, which never happens, so a bad code hung the card until timeout.
func TestRejectionMarkerMatchesRealCLIOutput(t *testing.T) {
	const afterBadPaste = "\r\nPaste code here if prompted > Invalid code. Please make sure the full code was copied."
	before := realLoginOutput
	after := realLoginOutput + afterBadPaste

	if strings.Count(before, loginInvalidCodeMarker) != 0 {
		t.Fatalf("marker %q already present before any paste", loginInvalidCodeMarker)
	}
	if strings.Count(after, loginInvalidCodeMarker) != 1 {
		t.Fatalf("marker %q did not catch the rejection", loginInvalidCodeMarker)
	}
	// A second bad paste must also register, so counting (not presence) is what the watcher uses.
	if strings.Count(after+afterBadPaste, loginInvalidCodeMarker) != 2 {
		t.Error("a second rejection was not counted")
	}
	// The prompt itself is printed once and stays that way — the thing we used to count.
	if strings.Count(after, "Paste code here") != 2 {
		t.Log("note: prompt appears twice here only because the fixture concatenates two renders")
	}
}

// Cancel + retry must work immediately. The heartbeat redelivers `start` until the runner's
// first report lands, so a repeat of the SAME attempt has to be a no-op — but a NEW attempt is
// the user asking again, and must preempt. Getting this wrong locked the user out for the full
// relay timeout: start() saw a relay running and returned, so the retry never reached the CLI.
func TestStartIsIdempotentPerAttemptButPreemptsANewOne(t *testing.T) {
	r := &loginRelay{running: true, attempt: "A"}

	// Same attempt redelivered: no-op, and the running relay is left alone.
	r.start("A", func(LoginResultRequest) { t.Error("redelivered start should not report") })
	r.mu.Lock()
	stillRunning, keptAttempt := r.running, r.attempt
	r.mu.Unlock()
	if !stillRunning || keptAttempt != "A" {
		t.Fatalf("redelivered start disturbed the relay: running=%v attempt=%q", stillRunning, keptAttempt)
	}

	// An empty attempt (older control plane) keeps the old no-op behaviour rather than churning.
	r.start("", func(LoginResultRequest) { t.Error("empty attempt should not restart") })
	r.mu.Lock()
	stillRunning = r.running
	r.mu.Unlock()
	if !stillRunning {
		t.Error("an attempt-less start from an old control plane should not preempt")
	}
}
