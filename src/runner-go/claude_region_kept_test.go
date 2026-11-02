//go:build linux || darwin

package main

import (
	"context"
	"encoding/json"
	"errors"
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"
)

// The region check across a restart (docs/claude-region-check-contract.md §10): every decided answer is kept on disk
// under the runner's home, by a hash of the proxy it went through, and a runner that starts reads them back before it
// asks anything. So an unknown answer after a restart carries a blocked verdict over until 24 hours after its
// decidedAt, as it would have had the runner kept running (owner decision ③). Driven by a fake clock against a fake
// route. What they pin is drill problem 1 of task 34pVMqzc9W2oEEEL6nU4B: a runner restarted while blocked, whose first
// answer was unknown, read plan usage and started claude.

// startRegionCheck makes this process's region check (claudeRegion) a new one on store, as runLoop makes one when a
// runner starts: a runner named atlas, asking stub, on clock. It makes no recheck after a flip, so a check a test has
// replaced asks nothing behind its back.
func startRegionCheck(t *testing.T, stub *regionStub, clock *fakePoolClock, store string) *claudeRegionCheck {
	t.Helper()
	check := newClaudeRegionCheck(NewTransport(stub.server.URL, "runner-token"), "atlas", store)
	check.clock = clock
	previous := claudeRegion.Swap(check)
	t.Cleanup(func() { claudeRegion.Store(previous) })
	return check
}

// readKept is what the store at path holds, by proxy key.
func readKept(t *testing.T, path string) map[string]claudeRegionKept {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var kept map[string]claudeRegionKept
	if err := json.Unmarshal(b, &kept); err != nil {
		t.Fatalf("the store holds %q: %v", b, err)
	}
	return kept
}

// A runner restarted on a blocked verdict, whose answers after the restart cannot decide, goes on holding Claude's
// requests to Anthropic back as it did before it: no plan-usage read, no claude of its own, an Anthropic-bound turn
// refused with the kept place, and a session on another provider's key started quiet from the first moment, before
// the new check has asked anything. At 24 hours after the blocked answer was decided, all of them go ahead.
func TestARestartedRunnerCarriesTheBlockedVerdictItKept(t *testing.T) {
	isolateClaudeRegionEnv(t)
	store := claudeRegionStorePath()
	home, _ := claudeAccountSlotTestHomes(t)
	writeClaudeCredentials(t, filepath.Join(home, ".claude"), "default-token")
	previousURL := planUsageURL
	t.Cleanup(func() { planUsageURL = previousURL })
	usageServer, usageTokens := claudeUsageServer(t, 12)
	planUsageURL = usageServer.URL
	deepseek := claudeSpawnJob(t)
	deepseek.Agent.Env = map[string]string{"ANTHROPIC_BASE_URL": deepseekBaseURL, "ANTHROPIC_AUTH_TOKEN": "sk-deepseek-orbit-test"}
	privateOrbitHome(t)
	starts := fakeOwnClaude(t)
	// spawnDeepSeek starts the DeepSeek session's claude as the session would (spawnClaude) and returns the value of
	// the nonessential-traffic variable it was started with.
	spawnDeepSeek := func() string {
		t.Helper()
		proc, err := spawnClaude(context.Background(), deepseek, t.TempDir(), claudeCommandArgs(deepseek, t.TempDir(), true))
		if err != nil {
			t.Fatal(err)
		}
		_ = proc.stdin.Close()
		_ = proc.cmd.Wait()
		values := starts()
		return values[len(values)-1]
	}
	stub := newRegionStub(t, regionAnswerBlocked)
	clock := newFakePoolClock()
	ctx := context.Background()

	// Before the restart: a check decides blocked, and keeps it.
	decidedAt := clock.Now()
	if v := startRegionCheck(t, stub, clock, store).check(ctx); v.Verdict != claudeRegionBlocked {
		t.Fatalf("the check before the restart answered %+v, want blocked", v)
	}

	// The restart, two minutes on: a new check on the same home, and a route that can no longer decide.
	stub.setAnswer(regionAnswerUnknown)
	clock.Advance(2 * time.Minute)
	check := startRegionCheck(t, stub, clock, store)
	asked := len(stub.checksSoFar())

	if got := spawnDeepSeek(); got != "1" {
		t.Fatalf("restarted, before any check: a DeepSeek session's claude started with %s = %q, want 1",
			claudeNonessentialTrafficVar, got)
	}
	if n := len(stub.checksSoFar()); n != asked {
		t.Fatalf("the DeepSeek session's start asked the route %d times, want none", n-asked)
	}

	if got := claudeRegionRefusal(ctx, anthropicJob()); got != atlasRussiaRefusal {
		t.Fatalf("restarted, unknown: the turn gate gave %q, want %q", got, atlasRussiaRefusal)
	}
	if n := len(stub.checksSoFar()); n != asked+1 {
		t.Fatalf("restarted: the turn gate asked the route %d times, want once", n-asked)
	}
	if v := check.forTurn(ctx); v.Verdict != claudeRegionBlocked || v.Name != "Russia" || !v.At.Equal(decidedAt) {
		t.Fatalf("restarted, unknown: forTurn = %+v, want the blocked verdict decided at %v", v, decidedAt)
	}

	probe := newClaudeAccountUsage().def
	if _, err := probe.fetch(ctx, probe.client); !errors.Is(err, errClaudeUsageRegionBlocked) {
		t.Fatalf("restarted, unknown: the usage read returned %v, want %v", err, errClaudeUsageRegionBlocked)
	}
	if got := usageTokens(); len(got) != 0 {
		t.Fatalf("restarted, unknown: the usage endpoint was asked, with %q", got)
	}

	for _, c := range ownClaudeStarts {
		var usedClaude bool
		captureRunnerStdout(t, func() { usedClaude = c.run(t) })
		if usedClaude {
			t.Fatalf("restarted, unknown: the %s came from claude, want its fallback", c.name)
		}
	}
	if got := starts(); !slices.Equal(got, []string{"1"}) {
		t.Fatalf("restarted, unknown: claude started with %q, want only the DeepSeek session's quiet start", got)
	}

	// A second short of 24 hours since the blocked answer, every gate still holds.
	advanceTo(clock, decidedAt.Add(claudeRegionCarryOver-time.Second))
	if got := claudeRegionRefusal(ctx, anthropicJob()); got != atlasRussiaRefusal {
		t.Fatalf("a second short of 24 hours: the turn gate gave %q", got)
	}
	if _, _, blocked := claudeConnectionBlocked(ctx); !blocked || len(usageTokens()) != 0 {
		t.Fatalf("a second short of 24 hours: blocked = %v, usage reads %q", blocked, usageTokens())
	}
	if got := spawnDeepSeek(); got != "1" {
		t.Fatalf("a second short of 24 hours: the DeepSeek session's claude started with %s = %q, want 1",
			claudeNonessentialTrafficVar, got)
	}

	// 24 hours to the moment: the kept verdict holds nothing back any more.
	advanceTo(clock, decidedAt.Add(claudeRegionCarryOver))
	if got := claudeRegionRefusal(ctx, anthropicJob()); got != "" {
		t.Fatalf("24 hours after the blocked answer, the turn gate refused: %q", got)
	}
	if usage := read(t, newClaudeAccountUsage().def); usage == nil || usage.FiveHour == nil {
		t.Fatalf("24 hours after the blocked answer, the usage read gave %#v", usage)
	}
	if got := usageTokens(); !slices.Equal(got, []string{"Bearer default-token"}) {
		t.Fatalf("usage reads = %q, want the one after the carry-over ran out", got)
	}
	before := len(starts())
	for _, c := range ownClaudeStarts {
		var usedClaude bool
		captureRunnerStdout(t, func() { usedClaude = c.run(t) })
		if !usedClaude {
			t.Fatalf("24 hours after the blocked answer, the %s took its fallback", c.name)
		}
	}
	if got := starts()[before:]; !allEqual(got, "unset") {
		t.Fatalf("24 hours after the blocked answer, claude started with %s = %q, want unset", claudeNonessentialTrafficVar, got)
	}
	if got := spawnDeepSeek(); got != "unset" {
		t.Fatalf("24 hours after the blocked answer, the DeepSeek session's claude started with %s = %q, want unset",
			claudeNonessentialTrafficVar, got)
	}
}

// The turn itself, through the real supervisor: a runner restarted on a blocked verdict it kept spawns no claude for an
// Anthropic-bound turn while the route answers unknown, and reports region_refused with the kept place on finalize, as
// a runner that had kept running would. A session on a DeepSeek key beside it runs, and asks the route nothing.
func TestARestartedRunnerRefusesTheTurnItsKeptVerdictHolds(t *testing.T) {
	isolateClaudeRegionEnv(t)
	store := claudeRegionStorePath()
	rig := prepareRegionRig(t, regionAnswerBlocked, nil)
	startRegionCheck(t, rig.regionStub, rig.clock, store).check(context.Background())

	rig.setAnswer(regionAnswerUnknown)
	rig.clock.Advance(time.Hour)
	rig.check = startRegionCheck(t, rig.regionStub, rig.clock, store)
	anthropic := claudeSpawnJob(t)
	anthropic.Agent.Env = anthropicKey()
	rig.start(anthropic, answersTwoTurns...)
	rig.awaitEnd()

	if spawns := rig.fake.Spawns(); len(spawns) != 0 {
		t.Fatalf("restarted on a kept blocked verdict, claude was spawned %d time(s) for an Anthropic-bound turn", len(spawns))
	}
	finals := rig.finalizes()
	if len(finals) != 1 {
		t.Fatalf("finalized %d times, want once", len(finals))
	}
	if f := finals[0]; f.Status != stFailed || f.Subtype != claudeRegionRefusedSubtype || f.Error != atlasRussiaRefusal {
		t.Fatalf("finalize = %s / %q / %q, want FAILED / region_refused / %q", f.Status, f.Subtype, f.Error, atlasRussiaRefusal)
	}
	if errs := rig.errors(); !slices.Equal(errs, []string{atlasRussiaRefusal}) {
		t.Fatalf("the transcript's errors are %q, want the refusal once", errs)
	}
	// The check before the restart, which decided blocked, and the refused turn's, which could not decide.
	if checks := rig.checksSoFar(); !slices.Equal(checks, []string{"0", "0"}) {
		t.Fatalf("checks = %q, want two, directly", checks)
	}

	deepseek := *anthropic
	deepseek.SessionID, deepseek.SessionUUID = "sess-2", "22222222-3333-4444-5555-666666666666"
	deepseek.Agent.Env = map[string]string{"ANTHROPIC_BASE_URL": deepseekBaseURL, "ANTHROPIC_AUTH_TOKEN": "test"}
	other := rig.beside(&deepseek, nil)
	if done := other.awaitSettled("turn-1"); done.Status != stSucceeded || done.Subtype == claudeRegionRefusedSubtype {
		t.Fatalf("the DeepSeek turn settled %s / %q, want it run", done.Status, done.Subtype)
	}
	if checks := rig.checksSoFar(); len(checks) != 2 {
		t.Fatalf("the DeepSeek session asked the route: checks = %q", checks)
	}
}

// A later decided answer replaces the kept one: an allowed answer after a restart is what the next start reads, so an
// unknown answer then holds nothing back, and a later blocked one moves decidedAt, from which the 24 hours run.
func TestALaterDecidedAnswerReplacesTheKeptOne(t *testing.T) {
	isolateClaudeRegionEnv(t)
	store := claudeRegionStorePath()
	stub := newRegionStub(t, regionAnswerBlocked)
	clock := newFakePoolClock()
	ctx := context.Background()
	direct := claudeRegionProxyKey("")
	startRegionCheck(t, stub, clock, store).check(ctx)

	stub.setAnswer(regionAnswerAllowed)
	clock.Advance(time.Hour)
	allowedAt := clock.Now()
	startRegionCheck(t, stub, clock, store).check(ctx)
	if kept := readKept(t, store); len(kept) != 1 || kept[direct].Verdict != claudeRegionAllowed ||
		kept[direct].Name != "United States" || !kept[direct].DecidedAt.Equal(allowedAt) {
		t.Fatalf("after an allowed answer the store holds %+v, want that answer alone", kept)
	}

	stub.setAnswer(regionAnswerUnknown)
	clock.Advance(time.Hour)
	check := startRegionCheck(t, stub, clock, store)
	if v, ok := check.lastDecided(""); !ok || v.Verdict != claudeRegionAllowed || !v.At.Equal(allowedAt) {
		t.Fatalf("restarted after an allowed answer: last decided = %+v (%v), want it", v, ok)
	}
	if got := claudeRegionRefusal(ctx, anthropicJob()); got != "" {
		t.Fatalf("restarted after an allowed answer, unknown: the turn gate refused: %q", got)
	}

	stub.setAnswer(regionAnswerBlocked)
	clock.Advance(time.Hour)
	blockedAt := clock.Now()
	check.check(ctx)
	stub.setAnswer(regionAnswerUnknown)
	// 26 hours after the first blocked answer, 23 after this one.
	advanceTo(clock, blockedAt.Add(23*time.Hour))
	startRegionCheck(t, stub, clock, store)
	if got := claudeRegionRefusal(ctx, anthropicJob()); got != atlasRussiaRefusal {
		t.Fatalf("restarted 23 hours after the newest blocked answer: the turn gate gave %q", got)
	}
	advanceTo(clock, blockedAt.Add(claudeRegionCarryOver))
	if got := claudeRegionRefusal(ctx, anthropicJob()); got != "" {
		t.Fatalf("24 hours after the newest blocked answer, the turn gate refused: %q", got)
	}
}

// A store that cannot be read carries nothing over and stops nothing: the check starts as one that has decided
// nothing, its one log line says why, and its next decided answer writes the file anew. An entry that is not a decided
// answer, or that is stamped later than the start, which cannot say how old it is, is skipped the same way.
func TestAKeptAnswerThatCannotBeReadCarriesNothingOver(t *testing.T) {
	const (
		none       = "Claude region: no decided answer kept from before this start"
		unreadable = "Claude region: the answers kept from before this start can't be read, so none is carried over ("
		skipped    = none + " (1 kept answer(s) skipped: not decided, or stamped later than now)"
	)
	direct := claudeRegionProxyKey("")
	future := time.Now().Add(48 * time.Hour).UTC().Format(time.RFC3339Nano)
	for _, c := range []struct {
		name, content, note string
	}{
		{"missing", "", none},
		{"cut short", `{"` + direct + `":{"verdict":"blo`, unreadable},
		{"null", "null", none},
		{"a list", "[1,2]", unreadable},
		{"a decidedAt that is not a time", `{"` + direct + `":{"verdict":"blocked","name":"Russia","decidedAt":"yesterday"}}`, unreadable},
		{"an unknown answer", `{"` + direct + `":{"verdict":"unknown","decidedAt":"2023-11-14T22:13:20Z"}}`, skipped},
		{"no decidedAt", `{"` + direct + `":{"verdict":"blocked","name":"Russia"}}`, skipped},
		{"stamped later than now", `{"` + direct + `":{"verdict":"blocked","name":"Russia","decidedAt":"` + future + `"}}`, skipped},
	} {
		t.Run(c.name, func(t *testing.T) {
			isolateClaudeRegionEnv(t)
			store := claudeRegionStorePath()
			if c.content != "" {
				if err := os.WriteFile(store, []byte(c.content), configFilePerm); err != nil {
					t.Fatal(err)
				}
			}
			stub := newRegionStub(t, regionAnswerUnknown)
			clock := newFakePoolClock()
			check := startRegionCheck(t, stub, clock, store)
			if !strings.HasPrefix(check.kept, c.note) || strings.Contains(check.kept, "\n") {
				t.Fatalf("the start's log line = %q, want one line starting %q", check.kept, c.note)
			}
			if c.note == none && check.kept != none {
				t.Fatalf("the start's log line = %q, want %q", check.kept, none)
			}
			if _, ok := check.lastDecided(""); ok {
				t.Fatal("a decided answer was carried over from a store that holds none")
			}
			if got := claudeRegionRefusal(context.Background(), anthropicJob()); got != "" {
				t.Fatalf("unknown, with nothing carried over: the turn gate refused: %q", got)
			}

			stub.setAnswer(regionAnswerBlocked)
			clock.Advance(claudeRegionFreshFor)
			check.check(context.Background())
			if kept := readKept(t, store); kept[direct].Verdict != claudeRegionBlocked || !kept[direct].DecidedAt.Equal(clock.Now()) {
				t.Fatalf("after a blocked answer the store holds %+v, want it", kept)
			}
		})
	}
}

// A store that cannot be written stops nothing either: the check goes on carrying its verdict over in memory, as it
// did before there was a store, and says once that it can't keep it.
func TestARegionStoreThatCannotBeWrittenStopsNothing(t *testing.T) {
	isolateClaudeRegionEnv(t)
	store := claudeRegionStorePath()
	if err := os.Mkdir(store, 0o700); err != nil {
		t.Fatal(err)
	}
	stub := newRegionStub(t, regionAnswerBlocked)
	clock := newFakePoolClock()
	check := startRegionCheck(t, stub, clock, store)
	if !strings.HasPrefix(check.kept, "Claude region: the answers kept from before this start can't be read") {
		t.Fatalf("the start's log line = %q", check.kept)
	}
	out := captureRunnerStdout(t, func() {
		check.check(context.Background())
		clock.Advance(5 * time.Minute)
		check.check(context.Background())
	})
	if n := strings.Count(out, "Claude region: can't keep the answer for the next start:"); n != 1 {
		t.Fatalf("the failed writes were logged %d times, want once:\n%s", n, out)
	}
	stub.setAnswer(regionAnswerUnknown)
	clock.Advance(time.Hour)
	if got := claudeRegionRefusal(context.Background(), anthropicJob()); got != atlasRussiaRefusal {
		t.Fatalf("with a store that cannot be written, an unknown answer gave %q, want the carried-over refusal", got)
	}
}

// The store keeps the six fields of a decided answer under a SHA-256 of the proxy, and never the proxy itself: not
// its URL, its host or the credentials in it. The file is private, and keyed per proxy: a restart through the same
// proxy carries its verdict over, and the direct connection, another connection, does not.
func TestTheKeptAnswersHoldNoProxy(t *testing.T) {
	isolateClaudeRegionEnv(t)
	store := claudeRegionStorePath()
	stub := newRegionStub(t, regionAnswerBlocked)
	forward := newForwardProxy(t)
	host := strings.TrimPrefix(forward.server.URL, "http://")
	proxyURL := "http://orbit:hunter2@" + host
	t.Setenv("HTTPS_PROXY", proxyURL)
	clock := newFakePoolClock()
	ctx := context.Background()
	if v := startRegionCheck(t, stub, clock, store).check(ctx); v.Verdict != claudeRegionBlocked || !v.ViaProxy {
		t.Fatalf("the check through the proxy answered %+v, want blocked", v)
	}
	if n := len(forward.requests()); n != 1 {
		t.Fatalf("the check went through Claude's proxy %d times, want once", n)
	}

	b, err := os.ReadFile(store)
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range []string{proxyURL, host, "hunter2", "orbit:", "http", "127.0.0.1"} {
		if strings.Contains(string(b), s) {
			t.Fatalf("the store holds %q:\n%s", s, b)
		}
	}
	var raw map[string]map[string]any
	if err := json.Unmarshal(b, &raw); err != nil {
		t.Fatal(err)
	}
	key := claudeRegionProxyKey(proxyURL)
	if len(raw) != 1 || raw[key] == nil || !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(key) {
		t.Fatalf("the store's keys are %v, want the proxy's SHA-256 alone (%s)", slices.Collect(maps.Keys(raw)), key)
	}
	fields := slices.Sorted(maps.Keys(raw[key]))
	if want := []string{"country", "decidedAt", "name", "regionCode", "verdict", "viaProxy"}; !slices.Equal(fields, want) {
		t.Fatalf("a kept answer holds %q, want %q", fields, want)
	}
	if e := raw[key]; e["verdict"] != claudeRegionBlocked || e["country"] != "RU" || e["name"] != "Russia" || e["viaProxy"] != true {
		t.Fatalf("the kept answer is %v", e)
	}
	info, err := os.Stat(store)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("the store's mode is %04o, want 0600", info.Mode().Perm())
	}
	if leftovers, _ := filepath.Glob(filepath.Join(filepath.Dir(store), ".claude-region.json-*")); len(leftovers) != 0 {
		t.Fatalf("the atomic write left %q behind", leftovers)
	}

	stub.setAnswer(regionAnswerUnknown)
	clock.Advance(time.Hour)
	check := startRegionCheck(t, stub, clock, store)
	if got := claudeRegionRefusal(ctx, anthropicJob()); got != atlasRussiaRefusal {
		t.Fatalf("restarted, through the same proxy, unknown: the turn gate gave %q", got)
	}
	t.Setenv("HTTPS_PROXY", "")
	if got := claudeRegionRefusal(ctx, anthropicJob()); got != "" {
		t.Fatalf("restarted, directly, unknown: the turn gate refused on the proxy's verdict: %q", got)
	}

	// The direct connection's own decided answer is kept beside the proxy's, which it leaves as it was.
	stub.setAnswer(regionAnswerAllowed)
	clock.Advance(claudeRegionFreshFor)
	check.check(ctx)
	if kept := readKept(t, store); len(kept) != 2 || kept[key].Verdict != claudeRegionBlocked ||
		kept[claudeRegionProxyKey("")].Verdict != claudeRegionAllowed {
		t.Fatalf("after a direct allowed answer the store holds %+v, want it beside the proxy's blocked one", kept)
	}
	stub.setAnswer(regionAnswerUnknown)
	t.Setenv("HTTPS_PROXY", proxyURL)
	clock.Advance(time.Minute)
	startRegionCheck(t, stub, clock, store)
	if got := claudeRegionRefusal(ctx, anthropicJob()); got != atlasRussiaRefusal {
		t.Fatalf("restarted again, through the proxy, unknown: the turn gate gave %q", got)
	}
}

// orbit doctor and the runner keep their answers in one store, a check's and doctor's both through keepLocked. Doctor
// reads a blocked verdict the runner kept, so its unknown answer reads blocked in its gates and in its section; and
// the runner's next start reads the answer doctor decided.
func TestDoctorAndTheRunnerShareTheKeptAnswers(t *testing.T) {
	dir := isolateClaudeRegionEnv(t)
	stub := newRegionStub(t, regionAnswerMainlandChina)
	ctx := context.Background()
	// On the real clock, which doctor's check goes by.
	newClaudeRegionCheck(NewTransport(stub.server.URL, "runner-token"), "HPC", claudeRegionStorePath()).check(ctx)

	stub.setAnswer(regionAnswerUnknown)
	cfg := &RunnerConfig{ServerURL: stub.server.URL, RunnerToken: "runner-token", Name: "HPC"}
	region := checkDoctorRegion(cfg)
	want := []string{
		"  Claude's route   mainland China (CN)   direct",
		"  ✗ Anthropic doesn't offer Claude in mainland China.",
		"    Orbit won't use Anthropic accounts or keys here, or start a",
		"    Claude sign-in. Claude Code still runs with other providers' keys.",
		"    https://www.anthropic.com/legal/supported-regions",
	}
	if got := formatDoctorRegion(region); !slices.Equal(got, want) {
		t.Fatalf("doctor's section on an unknown answer under the runner's kept verdict:\n%s\nwant:\n%s",
			strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	previous := claudeRegion.Swap(region.check)
	t.Cleanup(func() { claudeRegion.Store(previous) })
	writeClaudeTokenOnly(t, dir)
	bin := t.TempDir()
	runs := filepath.Join(bin, "runs")
	claude := writeFakeBin(t, bin, providerClaude, `echo "$*" >> '`+runs+`'
echo '{"loggedIn":true}'`)
	if got := probeAuthIn(ctx, providerClaude, claude, nil); got != authUnknown || countLines(t, runs) != 0 {
		t.Fatalf("doctor's auth probe = %v after %d runs of claude, want unknown and none", got, countLines(t, runs))
	}

	stub.setAnswer(regionAnswerAllowed)
	if region := checkDoctorRegion(cfg); region.verdict.Verdict != claudeRegionAllowed {
		t.Fatalf("doctor's second answer = %+v, want allowed", region.verdict)
	}
	stub.setAnswer(regionAnswerUnknown)
	restarted := newClaudeRegionCheck(NewTransport(stub.server.URL, "runner-token"), "HPC", claudeRegionStorePath())
	if v, ok := restarted.lastDecided(""); !ok || v.Verdict != claudeRegionAllowed || v.Name != "United States" {
		t.Fatalf("the runner's next start read %+v (%v), want doctor's allowed answer", v, ok)
	}
	if v := restarted.forTurn(ctx); v.Verdict != claudeRegionUnknown {
		t.Fatalf("the restarted runner's unknown answer reads %+v, want it unknown", v)
	}
}

// runLoop starts its check from the store under the runner's home, and logs what it found there, once.
func TestTheRunLoopStartsItsRegionCheckFromTheStore(t *testing.T) {
	src, err := os.ReadFile("runloop.go")
	if err != nil {
		t.Fatal(err)
	}
	body := string(src)
	body = body[strings.Index(body, "func runLoop("):]
	if !strings.Contains(body, "regionCheck := newClaudeRegionCheck(t, cfg.Name, claudeRegionStorePath())\n\tlogln(regionCheck.kept)\n") {
		t.Fatal("runLoop does not start its region check from claudeRegionStorePath and log what it kept")
	}
	if n := strings.Count(body, "regionCheck.kept"); n != 1 {
		t.Fatalf("runLoop reads what the store kept %d times, want once", n)
	}
}
