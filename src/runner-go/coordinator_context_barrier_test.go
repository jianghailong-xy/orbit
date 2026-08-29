package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync"
	"testing"
	"time"
)

func TestCoordinatorContextBarrierWaitsForEventsBeforeTurnComplete(t *testing.T) {
	eventsStarted := make(chan struct{})
	releaseEvents := make(chan struct{})
	turnCompleteStarted := make(chan struct{}, 1)

	var orderMu sync.Mutex
	var order []string
	record := func(step string) {
		orderMu.Lock()
		order = append(order, step)
		orderMu.Unlock()
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/runner/sessions/s1/events":
			record("events-started")
			close(eventsStarted)
			<-releaseEvents
			w.WriteHeader(http.StatusAccepted)
		case "/api/runner/sessions/s1/turn-complete":
			record("turn-complete-started")
			turnCompleteStarted <- struct{}{}
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"ok":true,"status":"AWAITING_INPUT"}`)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(func() {
		select {
		case <-releaseEvents:
		default:
			close(releaseEvents)
		}
		srv.Close()
	})

	transport := NewTransport(srv.URL, "token")
	barrier := &coordinatorContextFlushBarrier{}
	barrier.mark()

	done := make(chan error, 1)
	go func() {
		_, err := barrier.beforeTurnComplete(
			context.Background(),
			func(ctx context.Context) error {
				err := transport.postEvents(ctx, "s1", RunEventBatch{Events: []RunEvent{{
					Seq:     1,
					Type:    evSystem,
					Payload: map[string]interface{}{"subtype": "context_compacted"},
				}}})
				if err == nil {
					record("events-succeeded")
				}
				return err
			},
			func(ctx context.Context) (string, error) {
				return transport.turnComplete(ctx, "s1", TurnCompleteRequest{
					TurnID: "t1",
					Status: stSucceeded,
				})
			},
		)
		done <- err
	}()

	select {
	case <-eventsStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("compaction /events request did not start")
	}

	select {
	case <-turnCompleteStarted:
		t.Fatal("/turn-complete started before compaction /events succeeded")
	case <-time.After(100 * time.Millisecond):
	}

	close(releaseEvents)
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("barrier did not proceed after compaction /events succeeded")
	}

	orderMu.Lock()
	got := append([]string(nil), order...)
	orderMu.Unlock()
	want := []string{"events-started", "events-succeeded", "turn-complete-started"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("request order = %v, want %v", got, want)
	}
}

func TestCoordinatorContextBarrierFlushesABoundaryObservedDuringTheFirstRequest(t *testing.T) {
	barrier := &coordinatorContextFlushBarrier{}
	barrier.mark()
	flushes := 0

	err := barrier.flush(context.Background(), func(context.Context) error {
		flushes++
		if flushes == 1 {
			barrier.mark()
		}
		return nil
	})

	if err != nil {
		t.Fatal(err)
	}
	if flushes != 2 {
		t.Fatalf("flush count = %d, want 2", flushes)
	}
}
