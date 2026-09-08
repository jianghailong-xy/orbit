package main

import "testing"

type emitted struct {
	typ     string
	payload map[string]interface{}
}

func collect() (emitFn, *[]emitted) {
	var got []emitted
	return func(t string, p map[string]interface{}) { got = append(got, emitted{t, p}) }, &got
}

// Compaction is the one moment Claude silently drops history. Storing where it happened, and the
// summary it wrote, is what lets a later rebuild replay around it instead of paying to summarize
// that history all over again (transcript_rebuild.go).
func TestCompactBoundaryMetadataIsStored(t *testing.T) {
	emit, got := collect()
	// Note the wire is snake_case; the on-disk transcript spells the same fields camelCase.
	handleMessage(map[string]interface{}{
		"type":       "system",
		"subtype":    "compact_boundary",
		"session_id": "s1",
		"compact_metadata": map[string]interface{}{
			"trigger": "manual", "pre_tokens": float64(100),
		},
		"logical_parent_uuid": "u1",
	}, emit, nil)

	if len(*got) != 1 || (*got)[0].typ != evSystem {
		t.Fatalf("events = %v", *got)
	}
	md, ok := (*got)[0].payload["compactMetadata"].(map[string]interface{})
	if !ok || md["trigger"] != "manual" {
		t.Fatalf("compaction metadata was dropped: %v", (*got)[0].payload)
	}
	// An ordinary system ping must stay the bare three keys, or every progress tick would
	// escape the noise filter that keeps them out of transcripts.
	emit2, got2 := collect()
	handleMessage(map[string]interface{}{
		"type": "system", "subtype": "thinking_tokens", "session_id": "s1",
	}, emit2, nil)
	if _, present := (*got2)[0].payload["compactMetadata"]; present {
		t.Fatalf("a plain ping grew a compaction key: %v", (*got2)[0].payload)
	}
}

func TestCompactSummaryIsStored(t *testing.T) {
	summary := compactSummaryMarker + " that ran out of context.\n\nSummary:\nwe fixed the parser."

	emit, got := collect()
	handleMessage(map[string]interface{}{
		"type":        "user",
		"isSynthetic": true,
		"message":     map[string]interface{}{"role": "user", "content": summary},
	}, emit, nil)
	if len(*got) != 1 || (*got)[0].payload["subtype"] != "compact_summary" {
		t.Fatalf("the summary was not stored: %v", *got)
	}
	if (*got)[0].payload["text"] != summary {
		t.Fatalf("summary text was altered")
	}

	// A user who types or pastes that same sentence is a real turn: the inbox already emitted
	// it and --replay-user-messages is echoing it back, so storing it again would both double
	// the message and fake a compaction that never happened.
	emit2, got2 := collect()
	handleMessage(map[string]interface{}{
		"type":    "user",
		"message": map[string]interface{}{"role": "user", "content": summary},
	}, emit2, nil)
	if len(*got2) != 0 {
		t.Fatalf("a replayed user turn must not be mistaken for a compaction: %v", *got2)
	}

	// The ordinary path is untouched: tool results still come through as before.
	emit3, got3 := collect()
	handleMessage(map[string]interface{}{
		"type": "user",
		"message": map[string]interface{}{"role": "user", "content": []interface{}{
			map[string]interface{}{"type": "tool_result", "tool_use_id": "t1", "content": "ok"},
		}},
	}, emit3, nil)
	if len(*got3) != 1 || (*got3)[0].typ != evToolResult {
		t.Fatalf("tool results regressed: %v", *got3)
	}
}

func TestCoordinatorContextBoundaryEventsEnterTheCompletionFlushBarrier(t *testing.T) {
	for _, payload := range []map[string]interface{}{
		{"subtype": "compact_boundary"},
		{"subtype": "compact_summary"},
		{"subtype": "context_compacted"},
		{"subtype": "future_name", "compactMetadata": map[string]interface{}{"trigger": "auto"}},
	} {
		if !coordinatorContextBoundaryEvent(evSystem, payload) {
			t.Errorf("boundary payload was not classified: %#v", payload)
		}
	}
	if coordinatorContextBoundaryEvent(evAssistant, map[string]interface{}{"subtype": "compact_boundary"}) {
		t.Fatal("a non-system event entered the compaction flush barrier")
	}
}

// The pre-turn compaction window: the CLI summarizes a conversation that no longer fits BEFORE
// it reads the message it was sent, and emits nothing else for however long that takes. These
// frames are the only thing that crosses during it.
func TestEnginePhaseCrossesOnlyForCompaction(t *testing.T) {
	statusFrame := func(extra map[string]interface{}) map[string]interface{} {
		msg := map[string]interface{}{"type": "system", "subtype": "status", "session_id": "s1"}
		for k, v := range extra {
			msg[k] = v
		}
		return msg
	}

	emit, got := collect()
	handleMessage(statusFrame(map[string]interface{}{"status": "compacting"}), emit, nil)
	if len(*got) != 1 || (*got)[0].payload["enginePhase"] != "compacting" {
		t.Fatalf("compaction was not named: %v", *got)
	}

	// The frame that closes one reports `status: null` and the outcome; only "it is over"
	// crosses. Without it a compaction that ends producing nothing would read as still running.
	emitEnd, gotEnd := collect()
	handleMessage(statusFrame(map[string]interface{}{
		"status": nil, "compact_result": "failed", "compact_error": "Not enough messages to compact.",
	}), emitEnd, nil)
	if len(*gotEnd) != 1 || (*gotEnd)[0].payload["enginePhase"] != "none" {
		t.Fatalf("the end of a compaction was not named: %v", *gotEnd)
	}

	// The negative that matters, and the reason this is not just "forward `status`": the other
	// phases fire on every single turn. Naming one would put a key outside the ping set on that
	// event, which is exactly what lifts it out of the control plane's noise filter — and the
	// filter exists because these are ~92% of all stored events.
	for _, phase := range []string{"requesting", "responding", "thinking", "tool-use"} {
		emitOther, gotOther := collect()
		handleMessage(statusFrame(map[string]interface{}{"status": phase}), emitOther, nil)
		if len(*gotOther) != 1 {
			t.Fatalf("%s produced %d events", phase, len(*gotOther))
		}
		if _, named := (*gotOther)[0].payload["enginePhase"]; named {
			t.Fatalf("%s escaped the noise filter: %v", phase, (*gotOther)[0].payload)
		}
		for key := range (*gotOther)[0].payload {
			if key != "subtype" && key != "model" && key != "sessionId" {
				t.Fatalf("%s grew a non-ping key %q: %v", phase, key, (*gotOther)[0].payload)
			}
		}
	}

	// A handshake is not a phase ping and must not grow one.
	emitInit, gotInit := collect()
	handleMessage(map[string]interface{}{"type": "system", "subtype": "init", "session_id": "s1"}, emitInit, nil)
	if _, named := (*gotInit)[0].payload["enginePhase"]; named {
		t.Fatalf("init grew a phase: %v", (*gotInit)[0].payload)
	}
}
