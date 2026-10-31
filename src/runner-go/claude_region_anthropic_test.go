package main

import (
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// What runner-go sends Anthropic besides a turn while Claude's connection to Anthropic is in a region Anthropic
// doesn't offer Claude in (docs/claude-region-check-contract.md, board 03): no plan-usage read, and no token
// refresh for one; no `claude auth login`; and an `orbit doctor` that says so and offers no Claude sign-in.
// Codex's and Kimi Code's reads and sign-ins go on as before.

// regionAnswerMainlandChina is board 03's answer: a direct connection that comes out in mainland China.
const regionAnswerMainlandChina = `{"verdict":"blocked","country":"CN","regionCode":null,"name":"mainland China","viaProxy":false,"asOf":"2026-10-31"}`

// The sentence a sign-in on atlas is refused with while its connection to Anthropic is in Russia, word for word
// (board 04, contract §12).
const atlasRussiaSignInRefusal = "Claude sign-in isn’t available on atlas: its connection to Anthropic is in Russia, where Anthropic doesn’t offer Claude."

// streamRunnerStdout sends what this process prints to out as it is printed, until the func it returns puts
// stdout back and has copied the last of it. A test can wait on a log line while the loop that prints it runs.
func streamRunnerStdout(t *testing.T, out *syncBuffer) func() {
	t.Helper()
	previous := os.Stdout
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = writer
	copied := make(chan struct{})
	go func() {
		_, _ = io.Copy(out, reader)
		close(copied)
	}()
	var once sync.Once
	restore := func() {
		once.Do(func() {
			os.Stdout = previous
			_ = writer.Close()
			<-copied
			_ = reader.Close()
		})
	}
	t.Cleanup(restore)
	return restore
}

// While Claude's connection to Anthropic is in a region Anthropic doesn't offer Claude in, no account's usage is
// read: the fake usage endpoint gets no request, on any pass, and a token due for refreshing is not refreshed,
// which would talk to Anthropic too. Each account's probe says why once. The first passes on an allowed answer
// read again, the due token refreshed first.
func TestClaudeUsageReadsNothingFromAnthropicWhileBlocked(t *testing.T) {
	isolateClaudeRegionEnv(t)
	home, _ := claudeAccountSlotTestHomes(t)
	previousURL := planUsageURL
	t.Cleanup(func() { planUsageURL = previousURL })
	srv, tokens := claudeUsageServer(t, 12)
	planUsageURL = srv.URL
	refreshes, _ := fakeClaudeTokenCLI(t, "refresh", "fresh-token")
	writeClaudeCredentials(t, filepath.Join(home, ".claude"), "default-token")
	work, err := claudeAccountKind.create("Work")
	if err != nil {
		t.Fatal(err)
	}
	writeClaudeLogin(t, work.Dir, "expired-token", time.Now().Add(-time.Hour))
	stub := newRegionStub(t, regionAnswerBlocked)
	clock := newFakePoolClock()
	installRegionCheck(t, stub, clock)

	var out syncBuffer
	restore := streamRunnerStdout(t, &out)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go newClaudeAccountUsage().runWithIntervals(ctx, func() int { return 1 }, func() bool { return true },
		5*time.Millisecond, 20*time.Millisecond, 20*time.Millisecond)

	defaultBlocked := "claude plan-usage unavailable: " + errClaudeUsageRegionBlocked.Error()
	workBlocked := "claude plan-usage (account " + work.ID + ") unavailable: " + errClaudeUsageRegionBlocked.Error()
	waitFor(t, "both accounts' probes to pass while blocked", func() bool {
		s := out.String()
		return len(tokens()) > 0 || strings.Contains(s, defaultBlocked) && strings.Contains(s, workBlocked)
	})
	if got := tokens(); len(got) != 0 {
		t.Fatalf("the usage endpoint was asked while blocked, with %q", got)
	}
	// More passes while blocked. Each answer is fresh for a minute, so moving the clock past that makes the next
	// pass ask the route again: a check the stub counts is a pass that happened.
	for want := 2; want <= 3; want++ {
		clock.Advance(claudeRegionFreshFor)
		waitFor(t, "another pass while blocked", func() bool { return len(stub.checksSoFar()) >= want })
	}
	if got := tokens(); len(got) != 0 {
		t.Fatalf("the usage endpoint was asked while blocked, with %q", got)
	}
	if got := refreshes(); len(got) != 0 {
		t.Fatalf("claude was run to refresh a token while blocked, for %q", got)
	}

	// Allowed: the next pass asks again and both accounts read, Work's token refreshed in Work's directory.
	stub.setAnswer(regionAnswerAllowed)
	clock.Advance(claudeRegionFreshFor)
	waitFor(t, "both accounts to read again", func() bool {
		got := tokens()
		return slices.Contains(got, "Bearer default-token") && slices.Contains(got, "Bearer fresh-token")
	})
	waitFor(t, "both probes to say they recovered", func() bool {
		s := out.String()
		return strings.Contains(s, "claude plan-usage recovered") &&
			strings.Contains(s, "claude plan-usage (account "+work.ID+") recovered")
	})
	cancel()
	restore()
	if got := refreshes(); !slices.Equal(got, []string{work.Dir}) {
		t.Fatalf("claude refreshed for %q, want once, for Work once allowed", got)
	}
	if slices.Contains(tokens(), "Bearer expired-token") {
		t.Fatal("the expired token was sent")
	}
	logs := out.String()
	for _, line := range []string{defaultBlocked, workBlocked} {
		if n := strings.Count(logs, line); n != 1 {
			t.Fatalf("%q logged %d times, want once:\n%s", line, n, logs)
		}
	}
	if !strings.Contains(logs, "— "+claudeRegionUnsupported) {
		t.Fatalf("the stand-down does not carry %s:\n%s", claudeRegionUnsupported, logs)
	}
}

// A process with no region check of its own reads as it always did.
func TestClaudeUsageReadsWithNoRegionCheck(t *testing.T) {
	isolateClaudeRegionEnv(t)
	home, _ := claudeAccountSlotTestHomes(t)
	previousURL := planUsageURL
	t.Cleanup(func() { planUsageURL = previousURL })
	srv, tokens := claudeUsageServer(t, 12)
	planUsageURL = srv.URL
	writeClaudeCredentials(t, filepath.Join(home, ".claude"), "default-token")
	previous := claudeRegion.Swap(nil)
	t.Cleanup(func() { claudeRegion.Store(previous) })

	if usage := read(t, newClaudeAccountUsage().def); usage == nil || usage.FiveHour == nil {
		t.Fatalf("read %#v", usage)
	}
	if got := tokens(); !slices.Equal(got, []string{"Bearer default-token"}) {
		t.Fatalf("tokens seen = %q", got)
	}
}

// Codex's and Kimi Code's usage reads go to their own services, and the region check is not theirs: they read
// while Claude's connection is in a region Anthropic doesn't offer Claude in, and never ask for a check.
func TestOtherEnginesUsageIsReadWhileClaudeIsBlocked(t *testing.T) {
	isolateClaudeRegionEnv(t)
	stub := newRegionStub(t, regionAnswerBlocked)
	installRegionCheck(t, stub, newFakePoolClock())

	svc := newFakeKimiService(t)
	svc.usagesBody = `{"usages":{"limit_5h":{"used_ratio":0.31,"reset_time":"2026-10-08T17:00:00Z"}}}`
	kimiHome := t.TempDir()
	signInFakeKimi(t, kimiHome, svc, "at-good", "rt-0", time.Now().Add(10*time.Minute).Unix())
	kimi, err := (&kimiUsageRead{}).fetch(context.Background(), svc.Client(), kimiHome)
	if err != nil || kimi.FiveHour == nil || kimi.FiveHour.Utilization != 31 {
		t.Fatalf("Kimi Code's read while Claude is blocked = %#v, %v", kimi, err)
	}
	if got := svc.usages(); !slices.Equal(got, []string{"Bearer at-good"}) {
		t.Fatalf("Kimi Code's usage endpoint saw %q", got)
	}

	fixture := codexResetReadFixture(t, "details-complete")
	newFakeCodexBinary(t, fixture.account, fixture.rateLimits).useAsRunnerDefault(t)
	codex := newCodexAccountUsage(codexResetTestLeaseOwner)
	codexRead, err := codex.def.fetch(context.Background(), codex.def.client)
	if err != nil || codexRead.Primary == nil {
		t.Fatalf("Codex's read while Claude is blocked = %#v, %v", codexRead, err)
	}
	if n := len(stub.checksSoFar()); n != 0 {
		t.Fatalf("other engines' usage reads asked for %d region checks", n)
	}
}

// fakeSignInCLIs puts on PATH, alone, a `claude` and the `script` its sign-in runs under, each recording every run,
// so a test can tell whether a Claude sign-in started anything at all.
func fakeSignInCLIs(t *testing.T) func() []string {
	t.Helper()
	dir := t.TempDir()
	log := filepath.Join(dir, "runs")
	for _, name := range []string{providerClaude, "script"} {
		writeFakeBin(t, dir, name, `echo "`+name+` $*" >> '`+log+`'`)
	}
	t.Setenv("PATH", dir)
	return func() []string {
		b, err := os.ReadFile(log)
		if os.IsNotExist(err) {
			return nil
		}
		if err != nil {
			t.Fatal(err)
		}
		return strings.Split(strings.TrimSpace(string(b)), "\n")
	}
}

// A Claude sign-in while Claude's connection is in a region Anthropic doesn't offer Claude in starts nothing — no
// `claude auth login`, no pty, no account added — and fails at once with the sentence the control plane refuses one
// with: a start for the machine's own login, one from a control plane that names no engine, and one that adds an
// account. On an allowed answer the same start runs the CLI.
func TestClaudeSignInStartsNothingWhileBlocked(t *testing.T) {
	isolateClaudeRegionEnv(t)
	claudeAccountSlotTestHomes(t)
	runs := fakeSignInCLIs(t)
	stub := newRegionStub(t, regionAnswerBlocked)
	clock := newFakePoolClock()
	installRegionCheck(t, stub, clock)

	r := &loginRelay{}
	defer r.stop()
	var reports []LoginResultRequest
	logs := captureRunnerStdout(t, func() {
		for _, lr := range []LoginCommand{
			{Action: "start", Engine: providerClaude, Attempt: "A", Account: accountSlotDefaultID},
			{Action: "start", Attempt: "B"},
			{Action: "start", Engine: providerClaude, Attempt: "C", AccountName: "Work"},
		} {
			r.start(lr, func(res LoginResultRequest) { reports = append(reports, res) })
		}
	})
	if len(reports) != 3 {
		t.Fatalf("reports = %+v, want one for each start, made before start returned", reports)
	}
	for i, attempt := range []string{"A", "B", "C"} {
		if got := reports[i]; got.Status != loginFailed || got.Message != atlasRussiaSignInRefusal || got.Attempt != attempt {
			t.Fatalf("start %s reported %+v, want failed with %q", attempt, got, atlasRussiaSignInRefusal)
		}
	}
	if got := runs(); len(got) != 0 {
		t.Fatalf("a refused sign-in ran %q", got)
	}
	if n := r.inFlight(); n != 0 {
		t.Fatalf("%d sign-ins left running", n)
	}
	if slots, err := claudeAccountKind.list(); err != nil || len(slots) != 1 {
		t.Fatalf("slots = %+v, %v: a refused sign-in added an account", slots, err)
	}
	if want := "login A: claude sign-in refused — " + claudeRegionUnsupported; !strings.Contains(logs, want) {
		t.Fatalf("the runner logged:\n%s\nwant a line %q", logs, want)
	}

	stub.setAnswer(regionAnswerAllowed)
	clock.Advance(claudeRegionFreshFor)
	done := make(chan LoginResultRequest, 1)
	r.start(LoginCommand{Action: "start", Engine: providerClaude, Attempt: "D"}, func(res LoginResultRequest) { done <- res })
	select {
	case <-done:
	case <-time.After(fakeClaudeTimeout):
		t.Fatal("an allowed sign-in reported nothing")
	}
	if got := runs(); len(got) != 1 || !strings.HasPrefix(got[0], "script ") || !strings.Contains(got[0], "claude auth login") {
		t.Fatalf("an allowed sign-in ran %q, want `claude auth login` under script", got)
	}
}

// Codex's and Kimi Code's sign-ins are not Anthropic's: they start, run and finish while Claude's connection is in a
// region Anthropic doesn't offer Claude in, and never ask for a check.
func TestCodexAndKimiSignInWhileClaudeIsBlocked(t *testing.T) {
	isolateClaudeRegionEnv(t)
	stub := newRegionStub(t, regionAnswerBlocked)
	installRegionCheck(t, stub, newFakePoolClock())
	dir := t.TempDir()
	writeFakeBin(t, dir, providerKimi, "exit 0")
	// PATH ends up this directory alone, so the one tool the script uses is named in full.
	sleep, err := exec.LookPath("sleep")
	if err != nil {
		t.Fatal(err)
	}
	// Like the real CLI, it waits a while for the approval after printing the link and code.
	codex := writeFakeBin(t, dir, providerCodex, `if [ "$1 $2" = "login --help" ]; then echo '      --device-auth'; exit 0; fi
if [ "$1 $2" = "login status" ]; then exit 0; fi
if [ "$1 $2" = "login --device-auth" ]; then
  printf '1. Open this link in your browser and sign in to your account\n   https://auth.openai.com/codex/device\n\n'
  printf '2. Enter this one-time code (expires in 15 minutes)\n   ZXHO-K06HC\n'
  '`+sleep+`' 0.5
  exit 0
fi
exit 1`)
	t.Setenv("PATH", dir)
	previous := lookLoginEngine
	lookLoginEngine = func(engine string) (string, bool) {
		if engine == providerCodex {
			return codex, true
		}
		return "", false
	}
	t.Cleanup(func() { lookLoginEngine = previous })

	r := &loginRelay{}
	defer r.stop()
	var mu sync.Mutex
	got := map[string][]LoginResultRequest{}
	for _, engine := range []string{providerCodex, providerKimi} {
		r.start(LoginCommand{Action: "start", Engine: engine, Attempt: engine + "-1"}, func(res LoginResultRequest) {
			mu.Lock()
			got[engine] = append(got[engine], res)
			mu.Unlock()
		})
	}
	waitFor(t, "both sign-ins to finish", func() bool {
		mu.Lock()
		defer mu.Unlock()
		done := func(engine string) bool {
			reports := got[engine]
			return len(reports) > 0 && reports[len(reports)-1].Status != loginAwaitingApproval
		}
		return done(providerCodex) && done(providerKimi)
	})
	mu.Lock()
	defer mu.Unlock()
	if reports := got[providerCodex]; len(reports) != 2 || reports[0].Status != loginAwaitingApproval ||
		reports[0].URL != "https://auth.openai.com/codex/device" || reports[0].UserCode != "ZXHO-K06HC" || reports[1].Status != loginDone {
		t.Fatalf("Codex's sign-in reported %+v, want its link and code, then done", reports)
	}
	if reports := got[providerKimi]; len(reports) != 1 || reports[0].Status != loginDone {
		t.Fatalf("Kimi Code's sign-in reported %+v, want done", reports)
	}
	if n := len(stub.checksSoFar()); n != 0 {
		t.Fatalf("other engines' sign-ins asked for %d region checks", n)
	}
}

// orbit doctor's Claude region section, as board 03 draws it, from a check doctor makes itself, now: one request to
// the route with the runner's own token, direct when Claude uses no proxy. The address under it is the contract's
// source (§2), to which the board's /supported-countries redirects.
func TestDoctorClaudeRegionSectionIsBoard03(t *testing.T) {
	isolateClaudeRegionEnv(t)
	stub := newRegionStub(t, regionAnswerMainlandChina)
	region := checkDoctorRegion(&RunnerConfig{ServerURL: stub.server.URL, RunnerToken: "runner-token", Name: "HPC"})
	want := []string{
		"  Claude's route   mainland China (CN)   direct",
		"  ✗ Anthropic doesn't offer Claude in mainland China.",
		"    Orbit won't use Anthropic accounts or keys here, or start a",
		"    Claude sign-in. Claude Code still runs with other providers' keys.",
		"    https://www.anthropic.com/legal/supported-regions",
	}
	if got := formatDoctorRegion(region); !slices.Equal(got, want) {
		t.Fatalf("section:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	stub.mu.Lock()
	defer stub.mu.Unlock()
	if !slices.Equal(stub.checks, []string{"0"}) || !slices.Equal(stub.tokens, []string{"Bearer runner-token"}) {
		t.Fatalf("doctor's checks = %q with %q, want one direct check with the runner's token", stub.checks, stub.tokens)
	}
}

// The section's other answers: allowed, a region Ukraine is split by, a check through Claude's proxy (named, its
// password hidden), and the three ways a check cannot tell.
func TestDoctorClaudeRegionSectionOtherAnswers(t *testing.T) {
	closed := newRegionStub(t, regionAnswerAllowed)
	closed.server.Close()
	for _, c := range []struct {
		name   string
		answer string
		stub   *regionStub
		proxy  bool
		want   []string
	}{
		{name: "allowed", answer: regionAnswerAllowed, want: []string{
			"  Claude's route   United States (US)   direct",
			"  ✓ Anthropic offers Claude in United States.",
		}},
		{name: "Crimea", answer: `{"verdict":"blocked","country":"UA","regionCode":"UA-43","name":"Crimea","viaProxy":false,"asOf":"2026-10-31"}`, want: []string{
			"  Claude's route   Crimea (UA-43)   direct",
			"  ✗ Anthropic doesn't offer Claude in Crimea.",
			"    Orbit won't use Anthropic accounts or keys here, or start a",
			"    Claude sign-in. Claude Code still runs with other providers' keys.",
			"    https://www.anthropic.com/legal/supported-regions",
		}},
		{name: "through Claude's proxy", answer: regionAnswerAllowed, proxy: true, want: []string{
			"  Claude's route   United States (US)   through the proxy http://orbit:xxxxx@PROXY",
			"  ✓ Anthropic offers Claude in United States.",
		}},
		{name: "the server cannot tell", answer: regionAnswerUnknown, want: []string{
			"  Claude's route   unknown   direct",
			"  ⚠ The server couldn't tell where Claude's connection comes out.",
			"    A check that can't tell never stops Claude Code.",
		}},
		{name: "a server without the route", answer: regionAnswerNotFound, want: []string{
			"  Claude's route   unknown   direct",
			"  ⚠ This server has no region check yet.",
			"    A check that can't tell never stops Claude Code.",
		}},
		{name: "no answer", stub: closed, want: []string{
			"  Claude's route   unknown   direct",
			"  ⚠ The check failed: ",
			"    A check that can't tell never stops Claude Code.",
		}},
	} {
		t.Run(c.name, func(t *testing.T) {
			isolateClaudeRegionEnv(t)
			stub := c.stub
			if stub == nil {
				stub = newRegionStub(t, c.answer)
			}
			want := c.want
			if c.proxy {
				proxy := newForwardProxy(t)
				host := strings.TrimPrefix(proxy.server.URL, "http://")
				t.Setenv("HTTPS_PROXY", "http://orbit:hunter2@"+host)
				want = slices.Clone(want)
				want[0] = strings.Replace(want[0], "PROXY", host, 1)
				defer func() {
					if n := len(proxy.requests()); n != 1 {
						t.Errorf("the check went through Claude's proxy %d times, want once", n)
					}
				}()
			}
			got := formatDoctorRegion(checkDoctorRegion(&RunnerConfig{ServerURL: stub.server.URL, RunnerToken: "runner-token", Name: "atlas"}))
			if c.stub == closed {
				// The failure's own words follow the prefix; they are the transport's, not ours to pin.
				if len(got) == 3 && strings.HasPrefix(got[1], want[1]) && len(got[1]) > len(want[1]) {
					got[1] = want[1]
				}
			}
			if !slices.Equal(got, want) {
				t.Fatalf("section:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
			}
			if strings.Contains(strings.Join(got, "\n"), "hunter2") {
				t.Fatal("the proxy's password reached the section")
			}
		})
	}
}

// fakeDoctorEngines stands Claude Code, Codex and Kimi Code in for the machine's engines, all signed out, under
// executable names no real install has, so doctor finds only these. Each records what doctor runs that is not one
// of its probes: the sign-in.
func fakeDoctorEngines(t *testing.T) func() []string {
	t.Helper()
	dir := t.TempDir()
	log := filepath.Join(dir, "runs")
	writeFakeBin(t, dir, "orbit-doctor-test-claude", `if [ "$1" = "--version" ]; then echo 2.1.302; exit 0; fi
if [ "$1 $2" = "auth status" ]; then echo '{"loggedIn":false}'; exit 0; fi
echo "claude $*" >> '`+log+`'`)
	writeFakeBin(t, dir, "orbit-doctor-test-codex", `if [ "$1" = "--version" ]; then echo 'codex-cli 0.164.0'; exit 0; fi
if [ "$1 $2" = "login status" ]; then exit 1; fi
echo "codex $*" >> '`+log+`'`)
	writeFakeBin(t, dir, "orbit-doctor-test-kimi", `if [ "$1" = "--version" ]; then echo 2.1.4; exit 0; fi
if [ "$1" = "acp" ] || [ "$1" = "provider" ]; then exit 1; fi
echo "kimi $*" >> '`+log+`'`)
	t.Setenv("PATH", dir)
	previous := engineSpecs
	engineSpecs = []engineSpec{
		{name: "Claude Code", bin: providerClaude, exe: "orbit-doctor-test-claude", loginArgs: []string{"auth", "login"}, loginHeadless: "claude setup-token"},
		{name: "Codex", bin: providerCodex, exe: "orbit-doctor-test-codex", loginArgs: []string{"login"}, loginHeadless: "codex login --device-auth"},
		{name: "Kimi Code", bin: providerKimi, exe: "orbit-doctor-test-kimi", loginArgs: []string{"login"}, loginHeadless: "kimi login"},
	}
	t.Cleanup(func() { engineSpecs = previous })
	return func() []string {
		b, err := os.ReadFile(log)
		if os.IsNotExist(err) {
			return nil
		}
		if err != nil {
			t.Fatal(err)
		}
		return strings.Split(strings.TrimSpace(string(b)), "\n")
	}
}

// orbit doctor in interactive mode offers to sign in every engine that is not signed in — but not Claude Code while
// its region check found Claude's connection where Anthropic doesn't offer Claude. Claude's line says so, no hint
// suggests a Claude sign-in, and Codex and Kimi Code are offered theirs as before.
func TestDoctorOffersNoClaudeSignInWhileBlocked(t *testing.T) {
	isolateClaudeRegionEnv(t)
	previous := doctorInteractive
	doctorInteractive = func() bool { return true }
	t.Cleanup(func() { doctorInteractive = previous })
	for _, c := range []struct {
		name    string
		blocked bool
		line    string
		ran     []string
	}{
		{"blocked", true, "  ✗ Claude Code (2.1.302) — Anthropic: region not supported\n", []string{"codex login", "kimi login"}},
		{"allowed", false, "  ✓ Claude Code (2.1.302)  ⚠ not signed in\n", []string{"claude auth login", "codex login", "kimi login"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			ran := fakeDoctorEngines(t)
			out := captureRunnerStdout(t, func() { runDoctor(nil, c.blocked) })
			if !strings.Contains(out, c.line) {
				t.Fatalf("doctor printed:\n%s\nwant the line %q", out, c.line)
			}
			if got := ran(); !slices.Equal(got, c.ran) {
				t.Fatalf("doctor ran %q, want %q", got, c.ran)
			}
			for _, engine := range []string{"codex", "kimi"} {
				if !strings.Contains(out, "running: orbit-doctor-test-"+engine+" login\n") {
					t.Fatalf("doctor did not offer the %s sign-in:\n%s", engine, out)
				}
			}
			claudeHint := "Claude Code:  orbit-doctor-test-claude auth login"
			if c.blocked && strings.Contains(out, "orbit-doctor-test-claude auth login") {
				t.Fatalf("doctor suggested a Claude sign-in while blocked:\n%s", out)
			}
			if !c.blocked && !strings.Contains(out, claudeHint) {
				t.Fatalf("doctor did not suggest the Claude sign-in while allowed:\n%s", out)
			}
		})
	}
}

// The Claude line and the hints while blocked: a PATH warning still says what it says, a blocked Claude Code is
// not "all set", and a missing one is told how to install but not how to sign in.
func TestDoctorClaudeLineAndHintsWhileBlocked(t *testing.T) {
	claude, _ := specFor(providerClaude)
	if got, want := formatEngineLine(engineHealth{spec: claude, installed: true, version: "2.1.302", auth: authYes, onServicePath: true, regionBlocked: true}),
		"✗ Claude Code (2.1.302) — Anthropic: region not supported"; got != want {
		t.Fatalf("line = %q, want %q", got, want)
	}
	if got, want := formatEngineLine(engineHealth{spec: claude, installed: true, auth: authNo, regionBlocked: true}),
		"✗ Claude Code (installed) — Anthropic: region not supported  ⚠ not on service PATH"; got != want {
		t.Fatalf("line = %q, want %q", got, want)
	}
	if got := formatEngineLine(engineHealth{spec: claude, regionBlocked: true}); got != "✗ Claude Code — not installed" {
		t.Fatalf("a missing Claude Code reads %q", got)
	}

	signedIn := engineHealth{spec: claude, installed: true, version: "2.1.302", auth: authYes, onServicePath: true}
	if out := captureRunnerStdout(t, func() { printEngineHints([]engineHealth{signedIn}) }); !strings.Contains(out, "All set") {
		t.Fatalf("allowed, a signed-in Claude Code is all set:\n%s", out)
	}
	signedIn.regionBlocked = true
	if out := captureRunnerStdout(t, func() { printEngineHints([]engineHealth{signedIn}) }); out != "" {
		t.Fatalf("blocked, the hints printed:\n%s\nwant nothing: the region section says why", out)
	}
	missing := engineHealth{spec: claude, regionBlocked: true}
	out := captureRunnerStdout(t, func() { printEngineHints([]engineHealth{missing}) })
	if !strings.Contains(out, claude.installCmd) || strings.Contains(out, "sign in:") {
		t.Fatalf("a missing Claude Code while blocked got:\n%s\nwant its install, and no sign-in", out)
	}
}

// The runner's words are the contract's: the sign-in refusal of §12, and the supported list's source address,
// which @orbit/shared holds.
func TestClaudeRegionSignInWordsAreTheContracts(t *testing.T) {
	contract, err := os.ReadFile(filepath.Join("..", "..", "docs", "claude-region-check-contract.md"))
	if err != nil {
		t.Fatal(err)
	}
	if want := "`" + claudeSignInRefusedMessage("{machine}", "{region}") + "`"; !strings.Contains(string(contract), want) {
		t.Fatalf("the contract does not refuse a sign-in as the runner does: %s", want)
	}
	if got := claudeSignInRefusedMessage("atlas", "Russia"); got != atlasRussiaSignInRefusal {
		t.Fatalf("refusal = %q", got)
	}
	// The control plane refuses a sign-in at dispatch in the same words (runner-region.ts).
	server, err := os.ReadFile(filepath.Join("..", "apiserver", "src", "runners", "runner-region.ts"))
	if err != nil {
		t.Fatal(err)
	}
	if want := "return `" + claudeSignInRefusedMessage("${machine}", "${region}") + "`;"; !strings.Contains(string(server), want) {
		t.Fatalf("the control plane does not refuse a sign-in as the runner does: %s", want)
	}
	regions, err := os.ReadFile(filepath.Join("..", "shared", "src", "claude-regions.ts"))
	if err != nil {
		t.Fatal(err)
	}
	if want := "CLAUDE_REGIONS_SOURCE_URL = '" + claudeRegionsSourceURL + "'"; !strings.Contains(string(regions), want) {
		t.Fatalf("@orbit/shared does not say %s", want)
	}
}
