package linkpb_test

import (
	"bytes"
	"testing"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"

	"orbit/linkpb"
)

// samples is every message of contracts/runner-link/v1/runner_link.proto with every field set to
// something other than its default, so a round trip that drops or mangles a field shows up as a
// difference. A message with a oneof appears once per member: Frame once per body.
func samples(t *testing.T) []proto.Message {
	t.Helper()
	writeContract := &linkpb.WriteContract{CapabilityRevision: 2, SchemaRevision: 2, ContractDigest: "bbdd980c70dc56bf"}
	managedInstance := &linkpb.ManagedInstance{Generation: "7", PodUid: "pod-uid-1"}
	resume := &linkpb.SessionResume{SessionId: "ses-1", LastSeq: 41, TurnId: "turn-9"}
	hello := &linkpb.Hello{
		ProcessId:          "lease-owner-1",
		RunnerVersion:      "0.1.236",
		Os:                 "linux",
		MinProtocolVersion: 1,
		MaxProtocolVersion: 1,
		Capabilities:       []string{"source-pin/v1", "integration-job/v1"},
		SupportedProviders: []string{"claude", "codex"},
		WriteContract:      writeContract,
		ManagedInstance:    managedInstance,
		Sessions:           []*linkpb.SessionResume{resume, {SessionId: "ses-2", LastSeq: 3}},
	}
	limits := &linkpb.Limits{MaxFrameBytes: 256 << 10}
	credit := &linkpb.Credit{MaxUnackedEvents: 512, MaxUnackedBytes: 8 << 20}
	sessionState := &linkpb.SessionState{SessionId: "ses-1", DurableSeq: 40, LeaseHeld: true}
	approval := &linkpb.ApprovalHint{SessionId: "ses-1", ApprovalId: "apr-1"}
	watchers := &linkpb.WatchersHint{SessionId: "ses-1", Watchers: 2}
	hints := &linkpb.HintState{
		InboxSessionIds: []string{"ses-1", "ses-2"},
		Claim:           true,
		Approvals:       []*linkpb.ApprovalHint{approval},
		Watchers:        []*linkpb.WatchersHint{watchers, {SessionId: "ses-2", Watchers: 1}},
	}
	release := &linkpb.AssignedRelease{Version: "0.1.235", Rollback: true}
	welcome := &linkpb.Welcome{
		ProtocolVersion:     1,
		Mode:                linkpb.Mode_MODE_LINK,
		HeartbeatIntervalMs: 30000,
		Limits:              limits,
		Credit:              credit,
		Sessions:            []*linkpb.SessionState{sessionState},
		Hints:               hints,
		Release:             release,
		ConnectionId:        "conn-1",
	}
	tokenRefresh := &linkpb.TokenRefresh{Token: "eyJhbGciOiJFZERTQSJ9.e30.c2ln", ExpiresAtUnixMs: 1792900000000}
	redirect := &linkpb.Redirect{Url: "wss://link-cell-2.example/runner", Token: "eyJhbGciOiJFZERTQSJ9.e30.Y2VsbDI"}
	drain := &linkpb.Drain{ReconnectAfterMs: 4200}
	closeFrame := &linkpb.Close{Code: linkpb.CloseCode_CLOSE_CODE_SUPERSEDED, Message: "a newer connection took over", RetryAfterMs: 1000}
	inbox := &linkpb.InboxHint{SessionId: "ses-1"}
	tunnelRequest := &linkpb.TunnelRequest{Method: "POST", Path: "/runner/sessions/ses-1/merge-result", JsonBody: []byte(`{"ok":true}`)}
	rpc := &linkpb.Rpc{
		RequestId: "req-1",
		SessionId: "ses-1",
		AfterSeq:  40,
		Body:      &linkpb.Rpc_Tunnel{Tunnel: tunnelRequest},
	}
	tunnelResponse := &linkpb.TunnelResponse{Status: 409, JsonBody: []byte(`{"code":"STALE_CLAIM"}`), RetryAfterMs: 2000}
	failure := &linkpb.Failure{Code: "BACKEND_UNAVAILABLE", Message: "no backend answered", Retryable: true, RetryAfterMs: 1500}
	fact := &linkpb.Fact{Kind: "modelCatalog", Sha256: "9f86d081884c7d65", Json: []byte(`{"claude":[]}`)}
	heartbeat := &linkpb.Heartbeat{
		ProcessId:          "lease-owner-1",
		Draining:           true,
		IdleCapacity:       3,
		SessionIds:         []string{"ses-1", "ses-2"},
		SupportedProviders: []string{"claude", "codex", "cursor"},
		Facts:              []*linkpb.Fact{fact, {Kind: "repos", Sha256: "2c26b46b68ffc68f"}},
	}
	heartbeatAck := &linkpb.HeartbeatAck{
		Mode:          linkpb.Mode_MODE_HTTP,
		ReconcileJson: []byte(`{"cancelSessionIds":["ses-3"],"maxConcurrent":4}`),
		WantFacts:     []string{"repos"},
		Hints:         hints,
		Release:       release,
	}
	event := &linkpb.Event{Seq: 41, Type: "assistant", TsUnixMs: 1792900000123, TurnId: "turn-9", PayloadJson: []byte(`{"text":"done"}`)}
	eventBatch := &linkpb.EventBatch{
		SessionId: "ses-1",
		Events:    []*linkpb.Event{event, {Seq: 42, Type: "turn_end", TsUnixMs: 1792900000200, TurnId: "turn-9", PayloadJson: []byte(`{}`)}},
	}
	rejected := &linkpb.RejectedEvent{Seq: 39, Code: "PAYLOAD_INVALID", Message: "payload is not a JSON object"}
	eventAck := &linkpb.EventAck{
		SessionId:  "ses-1",
		DurableSeq: 42,
		Rejected:   []*linkpb.RejectedEvent{rejected},
		Failure:    &linkpb.Failure{Code: "DATABASE_FAILOVER", Message: "primary is failing over", Retryable: true, RetryAfterMs: 3000},
	}
	liveEvent := &linkpb.LiveEvent{LiveSeq: 7, Type: "text_delta", TsUnixMs: 1792900000050, TurnId: "turn-9", PayloadJson: []byte(`{"text":"do"}`)}
	liveBatch := &linkpb.LiveBatch{
		SessionId: "ses-1",
		Events:    []*linkpb.LiveEvent{liveEvent, {LiveSeq: 8, Type: "text_delta", TsUnixMs: 1792900000060, TurnId: "turn-9", PayloadJson: []byte(`{"text":"ne"}`)}},
	}
	turnPrefixRequest := &linkpb.TurnPrefixRequest{RequestId: "req-2", SessionId: "ses-1"}
	turnPrefixResponse := &linkpb.TurnPrefixResponse{
		RequestId:      "req-2",
		SessionId:      "ses-1",
		TurnId:         "turn-9",
		Text:           "Half of the repl",
		Thinking:       "The user wants",
		ThroughLiveSeq: 8,
	}
	chunk := &linkpb.Chunk{FrameId: 12, Index: 1, Last: true, Data: []byte{0x0a, 0x0b, 0x0c}}

	messages := []proto.Message{
		chunk, hello, writeContract, managedInstance, resume, welcome, limits, sessionState, release,
		tokenRefresh, redirect, drain, closeFrame,
		&linkpb.Hint{Kind: &linkpb.Hint_Inbox{Inbox: inbox}},
		&linkpb.Hint{Kind: &linkpb.Hint_Claim{Claim: &linkpb.ClaimHint{}}},
		&linkpb.Hint{Kind: &linkpb.Hint_Commands{Commands: &linkpb.CommandsHint{}}},
		&linkpb.Hint{Kind: &linkpb.Hint_Approval{Approval: approval}},
		&linkpb.Hint{Kind: &linkpb.Hint_Watchers{Watchers: watchers}},
		inbox, &linkpb.ClaimHint{}, &linkpb.CommandsHint{}, approval, watchers, hints,
		rpc, tunnelRequest,
		&linkpb.RpcResult{RequestId: "req-1", Outcome: &linkpb.RpcResult_Tunnel{Tunnel: tunnelResponse}},
		&linkpb.RpcResult{RequestId: "req-1", Outcome: &linkpb.RpcResult_Failure{Failure: failure}},
		tunnelResponse, failure, heartbeat, fact, heartbeatAck, eventBatch, event, eventAck, rejected,
		credit, liveBatch, liveEvent, turnPrefixRequest, turnPrefixResponse,
	}

	// One Frame per member of its body, each wrapping the first sample of that member's type.
	byType := map[protoreflect.FullName]proto.Message{}
	for _, m := range messages {
		name := m.ProtoReflect().Descriptor().FullName()
		if _, ok := byType[name]; !ok {
			byType[name] = m
		}
	}
	body := (&linkpb.Frame{}).ProtoReflect().Descriptor().Oneofs().ByName("body")
	for i := 0; i < body.Fields().Len(); i++ {
		member := body.Fields().Get(i)
		sample, ok := byType[member.Message().FullName()]
		if !ok {
			t.Fatalf("no sample of %s for Frame.%s", member.Message().FullName(), member.Name())
		}
		frame := &linkpb.Frame{Id: uint64(i + 1)}
		frame.ProtoReflect().Set(member, protoreflect.ValueOfMessage(proto.Clone(sample).ProtoReflect()))
		messages = append(messages, frame)
	}
	return messages
}

// sampleName is a message's name plus the oneof members it sets, such as "Frame.hello".
func sampleName(m proto.Message) string {
	r := m.ProtoReflect()
	name := string(r.Descriptor().Name())
	oneofs := r.Descriptor().Oneofs()
	for i := 0; i < oneofs.Len(); i++ {
		if member := r.WhichOneof(oneofs.Get(i)); member != nil {
			name += "." + string(member.Name())
		}
	}
	return name
}

// Every message decodes to exactly what was encoded, and encodes to the same bytes again.
func TestEveryMessageRoundTrips(t *testing.T) {
	deterministic := proto.MarshalOptions{Deterministic: true}
	for _, m := range samples(t) {
		t.Run(sampleName(m), func(t *testing.T) {
			wire, err := deterministic.Marshal(m)
			if err != nil {
				t.Fatalf("encode: %v", err)
			}
			decoded := m.ProtoReflect().New().Interface()
			if err := proto.Unmarshal(wire, decoded); err != nil {
				t.Fatalf("decode: %v", err)
			}
			if !proto.Equal(m, decoded) {
				t.Fatalf("decoded\n  %v\nwant\n  %v", decoded, m)
			}
			again, err := deterministic.Marshal(decoded)
			if err != nil {
				t.Fatalf("encode the decoded message: %v", err)
			}
			if !bytes.Equal(wire, again) {
				t.Fatalf("re-encoded to %x, first encoding was %x", again, wire)
			}
		})
	}
}

// Every message in the file has a sample, so a message added to the proto without one fails here.
func TestEveryMessageHasASample(t *testing.T) {
	sampled := map[protoreflect.FullName]bool{}
	for _, m := range samples(t) {
		sampled[m.ProtoReflect().Descriptor().FullName()] = true
	}
	var walk func(protoreflect.MessageDescriptors)
	walk = func(messages protoreflect.MessageDescriptors) {
		for i := 0; i < messages.Len(); i++ {
			md := messages.Get(i)
			if !sampled[md.FullName()] {
				t.Errorf("%s has no round-trip sample", md.FullName())
			}
			walk(md.Messages())
		}
	}
	walk(linkpb.File_v1_runner_link_proto.Messages())
}

// Every sample sets every field outside a oneof, and some sample sets each oneof member, so the
// round trip covers every field of the protocol.
func TestSamplesSetEveryField(t *testing.T) {
	setMembers := map[protoreflect.FullName]bool{}
	members := map[protoreflect.FullName]bool{}
	for _, m := range samples(t) {
		r := m.ProtoReflect()
		fields := r.Descriptor().Fields()
		for i := 0; i < fields.Len(); i++ {
			field := fields.Get(i)
			if field.ContainingOneof() != nil {
				members[field.FullName()] = true
				if r.Has(field) {
					setMembers[field.FullName()] = true
				}
				continue
			}
			if !r.Has(field) {
				t.Errorf("%s leaves %s at its default", sampleName(m), field.Name())
			}
		}
	}
	for member := range members {
		if !setMembers[member] {
			t.Errorf("no sample sets oneof member %s", member)
		}
	}
}
