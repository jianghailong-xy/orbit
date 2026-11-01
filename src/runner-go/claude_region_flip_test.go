package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// The region check over time (docs/claude-region-check-contract.md §5, §10): an answer that cannot decide keeps
// the last decided verdict for 24 hours (owner decision ③), and a flip to blocked is checked again a minute on,
// a second blocked answer stopping the turns already running (④). Driven by a fake clock against a fake route.

// The sentence a turn on atlas is stopped with when its connection to Anthropic is now in Russia, word for word
// (board 04, contract §10).
const atlasRussiaStopped = "CLAUDE_REGION_UNSUPPORTED: Claude Code stopped on atlas: its connection to Anthropic is now in Russia, where Anthropic doesn’t offer Claude."

// anthropicJob is a Claude session whose turns talk to Anthropic: an Anthropic key, no base URL.
func anthropicJob() *ClaimedSession {
	return &ClaimedSession{SessionID: "s", Provider: providerClaude,
		Agent: AgentExecConfig{Provider: providerClaude, Env: map[string]string{"ANTHROPIC_API_KEY": "test"}}}
}

// advanceTo moves clock to at.
func advanceTo(clock *fakePoolClock, at time.Time) { clock.Advance(at.Sub(clock.Now())) }

// stopRecorder is a registered engine (claudeRegionCheck.register) that records each stop it is asked for.
type stopRecorder struct {
	mu    sync.Mutex
	asked []string
}

func (s *stopRecorder) stop(sentence string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.asked = append(s.asked, sentence)
}

func (s *stopRecorder) stops() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.asked...)
}

// regionFlipRig is a region check that rechecks after a flip as runLoop's does, on a fake clock, against a fake
// route, with one registered engine that records what it is asked to stop.
func regionFlipRig(t *testing.T, answer string) (*regionStub, *fakePoolClock, *claudeRegionCheck, *stopRecorder) {
	t.Helper()
	isolateClaudeRegionEnv(t)
	stub := newRegionStub(t, answer)
	clock := newFakePoolClock()
	check := installRegionCheck(t, stub, clock)
	check.lifetime = context.Background()
	engine := &stopRecorder{}
	t.Cleanup(check.register(engine.stop))
	return stub, clock, check, engine
}

// An unknown answer keeps the last decided verdict, blocked, until 24 hours after its decidedAt, for forTurn
// and for the turn gate that reads it, each time on a check made then; from 24 hours on, an unknown answer is
// allowed.
func TestClaudeRegionUnknownKeepsABlockedVerdictFor24Hours(t *testing.T) {
	isolateClaudeRegionEnv(t)
	stub := newRegionStub(t, regionAnswerBlocked)
	clock := newFakePoolClock()
	check := installRegionCheck(t, stub, clock)
	ctx := context.Background()

	decidedAt := clock.Now()
	if v := check.forTurn(ctx); v.Verdict != claudeRegionBlocked {
		t.Fatalf("first answer = %+v, want blocked", v)
	}
	stub.setAnswer(regionAnswerUnknown)
	for _, since := range []time.Duration{time.Minute, time.Hour, 23 * time.Hour, claudeRegionCarryOver - time.Second} {
		advanceTo(clock, decidedAt.Add(since))
		checks := len(stub.checksSoFar())
		v := check.forTurn(ctx)
		if len(stub.checksSoFar()) != checks+1 {
			t.Fatalf("%s after the blocked answer: no new check; the last answer was stale", since)
		}
		if v.Verdict != claudeRegionBlocked || v.Name != "Russia" || !v.At.Equal(decidedAt) {
			t.Fatalf("%s after the blocked answer, an unknown one reads %+v, want the blocked verdict decided at %v", since, v, decidedAt)
		}
		if got := claudeRegionRefusal(ctx, anthropicJob()); got != atlasRussiaRefusal {
			t.Fatalf("%s after the blocked answer, the turn gate gave %q, want %q", since, got, atlasRussiaRefusal)
		}
	}
	// 24 hours to the moment: the unknown answer of a second ago is fresh, and nothing holds it back any more.
	advanceTo(clock, decidedAt.Add(claudeRegionCarryOver))
	if v := check.forTurn(ctx); v.Verdict != claudeRegionUnknown {
		t.Fatalf("24 hours after the blocked answer, an unknown one reads %+v, want unknown", v)
	}
	if got := claudeRegionRefusal(ctx, anthropicJob()); got != "" {
		t.Fatalf("24 hours after the blocked answer, the turn gate refused: %q", got)
	}
	advanceTo(clock, decidedAt.Add(30*time.Hour))
	if v := check.forTurn(ctx); v.Verdict != claudeRegionUnknown || claudeRegionRefusal(ctx, anthropicJob()) != "" {
		t.Fatalf("30 hours after the blocked answer, an unknown one reads %+v, want unknown and no refusal", v)
	}
	// The stored verdict is still the decided one; only what it means has run out.
	if v, ok := check.lastDecided(""); !ok || v.Verdict != claudeRegionBlocked || !v.At.Equal(decidedAt) {
		t.Fatalf("last decided = %+v (%v), want the blocked verdict decided at %v", v, ok, decidedAt)
	}
}

// The runner's gates besides its turns read the carry-over where its turns do, in forTurn's answer
// (claudeConnectionBlocked): after a blocked answer, unknown ones keep a plan-usage read and a claude the runner would
// start for its own work (claudeStartBlocked) held back, with no request to the usage endpoint, until 24 hours after
// the blocked answer was decided. From then on both go ahead.
func TestNonTurnGatesCarryABlockedVerdictFor24Hours(t *testing.T) {
	isolateClaudeRegionEnv(t)
	home, _ := claudeAccountSlotTestHomes(t)
	previousURL := planUsageURL
	t.Cleanup(func() { planUsageURL = previousURL })
	srv, tokens := claudeUsageServer(t, 12)
	planUsageURL = srv.URL
	writeClaudeCredentials(t, filepath.Join(home, ".claude"), "default-token")
	stub := newRegionStub(t, regionAnswerBlocked)
	clock := newFakePoolClock()
	check := installRegionCheck(t, stub, clock)
	ctx := context.Background()

	decidedAt := clock.Now()
	check.check(ctx)
	stub.setAnswer(regionAnswerUnknown)
	// The contract's 24 hours, written out: claudeRegionCarryOver is asserted against @orbit/shared apart.
	for _, since := range []time.Duration{time.Minute, time.Hour, 23 * time.Hour, 24*time.Hour - time.Second} {
		advanceTo(clock, decidedAt.Add(since))
		checks := len(stub.checksSoFar())
		if machine, region, blocked := claudeConnectionBlocked(ctx); !blocked || machine != "atlas" || region != "Russia" {
			t.Fatalf("%s after the blocked answer, an unknown one reads %q, %q, %v; want atlas, Russia, blocked",
				since, machine, region, blocked)
		}
		if len(stub.checksSoFar()) != checks+1 {
			t.Fatalf("%s after the blocked answer: no new check; the last answer was stale", since)
		}
		if !claudeStartBlocked(ctx, nil) {
			t.Fatalf("%s after the blocked answer, a claude the runner starts for itself was let through", since)
		}
		probe := newClaudeAccountUsage().def
		if _, err := probe.fetch(ctx, probe.client); !errors.Is(err, errClaudeUsageRegionBlocked) {
			t.Fatalf("%s after the blocked answer, the usage read returned %v, want %v", since, err, errClaudeUsageRegionBlocked)
		}
		if got := tokens(); len(got) != 0 {
			t.Fatalf("%s after the blocked answer, the usage endpoint was asked, with %q", since, got)
		}
	}

	advanceTo(clock, decidedAt.Add(24*time.Hour))
	if _, _, blocked := claudeConnectionBlocked(ctx); blocked {
		t.Fatal("24 hours after the blocked answer, an unknown one still reads blocked")
	}
	if claudeStartBlocked(ctx, nil) {
		t.Fatal("24 hours after the blocked answer, a claude the runner starts for itself is still held back")
	}
	if usage := read(t, newClaudeAccountUsage().def); usage == nil || usage.FiveHour == nil {
		t.Fatalf("24 hours after the blocked answer, the usage read gave %#v", usage)
	}
	if got := tokens(); !slices.Equal(got, []string{"Bearer default-token"}) {
		t.Fatalf("tokens seen = %q, want the one read after the carry-over ran out", got)
	}
}

// orbit doctor keeps the answer it asks for itself the way a check keeps one (keep), flip and all: a blocked answer
// checkDoctorRegion got starts a flip, which a blocked check a minute later through that check confirms, stopping
// what is registered with it, as it would had the check asked first.
func TestDoctorKeepsItsAnswerAsACheckDoes(t *testing.T) {
	isolateClaudeRegionEnv(t)
	stub := newRegionStub(t, regionAnswerBlocked)
	region := checkDoctorRegion(&RunnerConfig{ServerURL: stub.server.URL, RunnerToken: "runner-token", Name: "atlas"})
	if region.verdict.Verdict != claudeRegionBlocked {
		t.Fatalf("doctor's answer = %+v, want blocked", region.verdict)
	}
	check := region.check
	clock := &fakePoolClock{now: region.verdict.At}
	check.clock = clock
	engine := &stopRecorder{}
	t.Cleanup(check.register(engine.stop))

	clock.Advance(claudeRegionRecheckAfter)
	check.check(context.Background())
	if got := engine.stops(); !slices.Equal(got, []string{atlasRussiaStopped}) {
		t.Fatalf("stops = %q: a blocked check a minute after doctor's blocked answer did not confirm the flip it started", got)
	}
}

// With no decided verdict, every answer that cannot decide is allowed, and an allowed verdict carries over as
// itself.
func TestClaudeRegionUnknownWithoutABlockedVerdictIsAllowed(t *testing.T) {
	ctx := context.Background()
	for _, answer := range []string{regionAnswerUnknown, regionAnswerNotFound} {
		isolateClaudeRegionEnv(t)
		stub := newRegionStub(t, answer)
		check := installRegionCheck(t, stub, newFakePoolClock())
		if v := check.forTurn(ctx); v.Verdict != claudeRegionUnknown {
			t.Fatalf("no decided verdict, answer %q: %+v, want unknown", answer, v)
		}
		if got := claudeRegionRefusal(ctx, anthropicJob()); got != "" {
			t.Fatalf("no decided verdict, answer %q: the turn gate refused: %q", answer, got)
		}
	}

	isolateClaudeRegionEnv(t)
	stub := newRegionStub(t, regionAnswerAllowed)
	clock := newFakePoolClock()
	check := installRegionCheck(t, stub, clock)
	check.forTurn(ctx)
	stub.setAnswer(regionAnswerUnknown)
	clock.Advance(time.Hour)
	if v := check.forTurn(ctx); v.Verdict == claudeRegionBlocked || claudeRegionRefusal(ctx, anthropicJob()) != "" {
		t.Fatalf("after an allowed verdict an unknown answer reads %+v, want it allowed", v)
	}
}

// Allowed to blocked: the check is made again a minute on, and its second blocked answer stops the running
// Anthropic-bound turns with the stopped sentence; so does every blocked answer after it, for what has started
// since. An unknown answer stops nothing.
func TestClaudeRegionFlipIsCheckedAgainAMinuteOnAndConfirmed(t *testing.T) {
	stub, clock, check, engine := regionFlipRig(t, regionAnswerAllowed)
	ctx := context.Background()
	check.check(ctx)
	clock.Advance(5 * time.Minute)

	stub.setAnswer(regionAnswerBlocked)
	check.check(ctx) // the periodic check finds the flip
	if got := engine.stops(); len(got) != 0 {
		t.Fatalf("one blocked answer stopped turns: %q", got)
	}
	checks := len(stub.checksSoFar())
	clock.Advance(claudeRegionRecheckAfter - time.Second)
	if n := len(stub.checksSoFar()); n != checks {
		t.Fatalf("checked again %d time(s) within the minute", n-checks)
	}
	clock.Advance(time.Second)
	if n := len(stub.checksSoFar()); n != checks+1 {
		t.Fatalf("checked again %d time(s) a minute on, want once", n-checks)
	}
	if got := engine.stops(); !slices.Equal(got, []string{atlasRussiaStopped}) {
		t.Fatalf("stops = %q, want one, with %q", got, atlasRussiaStopped)
	}

	// Each blocked answer after it stops what has started since (a turn an engine runs on its own); an unknown
	// one, which only keeps the verdict, stops nothing.
	clock.Advance(5 * time.Minute)
	check.check(ctx)
	stub.setAnswer(regionAnswerUnknown)
	clock.Advance(5 * time.Minute)
	check.check(ctx)
	stub.setAnswer(regionAnswerBlocked)
	clock.Advance(time.Hour)
	check.check(ctx)
	if got := engine.stops(); len(got) != 3 {
		t.Fatalf("stops = %q, want one for each of the three blocked answers since the minute was up", got)
	}

	// Allowed ends the flip; the next blocked answer is a new one, with its own minute.
	stub.setAnswer(regionAnswerAllowed)
	clock.Advance(5 * time.Minute)
	check.check(ctx)
	stub.setAnswer(regionAnswerBlocked)
	clock.Advance(5 * time.Minute)
	check.check(ctx)
	if got := engine.stops(); len(got) != 3 {
		t.Fatalf("stops = %q: a new flip stopped turns on its first blocked answer", got)
	}
	clock.Advance(claudeRegionRecheckAfter)
	if got := engine.stops(); len(got) != 4 || got[3] != atlasRussiaStopped {
		t.Fatalf("stops = %q, want the new flip confirmed a minute on", got)
	}
}

// A flip the recheck finds recovered stops nothing, and leaves no recheck behind.
func TestClaudeRegionFlipThatRecoversStopsNothing(t *testing.T) {
	stub, clock, check, engine := regionFlipRig(t, regionAnswerAllowed)
	ctx := context.Background()
	check.check(ctx)
	clock.Advance(5 * time.Minute)
	stub.setAnswer(regionAnswerBlocked)
	check.check(ctx)

	stub.setAnswer(regionAnswerAllowed)
	checks := len(stub.checksSoFar())
	clock.Advance(claudeRegionRecheckAfter)
	if n := len(stub.checksSoFar()); n != checks+1 {
		t.Fatalf("checked again %d time(s) a minute on, want once", n-checks)
	}
	clock.Advance(time.Hour)
	if n := len(stub.checksSoFar()); n != checks+1 {
		t.Fatalf("checked %d time(s) after the flip recovered, want none", n-checks-1)
	}
	if got := engine.stops(); len(got) != 0 {
		t.Fatalf("a flip that recovered stopped turns: %q", got)
	}
	if v := check.forTurn(ctx); v.Verdict != claudeRegionAllowed {
		t.Fatalf("after the recovery a turn goes on %+v, want allowed", v)
	}
}

// A recheck that cannot decide leaves the flip standing, and the verdict blocked (③): the next decided answer
// settles it — here the periodic check's, blocked, which stops the running turns.
func TestClaudeRegionFlipWaitsOutAnUnknownRecheck(t *testing.T) {
	stub, clock, check, engine := regionFlipRig(t, regionAnswerAllowed)
	ctx := context.Background()
	check.check(ctx)
	clock.Advance(5 * time.Minute)
	stub.setAnswer(regionAnswerBlocked)
	check.check(ctx)

	stub.setAnswer(regionAnswerNotFound)
	clock.Advance(claudeRegionRecheckAfter)
	if got := engine.stops(); len(got) != 0 {
		t.Fatalf("an unknown recheck stopped turns: %q", got)
	}
	if got := claudeRegionRefusal(ctx, anthropicJob()); got != atlasRussiaRefusal {
		t.Fatalf("after an unknown recheck the turn gate gave %q, want the blocked verdict carried over", got)
	}
	stub.setAnswer(regionAnswerBlocked)
	clock.Advance(4 * time.Minute)
	check.check(ctx)
	if got := engine.stops(); !slices.Equal(got, []string{atlasRussiaStopped}) {
		t.Fatalf("stops = %q, want the blocked answer after the unknown recheck to confirm the flip", got)
	}
}

// A second blocked answer sooner than a minute after the first — the owner's Check again — does not confirm the
// flip; the recheck a minute on does.
func TestClaudeRegionFlipNeedsAMinuteBetweenItsTwoBlockedAnswers(t *testing.T) {
	stub, clock, check, engine := regionFlipRig(t, regionAnswerAllowed)
	ctx := context.Background()
	check.check(ctx)
	clock.Advance(5 * time.Minute)
	stub.setAnswer(regionAnswerBlocked)
	check.check(ctx)

	clock.Advance(10 * time.Second)
	check.check(ctx)
	if got := engine.stops(); len(got) != 0 {
		t.Fatalf("two blocked answers ten seconds apart stopped turns: %q", got)
	}
	clock.Advance(claudeRegionRecheckAfter - 10*time.Second)
	if got := engine.stops(); !slices.Equal(got, []string{atlasRussiaStopped}) {
		t.Fatalf("stops = %q, want the recheck a minute after the first blocked answer to confirm the flip", got)
	}
}

// The first answer a runner gets, blocked, is a flip from no decided verdict, which counts as allowed (③); and
// once a blocked verdict has carried over for 24 hours without a decided answer, the next blocked one is a new
// flip, not a confirmation of the old one.
func TestClaudeRegionFlipFromNoVerdictAndAfterTheCarryOver(t *testing.T) {
	stub, clock, check, engine := regionFlipRig(t, regionAnswerBlocked)
	ctx := context.Background()
	check.check(ctx)
	clock.Advance(claudeRegionRecheckAfter)
	if got := engine.stops(); len(got) != 1 {
		t.Fatalf("stops = %q, want the first blocked answer's flip confirmed a minute on", got)
	}

	stub.setAnswer(regionAnswerUnknown)
	clock.Advance(25 * time.Hour)
	check.check(ctx)
	stub.setAnswer(regionAnswerBlocked)
	check.check(ctx)
	if got := engine.stops(); len(got) != 1 {
		t.Fatalf("stops = %q: a blocked answer after the carry-over ran out was taken for the old flip's second", got)
	}
	clock.Advance(claudeRegionRecheckAfter)
	if got := engine.stops(); len(got) != 2 {
		t.Fatalf("stops = %q, want the new flip confirmed a minute on", got)
	}
}

// A check made outside a runner's loop (orbit doctor's) runs no turns, so it makes no recheck.
func TestClaudeRegionCheckOutsideTheRunLoopMakesNoRecheck(t *testing.T) {
	isolateClaudeRegionEnv(t)
	stub := newRegionStub(t, regionAnswerBlocked)
	clock := newFakePoolClock()
	check := newClaudeRegionCheck(NewTransport(stub.server.URL, "runner-token"), "atlas")
	check.clock = clock
	check.check(context.Background())
	clock.Advance(time.Hour)
	if n := len(stub.checksSoFar()); n != 1 {
		t.Fatalf("a check with no loop to run in made %d checks, want its own one", n)
	}
}

// An engine that has gone is not stopped: it takes itself off the check when it ends.
func TestClaudeRegionStopsOnlyTheEnginesStillRunning(t *testing.T) {
	stub, clock, check, engine := regionFlipRig(t, regionAnswerAllowed)
	gone := &stopRecorder{}
	unregister := check.register(gone.stop)
	unregister()
	ctx := context.Background()
	check.check(ctx)
	stub.setAnswer(regionAnswerBlocked)
	clock.Advance(5 * time.Minute)
	check.check(ctx)
	clock.Advance(claudeRegionRecheckAfter)
	if len(engine.stops()) != 1 || len(gone.stops()) != 0 {
		t.Fatalf("stops: running engine %q, gone engine %q; want only the running one stopped", engine.stops(), gone.stops())
	}
}

// The stopped sentence, the stop's subtype and the carry-over are the shared ones, so the runner, the control
// plane and the clients say and count the same thing.
func TestTheRunnerStopsAndCarriesOverAsTheSharedRulesSay(t *testing.T) {
	dto, err := os.ReadFile(filepath.Join("..", "shared", "src", "dto.ts"))
	if err != nil {
		t.Fatal(err)
	}
	if want := "CLAUDE_REGION_STOPPED_SUBTYPE = '" + claudeRegionStoppedSubtype + "'"; !strings.Contains(string(dto), want) {
		t.Errorf("@orbit/shared does not say %s", want)
	}
	rules, err := os.ReadFile(filepath.Join("..", "shared", "src", "claude-region-check.ts"))
	if err != nil {
		t.Fatal(err)
	}
	sentence := strings.TrimPrefix(claudeRegionStoppedError("${machine}", "${region}"), claudeRegionUnsupported)
	if want := "return `${CLAUDE_REGION_UNSUPPORTED}" + sentence + "`;"; !strings.Contains(string(rules), want) {
		t.Errorf("claude-region-check.ts does not write the stopped sentence as the runner does: %s", want)
	}
	if got := claudeRegionStoppedError("atlas", "Russia"); got != atlasRussiaStopped {
		t.Errorf("stopped sentence = %q", got)
	}
	if !strings.Contains(string(rules), "CLAUDE_REGION_CARRY_OVER_MS = 24 * 60 * 60 * 1000;") || claudeRegionCarryOver != 24*time.Hour {
		t.Errorf("the carry-over is %s here; claude-region-check.ts does not say 24 * 60 * 60 * 1000 ms", claudeRegionCarryOver)
	}
}
