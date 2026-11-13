package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"
)

// The local model server probe (docs/ollama-local-provider-contract.md §6). A runner-scoped provider is a model
// server on this runner's own machine — Ollama — that the control plane must never reach itself. Each heartbeat
// answer names the ones bound to this runner (HeartbeatResponse.LocalProviders); this file probes them in the
// background and the next heartbeat reports what it found (HeartbeatRequest.LocalProviderProbes).
//
// The probe is not a general HTTP client. It reads three fixed Ollama routes and nothing else:
//
//	GET  /api/version  readiness: cheap, every cycle, timed
//	GET  /api/tags     inventory: the models the server holds
//	POST /api/show     one model's capabilities and context, a few at a time, cached by digest
//
// and holds every request to the same limits: http or https only; an endpoint at the server root, with no
// userinfo, query or fragment; a loopback address unless this runner's own configuration allows another host
// (ORBIT_OLLAMA_ALLOWED_HOSTS), checked again at connect time against the address actually dialled; no proxy; no
// redirect; a timeout per call and per cycle; a byte cap on every body; JSON in UTF-8 only. What it reports is a
// state, the server's version, a short reason code, timings and a sanitized catalogue: never a response body, a
// prompt or a key. It installs nothing and pulls or removes no model.

const (
	localProbeCapabilityV1 = "ollama-probe/v1"

	localProbeInterval      = 60 * time.Second
	localProbeCycleTimeout  = 45 * time.Second
	localProbeVersionTimout = 3 * time.Second
	localProbeTagsTimeout   = 5 * time.Second
	localProbeShowTimeout   = 5 * time.Second

	localProbeVersionLimit = 4 << 10
	localProbeTagsLimit    = 4 << 20
	localProbeShowLimit    = 2 << 20

	localProbeMaxTargets   = 16
	localProbeMaxModels    = 200
	localProbeMaxShown     = 64
	localProbeShowParallel = 4
	localProbeTargetsAtA   = 4

	// docs/ollama-local-provider-phase0.md: Claude Code needs at least 64K tokens of context.
	localMinContextWindow = 65536

	localProbeAllowedHostsEnv = "ORBIT_OLLAMA_ALLOWED_HOSTS"
)

// The probe states (@orbit/shared LOCAL_PROBE_STATES).
const (
	localStateReady             = "READY"
	localStateUnreachable       = "UNREACHABLE"
	localStateMalformed         = "MALFORMED"
	localStateNoModels          = "NO_MODELS"
	localStateModelMissing      = "MODEL_MISSING"
	localStateCapabilityMissing = "CAPABILITY_MISSING"
	localStateRefused           = "REFUSED"
)

// LocalProviderTarget mirrors @orbit/shared LocalProviderTarget: one runner-scoped provider bound to this runner.
type LocalProviderTarget struct {
	ProviderID string   `json:"providerId"`
	BaseURL    string   `json:"baseUrl"`
	Models     []string `json:"models"`
}

// LocalInstanceModel mirrors @orbit/shared LocalInstanceModel: what may be shown of one model, and nothing more.
type LocalInstanceModel struct {
	Value         string `json:"value"`
	ContextWindow int    `json:"contextWindow,omitempty"`
	Tools         *bool  `json:"tools,omitempty"`
	ParameterSize string `json:"parameterSize,omitempty"`
	Quantization  string `json:"quantization,omitempty"`
}

// LocalProviderProbe mirrors @orbit/shared LocalProviderProbe. Models is null when the server did not answer the
// inventory (the control plane then keeps the catalogue it has) and a list, possibly empty, when it did.
type LocalProviderProbe struct {
	ProviderID string               `json:"providerId"`
	BaseURL    string               `json:"baseUrl"`
	State      string               `json:"state"`
	Version    string               `json:"version,omitempty"`
	CheckedAt  string               `json:"checkedAt"`
	LatencyMs  *int64               `json:"latencyMs,omitempty"`
	Reason     string               `json:"reason,omitempty"`
	Models     []LocalInstanceModel `json:"models"`
}

// ── Endpoint policy ─────────────────────────────────────────────────────────────────────────────────────

// localProbePolicy is which hosts besides loopback this runner's owner allowed it to probe: host names, IP
// addresses or CIDR prefixes, from ORBIT_OLLAMA_ALLOWED_HOSTS (comma- or space-separated). Empty by default:
// loopback only. It is this machine's configuration, never the control plane's: a provider row can name any
// URL, and only what is allowed here is ever dialled.
type localProbePolicy struct {
	names    map[string]bool
	prefixes []*net.IPNet
}

func localProbePolicyFromEnv() localProbePolicy {
	return parseLocalProbePolicy(os.Getenv(localProbeAllowedHostsEnv))
}

func parseLocalProbePolicy(raw string) localProbePolicy {
	p := localProbePolicy{names: map[string]bool{}}
	for _, field := range strings.FieldsFunc(raw, func(r rune) bool { return r == ',' || r == ' ' || r == '\t' || r == '\n' }) {
		field = strings.ToLower(strings.TrimSpace(field))
		if field == "" {
			continue
		}
		if _, prefix, err := net.ParseCIDR(field); err == nil {
			p.prefixes = append(p.prefixes, prefix)
			continue
		}
		if ip := net.ParseIP(strings.Trim(field, "[]")); ip != nil {
			bits := 128
			if ip.To4() != nil {
				ip, bits = ip.To4(), 32
			}
			p.prefixes = append(p.prefixes, &net.IPNet{IP: ip, Mask: net.CIDRMask(bits, bits)})
			continue
		}
		p.names[strings.TrimSuffix(field, ".")] = true
	}
	return p
}

func (p localProbePolicy) allowsIP(ip net.IP) bool {
	if ip == nil {
		return false
	}
	if ip.IsLoopback() {
		return true
	}
	for _, prefix := range p.prefixes {
		if prefix.Contains(ip) {
			return true
		}
	}
	return false
}

// localEndpoint is a target's endpoint after the policy: the origin requests go to, and whether any address its
// host resolves to may be dialled (a host name the owner listed) or only allowed ones.
type localEndpoint struct {
	origin  string
	anyAddr bool
}

// errLocalRefused is a target the policy will not probe, or an address it will not dial.
type errLocalRefused struct{ reason string }

func (e *errLocalRefused) Error() string { return "refused: " + e.reason }

// parseLocalEndpoint holds a provider's base URL to the probe's rules: http or https, a host, no userinfo, no
// query or fragment, nothing but "/" for a path (Ollama serves at the root; a trailing slash is fine), and a host
// that is loopback or allowed by the policy.
func parseLocalEndpoint(raw string, policy localProbePolicy) (localEndpoint, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" || u.Opaque != "" {
		return localEndpoint{}, &errLocalRefused{"bad_url"}
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return localEndpoint{}, &errLocalRefused{"scheme"}
	}
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.ForceQuery {
		return localEndpoint{}, &errLocalRefused{"bad_url"}
	}
	if strings.Trim(u.Path, "/") != "" {
		return localEndpoint{}, &errLocalRefused{"path"}
	}
	host := strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))
	port := u.Port()
	if port != "" {
		if n, err := strconv.Atoi(port); err != nil || n < 1 || n > 65535 {
			return localEndpoint{}, &errLocalRefused{"bad_url"}
		}
	}
	ep := localEndpoint{}
	if ip := net.ParseIP(host); ip != nil {
		if !policy.allowsIP(ip) {
			return localEndpoint{}, &errLocalRefused{"not_loopback"}
		}
	} else if policy.names[host] {
		ep.anyAddr = true
	} else if host != "localhost" && !strings.HasSuffix(host, ".localhost") {
		// "localhost" is a name, so every address it resolves to is still held to loopback when dialled.
		return localEndpoint{}, &errLocalRefused{"not_loopback"}
	}
	ep.origin = scheme + "://" + u.Host
	return ep, nil
}

// localProbeClient is the one HTTP client a target is probed with: no proxy, no redirect, no transparent
// decompression, small header and idle limits, and a dialler that checks the address it actually connects to.
func localProbeClient(ep localEndpoint, policy localProbePolicy) *http.Client {
	dialer := &net.Dialer{
		Timeout: localProbeVersionTimout,
		Control: func(network, address string, _ syscall.RawConn) error {
			if ep.anyAddr {
				return nil
			}
			host, _, err := net.SplitHostPort(address)
			if err != nil {
				return &errLocalRefused{"not_loopback"}
			}
			if !policy.allowsIP(net.ParseIP(host)) {
				return &errLocalRefused{"not_loopback"}
			}
			return nil
		},
	}
	return &http.Client{
		Transport: &http.Transport{
			Proxy:                  nil,
			DialContext:            dialer.DialContext,
			TLSHandshakeTimeout:    localProbeVersionTimout,
			ResponseHeaderTimeout:  localProbeShowTimeout,
			MaxResponseHeaderBytes: 16 << 10,
			DisableCompression:     true,
			MaxIdleConns:           localProbeShowParallel,
			MaxIdleConnsPerHost:    localProbeShowParallel,
			IdleConnTimeout:        30 * time.Second,
		},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

// ── Calls ───────────────────────────────────────────────────────────────────────────────────────────────

// localCallError is why a call failed: the state it puts the target in and a short reason code.
type localCallError struct {
	state  string
	reason string
	status int
}

func (e *localCallError) Error() string { return e.state + ": " + e.reason }

func classifyLocalTransportError(err error) *localCallError {
	var refused *errLocalRefused
	if errors.As(err, &refused) {
		return &localCallError{state: localStateRefused, reason: refused.reason}
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return &localCallError{state: localStateUnreachable, reason: "timeout"}
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return &localCallError{state: localStateUnreachable, reason: "timeout"}
	}
	if errors.Is(err, syscall.ECONNREFUSED) {
		return &localCallError{state: localStateUnreachable, reason: "connection_refused"}
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return &localCallError{state: localStateUnreachable, reason: "dns"}
	}
	return &localCallError{state: localStateUnreachable, reason: "connect_failed"}
}

// localCall makes one request to one of the fixed routes and decodes its JSON answer into out, within limit bytes.
func localCall(ctx context.Context, client *http.Client, origin, method, path string, body any, limit int64, timeout time.Duration, out any) *localCallError {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return &localCallError{state: localStateMalformed, reason: "request"}
		}
		reader = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, origin+path, reader)
	if err != nil {
		return &localCallError{state: localStateRefused, reason: "bad_url"}
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Accept-Encoding", "identity")
	req.Header.Set("User-Agent", "orbit-runner-probe")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := client.Do(req)
	if err != nil {
		return classifyLocalTransportError(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		return &localCallError{state: localStateMalformed, reason: "redirect", status: resp.StatusCode}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &localCallError{state: localStateUnreachable, reason: "http_" + strconv.Itoa(resp.StatusCode), status: resp.StatusCode}
	}
	if enc := resp.Header.Get("Content-Encoding"); enc != "" && !strings.EqualFold(enc, "identity") {
		return &localCallError{state: localStateMalformed, reason: "encoding"}
	}
	mediaType, params, err := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return &localCallError{state: localStateMalformed, reason: "content_type"}
	}
	if cs, ok := params["charset"]; ok && !strings.EqualFold(cs, "utf-8") && !strings.EqualFold(cs, "utf8") {
		return &localCallError{state: localStateMalformed, reason: "charset"}
	}
	if resp.ContentLength > limit {
		return &localCallError{state: localStateMalformed, reason: "too_large"}
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return classifyLocalTransportError(err)
	}
	if int64(len(data)) > limit {
		return &localCallError{state: localStateMalformed, reason: "too_large"}
	}
	if !utf8.Valid(data) {
		return &localCallError{state: localStateMalformed, reason: "charset"}
	}
	if err := json.Unmarshal(data, out); err != nil {
		return &localCallError{state: localStateMalformed, reason: "bad_json"}
	}
	return nil
}

// ── The probe of one target ─────────────────────────────────────────────────────────────────────────────

var (
	localModelNameRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$`)
	localShortTextRE = regexp.MustCompile(`^[\x20-\x7e]{1,64}$`)
)

// localShortText is a field fit to show: printable ASCII, at most 64 bytes; anything else is dropped.
func localShortText(value string) string {
	value = strings.TrimSpace(value)
	if len(value) > 64 || !localShortTextRE.MatchString(value) {
		return ""
	}
	return value
}

// localDigestRE is a model digest as Ollama spells it: "sha256:" and exactly 64 hex digits. Only such a digest keys
// the /api/show cache: anything else (a placeholder such as "unknown", a truncated digest, another algorithm) says
// nothing about whether the model changed, so that model is shown again every cycle. It is never reported.
var localDigestRE = regexp.MustCompile(`^sha256:[0-9A-Fa-f]{64}$`)

func localDigest(value string) string {
	value = strings.TrimSpace(value)
	if !localDigestRE.MatchString(value) {
		return ""
	}
	return value
}

func isLocalCloudModel(name string) bool {
	name = strings.ToLower(strings.TrimSpace(name))
	return strings.HasSuffix(name, "-cloud") || strings.HasSuffix(name, ":cloud")
}

// canonicalLocalModel is how Ollama resolves a name: "llama3" is "llama3:latest".
func canonicalLocalModel(name string) string {
	name = strings.TrimSpace(name)
	base := name
	if i := strings.LastIndex(name, "/"); i >= 0 {
		base = name[i+1:]
	}
	if !strings.Contains(base, ":") {
		return name + ":latest"
	}
	return name
}

type ollamaTagsAnswer struct {
	Models []struct {
		Name       string `json:"name"`
		Model      string `json:"model"`
		Digest     string `json:"digest"`
		RemoteHost string `json:"remote_host"`
		Details    struct {
			ParameterSize     string `json:"parameter_size"`
			QuantizationLevel string `json:"quantization_level"`
		} `json:"details"`
	} `json:"models"`
}

type ollamaShowAnswer struct {
	Capabilities []string                   `json:"capabilities"`
	ModelInfo    map[string]json.RawMessage `json:"model_info"`
}

// localShowFacts is what /api/show taught about one model: all the probe keeps of an answer that also holds the
// model's template, licence and parameters.
type localShowFacts struct {
	known         bool
	missing       bool
	tools         bool
	contextWindow int
}

func showFactsOf(answer ollamaShowAnswer) localShowFacts {
	facts := localShowFacts{known: true}
	for _, c := range answer.Capabilities {
		if strings.EqualFold(strings.TrimSpace(c), "tools") {
			facts.tools = true
		}
	}
	for key, raw := range answer.ModelInfo {
		if !strings.HasSuffix(key, ".context_length") {
			continue
		}
		var n json.Number
		if json.Unmarshal(raw, &n) != nil {
			continue
		}
		if v, err := strconv.ParseInt(n.String(), 10, 64); err == nil && v > 0 && v <= 100_000_000 && int(v) > facts.contextWindow {
			facts.contextWindow = int(v)
		}
	}
	return facts
}

// localShowCache keeps /api/show facts by endpoint, model and digest, so a model is shown again only once it changed.
type localShowCache struct {
	mu      sync.Mutex
	entries map[string]localShowFacts
}

func newLocalShowCache() *localShowCache {
	return &localShowCache{entries: map[string]localShowFacts{}}
}

func (c *localShowCache) get(key string) (localShowFacts, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	f, ok := c.entries[key]
	return f, ok
}

func (c *localShowCache) put(key string, f localShowFacts) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[key] = f
}

// keep drops every entry whose key is not in live.
func (c *localShowCache) keep(live map[string]bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for key := range c.entries {
		if !live[key] {
			delete(c.entries, key)
		}
	}
}

// localProber holds what a probe needs besides its target, so tests can tighten it.
type localProber struct {
	policy      localProbePolicy
	cache       *localShowCache
	now         func() time.Time
	showTimeout time.Duration
}

func newLocalProber(policy localProbePolicy) *localProber {
	return &localProber{policy: policy, cache: newLocalShowCache(), now: time.Now, showTimeout: localProbeShowTimeout}
}

// probe runs one probe of one target. It always answers, whatever the target does: a failure is a state.
func (p *localProber) probe(ctx context.Context, target LocalProviderTarget, live map[string]bool) LocalProviderProbe {
	out := LocalProviderProbe{ProviderID: target.ProviderID, BaseURL: target.BaseURL, CheckedAt: p.now().UTC().Format(time.RFC3339Nano)}
	ep, err := parseLocalEndpoint(target.BaseURL, p.policy)
	if err != nil {
		out.State, out.Reason = localStateRefused, err.(*errLocalRefused).reason
		return out
	}
	client := localProbeClient(ep, p.policy)
	defer client.CloseIdleConnections()

	var version struct {
		Version string `json:"version"`
	}
	started := time.Now()
	if failed := localCall(ctx, client, ep.origin, http.MethodGet, "/api/version", nil, localProbeVersionLimit, localProbeVersionTimout, &version); failed != nil {
		out.State, out.Reason = failed.state, failed.reason
		return out
	}
	latency := time.Since(started).Milliseconds()
	out.LatencyMs = &latency
	out.Version = localShortText(version.Version)
	if out.Version == "" {
		out.State, out.Reason = localStateMalformed, "no_version"
		return out
	}

	var tags ollamaTagsAnswer
	if failed := localCall(ctx, client, ep.origin, http.MethodGet, "/api/tags", nil, localProbeTagsLimit, localProbeTagsTimeout, &tags); failed != nil {
		out.State, out.Reason = failed.state, failed.reason
		return out
	}

	type held struct {
		model  LocalInstanceModel
		digest string
	}
	byName := map[string]*held{}
	order := []string{}
	for _, m := range tags.Models {
		if len(order) >= localProbeMaxModels {
			break
		}
		name := strings.TrimSpace(m.Name)
		if name == "" {
			name = strings.TrimSpace(m.Model)
		}
		if !localModelNameRE.MatchString(name) || isLocalCloudModel(name) || strings.TrimSpace(m.RemoteHost) != "" {
			continue
		}
		if _, dup := byName[name]; dup {
			continue
		}
		byName[name] = &held{
			model: LocalInstanceModel{
				Value:         name,
				ParameterSize: localShortText(m.Details.ParameterSize),
				Quantization:  localShortText(m.Details.QuantizationLevel),
			},
			digest: localDigest(m.Digest),
		}
		order = append(order, name)
	}
	out.Models = []LocalInstanceModel{}
	if len(order) == 0 {
		out.State, out.Reason = localStateNoModels, "no_models"
		return out
	}

	// The models the row names are shown first, so a cap on how many are shown never hides the ones that decide
	// the state; the rest of the catalogue is shown as far as the cap goes.
	required := make([]string, 0, len(target.Models))
	seenReq := map[string]bool{}
	for _, m := range target.Models {
		if m = strings.TrimSpace(m); m == "" || seenReq[canonicalLocalModel(m)] {
			continue
		}
		seenReq[canonicalLocalModel(m)] = true
		required = append(required, m)
	}
	resolve := func(name string) string {
		if _, ok := byName[name]; ok {
			return name
		}
		if c := canonicalLocalModel(name); byName[c] != nil {
			return c
		}
		return ""
	}
	toShow := []string{}
	queued := map[string]bool{}
	for _, m := range required {
		if name := resolve(m); name != "" && !queued[name] {
			queued[name] = true
			toShow = append(toShow, name)
		}
	}
	for _, name := range order {
		if len(toShow) >= localProbeMaxShown {
			break
		}
		if !queued[name] {
			queued[name] = true
			toShow = append(toShow, name)
		}
	}

	// Cached facts are read first, on this goroutine, before any /api/show call starts: from then on facts is
	// written only by those calls, under factsMu, and read here only after they have all returned.
	facts := make(map[string]localShowFacts, len(toShow))
	type showJob struct{ name, key string }
	var misses []showJob
	for _, name := range toShow {
		digest := byName[name].digest
		key := ep.origin + "\x00" + name + "\x00" + digest
		if live != nil {
			live[key] = true
		}
		if digest != "" {
			if f, ok := p.cache.get(key); ok {
				facts[name] = f
				continue
			}
		}
		misses = append(misses, showJob{name: name, key: key})
	}
	var factsMu sync.Mutex
	sem := make(chan struct{}, localProbeShowParallel)
	var wg sync.WaitGroup
	for _, job := range misses {
		wg.Add(1)
		go func(name, key string, cacheable bool) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				return
			}
			defer func() { <-sem }()
			var answer ollamaShowAnswer
			f := localShowFacts{}
			if failed := localCall(ctx, client, ep.origin, http.MethodPost, "/api/show", map[string]string{"model": name}, localProbeShowLimit, p.showTimeout, &answer); failed == nil {
				f = showFactsOf(answer)
				if cacheable {
					p.cache.put(key, f)
				}
			} else if failed.status == http.StatusNotFound {
				// Listed a moment ago and gone now: removed between the two calls.
				f.missing = true
			}
			factsMu.Lock()
			facts[name] = f
			factsMu.Unlock()
		}(job.name, job.key, byName[job.name].digest != "")
	}
	wg.Wait()

	for _, name := range order {
		f := facts[name]
		if f.missing {
			continue
		}
		model := byName[name].model
		if f.known {
			tools := f.tools
			model.Tools = &tools
			model.ContextWindow = f.contextWindow
		}
		out.Models = append(out.Models, model)
	}
	if len(out.Models) == 0 {
		out.State, out.Reason = localStateNoModels, "no_models"
		return out
	}

	out.State = localStateReady
	for _, m := range required {
		name := resolve(m)
		if name == "" || facts[name].missing {
			out.State, out.Reason = localStateModelMissing, "missing:"+m
			break
		}
		f := facts[name]
		switch {
		case !f.known:
			out.State, out.Reason = localStateCapabilityMissing, "capabilities_unknown:"+m
		case !f.tools:
			out.State, out.Reason = localStateCapabilityMissing, "no_tools:"+m
		case f.contextWindow == 0:
			out.State, out.Reason = localStateCapabilityMissing, "context_unknown:"+m
		case f.contextWindow < localMinContextWindow:
			out.State, out.Reason = localStateCapabilityMissing, fmt.Sprintf("context:%s:%d", m, f.contextWindow)
		default:
			continue
		}
		break
	}
	if len(out.Reason) > 240 {
		out.Reason = out.Reason[:240]
	}
	return out
}

// probeAll probes every target, a few at a time, and forgets cached facts of models no target holds any more.
func (p *localProber) probeAll(ctx context.Context, targets []LocalProviderTarget) []LocalProviderProbe {
	out := make([]LocalProviderProbe, len(targets))
	live := make([]map[string]bool, len(targets))
	sem := make(chan struct{}, localProbeTargetsAtA)
	var wg sync.WaitGroup
	for i, target := range targets {
		live[i] = map[string]bool{}
		wg.Add(1)
		go func(i int, target LocalProviderTarget) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			out[i] = p.probe(ctx, target, live[i])
		}(i, target)
	}
	wg.Wait()
	all := map[string]bool{}
	for _, keys := range live {
		for key := range keys {
			all[key] = true
		}
	}
	p.cache.keep(all)
	return out
}

// ── The background loop ─────────────────────────────────────────────────────────────────────────────────

// localProviderProbe runs the probe on its own goroutine, every localProbeInterval and at once when the target
// set changes, and keeps the last completed cycle for the heartbeat to read. Like the directory probe, the
// heartbeat never waits on it.
type localProviderProbe struct {
	prober   *localProber
	interval time.Duration
	wake     chan struct{}
	done     chan struct{}

	mu      sync.Mutex
	targets []LocalProviderTarget
	given   bool
	state   []LocalProviderProbe
	probed  bool
}

func newLocalProviderProbe(prober *localProber, interval time.Duration) *localProviderProbe {
	if interval <= 0 {
		interval = localProbeInterval
	}
	return &localProviderProbe{prober: prober, interval: interval, wake: make(chan struct{}, 1), done: make(chan struct{})}
}

func localTargetsKey(targets []LocalProviderTarget) string {
	parts := make([]string, 0, len(targets))
	for _, t := range targets {
		models := append([]string(nil), t.Models...)
		sort.Strings(models)
		parts = append(parts, t.ProviderID+"\x00"+t.BaseURL+"\x00"+strings.Join(models, "\x01"))
	}
	sort.Strings(parts)
	return strings.Join(parts, "\x02")
}

// trigger takes the target set a heartbeat answer named. A changed set is probed at once; the same set waits for
// the next tick.
func (l *localProviderProbe) trigger(targets []LocalProviderTarget) {
	if len(targets) > localProbeMaxTargets {
		targets = targets[:localProbeMaxTargets]
	}
	l.mu.Lock()
	changed := !l.given || localTargetsKey(l.targets) != localTargetsKey(targets)
	l.targets = append(l.targets[:0:0], targets...)
	l.given = true
	l.mu.Unlock()
	if changed {
		select {
		case l.wake <- struct{}{}:
		default:
		}
	}
}

func (l *localProviderProbe) run(ctx context.Context) {
	defer close(l.done)
	ticker := time.NewTicker(l.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-l.wake:
		}
		l.mu.Lock()
		given := l.given
		targets := append([]LocalProviderTarget(nil), l.targets...)
		l.mu.Unlock()
		if !given {
			continue
		}
		cycleCtx, cancel := context.WithTimeout(ctx, localProbeCycleTimeout)
		state := l.prober.probeAll(cycleCtx, targets)
		cancel()
		if ctx.Err() != nil {
			return
		}
		l.mu.Lock()
		l.state = state
		l.probed = true
		l.mu.Unlock()
	}
}

func (l *localProviderProbe) wait() { <-l.done }

// snapshot is the last completed cycle, limited to the targets the last answer named: nil before the first one
// (the field is then left out, and the control plane keeps what it has).
func (l *localProviderProbe) snapshot() []LocalProviderProbe {
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.probed {
		return nil
	}
	current := map[string]bool{}
	for _, t := range l.targets {
		current[t.ProviderID+"\x00"+t.BaseURL] = true
	}
	out := make([]LocalProviderProbe, 0, len(l.state))
	for _, s := range l.state {
		if current[s.ProviderID+"\x00"+s.BaseURL] {
			out = append(out, s)
		}
	}
	return out
}
