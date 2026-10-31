package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The runner's own one-shot claude starts while Claude's connection to Anthropic is in a region Anthropic doesn't
// offer Claude in (claudeStartBlocked, docs/claude-region-check-contract.md): a commit message, a transcript summary,
// the slash-command registry and the model catalog. Each starts nothing while blocked and its caller takes the
// fallback it already had; each starts again once allowed; and a machine whose own Claude Code talks to DeepSeek
// keeps them, blocked or not, since that claude does not talk to Anthropic (owner decision ①).

const deepseekBaseURL = "https://api.deepseek.com/anthropic"

// fakeOwnClaude puts first on PATH a claude that records each start and answers each of the four as the real CLI
// does, keeps git reachable for the commit case, and names the same claude as the commit-message engine. It returns
// how many times claude has been started.
func fakeOwnClaude(t *testing.T) func() int {
	t.Helper()
	dir := t.TempDir()
	log := filepath.Join(dir, "starts")
	writeFakeBin(t, dir, providerClaude, `echo start >> '`+log+`'
for arg in "$@"; do
  case "$arg" in
    "/model opus") echo "Set model to Opus 5 for this session only"; exit 0 ;;
    "/model fable") echo "Set model to Fable 5 for this session only"; exit 0 ;;
    "/model sonnet") echo "Set model to Sonnet 5 for this session only"; exit 0 ;;
    "/model haiku") echo "Set model to Haiku 4.5 for this session only"; exit 0 ;;
    /help) echo '{"type":"system","subtype":"init","slash_commands":["loop","clear"],"skills":["loop"]}'; exit 0 ;;
  esac
done
case "$*" in
  *"Generate a git commit message"*) echo "feat: written by claude"; exit 0 ;;
  *"no longer fits in the context window"*) echo "A summary written by claude"; exit 0 ;;
esac
exit 2`)
	git, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+filepath.Dir(git))
	previous := commitMsgEngine
	commitMsgEngine = providerClaude
	t.Cleanup(func() { commitMsgEngine = previous })
	return func() int {
		b, err := os.ReadFile(log)
		if os.IsNotExist(err) {
			return 0
		}
		if err != nil {
			t.Fatal(err)
		}
		return strings.Count(string(b), "start\n")
	}
}

// ownClaudeStart is one of the runner's own claude starts, driven through its caller: run reports whether what the
// caller got came from claude, and fails the test when it is neither that nor the caller's own fallback.
type ownClaudeStart struct {
	name string
	run  func(t *testing.T) bool
}

var ownClaudeStarts = []ownClaudeStart{
	{"commit message", func(t *testing.T) bool {
		repo := initRepo(t)
		if err := os.WriteFile(filepath.Join(repo, "login.go"), []byte("package login\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		mustGit(t, repo, "add", "login.go")
		const fallback = "Update login.go"
		switch got := generateCommitMessage(repo, fallback); got {
		case "feat: written by claude":
			return true
		case fallback:
			return false
		default:
			t.Fatalf("commit message = %q", got)
			return false
		}
	}},
	{"transcript summary", func(t *testing.T) bool {
		head := []replayMessage{{role: "user", blocks: []map[string]interface{}{{"type": "text", "text": "Fix the flaky login test"}}, tokens: 8}}
		digest := replayDigest(head, transcriptSummaryInputTokenBudget)
		switch got := summarizeReplayHead(context.Background(), head); got {
		case "A summary written by claude":
			return true
		case digest:
			return false
		default:
			t.Fatalf("summary = %q", got)
			return false
		}
	}},
	{"slash-command registry", func(t *testing.T) bool {
		previous := slashReg
		slashReg = newSlashRegistry(filepath.Join(t.TempDir(), "reg.json"))
		defer func() { slashReg = previous }()
		learned := ensureClaudeSlashRegistry(context.Background())
		if commands, _ := slashReg.extras(nil); learned != (len(commands) > 0) {
			t.Fatalf("learned = %v, but the registry holds %v", learned, names(commands))
		}
		return learned
	}},
	{"model catalog", func(t *testing.T) bool {
		// What a refresh round leaves behind: the catalog it had, unless this round read a new one.
		had := &ModelCatalog{Claude: []ModelInfo{{Value: "claude-opus-4-8", Label: "Opus 4.8"}}}
		var logged []string
		next, signedOut := readModelCatalog(context.Background(), []catalogRuntime{{providerClaude, claudeCLIAvailable, fetchClaudeModelCatalog}},
			func(string) bool { return false }, func(args ...interface{}) {
				for _, a := range args {
					if s, ok := a.(string); ok {
						logged = append(logged, s)
					}
				}
			})
		merged := mergeModelCatalog(had, next, signedOut)
		switch {
		case len(merged.Claude) == 4 && merged.Claude[0].Value == "claude-opus-5":
			return true
		case len(merged.Claude) == 1 && merged.Claude[0].Value == "claude-opus-4-8":
			return false
		default:
			t.Fatalf("catalog = %#v (logged %q)", merged.Claude, logged)
			return false
		}
	}},
}

// Blocked, none of the four starts claude and each caller takes its fallback; a process environment that points
// Claude Code at DeepSeek still starts while blocked; and once allowed, each starts again.
func TestOwnClaudeStartsWaitOnTheRegion(t *testing.T) {
	for _, c := range ownClaudeStarts {
		t.Run(c.name, func(t *testing.T) {
			isolateClaudeRegionEnv(t)
			privateOrbitHome(t)
			starts := fakeOwnClaude(t)
			stub := newRegionStub(t, regionAnswerBlocked)
			clock := newFakePoolClock()
			installRegionCheck(t, stub, clock)

			var usedClaude bool
			captureRunnerStdout(t, func() { usedClaude = c.run(t) })
			if usedClaude || starts() != 0 {
				t.Fatalf("blocked: claude started %d times (caller used it: %v), want none and the fallback", starts(), usedClaude)
			}

			t.Setenv("ANTHROPIC_BASE_URL", deepseekBaseURL)
			captureRunnerStdout(t, func() { usedClaude = c.run(t) })
			if !usedClaude || starts() == 0 {
				t.Fatalf("blocked, Claude Code on DeepSeek: claude started %d times (caller used it: %v), want it started", starts(), usedClaude)
			}
			t.Setenv("ANTHROPIC_BASE_URL", "")

			stub.setAnswer(regionAnswerAllowed)
			clock.Advance(claudeRegionFreshFor)
			before := starts()
			captureRunnerStdout(t, func() { usedClaude = c.run(t) })
			if !usedClaude || starts() == before {
				t.Fatalf("allowed: claude started %d more times (caller used it: %v), want it started", starts()-before, usedClaude)
			}
		})
	}
}

// The rule itself: blocked and Anthropic-bound, read from the process environment and the env of the runner's own
// settings.json the way a turn's is (claudeTurnIsAnthropicBound); nothing in a process with no check.
func TestClaudeStartBlockedGoesByTheProcessEnvironment(t *testing.T) {
	dir := isolateClaudeRegionEnv(t)
	previous := claudeRegion.Swap(nil)
	t.Cleanup(func() { claudeRegion.Store(previous) })
	if claudeStartBlocked(context.Background(), nil) {
		t.Fatal("a process with no region check gated a start")
	}
	stub := newRegionStub(t, regionAnswerBlocked)
	clock := newFakePoolClock()
	installRegionCheck(t, stub, clock)
	for _, c := range []struct {
		name     string
		process  map[string]string
		settings map[string]interface{}
		want     bool
	}{
		{"Claude Code's own sign-in", nil, nil, true},
		{"DeepSeek in the process environment", map[string]string{"ANTHROPIC_BASE_URL": deepseekBaseURL}, nil, false},
		{"DeepSeek in settings.json", nil, map[string]interface{}{"ANTHROPIC_BASE_URL": deepseekBaseURL}, false},
		{"Bedrock in settings.json", nil, map[string]interface{}{"CLAUDE_CODE_USE_BEDROCK": "1"}, false},
		{"Anthropic named in settings.json", nil, map[string]interface{}{"ANTHROPIC_BASE_URL": "https://api.anthropic.com"}, true},
	} {
		for _, key := range []string{"ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK"} {
			t.Setenv(key, c.process[key])
		}
		writeClaudeSettingsEnv(t, dir, c.settings)
		if got := claudeStartBlocked(context.Background(), nil); got != c.want {
			t.Errorf("%s: claudeStartBlocked = %v, want %v", c.name, got, c.want)
		}
	}
	writeClaudeSettingsEnv(t, dir, nil)
	stub.setAnswer(regionAnswerAllowed)
	clock.Advance(claudeRegionFreshFor)
	if claudeStartBlocked(context.Background(), nil) {
		t.Fatal("allowed, a start was gated")
	}
}

// writeClaudeTokenOnly keeps in dir an OAuth login with an access token and no refresh token: one the credentials file
// cannot answer for by itself (claudeStoredSignedIn), so `claude auth status` is what would be asked about it.
func writeClaudeTokenOnly(t *testing.T, dir string) {
	t.Helper()
	body := `{"claudeAiOauth":{"accessToken":"sk-ant-oat01-orbit-test","refreshToken":"","subscriptionType":"max"}}`
	if err := os.WriteFile(filepath.Join(dir, ".credentials.json"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

// countLines is how many lines file holds: none while it does not exist.
func countLines(t *testing.T, file string) int {
	t.Helper()
	b, err := os.ReadFile(file)
	if os.IsNotExist(err) {
		return 0
	}
	if err != nil {
		t.Fatal(err)
	}
	return strings.Count(string(b), "\n")
}

// `claude auth status` sends a stored login to Anthropic as it answers (GET /api/oauth/profile, measured), so while
// blocked it is not asked about one, for the runner's own login or an added account's, and the answer is unknown. With
// no login to send it is asked, blocked or not; so it is for Claude Code on DeepSeek, and once allowed.
func TestClaudeAuthStatusWaitsOnTheRegionWithALoginToSend(t *testing.T) {
	dir := isolateClaudeRegionEnv(t)
	bin := t.TempDir()
	runs := filepath.Join(bin, "runs")
	claude := writeFakeBin(t, bin, providerClaude, `echo "$*" >> '`+runs+`'
echo '{"loggedIn":true}'`)
	stub := newRegionStub(t, regionAnswerBlocked)
	clock := newFakePoolClock()
	installRegionCheck(t, stub, clock)
	ask := func(want authState, wantRuns int, what string) {
		t.Helper()
		if got := probeAuthIn(context.Background(), providerClaude, claude, nil); got != want || countLines(t, runs) != wantRuns {
			t.Fatalf("%s: auth = %v after %d runs of claude, want %v after %d", what, got, countLines(t, runs), want, wantRuns)
		}
	}

	ask(authYes, 1, "blocked, no login stored")
	writeClaudeTokenOnly(t, dir)
	ask(authUnknown, 1, "blocked, a login stored")
	account := t.TempDir()
	writeClaudeTokenOnly(t, account)
	if got := claudeSlotLoginStatus(context.Background(), claude, account); got != authUnknown || countLines(t, runs) != 1 {
		t.Fatalf("blocked, an added account's login: auth = %v after %d runs, want unknown and no run", got, countLines(t, runs))
	}
	if err := os.Remove(filepath.Join(dir, ".credentials.json")); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-orbit-test")
	ask(authUnknown, 1, "blocked, a token in the environment")
	t.Setenv("ANTHROPIC_BASE_URL", deepseekBaseURL)
	ask(authYes, 2, "blocked, Claude Code on DeepSeek")
	t.Setenv("ANTHROPIC_BASE_URL", "")
	stub.setAnswer(regionAnswerAllowed)
	clock.Advance(claudeRegionFreshFor)
	ask(authYes, 3, "allowed, a token in the environment")
}

// `claude update` sends the login stored here to Anthropic (measured), so while blocked it does not run where there
// is one, and the record says why. With no login it runs, blocked or not; so it does for Claude Code on DeepSeek,
// and once allowed.
func TestClaudeUpdateWaitsOnTheRegionWithALoginToSend(t *testing.T) {
	dir := isolateClaudeRegionEnv(t)
	t.Setenv("ORBIT_HOME", t.TempDir())
	svc := t.TempDir()
	writeFakeBin(t, svc, providerClaude, `echo '2.1.226 (Claude Code)'`)
	feed := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("2.1.228")) }))
	t.Cleanup(feed.Close)
	runs := filepath.Join(t.TempDir(), "runs")
	spec := engineSpec{name: "Claude Code", bin: providerClaude, updateCmd: "echo update >> '" + runs + "'", latestURL: feed.URL}
	stub := newRegionStub(t, regionAnswerBlocked)
	clock := newFakePoolClock()
	installRegionCheck(t, stub, clock)
	update := func() EngineUpdateReport {
		t.Helper()
		var rec EngineUpdateReport
		captureRunnerStdout(t, func() { rec, _ = updateEngine(context.Background(), spec, svc, nil) })
		return rec
	}

	writeClaudeLogin(t, dir, "sk-ant-oat01-orbit-test", time.Now().Add(time.Hour))
	if rec := update(); rec.Status != updateSkipped || rec.Message != claudeUpdateSkippedDetail("Russia") || countLines(t, runs) != 0 {
		t.Fatalf("blocked, a login stored: %+v after %d runs, want skipped with %q and no run", rec, countLines(t, runs), claudeUpdateSkippedDetail("Russia"))
	}
	t.Setenv("ANTHROPIC_BASE_URL", deepseekBaseURL)
	if update(); countLines(t, runs) != 1 {
		t.Fatalf("blocked, Claude Code on DeepSeek: the updater ran %d times, want once", countLines(t, runs))
	}
	t.Setenv("ANTHROPIC_BASE_URL", "")
	if err := os.Remove(filepath.Join(dir, ".credentials.json")); err != nil {
		t.Fatal(err)
	}
	if update(); countLines(t, runs) != 2 {
		t.Fatalf("blocked, no login stored: the updater ran %d times in all, want twice", countLines(t, runs))
	}
	writeClaudeLogin(t, dir, "sk-ant-oat01-orbit-test", time.Now().Add(time.Hour))
	stub.setAnswer(regionAnswerAllowed)
	clock.Advance(claudeRegionFreshFor)
	if update(); countLines(t, runs) != 3 {
		t.Fatalf("allowed, a login stored: the updater ran %d times in all, want three", countLines(t, runs))
	}
}

// Claude Code's installer sends the login stored here to Anthropic (its `claude install`, measured), so while blocked
// neither the Install button nor a session's on-demand install runs it where there is one: each answers with why.
// With no login it runs, blocked or not, which keeps a fresh machine able to run Claude Code on another provider's
// key; and it runs once allowed.
func TestClaudeInstallWaitsOnTheRegionWithALoginToSend(t *testing.T) {
	dir := isolateClaudeRegionEnv(t)
	t.Setenv("ORBIT_HOME", t.TempDir())
	runs := filepath.Join(t.TempDir(), "runs")
	previous := engineSpecs
	engineSpecs = []engineSpec{{name: "Claude Code", bin: providerClaude, exe: "orbit-test-claude-not-installed", installCmd: "echo install >> '" + runs + "'"}}
	t.Cleanup(func() { engineSpecs = previous })
	engineInstall.mu.Lock()
	allowed, proxies := engineInstall.allowed, engineInstall.proxyVars
	engineInstall.mu.Unlock()
	configureEngineInstall(true, nil)
	t.Cleanup(func() { configureEngineInstall(allowed, proxies) })
	stub := newRegionStub(t, regionAnswerBlocked)
	clock := newFakePoolClock()
	installRegionCheck(t, stub, clock)
	install := func() (InstallResultRequest, string) {
		t.Helper()
		var res InstallResultRequest
		var msg string
		captureRunnerStdout(t, func() {
			res = installEngineNow(engineSpecs[0])
			msg = ensureEngine(context.Background(), providerClaude, func(string) {})
		})
		return res, msg
	}

	writeClaudeLogin(t, dir, "sk-ant-oat01-orbit-test", time.Now().Add(time.Hour))
	refusal := claudeInstallRefusedMessage("atlas", "Russia")
	if res, msg := install(); res.Status != installFailed || res.Message != refusal || msg != refusal || countLines(t, runs) != 0 {
		t.Fatalf("blocked, a login stored: Install = %+v, on demand = %q, after %d installer runs; want both refused with %q and no run",
			res, msg, countLines(t, runs), refusal)
	}
	if err := os.Remove(filepath.Join(dir, ".credentials.json")); err != nil {
		t.Fatal(err)
	}
	if install(); countLines(t, runs) != 2 {
		t.Fatalf("blocked, no login stored: the installer ran %d times, want once for each", countLines(t, runs))
	}
	writeClaudeLogin(t, dir, "sk-ant-oat01-orbit-test", time.Now().Add(time.Hour))
	stub.setAnswer(regionAnswerAllowed)
	clock.Advance(claudeRegionFreshFor)
	if install(); countLines(t, runs) != 4 {
		t.Fatalf("allowed, a login stored: the installer ran %d times in all, want four", countLines(t, runs))
	}
}

// orbit doctor goes by its own answer as the runner goes by its check: made the process's check (cmdDoctor), a blocked
// answer keeps the engine probe's `claude auth status` from sending a stored login, and asks the route no second time.
func TestDoctorRegionIsTheProcessesCheck(t *testing.T) {
	dir := isolateClaudeRegionEnv(t)
	stub := newRegionStub(t, regionAnswerMainlandChina)
	region := checkDoctorRegion(&RunnerConfig{ServerURL: stub.server.URL, RunnerToken: "runner-token", Name: "HPC"})
	previous := claudeRegion.Swap(region.check)
	t.Cleanup(func() { claudeRegion.Store(previous) })
	writeClaudeTokenOnly(t, dir)
	bin := t.TempDir()
	runs := filepath.Join(bin, "runs")
	claude := writeFakeBin(t, bin, providerClaude, `echo "$*" >> '`+runs+`'
echo '{"loggedIn":true}'`)
	if got := probeAuthIn(context.Background(), providerClaude, claude, nil); got != authUnknown || countLines(t, runs) != 0 {
		t.Fatalf("auth = %v after %d runs of claude, want unknown and none", got, countLines(t, runs))
	}
	if machine, place, blocked := claudeConnectionBlocked(context.Background()); !blocked || machine != "HPC" || place != "mainland China" {
		t.Fatalf("the process's verdict = %q, %q, %v; want doctor's: HPC, mainland China, blocked", machine, place, blocked)
	}
	if n := len(stub.checksSoFar()); n != 1 {
		t.Fatalf("doctor asked the route %d times, want once", n)
	}
}
