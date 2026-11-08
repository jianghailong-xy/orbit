package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"time"

	"orbit/linkpb"
)

// The heartbeat over the link (docs/runner-link-design.md §5.7). POST /runner/heartbeat is sent as a Heartbeat frame: the
// process, whether it is draining, its idle capacity and its sessions as typed fields, and every other member of the
// body (HeartbeatRequest) as one Fact, the member's JSON with its SHA-256. The mapping is the one the gateway forwards
// by (src/link-gateway/README.md), so the heartbeat route reads the body it always read.
//
// A part travels whole only when the gateway does not hold it: the first beat on a connection, a part that changed
// since it was last sent whole, and a part the gateway asks for (HeartbeatAck.want_facts), which is sent at once.
// Otherwise its digest alone stands for it, and the gateway fills it in from what that connection sent before.
//
// The HeartbeatAck's reconcile_json is the heartbeat route's answer, a HeartbeatResponse, which the runner applies: every
// command keeps its contract. An ack with no reconcile_json reconciled nothing, and the beat failed.
//
// A slow answer is not a dead connection (docs/runner-link-design.md §15.13). A connection carries one beat at a time,
// each named by its beat_id, and keeps it however long the control plane takes to answer: the next beat waits for that
// answer rather than pile onto it, and a beat over the link waits for its own answer longer than the gateway may take
// to give one (linkHeartbeatTimeout). Whether the connection still works is for its pings to say (link_work.go).

var errLinkBeatUnreconciled = errors.New("the heartbeat reached the runner link but no reconcile came back")

// linkHeartbeatTimeout bounds one heartbeat over the link, the wait for a connection included. It is longer than the
// gateway takes at the most to answer a beat it forwards (LINK_RPC_TIMEOUT, 60s by default, past which it answers that
// the control plane did not), so a beat on a live connection gets its answer however slow the control plane is: the
// reconcile is applied, and beats never overlap, so they come no faster than the control plane answers them. A dead
// connection ends the wait sooner, and the beat goes again on the next. Over HTTPS a heartbeat keeps 15s.
const linkHeartbeatTimeout = 75 * time.Second

// linkBeat is a beat sent on a connection whose HeartbeatAck has not come.
type linkBeat struct {
	id   uint64
	sent time.Time
}

// linkHeartbeatTyped are the members of the heartbeat body that are not Facts: four typed fields of Heartbeat, and status
// and version, which the link does not carry (the version travels in Hello).
var linkHeartbeatTyped = map[string]bool{
	"leaseOwner": true, "idleCapacity": true, "draining": true, "supervisedSessionIds": true, "status": true, "version": true,
}

// linkHeartbeatOf is the Heartbeat frame of a POST /runner/heartbeat body (src/link-gateway/README.md, "What the runner
// sends"): process_id is leaseOwner, idle_capacity idleCapacity, draining draining and session_ids supervisedSessionIds;
// every other member but status and version is one Fact, its kind the member's name, its json the member's bytes as
// they were encoded and its sha256 their digest. supported_providers is what X-Orbit-Supported-Providers says.
func linkHeartbeatOf(body []byte, providers string) (*linkpb.Heartbeat, error) {
	var members map[string]json.RawMessage
	if err := json.Unmarshal(body, &members); err != nil || members == nil {
		return nil, errors.New("the heartbeat body is not a JSON object")
	}
	hb := &linkpb.Heartbeat{SupportedProviders: linkList(providers)}
	_ = json.Unmarshal(members["leaseOwner"], &hb.ProcessId)
	_ = json.Unmarshal(members["draining"], &hb.Draining)
	_ = json.Unmarshal(members["supervisedSessionIds"], &hb.SessionIds)
	var idle json.Number
	if json.Unmarshal(members["idleCapacity"], &idle) == nil {
		if n, err := strconv.ParseUint(idle.String(), 10, 32); err == nil {
			hb.IdleCapacity = uint32(n)
		}
	}
	names := make([]string, 0, len(members))
	for name := range members {
		if !linkHeartbeatTyped[name] {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	for _, name := range names {
		sum := sha256.Sum256(members[name])
		hb.Facts = append(hb.Facts, &linkpb.Fact{Kind: name, Sha256: hex.EncodeToString(sum[:]), Json: members[name]})
	}
	return hb, nil
}

// heartbeat sends one heartbeat over the link and reads the route's answer into out.
func (m *linkMode) heartbeat(ctx context.Context, body, out interface{}) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	hb, err := linkHeartbeatOf(raw, supportedProvidersHeader())
	if err != nil {
		return err
	}
	for asked := 0; ; {
		conn, err := m.work.waitConn(ctx)
		if err != nil {
			return err
		}
		ack, err := conn.beat(ctx, hb)
		if errors.Is(err, errLinkConnEnded) {
			continue // sent again, whole, on the next connection
		}
		if err != nil {
			return err
		}
		if want := ack.GetWantFacts(); len(want) > 0 {
			if asked++; asked > 2 {
				return fmt.Errorf("the gateway asked again for heartbeat parts %v it was sent whole", want)
			}
			continue // beat forgot them on conn: the next beat carries them whole
		}
		if ack.GetMode() == linkpb.Mode_MODE_HTTP {
			return errLinkGatewayModeHTTP
		}
		if len(ack.GetReconcileJson()) == 0 {
			return errLinkBeatUnreconciled
		}
		m.work.reconciled(conn)
		if out == nil {
			return nil
		}
		return json.Unmarshal(ack.GetReconcileJson(), out)
	}
}

// beat sends hb on the connection and waits for its HeartbeatAck. The gateway forwards a connection's beats one at a
// time and answers each, so a connection carries one beat at a time, and the ack that comes while it is unanswered is
// its answer: a gateway that names the beat it answers (HeartbeatAck.beat_id) says so outright, and an older one, which
// names none, is taken at its order.
//
// A beat whose call gives up before its answer comes stays unanswered on the connection, which carries on: the next
// beat first waits for that answer, which is not applied, as an HTTPS answer that came after its timeout was not, and
// then goes itself. Only a beat unanswered for beatStuckAfter ends the connection: the gateway answers every beat it
// forwards within its own bound on the call, so it is not forwarding this connection's beats.
func (c *linkWorkConn) beat(ctx context.Context, hb *linkpb.Heartbeat) (*linkpb.HeartbeatAck, error) {
	c.beatMu.Lock()
	defer c.beatMu.Unlock()
	if c.pending != nil {
		if err := c.waitPending(ctx); err != nil {
			return nil, err
		}
	}
	frame := &linkpb.Heartbeat{
		ProcessId: hb.GetProcessId(), Draining: hb.GetDraining(), IdleCapacity: hb.GetIdleCapacity(),
		SessionIds: hb.GetSessionIds(), SupportedProviders: hb.GetSupportedProviders(), BeatId: c.work.beatSeq.Add(1),
	}
	for _, f := range hb.GetFacts() {
		if c.facts[f.GetKind()] == f.GetSha256() {
			frame.Facts = append(frame.Facts, &linkpb.Fact{Kind: f.GetKind(), Sha256: f.GetSha256()})
			continue
		}
		frame.Facts = append(frame.Facts, f)
		c.facts[f.GetKind()] = f.GetSha256()
	}
	select {
	case <-c.acks: // an ack no beat on this connection waits for
	default:
	}
	c.pending = &linkBeat{id: frame.GetBeatId(), sent: time.Now()}
	if _, err := c.send(&linkpb.Frame{Body: &linkpb.Frame_Heartbeat{Heartbeat: frame}}); err != nil {
		_ = c.ws.CloseNow()
		if !linkWaitEnded(ctx, c) {
			return nil, ctx.Err()
		}
		return nil, errLinkConnEnded
	}
	for {
		select {
		case ack := <-c.acks:
			if !c.answersPending(ack) {
				continue
			}
			took := time.Since(c.pending.sent)
			c.settle(ack)
			c.work.slowBeat(c, frame.GetBeatId(), took)
			return ack, nil
		case <-c.done:
			return nil, errLinkConnEnded
		case <-ctx.Done():
			return nil, fmt.Errorf("heartbeat %d got no answer on connection %s before its call gave up; the connection carries on, and the next beat waits for this one's answer: %w",
				frame.GetBeatId(), c.id, ctx.Err())
		}
	}
}

// waitPending waits for the answer to the beat still unanswered on the connection, whose call has given up on it: that
// answer is not applied. The connection is ended once that beat has been unanswered for beatStuckAfter.
func (c *linkWorkConn) waitPending(ctx context.Context) error {
	p := c.pending
	stuck := time.NewTimer(time.Until(p.sent.Add(c.work.beatStuckAfter)))
	defer stuck.Stop()
	for {
		select {
		case ack := <-c.acks:
			if !c.answersPending(ack) {
				continue
			}
			c.settle(ack)
			c.work.log(fmt.Sprintf("runner link: connection %s answered heartbeat %d %s after it was sent, once its call had given up; that answer is not applied, and the next beat goes now",
				c.id, p.id, time.Since(p.sent).Round(time.Millisecond)))
			return nil
		case <-c.done:
			return errLinkConnEnded
		case <-stuck.C:
			why := fmt.Sprintf("heartbeat %d sent on it went unanswered for %s while it answered pings: its gateway is not forwarding its beats", p.id, c.work.beatStuckAfter)
			c.retired.Store(&why)
			_ = c.ws.CloseNow()
			if !linkWaitEnded(ctx, c) {
				return ctx.Err()
			}
			return errLinkConnEnded
		case <-ctx.Done():
			return fmt.Errorf("heartbeat %d, sent on connection %s %s ago, is still unanswered, so the next was not sent: %w",
				p.id, c.id, time.Since(p.sent).Round(time.Millisecond), ctx.Err())
		}
	}
}

// answersPending reports whether ack answers the beat unanswered on the connection: it names that beat, or names none.
// One naming another answers a beat nobody waits for, and is dropped.
func (c *linkWorkConn) answersPending(ack *linkpb.HeartbeatAck) bool {
	id := ack.GetBeatId()
	return c.pending != nil && (id == 0 || id == c.pending.id)
}

// settle takes the answer to the unanswered beat: the connection may carry the next, and the parts the gateway asked
// for go whole in it.
func (c *linkWorkConn) settle(ack *linkpb.HeartbeatAck) {
	c.pending = nil
	for _, kind := range ack.GetWantFacts() {
		delete(c.facts, kind)
	}
}
