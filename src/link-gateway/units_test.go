package main

import (
	"bufio"
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"log/slog"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/encoding/protodelim"
	"google.golang.org/protobuf/proto"

	"orbit/link-gateway/linkpb"
)

func TestChunksJoinBackIntoTheFrame(t *testing.T) {
	f := &linkpb.Frame{Id: 7, Body: &linkpb.Frame_EventBatch{EventBatch: &linkpb.EventBatch{SessionId: "s",
		Events: []*linkpb.Event{{Seq: 1, PayloadJson: bytes.Repeat([]byte("x"), 700<<10)}}}}}
	next := uint64(7)
	msgs, err := encodeFrame(f, maxFrameBytes, func() uint64 { next++; return next })
	if err != nil || len(msgs) != 3 {
		t.Fatalf("%d messages, %v", len(msgs), err)
	}
	var r reassembler
	for i, m := range msgs {
		if len(m) > maxFrameBytes {
			t.Fatalf("message %d is %d bytes", i, len(m))
		}
		var piece linkpb.Frame
		if err := proto.Unmarshal(m, &piece); err != nil {
			t.Fatal(err)
		}
		joined, err := r.add(piece.GetChunk())
		if err != nil {
			t.Fatal(err)
		}
		if (joined != nil) != (i == len(msgs)-1) {
			t.Fatalf("piece %d: joined %v", i, joined != nil)
		}
		if joined != nil && !proto.Equal(joined, f) {
			t.Fatal("the joined frame differs")
		}
	}
	if partialBytes.Load() != 0 {
		t.Fatalf("%d bytes still held", partialBytes.Load())
	}
	small, _ := encodeFrame(&linkpb.Frame{Id: 1, Body: &linkpb.Frame_Heartbeat{Heartbeat: &linkpb.Heartbeat{}}}, maxFrameBytes, nil)
	if len(small) != 1 {
		t.Fatal("a small frame was cut up")
	}
}

func TestChunkRulesAreEnforced(t *testing.T) {
	cases := []struct {
		name   string
		pieces []*linkpb.Chunk
	}{
		{"starts past 0", []*linkpb.Chunk{{FrameId: 1, Index: 1, Last: true}}},
		{"skips a piece", []*linkpb.Chunk{{FrameId: 1, Index: 0}, {FrameId: 1, Index: 2, Last: true}}},
		{"too large", []*linkpb.Chunk{{FrameId: 1, Index: 0, Data: make([]byte, maxChunkedFrameBytes)}, {FrameId: 1, Index: 1, Data: []byte{1}}}},
		{"too many at once", []*linkpb.Chunk{{FrameId: 1}, {FrameId: 2}, {FrameId: 3}, {FrameId: 4}, {FrameId: 5}}},
		{"joins to garbage", []*linkpb.Chunk{{FrameId: 1, Index: 0, Last: true, Data: []byte{0xff, 0xff}}}},
	}
	nested, _ := proto.Marshal(&linkpb.Frame{Body: &linkpb.Frame_Chunk{Chunk: &linkpb.Chunk{FrameId: 9}}})
	cases = append(cases, struct {
		name   string
		pieces []*linkpb.Chunk
	}{"a chunk of a chunk", []*linkpb.Chunk{{FrameId: 1, Index: 0, Last: true, Data: nested}}})
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var r reassembler
			defer r.close()
			var err error
			for _, p := range c.pieces {
				if _, err = r.add(p); err != nil {
					break
				}
			}
			if err == nil {
				t.Fatal("accepted")
			}
		})
	}
	if partialBytes.Load() != 0 {
		t.Fatalf("%d bytes still held", partialBytes.Load())
	}
}

func TestLimiterRefillsAndForgets(t *testing.T) {
	now := time.Unix(0, 0)
	l := newLimiter(2, 3)
	l.now = func() time.Time { return now }
	for i := 0; i < 3; i++ {
		if ok, _ := l.allow("a"); !ok {
			t.Fatalf("burst refused at %d", i)
		}
	}
	ok, wait := l.allow("a")
	if ok || wait <= 0 || wait > 500*time.Millisecond {
		t.Fatalf("after the burst: %v %v", ok, wait)
	}
	if ok, _ := l.allow("b"); !ok {
		t.Fatal("another key shares a's bucket")
	}
	now = now.Add(500 * time.Millisecond)
	if ok, _ := l.allow("a"); !ok {
		t.Fatal("no refill after 0.5 s at 2/s")
	}
	now = now.Add(time.Hour)
	l.sweep()
	if l.size() != 0 {
		t.Fatalf("%d full buckets kept", l.size())
	}
}

func TestPrometheusExposition(t *testing.T) {
	c := newCounter("x_total", "Things.", "kind")
	c.inc(`a"b`)
	c.add(2, "z")
	g := newGauge("y", "A level.")
	g.set(1.5)
	h := newHistogram("d_seconds", "Durations.", 0.1, 1)
	h.observe(50 * time.Millisecond)
	h.observe(2 * time.Second)
	var b bytes.Buffer
	w := bufio.NewWriter(&b)
	for _, col := range []collector{c, g, h} {
		col.write(w)
	}
	w.Flush()
	want := `# HELP x_total Things.
# TYPE x_total counter
x_total{kind="a\"b"} 1
x_total{kind="z"} 2
# HELP y A level.
# TYPE y gauge
y 1.5
# HELP d_seconds Durations.
# TYPE d_seconds histogram
d_seconds_bucket{le="0.1"} 1
d_seconds_bucket{le="1"} 1
d_seconds_bucket{le="+Inf"} 2
d_seconds_sum 2.05
d_seconds_count 2
`
	if b.String() != want {
		t.Fatalf("got\n%s\nwant\n%s", b.String(), want)
	}
}

func TestDumpDecodesLogLinesAndCaptures(t *testing.T) {
	hb := &linkpb.Frame{Id: 3, Body: &linkpb.Frame_Heartbeat{Heartbeat: &linkpb.Heartbeat{ProcessId: "p-1", IdleCapacity: 2,
		Facts: []*linkpb.Fact{{Kind: "engines", Sha256: "abcdef0123456789", Json: []byte("[]")}}}}}
	b, _ := proto.Marshal(hb)
	text := strings.Join([]string{
		base64.StdEncoding.EncodeToString(b),
		hex.EncodeToString(b),
		`time=2026-10-25T06:00:00Z level=WARN msg="frame does not decode" raw="` + base64.StdEncoding.EncodeToString(b) + `"`,
		"# a comment",
	}, "\n")
	var out, errOut bytes.Buffer
	if code := dumpMain(nil, strings.NewReader(text), &out, &errOut); code != 0 {
		t.Fatalf("exit %d: %s %s", code, out.String(), errOut.String())
	}
	if n := strings.Count(out.String(), "#3 heartbeat process=p-1 draining=false idle=2 sessions=0 facts=[engines:abcdef01+2B]"); n != 3 {
		t.Fatalf("%d summaries:\n%s", n, out.String())
	}

	var capture bytes.Buffer
	big := &linkpb.Frame{Id: 4, Body: &linkpb.Frame_EventBatch{EventBatch: &linkpb.EventBatch{SessionId: "s-1",
		Events: []*linkpb.Event{{Seq: 1, PayloadJson: bytes.Repeat([]byte("y"), 300<<10)}}}}}
	next := uint64(4)
	msgs, _ := encodeFrame(big, maxFrameBytes, func() uint64 { next++; return next })
	for _, m := range msgs {
		var f linkpb.Frame
		_ = proto.Unmarshal(m, &f)
		_, _ = protodelim.MarshalTo(&capture, &f)
	}
	out.Reset()
	if code := dumpMain(nil, &capture, &out, &errOut); code != 0 {
		t.Fatalf("exit %d: %s", code, out.String())
	}
	if !strings.Contains(out.String(), "chunk frame=4 index=1 last=true") || !strings.Contains(out.String(), "#4 event_batch session=s-1 events=1 seq=1-1") {
		t.Fatalf("capture:\n%s", out.String())
	}
	out.Reset()
	if code := dumpMain(nil, strings.NewReader("Zm9vYmFy\n"), &out, &errOut); code != 1 {
		t.Fatalf("garbage: exit %d", code)
	}
}

func TestConfigurationFromEnvironment(t *testing.T) {
	k := newTestKeys(t)
	env := map[string]string{
		"LINK_PUBLIC_KEYS":   base64.StdEncoding.EncodeToString([]byte(publicPEM(t, k.pub))),
		"LINK_API_URL":       "http://apiserver:3000/",
		"LINK_GATEWAY_TOKEN": strings.Repeat("g", 32),
		"LINK_TLS_CERT_FILE": "/tls/fullchain.pem",
		"LINK_TLS_KEY_FILE":  "/tls/privkey.pem",
	}
	get := func(name string) string { return env[name] }
	c, err := configFromEnv(get)
	if err != nil {
		t.Fatal(err)
	}
	if c.TLSMode != "files" || c.APIURL != "http://apiserver:3000" || c.PingInterval != 20*time.Second ||
		c.PingTimeout != 60*time.Second || c.MaxConnsPerRunner != 2 || c.Mode != linkpb.Mode_MODE_HTTP || len(c.PublicKeys) != 1 {
		t.Fatalf("config %+v", c)
	}
	env["LINK_ACME_DOMAINS"] = "link.example.com"
	env["LINK_ACME_CACHE_DIR"] = "/acme"
	if c, err := configFromEnv(get); err != nil || c.TLSMode != "acme" || c.ACMEDirectoryURL != letsEncrypt {
		t.Fatalf("acme: %+v %v", c, err)
	}
	_, err = configFromEnv(func(name string) string {
		if name == "LINK_PING_INTERVAL" || name == "LINK_IP_RATE" {
			return "fast"
		}
		return map[string]string{"LINK_IP_RATE": "fast", "LINK_TLS_MODE": "magic", "LINK_DRAIN_GRACE": "-1s"}[name]
	})
	if err == nil {
		t.Fatal("accepted")
	}
	for _, want := range []string{"LINK_PUBLIC_KEYS is required", "LINK_API_URL is required", "LINK_GATEWAY_TOKEN is required",
		`LINK_TLS_MODE="magic"`, `LINK_IP_RATE="fast"`, `LINK_DRAIN_GRACE="-1s"`} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("problems do not say %q:\n%s", want, err)
		}
	}
}

// selfSigned writes a certificate and key for name, valid until notAfter, as PEM files in dir.
func selfSigned(t *testing.T, dir, name string, notAfter time.Time) (certFile, keyFile string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: name},
		DNSNames: []string{name}, NotBefore: time.Now().Add(-time.Hour), NotAfter: notAfter}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	kder, _ := x509.MarshalECPrivateKey(key)
	certFile, keyFile = filepath.Join(dir, "fullchain.pem"), filepath.Join(dir, "privkey.pem")
	if err := os.WriteFile(certFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyFile, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kder}), 0o600); err != nil {
		t.Fatal(err)
	}
	return certFile, keyFile
}

// A renewed or rotated certificate is served without a restart; files that do not make a valid pair leave the one in
// use alone.
func TestCertificateFilesAreReloaded(t *testing.T) {
	dir := t.TempDir()
	first := time.Now().Add(24 * time.Hour).Truncate(time.Second)
	certFile, keyFile := selfSigned(t, dir, "link.test", first)
	g := newGateway(testConfig(), slog.New(slog.NewTextHandler(&syncBuffer{}, nil)))
	cf := &certFiles{certFile: certFile, keyFile: keyFile, metrics: g.metrics, log: g.log}
	if _, err := cf.load(); err != nil {
		t.Fatal(err)
	}
	serving := func() *x509.Certificate {
		c, _ := cf.getCertificate(&tls.ClientHelloInfo{})
		return c.Leaf
	}
	if !serving().NotAfter.Equal(first) || g.metrics.tlsNotAfter.get() != float64(first.Unix()) {
		t.Fatal("first certificate not served")
	}
	if changed, err := cf.load(); changed || err != nil {
		t.Fatalf("unchanged files reloaded: %v %v", changed, err)
	}
	second := time.Now().Add(48 * time.Hour).Truncate(time.Second)
	selfSigned(t, dir, "link.test", second)
	if changed, err := cf.load(); !changed || err != nil {
		t.Fatalf("rotation: %v %v", changed, err)
	}
	if !serving().NotAfter.Equal(second) {
		t.Fatal("rotated certificate not served")
	}
	if err := os.WriteFile(keyFile, []byte("not a key"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := cf.load(); err == nil {
		t.Fatal("a broken pair loaded")
	}
	if !serving().NotAfter.Equal(second) {
		t.Fatal("a broken pair replaced the certificate in use")
	}
}

func TestACMEConfiguration(t *testing.T) {
	cfg := testConfig()
	cfg.TLSMode, cfg.ACMEDomains, cfg.ACMECacheDir, cfg.ACMEDirectoryURL = "acme", []string{"link.test"}, t.TempDir(), letsEncrypt
	g := newGateway(cfg, slog.New(slog.NewTextHandler(&syncBuffer{}, nil)))
	setup, err := buildTLS(cfg, g.metrics, g.log)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(setup.config.NextProtos, ",") != "http/1.1,acme-tls/1" {
		t.Fatalf("ALPN %v: TLS-ALPN-01 needs acme-tls/1", setup.config.NextProtos)
	}
	// A name outside LINK_ACME_DOMAINS is refused before anything is asked of the CA.
	if _, err := setup.config.GetCertificate(&tls.ClientHelloInfo{ServerName: "other.test"}); err == nil {
		t.Fatal("a certificate for another name")
	}
	cfg.ACMECAFile = filepath.Join(t.TempDir(), "missing.pem")
	if _, err := buildTLS(cfg, g.metrics, g.log); err == nil {
		t.Fatal("a missing CA file accepted")
	}
}
