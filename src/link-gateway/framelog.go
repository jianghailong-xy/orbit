package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"

	"orbit/link-gateway/linkpb"
)

// One line per frame for the gateway's log and for `link-gateway dump`: what the frame is and the facts an operator
// reads it for, never a payload's content (event payloads and facts are only sized and digested).

// bodyName is a frame body's name as metrics and logs spell it.
func bodyName(f *linkpb.Frame) string {
	switch f.GetBody().(type) {
	case *linkpb.Frame_Hello:
		return "hello"
	case *linkpb.Frame_Welcome:
		return "welcome"
	case *linkpb.Frame_TokenRefresh:
		return "token_refresh"
	case *linkpb.Frame_Redirect:
		return "redirect"
	case *linkpb.Frame_Drain:
		return "drain"
	case *linkpb.Frame_Close:
		return "close"
	case *linkpb.Frame_Hint:
		return "hint"
	case *linkpb.Frame_Rpc:
		return "rpc"
	case *linkpb.Frame_RpcResult:
		return "rpc_result"
	case *linkpb.Frame_Heartbeat:
		return "heartbeat"
	case *linkpb.Frame_HeartbeatAck:
		return "heartbeat_ack"
	case *linkpb.Frame_EventBatch:
		return "event_batch"
	case *linkpb.Frame_EventAck:
		return "event_ack"
	case *linkpb.Frame_Credit:
		return "credit"
	case *linkpb.Frame_LiveBatch:
		return "live_batch"
	case *linkpb.Frame_TurnPrefixRequest:
		return "turn_prefix_request"
	case *linkpb.Frame_TurnPrefixResponse:
		return "turn_prefix_response"
	case *linkpb.Frame_Chunk:
		return "chunk"
	default:
		return "unknown"
	}
}

// summarize is the frame's one-line summary.
func summarize(f *linkpb.Frame) string {
	var b strings.Builder
	fmt.Fprintf(&b, "#%d %s", f.GetId(), bodyName(f))
	kv := func(k string, v any) { fmt.Fprintf(&b, " %s=%v", k, v) }
	switch body := f.GetBody().(type) {
	case *linkpb.Frame_Hello:
		h := body.Hello
		kv("process", h.GetProcessId())
		kv("version", h.GetRunnerVersion())
		kv("os", h.GetOs())
		kv("protocol", fmt.Sprintf("%d-%d", h.GetMinProtocolVersion(), h.GetMaxProtocolVersion()))
		kv("capabilities", len(h.GetCapabilities()))
		kv("providers", strings.Join(h.GetSupportedProviders(), ","))
		kv("sessions", len(h.GetSessions()))
		if h.GetManagedInstance() != nil {
			kv("managed", h.GetManagedInstance().GetGeneration())
		}
	case *linkpb.Frame_Welcome:
		w := body.Welcome
		kv("connection", w.GetConnectionId())
		kv("protocol", w.GetProtocolVersion())
		kv("mode", w.GetMode())
		kv("heartbeat_ms", w.GetHeartbeatIntervalMs())
		kv("sessions", len(w.GetSessions()))
	case *linkpb.Frame_TokenRefresh:
		kv("expires_ms", body.TokenRefresh.GetExpiresAtUnixMs())
	case *linkpb.Frame_Redirect:
		kv("url", body.Redirect.GetUrl())
	case *linkpb.Frame_Drain:
		kv("reconnect_after_ms", body.Drain.GetReconnectAfterMs())
	case *linkpb.Frame_Close:
		kv("code", body.Close.GetCode())
		kv("retry_after_ms", body.Close.GetRetryAfterMs())
		kv("message", fmt.Sprintf("%q", body.Close.GetMessage()))
	case *linkpb.Frame_Hint:
		kv("kind", fmt.Sprintf("%T", body.Hint.GetKind()))
	case *linkpb.Frame_Rpc:
		r := body.Rpc
		kv("request", r.GetRequestId())
		if r.GetSessionId() != "" {
			kv("session", r.GetSessionId())
			kv("after_seq", r.GetAfterSeq())
		}
		if t := r.GetTunnel(); t != nil {
			kv("tunnel", t.GetMethod()+" "+t.GetPath())
			kv("body", sized(t.GetJsonBody()))
		}
	case *linkpb.Frame_RpcResult:
		r := body.RpcResult
		kv("request", r.GetRequestId())
		if t := r.GetTunnel(); t != nil {
			kv("status", t.GetStatus())
		}
		if fl := r.GetFailure(); fl != nil {
			kv("failure", fl.GetCode())
			kv("retryable", fl.GetRetryable())
		}
	case *linkpb.Frame_Heartbeat:
		h := body.Heartbeat
		kv("process", h.GetProcessId())
		kv("draining", h.GetDraining())
		kv("idle", h.GetIdleCapacity())
		kv("sessions", len(h.GetSessionIds()))
		facts := make([]string, 0, len(h.GetFacts()))
		for _, fact := range h.GetFacts() {
			s := fact.GetKind() + ":" + short(fact.GetSha256())
			if len(fact.GetJson()) > 0 {
				s += "+" + fmt.Sprint(len(fact.GetJson())) + "B"
			}
			facts = append(facts, s)
		}
		kv("facts", "["+strings.Join(facts, " ")+"]")
	case *linkpb.Frame_HeartbeatAck:
		a := body.HeartbeatAck
		kv("mode", a.GetMode())
		kv("reconcile", sized(a.GetReconcileJson()))
		kv("want_facts", len(a.GetWantFacts()))
	case *linkpb.Frame_EventBatch:
		e := body.EventBatch
		kv("session", e.GetSessionId())
		kv("events", len(e.GetEvents()))
		if n := len(e.GetEvents()); n > 0 {
			kv("seq", fmt.Sprintf("%d-%d", e.GetEvents()[0].GetSeq(), e.GetEvents()[n-1].GetSeq()))
		}
	case *linkpb.Frame_EventAck:
		kv("session", body.EventAck.GetSessionId())
		kv("durable_seq", body.EventAck.GetDurableSeq())
	case *linkpb.Frame_Credit:
		kv("events", body.Credit.GetMaxUnackedEvents())
		kv("bytes", body.Credit.GetMaxUnackedBytes())
	case *linkpb.Frame_LiveBatch:
		kv("session", body.LiveBatch.GetSessionId())
		kv("events", len(body.LiveBatch.GetEvents()))
	case *linkpb.Frame_TurnPrefixRequest:
		kv("request", body.TurnPrefixRequest.GetRequestId())
		kv("session", body.TurnPrefixRequest.GetSessionId())
	case *linkpb.Frame_TurnPrefixResponse:
		r := body.TurnPrefixResponse
		kv("request", r.GetRequestId())
		kv("turn", r.GetTurnId())
		kv("text", len(r.GetText()))
		kv("through_live_seq", r.GetThroughLiveSeq())
	case *linkpb.Frame_Chunk:
		c := body.Chunk
		kv("frame", c.GetFrameId())
		kv("index", c.GetIndex())
		kv("last", c.GetLast())
		kv("data", len(c.GetData()))
	}
	return b.String()
}

// sized describes bytes by their length and digest, never their content.
func sized(b []byte) string {
	if len(b) == 0 {
		return "0B"
	}
	sum := sha256.Sum256(b)
	return fmt.Sprintf("%dB:%s", len(b), hex.EncodeToString(sum[:4]))
}

func short(s string) string {
	if len(s) > 8 {
		return s[:8]
	}
	return s
}
