package main

import (
	"context"
	"os"
	"strings"
	"testing"
)

// A steer is a user message written into the turn that is ALREADY running. Only an engine with
// a way to take one mid-turn can be handed it, and only by a binary that implements that way —
// the control plane asks both questions before it files the turn (steersMidTurn, and the
// capability declared from it). So a steer reaching a loop that cannot deliver one means the two
// disagree: a runner older than the control plane, or a session whose provider moved under it.
//
// What must NOT happen then is nothing. The turn is already leased (so it is gone from the queued
// list) and a steer's lease is never reclaimed (re-writing a message the engine may have acted on
// is the one thing mid-turn delivery must not do), so a message dropped here is gone for good,
// with no event, no error and no trace.

func TestRefusingASteerSettlesItInsteadOfDroppingIt(t *testing.T) {
	job := &ClaimedSession{SessionID: "s-1", Agent: AgentExecConfig{Provider: providerCodex}}
	type event struct {
		turnID  string
		typ     string
		payload map[string]interface{}
	}
	var events []event
	var completions []TurnCompleteRequest
	emitFor := func(turnID, eventType string, payload map[string]interface{}) {
		events = append(events, event{turnID, eventType, payload})
	}
	complete := func(req TurnCompleteRequest, _ ...context.Context) error {
		completions = append(completions, req)
		return nil
	}

	refuseUnsupportedSteer("turn-9", "actually, call it gadget", providerCodex, job, emitFor, complete)

	// The refusal enters the transcript. Without it the sender watches an optimistic bubble wait
	// for a reply that is never coming, and a reload has nothing to render the message from at
	// all — a steer is answered by the turn it joined, so it has no reply of its own to wait for.
	if len(events) != 2 {
		t.Fatalf("events = %+v, want a user event and a delivery report", events)
	}
	if events[0].typ != evUser || events[0].turnID != "turn-9" {
		t.Errorf("first event = %+v, want a user event on turn-9", events[0])
	}
	if events[0].payload["text"] != "actually, call it gadget" {
		t.Errorf("user event text = %v", events[0].payload["text"])
	}
	// Never as a message that looks sent: it says up front that it was not delivered.
	if events[0].payload["delivery"] != string(deliveryFailed) || events[0].payload["steer"] != true {
		t.Errorf("user event payload = %+v, want a failed steer", events[0].payload)
	}
	if events[1].typ != evUserDelivery || events[1].payload["turnId"] != "turn-9" {
		t.Errorf("second event = %+v, want a user_delivery for turn-9", events[1])
	}
	reason, _ := events[1].payload["reason"].(string)
	// Diagnosable: it names the engine and what about it made this impossible, not "failed".
	if !strings.Contains(reason, providerCodex) || !strings.Contains(reason, "while a turn is running") {
		t.Errorf("reason = %q, want it to name the engine and the reason", reason)
	}
	// Nothing was written, so sending the same message again is safe.
	if events[1].payload["retryable"] != true {
		t.Errorf("retryable = %v, want true", events[1].payload["retryable"])
	}

	// The turn is settled, so it stops being an in-flight row nobody will ever answer…
	if len(completions) != 1 {
		t.Fatalf("completions = %+v, want exactly one", completions)
	}
	if completions[0].TurnID != "turn-9" || completions[0].Status != stFailed {
		t.Errorf("completion = %+v, want turn-9 failed", completions[0])
	}
	// …as a STEER, which is what keeps this from taking the session down with it. The turn this
	// message was meant to join is still running, and a side-channel message that never reached
	// the engine is no reason to seal a working run's event stream.
	if completions[0].Subtype != subtypeSteer {
		t.Errorf("completion subtype = %q, want %q", completions[0].Subtype, subtypeSteer)
	}
	if !strings.Contains(completions[0].Result, "cannot be given a message") {
		t.Errorf("completion result = %q", completions[0].Result)
	}
}

// The bug this closes was not in any one provider — it was a `switch resp.Kind` with no arm for
// a kind that had just been invented, in three loops at once. A fourth engine added tomorrow
// would land the same way, and the failure is silent by construction: the turn is leased and
// never comes back, so nothing anywhere says a message went missing.
//
// Keyed on steersMidTurn, not on the transport: codex and kimi are both json-rpc and only codex
// has a call that folds a message into the running turn, so the transport cannot answer which
// loops still have to refuse one.
func TestEverySessionLoopThatCannotSteerRefusesOne(t *testing.T) {
	loops := map[string][]string{
		// provider → the source files its inbox dispatch lives in.
		providerCodex:    {"codex_appserver.go"},
		providerKimi:     {"kimi_acp.go"},
		providerOpenCode: {"opencode.go"},
	}

	checked := 0
	for provider, runtime := range providerRuntimes {
		if runtime.steersMidTurn {
			continue // this loop delivers the steer instead of refusing it; that is the feature
		}
		checked++
		files, known := loops[provider]
		if !known {
			t.Errorf("no session loop is listed for provider %q; add its file here and give its "+
				"inbox switch a `case \"steer\"`", provider)
			continue
		}
		for _, file := range files {
			src, err := os.ReadFile(file)
			if err != nil {
				t.Fatalf("read %s: %v", file, err)
			}
			if !strings.Contains(string(src), `case "steer":`) {
				t.Errorf("%s has no `case \"steer\"`: a steer handed to %s would be dropped silently",
					file, provider)
			}
			// A loop that cannot deliver one must still settle it where the sender can see it.
			if !runtime.steersMidTurn && !strings.Contains(string(src), "refuseUnsupportedSteer(") {
				t.Errorf("%s cannot deliver a steer and does not refuse the one it matches", file)
			}
		}
	}
	if checked == 0 {
		t.Fatal("no non-steering provider was checked; this test proved nothing")
	}
}

// What this binary tells the control plane about mid-turn delivery. The control plane files a
// `steer` for a runtime only when the runner holding the session has named it, so this list is
// a promise: a token declared for a loop that still refuses steers turns a mid-turn message
// from something that quietly queued into something that fails in front of the user, on every
// send (docs/codex-turn-steer-contract.md §6.1).
func TestOnlyAnImplementedSteerIsDeclaredToTheControlPlane(t *testing.T) {
	declared := map[string]bool{}
	for _, capability := range declaredSteerCapabilities() {
		if capability == "" {
			t.Fatal("declared an empty capability token")
		}
		declared[capability] = true
	}

	for provider, runtime := range providerRuntimes {
		switch {
		case runtime.steerCapability == "":
			// claude: its mid-turn delivery predates the gate and needs no token. Nothing to
			// declare, and nothing that could withdraw it from the runners already in the field.
		case runtime.steersMidTurn && !declared[runtime.steerCapability]:
			t.Errorf("%s steers mid-turn but does not declare %q, so the control plane will "+
				"never file one for it", provider, runtime.steerCapability)
		case !runtime.steersMidTurn && declared[runtime.steerCapability]:
			t.Errorf("%s declares %q while its loop still refuses a steer", provider, runtime.steerCapability)
		}
	}

	// The declaration travels on the header every request already carries, which is what lets
	// the same word gate both how a message is filed (from the heartbeat snapshot) and whether
	// it is handed over (from the poller itself).
	for _, capability := range declaredSteerCapabilities() {
		if !strings.Contains(runnerCapabilitiesV1, capability) {
			t.Errorf("capability %q is declared but missing from the header %q", capability, runnerCapabilitiesV1)
		}
	}
}

// providerRuntime.steersMidTurn is what the control plane's own answer has to agree with: it decides
// whether a message becomes a steer BEFORE the runner ever sees it, so a provider marked as
// steering here whose loop cannot actually deliver one turns every mid-turn message on that
// engine into a visible failure instead of a quiet queue.
func TestOnlyEnginesWithAMidTurnMethodClaimToSteer(t *testing.T) {
	// The method each steering engine writes a mid-turn message with. An engine reaching this
	// list is a deliberate act: there is no transport-shaped rule that would put it here.
	methods := map[string]string{
		providerClaude: "userFrame(", // a `user` frame on a stdin that stays open (session.go)
		providerCodex:  "turn/steer", // written into the turn in progress (codex_steer.go)
	}
	for provider, runtime := range providerRuntimes {
		if !runtime.steersMidTurn {
			continue
		}
		method, known := methods[provider]
		if !known {
			t.Errorf("provider %q claims to steer; name the call it delivers a mid-turn message "+
				"with here, so this stays a fact about the code rather than a flag", provider)
			continue
		}
		found := false
		for _, file := range []string{"session.go", "codex_steer.go"} {
			src, err := os.ReadFile(file)
			if err != nil {
				t.Fatalf("read %s: %v", file, err)
			}
			found = found || strings.Contains(string(src), method)
		}
		if !found {
			t.Errorf("provider %q claims to steer via %q, which no longer appears in the runner: "+
				"the control plane would keep filing mid-turn messages nothing can deliver",
				provider, method)
		}
	}
}
