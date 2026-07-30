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

// A rejected code makes the CLI re-prompt with a NEW url — the old challenge/state are spent —
// so the retry the user is shown must be the newest one, not the first.
func TestLatestLoginURLPrefersTheNewest(t *testing.T) {
	first := "https://claude.com/cai/oauth/authorize?code=true&state=OLD&code_challenge=aaa"
	second := "https://claude.com/cai/oauth/authorize?code=true&state=NEW&code_challenge=bbb"
	out := "Paste code here if prompted > \r\n" + first + "\r\nbad code\r\n" +
		"If the browser didn't open, visit: " + second + "\r\nPaste code here if prompted > "
	got := latestLoginURL(out)
	if got != second {
		t.Fatalf("latestLoginURL = %q, want the newest %q", got, second)
	}
	// And the re-prompt is the only rejection signal there is.
	if strings.Count(out, loginPromptMarker) != 2 {
		t.Fatalf("prompt marker %q no longer counts re-prompts", loginPromptMarker)
	}
}
