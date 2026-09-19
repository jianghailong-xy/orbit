//go:build linux || darwin

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Claude's Monitor runs its watch command inside the engine process and wakes the agent on each
// event. Recycling the engine ends it, and until now nothing said so: Claude writes a
// <task-notification> only for a Monitor that ends on its own, and the runner only recognised the
// Bash(run_in_background) receipt. Production lost three Monitors this way at the warm TTL
// (bpqs51zju, bnz2zm3z4, benudz2z4) without a single event. These tests pin that the death is
// reported — not that the Monitor survives, which is a different piece of work.
//
// The other way a Monitor ends is the deadline its own receipt states. That one also went
// unreported, and cost more: the notice Claude sends at expiry names the Monitor's task id and
// nothing else — no tool_use id, no status — so the id of the tool_use that launched the watch
// stayed in Session.runningBgShells for the rest of the session's life. One production session
// carried nine of them, and a session that had already FAILED still carried six.

// The receipts exactly as Claude returns them (tool_call.output in production). A deadline is
// stated as an expiry duration — 2.1.270's own form, and what the production sessions that carried
// stuck launches had — or as raw milliseconds, which is what the same CLI writes when the flag
// behind that wording is off. Both are real, so both are pinned.
const (
	monitorExpiresReceipt = "Monitor started (task bbairyimf, expires in 5m unless the source ends first;" +
		" you get one notice at expiry — re-arm if you still need the watch)." +
		" You will be notified on each event. Keep working — do not poll or sleep." +
		" Events may arrive while you are waiting for the user — an event is not their reply."
	monitorTimeoutReceipt = "Monitor started (task b97q4j1iy, timeout 2400000ms). You will be notified on each event." +
		" Keep working — do not poll or sleep. Events may arrive while you are waiting for the user — an event is not their reply."
	monitorPersistentReceipt = "Monitor started (task blltn4ypz, persistent — runs until TaskStop or session end)." +
		" You will be notified on each event. Keep working — do not poll or sleep." +
		" Events may arrive while you are waiting for the user — an event is not their reply."
)

// Both receipt forms register, and what they recorded is read back where it is spent: the engine's
// stop. A Monitor writes nothing in the checkout, so unlike the Bash shell beside it, it must not
// hold the checkout or take an admission slot — and the Bash registration must not change.
func TestMonitorStartIsRegisteredFromToolResult(t *testing.T) {
	h := newEvictionHarness(t, "monitorstart", 1)
	h.startEngine()
	job := h.startJob("sleep 30", bgKindJob) // the admission count's positive: this one is counted

	h.bg.onToolResult("toolu_timeout", monitorTimeoutReceipt)
	h.bg.onToolResult("toolu_expires", monitorExpiresReceipt)
	h.bg.onToolResult("toolu_persistent", monitorPersistentReceipt)
	// Text that quotes a receipt is not a Monitor that exists.
	h.bg.onToolResult("toolu_quoted", "src/runner-go/background_monitor_test.go:22: "+monitorTimeoutReceipt)
	output := filepath.Join(h.dir, "bei1.output")
	h.bg.onToolResult("toolu_bash", "Command running in background with ID: bei1. Output is being"+
		" written to: "+output+". You will be notified when it completes.")

	holders := h.pool.worktreeHolders(h.id)
	if !holdersInclude(holders, worktreeHeldByBackgroundJob, "bei1") {
		t.Fatalf("the Bash background shell is no longer a writer of the checkout: %v", holders)
	}
	for _, name := range []string{
		"b97q4j1iy", "bbairyimf", "blltn4ypz", "toolu_timeout", "toolu_expires", "toolu_persistent",
	} {
		if holdersInclude(holders, worktreeHeldByBackgroundJob, name) {
			t.Fatalf("a Monitor was registered as a writer of the checkout (%s): %v", name, holders)
		}
	}
	if got := h.jobCount(); got != 1 {
		t.Fatalf("admission-visible job count = %d, want 1 (the runner job %s, and no Monitor)", got, job.JobID)
	}

	h.bg.killEngineShells()

	timeout := h.events.terminalsFor("toolu_timeout")
	if len(timeout) != 1 {
		t.Fatalf("the Monitor with a timeout was not registered: terminal reports %v, all events %v",
			timeout, h.events.withStatus("killed"))
	}
	if got := asString(timeout[0]["shellId"]); got != "b97q4j1iy" {
		t.Fatalf("task id = %q, want b97q4j1iy", got)
	}
	if got, _ := timeout[0]["timeoutMs"].(int64); got != 2400000 || timeout[0]["persistent"] != nil {
		t.Fatalf("timeout Monitor recorded timeoutMs=%#v persistent=%#v, want 2400000 and absent",
			timeout[0]["timeoutMs"], timeout[0]["persistent"])
	}

	// The newer receipt states the same thing as a duration. Reading it is what the expiry below
	// hangs on: a receipt this regex missed left the Monitor unregistered, and its launch
	// unretirable, which is the whole defect.
	expires := h.events.terminalsFor("toolu_expires")
	if len(expires) != 1 {
		t.Fatalf("the Monitor whose receipt states an expiry duration was not registered: terminal reports %v", expires)
	}
	if got := asString(expires[0]["shellId"]); got != "bbairyimf" {
		t.Fatalf("task id = %q, want bbairyimf", got)
	}
	if got, _ := expires[0]["timeoutMs"].(int64); got != 300000 {
		t.Fatalf("expires-in Monitor recorded timeoutMs=%#v, want 300000 (the receipt's 5m)",
			expires[0]["timeoutMs"])
	}

	persistent := h.events.terminalsFor("toolu_persistent")
	if len(persistent) != 1 {
		t.Fatalf("the persistent Monitor was not registered: terminal reports %v", persistent)
	}
	if got := asString(persistent[0]["shellId"]); got != "blltn4ypz" {
		t.Fatalf("task id = %q, want blltn4ypz", got)
	}
	if persistent[0]["persistent"] != true || persistent[0]["timeoutMs"] != nil {
		t.Fatalf("persistent Monitor recorded persistent=%#v timeoutMs=%#v, want true and absent",
			persistent[0]["persistent"], persistent[0]["timeoutMs"])
	}

	if quoted := h.events.forJob("toolu_quoted"); len(quoted) != 0 {
		t.Fatalf("text quoting a receipt was registered as a Monitor: %v", quoted)
	}

	bash := h.events.terminalsFor("toolu_bash")
	if len(bash) != 1 || asString(bash[0]["shellId"]) != "bei1" ||
		asString(bash[0]["summary"]) != "Background command stopped with the session runtime that launched it" ||
		bash[0]["tool"] != nil {
		t.Fatalf("the Bash shell's killed report changed: %v", bash)
	}
}

// The death this exists to report: a live Monitor, a parked engine, the warm TTL. The recycle is
// the real pool path, not a direct call.
func TestEngineStopReportsLiveMonitorKilled(t *testing.T) {
	h := newEvictionHarness(t, "monitorkilled", 1)
	h.startEngine()
	h.bg.onToolResult("toolu_monitor", monitorTimeoutReceipt)

	h.park()
	h.clock.Advance(warmEngineTTL + time.Second)
	h.afterEngineStopped()

	killed := h.events.withStatus("killed")
	if len(killed) != 1 {
		t.Fatalf("killed events after the engine was recycled = %v, want exactly the Monitor's", killed)
	}
	report := killed[0]
	if got := asString(report["shellId"]); got != "b97q4j1iy" {
		t.Fatalf("task id = %q, want b97q4j1iy", got)
	}
	if got := asString(report["toolUseId"]); got != "toolu_monitor" {
		t.Fatalf("tool_use id = %q, want toolu_monitor", got)
	}
	if got := asString(report["tool"]); got != "Monitor" {
		t.Fatalf("tool = %q, want Monitor: the control plane tells a stopped Monitor from a shell by it", got)
	}
	if summary := asString(report["summary"]); !strings.Contains(summary, "Monitor") ||
		!strings.Contains(summary, "session runtime") {
		t.Fatalf("summary %q does not say the Monitor stopped with the session runtime", summary)
	}
}

// The negative control, with its positive in the same fixture. A Monitor whose own terminal
// notification already arrived is over, so the engine's stop must not report it again; a Monitor
// still running at that moment is reported. The per-event ping carries neither a tool-use id nor a
// status, so it ends nothing.
func TestMonitorEndedOnItsOwnIsNotReportedKilled(t *testing.T) {
	h := newEvictionHarness(t, "monitorended", 1)
	h.startEngine()
	h.bg.onToolResult("toolu_ended", strings.Replace(monitorTimeoutReceipt, "b97q4j1iy", "bended01", 1))
	h.bg.onToolResult("toolu_live", monitorPersistentReceipt)

	// While parked the runner learns of it from the transcript: the stdout stream carries a
	// notification only at the start of the next turn.
	transcript := filepath.Join(h.dir, "session.jsonl")
	lines := jsonlLine(t, "<task-notification>\n<task-id>blltn4ypz</task-id>\n"+
		"<summary>Monitor event: \"CI\" (3 lines)</summary>\n</task-notification>") +
		jsonlLine(t, "<task-notification>\n<task-id>bended01</task-id>\n<tool-use-id>toolu_ended</tool-use-id>\n"+
			"<output-file>"+filepath.Join(h.dir, "bended01.output")+"</output-file>\n<status>completed</status>\n"+
			"<summary>Monitor \"CI\" stream ended</summary>\n</task-notification>")
	if err := os.WriteFile(transcript, []byte(lines), 0o644); err != nil {
		t.Fatal(err)
	}
	h.park()
	h.bg.scanTranscript(transcript, 0)
	h.clock.Advance(warmEngineTTL + time.Second)
	h.afterEngineStopped()

	if ended := h.events.terminalsFor("toolu_ended"); len(ended) != 1 || asString(ended[0]["status"]) != "completed" {
		t.Fatalf("a Monitor that ended on its own must keep exactly its own terminal report, got %v", ended)
	}
	if live := h.events.terminalsFor("toolu_live"); len(live) != 1 || asString(live[0]["status"]) != "killed" {
		t.Fatalf("the Monitor still running when the engine stopped must be reported killed, got %v", live)
	}
}

// A Monitor that reaches the deadline its receipt stated must terminalize the tool_use that launched
// it. Claude's notice of that event names the Monitor's task id and nothing else, so nothing that
// arrives from outside can retire the launch: the id it left in Session.runningBgShells stays there
// for the rest of the session's life, and every later look at the session reads "N background
// processes running". The deadline is stated in the receipt, so the runner can say the watch is over
// without being told.
func TestMonitorExpiryTerminalizesLaunch(t *testing.T) {
	h := newEvictionHarness(t, "monitorexpiry", 1)
	h.startEngine()
	// The persistent Monitor is the negative in the same fixture: it has no deadline of its own, so
	// the pair pins that the deadline — not the registration — is what ends a watch.
	h.bg.onToolResult("toolu_persistent", monitorPersistentReceipt)
	registered := time.Now()
	h.bg.onToolResult("toolu_expires",
		strings.Replace(monitorExpiresReceipt, "expires in 5m", "expires in 1s", 1))

	report := h.events.awaitTerminal(t, "toolu_expires", 10*time.Second)
	if status := asString(report["status"]); !isTerminalBgStatus(status) {
		t.Fatalf("status = %q, which the control plane does not read as an end", status)
	}
	if got := asString(report["toolUseId"]); got != "toolu_expires" {
		t.Fatalf("tool_use id = %q, want toolu_expires: retiring the launch is the whole point", got)
	}
	if got := asString(report["shellId"]); got != "bbairyimf" {
		t.Fatalf("task id = %q, want bbairyimf", got)
	}
	if got, _ := report["timeoutMs"].(int64); got != 1000 {
		t.Fatalf("timeoutMs = %#v, want the receipt's 1000", report["timeoutMs"])
	}
	// The deadline, not the registration: a report sent when the Monitor started would retire a
	// watch that is still running. Only the lower bound is asserted — a loaded machine can only
	// make the report later, never earlier.
	if elapsed := time.Since(registered); elapsed < 900*time.Millisecond {
		t.Fatalf("the terminal report arrived after %s, before the receipt's deadline", elapsed)
	}
	if live := h.events.terminalsFor("toolu_persistent"); len(live) != 0 {
		t.Fatalf("the persistent Monitor was expired by the deadline beside it: %v", live)
	}
	if got := h.bg.monitorsLive.Load(); got != 1 {
		t.Fatalf("live Monitors = %d, want 1: the persistent one is still watching, the expired one is over", got)
	}
	// Reported once, and only once: the engine's stop that follows must not also report this Monitor
	// killed — the report above is the end of it.
	h.bg.killEngineShells()
	if reports := h.events.terminalsFor("toolu_expires"); len(reports) != 1 {
		t.Fatalf("the expired Monitor was reported %d times: %v", len(reports), reports)
	}
}
