package main

import (
	"encoding/json"
	"sort"
)

// What becomes of each event a session emits while its work goes over the runner link (docs/runner-link-design.md
// §5.8, §5.9; task B8).
//
// Over HTTPS every event takes the next durable seq and goes in the same batch, and the ingest sorts them: it stores
// what is worth storing and broadcasts the rest in-process. Over the link the two streams are separate, and an event
// the ingest would not store must not take a durable seq at all. B5's link ingest refuses a live-only event with
// EVENT_LIVE_ONLY and holds its seq with a tombstone. It acknowledges a noise ping without storing it, which leaves a
// hole in run_event: Welcome's durable_seq stops there, and C1a's check that a session's seqs have no gaps fails. So:
//
//   - A live-only event (the server's NON_REPLAYABLE_EVENT_TYPES) goes in a LiveBatch, with a live_seq of its own, and
//     only while somebody watches the session (link_events_live.go).
//   - A noise ping (the server's isNoiseSystemEvent, common/system-noise.ts) is dropped. Neither door stores or
//     broadcasts one, and the apiserver's live decoder takes none.
//   - A ping-shaped coordinator-context boundary is the exception: the ingest reads it before the noise filter
//     (coordinatorContextEpoch, runner-api.controller.ts), so dropping it would stop a coordinator's context from
//     being given back after a compaction. It carries "provider" over the link, as the runner's init, resumed and
//     reload events do, which makes it an event the server stores at its seq.
//   - Everything else is durable: it takes the next seq and goes in an EventBatch (link_events.go).
//
// The runner's reading of these server rules has to be the server's own, or a seq is taken and never stored (a hole)
// or an event is dropped that the server reads. testdata/b8-link-events.json is generated from the server's code
// (scripts/runner-link/gen-event-kind-fixtures.mjs), and TestLinkEventKindsAreTheServers holds this file to it, case by
// case.

// linkEventFate is what becomes of an emitted event in link mode.
type linkEventFate int

const (
	// linkDurable: it takes the next durable seq and goes in an EventBatch.
	linkDurable linkEventFate = iota
	// linkLive: it goes in a LiveBatch, while the session is watched, and takes no durable seq.
	linkLive
	// linkDropped: a noise ping, which nothing stores or shows; it takes no seq.
	linkDropped
)

// linkLiveOnlyTypes is the server's NON_REPLAYABLE_EVENT_TYPES (common/system-noise.ts): the kinds that belong to a live
// connection only and are never stored. The link's ingest refuses each of them with EVENT_LIVE_ONLY.
var linkLiveOnlyTypes = map[string]bool{
	evTextDelta:            true,
	evThinkingDelta:        true,
	evToolOutput:           true,
	"approval_request":     true,
	"approval_resolved":    true,
	"queued_turns_changed": true,
	evBackgroundOutput:     true,
	evTaskProgress:         true,
	"resync":               true,
	"tombstone":            true,
}

// The two halves of the server's isNoiseSystemEvent: the system subtypes something reads, and the keys a bare progress
// ping carries.
var (
	linkMeaningfulSystemSubtypes = map[string]bool{"init": true, "resumed": true}
	linkPingKeys                 = map[string]bool{"model": true, "subtype": true, "sessionId": true}
)

// linkCoordinatorBoundarySubtypes is the server's COORDINATOR_CONTEXT_BOUNDARY_SUBTYPES (runner-api.controller.ts): the
// system subtypes whose seq the ingest takes as a session's new coordinator-context epoch, read from every event of a
// batch, noise pings included.
var linkCoordinatorBoundarySubtypes = map[string]bool{"compact_boundary": true, "compact_summary": true, "context_compacted": true}

// linkLiveEventSeqSubtype names the bare ping that holds the seq of a live event numbered while the session's events
// went over HTTPS, when that event is sent over the link after all (linkLiveEventSeqPlaceholder).
const linkLiveEventSeqSubtype = "live_event_seq"

// linkNoiseSystemEvent is the server's isNoiseSystemEvent: a system event carrying nothing anybody could use. Its
// payload holds nothing but the ping keys, and its subtype is not one something reads.
func linkNoiseSystemEvent(eventType string, payload map[string]interface{}) bool {
	if eventType != evSystem {
		return false
	}
	if subtype, ok := payload["subtype"].(string); ok && linkMeaningfulSystemSubtypes[subtype] {
		return false
	}
	for key := range payload {
		if !linkPingKeys[key] {
			return false
		}
	}
	return true
}

// linkRowEvent reports whether the control plane stores an event, as it was sent, as a row of run_event: over HTTPS and
// over the link alike, a live-only event and a noise ping are stored as nothing. Only a row can satisfy a call's
// after_seq (assertAfterSeqStored, runner-link-call.ts): a turn completion that depended on a seq held by nothing but a
// ping would wait for ever.
func linkRowEvent(eventType string, payload map[string]interface{}) bool {
	return !linkLiveOnlyTypes[eventType] && !linkNoiseSystemEvent(eventType, payload)
}

// linkEventFateOf is what becomes of an event in link mode, and the payload it goes with: a ping-shaped
// coordinator-context boundary goes with "provider" added.
func linkEventFateOf(eventType string, payload map[string]interface{}, provider string) (linkEventFate, map[string]interface{}) {
	if linkLiveOnlyTypes[eventType] {
		return linkLive, payload
	}
	if !linkNoiseSystemEvent(eventType, payload) {
		return linkDurable, payload
	}
	if subtype, _ := payload["subtype"].(string); linkCoordinatorBoundarySubtypes[subtype] {
		return linkDurable, linkWithProvider(payload, provider)
	}
	return linkDropped, payload
}

// linkWithProvider is a copy of payload that names the session's engine.
func linkWithProvider(payload map[string]interface{}, provider string) map[string]interface{} {
	out := make(map[string]interface{}, len(payload)+1)
	for k, v := range payload {
		out[k] = v
	}
	out["provider"] = provider
	return out
}

// linkLiveEventSeqPlaceholder is what an EventBatch carries in place of a live event that took a durable seq while the
// session's events went over HTTPS, and is sent over the link after all: at the cut-over, events numbered before the
// first UPGRADE_REQUIRED are still in the buffer. A bare ping, so the server acknowledges it without storing,
// broadcasting or tombstoning it, as HTTPS never stored the live event either. Only seqs numbered under HTTP mode are
// ever held this way. The live event itself is not sent: by now it is stale, and the durable assistant and thinking
// events carry its text.
func linkLiveEventSeqPlaceholder() map[string]interface{} {
	return map[string]interface{}{"subtype": linkLiveEventSeqSubtype}
}

// linkBoundaryEvent reports whether an event is one the session's durable stream sends at once rather than at its next
// tick (§5.8: a reply's end, a tool's result, a change of state). The tick is linkEventCadence; tool calls, thinking
// blocks and other system events wait for it.
func linkBoundaryEvent(eventType string, payload map[string]interface{}) bool {
	switch eventType {
	case evAssistant, evToolResult, evTurnEnd, evUser, evUserDelivery, evError, evInterrupt, evBackgroundTask,
		evPromptSuggestion:
		return true
	case evSystem:
		subtype, _ := payload["subtype"].(string)
		return linkMeaningfulSystemSubtypes[subtype]
	}
	return false
}

// linkProgressKind names the progress report an event is, "" for any other event: a report whose newest value is all
// anybody reads, which may take the place of an unsent one of the same kind while the link's credit holds the
// session's events back (§5.8). The context gauge (context_ping.go, dsh_events.go) is the one there is.
func linkProgressKind(eventType string, payload map[string]interface{}) string {
	if eventType != evSystem {
		return ""
	}
	if subtype, _ := payload["subtype"].(string); subtype == "context" {
		return "system/context"
	}
	return ""
}

// linkTrimFieldBytes is the largest top-level field of a payload a trimmed event keeps.
const linkTrimFieldBytes = 4 << 10

// linkTrimmedPayload is what an event whose payload the link cannot carry goes with instead: every top-level field of
// at most linkTrimFieldBytes, how many bytes the payload had (omittedBytes), and the names of the fields left out
// (omittedFields). Ids, flags and short texts survive, so the event still reads as what it was.
func linkTrimmedPayload(payload map[string]interface{}, size int) []byte {
	out := map[string]interface{}{}
	var omitted []string
	for k, v := range payload {
		raw, err := json.Marshal(v)
		if err != nil || len(raw) > linkTrimFieldBytes {
			omitted = append(omitted, k)
			continue
		}
		out[k] = json.RawMessage(raw)
	}
	sort.Strings(omitted)
	out["omittedBytes"] = size
	out["omittedFields"] = omitted
	b, err := json.Marshal(out)
	if err != nil || len(b) > linkBatchMaxBytes {
		// So many small fields that even they are too much: the size is all that is left.
		b, _ = json.Marshal(map[string]interface{}{"omittedBytes": size, "omittedFields": []string{"*"}})
	}
	return b
}
