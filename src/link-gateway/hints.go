package main

import (
	"errors"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/nats-io/nats.go"
	"google.golang.org/protobuf/encoding/protojson"

	"orbit/link-gateway/linkpb"
)

// Hints (docs/runner-link-design.md §5.5, §6.3). The apiserver publishes each one for a runner on NATS, on
// rnr.<runnerId>, as a link Frame with only `hint` set, in protobuf's canonical JSON
// (src/apiserver/src/realtime/runner-hints.ts). The gateway subscribes to rnr.<runnerId> while it holds a connection
// of that runner, from its first connection's Welcome to its last connection's end, and writes each hint to that
// runner's connections as a Hint frame.
//
// Only to connections in MODE_LINK. A connection in MODE_HTTP is a runner that works over HTTPS and is woken by its
// long polls, and the shadow period sends it nothing new (§11.2): there a hint is counted and dropped. Every
// connection is in MODE_HTTP until the gateway forwards (B4).
//
// A hint is sent at most once (§5.2). One that finds no NATS, no connection of its runner or a full queue is counted
// and dropped, never waited for: the runner's next heartbeat carries the same news.

const (
	hintSubjectPrefix = "rnr."
	// hintBuffer is how many hints may wait for the relay at once, across every runner. More than that is a burst
	// the relay is not keeping up with; NATS drops the rest and they are counted as slow.
	hintBuffer = 4096
)

// hintRelay is the NATS connection and the subscriptions held on it.
type hintRelay struct {
	g    *gateway
	nc   *nats.Conn
	msgs chan *nats.Msg
	done chan struct{}
	log  *slog.Logger

	mu sync.Mutex
	// held is, per runner, how many open connections hold its subscription; subs is the subscription itself.
	held map[string]int
	subs map[string]*nats.Subscription

	lastMalformedLog atomic.Int64
}

// startHintRelay connects to NATS at url and relays hints from then on. NATS need not be up: the client keeps
// dialing, and the subscriptions made meanwhile take effect once it connects.
func startHintRelay(g *gateway, url string) (*hintRelay, error) {
	h := &hintRelay{
		g:    g,
		msgs: make(chan *nats.Msg, hintBuffer),
		done: make(chan struct{}),
		log:  g.log.With("component", "hints"),
		held: map[string]int{},
		subs: map[string]*nats.Subscription{},
	}
	m := g.metrics
	nc, err := nats.Connect(url,
		nats.Name("orbit-link-gateway "+nodeName()),
		nats.RetryOnFailedConnect(true),
		nats.MaxReconnects(-1),
		nats.ReconnectWait(2*time.Second),
		nats.PingInterval(20*time.Second),
		nats.MaxPingsOutstanding(3),
		nats.ConnectHandler(func(c *nats.Conn) {
			m.natsConnected.set(1)
			h.log.Info("NATS connected", "server", c.ConnectedUrlRedacted())
		}),
		nats.ReconnectHandler(func(c *nats.Conn) {
			m.natsConnected.set(1)
			m.natsReconnects.inc()
			h.log.Info("NATS reconnected; subscriptions restored", "server", c.ConnectedUrlRedacted())
		}),
		nats.DisconnectErrHandler(func(_ *nats.Conn, err error) {
			m.natsConnected.set(0)
			h.log.Warn("NATS disconnected; hints wait for runners' heartbeats until it is back", "err", err)
		}),
		nats.ClosedHandler(func(*nats.Conn) { m.natsConnected.set(0) }),
		nats.ErrorHandler(func(_ *nats.Conn, _ *nats.Subscription, err error) {
			if errors.Is(err, nats.ErrSlowConsumer) {
				m.hintsSlow.inc()
				return
			}
			h.log.Warn("NATS error", "err", err)
		}),
	)
	if err != nil {
		return nil, err
	}
	h.nc = nc
	if nc.IsConnected() {
		m.natsConnected.set(1)
	}
	go h.run()
	return h, nil
}

// hold subscribes to the runner's hints for one more of its connections; the first one subscribes.
func (h *hintRelay) hold(runnerID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.held[runnerID]++
	if h.held[runnerID] > 1 {
		return
	}
	sub, err := h.nc.ChanSubscribe(hintSubjectPrefix+runnerID, h.msgs)
	if err != nil {
		h.log.Warn("subscribing to a runner's hints failed; it learns of work at its heartbeat", "runner", runnerID, "err", err)
		return
	}
	h.subs[runnerID] = sub
	h.g.metrics.hintSubscriptions.add(1)
}

// release lets go of one connection's hold; the last one unsubscribes.
func (h *hintRelay) release(runnerID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.held[runnerID]--; h.held[runnerID] > 0 {
		return
	}
	delete(h.held, runnerID)
	if sub := h.subs[runnerID]; sub != nil {
		_ = sub.Unsubscribe()
		delete(h.subs, runnerID)
		h.g.metrics.hintSubscriptions.add(-1)
	}
}

// subscribed is the runners whose hints are subscribed to, for the tests.
func (h *hintRelay) subscribed() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]string, 0, len(h.subs))
	for runnerID := range h.subs {
		out = append(out, runnerID)
	}
	return out
}

func (h *hintRelay) run() {
	for {
		select {
		case msg := <-h.msgs:
			h.deliver(strings.TrimPrefix(msg.Subject, hintSubjectPrefix), msg.Data)
		case <-h.done:
			return
		}
	}
}

// deliver writes one hint to the runner's connections in MODE_LINK, and counts what became of it.
func (h *hintRelay) deliver(runnerID string, data []byte) {
	var f linkpb.Frame
	// A field or body of a newer apiserver is ignored, as the protocol asks of every receiver.
	if err := (protojson.UnmarshalOptions{DiscardUnknown: true}).Unmarshal(data, &f); err != nil || f.GetHint().GetKind() == nil {
		h.g.metrics.hints.inc("unknown", "malformed")
		h.malformed(runnerID, data, err)
		return
	}
	hint := f.GetHint()
	kind := hintKind(hint)
	result := "no_connection"
	for _, c := range h.g.reg.connsOf(runnerID) {
		if c.mode != linkpb.Mode_MODE_LINK {
			if result == "no_connection" {
				result = "mode_http"
			}
			continue
		}
		if c.offer(&linkpb.Frame{Body: &linkpb.Frame_Hint{Hint: hint}}) {
			result = "sent"
		} else if result != "sent" {
			result = "dropped"
		}
	}
	h.g.metrics.hints.inc(kind, result)
	if h.g.cfg.FrameLog == "all" && result != "sent" {
		// A hint that is written is logged with the frame; one that is not is logged here.
		h.log.Info("hint", "runner", runnerID, "kind", kind, "result", result)
	}
}

// malformed logs a message that is not a hint, at most once a minute: the count is in link_hints_total.
func (h *hintRelay) malformed(runnerID string, data []byte, err error) {
	now := time.Now().Unix()
	last := h.lastMalformedLog.Load()
	if now-last < 60 || !h.lastMalformedLog.CompareAndSwap(last, now) {
		return
	}
	shown := data
	if len(shown) > 256 {
		shown = shown[:256]
	}
	h.log.Warn("a message on a runner's hint subject is not a hint", "runner", runnerID, "bytes", len(data), "message", string(shown), "err", err)
}

// close ends the NATS connection, once every runner connection has closed.
func (h *hintRelay) close() {
	h.nc.Close()
	close(h.done)
}

func hintKind(hint *linkpb.Hint) string {
	switch hint.GetKind().(type) {
	case *linkpb.Hint_Inbox:
		return "inbox"
	case *linkpb.Hint_Claim:
		return "claim"
	case *linkpb.Hint_Commands:
		return "commands"
	case *linkpb.Hint_Approval:
		return "approval"
	case *linkpb.Hint_Watchers:
		return "watchers"
	}
	return "unknown"
}
