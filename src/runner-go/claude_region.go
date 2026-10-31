package main

// The Claude region check (docs/claude-region-check-contract.md).
//
// Anthropic offers Claude only in the regions its Supported Regions Policy lists, and what counts here is
// where Claude's own connection to Anthropic comes out (owner decision ②): through the proxy `claude` would
// use for https://api.anthropic.com, or from this machine when there is none. The control plane reads the
// place off Cloudflare's headers on one request that leaves the same way (GET /runner/region-check, §3) and
// answers allowed, blocked or unknown; the runner carries no list of its own. While the answer is blocked, a
// Claude turn that would talk to Anthropic (§8) is not started, and a message is not delivered to a running
// engine (§10). An answer that cannot decide keeps the last decided verdict for 24 hours (owner decision ③), and
// a flip to blocked that a second check a minute later confirms stops the turns already running (④).

import (
	"context"
	"encoding/json"
	"fmt"
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
	// claudeRegionStoppedSubtype marks the report of a running turn a confirmed flip stopped (§10), which a control
	// plane that knows it answers without failing the session or replaying the turn: CLAUDE_REGION_STOPPED_SUBTYPE.
	claudeRegionStoppedSubtype = "region_stopped"
)

// The route's verdicts (@orbit/shared ClaudeRegionVerdict).
const (
	claudeRegionAllowed = "allowed"
	claudeRegionBlocked = "blocked"
	claudeRegionUnknown = "unknown"
)

// claudeRegionFreshFor is how old an answer a turn may go on; an older one is asked again first.
const claudeRegionFreshFor = 60 * time.Second

// claudeRegionCarryOver is how long a decided verdict outlives the answers after it that could not decide (owner
// decision ③, contract §5): @orbit/shared's CLAUDE_REGION_CARRY_OVER_MS.
const claudeRegionCarryOver = 24 * time.Hour

// claudeRegionRecheckAfter is how long after a flip to blocked the check is made again (owner decision ④): a blocked
// answer at least this long after the flip's first one confirms it.
const claudeRegionRecheckAfter = 60 * time.Second

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
	// clock tells the time and runs the recheck after a flip; a fake one in tests.
	clock poolClock
	// lifetime is what the recheck after a flip asks under: runLoop's loop context. Nil outside a runner's loop
	// (orbit doctor, a test that needs none), where no turn runs for a confirmed flip to stop, and nothing is
	// rechecked.
	lifetime context.Context
	// One check at a time. A turn that finds one in flight waits for its answer rather than asking again.
	checking sync.Mutex

	mu sync.Mutex
	// latest is the newest answer through each proxy, unknown included: what a turn goes on while it is fresh.
	latest map[string]claudeRegionVerdict
	// decided is the last decided (allowed or blocked) answer through each proxy, with its decidedAt.
	decided map[string]claudeRegionVerdict
	// flips is the flip to blocked through each proxy that no allowed answer has ended yet (noteFlipLocked).
	flips map[string]*claudeRegionFlip
	// engines is every Claude engine running now whose turns talk to Anthropic (register): what a confirmed
	// flip stops.
	engines map[*claudeRegionEngine]struct{}
	// asked is the owner's last Check again this runner took up (its requestedAt).
	asked string
}

// claudeRegionFlip is a flip to blocked through one proxy (owner decision ④): when its first blocked answer came,
// the recheck a minute after it, and whether a second blocked answer has confirmed it.
type claudeRegionFlip struct {
	at        time.Time
	recheck   poolTimer
	confirmed bool
}

// claudeRegionEngine is one running Claude engine whose turns talk to Anthropic, as runClaudeSessionProcess
// registers it: stop asks it to stop the turn it is running, with the stopped sentence. It must not block.
type claudeRegionEngine struct {
	stop func(sentence string)
}

func newClaudeRegionCheck(t *Transport, machine string) *claudeRegionCheck {
	return &claudeRegionCheck{
		t: t, machine: machine, clock: realPoolClock{},
		latest: map[string]claudeRegionVerdict{}, decided: map[string]claudeRegionVerdict{},
		flips: map[string]*claudeRegionFlip{}, engines: map[*claudeRegionEngine]struct{}{},
	}
}

// check asks now, through the proxy `claude` would use, and records the answer: the check at the runner's
// start, on the engine-health clock and on the owner's Check again.
func (c *claudeRegionCheck) check(ctx context.Context) claudeRegionVerdict {
	c.checking.Lock()
	defer c.checking.Unlock()
	return c.checkLocked(ctx, claudeAnthropicProxy())
}

// forTurn is the answer a turn goes on, and every other request the runner would make of Anthropic: the newest
// through the proxy `claude` would use while it is under claudeRegionFreshFor old, else one asked for now, read
// with the carry-over (carriedOver).
func (c *claudeRegionCheck) forTurn(ctx context.Context) claudeRegionVerdict {
	proxy := claudeAnthropicProxy()
	if v, ok := c.fresh(proxy); ok {
		return c.carriedOver(proxy, v)
	}
	c.checking.Lock()
	defer c.checking.Unlock()
	// A check that ended while this one waited for the lock is as fresh as one made now.
	if v, ok := c.fresh(proxy); ok {
		return c.carriedOver(proxy, v)
	}
	return c.carriedOver(proxy, c.checkLocked(ctx, proxy))
}

// carriedOver is what an answer through proxy means (owner decision ③, contract §5): a decided one is itself, and
// an unknown one is the last decided verdict through proxy while that is blocked and under claudeRegionCarryOver
// old, so a check that cannot decide never lets through what a decided one holds back. Otherwise it stays unknown,
// which is allowed.
func (c *claudeRegionCheck) carriedOver(proxy string, v claudeRegionVerdict) claudeRegionVerdict {
	if v.Verdict != claudeRegionUnknown {
		return v
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if last, ok := c.decided[proxy]; ok && claudeRegionHolds(last, c.clock.Now()) {
		return last
	}
	return v
}

// claudeRegionHolds reports whether decided answer v still holds turns back at now: blocked, and decided under
// claudeRegionCarryOver ago (@orbit/shared's effectiveRegionVerdict).
func claudeRegionHolds(v claudeRegionVerdict, now time.Time) bool {
	return v.Verdict == claudeRegionBlocked && now.Sub(v.At) < claudeRegionCarryOver
}

func (c *claudeRegionCheck) fresh(proxy string) (claudeRegionVerdict, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	v, ok := c.latest[proxy]
	return v, ok && c.clock.Now().Sub(v.At) < claudeRegionFreshFor
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
	v.At = c.clock.Now()
	c.mu.Lock()
	previous, seen := c.latest[proxy]
	stopping, confirmed := c.noteFlipLocked(proxy, v)
	c.latest[proxy] = v
	if v.Verdict != claudeRegionUnknown {
		c.decided[proxy] = v
	}
	var stops []func(string)
	if stopping {
		for e := range c.engines {
			stops = append(stops, e.stop)
		}
	}
	c.mu.Unlock()
	how := "directly"
	if proxy != "" {
		how = "through a proxy"
	}
	// Said when it changes, not every five minutes: the log is where an operator reads why turns stopped.
	if !seen || previous.Verdict != v.Verdict || previous.Name != v.Name {
		line := "Claude region (" + how + "): " + v.Verdict
		if v.Name != "" {
			line += " — " + v.Name
		}
		if err != nil {
			line += " (" + err.Error() + ")"
		}
		logln(line)
	}
	if confirmed {
		logln(fmt.Sprintf("Claude region (%s): still blocked a minute on — stopping the running Anthropic-bound Claude turns of %d engine(s)",
			how, len(stops)))
	}
	if stopping {
		sentence := claudeRegionStoppedError(c.machine, v.Name)
		for _, stop := range stops {
			stop(sentence)
		}
	}
	return v
}

// noteFlipLocked keeps the flip through proxy up to date with answer v, and reports whether v stops the running
// turns, and whether v is the answer that confirms the flip (owner decision ④, contract §10). A blocked answer while
// turns through proxy run — the last decided verdict allowed, none decided yet, or a blocked one past its
// carry-over — starts a flip, and the check is made again claudeRegionRecheckAfter later. A blocked answer at least
// that long after the flip's first confirms it, and it and every blocked answer after it stop what is running then:
// a turn an engine starts on its own after the confirmation is stopped by the next one. An allowed answer ends the
// flip. An unknown one leaves it standing, as it leaves the verdict: the next decided answer, the recheck's or a
// later one, settles it.
func (c *claudeRegionCheck) noteFlipLocked(proxy string, v claudeRegionVerdict) (stopping, confirmed bool) {
	flip := c.flips[proxy]
	switch v.Verdict {
	case claudeRegionAllowed:
		if flip != nil {
			if flip.recheck != nil {
				flip.recheck.Stop()
			}
			delete(c.flips, proxy)
		}
	case claudeRegionBlocked:
		if last, ok := c.decided[proxy]; flip == nil || !ok || !claudeRegionHolds(last, v.At) {
			if flip != nil && flip.recheck != nil {
				flip.recheck.Stop()
			}
			flip = &claudeRegionFlip{at: v.At}
			if c.lifetime != nil {
				flip.recheck = c.clock.AfterFunc(claudeRegionRecheckAfter, func() { c.check(c.lifetime) })
			}
			c.flips[proxy] = flip
			return false, false
		}
		if v.At.Sub(flip.at) >= claudeRegionRecheckAfter {
			confirmed = !flip.confirmed
			flip.confirmed = true
			return true, confirmed
		}
	}
	return false, false
}

// register adds a running Claude engine whose turns talk to Anthropic to what a confirmed flip stops, until the
// func it returns is called. stop must not block: it is called with the check's answer just in.
func (c *claudeRegionCheck) register(stop func(sentence string)) func() {
	e := &claudeRegionEngine{stop: stop}
	c.mu.Lock()
	c.engines[e] = struct{}{}
	c.mu.Unlock()
	return func() {
		c.mu.Lock()
		delete(c.engines, e)
		c.mu.Unlock()
	}
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

// claudeRegionStoppedError is the error of a running turn a confirmed flip stopped (§10), @orbit/shared's
// claudeRegionStoppedError: the code, then board 04's "stopped" sentence. machine is the runner's name, region the
// decided name.
func claudeRegionStoppedError(machine, region string) string {
	return claudeRegionUnsupported + ": Claude Code stopped on " + machine + ": its connection to Anthropic is now in " +
		region + ", where Anthropic doesn’t offer Claude."
}

// claudeRegionRefusal is what job's next turn is refused with while its connection to Anthropic is in a region
// Anthropic does not offer Claude in, and "" when it may run: an engine other than Claude (owner decision ⑥), a
// turn that does not talk to Anthropic (§8), an answer that is allowed or unknown with no blocked verdict to carry
// over (forTurn), or a process with no check.
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
