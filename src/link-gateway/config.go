package main

import (
	"crypto/ed25519"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"orbit/link-gateway/linkpb"
)

// Fixed by the design rather than configured (docs/runner-link-design.md §5.1, §5.7, §6.1). They are fields of
// config only so that tests can shorten them.
const (
	// maxMergeBatches is how many batches the apiserver takes in one merged call (MAX_LINK_CALL_BATCHES, link-events.ts).
	maxMergeBatches          = 256
	maxFrameBytes            = 256 << 10
	defaultHeartbeatInterval = 30 * time.Second
	defaultModeInterval      = time.Second
	defaultPingInterval      = 20 * time.Second
	defaultPingTimeout       = 60 * time.Second
	defaultMaxConnsPerRunner = 2
)

// config is everything the gateway is told at start, from the environment (README.md, "Configuration").
type config struct {
	ListenAddr  string
	MetricsAddr string

	// TLSMode is "files" (a certificate and key on disk, reloaded when they change), "acme" (issued and renewed by
	// the gateway itself) or "off" (plain ws://, for development only).
	TLSMode           string
	TLSCertFile       string
	TLSKeyFile        string
	TLSReloadInterval time.Duration
	ACMEDomains       []string
	ACMEEmail         string
	ACMEDirectoryURL  string
	ACMECacheDir      string
	ACMECAFile        string

	// PublicKeys verify connection tokens: the public halves of the apiserver's RUNNER_LINK_SIGNING_KEY, two of
	// them while that key is being replaced.
	PublicKeys []ed25519.PublicKey
	CellID     string

	// APIURL is the apiserver's base address; the gateway reads the revoked credentials from it with GatewayToken, and
	// the RUNNER_LINK_REQUIRED switch (mode.go).
	APIURL             string
	GatewayToken       string
	RevocationInterval time.Duration
	// ModeInterval is how often the switch is read; a field only so that tests can shorten it.
	ModeInterval time.Duration

	HeartbeatInterval time.Duration
	PingInterval      time.Duration
	PingTimeout       time.Duration
	HelloTimeout      time.Duration
	HandshakeTimeout  time.Duration

	IPRate            float64
	IPBurst           int
	HandshakeRate     float64
	HandshakeBurst    int
	MaxConnsPerRunner int

	DrainBatch         int
	DrainBatchInterval time.Duration
	DrainReconnectMin  time.Duration
	DrainReconnectMax  time.Duration
	DrainGrace         time.Duration
	DrainTimeout       time.Duration

	// NATSURL is where the apiserver publishes runner hints (hints.go); empty, the gateway relays none.
	NATSURL string
	// NATSSeed is the gateway's NATS user nkey seed (an "SU…" seed), from LINK_NATS_SEED: the credential the gateway
	// connects with. Never logged.
	NATSSeed string

	// FrameLog is "lifecycle" (Hello, Welcome, Drain, Close and anything refused), "all" (a summary of every frame
	// either way) or "off".
	FrameLog string

	// Mode is LINK_MODE. MODE_LINK (link) pins what Welcome and HeartbeatAck tell runners, whatever the server's
	// RUNNER_LINK_REQUIRED switch says: the staging drills. MODE_HTTP (http, the default) is what they are told until
	// that switch is on, and again once it is off (mode.go). The mode decides whether a connection's work is forwarded
	// (MODE_LINK) or only compared (MODE_HTTP, the shadow period).
	Mode linkpb.Mode

	// InternalAPIURLs are the apiserver's internal listeners for runner link calls (RUNNER_LINK_INTERNAL_PORT), one per
	// apiserver instance: the backends every forwarded call goes to (backend.go). Required in MODE_LINK.
	InternalAPIURLs []string
	// RPCTimeout bounds one forwarded call to a backend, retries included.
	RPCTimeout time.Duration

	// DrillLoseAnswers is LINK_DRILL_LOSE_ANSWERS: how many answers of each call a staging drill has the gateway lose
	// (drill.go). Nil, the default, loses none.
	DrillLoseAnswers map[string]int
	// DrillIngestRate is LINK_DRILL_INGEST_RATE: the durable events a second a load test has the gateway forward at
	// most, an ingest slower than what runners send (drill.go). 0, the default, forwards them as they come.
	DrillIngestRate float64

	// The rest is fixed by the design or by this version; fields only so that tests can shorten them.
	link linkTuning
}

// linkTuning holds what the forwarding paths are bound by (forward.go, events.go, live.go).
type linkTuning struct {
	// MaxRPCsInFlight bounds one connection's forwarded calls at once; a call past it is answered retryable.
	MaxRPCsInFlight int
	// MaxIngestPerConn bounds how many sessions' event batches one connection forwards at once.
	MaxIngestPerConn int
	// Credit is what each connection may have unacknowledged while the gateway's ingest queue is short, and Reduced
	// what it may have once the queue is past HighWater, at most its share of HighWater; it is restored below LowWater
	// (events.go).
	Credit, Reduced     creditLevel
	HighWater, LowWater creditLevel
	// MaxQueued bounds the ingest queue across every connection (LINK_INGEST_QUEUE_MAX_*): a batch it has no room for
	// is refused, and its session waits in line for the room the queue frees (events.go).
	MaxQueued creditLevel
	// HoldFor is how long room freed for a session in line is held for its runner to send again.
	HoldFor time.Duration
	// RetryBudget is how long a call keeps being retried on other backends, and BackendDownFor how long a backend
	// that could not be dialed is passed over.
	RetryBudget, BackendDownFor time.Duration
	// WatchersTTL is how long an apiserver instance's count of a session's watchers stands without being repeated
	// (live.go).
	WatchersTTL time.Duration
	// PrefixTimeout is how long a turn prefix request waits for the runner's answer.
	PrefixTimeout time.Duration
	// WelcomeTimeout bounds the welcome route's call a Welcome waits for (welcome.go), retries included: well inside the
	// 10 s a runner waits for Welcome after its Hello.
	WelcomeTimeout time.Duration
	// Merge is what merged ingest calls are bound by (events_merge.go).
	Merge mergeTuning
}

// creditLevel is an amount of durable events: a count and their payload bytes.
type creditLevel struct {
	Events uint32
	Bytes  uint64
}

func (a creditLevel) plus(b creditLevel) creditLevel {
	return creditLevel{Events: a.Events + b.Events, Bytes: a.Bytes + b.Bytes}
}

func (a creditLevel) minus(b creditLevel) creditLevel {
	return creditLevel{Events: a.Events - b.Events, Bytes: a.Bytes - b.Bytes}
}

func (a creditLevel) half() creditLevel { return creditLevel{Events: a.Events / 2, Bytes: a.Bytes / 2} }

// within says a is no more than limit, in events and in bytes.
func (a creditLevel) within(limit creditLevel) bool {
	return a.Events <= limit.Events && a.Bytes <= limit.Bytes
}

// defaultMaxQueued is the ingest queue's bound (README.md, "Durable events and credit"), about half a GiB of the
// gateway's memory either way: task C2b measured 2.4 KB for each queued event of 660 payload bytes, so 200,000 of them
// are about 470 MiB; larger events, which the bytes stop first, take about 4.7 times their payload (held decoded and
// encoded for their call, and the heap's growth between collections), so 128 MiB of them about 600 MiB.
var defaultMaxQueued = creditLevel{Events: 200_000, Bytes: 128 << 20}

func defaultLinkTuning() linkTuning {
	return linkTuning{
		MaxRPCsInFlight:  64,
		MaxIngestPerConn: 8,
		Credit:           creditLevel{Events: 10_000, Bytes: 64 << 20},
		Reduced:          creditLevel{Events: 1_000, Bytes: 8 << 20},
		HighWater:        defaultMaxQueued.half(),
		LowWater:         defaultMaxQueued.half().half(),
		MaxQueued:        defaultMaxQueued,
		HoldFor:          15 * time.Second,
		RetryBudget:      5 * time.Second,
		BackendDownFor:   5 * time.Second,
		WatchersTTL:      60 * time.Second,
		PrefixTimeout:    10 * time.Second,
		WelcomeTimeout:   3 * time.Second,
		Merge:            defaultMergeTuning(),
	}
}

// letsEncrypt is the ACME directory used unless LINK_ACME_DIRECTORY_URL names another.
const letsEncrypt = "https://acme-v02.api.letsencrypt.org/directory"

// configFromEnv reads the configuration, reporting every problem at once rather than the first.
func configFromEnv(getenv func(string) string) (config, error) {
	var problems []string
	str := func(name, fallback string) string {
		if v := strings.TrimSpace(getenv(name)); v != "" {
			return v
		}
		return fallback
	}
	dur := func(name string, fallback time.Duration) time.Duration {
		v := strings.TrimSpace(getenv(name))
		if v == "" {
			return fallback
		}
		d, err := time.ParseDuration(v)
		if err != nil || d <= 0 {
			problems = append(problems, fmt.Sprintf("%s=%q is not a positive duration such as 30s", name, v))
			return fallback
		}
		return d
	}
	num := func(name string, fallback float64) float64 {
		v := strings.TrimSpace(getenv(name))
		if v == "" {
			return fallback
		}
		f, err := strconv.ParseFloat(v, 64)
		if err != nil || f <= 0 {
			problems = append(problems, fmt.Sprintf("%s=%q is not a positive number", name, v))
			return fallback
		}
		return f
	}
	integer := func(name string, fallback int) int {
		v := strings.TrimSpace(getenv(name))
		if v == "" {
			return fallback
		}
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 {
			problems = append(problems, fmt.Sprintf("%s=%q is not a positive whole number", name, v))
			return fallback
		}
		return n
	}

	c := config{
		ListenAddr:         str("LINK_LISTEN_ADDR", ":8443"),
		MetricsAddr:        str("LINK_METRICS_ADDR", ":9464"),
		TLSMode:            str("LINK_TLS_MODE", ""),
		TLSCertFile:        str("LINK_TLS_CERT_FILE", ""),
		TLSKeyFile:         str("LINK_TLS_KEY_FILE", ""),
		TLSReloadInterval:  dur("LINK_TLS_RELOAD_INTERVAL", 30*time.Second),
		ACMEDomains:        splitList(getenv("LINK_ACME_DOMAINS")),
		ACMEEmail:          str("LINK_ACME_EMAIL", ""),
		ACMEDirectoryURL:   str("LINK_ACME_DIRECTORY_URL", letsEncrypt),
		ACMECacheDir:       str("LINK_ACME_CACHE_DIR", ""),
		ACMECAFile:         str("LINK_ACME_CA_FILE", ""),
		CellID:             str("LINK_CELL_ID", "cell-1"),
		APIURL:             strings.TrimRight(str("LINK_API_URL", ""), "/"),
		GatewayToken:       str("LINK_GATEWAY_TOKEN", ""),
		RevocationInterval: dur("LINK_REVOCATION_INTERVAL", 30*time.Second),
		ModeInterval:       defaultModeInterval,
		HeartbeatInterval:  defaultHeartbeatInterval,
		PingInterval:       defaultPingInterval,
		PingTimeout:        defaultPingTimeout,
		HelloTimeout:       dur("LINK_HELLO_TIMEOUT", 10*time.Second),
		HandshakeTimeout:   dur("LINK_HANDSHAKE_TIMEOUT", 5*time.Second),
		IPRate:             num("LINK_IP_RATE", 1),
		IPBurst:            integer("LINK_IP_BURST", 20),
		HandshakeRate:      num("LINK_HANDSHAKE_RATE", 200),
		HandshakeBurst:     integer("LINK_HANDSHAKE_BURST", 400),
		MaxConnsPerRunner:  defaultMaxConnsPerRunner,
		DrainBatch:         integer("LINK_DRAIN_BATCH", 250),
		DrainBatchInterval: dur("LINK_DRAIN_BATCH_INTERVAL", time.Second),
		DrainReconnectMin:  dur("LINK_DRAIN_RECONNECT_MIN", time.Second),
		DrainReconnectMax:  dur("LINK_DRAIN_RECONNECT_MAX", 30*time.Second),
		DrainGrace:         dur("LINK_DRAIN_GRACE", 15*time.Second),
		DrainTimeout:       dur("LINK_DRAIN_TIMEOUT", 80*time.Second),
		NATSURL:            str("LINK_NATS_URL", ""),
		NATSSeed:           strings.TrimSpace(getenv("LINK_NATS_SEED")),
		FrameLog:           str("LINK_FRAME_LOG", "lifecycle"),
		Mode:               linkpb.Mode_MODE_HTTP,
		InternalAPIURLs:    splitList(getenv("LINK_INTERNAL_API_URLS")),
		RPCTimeout:         dur("LINK_RPC_TIMEOUT", 60*time.Second),
		link:               defaultLinkTuning(),
	}
	// Merged ingest (events_merge.go): a window of 0 forwards every batch alone, as before merging.
	switch v := strings.TrimSpace(getenv("LINK_EVENT_MERGE_WINDOW")); v {
	case "":
	case "0", "off":
		c.link.Merge.Window = 0
	default:
		d, err := time.ParseDuration(v)
		if err != nil || d <= 0 || d > mergeMaxWindow {
			problems = append(problems, fmt.Sprintf("LINK_EVENT_MERGE_WINDOW=%q is not 0 or a duration up to %s, such as 100ms", v, mergeMaxWindow))
		} else {
			c.link.Merge.Window = d
		}
	}
	c.link.Merge.MaxBatches = integer("LINK_EVENT_MERGE_MAX_BATCHES", c.link.Merge.MaxBatches)
	if c.link.Merge.MaxBatches > maxMergeBatches {
		problems = append(problems, fmt.Sprintf("LINK_EVENT_MERGE_MAX_BATCHES=%d is more than the %d batches the apiserver takes in one call", c.link.Merge.MaxBatches, maxMergeBatches))
	}
	c.link.Merge.MaxBytes = integer("LINK_EVENT_MERGE_MAX_BYTES", c.link.Merge.MaxBytes)
	// The ingest queue's bound (events.go); the high- and low-water marks of the credit are half and a quarter of it.
	c.link.MaxQueued = creditLevel{
		Events: uint32(min(integer("LINK_INGEST_QUEUE_MAX_EVENTS", int(defaultMaxQueued.Events)), 1<<31)),
		Bytes:  uint64(integer("LINK_INGEST_QUEUE_MAX_BYTES", int(defaultMaxQueued.Bytes))),
	}
	if !c.link.Credit.within(c.link.MaxQueued) {
		problems = append(problems, fmt.Sprintf("LINK_INGEST_QUEUE_MAX_EVENTS and LINK_INGEST_QUEUE_MAX_BYTES must be at least one connection's credit, %d events and %d bytes: a batch within it has to fit the queue",
			c.link.Credit.Events, c.link.Credit.Bytes))
	}
	c.link.HighWater = c.link.MaxQueued.half()
	c.link.LowWater = c.link.HighWater.half()
	c.DrillIngestRate = num("LINK_DRILL_INGEST_RATE", 0)

	switch mode := str("LINK_MODE", "http"); mode {
	case "http":
	case "link":
		c.Mode = linkpb.Mode_MODE_LINK
	default:
		problems = append(problems, fmt.Sprintf("LINK_MODE=%q is not http or link", mode))
	}

	if c.TLSMode == "" {
		c.TLSMode = "files"
		if len(c.ACMEDomains) > 0 {
			c.TLSMode = "acme"
		}
	}
	switch c.TLSMode {
	case "files":
		if c.TLSCertFile == "" || c.TLSKeyFile == "" {
			problems = append(problems, "LINK_TLS_CERT_FILE and LINK_TLS_KEY_FILE are required in the files TLS mode "+
				"(or set LINK_ACME_DOMAINS for certificates the gateway obtains itself)")
		}
	case "acme":
		if len(c.ACMEDomains) == 0 {
			problems = append(problems, "LINK_ACME_DOMAINS is required in the acme TLS mode")
		}
		if c.ACMECacheDir == "" {
			problems = append(problems, "LINK_ACME_CACHE_DIR is required in the acme TLS mode: certificates must outlive a restart")
		}
		if u, err := url.Parse(c.ACMEDirectoryURL); err != nil || u.Scheme != "https" {
			problems = append(problems, fmt.Sprintf("LINK_ACME_DIRECTORY_URL=%q is not an https:// address", c.ACMEDirectoryURL))
		}
	case "off":
	default:
		problems = append(problems, fmt.Sprintf("LINK_TLS_MODE=%q is not files, acme or off", c.TLSMode))
	}

	keys, err := parsePublicKeys(getenv("LINK_PUBLIC_KEYS"))
	if err != nil {
		problems = append(problems, err.Error())
	}
	c.PublicKeys = keys

	if c.APIURL == "" {
		problems = append(problems, "LINK_API_URL is required: the apiserver the revoked credentials are read from")
	} else if u, err := url.Parse(c.APIURL); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		problems = append(problems, fmt.Sprintf("LINK_API_URL=%q is not an http:// or https:// address", c.APIURL))
	}
	if c.GatewayToken == "" {
		problems = append(problems, "LINK_GATEWAY_TOKEN is required: the apiserver's RUNNER_LINK_GATEWAY_TOKEN")
	}
	if c.NATSURL != "" {
		if u, err := url.Parse(c.NATSURL); err != nil || u.Scheme != "nats" || u.Host == "" {
			problems = append(problems, fmt.Sprintf("LINK_NATS_URL=%q is not a nats:// address", c.NATSURL))
		} else if u.User != nil {
			problems = append(problems, "LINK_NATS_URL carries credentials: give the gateway its nkey seed in LINK_NATS_SEED instead")
		}
	}
	if c.NATSSeed != "" {
		// The seed itself is never repeated in a problem: it is a credential.
		if _, err := natsUserKey(c.NATSSeed); err != nil {
			problems = append(problems, "LINK_NATS_SEED is not a NATS user nkey seed (link-gateway nkey makes one): "+err.Error())
		}
	}
	for _, raw := range c.InternalAPIURLs {
		if u, err := url.Parse(raw); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || (u.Path != "" && u.Path != "/") {
			problems = append(problems, fmt.Sprintf("LINK_INTERNAL_API_URLS: %q is not an http:// or https:// address without a path", raw))
		}
	}
	if c.Mode == linkpb.Mode_MODE_LINK && len(c.InternalAPIURLs) == 0 {
		problems = append(problems, "LINK_MODE=link needs LINK_INTERNAL_API_URLS: the apiserver's internal listener (RUNNER_LINK_INTERNAL_PORT) that runner calls are forwarded to")
	}
	for i, raw := range c.InternalAPIURLs {
		c.InternalAPIURLs[i] = strings.TrimRight(raw, "/")
	}
	if c.DrainReconnectMax < c.DrainReconnectMin {
		problems = append(problems, "LINK_DRAIN_RECONNECT_MAX is shorter than LINK_DRAIN_RECONNECT_MIN")
	}
	switch c.FrameLog {
	case "lifecycle", "all", "off":
	default:
		problems = append(problems, fmt.Sprintf("LINK_FRAME_LOG=%q is not lifecycle, all or off", c.FrameLog))
	}
	if counts, err := parseDrillLoseAnswers(getenv("LINK_DRILL_LOSE_ANSWERS")); err != nil {
		problems = append(problems, err.Error())
	} else {
		c.DrillLoseAnswers = counts
	}
	if len(problems) > 0 {
		return c, errors.New(strings.Join(problems, "\n"))
	}
	return c, nil
}

// splitList reads a comma- or whitespace-separated list.
func splitList(v string) []string {
	return strings.FieldsFunc(v, func(r rune) bool { return r == ',' || r == ' ' || r == '\n' || r == '\t' })
}

// nodeName names this gateway process in logs: its container's hostname.
func nodeName() string {
	if h, err := os.Hostname(); err == nil && h != "" {
		return h
	}
	return "link-gateway"
}
