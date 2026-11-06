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

var errLinkBeatUnreconciled = errors.New("the heartbeat reached the runner link but no reconcile came back")

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
		if out == nil {
			return nil
		}
		return json.Unmarshal(ack.GetReconcileJson(), out)
	}
}

// beat sends hb on the connection and waits for its HeartbeatAck. Nothing in an ack says which beat it answers, so a
// connection carries one beat at a time: a beat whose ack never came leaves the connection unusable for the next, which
// ends it, and the next goes on a new connection.
func (c *linkWorkConn) beat(ctx context.Context, hb *linkpb.Heartbeat) (*linkpb.HeartbeatAck, error) {
	c.beatMu.Lock()
	defer c.beatMu.Unlock()
	if c.beating {
		why := "a heartbeat sent on it was never answered"
		c.retired.Store(&why)
		_ = c.ws.CloseNow()
		if !linkWaitEnded(ctx, c) {
			return nil, ctx.Err()
		}
		return nil, errLinkConnEnded
	}
	frame := &linkpb.Heartbeat{
		ProcessId: hb.GetProcessId(), Draining: hb.GetDraining(), IdleCapacity: hb.GetIdleCapacity(),
		SessionIds: hb.GetSessionIds(), SupportedProviders: hb.GetSupportedProviders(),
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
	case <-c.acks: // an ack nobody waited for
	default:
	}
	c.beating = true
	if _, err := c.send(&linkpb.Frame{Body: &linkpb.Frame_Heartbeat{Heartbeat: frame}}); err != nil {
		_ = c.ws.CloseNow()
		if !linkWaitEnded(ctx, c) {
			return nil, ctx.Err()
		}
		return nil, errLinkConnEnded
	}
	select {
	case ack := <-c.acks:
		c.beating = false
		for _, kind := range ack.GetWantFacts() {
			delete(c.facts, kind)
		}
		return ack, nil
	case <-c.done:
		return nil, errLinkConnEnded
	case <-ctx.Done():
		return nil, ctx.Err() // still beating: the next beat ends this connection
	}
}
