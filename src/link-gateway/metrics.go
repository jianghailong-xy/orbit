package main

import (
	"bufio"
	"fmt"
	"io"
	"math"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Metrics in the Prometheus text exposition format (version 0.0.4), written by hand: a handful of counters, gauges
// and histograms do not justify the client library's dependency tree. README.md, "Metrics", lists them.

type collector interface {
	write(w *bufio.Writer)
}

// counter is a counter with labels; each label combination is one series.
type counter struct {
	name, help string
	labels     []string
	mu         sync.Mutex
	values     map[string]float64
}

func newCounter(name, help string, labels ...string) *counter {
	return &counter{name: name, help: help, labels: labels, values: map[string]float64{}}
}

func (c *counter) inc(labelValues ...string) { c.add(1, labelValues...) }

func (c *counter) add(v float64, labelValues ...string) {
	if len(labelValues) != len(c.labels) {
		panic(fmt.Sprintf("metric %s takes %d labels, got %d", c.name, len(c.labels), len(labelValues)))
	}
	key := strings.Join(labelValues, "\xff")
	c.mu.Lock()
	c.values[key] += v
	c.mu.Unlock()
}

// preset makes series exist at zero before anything happens, so "none so far" reads as 0 rather than as absent.
func (c *counter) preset(labelValues ...string) { c.add(0, labelValues...) }

func (c *counter) get(labelValues ...string) float64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.values[strings.Join(labelValues, "\xff")]
}

func (c *counter) write(w *bufio.Writer) {
	c.mu.Lock()
	keys := make([]string, 0, len(c.values))
	for k := range c.values {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	fmt.Fprintf(w, "# HELP %s %s\n# TYPE %s counter\n", c.name, c.help, c.name)
	for _, k := range keys {
		var values []string
		if len(c.labels) > 0 {
			values = strings.Split(k, "\xff")
		}
		fmt.Fprintf(w, "%s%s %s\n", c.name, labelString(c.labels, values), formatValue(c.values[k]))
	}
	c.mu.Unlock()
}

// gauge is a value that is set, or read from fn when the metrics are written.
type gauge struct {
	name, help string
	mu         sync.Mutex
	v          float64
	fn         func() float64
}

func newGauge(name, help string) *gauge { return &gauge{name: name, help: help} }

func newGaugeFunc(name, help string, fn func() float64) *gauge {
	return &gauge{name: name, help: help, fn: fn}
}

func (g *gauge) set(v float64) {
	g.mu.Lock()
	g.v = v
	g.mu.Unlock()
}

func (g *gauge) add(v float64) {
	g.mu.Lock()
	g.v += v
	g.mu.Unlock()
}

func (g *gauge) get() float64 {
	if g.fn != nil {
		return g.fn()
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.v
}

func (g *gauge) write(w *bufio.Writer) {
	fmt.Fprintf(w, "# HELP %s %s\n# TYPE %s gauge\n%s %s\n", g.name, g.help, g.name, g.name, formatValue(g.get()))
}

// infoGauge is a constant 1 whose labels carry the information, such as the build version.
type infoGauge struct {
	name, help string
	labels     []string
	values     []string
}

func (g *infoGauge) write(w *bufio.Writer) {
	fmt.Fprintf(w, "# HELP %s %s\n# TYPE %s gauge\n%s%s 1\n", g.name, g.help, g.name, g.name, labelString(g.labels, g.values))
}

// histogram counts observations into fixed upper bounds, in seconds.
type histogram struct {
	name, help string
	bounds     []float64
	mu         sync.Mutex
	counts     []uint64
	sum        float64
	count      uint64
}

func newHistogram(name, help string, bounds ...float64) *histogram {
	return &histogram{name: name, help: help, bounds: bounds, counts: make([]uint64, len(bounds))}
}

func (h *histogram) observe(d time.Duration) {
	v := d.Seconds()
	h.mu.Lock()
	for i, b := range h.bounds {
		if v <= b {
			h.counts[i]++
		}
	}
	h.sum += v
	h.count++
	h.mu.Unlock()
}

func (h *histogram) snapshot() (count uint64, sum float64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.count, h.sum
}

func (h *histogram) write(w *bufio.Writer) {
	h.mu.Lock()
	defer h.mu.Unlock()
	fmt.Fprintf(w, "# HELP %s %s\n# TYPE %s histogram\n", h.name, h.help, h.name)
	for i, b := range h.bounds {
		fmt.Fprintf(w, "%s_bucket{le=\"%s\"} %d\n", h.name, formatValue(b), h.counts[i])
	}
	fmt.Fprintf(w, "%s_bucket{le=\"+Inf\"} %d\n%s_sum %s\n%s_count %d\n", h.name, h.count, h.name, formatValue(h.sum), h.name, h.count)
}

func labelString(names, values []string) string {
	if len(names) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteByte('{')
	for i, n := range names {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(n)
		b.WriteString(`="`)
		b.WriteString(strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`).Replace(values[i]))
		b.WriteByte('"')
	}
	b.WriteByte('}')
	return b.String()
}

func formatValue(v float64) string {
	if math.IsInf(v, 1) {
		return "+Inf"
	}
	// Whole numbers, timestamps among them, in plain digits rather than exponent form.
	if v == math.Trunc(v) && math.Abs(v) < 1e15 {
		return strconv.FormatFloat(v, 'f', -1, 64)
	}
	return strconv.FormatFloat(v, 'g', -1, 64)
}

// gatewayMetrics is every metric the gateway exposes.
type gatewayMetrics struct {
	all []collector

	connections           *gauge
	handshakes            *counter
	handshakeDuration     *histogram
	tokenRefusals         *counter
	disconnects           *counter
	rtt                   *histogram
	framesReceived        *counter
	framesSent            *counter
	frameDecodeErrors     *counter
	heartbeats            *counter
	draining              *gauge
	drainsSent            *counter
	revocations           *gauge
	revocationFetches     *counter
	revocationLastSuccess *gauge
	tlsNotAfter           *gauge
	tlsReloads            *counter
	tlsHandshakeErrors    *counter
	rpcs                  *counter
	shadowPairs           *counter
	shadowMismatches      *counter
	shadowUnpaired        *counter
	shadowEvents          *counter
	shadowPendingBytes    *gauge
	hints                 *counter
	hintsSlow             *counter
	hintSubscriptions     *gauge
	natsConnected         *gauge
	natsReconnects        *counter

	// Forwarding, in MODE_LINK (backend.go, forward.go, heartbeat.go, events.go, live.go).
	backendCalls      *counter
	backendRetries    *counter
	backendDuration   *histogram
	rpcResults        *counter
	rpcDuration       *histogram
	heartbeatForwards *counter
	heartbeatDuration *histogram
	heartbeatFacts    *counter
	eventBatches      *counter
	eventsStored      *counter
	eventAckDuration  *histogram
	ingestEvents      *gauge
	ingestBytes       *gauge
	creditReduced     *gauge
	creditChanges     *counter
	liveEvents        *counter
	watchedSessions   *gauge
	prefixRequests    *counter
	queueFull         *counter
}

// Every label value a counter can take that a dashboard or a report reads, so their series exist from the start.
var (
	handshakeResults  = []string{"ok", "unauthenticated", "rate_limited", "too_many_connections", "draining", "not_websocket", "hello_timeout", "protocol_error", "upgrade_required", "upgrade_failed"}
	refusalReasons    = []tokenRefusal{refuseMissing, refuseMalformed, refuseSignature, refuseAudience, refuseExpired, refuseClaims, refuseCell, refuseRevoked}
	disconnectReasons = []string{"client_closed", "connection_lost", "superseded", "ping_timeout", "token_expired", "revoked", "protocol_error", "slow_consumer", "drained", "shutdown", "internal_error"}
)

func newGatewayMetrics(version string, deny *denyList, pendingBytes func() float64) *gatewayMetrics {
	m := &gatewayMetrics{
		connections:       newGauge("link_connections", "Open runner connections: those that were sent Welcome and are not closed yet."),
		handshakes:        newCounter("link_handshakes_total", "Upgrade requests by outcome; ok is a connection that was sent Welcome.", "result"),
		handshakeDuration: newHistogram("link_handshake_duration_seconds", "From the upgrade request to Welcome written, for handshakes that succeeded.", 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10),
		tokenRefusals:     newCounter("link_token_refusals_total", "Connection tokens refused before the upgrade, by reason.", "reason"),
		disconnects:       newCounter("link_disconnects_total", "Closed connections that had been sent Welcome, by reason.", "reason"),
		rtt:               newHistogram("link_rtt_seconds", "WebSocket ping round trips.", 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60),
		framesReceived:    newCounter("link_frames_received_total", "Frames received from runners, by body.", "type"),
		framesSent:        newCounter("link_frames_sent_total", "Frames sent to runners, by body.", "type"),
		frameDecodeErrors: newCounter("link_frame_decode_errors_total", "WebSocket messages from runners that did not decode as a Frame."),
		heartbeats:        newCounter("link_heartbeats_total", "Heartbeat frames received."),
		draining:          newGauge("link_draining", "1 while the gateway drains its connections before it exits."),
		drainsSent:        newCounter("link_drains_sent_total", "Drain frames sent."),
		revocations: newGaugeFunc("link_revocations", "Revoked runner credentials in the deny list.",
			func() float64 { return float64(deny.size()) }),
		revocationFetches:     newCounter("link_revocation_fetches_total", "Reads of the apiserver's revocation list, by outcome.", "result"),
		revocationLastSuccess: newGauge("link_revocation_last_success_timestamp_seconds", "When the revocation list was last read, in Unix seconds."),
		tlsNotAfter:           newGauge("link_tls_certificate_not_after_timestamp_seconds", "When the certificate in use expires, in Unix seconds (files TLS mode)."),
		tlsReloads:            newCounter("link_tls_reloads_total", "Certificate reloads after its files changed, by outcome.", "result"),
		tlsHandshakeErrors:    newCounter("link_tls_handshake_errors_total", "TLS handshakes that failed."),
		rpcs:                  newCounter("link_rpcs_total", "Rpc frames by what became of them.", "result"),
		shadowPairs:           newCounter("link_shadow_pairs_total", "Mirrored HTTP requests compared with their typed frame, by kind and result.", "kind", "result"),
		shadowMismatches:      newCounter("link_shadow_mismatches_total", "Fields that differed in compared pairs.", "kind", "field"),
		shadowUnpaired:        newCounter("link_shadow_unpaired_total", "Halves of a mirror that never met their other half, by side and reason.", "side", "reason"),
		shadowEvents:          newCounter("link_shadow_events_compared_total", "Events compared in mirrored event batches."),
		shadowPendingBytes:    newGaugeFunc("link_shadow_pending_bytes", "Bytes of mirror halves waiting for their other half.", pendingBytes),
		hints:                 newCounter("link_hints_total", "Hints received from NATS, by kind and by what became of them.", "kind", "result"),
		hintsSlow:             newCounter("link_hints_slow_total", "Hints NATS dropped because the relay was not keeping up."),
		hintSubscriptions:     newGauge("link_hint_subscriptions", "Runners whose hint subject this gateway subscribes to."),
		natsConnected:         newGauge("link_nats_connected", "1 while the gateway is connected to NATS."),
		natsReconnects:        newCounter("link_nats_reconnects_total", "Times the NATS connection was established again after it was lost."),

		backendCalls:      newCounter("link_backend_calls_total", "Calls forwarded to the apiserver's internal listener, by what they were for and how they ended.", "kind", "result"),
		backendRetries:    newCounter("link_backend_retries_total", "Calls sent again on the next backend, by what they were for and why: not_delivered (no handler ran) or lost (an idempotent call whose answer was lost).", "kind", "reason"),
		backendDuration:   newHistogram("link_backend_call_duration_seconds", "From a forwarded call's start to its backend's answer, retries included.", linkDurationBounds...),
		rpcResults:        newCounter("link_rpc_results_total", "RpcResults of forwarded requests: the route's status class, or the Failure code when it gave no answer.", "result"),
		rpcDuration:       newHistogram("link_rpc_duration_seconds", "From a forwarded request's start to its route's answer.", linkDurationBounds...),
		heartbeatForwards: newCounter("link_heartbeat_forwards_total", "Heartbeats in MODE_LINK, by what became of them.", "result"),
		heartbeatDuration: newHistogram("link_heartbeat_forward_duration_seconds", "From a heartbeat's forwarding to the route's answer.", linkDurationBounds...),
		heartbeatFacts:    newCounter("link_heartbeat_facts_total", "Heartbeat facts, by how the gateway read them: whole, cached (a digest it held), unknown_digest, invalid_json, digest_mismatch, ignored.", "result"),
		eventBatches:      newCounter("link_event_batches_total", "Event batches in MODE_LINK, by what became of them.", "result"),
		eventsStored:      newCounter("link_events_stored_total", "Durable events the ingest route stored and the gateway acknowledged."),
		eventAckDuration:  newHistogram("link_event_ack_duration_seconds", "From an event batch's arrival to its EventAck.", linkDurationBounds...),
		ingestEvents:      newGauge("link_ingest_queue_events", "Durable events queued for or in flight to the apiserver, across connections: the depth credit is granted by."),
		ingestBytes:       newGauge("link_ingest_queue_bytes", "The payload bytes of those events."),
		creditReduced:     newGauge("link_credit_reduced", "1 while the ingest queue is past its high-water mark and every connection's credit is reduced."),
		creditChanges:     newCounter("link_credit_changes_total", "Times every connection's credit was reduced or restored.", "to"),
		liveEvents:        newCounter("link_live_events_total", "Live stream events, by what became of them: published, no_watchers, nats_down, publish_failed, bad_session.", "result"),
		watchedSessions:   newGauge("link_watched_sessions", "Sessions of connected runners that someone watches live now."),
		prefixRequests:    newCounter("link_turn_prefix_requests_total", "Turn prefix requests from the apiserver, by how they were answered.", "result"),
		queueFull:         newCounter("link_queue_full_total", "Frames that found their write queue full, by queue and what became of them: closed (the connection, slow_consumer) or dropped.", "queue", "result"),
	}
	for _, r := range handshakeResults {
		m.handshakes.preset(r)
	}
	for _, r := range refusalReasons {
		m.tokenRefusals.preset(string(r))
	}
	for _, r := range disconnectReasons {
		m.disconnects.preset(r)
	}
	for _, kind := range []string{"heartbeat", "events"} {
		m.shadowPairs.preset(kind, "match")
		m.shadowPairs.preset(kind, "mismatch")
	}
	for _, side := range []string{"typed", "raw"} {
		for _, reason := range []string{"expired", "evicted", "closed"} {
			m.shadowUnpaired.preset(side, reason)
		}
	}
	for _, r := range []string{"ok", "error", "unauthorized", "not_configured"} {
		m.revocationFetches.preset(r)
	}
	for _, kind := range []string{"inbox", "claim", "commands"} {
		for _, result := range []string{"sent", "mode_http", "no_connection", "dropped"} {
			m.hints.preset(kind, result)
		}
	}
	m.hints.preset("unknown", "malformed")
	for _, kind := range []string{"rpc", "heartbeat", "events"} {
		for _, result := range []string{"answered", "timeout", "cancelled", "cut_off", "unavailable"} {
			m.backendCalls.preset(kind, result)
		}
	}
	for _, r := range []string{"2xx", "4xx", "5xx", "BACKEND_UNAVAILABLE", "BACKEND_TIMEOUT", "BACKEND_CUT_OFF", "RPC_BAD_REQUEST", "RPC_TOO_MANY_IN_FLIGHT", "CANCELLED"} {
		m.rpcResults.preset(r)
	}
	for _, r := range []string{"forwarded", "want_facts", "failed", "refused", "superseded"} {
		m.heartbeatForwards.preset(r)
	}
	for _, r := range []string{"stored", "credit_exceeded", "gap", "no_answer", "refused", "refused_retryable", "failed_behind"} {
		m.eventBatches.preset(r)
	}
	for _, r := range []string{"published", "no_watchers", "nats_down"} {
		m.liveEvents.preset(r)
	}
	for _, r := range []string{"answered", "timeout", "dropped", "mode_http", "no_connection"} {
		m.prefixRequests.preset(r)
	}
	for _, q := range tierNames {
		m.queueFull.preset(q, "closed")
		m.queueFull.preset(q, "dropped")
	}
	m.all = []collector{
		&infoGauge{name: "link_gateway_build_info", help: "The gateway's version.", labels: []string{"version"}, values: []string{version}},
		&gauge{name: "link_gateway_start_time_seconds", help: "When this process started, in Unix seconds.", v: float64(time.Now().Unix())},
		m.connections, m.handshakes, m.handshakeDuration, m.tokenRefusals, m.disconnects, m.rtt,
		m.framesReceived, m.framesSent, m.frameDecodeErrors, m.heartbeats, m.draining, m.drainsSent,
		m.revocations, m.revocationFetches, m.revocationLastSuccess, m.tlsNotAfter, m.tlsReloads, m.tlsHandshakeErrors,
		m.rpcs, m.shadowPairs, m.shadowMismatches, m.shadowUnpaired, m.shadowEvents, m.shadowPendingBytes,
		m.hints, m.hintsSlow, m.hintSubscriptions, m.natsConnected, m.natsReconnects,
		m.backendCalls, m.backendRetries, m.backendDuration, m.rpcResults, m.rpcDuration,
		m.heartbeatForwards, m.heartbeatDuration, m.heartbeatFacts,
		m.eventBatches, m.eventsStored, m.eventAckDuration, m.ingestEvents, m.ingestBytes, m.creditReduced, m.creditChanges,
		m.liveEvents, m.watchedSessions, m.prefixRequests, m.queueFull,
	}
	return m
}

// linkDurationBounds are the buckets of the forwarding paths' durations, in seconds: an event acknowledgement's p99 is
// held under one second (§9).
var linkDurationBounds = []float64{0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60}

func (m *gatewayMetrics) writeTo(out io.Writer) error {
	w := bufio.NewWriter(out)
	for _, c := range m.all {
		c.write(w)
	}
	return w.Flush()
}
