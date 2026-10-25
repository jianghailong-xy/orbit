package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"orbit/linkpb"
)

// The runner link section of `orbit doctor` (docs/runner-link-design.md §7): can this machine hold the link, over
// which proxy, with what TLS and what round trip, and when it cannot, what is in the way. A proxy that will not carry
// a WebSocket leaves a runner without the link, and decision D6 ships no fallback for it, so doctor says that one in
// so many words: "WebSocket blocked by proxy".
//
// And the link mode (link_mode.go): which way the runner's daemon calls go now, as the gateway's Welcome and the
// control plane's answer over HTTPS say it, and, when that is the link, whether a daemon call goes through it: one
// GET /runner/me sent as the daemon sends its calls, an Rpc forwarded to the control plane.

const (
	// linkDoctorBudget bounds the whole check: the token, the dial and the pings.
	linkDoctorBudget = 45 * time.Second
	linkDoctorPings  = 5
)

// linkProbe is what one try of the link found.
type linkProbe struct {
	// notConfigured is set when the server has no runner link, which is no fault of this machine's.
	notConfigured error
	err           error // what failed; nil once the gateway has welcomed the connection
	// blocked says how, when what failed is a proxy, or something on the way, not carrying the WebSocket.
	blocked  string
	linkURL  string
	target   string   // the link's host:port
	proxy    *url.URL // nil: a direct connection
	proxyVar string   // the variable the proxy comes from
	// proxyStatus is the proxy's answer to CONNECT; 0 when there was none.
	proxyStatus     int
	tcp, tls, total time.Duration
	tlsState        *tls.ConnectionState
	connectionID    string
	rtts            []time.Duration

	// The link mode. mode is what the Welcome said; tokenLifetime, how long the link token lives; release, what the
	// Welcome assigns.
	mode          linkpb.Mode
	tokenLifetime time.Duration
	release       *linkpb.AssignedRelease
	// call is the daemon call doctor sent over the link, in MODE_LINK: its status, or why there is none, and its
	// round trip.
	callStatus int
	callErr    error
	callTime   time.Duration
	// httpsRefused is the control plane refusing a daemon call over HTTPS with UPGRADE_REQUIRED: the cutover.
	httpsRefused bool
	// localOff is what turned the link mode off on this machine, "" when nothing did.
	localOff string
}

// checkRunnerLink prints doctor's runner link section for the runner cfg describes.
func checkRunnerLink(cfg *RunnerConfig, out io.Writer) {
	ctx, cancel := context.WithTimeout(context.Background(), linkDoctorBudget)
	defer cancel()
	p := probeRunnerLink(ctx, cfg.ServerURL, cfg.RunnerToken, http.ProxyFromEnvironment, nil)
	if off, why := linkModeOff(cfg); off {
		p.localOff = why
	}
	fmt.Fprintln(out, "\nRunner link:")
	for _, line := range p.report() {
		fmt.Fprintln(out, "  "+line)
	}
}

// probeRunnerLink tries the link the way the runner does: a connection token over HTTPS, then the upgrade over TLS
// through the proxy proxy names, Hello, Welcome and a few pings. It opens the connection as a process of its own,
// which takes one of the runner's two connections while it lasts. roots replaces the system's roots when given.
func probeRunnerLink(ctx context.Context, serverURL, runnerToken string, proxy func(*http.Request) (*url.URL, error), roots *x509.CertPool) *linkProbe {
	p := &linkProbe{}
	processID, err := newLeaseGeneration()
	if err != nil {
		p.err = err
		return p
	}
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots}
	client := newLinkClient(serverURL, runnerToken, processID, nil)
	client.api = &http.Client{Transport: newLinkHTTPTransport(proxy, tlsConfig.Clone())}
	tok, err := client.mintToken(ctx)
	if err != nil {
		if linkNotConfigured(err) {
			p.notConfigured = err
		} else {
			p.err = err
		}
		return p
	}
	p.linkURL, p.tokenLifetime = tok.linkURL, tok.lifetime
	defer func() {
		// Asked over HTTPS as the daemon asks, naming no caller (runnerCallerHeader): what the daemon is answered there.
		_, err := NewTransport(serverURL, runnerToken).me()
		p.httpsRefused = linkUpgradeRequired(err)
	}()
	target, err := url.Parse(tok.linkURL)
	if err != nil || (target.Scheme != "wss" && target.Scheme != "ws") {
		p.err = fmt.Errorf("the server gave the link address %q, which is not a ws:// or wss:// URL", tok.linkURL)
		return p
	}
	p.target = target.Host
	if target.Port() == "" {
		p.target = net.JoinHostPort(target.Hostname(), map[string]string{"wss": "443", "ws": "80"}[target.Scheme])
	}
	asked := *target
	asked.Scheme, p.proxyVar = "https", "HTTPS_PROXY"
	if target.Scheme == "ws" {
		asked.Scheme, p.proxyVar = "http", "HTTP_PROXY"
	}
	if p.proxy, err = proxy(&http.Request{URL: &asked}); err != nil {
		p.err = fmt.Errorf("the proxy setting does not read: %w", err)
		return p
	}

	var mu sync.Mutex // the trace's callbacks run on the transport's goroutines
	var tcpStart, tlsStart time.Time
	transport := newLinkHTTPTransport(proxy, tlsConfig.Clone())
	transport.OnProxyConnectResponse = func(_ context.Context, _ *url.URL, _ *http.Request, resp *http.Response) error {
		mu.Lock()
		p.proxyStatus = resp.StatusCode
		mu.Unlock()
		return nil
	}
	trace := &httptrace.ClientTrace{
		ConnectStart: func(string, string) { mu.Lock(); tcpStart = time.Now(); mu.Unlock() },
		ConnectDone:  func(string, string, error) { mu.Lock(); p.tcp = time.Since(tcpStart); mu.Unlock() },
		TLSHandshakeStart: func() {
			mu.Lock()
			tlsStart = time.Now()
			mu.Unlock()
		},
		TLSHandshakeDone: func(state tls.ConnectionState, err error) {
			mu.Lock()
			defer mu.Unlock()
			p.tls = time.Since(tlsStart)
			if err == nil {
				p.tlsState = &state
			}
		},
	}
	start := time.Now()
	results := make(chan *linkpb.RpcResult, 1)
	conn, err := dialLink(httptrace.WithClientTrace(ctx, trace), &http.Client{Transport: transport}, tok.linkURL, tok.token,
		linkHello(processID), func(_ *linkConn, f *linkpb.Frame) {
			if r := f.GetRpcResult(); r != nil {
				select {
				case results <- r:
				default:
				}
			}
		})
	mu.Lock()
	defer mu.Unlock()
	p.total = time.Since(start)
	if err != nil {
		p.err = err
		p.blocked = p.blockedBy(err)
		return p
	}
	p.connectionID = conn.id
	for range linkDoctorPings {
		rtt, err := conn.ping(5 * time.Second)
		if err != nil {
			p.err = fmt.Errorf("the connection was welcomed, but a ping went unanswered: %w", err)
			if p.proxy != nil {
				p.blocked = "the proxy " + p.proxy.Redacted() + " carried the WebSocket's opening, then not its pings"
			}
			break
		}
		p.rtts = append(p.rtts, rtt)
	}
	p.mode, p.release = conn.welcome.GetMode(), conn.welcome.GetRelease()
	if p.err == nil && p.mode == linkpb.Mode_MODE_LINK {
		p.callStatus, p.callTime, p.callErr = probeLinkCall(ctx, conn, results, processID)
	}
	_ = conn.ws.Close(websocket.StatusNormalClosure, "orbit doctor")
	return p
}

// probeLinkCall sends GET /runner/me over conn as an Rpc, as the daemon sends its calls in link mode, and waits for
// its RpcResult: the route's status and the round trip, or why no answer came.
func probeLinkCall(ctx context.Context, conn *linkConn, results <-chan *linkpb.RpcResult, processID string) (int, time.Duration, error) {
	start := time.Now()
	if _, err := conn.send(&linkpb.Frame{Body: &linkpb.Frame_Rpc{Rpc: &linkpb.Rpc{
		RequestId: "doctor:" + processID,
		Body:      &linkpb.Rpc_Tunnel{Tunnel: &linkpb.TunnelRequest{Method: http.MethodGet, Path: "/runner/me"}},
	}}}); err != nil {
		return 0, 0, fmt.Errorf("sending it: %w", err)
	}
	wait := time.NewTimer(10 * time.Second)
	defer wait.Stop()
	select {
	case r := <-results:
		took := time.Since(start)
		if t := r.GetTunnel(); t != nil {
			return int(t.GetStatus()), took, nil
		}
		f := r.GetFailure()
		return 0, took, fmt.Errorf("the gateway answered %s: %s", f.GetCode(), f.GetMessage())
	case <-conn.done:
		return 0, 0, errors.New("the connection ended before an answer came")
	case <-wait.C:
		return 0, 0, errors.New("no answer within 10s")
	case <-ctx.Done():
		return 0, 0, ctx.Err()
	}
}

// blockedBy says how err is a proxy, or something on the way, not carrying the WebSocket; "" when it is not.
func (p *linkProbe) blockedBy(err error) string {
	via := "something on the way to " + p.target + " (no proxy is configured: a transparent proxy or a firewall?)"
	if p.proxy != nil {
		via = "the proxy " + p.proxy.Redacted()
	}
	var refused *linkHTTPError
	var unverified *tls.CertificateVerificationError
	switch {
	case p.proxy != nil && p.proxyStatus != 0 && p.proxyStatus != http.StatusOK:
		return fmt.Sprintf("the proxy %s refused to open a tunnel to %s (HTTP %d %s)", p.proxy.Redacted(), p.target,
			p.proxyStatus, http.StatusText(p.proxyStatus))
	case p.proxy != nil && errors.As(err, &unverified):
		issuer := "an unknown issuer"
		if len(unverified.UnverifiedCertificates) > 0 {
			issuer = fmt.Sprintf("%q", unverified.UnverifiedCertificates[0].Issuer.String())
		}
		return fmt.Sprintf("the proxy %s intercepts TLS: %s answered with a certificate issued by %s, which this machine does not trust",
			p.proxy.Redacted(), p.target, issuer)
	case errors.As(err, &refused) && refused.op == "upgrade" && refused.code == "":
		// The gateway names every refusal it makes (src/link-gateway/README.md, Handshake): this one is not its.
		return fmt.Sprintf("%s answered the WebSocket upgrade with HTTP %d %s, in place of the link gateway",
			via, refused.status, http.StatusText(refused.status))
	case errors.Is(err, errLinkNoWelcome):
		return via + " let the WebSocket upgrade through, then did not carry the connection: " + err.Error()
	}
	return ""
}

// report is the section's lines: the outcome first, then what it rests on.
func (p *linkProbe) report() []string {
	if p.notConfigured != nil {
		return []string{"– not configured on this server (" + p.notConfigured.Error() + "): nothing to check"}
	}
	var lines []string
	switch {
	case p.err == nil:
		lines = append(lines, fmt.Sprintf("✓ %s welcomed this machine as %s", p.linkURL, p.connectionID))
	case p.blocked != "" && p.proxy != nil:
		lines = append(lines, "✗ WebSocket blocked by proxy: "+p.blocked)
	case p.blocked != "":
		lines = append(lines, "✗ WebSocket blocked: "+p.blocked)
	case p.linkURL == "":
		lines = append(lines, "✗ cannot get a link token: "+p.err.Error())
	default:
		lines = append(lines, "✗ "+p.linkURL+": "+p.err.Error())
	}
	if p.linkURL == "" {
		return lines
	}
	if p.proxy == nil {
		lines = append(lines, "  proxy:  none")
	} else {
		proxy := fmt.Sprintf("  proxy:  %s (%s)", p.proxy.Redacted(), p.proxyVar)
		if p.proxyStatus != 0 {
			proxy += fmt.Sprintf(", CONNECT answered %d", p.proxyStatus)
		}
		lines = append(lines, proxy)
	}
	if s := p.tlsState; s != nil {
		line := "  TLS:    " + tls.VersionName(s.Version)
		if len(s.PeerCertificates) > 0 {
			cert := s.PeerCertificates[0]
			line += fmt.Sprintf(", certificate %s issued by %s, valid until %s", cert.Subject, cert.Issuer,
				cert.NotAfter.UTC().Format("2006-01-02"))
		}
		lines = append(lines, line)
	}
	timing := []string{}
	if p.tcp > 0 {
		timing = append(timing, "TCP "+linkDoctorMs(p.tcp))
	}
	if p.tls > 0 {
		timing = append(timing, "TLS "+linkDoctorMs(p.tls))
	}
	if p.err == nil {
		timing = append(timing, "Welcome after "+linkDoctorMs(p.total))
	}
	if len(timing) > 0 {
		lines = append(lines, "  time:   "+strings.Join(timing, ", "))
	}
	if n := len(p.rtts); n > 0 {
		lo, hi, sum := p.rtts[0], p.rtts[0], time.Duration(0)
		for _, rtt := range p.rtts {
			lo, hi, sum = min(lo, rtt), max(hi, rtt), sum+rtt
		}
		lines = append(lines, fmt.Sprintf("  RTT:    min %s, avg %s, max %s over %d pings", linkDoctorMs(lo),
			linkDoctorMs(sum/time.Duration(n)), linkDoctorMs(hi), n))
	}
	if p.blocked != "" {
		lines = append(lines, "  The runner link is one WebSocket straight to "+p.target+". Have it let through without TLS inspection, or run the runner on a network that carries it.")
	}
	return append(lines, p.modeReport()...)
}

// modeReport is the link mode's lines: which way the daemon calls go, and whether that way works.
func (p *linkProbe) modeReport() []string {
	var lines []string
	switch {
	case p.err != nil:
	case p.mode == linkpb.Mode_MODE_LINK:
		lines = append(lines, "  mode:   MODE_LINK — the runner's daemon calls go over this link")
	case p.mode == linkpb.Mode_MODE_HTTP:
		lines = append(lines, "  mode:   MODE_HTTP — the runner's daemon calls go over HTTPS; the link only mirrors them (the shadow period)")
	default:
		lines = append(lines, "  mode:   the gateway states none; the runner keeps the way it works now")
	}
	if p.err == nil && p.mode == linkpb.Mode_MODE_LINK {
		switch {
		case p.callErr != nil:
			lines = append(lines, "✗ a daemon call over the link got no answer: GET /runner/me — "+p.callErr.Error())
		case p.callStatus >= 200 && p.callStatus < 300:
			lines = append(lines, fmt.Sprintf("  call:   GET /runner/me answered %d over the link in %s", p.callStatus, linkDoctorMs(p.callTime)))
		default:
			lines = append(lines, fmt.Sprintf("✗ a daemon call over the link was refused: GET /runner/me answered %d", p.callStatus))
		}
	}
	if p.httpsRefused {
		lines = append(lines, "  HTTPS:  the control plane answers daemon calls over HTTPS with UPGRADE_REQUIRED: the runner works only over the link")
	}
	if p.err == nil && p.tokenLifetime > 0 {
		lines = append(lines, fmt.Sprintf("  token:  lives %s; the runner opens its next connection %s before it expires", p.tokenLifetime,
			min(linkRenewBefore, p.tokenLifetime/2)))
	}
	if r := p.release; r.GetVersion() != "" {
		line := fmt.Sprintf("  update: the link assigns release %s; this binary is %s", r.GetVersion(), version)
		if r.GetRollback() {
			line += " (a rollback)"
		}
		lines = append(lines, line)
	}
	if p.localOff != "" {
		line := "  local:  link mode is off on this machine (" + p.localOff + "): its daemon calls stay on HTTPS"
		if p.httpsRefused || p.mode == linkpb.Mode_MODE_LINK {
			line = "✗ link mode is off on this machine (" + p.localOff + "), but the control plane asks for the link: the runner cannot work until that setting is removed"
		}
		lines = append(lines, line)
	}
	return lines
}

func linkDoctorMs(d time.Duration) string {
	return fmt.Sprintf("%.2fms", float64(d.Microseconds())/1000)
}
