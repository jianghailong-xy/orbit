package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
)

func TestSessionCurrentWorkDeliveryFlushFiveHundredsRemainStickyBeforeTurnComplete(t *testing.T) {
	rejections := 0
	policy := eventFlushRetryPolicy(&rejections)
	var rejected error
	for i := 0; i < maxEventFlushServerRejections; i++ {
		rejected = serverError(http.StatusInternalServerError)
		if retry := policy(rejected); retry != (i+1 < maxEventFlushServerRejections) {
			t.Fatalf("retry after rejection %d = %v", i+1, retry)
		}
	}

	fence := &criticalEventFlushFence{}
	dropErr := fence.recordDropped([]RunEvent{{
		Seq:    41,
		Type:   evUserDelivery,
		TurnID: "current-work-1",
		Payload: map[string]interface{}{
			"turnId":   "current-work-1",
			"delivery": string(deliveryAcknowledged),
		},
	}}, rejected)
	if dropErr == nil {
		t.Fatal("critical acknowledgement drop did not become sticky")
	}

	turnCompleteCalled := false
	_, err := (&coordinatorContextFlushBarrier{}).beforeTurnComplete(
		context.Background(),
		func(context.Context) error {
			// The batch has already left the queue. Its sticky fence must still make this empty
			// flush fail instead of manufacturing ACK-before-complete success.
			return fence.check()
		},
		func(context.Context) (string, error) {
			turnCompleteCalled = true
			return stAwaitingInput, nil
		},
	)
	if err == nil {
		t.Fatal("empty flush hid the permanently rejected CURRENT_WORK acknowledgement")
	}
	if turnCompleteCalled {
		t.Fatal("turn-complete ran without a durable CURRENT_WORK acknowledgement proof")
	}
}

func serverError(status int) error {
	return &transportHTTPError{method: "POST", path: "/events", statusCode: status}
}

func TestEventFlushRetryPolicyGivesUpOnSustainedServerRejections(t *testing.T) {
	rejections := 0
	policy := eventFlushRetryPolicy(&rejections)

	for i := 1; i < maxEventFlushServerRejections; i++ {
		if !policy(serverError(http.StatusInternalServerError)) {
			t.Fatalf("stopped retrying after %d rejections, want at least %d", i, maxEventFlushServerRejections)
		}
	}
	// The batch the server will never accept must not be replayed forever: past the ceiling the
	// caller drops it rather than parking every later event for the session behind it.
	if policy(serverError(http.StatusInternalServerError)) {
		t.Fatal("kept retrying past the ceiling")
	}
	if rejections != maxEventFlushServerRejections {
		t.Fatalf("rejections = %d, want %d", rejections, maxEventFlushServerRejections)
	}
}

func TestEventFlushRetryPolicyKeepsRetryingRecoverableFailures(t *testing.T) {
	rejections := 0
	policy := eventFlushRetryPolicy(&rejections)

	// A deploy fails the connection or answers 502/503; none of it is the batch's fault, and a
	// long outage must not cost the events waiting behind it.
	for i := 0; i < maxEventFlushServerRejections*3; i++ {
		for _, err := range []error{
			errors.New("connection refused"),
			serverError(http.StatusBadGateway),
			serverError(http.StatusServiceUnavailable),
			serverError(http.StatusTooManyRequests),
		} {
			if !policy(err) {
				t.Fatalf("gave up on a recoverable failure: %v", err)
			}
		}
	}
	if rejections != 0 {
		t.Fatalf("rejections = %d, want 0", rejections)
	}
}

func TestEventFlushRetryPolicyResetsWhenTheServerRecovers(t *testing.T) {
	rejections := 0
	policy := eventFlushRetryPolicy(&rejections)

	for i := 0; i < maxEventFlushServerRejections-1; i++ {
		policy(serverError(http.StatusInternalServerError))
	}
	// One non-500 proves the batch isn't poison, so the ceiling starts over — an intermittent
	// 500 amid a flaky link must not accumulate into a drop.
	policy(serverError(http.StatusBadGateway))
	if !policy(serverError(http.StatusInternalServerError)) {
		t.Fatal("counted rejections across a recovery")
	}
}

// A flush holding more than one request may carry goes out as consecutive requests within
// maxEventBatchBytes, each event once and in seq order; an event larger than that on its own still
// goes, alone.
func TestEventBatchLenKeepsEachRequestWithinTheCap(t *testing.T) {
	event := func(seq, size int) RunEvent {
		return RunEvent{Seq: seq, Type: evToolResult, TS: "2026-10-15T00:00:00.000Z",
			Payload: map[string]interface{}{"toolUseId": "t", "content": strings.Repeat("x", size)}}
	}
	split := func(events []RunEvent) [][]RunEvent {
		var batches [][]RunEvent
		for len(events) > 0 {
			n := eventBatchLen(events, maxEventBatchBytes)
			if n < 1 {
				t.Fatalf("eventBatchLen = %d for %d events, want at least one", n, len(events))
			}
			batches = append(batches, events[:n])
			events = events[n:]
		}
		return batches
	}

	var events []RunEvent
	for seq := 1; seq <= 10; seq++ {
		events = append(events, event(seq, 300<<10))
	}
	batches := split(events)
	if len(batches) != 2 {
		t.Errorf("3 MB of events went out in %d request(s), want 2", len(batches))
	}
	next := 1
	for i, batch := range batches {
		body, _ := json.Marshal(RunEventBatch{LeaseOwner: "4e453ab7-f37c-494d-8017-bb4e9beffeef", Events: batch})
		if len(body) > maxEventBatchBytes {
			t.Errorf("request %d is %d bytes, over the %d a request may carry", i+1, len(body), maxEventBatchBytes)
		}
		for _, e := range batch {
			if e.Seq != next {
				t.Fatalf("request %d carries seq %d where %d comes next", i+1, e.Seq, next)
			}
			next++
		}
	}
	if next != 11 {
		t.Errorf("the requests carried %d of 10 events", next-1)
	}

	oversized := split([]RunEvent{event(1, 10), event(2, 3<<20), event(3, 10)})
	if len(oversized) != 3 || len(oversized[1]) != 1 || oversized[1][0].Seq != 2 {
		t.Errorf("an oversized event went out as %d request(s) of %v events, want it alone between the other two",
			len(oversized), batchSeqs(oversized))
	}
}

func batchSeqs(batches [][]RunEvent) [][]int {
	var out [][]int
	for _, batch := range batches {
		var seqs []int
		for _, e := range batch {
			seqs = append(seqs, e.Seq)
		}
		out = append(out, seqs)
	}
	return out
}

func TestEventFlushRetryPolicyStillRefusesNonRetryableFailures(t *testing.T) {
	rejections := 0
	policy := eventFlushRetryPolicy(&rejections)

	// Lease ownership loss (409/403/404) ends the flush immediately, as before.
	for _, status := range []int{http.StatusConflict, http.StatusForbidden, http.StatusNotFound, http.StatusBadRequest} {
		if policy(serverError(status)) {
			t.Fatalf("retried a non-retryable %d", status)
		}
	}
}
