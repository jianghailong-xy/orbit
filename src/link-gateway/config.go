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
	maxFrameBytes            = 256 << 10
	defaultHeartbeatInterval = 30 * time.Second
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

	// APIURL is the apiserver's base address; the gateway reads the revoked credentials from it with GatewayToken.
	APIURL             string
	GatewayToken       string
	RevocationInterval time.Duration

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

	// FrameLog is "lifecycle" (Hello, Welcome, Drain, Close and anything refused), "all" (a summary of every frame
	// either way) or "off".
	FrameLog string

	// Mode is what Welcome and HeartbeatAck tell runners. Version 0 forwards nothing, so it is always MODE_HTTP;
	// the field exists for the tests that pin what a MODE_LINK connection may forward.
	Mode linkpb.Mode
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
		FrameLog:           str("LINK_FRAME_LOG", "lifecycle"),
		Mode:               linkpb.Mode_MODE_HTTP,
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
	if c.DrainReconnectMax < c.DrainReconnectMin {
		problems = append(problems, "LINK_DRAIN_RECONNECT_MAX is shorter than LINK_DRAIN_RECONNECT_MIN")
	}
	switch c.FrameLog {
	case "lifecycle", "all", "off":
	default:
		problems = append(problems, fmt.Sprintf("LINK_FRAME_LOG=%q is not lifecycle, all or off", c.FrameLog))
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
