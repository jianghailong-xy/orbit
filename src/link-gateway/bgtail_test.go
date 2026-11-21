package main

import (
	"testing"
	"time"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	"orbit/link-gateway/linkpb"
)

// connectTailing opens a connection whose Hello says linkHello and declares bg-output-tail/v1.
func (h *harness) connectTailing(runner, process string) *testConn {
	h.t.Helper()
	tc, _, err := h.dial(h.token(runner, process))
	if err != nil {
		h.t.Fatalf("dial: %v", err)
	}
	hello := linkHello(process)
	hello.GetHello().Capabilities = append(hello.GetHello().Capabilities, bgTailCapability)
	tc.send(hello)
	tc.expect("welcome", 5*time.Second)
	return tc
}

func tailRequestMessage(requestID string) []byte {
	return []byte(`{"backgroundJobTailRequest":{"requestId":"` + requestID + `","sessionId":"` + watchedSession +
		`","jobId":"bgj_0a0b0c0d0e0f","maxLines":40,"maxBytes":8192}}`)
}

// tailAnswer reads the one answer published on reply.
func tailAnswer(t *testing.T, nats *natsStandIn, reply string) *linkpb.BackgroundJobTailResponse {
	t.Helper()
	eventually(t, 5*time.Second, "the answer published on "+reply, func() bool { return len(nats.publishedOn(reply)) == 1 })
	var f linkpb.Frame
	if err := protojson.Unmarshal(nats.publishedOn(reply)[0], &f); err != nil {
		t.Fatal(err)
	}
	return f.GetBackgroundJobTailResponse()
}

// tailRig is a gateway with NATS and backends, and a runner whose process declares the read when tailing says so.
func tailRig(t *testing.T, tailing bool) (*harness, *natsStandIn, *testConn) {
	t.Helper()
	nats := listenNATS(t, "127.0.0.1:0")
	h := newLinkHarness(t, []*fakeBackend{newFakeBackend(t, heartbeatAnswer)}, nil)
	relayTo(t, h, nats.url())
	var tc *testConn
	if tailing {
		tc = h.connectTailing(runnerA, processA)
	} else {
		tc, _ = h.connectLink(runnerA, processA)
	}
	eventually(t, 5*time.Second, "A's subject subscribed", func() bool { return nats.subscribers("rnr."+runnerA) == 1 })
	return h, nats, tc
}

func TestABackgroundJobTailRequestIsRelayedToTheRunnerAndItsAnswerBack(t *testing.T) {
	h, nats, tc := tailRig(t, true)
	reply := "_INBOX.test.tail-1"
	nats.deliverMsg("rnr."+runnerA, reply, nil, tailRequestMessage("t-1"))
	req := tc.await("background_job_tail_request", 5*time.Second, nil).GetBackgroundJobTailRequest()
	if req.GetRequestId() != "t-1" || req.GetSessionId() != watchedSession || req.GetJobId() != "bgj_0a0b0c0d0e0f" ||
		req.GetMaxLines() != 40 || req.GetMaxBytes() != 8192 {
		t.Fatalf("request %v", req)
	}
	answer := &linkpb.BackgroundJobTailResponse{RequestId: "t-1", SessionId: watchedSession, JobId: "bgj_0a0b0c0d0e0f",
		Outcome: linkpb.BackgroundJobTailOutcome_BACKGROUND_JOB_TAIL_OUTCOME_OK, Status: "running", Text: "line 1\nline 2\n",
		Truncated: true, OutputBytes: 4096}
	tc.send(&linkpb.Frame{Body: &linkpb.Frame_BackgroundJobTailResponse{BackgroundJobTailResponse: answer}})
	if got := tailAnswer(t, nats, reply); !proto.Equal(got, answer) {
		t.Fatalf("published %v", got)
	}
	if h.g.metrics.bgTailRequests.get("answered") != 1 {
		t.Fatal("not counted")
	}
	// An answer nobody asked for is counted and goes nowhere.
	tc.send(&linkpb.Frame{Body: &linkpb.Frame_BackgroundJobTailResponse{BackgroundJobTailResponse: &linkpb.BackgroundJobTailResponse{RequestId: "t-9"}}})
	eventually(t, 5*time.Second, "the stray answer counted", func() bool { return h.g.metrics.bgTailRequests.get("unknown_answer") == 1 })
}

func TestABackgroundJobTailIsAskedOfTheProcessThatSupervisesTheSession(t *testing.T) {
	nats := listenNATS(t, "127.0.0.1:0")
	h := newLinkHarness(t, []*fakeBackend{newFakeBackend(t, heartbeatAnswer)}, nil)
	relayTo(t, h, nats.url())
	supervisor := h.connectTailing(runnerA, processA)
	newest := h.connectTailing(runnerA, processC)
	supervisor.send(heartbeatFrame(&linkpb.Heartbeat{ProcessId: processA, SessionIds: []string{watchedSession}}))
	supervisor.await("heartbeat_ack", 5*time.Second, nil)
	eventually(t, 5*time.Second, "A's subject subscribed", func() bool { return nats.subscribers("rnr."+runnerA) == 1 })
	nats.deliverMsg("rnr."+runnerA, "_INBOX.test.tail-2", nil, tailRequestMessage("t-2"))
	if req := supervisor.await("background_job_tail_request", 5*time.Second, nil).GetBackgroundJobTailRequest(); req.GetRequestId() != "t-2" {
		t.Fatalf("request %v", req)
	}
	newest.never("background_job_tail_request", 300*time.Millisecond)
}

// A runner connected without bg-output-tail/v1 is never sent the request: the gateway answers UNSUPPORTED at once.
func TestABackgroundJobTailOfARunnerWithoutTheCapabilityIsAnsweredUnsupported(t *testing.T) {
	h, nats, tc := tailRig(t, false)
	reply := "_INBOX.test.tail-3"
	nats.deliverMsg("rnr."+runnerA, reply, nil, tailRequestMessage("t-3"))
	if got := tailAnswer(t, nats, reply); got.GetOutcome() != linkpb.BackgroundJobTailOutcome_BACKGROUND_JOB_TAIL_OUTCOME_UNSUPPORTED ||
		got.GetRequestId() != "t-3" || got.GetJobId() != "bgj_0a0b0c0d0e0f" {
		t.Fatalf("answer %v", got)
	}
	tc.never("background_job_tail_request", 300*time.Millisecond)
	if h.g.metrics.bgTailRequests.get("unsupported") != 1 {
		t.Fatal("not counted")
	}
}

func TestABackgroundJobTailWithNoConnectionToAskIsAnsweredNoConnectionAtOnce(t *testing.T) {
	nats := listenNATS(t, "127.0.0.1:0")
	h := newHarness(t, nil) // no backends: the connection forwards nothing and is asked nothing
	relayTo(t, h, nats.url())
	h.connect(runnerA, processA)
	eventually(t, 5*time.Second, "A's subject subscribed", func() bool { return nats.subscribers("rnr."+runnerA) == 1 })
	reply := "_INBOX.test.tail-4"
	nats.deliverMsg("rnr."+runnerA, reply, nil, tailRequestMessage("t-4"))
	if got := tailAnswer(t, nats, reply); got.GetOutcome() != linkpb.BackgroundJobTailOutcome_BACKGROUND_JOB_TAIL_OUTCOME_NO_CONNECTION {
		t.Fatalf("answer %v", got)
	}
	if h.g.metrics.bgTailRequests.get("no_connection") != 1 {
		t.Fatal("not counted")
	}
}

func TestAnUnansweredBackgroundJobTailIsAnsweredTimeout(t *testing.T) {
	saved := bgTailTimeout
	bgTailTimeout = 300 * time.Millisecond
	t.Cleanup(func() { bgTailTimeout = saved })
	h, nats, tc := tailRig(t, true)
	reply := "_INBOX.test.tail-5"
	nats.deliverMsg("rnr."+runnerA, reply, nil, tailRequestMessage("t-5"))
	tc.await("background_job_tail_request", 5*time.Second, nil)
	if got := tailAnswer(t, nats, reply); got.GetOutcome() != linkpb.BackgroundJobTailOutcome_BACKGROUND_JOB_TAIL_OUTCOME_TIMEOUT {
		t.Fatalf("answer %v", got)
	}
	if h.g.metrics.bgTailRequests.get("timeout") != 1 {
		t.Fatal("not counted")
	}
	// The runner's late answer finds nobody waiting.
	tc.send(&linkpb.Frame{Body: &linkpb.Frame_BackgroundJobTailResponse{BackgroundJobTailResponse: &linkpb.BackgroundJobTailResponse{RequestId: "t-5"}}})
	eventually(t, 5*time.Second, "the late answer counted", func() bool { return h.g.metrics.bgTailRequests.get("unknown_answer") == 1 })
	if n := len(nats.publishedOn(reply)); n != 1 {
		t.Fatalf("%d answers published", n)
	}
}
