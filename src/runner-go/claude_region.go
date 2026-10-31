package main

// The Claude region check (docs/claude-region-check-contract.md).
//
// Anthropic offers Claude only in the regions its Supported Regions Policy lists, and what counts here is
// where Claude's own connection to Anthropic comes out (owner decision ②): through the proxy `claude` would
// use for https://api.anthropic.com, or from this machine when there is none. The control plane reads the
// place off Cloudflare's headers on one request that leaves the same way (GET /runner/region-check, §3) and
// answers allowed, blocked or unknown; the runner carries no list of its own. While the answer is blocked, a
// Claude turn that would talk to Anthropic (§8) is not started, and a message is not delivered to a running
// engine (§10).

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// claudeRegionCapabilityV1 declares that this runner checks where its Claude connection comes out and gates
// its Anthropic-bound Claude turns on the answer (contract §1): @orbit/shared's CLAUDE_REGION_V1. The control
// plane holds or refuses work only on a runner that declares it.
const claudeRegionCapabilityV1 = "claude-region/v1"

const (
	// claudeRegionUnsupported starts a refused turn's error (§9): @orbit/shared's CLAUDE_REGION_UNSUPPORTED.
	claudeRegionUnsupported = "CLAUDE_REGION_UNSUPPORTED"
	// claudeRegionRefusedSubtype marks the report of a turn refused for the region (§10), which a control plane
	// that knows it puts back in the queue rather than fails: CLAUDE_REGION_REFUSED_SUBTYPE.
	claudeRegionRefusedSubtype = "region_refused"
)

// The route's verdicts (@orbit/shared ClaudeRegionVerdict).
const (
	claudeRegionAllowed = "allowed"
	claudeRegionBlocked = "blocked"
	claudeRegionUnknown = "unknown"
)

// claudeRegionFreshFor is how old an answer a turn may go on; an older one is asked again first.
const claudeRegionFreshFor = 60 * time.Second

// claudeRegionCheckBudget bounds one check, the connection through the proxy included (§3). A check that runs
// out is unknown. A variable only so that tests can shorten it.
var claudeRegionCheckBudget = 3 * time.Second

// claudeRegion is this runner's check (runLoop). Nil in a process that runs none — a CLI verb, `orbit mcp`, a
// test that installs none — and then nothing is gated.
var claudeRegion atomic.Pointer[claudeRegionCheck]

// claudeRegionVerdict is what one check found (ClaudeRegionCheckResponse), and when.
type claudeRegionVerdict struct {
	Verdict    string
	Country    string
	RegionCode string
	// Name is what Orbit calls the place: {region} in the refusal.
	Name     string
	ViaProxy bool
	// At is when the answer came, which for a decided verdict is its decidedAt.
	At time.Time
}

// claudeRegionCheck asks the control plane where Claude's connection comes out, and keeps the answers by the
// proxy they went through ("" for none): a proxy changed in the environment or in settings.json is another
// connection, which an answer about the old one does not describe.
type claudeRegionCheck struct {
	t *Transport
	// machine is the runner's name: {machine} in the refusal.
	machine string
	now     func() time.Time
	// One check at a time. A turn that finds one in flight waits for its answer rather than asking again.
	checking sync.Mutex

	mu sync.Mutex
	// latest is the newest answer through each proxy, unknown included: what a turn goes on while it is fresh.
	latest map[string]claudeRegionVerdict
	// decided is the last decided (allowed or blocked) answer through each proxy, with its decidedAt.
	decided map[string]claudeRegionVerdict
	// asked is the owner's last Check again this runner took up (its requestedAt).
	asked string
}

func newClaudeRegionCheck(t *Transport, machine string) *claudeRegionCheck {
	return &claudeRegionCheck{
		t: t, machine: machine, now: time.Now,
		latest: map[string]claudeRegionVerdict{}, decided: map[string]claudeRegionVerdict{},
	}
}

// check asks now, through the proxy `claude` would use, and records the answer: the check at the runner's
// start, on the engine-health clock and on the owner's Check again.
func (c *claudeRegionCheck) check(ctx context.Context) claudeRegionVerdict {
	c.checking.Lock()
	defer c.checking.Unlock()
	return c.checkLocked(ctx, claudeAnthropicProxy())
}

// forTurn is the answer a turn goes on: the newest through the proxy `claude` would use while it is under
// claudeRegionFreshFor old, else one asked for now.
func (c *claudeRegionCheck) forTurn(ctx context.Context) claudeRegionVerdict {
	proxy := claudeAnthropicProxy()
	if v, ok := c.fresh(proxy); ok {
		return v
	}
	c.checking.Lock()
	defer c.checking.Unlock()
	// A check that ended while this one waited for the lock is as fresh as one made now.
	if v, ok := c.fresh(proxy); ok {
		return v
	}
	return c.checkLocked(ctx, proxy)
}

func (c *claudeRegionCheck) fresh(proxy string) (claudeRegionVerdict, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	v, ok := c.latest[proxy]
	return v, ok && c.now().Sub(v.At) < claudeRegionFreshFor
}

// lastDecided is the last decided answer through proxy, if any check through it has decided.
func (c *claudeRegionCheck) lastDecided(proxy string) (claudeRegionVerdict, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	v, ok := c.decided[proxy]
	return v, ok
}

// takeCheckAgain reports whether requestedAt is an owner's Check again this runner has not taken up yet, and
// takes it up (contract §7). The control plane repeats the request on every heartbeat until it records a check
// made at or after it, and a check that cannot decide records nothing while no verdict is stored, so it is
// answered once per request rather than once per heartbeat.
func (c *claudeRegionCheck) takeCheckAgain(requestedAt string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if requestedAt == "" || requestedAt == c.asked {
		return false
	}
	c.asked = requestedAt
	return true
}

func (c *claudeRegionCheck) checkLocked(ctx context.Context, proxy string) claudeRegionVerdict {
	v, err := c.ask(ctx, proxy)
	v.At = c.now()
	c.mu.Lock()
	previous, seen := c.latest[proxy]
	c.latest[proxy] = v
	if v.Verdict != claudeRegionUnknown {
		c.decided[proxy] = v
	}
	c.mu.Unlock()
	// Said when it changes, not every five minutes: the log is where an operator reads why turns stopped.
	if !seen || previous.Verdict != v.Verdict || previous.Name != v.Name {
		how := "directly"
		if proxy != "" {
			how = "through a proxy"
		}
		line := "Claude region (" + how + "): " + v.Verdict
		if v.Name != "" {
			line += " — " + v.Name
		}
		if err != nil {
			line += " (" + err.Error() + ")"
		}
		logln(line)
	}
	return v
}

// ask makes the one request of a check (contract §3): GET /runner/region-check with the runner token, over
// HTTPS and never the runner link, through proxy or directly when there is none. The transport is built with
// the proxy named outright because `orbit register --proxy` puts the Orbit host in NO_PROXY, which would send
// this request around the proxy that Claude's own requests go through. A 404 (a control plane without the
// route) and every failure are unknown.
func (c *claudeRegionCheck) ask(ctx context.Context, proxy string) (claudeRegionVerdict, error) {
	unknown := claudeRegionVerdict{Verdict: claudeRegionUnknown, ViaProxy: proxy != ""}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.DisableKeepAlives = true // one request per check; nothing to keep a connection for
	viaProxy := "0"
	if proxy != "" {
		u, err := url.Parse(proxy)
		if err != nil {
			return unknown, err
		}
		transport.Proxy = http.ProxyURL(u)
		viaProxy = "1"
	}
	var answer struct {
		Verdict    string `json:"verdict"`
		Country    string `json:"country"`
		RegionCode string `json:"regionCode"`
		Name       string `json:"name"`
	}
	err := c.t.doHTTP(ctx, &http.Client{Transport: transport}, http.MethodGet, "/runner/region-check?viaProxy="+viaProxy,
		nil, &answer, claudeRegionCheckBudget, nil)
	if err != nil {
		return unknown, err
	}
	if answer.Verdict != claudeRegionAllowed && answer.Verdict != claudeRegionBlocked {
		return unknown, nil
	}
	return claudeRegionVerdict{Verdict: answer.Verdict, Country: answer.Country, RegionCode: answer.RegionCode,
		Name: answer.Name, ViaProxy: proxy != ""}, nil
}

// claudeProxyVars are the variables `claude` takes the proxy for an https URL from, in the order the runner
// reads them everywhere (doctorProxyVars): an https proxy, else the http one.
var claudeProxyVars = []string{"https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"}

// claudeAnthropicProxy is the proxy `claude` would use for https://api.anthropic.com, or "" when it would go
// directly: the first proxy variable this process's environment sets, else the first the `env` of Claude Code's
// settings.json sets, unless NO_PROXY, read the same way, exempts Anthropic's host. An address with no scheme is
// an http:// one, as Go and Node both read it.
func claudeAnthropicProxy() string {
	var settings map[string]string
	if dir, err := effectiveClaudeConfigDir(os.Environ(), ""); err == nil {
		settings = claudeSettingsEnv(dir)
	}
	lookup := func(keys ...string) string {
		for _, key := range keys {
			if v := strings.TrimSpace(os.Getenv(key)); v != "" {
				return v
			}
		}
		for _, key := range keys {
			if v := strings.TrimSpace(settings[key]); v != "" {
				return v
			}
		}
		return ""
	}
	proxy := lookup(claudeProxyVars...)
	if proxy == "" || noProxyCovers(lookup("no_proxy", "NO_PROXY"), "api.anthropic.com") {
		return ""
	}
	if !strings.Contains(proxy, "://") {
		proxy = "http://" + proxy
	}
	return proxy
}

// noProxyCovers reports whether a NO_PROXY list exempts host: `*`, the host itself, or a domain it is under
// (`anthropic.com`, `.anthropic.com`, `*.anthropic.com`), compared without case. A port on an entry is ignored.
func noProxyCovers(list, host string) bool {
	for _, entry := range strings.Split(list, ",") {
		e := strings.ToLower(strings.TrimSpace(entry))
		if e == "*" {
			return true
		}
		if h, _, err := net.SplitHostPort(e); err == nil {
			e = h
		}
		e = strings.TrimPrefix(strings.TrimPrefix(e, "*"), ".")
		if e != "" && (host == e || strings.HasSuffix(host, "."+e)) {
			return true
		}
	}
	return false
}

// claudeSettingsEnv is the `env` of the settings.json in the Claude Code config directory dir, the variables
// the CLI adds to its environment, or nil when there is none to read. A number or a boolean there is the text
// the CLI's environment ends up holding.
func claudeSettingsEnv(dir string) map[string]string {
	b, err := os.ReadFile(filepath.Join(dir, "settings.json"))
	if err != nil {
		return nil
	}
	var settings struct {
		Env map[string]interface{} `json:"env"`
	}
	if json.Unmarshal(b, &settings) != nil {
		return nil
	}
	out := make(map[string]string, len(settings.Env))
	for key, value := range settings.Env {
		switch v := value.(type) {
		case string:
			out[key] = v
		case float64:
			out[key] = strconv.FormatFloat(v, 'f', -1, 64)
		case bool:
			out[key] = strconv.FormatBool(v)
		}
	}
	return out
}

// claudeTurnIsAnthropicBound reports whether a `claude` spawned with agentEnv layered over this process's
// environment talks to Anthropic (contract §8): ANTHROPIC_BASE_URL is empty or on anthropic.com, and neither
// Bedrock nor Vertex is on. Each variable is read from the session's env, then from the `env` of the
// settings.json in the session's CLAUDE_CONFIG_DIR, then from this process's environment, and the first that
// sets it wins: the base URL as claudeTalksToMeasuredEndpoint reads it, with the settings file between the two.
func claudeTurnIsAnthropicBound(agentEnv map[string]string) bool {
	var settings map[string]string
	if dir, err := claudeSessionAccountDir(agentEnv, ""); err == nil {
		settings = claudeSettingsEnv(dir)
	}
	lookup := func(key string) string {
		if v, set := agentEnv[key]; set {
			return v
		}
		if v, set := settings[key]; set {
			return v
		}
		return os.Getenv(key)
	}
	if claudeEnvTruthy(lookup("CLAUDE_CODE_USE_BEDROCK")) || claudeEnvTruthy(lookup("CLAUDE_CODE_USE_VERTEX")) {
		return false
	}
	base := strings.TrimSpace(lookup("ANTHROPIC_BASE_URL"))
	return base == "" || isAnthropicHost(base)
}

// claudeEnvTruthy reads a Claude Code switch the way the CLI does: 1, true, yes or on, in any case.
func claudeEnvTruthy(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

// isAnthropicHost reports whether a base URL's host is anthropic.com or a name under it, compared without case
// or a trailing dot. A look-alike such as anthropic.com.example or myanthropic.com is not.
func isAnthropicHost(baseURL string) bool {
	u, err := url.Parse(baseURL)
	if err != nil {
		return false
	}
	host := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
	return host == "anthropic.com" || strings.HasSuffix(host, ".anthropic.com")
}

// claudeRegionRefusedError is a refused turn's error (§9), @orbit/shared's claudeRegionRefusedError: the code,
// then board 04's sentence. machine is the runner's name, region the decided name.
func claudeRegionRefusedError(machine, region string) string {
	return claudeRegionUnsupported + ": " + machine + "’s connection to Anthropic is in " + region +
		", where Anthropic doesn’t offer Claude."
}

// claudeRegionRefusal is what job's next turn is refused with while its connection to Anthropic is in a region
// Anthropic does not offer Claude in, and "" when it may run: an engine other than Claude (owner decision ⑥), a
// turn that does not talk to Anthropic (§8), an answer that is allowed or unknown, or a process with no check.
func claudeRegionRefusal(ctx context.Context, job *ClaimedSession) string {
	check := claudeRegion.Load()
	if check == nil || runtimeProvider(job) != providerClaude || !claudeTurnIsAnthropicBound(job.Agent.Env) {
		return ""
	}
	if v := check.forTurn(ctx); v.Verdict == claudeRegionBlocked {
		return claudeRegionRefusedError(check.machine, v.Name)
	}
	return ""
}
