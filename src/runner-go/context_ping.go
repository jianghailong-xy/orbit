package main

import "time"

// The engines report context-window occupancy on `turn_end`, and the clients read
// `contextTokens` off any event to fill their gauge. That leaves the gauge at 0% for the whole of
// a session's first turn — which for tool-heavy work runs for tens of minutes — and reads as a
// broken gauge rather than a pending one. contextPinger emits the running figure mid-turn, so the
// gauge fills while the turn is still going; `turn_end` still carries the authoritative value.
//
// Rate-limited and change-gated because these are persisted, non-noise events: they carry a key
// outside the ping-key set in system-noise.ts, which is exactly what keeps them on the wire, so
// one per assistant message would displace real content in the clients' count-capped transcript
// pages. A gauge needs no finer resolution than this.
//
// Not safe for concurrent use: each engine pings from the single goroutine reading its stream.
type contextPinger struct {
	last int
	at   time.Time
}

const contextPingInterval = 20 * time.Second

func (p *contextPinger) ping(emit emitFn, tokens int) {
	if tokens <= 0 || tokens == p.last || time.Since(p.at) < contextPingInterval {
		return
	}
	p.last, p.at = tokens, time.Now()
	emit(evSystem, map[string]interface{}{"subtype": "context", "contextTokens": tokens})
}
