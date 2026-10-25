package main

import (
	"bytes"
	"context"
	"crypto/x509"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func linkNoProxy(*http.Request) (*url.URL, error) { return nil, nil }

// A link that works: doctor says it was welcomed, over which TLS, how long each step took and what a ping costs, and
// closes its connection as a client that is done.
func TestDoctorSaysTheLinkWelcomedThisMachine(t *testing.T) {
	g := newFakeLinkGateway(t)
	cp := newFakeLinkControlPlane(t, g.linkURL())
	p := probeRunnerLink(context.Background(), cp.URL, "runner-token", linkNoProxy, g.roots())
	if p.err != nil {
		t.Fatalf("probe: %v\n%s", p.err, strings.Join(p.report(), "\n"))
	}
	report := strings.Join(p.report(), "\n")
	t.Log("\n" + report)
	for _, want := range []string{"✓ " + g.linkURL() + " welcomed this machine as c-", "proxy:  none", "TLS:    TLS 1.3, certificate",
		"time:   TCP ", ", TLS ", "Welcome after ", "RTT:    min ", fmt.Sprintf("over %d pings", linkDoctorPings)} {
		if !strings.Contains(report, want) {
			t.Errorf("the report does not say %q:\n%s", want, report)
		}
	}
	conns, _, _, _ := g.snapshot()
	linkWaitFor(t, 5*time.Second, "the doctor's connection to end", func() bool {
		g.mu.Lock()
		defer g.mu.Unlock()
		return len(conns) == 1 && !conns[0].ended.IsZero()
	})
	g.mu.Lock()
	defer g.mu.Unlock()
	if conns[0].status != websocket.StatusNormalClosure {
		t.Errorf("the doctor's connection ended with %v", conns[0].status)
	}
	if tok := cp.requests("/api/runner/link-token"); len(tok) != 1 || !strings.EqualFold(tok[0].leaseOwner, conns[0].hello.GetProcessId()) {
		t.Errorf("the doctor's token and Hello name different processes")
	}
}

// Through a proxy that tunnels, the report names the proxy and its CONNECT answer.
func TestDoctorNamesTheProxyItWentThrough(t *testing.T) {
	g := newFakeLinkGateway(t)
	cp := newFakeLinkControlPlane(t, g.linkURL())
	proxy := newFakeLinkProxy(t)
	host := strings.TrimPrefix(g.URL, "https://")
	p := probeRunnerLink(context.Background(), cp.URL, "runner-token", proxy.proxyFor(host), g.roots())
	if p.err != nil {
		t.Fatalf("probe: %v", p.err)
	}
	report := strings.Join(p.report(), "\n")
	t.Log("\n" + report)
	if want := "proxy:  " + proxy.URL + " (HTTPS_PROXY), CONNECT answered 200"; !strings.Contains(report, want) {
		t.Errorf("the report does not say %q:\n%s", want, report)
	}
}

// A proxy that will not carry the WebSocket is named as what blocks it, whichever way it does that: it refuses the
// tunnel, it intercepts TLS with a certificate this machine does not trust, it answers the upgrade itself, or it lets
// the upgrade through and then drops the connection.
func TestDoctorSaysWebSocketBlockedByProxy(t *testing.T) {
	interceptCert, interceptLeaf := linkTestCert(t, "Corp Proxy Inspection CA")
	for _, c := range []struct {
		name    string
		set     func(p *fakeLinkProxy)
		trusted bool // whether this machine trusts the interception certificate, as a managed laptop may
		want    string
	}{
		{"refuses the tunnel", func(p *fakeLinkProxy) { p.refuse = http.StatusForbidden }, false,
			"refused to open a tunnel to %s (HTTP 403 Forbidden)"},
		{"intercepts TLS", func(p *fakeLinkProxy) {
			p.mitmCert = interceptCert
			p.mitmHandler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {})
		}, false, `intercepts TLS: %s answered with a certificate issued by "CN=Corp Proxy Inspection CA", which this machine does not trust`},
		{"answers the upgrade itself", func(p *fakeLinkProxy) {
			p.mitmCert = interceptCert
			p.mitmHandler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusForbidden)
				_, _ = w.Write([]byte("<html>WebSockets are not allowed</html>"))
			})
		}, true, "answered the WebSocket upgrade with HTTP 403 Forbidden, in place of the link gateway"},
		{"drops the WebSocket", func(p *fakeLinkProxy) {
			p.mitmCert = interceptCert
			p.mitmHandler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				conn, _, err := w.(http.Hijacker).Hijack()
				if err != nil {
					return
				}
				fmt.Fprintf(conn, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n",
					linkWebSocketAccept(r.Header.Get("Sec-WebSocket-Key")))
				_ = conn.Close()
			})
		}, true, "let the WebSocket upgrade through, then did not carry the connection"},
	} {
		t.Run(c.name, func(t *testing.T) {
			g := newFakeLinkGateway(t)
			cp := newFakeLinkControlPlane(t, g.linkURL())
			proxy := newFakeLinkProxy(t)
			c.set(proxy)
			host := strings.TrimPrefix(g.URL, "https://")
			roots := g.roots()
			if c.trusted {
				roots.AddCert(interceptLeaf)
			}
			p := probeRunnerLink(context.Background(), cp.URL, "runner-token", proxy.proxyFor(host), roots)
			report := p.report()
			t.Log("\n" + strings.Join(report, "\n"))
			want := "✗ WebSocket blocked by proxy: "
			if !strings.HasPrefix(report[0], want) {
				t.Fatalf("the report starts %q, want %q\n%s", report[0], want, strings.Join(report, "\n"))
			}
			detail := c.want
			if strings.Contains(detail, "%s") {
				detail = fmt.Sprintf(detail, host)
			}
			if !strings.Contains(report[0], detail) || !strings.Contains(report[0], proxy.URL) {
				t.Errorf("the report says %q, want it to name %s and say %q", report[0], proxy.URL, detail)
			}
			if !strings.Contains(strings.Join(report, "\n"), "without TLS inspection") {
				t.Errorf("the report says nothing of what to do:\n%s", strings.Join(report, "\n"))
			}
			if got := proxy.connected(); len(got) != 1 || got[0] != host {
				t.Errorf("the proxy was asked for %v", got)
			}
		})
	}
}

// Without a proxy configured, something on the way that answers the upgrade in place of the gateway is reported as
// blocking the WebSocket, and said not to be a configured proxy.
func TestDoctorSaysWebSocketBlockedWithNoProxyConfigured(t *testing.T) {
	middlebox := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("<html>Welcome to the hotel network</html>"))
	}))
	defer middlebox.Close()
	cp := newFakeLinkControlPlane(t, "wss://"+strings.TrimPrefix(middlebox.URL, "https://"))
	roots := x509.NewCertPool()
	roots.AddCert(middlebox.Certificate())
	report := probeRunnerLink(context.Background(), cp.URL, "runner-token", linkNoProxy, roots).report()
	t.Log("\n" + strings.Join(report, "\n"))
	if !strings.HasPrefix(report[0], "✗ WebSocket blocked: something on the way to ") ||
		!strings.Contains(report[0], "no proxy is configured") || !strings.Contains(report[0], "HTTP 200 OK, in place of the link gateway") {
		t.Errorf("report:\n%s", strings.Join(report, "\n"))
	}
}

// The gateway's own refusal is the gateway's, named by its code; nothing is said to block the WebSocket.
func TestDoctorReportsTheGatewaysOwnRefusal(t *testing.T) {
	g := newFakeLinkGateway(t)
	g.refuse = func(*http.Request) (int, string, string) {
		return http.StatusTooManyRequests, `{"code":"TOO_MANY_CONNECTIONS","message":"two connections already"}`, "30"
	}
	cp := newFakeLinkControlPlane(t, g.linkURL())
	p := probeRunnerLink(context.Background(), cp.URL, "runner-token", linkNoProxy, g.roots())
	report := p.report()
	t.Log("\n" + strings.Join(report, "\n"))
	if p.blocked != "" || report[0] != "✗ "+g.linkURL()+": upgrade answered 429 TOO_MANY_CONNECTIONS" {
		t.Errorf("report:\n%s", strings.Join(report, "\n"))
	}
}

// A server without the runner link has nothing for doctor to check, which is no fault of the machine's; doctor's
// section says so.
func TestDoctorSaysTheServerHasNoLink(t *testing.T) {
	cp := newFakeLinkControlPlane(t, "wss://127.0.0.1:1")
	cp.tokenStatus = http.StatusNotFound
	var out bytes.Buffer
	checkRunnerLink(&RunnerConfig{ServerURL: cp.URL, RunnerToken: "runner-token"}, &out)
	want := "\nRunner link:\n  – not configured on this server (POST /api/runner/link-token answered 404 RUNNER_LINK_NOT_CONFIGURED): nothing to check\n"
	if out.String() != want {
		t.Errorf("doctor printed %q, want %q", out.String(), want)
	}
}
