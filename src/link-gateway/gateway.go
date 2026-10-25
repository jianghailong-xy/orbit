package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"log/slog"
	"math"
	"math/rand/v2"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/coder/websocket"

	"orbit/link-gateway/linkpb"
)

// gateway is what every connection shares.
type gateway struct {
	cfg         config
	log         *slog.Logger
	metrics     *gatewayMetrics
	verifier    *tokenVerifier
	deny        *denyList
	ipLimit     *limiter
	globalLimit *limiter
	reg         *registry
	now         func() time.Time
	draining    atomic.Bool
	// linkRequired is the server's RUNNER_LINK_REQUIRED switch as last read (mode.go).
	linkRequired atomic.Bool

	// hints relays runner hints from NATS (hints.go); nil when LINK_NATS_URL is not set.
	hints *hintRelay

	// backends are the apiserver instances calls are forwarded to (backend.go); nil when LINK_INTERNAL_API_URLS names
	// none.
	backends *backendPool
	// credit is the ingest queue's depth and the credit it grants (events.go).
	credit *creditBook
	// watchers is who watches which session live, by runner (live.go).
	watchers *watcherBook

	// forward hands an Rpc to a backend: forwardRPC, behind mayForward, which lets only a connection in MODE_LINK
	// forward; nil without backends.
	forward func(c *conn, rpc *linkpb.Rpc)
}

func newGateway(cfg config, logger *slog.Logger) *gateway {
	deny := &denyList{set: map[string]struct{}{}}
	g := &gateway{
		cfg:         cfg,
		log:         logger,
		verifier:    newTokenVerifier(cfg.PublicKeys),
		deny:        deny,
		ipLimit:     newLimiter(cfg.IPRate, cfg.IPBurst),
		globalLimit: newLimiter(cfg.HandshakeRate, cfg.HandshakeBurst),
		reg:         newRegistry(cfg.MaxConnsPerRunner),
		now:         time.Now,
	}
	g.metrics = newGatewayMetrics(version, deny, func() float64 { return float64(shadowPending.Load()) })
	g.credit = newCreditBook(g, cfg.link)
	g.watchers = newWatcherBook(cfg.link.WatchersTTL)
	g.metrics.ingestEvents.fn = func() float64 { return float64(g.credit.depth().Events) }
	g.metrics.ingestBytes.fn = func() float64 { return float64(g.credit.depth().Bytes) }
	g.metrics.watchedSessions.fn = func() float64 { return float64(g.watchers.watched()) }
	// Built in MODE_HTTP too, since the switch can turn MODE_LINK on at any time; they dial nothing until a call is
	// forwarded.
	if len(cfg.InternalAPIURLs) > 0 {
		g.backends = newBackendPool(cfg, g.metrics, logger)
		g.forward = forwardRPC
	}
	g.metrics.mode.set(modeGauge(g.mode()))
	return g
}

// ServeHTTP is the runners' port: every request is an upgrade request, checked in this order before anything is
// upgraded (README.md, "Handshake"): draining, WebSocket, the handshake rate, the client address's rate, the
// connection token, the runner's connection slots.
func (g *gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	started := g.now()
	m := g.metrics
	if g.draining.Load() {
		m.handshakes.inc("draining")
		refuseHTTP(w, http.StatusServiceUnavailable, "DRAINING", "", "this gateway is shutting down; connect again shortly", 5*time.Second)
		return
	}
	if !isWebSocketUpgrade(r) {
		m.handshakes.inc("not_websocket")
		w.Header().Set("Upgrade", "websocket")
		refuseHTTP(w, http.StatusUpgradeRequired, "WEBSOCKET_REQUIRED", "", "this is the Orbit runner link: it speaks WebSocket only", 0)
		return
	}
	if ok, wait := g.globalLimit.allow(""); !ok {
		m.handshakes.inc("rate_limited")
		refuseHTTP(w, http.StatusTooManyRequests, "RATE_LIMITED", "", "this gateway is taking too many new connections", wait)
		return
	}
	ip := clientIP(r)
	if ok, wait := g.ipLimit.allow(ip); !ok {
		m.handshakes.inc("rate_limited")
		refuseHTTP(w, http.StatusTooManyRequests, "RATE_LIMITED", "", "too many new connections from this address", wait)
		return
	}
	claims, err := g.verifier.verify(bearer(r), g.cfg.CellID, g.deny, g.now())
	if err != nil {
		reason := refusalOf(err)
		m.handshakes.inc("unauthenticated")
		m.tokenRefusals.inc(string(reason))
		g.log.Info("upgrade refused", "remote", ip, "reason", reason, "err", err)
		refuseHTTP(w, http.StatusUnauthorized, "UNAUTHENTICATED", string(reason),
			"the link token was refused; fetch a new one with POST /api/runner/link-token", 0)
		return
	}
	if !g.reg.reserve(claims.RunnerID, claims.LeaseOwner) {
		m.handshakes.inc("too_many_connections")
		g.log.Info("upgrade refused", "remote", ip, "runner", claims.RunnerID, "reason", "too many connections")
		refuseHTTP(w, http.StatusTooManyRequests, "TOO_MANY_CONNECTIONS", "",
			fmt.Sprintf("this runner already has %d connections", g.cfg.MaxConnsPerRunner), 30*time.Second)
		return
	}
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		g.reg.release(claims.RunnerID)
		m.handshakes.inc("upgrade_failed")
		g.log.Info("upgrade failed", "remote", ip, "err", err)
		return
	}
	ws.SetReadLimit(maxFrameBytes)
	c := newConn(g, ws, claims, ip)
	c.token = bearer(r)
	c.run(started)
}

// refuseHTTP answers an upgrade request the gateway will not upgrade. The body's code names the CloseCode the same
// refusal would carry after the upgrade, and Retry-After says when to come back.
func refuseHTTP(w http.ResponseWriter, status int, code, reason, message string, retryAfter time.Duration) {
	h := w.Header()
	h.Set("Content-Type", "application/json")
	h.Set("Connection", "close")
	body := map[string]any{"code": code, "message": message}
	if reason != "" {
		body["reason"] = reason
	}
	if retryAfter > 0 {
		h.Set("Retry-After", strconv.Itoa(int(math.Ceil(retryAfter.Seconds()))))
		body["retryAfterMs"] = retryAfter.Milliseconds()
	}
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func isWebSocketUpgrade(r *http.Request) bool {
	return headerHasToken(r.Header, "Connection", "upgrade") && headerHasToken(r.Header, "Upgrade", "websocket")
}

func headerHasToken(h http.Header, name, token string) bool {
	for _, v := range h.Values(name) {
		for _, t := range strings.Split(v, ",") {
			if strings.EqualFold(strings.TrimSpace(t), token) {
				return true
			}
		}
	}
	return false
}

func bearer(r *http.Request) string {
	if v, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer "); ok {
		return strings.TrimSpace(v)
	}
	return ""
}

// clientIP is the connecting address. Runners connect to the gateway directly (D1), so no forwarding header is
// believed.
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// drainDelay is a reconnect delay drawn at random, so a draining node's runners do not all come back at once.
func (g *gateway) drainDelay() time.Duration {
	lo, hi := g.cfg.DrainReconnectMin, g.cfg.DrainReconnectMax
	if hi <= lo {
		return lo
	}
	return lo + time.Duration(rand.Int64N(int64(hi-lo)))
}

// drain sends every connection a Drain in batches and waits until they have all closed, or ctx ends, when it closes
// the rest (§6.1). New upgrades are refused from the start, so runners come back to the next process.
func (g *gateway) drain(ctx context.Context) {
	g.draining.Store(true)
	g.metrics.draining.set(1)
	conns := g.reg.snapshot()
	rand.Shuffle(len(conns), func(i, j int) { conns[i], conns[j] = conns[j], conns[i] })
	g.log.Info("draining", "connections", len(conns), "batch", g.cfg.DrainBatch, "every", g.cfg.DrainBatchInterval,
		"reconnect_after", fmt.Sprintf("%s-%s", g.cfg.DrainReconnectMin, g.cfg.DrainReconnectMax))
	for i := 0; i < len(conns); i += g.cfg.DrainBatch {
		for _, c := range conns[i:min(i+g.cfg.DrainBatch, len(conns))] {
			c.drain(g.drainDelay())
		}
		if i+g.cfg.DrainBatch < len(conns) {
			select {
			case <-ctx.Done():
			case <-time.After(g.cfg.DrainBatchInterval):
			}
		}
	}
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for g.reg.count() > 0 {
		select {
		case <-ctx.Done():
			rest := g.reg.snapshot()
			g.log.Warn("drain timed out; closing the rest", "connections", len(rest))
			for _, c := range rest {
				c.closeWith(linkpb.CloseCode_CLOSE_CODE_UNSPECIFIED, "the gateway is shutting down", 0, websocket.StatusGoingAway, "shutdown")
			}
			deadline := time.Now().Add(12 * time.Second)
			for g.reg.count() > 0 && time.Now().Before(deadline) {
				time.Sleep(100 * time.Millisecond)
			}
			return
		case <-tick.C:
		}
	}
	g.log.Info("drained")
}

// kickRevoked closes the open connections whose credential the apiserver has revoked since they connected.
func (g *gateway) kickRevoked(set map[string]struct{}) {
	for _, c := range g.reg.snapshot() {
		if _, revoked := set[c.claims.Credential]; revoked {
			c.closeWith(linkpb.CloseCode_CLOSE_CODE_UNAUTHENTICATED, "the runner credential was revoked", 0,
				websocket.StatusPolicyViolation, "revoked")
		}
	}
}

// metricsHandler serves /metrics and /healthz on the private port.
func (g *gateway) metricsHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /metrics", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		_ = g.metrics.writeTo(w)
	})
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		if g.draining.Load() {
			http.Error(w, "draining", http.StatusServiceUnavailable)
			return
		}
		_, _ = w.Write([]byte("ok\n"))
	})
	return mux
}

// errorLogWriter takes net/http's own log lines: failed TLS handshakes are counted and dropped (the internet
// knocks on every port), anything else is logged.
type errorLogWriter struct{ g *gateway }

func (e errorLogWriter) Write(p []byte) (int, error) {
	line := strings.TrimSpace(string(p))
	if strings.Contains(line, "TLS handshake error") {
		e.g.metrics.tlsHandshakeErrors.inc()
		if e.g.cfg.FrameLog == "all" {
			e.g.log.Info("tls handshake failed", "detail", line)
		}
		return len(p), nil
	}
	e.g.log.Warn("http server", "detail", line)
	return len(p), nil
}

func serveMain(args []string) int {
	if len(args) > 0 {
		fmt.Fprintln(os.Stderr, "link-gateway serve takes no arguments; it reads its configuration from the environment (README.md)")
		return 2
	}
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil)).With("node", nodeName())
	cfg, err := configFromEnv(os.Getenv)
	if err != nil {
		logger.Error("configuration refused", "problems", err.Error())
		return 2
	}
	g := newGateway(cfg, logger)
	tlsSetup, err := buildTLS(cfg, g.metrics, logger)
	if err != nil {
		logger.Error("TLS not configured", "err", err)
		return 2
	}

	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	poller := &revocationPoller{
		url:     cfg.APIURL + "/api/runner/link-token/revocations",
		token:   cfg.GatewayToken,
		client:  &http.Client{Timeout: 15 * time.Second},
		deny:    g.deny,
		metrics: g.metrics,
		log:     logger,
		revoked: g.kickRevoked,
	}
	// One read before serving, so a gateway that starts normally starts with the list; if the apiserver cannot be
	// reached it serves anyway, and refuses revoked credentials once the list arrives (tokens expire within the
	// hour regardless).
	if err := poller.fetch(ctx); err != nil {
		logger.Error("revocation list not read at start; serving without it until it is", "err", err)
	}
	go poller.run(ctx, cfg.RevocationInterval)

	if cfg.NATSURL == "" {
		logger.Warn("LINK_NATS_URL is not set: no runner hints are relayed, and runners learn of work at their heartbeat")
	} else if relay, err := startHintRelay(g, cfg.NATSURL); err != nil {
		logger.Error("runner hints not relayed: NATS refused the configuration", "err", err)
	} else {
		g.hints = relay
	}
	go g.sweepWatchers(ctx.Done())
	switch {
	case cfg.Mode == linkpb.Mode_MODE_LINK:
		logger.Info("LINK_MODE=link: runners are told MODE_LINK, whatever RUNNER_LINK_REQUIRED says")
	case g.backends == nil:
		logger.Warn("LINK_INTERNAL_API_URLS is not set: runners are told MODE_HTTP whatever RUNNER_LINK_REQUIRED says, " +
			"since there is nowhere to forward their calls to")
	default:
		modes := &modePoller{
			url:    cfg.APIURL + "/api/runner/link/mode",
			token:  cfg.GatewayToken,
			client: &http.Client{Timeout: 10 * time.Second},
			g:      g,
		}
		// One read before serving, as for the revocation list; until a read succeeds, runners are told MODE_HTTP.
		modes.report(modes.fetch(ctx))
		go modes.run(ctx, cfg.ModeInterval)
	}
	if g.backends != nil {
		logger.Info("runner calls are forwarded on connections in MODE_LINK", "backends", g.backends.String(), "timeout", cfg.RPCTimeout)
	}

	hup := make(chan os.Signal, 1)
	signal.Notify(hup, syscall.SIGHUP)
	go tlsSetup.run(ctx, hup)
	go func() {
		t := time.NewTicker(time.Minute)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				g.ipLimit.sweep()
			}
		}
	}()

	metricsSrv := &http.Server{Addr: cfg.MetricsAddr, Handler: g.metricsHandler(), ReadHeaderTimeout: 5 * time.Second}
	var protocols http.Protocols
	protocols.SetHTTP1(true)
	linkSrv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           g,
		TLSConfig:         tlsSetup.config,
		ReadHeaderTimeout: cfg.HandshakeTimeout,
		IdleTimeout:       cfg.HandshakeTimeout,
		MaxHeaderBytes:    16 << 10,
		Protocols:         &protocols,
		ErrorLog:          log.New(errorLogWriter{g}, "", 0),
	}

	errs := make(chan error, 2)
	go func() { errs <- fmt.Errorf("metrics server: %w", metricsSrv.ListenAndServe()) }()
	go func() {
		if tlsSetup.config == nil {
			errs <- fmt.Errorf("link server: %w", linkSrv.ListenAndServe())
		} else {
			errs <- fmt.Errorf("link server: %w", linkSrv.ListenAndServeTLS("", ""))
		}
	}()
	logger.Info("link gateway serving", "version", version, "listen", cfg.ListenAddr, "metrics", cfg.MetricsAddr,
		"tls", cfg.TLSMode, "cell", cfg.CellID, "keys", len(cfg.PublicKeys), "mode", g.mode().String(), "hints", g.hints != nil)

	sig := make(chan os.Signal, 2)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	select {
	case err := <-errs:
		logger.Error("stopped", "err", err)
		return 1
	case s := <-sig:
		logger.Info("shutting down: draining first", "signal", s.String())
	}
	drainCtx, cancel := context.WithTimeout(context.Background(), cfg.DrainTimeout)
	defer cancel()
	done := make(chan struct{})
	go func() { g.drain(drainCtx); close(done) }()
	select {
	case <-done:
	case s := <-sig:
		logger.Warn("second signal: exiting without waiting for the drain", "signal", s.String())
		return 1
	}
	if g.hints != nil {
		g.hints.close()
	}
	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelShutdown()
	_ = linkSrv.Shutdown(shutdownCtx)
	_ = metricsSrv.Shutdown(shutdownCtx)
	logger.Info("stopped")
	return 0
}

// healthMain is the container's health check: the metrics port answers /healthz with 200.
func healthMain(args []string) int {
	addr := os.Getenv("LINK_METRICS_ADDR")
	if addr == "" {
		addr = ":9464"
	}
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		fmt.Fprintln(os.Stderr, "LINK_METRICS_ADDR:", err)
		return 1
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("http://" + net.JoinHostPort(host, port) + "/healthz")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		fmt.Fprintln(os.Stderr, "healthz:", resp.Status)
		return 1
	}
	return 0
}
