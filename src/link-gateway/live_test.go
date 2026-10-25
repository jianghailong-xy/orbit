package main

import (
	"fmt"
	"testing"
	"time"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	"orbit/link-gateway/linkpb"
)

// The live stream, its watchers and turn prefixes (live.go).

func watchersMessage(session string, n int) []byte {
	return []byte(fmt.Sprintf(`{"hint":{"watchers":{"sessionId":%q,"watchers":%d}}}`, session, n))
}

func liveFrame(session string, seqs ...uint64) *linkpb.Frame {
	lb := &linkpb.LiveBatch{SessionId: session}
	for _, seq := range seqs {
		lb.Events = append(lb.Events, &linkpb.LiveEvent{LiveSeq: seq, Type: "text_delta", TsUnixMs: 1_761_380_000_000 + int64(seq),
			TurnId: "0190a0b0-0000-7000-8000-0000000000f1", PayloadJson: []byte(fmt.Sprintf(`{"text":"part %d é"}`, seq))})
	}
	return &linkpb.Frame{Body: &linkpb.Frame_LiveBatch{LiveBatch: lb}}
}

// never checks that the runner was sent no frame of body for a moment; other frames may come.
func (tc *testConn) never(body string, d time.Duration) {
	tc.t.Helper()
	deadline := time.After(d)
	for {
		select {
		case f := <-tc.frames:
			if bodyName(f) == body {
				tc.t.Fatalf("the runner was sent %s", summarize(f))
			}
		case <-deadline:
			return
		}
	}
}

// watchersHint waits for the next watchers hint the runner is sent.
func (tc *testConn) watchersHint(timeout time.Duration) *linkpb.WatchersHint {
	tc.t.Helper()
	return tc.await("hint", timeout, func(f *linkpb.Frame) bool { return f.GetHint().GetWatchers() != nil }).GetHint().GetWatchers()
}

// linkRunner is a runner in MODE_LINK with NATS between the apiserver (the test) and the gateway.
func linkRunner(t *testing.T, mutate func(*config)) (*harness, *natsStandIn, *testConn) {
	t.Helper()
	nats := listenNATS(t, "127.0.0.1:0")
	backend := newFakeBackend(t, heartbeatAnswer)
	h := newLinkHarness(t, []*fakeBackend{backend}, mutate)
	relayTo(t, h, nats.url())
	tc, _ := h.connectLink(runnerA, processA)
	eventually(t, 5*time.Second, "A's subject subscribed", func() bool { return nats.subscribers("rnr."+runnerA) == 1 })
	return h, nats, tc
}

func TestWatchersAreSummedAcrossApiserverInstances(t *testing.T) {
	_, nats, tc := linkRunner(t, nil)
	for _, step := range []struct {
		instance string
		n        int
		want     uint32
	}{{"i-1", 1, 1}, {"i-2", 2, 3}, {"i-1", 0, 2}, {"i-2", 0, 0}} {
		nats.deliverMsg("rnr."+runnerA, "", map[string]string{"Orbit-Instance": step.instance}, watchersMessage(watchedSession, step.n))
		if w := tc.watchersHint(5 * time.Second); w.GetSessionId() != watchedSession || w.GetWatchers() != step.want {
			t.Fatalf("%s says %d: the runner was told %v, want %d", step.instance, step.n, w, step.want)
		}
	}
	// The same count again moves nothing: the runner is told nothing new.
	nats.deliverMsg("rnr."+runnerA, "", map[string]string{"Orbit-Instance": "i-1"}, watchersMessage(watchedSession, 1))
	tc.watchersHint(5 * time.Second)
	nats.deliverMsg("rnr."+runnerA, "", map[string]string{"Orbit-Instance": "i-1"}, watchersMessage(watchedSession, 1))
	tc.quiet(300 * time.Millisecond)
}

func TestALiveBatchIsPublishedOnlyWhileSomeoneWatches(t *testing.T) {
	h, nats, tc := linkRunner(t, nil)
	subject := "ses." + watchedSession + ".live"

	// Nobody watches: dropped, and the runner is told so, once.
	tc.send(liveFrame(watchedSession, 1, 2))
	if w := tc.watchersHint(5 * time.Second); w.GetSessionId() != watchedSession || w.GetWatchers() != 0 {
		t.Fatalf("hint %v", w)
	}
	tc.send(liveFrame(watchedSession, 3))
	tc.quiet(300 * time.Millisecond)
	if got := nats.publishedOn(subject); len(got) != 0 {
		t.Fatalf("published while nobody watched: %d", len(got))
	}
	if got := h.g.metrics.liveEvents.get("no_watchers"); got != 3 {
		t.Fatalf("no_watchers %v", got)
	}

	// A client watches: the runner is told, and the batch is published as it came, in protobuf's JSON.
	nats.deliverMsg("rnr."+runnerA, "", map[string]string{"Orbit-Instance": "i-1"}, watchersMessage(watchedSession, 1))
	if w := tc.watchersHint(5 * time.Second); w.GetWatchers() != 1 {
		t.Fatalf("hint %v", w)
	}
	sent := liveFrame(watchedSession, 4, 5)
	tc.send(sent)
	eventually(t, 5*time.Second, "the batch published", func() bool { return len(nats.publishedOn(subject)) == 1 })
	var f linkpb.Frame
	if err := protojson.Unmarshal(nats.publishedOn(subject)[0], &f); err != nil {
		t.Fatal(err)
	}
	if !proto.Equal(f.GetLiveBatch(), sent.GetLiveBatch()) {
		t.Fatalf("published %v, sent %v", f.GetLiveBatch(), sent.GetLiveBatch())
	}
	if got := h.g.metrics.liveEvents.get("published"); got != 2 {
		t.Fatalf("published %v", got)
	}
	// Named by its public id, as a runner may hold it, the session is the same one: the same subject, watched.
	tc.send(liveFrame("2x5PpI0zRtLFFWeu0anPV", 6))
	eventually(t, 5*time.Second, "the batch named by the public id published", func() bool { return len(nats.publishedOn(subject)) == 2 })
	_ = protojson.Unmarshal(nats.publishedOn(subject)[1], &f)
	if f.GetLiveBatch().GetSessionId() != watchedSession {
		t.Fatalf("published under %q", f.GetLiveBatch().GetSessionId())
	}

	// The client leaves: told again, and the next batch is dropped.
	nats.deliverMsg("rnr."+runnerA, "", map[string]string{"Orbit-Instance": "i-1"}, watchersMessage(watchedSession, 0))
	if w := tc.watchersHint(5 * time.Second); w.GetWatchers() != 0 {
		t.Fatalf("hint %v", w)
	}
	tc.send(liveFrame(watchedSession, 7))
	tc.quiet(300 * time.Millisecond)
	if n := len(nats.publishedOn(subject)); n != 2 {
		t.Fatalf("%d published", n)
	}
	// Only a session named by its UUID becomes a subject.
	tc.send(liveFrame("not.a.session", 8))
	eventually(t, 5*time.Second, "the bad session counted", func() bool { return h.g.metrics.liveEvents.get("bad_session") == 1 })
	if got := nats.publishedUnder("ses."); len(got) != 1 {
		t.Fatalf("subjects published on: %v", got)
	}
}

func TestAWatcherCountNotRepeatedLapses(t *testing.T) {
	h, nats, tc := linkRunner(t, func(c *config) { c.link.WatchersTTL = 400 * time.Millisecond })
	nats.deliverMsg("rnr."+runnerA, "", map[string]string{"Orbit-Instance": "i-1"}, watchersMessage(watchedSession, 1))
	if w := tc.watchersHint(5 * time.Second); w.GetWatchers() != 1 {
		t.Fatalf("hint %v", w)
	}
	go h.g.sweepWatchers(h.t.Context().Done())
	if w := tc.watchersHint(5 * time.Second); w.GetWatchers() != 0 {
		t.Fatalf("after the count lapsed: %v", w)
	}
	if h.g.watchers.sum(runnerA, watchedSession) != 0 {
		t.Fatal("the lapsed count still counts")
	}
}

func TestTheHeartbeatAnswerStatesTheWatchersSummed(t *testing.T) {
	_, nats, tc := linkRunner(t, nil)
	// Another instance has one watcher; the heartbeat route's answer says its own instance (i-1) has two.
	nats.deliverMsg("rnr."+runnerA, "", map[string]string{"Orbit-Instance": "i-2"}, watchersMessage(watchedSession, 1))
	tc.watchersHint(5 * time.Second)
	tc.send(heartbeatFrame(&linkpb.Heartbeat{ProcessId: processA}))
	ack := tc.await("heartbeat_ack", 5*time.Second, nil).GetHeartbeatAck()
	if w := ack.GetHints().GetWatchers(); len(w) != 1 || w[0].GetSessionId() != watchedSession || w[0].GetWatchers() != 3 {
		t.Fatalf("hints %v", ack.GetHints())
	}
}

func TestATurnPrefixRequestIsRelayedToTheRunnerAndItsAnswerBack(t *testing.T) {
	h, nats, tc := linkRunner(t, nil)
	reply := "_INBOX.test.prefix-1"
	nats.deliverMsg("rnr."+runnerA, reply, nil, []byte(`{"turnPrefixRequest":{"requestId":"p-1","sessionId":"`+watchedSession+`"}}`))
	req := tc.await("turn_prefix_request", 5*time.Second, nil).GetTurnPrefixRequest()
	if req.GetRequestId() != "p-1" || req.GetSessionId() != watchedSession {
		t.Fatalf("request %v", req)
	}
	answer := &linkpb.TurnPrefixResponse{RequestId: "p-1", SessionId: watchedSession, TurnId: "0190a0b0-0000-7000-8000-0000000000f1",
		Text: "Hello wor", Thinking: "the user greets", ThroughLiveSeq: 7}
	tc.send(&linkpb.Frame{Body: &linkpb.Frame_TurnPrefixResponse{TurnPrefixResponse: answer}})
	eventually(t, 5*time.Second, "the answer published on the reply subject", func() bool { return len(nats.publishedOn(reply)) == 1 })
	var f linkpb.Frame
	if err := protojson.Unmarshal(nats.publishedOn(reply)[0], &f); err != nil {
		t.Fatal(err)
	}
	if !proto.Equal(f.GetTurnPrefixResponse(), answer) {
		t.Fatalf("published %v", f.GetTurnPrefixResponse())
	}
	if h.g.metrics.prefixRequests.get("answered") != 1 {
		t.Fatal("not counted")
	}
	// An answer nobody asked for is counted and goes nowhere.
	tc.send(&linkpb.Frame{Body: &linkpb.Frame_TurnPrefixResponse{TurnPrefixResponse: &linkpb.TurnPrefixResponse{RequestId: "p-9"}}})
	eventually(t, 5*time.Second, "the stray answer counted", func() bool { return h.g.metrics.prefixRequests.get("unknown_answer") == 1 })
}

func TestATurnPrefixIsAskedOfTheProcessThatSupervisesTheSession(t *testing.T) {
	nats := listenNATS(t, "127.0.0.1:0")
	backend := newFakeBackend(t, heartbeatAnswer)
	h := newLinkHarness(t, []*fakeBackend{backend}, nil)
	relayTo(t, h, nats.url())
	supervisor, _ := h.connectLink(runnerA, processA)
	newest, _ := h.connectLink(runnerA, processC)
	supervisor.send(heartbeatFrame(&linkpb.Heartbeat{ProcessId: processA, SessionIds: []string{watchedSession}}))
	supervisor.await("heartbeat_ack", 5*time.Second, nil)
	eventually(t, 5*time.Second, "A's subject subscribed", func() bool { return nats.subscribers("rnr."+runnerA) == 1 })
	nats.deliverMsg("rnr."+runnerA, "_INBOX.test.2", nil, []byte(`{"turnPrefixRequest":{"requestId":"p-2","sessionId":"`+watchedSession+`"}}`))
	if req := supervisor.await("turn_prefix_request", 5*time.Second, nil).GetTurnPrefixRequest(); req.GetRequestId() != "p-2" {
		t.Fatalf("request %v", req)
	}
	newest.never("turn_prefix_request", 300*time.Millisecond)
}

func TestATurnPrefixRequestWithNoConnectionToAskIsAnsweredEmptyAtOnce(t *testing.T) {
	nats := listenNATS(t, "127.0.0.1:0")
	h := newHarness(t, nil) // MODE_HTTP: the runner works over HTTPS and is asked nothing
	relayTo(t, h, nats.url())
	tc, _ := h.connect(runnerA, processA)
	eventually(t, 5*time.Second, "A's subject subscribed", func() bool { return nats.subscribers("rnr."+runnerA) == 1 })
	reply := "_INBOX.test.3"
	nats.deliverMsg("rnr."+runnerA, reply, nil, []byte(`{"turnPrefixRequest":{"requestId":"p-3","sessionId":"`+watchedSession+`"}}`))
	eventually(t, 5*time.Second, "an empty answer", func() bool { return len(nats.publishedOn(reply)) == 1 })
	var f linkpb.Frame
	if err := protojson.Unmarshal(nats.publishedOn(reply)[0], &f); err != nil {
		t.Fatal(err)
	}
	if r := f.GetTurnPrefixResponse(); r.GetRequestId() != "p-3" || r.GetSessionId() != watchedSession || r.GetText() != "" || r.GetTurnId() != "" {
		t.Fatalf("answer %v", r)
	}
	tc.quiet(300 * time.Millisecond)
	if h.g.metrics.prefixRequests.get("mode_http") != 1 {
		t.Fatal("not counted")
	}
}

func TestAnUnansweredTurnPrefixRequestIsAnsweredEmptyWhenItTimesOut(t *testing.T) {
	h, nats, tc := linkRunner(t, func(c *config) { c.link.PrefixTimeout = 300 * time.Millisecond })
	reply := "_INBOX.test.4"
	nats.deliverMsg("rnr."+runnerA, reply, nil, []byte(`{"turnPrefixRequest":{"requestId":"p-4","sessionId":"`+watchedSession+`"}}`))
	tc.await("turn_prefix_request", 5*time.Second, nil)
	eventually(t, 5*time.Second, "an empty answer after the timeout", func() bool { return len(nats.publishedOn(reply)) == 1 })
	if h.g.metrics.prefixRequests.get("timeout") != 1 {
		t.Fatal("not counted")
	}
	// The runner's late answer finds nobody waiting.
	tc.send(&linkpb.Frame{Body: &linkpb.Frame_TurnPrefixResponse{TurnPrefixResponse: &linkpb.TurnPrefixResponse{RequestId: "p-4"}}})
	eventually(t, 5*time.Second, "the late answer counted", func() bool { return h.g.metrics.prefixRequests.get("unknown_answer") == 1 })
	if n := len(nats.publishedOn(reply)); n != 1 {
		t.Fatalf("%d answers published", n)
	}
}

// The heartbeat route answers without NATS too; its counts alone say who watches.
func TestWithoutNATSTheHeartbeatAnswerAloneSaysWhoWatches(t *testing.T) {
	backend := newFakeBackend(t, heartbeatAnswer)
	h := newLinkHarness(t, []*fakeBackend{backend}, nil)
	tc, _ := h.connectLink(runnerA, processA)
	tc.send(heartbeatFrame(&linkpb.Heartbeat{ProcessId: processA}))
	if w := tc.watchersHint(5 * time.Second); w.GetSessionId() != watchedSession || w.GetWatchers() != 2 {
		t.Fatalf("hint %v", w)
	}
	tc.send(liveFrame(watchedSession, 1))
	eventually(t, 5*time.Second, "counted as NATS down", func() bool { return h.g.metrics.liveEvents.get("nats_down") == 1 })
}
