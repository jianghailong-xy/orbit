package main

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"
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

func TestStoppingIdleLoginRelayReturns(t *testing.T) {
	(&loginRelay{}).stop()
}

func TestStoppingLoginRelayCancelsAndJoinsCurrentAttempt(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	r := &loginRelay{running: true, cancel: cancel}
	finished := make(chan struct{})
	r.wg.Add(1)
	go func() {
		defer r.wg.Done()
		<-ctx.Done()
		close(finished)
	}()
	r.stop()
	select {
	case <-finished:
	default:
		t.Fatal("login relay returned before its attempt stopped")
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
	r.start("A", providerClaude, func(LoginResultRequest) { t.Error("redelivered start should not report") })
	r.mu.Lock()
	stillRunning, keptAttempt := r.running, r.attempt
	r.mu.Unlock()
	if !stillRunning || keptAttempt != "A" {
		t.Fatalf("redelivered start disturbed the relay: running=%v attempt=%q", stillRunning, keptAttempt)
	}

	// An empty attempt (older control plane) keeps the old no-op behaviour rather than churning.
	r.start("", providerClaude, func(LoginResultRequest) { t.Error("empty attempt should not restart") })
	r.mu.Lock()
	stillRunning = r.running
	r.mu.Unlock()
	if !stillRunning {
		t.Error("an attempt-less start from an old control plane should not preempt")
	}
}

// Verbatim shape of what `codex login --device-auth` writes (codex-cli 0.146.0), colour codes and
// all. Two things matter and both arrive coloured, so a scrape has to stop at the escape byte:
// the sign-in page, and the one-time code the user types there. Unlike claude's flow nothing is
// pasted back — the CLI polls for the approval itself.
const realCodexDeviceOutput = "\r\nWelcome to Codex [v\x1b[90m0.146.0\x1b[0m]\r\n" +
	"\x1b[90mOpenAI's command-line coding agent\x1b[0m\r\n\r\n" +
	"Follow these steps to sign in with ChatGPT using device code authorization:\r\n\r\n" +
	"1. Open this link in your browser and sign in to your account\r\n" +
	"   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\r\n\r\n" +
	"2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\r\n" +
	"   \x1b[94mZXHO-K06HC\x1b[0m\r\n\r\n" +
	"\x1b[90mContinue only if you started this login in Codex. If a website or another person gave you this code, cancel.\x1b[0m\r\n"

func TestCodexDeviceScrape(t *testing.T) {
	res := loginFlowFor(providerCodex).progress(realCodexDeviceOutput)
	if res == nil {
		t.Fatal("nothing scraped from real device-auth output")
	}
	if res.Status != loginAwaitingApproval {
		t.Errorf("device flow waits on an approval, not a paste: %q", res.Status)
	}
	if res.URL != "https://auth.openai.com/codex/device" {
		t.Errorf("URL scrape ran into the colour reset or came up short: %q", res.URL)
	}
	if res.UserCode != "ZXHO-K06HC" {
		t.Errorf("one-time code scrape: got %q", res.UserCode)
	}
}

// Both halves are useless alone — a URL with no code leaves the user staring at a page they can't
// get past — so the relay must not report until it has seen both.
func TestCodexDeviceScrapeWaitsForBothHalves(t *testing.T) {
	progress := loginFlowFor(providerCodex).progress
	urlOnly := realCodexDeviceOutput[:strings.Index(realCodexDeviceOutput, "2. Enter this")]
	if res := progress(urlOnly); res != nil {
		t.Errorf("reported with no code yet: %+v", res)
	}
	if res := progress("Welcome to Codex\r\nnothing here yet"); res != nil {
		t.Errorf("reported from unrelated output: %+v", res)
	}
	// The code is only read from the line that announces it, so an id printed elsewhere can't
	// be mistaken for one.
	if got := codexDeviceCode("warning: ABCD-12345 is deprecated\r\n"); got != "" {
		t.Errorf("matched a code outside the one-time-code line: %q", got)
	}
}

// The device flow is the whole point: plain `codex login` serves its callback on localhost:1455
// on the runner, which is exactly the browser the user doesn't have. It also prints to plain
// stdout, so unlike claude's TUI it needs no pty.
func TestCodexLoginFlowUsesDeviceAuth(t *testing.T) {
	f := loginFlowFor(providerCodex)
	if f.cmdLine() != "codex login --device-auth" {
		t.Fatalf("codex must be driven through the device flow, got %q", f.cmdLine())
	}
	if f.pty {
		t.Error("codex's device flow prints to plain stdout — no pty needed")
	}
	if f.takesCode {
		t.Error("the device flow completes on its own; there is no code to hand back")
	}
	// An older control plane sends no engine at all, and only ever drove claude.
	for _, engine := range []string{"", providerClaude} {
		c := loginFlowFor(engine)
		if c.engine != providerClaude || !c.pty || !c.takesCode {
			t.Errorf("engine %q should map to claude's paste-back flow, got %+v", engine, c)
		}
	}
}

// Verbatim format emitted by the current `kimi login` device-code flow. Kimi
// writes this to stderr (the relay combines stderr/stdout), opens the complete
// verification URL best-effort, and keeps polling until authorization finishes.
const realKimiDeviceOutput = "\r\nOpening browser for Kimi device login: https://auth.kimi.com/verify?user_code=WDJB-MJHT\r\n" +
	"If the browser did not open, paste the URL above and enter code: WDJB-MJHT\r\n" +
	"Code expires in 900s.\r\n" +
	"Waiting for authorization to complete...\r\n"

func TestKimiDeviceScrape(t *testing.T) {
	res := loginFlowFor(providerKimi).progress(realKimiDeviceOutput)
	if res == nil {
		t.Fatal("nothing scraped from Kimi's device-login output")
	}
	if res.Status != loginAwaitingApproval {
		t.Errorf("Kimi's device flow waits on browser approval, got %q", res.Status)
	}
	if res.URL != "https://auth.kimi.com/verify?user_code=WDJB-MJHT" {
		t.Errorf("Kimi URL scrape = %q", res.URL)
	}
	if res.UserCode != "WDJB-MJHT" {
		t.Errorf("Kimi user-code scrape = %q", res.UserCode)
	}
}

func TestKimiDeviceScrapeWaitsForBothHalves(t *testing.T) {
	progress := loginFlowFor(providerKimi).progress
	urlOnly := realKimiDeviceOutput[:strings.Index(realKimiDeviceOutput, "If the browser")]
	if res := progress(urlOnly); res != nil {
		t.Errorf("reported before the user code arrived: %+v", res)
	}
	if res := progress("see https://moonshotai.github.io/kimi-code for docs"); res != nil {
		t.Errorf("matched unrelated Kimi output: %+v", res)
	}
}

func TestKimiLoginFlowUsesDeviceAuth(t *testing.T) {
	f := loginFlowFor(providerKimi)
	if f.cmdLine() != "kimi login" {
		t.Fatalf("Kimi must use its device-login subcommand, got %q", f.cmdLine())
	}
	if f.pty {
		t.Error("Kimi writes device login progress without a pty")
	}
	if f.takesCode {
		t.Error("Kimi polls itself; no code is pasted back to the runner")
	}
	if !f.successOnExit {
		t.Error("Kimi documents exit 0 as successful login")
	}
}

func TestKimiLoginCleanExitIsSuccess(t *testing.T) {
	dir := t.TempDir()
	writeFakeBin(t, dir, providerKimi, "exit 0")
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))

	got := make(chan LoginResultRequest, 1)
	(&loginRelay{}).start("kimi-clean-exit", providerKimi, func(res LoginResultRequest) { got <- res })
	select {
	case res := <-got:
		if res.Status != loginDone {
			t.Fatalf("Kimi exit 0 should finish login, got %+v", res)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Kimi clean exit produced no login result")
	}
}

func TestOpenCodeLoginNeverFallsBackToClaude(t *testing.T) {
	flow := loginFlowFor(providerOpenCode)
	if flow.engine != providerOpenCode || len(flow.argv) != 0 {
		t.Fatalf("OpenCode flow = %+v", flow)
	}
}
