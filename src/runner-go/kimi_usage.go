package main

// Kimi Code plan usage: one account's read (kimi_account_usage.go keeps one per account).
//
// It is the read Kimi Code's own /usage makes (getManagedUsage, 2.1.1): GET `<base_url>/usages` of the
// managed Kimi Code provider in the account's config.toml, with the account's OAuth access token as
// its bearer. `usages` names four limits, each {used_ratio, reset_time}, and each lands in the window
// @orbit/shared names for it (PlanUsageSnapshot): limit_5h → fiveHour, limit_7d → sevenDay,
// limit_month_total → month, limit_month_code → monthCode, utilization = used_ratio × 100.
//
// An access token lives 900 seconds, and nothing the runner runs keeps one fresh — its sign-in probe
// does not refresh — so on a machine no session has used for a quarter of an hour every stored token
// has expired. A read refreshes one that is about to, and only under Kimi Code's own refresh lock
// (kimi_refresh_lock.go), the way the CLI does: a refresh rotates the refresh token, and one made
// beside a CLI's own would spend the token that CLI is about to send and sign the account out.
//
// Not by running the CLI to refresh for it (`kimi web` in an overlay of the account): that is a
// server on a port, a bearer token scraped from its start-up output and a 190 MB process per read,
// each of which can change in any release, where the lock, the token file and the token request are
// what every Kimi Code process sharing a home already has to agree on.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	// kimiTokenRefreshLead is how near its expiry a token is refreshed before a read sends it. Kimi Code
	// renews far earlier — half the token's life, five minutes at least — so where a CLI is at work it
	// is the CLI that refreshes, and the read only renews a token nobody else is going to.
	kimiTokenRefreshLead = 30 * time.Second
	// kimiTokenRefreshTimeout is the CLI's own budget for one token request.
	kimiTokenRefreshTimeout = 30 * time.Second
)

const (
	// Kimi Code's OAuth client, and the sign-in site and API of a login that names none
	// (KIMI_CODE_FLOW_CONFIG, DEFAULT_KIMI_CODE_BASE_URL).
	kimiOAuthClientID    = "17e5f671-d194-4dfb-9706-5516cb48c098"
	kimiDefaultOAuthHost = "https://auth.kimi.com"
	kimiDefaultBaseURL   = "https://api.kimi.com/coding/v1"
)

var (
	errKimiNotSignedIn = errors.New("not signed in to Kimi Code")
	// A stored token with no access token is the CLI's tombstone: a refresh the server refused.
	errKimiSignedOut      = errors.New("signed out: Kimi Code's refresh was refused and it cleared the login — sign in again")
	errKimiTokenRefused   = errors.New("usage endpoint -> 401; this token is not sent again")
	errKimiRefreshRefused = errors.New("Kimi Code's token endpoint refused the refresh token; it is not sent again — sign in again")
)

// kimiLogin is one account's Kimi Code login, where the CLI keeps it.
type kimiLogin struct {
	home string
	// baseURL is the managed provider's API, without a trailing slash.
	baseURL string
	// oauthHost is the sign-in site its tokens are refreshed on.
	oauthHost string
	// storage is the name its token is stored under — credentials/<storage>.json, locked as
	// oauth/<storage>.lock.
	storage string
}

func (l kimiLogin) tokenPath() string {
	return filepath.Join(l.home, "credentials", l.storage+".json")
}

// readKimiLogin reads the login kept in home from its config.toml.
func readKimiLogin(home string) (kimiLogin, error) {
	config, err := os.ReadFile(filepath.Join(home, "config.toml"))
	if errors.Is(err, fs.ErrNotExist) {
		return kimiLogin{}, errKimiNotSignedIn
	}
	if err != nil {
		return kimiLogin{}, err
	}
	values := kimiConfigStrings(config)
	provider := []string{"providers", kimiManagedProvider}
	value := func(path ...string) (string, bool) {
		v, ok := values[strings.Join(append(append([]string(nil), provider...), path...), "\x00")]
		return v, ok
	}
	// The managed provider's oauth table is the login: its key is what the CLI's sign-in records, and
	// its sign-out takes the provider away.
	if _, ok := value("oauth", "key"); !ok {
		return kimiLogin{}, errKimiNotSignedIn
	}
	if storage, ok := value("oauth", "storage"); ok && storage != "file" {
		return kimiLogin{}, fmt.Errorf("Kimi Code keeps this login's token in %q storage, which the runner does not read", storage)
	}
	baseURL, ok := value("base_url")
	if !ok {
		baseURL = kimiDefaultBaseURL
	}
	oauthHost, ok := value("oauth", "oauth_host")
	if !ok {
		oauthHost = kimiDefaultOAuthHost
	}
	login := kimiLogin{
		home:      home,
		baseURL:   strings.TrimRight(baseURL, "/"),
		oauthHost: strings.TrimRight(strings.TrimSpace(oauthHost), "/"),
	}
	login.storage = kimiTokenStorageName(login.oauthHost, login.baseURL)
	return login, nil
}

// kimiTokenStorageName is the name the CLI stores a login's token under, derived as its runtime
// derives it (resolveKimiCodeRuntimeAuth, resolveKimiCodeOAuthKey): from the sign-in site and the API
// the login uses — whatever key config.toml records, which the CLI overrides the same way when it names
// another slot. "kimi-code" for kimi.com's own pair, "kimi-code-env-" and 16 hex digits of a SHA-256
// for any other.
func kimiTokenStorageName(oauthHost, baseURL string) string {
	if oauthHost == kimiDefaultOAuthHost && baseURL == kimiDefaultBaseURL {
		return "kimi-code"
	}
	// JSON.stringify({oauthHost, baseUrl}): the key order the CLI hashes, and nothing HTML-escaped.
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(struct {
		OAuthHost string `json:"oauthHost"`
		BaseURL   string `json:"baseUrl"`
	}{oauthHost, baseURL})
	sum := sha256.Sum256(bytes.TrimSuffix(b.Bytes(), []byte("\n")))
	return "kimi-code-env-" + hex.EncodeToString(sum[:])[:16]
}

// kimiConfigStrings is every string value of a config.toml by its full key path, the parts joined by
// NUL: the [table] it is in, then its own dotted key, each part unquoted. It reads the file as the CLI
// writes it (smol-toml): table headers, and `key = "basic"` or `key = 'literal'` on a line of its own.
// Anything else — arrays, numbers, multi-line strings, inline tables — is skipped, so a key held that
// way reads as absent.
func kimiConfigStrings(config []byte) map[string]string {
	out := map[string]string{}
	var table []string
	for _, line := range strings.Split(string(config), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || line[0] == '#' {
			continue
		}
		if line[0] == '[' {
			// An array of tables is no table a read looks in.
			array := strings.HasPrefix(line, "[[")
			header := strings.TrimLeft(line, "[")
			end := tomlKeyEnd(header, ']')
			path, ok := tomlKeyPath(header[:end])
			if array || !ok {
				path = []string{"[["}
			}
			table = path
			continue
		}
		eq := tomlKeyEnd(line, '=')
		if eq == len(line) {
			continue
		}
		key, ok := tomlKeyPath(line[:eq])
		if !ok {
			continue
		}
		if value, ok := tomlString(strings.TrimSpace(line[eq+1:])); ok {
			out[strings.Join(append(append([]string(nil), table...), key...), "\x00")] = value
		}
	}
	return out
}

// tomlKeyEnd is where in s the first stop byte outside quotes is, or len(s).
func tomlKeyEnd(s string, stop byte) int {
	var quote byte
	for i := 0; i < len(s); i++ {
		switch c := s[i]; {
		case quote != 0:
			if c == '\\' && quote == '"' {
				i++
			} else if c == quote {
				quote = 0
			}
		case c == '"' || c == '\'':
			quote = c
		case c == stop:
			return i
		}
	}
	return len(s)
}

var tomlBareKey = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

// tomlKeyPath splits a dotted key into its parts, unquoting each.
func tomlKeyPath(s string) ([]string, bool) {
	var path []string
	for {
		s = strings.TrimSpace(s)
		end := tomlKeyEnd(s, '.')
		part := strings.TrimSpace(s[:end])
		switch {
		case tomlBareKey.MatchString(part):
		case len(part) >= 2 && part[0] == '\'' && part[len(part)-1] == '\'':
			part = part[1 : len(part)-1]
		case len(part) >= 2 && part[0] == '"':
			unquoted, err := strconv.Unquote(part)
			if err != nil {
				return nil, false
			}
			part = unquoted
		default:
			return nil, false
		}
		path = append(path, part)
		if end == len(s) {
			return path, true
		}
		s = s[end+1:]
	}
}

// tomlString reads a one-line string value, and whatever comment follows it.
func tomlString(s string) (string, bool) {
	if strings.HasPrefix(s, `"""`) || strings.HasPrefix(s, "'''") || len(s) < 2 || (s[0] != '"' && s[0] != '\'') {
		return "", false
	}
	end := 1
	for ; end < len(s) && s[end] != s[0]; end++ {
		if s[end] == '\\' && s[0] == '"' {
			end++
		}
	}
	if end >= len(s) {
		return "", false
	}
	if rest := strings.TrimSpace(s[end+1:]); rest != "" && rest[0] != '#' {
		return "", false
	}
	if s[0] == '\'' {
		return s[1:end], true
	}
	value, err := strconv.Unquote(s[:end+1])
	return value, err == nil
}

// kimiStoredToken is a Kimi Code token as the CLI stores it (FileTokenStorage): snake_case, in this
// order, two-space indented — what it writes, and what the runner writes back after a refresh.
type kimiStoredToken struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	// ExpiresAt is in unix seconds; 0 is a token the CLI never refreshes.
	ExpiresAt float64 `json:"expires_at"`
	Scope     string  `json:"scope"`
	TokenType string  `json:"token_type"`
	ExpiresIn float64 `json:"expires_in"`
}

// expiresWithin is the CLI's shouldRefreshToken with lead for its threshold.
func (t kimiStoredToken) expiresWithin(lead time.Duration, now time.Time) bool {
	return t.ExpiresAt != 0 && t.ExpiresAt-float64(now.Unix()) < lead.Seconds()
}

// loadKimiToken reads the token stored for login. A file missing or unreadable is no login, as it
// is to the CLI (tokenFromWire); one holding no access token is a login the CLI signed out.
func loadKimiToken(login kimiLogin) (kimiStoredToken, error) {
	b, err := os.ReadFile(login.tokenPath())
	if errors.Is(err, fs.ErrNotExist) {
		return kimiStoredToken{}, errKimiNotSignedIn
	}
	if err != nil {
		return kimiStoredToken{}, err
	}
	var raw map[string]interface{}
	if json.Unmarshal(b, &raw) != nil || raw == nil {
		return kimiStoredToken{}, errKimiNotSignedIn
	}
	token := kimiStoredToken{}
	token.AccessToken, _ = raw["access_token"].(string)
	token.RefreshToken, _ = raw["refresh_token"].(string)
	token.ExpiresAt, _ = numberValue(raw["expires_at"])
	if token.AccessToken == "" {
		return token, errKimiSignedOut
	}
	return token, nil
}

// saveKimiToken stores token for login the way the CLI does: the whole file replaced at once.
func saveKimiToken(login kimiLogin, token kimiStoredToken) error {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(token); err != nil {
		return err
	}
	return writeFileAtomically(login.tokenPath(), b.Bytes(), 0o600)
}

// kimiUsageRead is one Kimi Code account's usage read, and what it keeps between passes: the hashes —
// never the tokens — of an access token the usage endpoint refused and of a refresh token the token
// endpoint refused. Neither is sent again: the answer would not change, and a refused refresh token
// is one only signing in again replaces.
type kimiUsageRead struct {
	refusedAccess  [sha256.Size]byte
	refusedRefresh [sha256.Size]byte
}

// fetch reads the usage of the login kept in home.
func (r *kimiUsageRead) fetch(ctx context.Context, client *http.Client, home string) (*PlanUsage, error) {
	login, err := readKimiLogin(home)
	if err != nil {
		return nil, err
	}
	token, err := r.accessToken(ctx, client, login)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256([]byte(token))
	if sum == r.refusedAccess {
		return nil, errKimiTokenRefused
	}
	cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(cctx, http.MethodGet, login.baseURL+"/usages", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "orbit-runner/"+version)
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode == http.StatusUnauthorized {
		r.refusedAccess = sum
		return nil, errKimiTokenRefused
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("usage endpoint -> %d", resp.StatusCode)
	}
	return parseKimiPlanUsage(body)
}

// accessToken is the token a read sends: the stored one while it has longer than kimiTokenRefreshLead
// left, else whatever a refresh under Kimi Code's lock leaves stored.
func (r *kimiUsageRead) accessToken(ctx context.Context, client *http.Client, login kimiLogin) (string, error) {
	token, err := loadKimiToken(login)
	if err != nil || !token.expiresWithin(kimiTokenRefreshLead, time.Now()) {
		return token.AccessToken, err
	}
	// Where the CLI takes no lock, neither does anything else: nothing to refresh beside safely.
	if runtime.GOOS == "windows" || os.Getenv("KIMI_DISABLE_OAUTH_LOCK") == "1" {
		return "", errors.New("access token expired; Kimi Code takes no refresh lock on this machine, so only the CLI refreshes it")
	}
	if sha256.Sum256([]byte(token.RefreshToken)) == r.refusedRefresh {
		return "", errKimiRefreshRefused
	}
	headers, err := kimiDeviceHeaders(login.home)
	if err != nil {
		return "", fmt.Errorf("access token expired; not refreshed: %w", err)
	}
	lock, err := acquireKimiRefreshLock(ctx, login.home, login.storage)
	if err != nil {
		return "", fmt.Errorf("access token expired; Kimi Code's refresh lock: %w", err)
	}
	defer lock.release()
	// What is stored now is what counts: whoever held the lock before may have refreshed already, and
	// then its token is the one to send — refreshing again would spend the refresh token it stored.
	if token, err = loadKimiToken(login); err != nil || !token.expiresWithin(kimiTokenRefreshLead, time.Now()) {
		return token.AccessToken, err
	}
	if token.RefreshToken == "" {
		return "", errors.New("access token expired and no refresh token is stored — sign in again")
	}
	spent := sha256.Sum256([]byte(token.RefreshToken))
	if spent == r.refusedRefresh {
		return "", errKimiRefreshRefused
	}
	if !lock.held() {
		return "", errors.New("access token expired; lost Kimi Code's refresh lock before refreshing")
	}
	fresh, err := refreshKimiToken(ctx, client, login.oauthHost, token.RefreshToken, headers)
	if errors.Is(err, errKimiRefreshRefused) {
		r.refusedRefresh = spent
	}
	if err != nil {
		return "", err
	}
	// Stored even if the lock was lost meanwhile: the refresh token sent is spent, and this pair is the
	// only good one there is.
	if err := saveKimiToken(login, fresh); err != nil {
		return "", fmt.Errorf("refreshed the access token but could not store it: %w", err)
	}
	return fresh.AccessToken, nil
}

// refreshKimiToken is Kimi Code's refresh request (refreshAccessToken): its client, its device
// headers, the refresh token as a form. Once sent it is not cut off with the read: a refresh stopped
// after the server rotated the token leaves nobody holding the new one.
func refreshKimiToken(ctx context.Context, client *http.Client, oauthHost, refreshToken string, headers http.Header) (kimiStoredToken, error) {
	form := url.Values{"client_id": {kimiOAuthClientID}, "grant_type": {"refresh_token"}, "refresh_token": {refreshToken}}
	cctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), kimiTokenRefreshTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(cctx, http.MethodPost, oauthHost+"/api/oauth/token", strings.NewReader(form.Encode()))
	if err != nil {
		return kimiStoredToken{}, err
	}
	req.Header = headers.Clone()
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return kimiStoredToken{}, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var data map[string]interface{}
	_ = json.Unmarshal(body, &data)
	if _, ok := data["access_token"].(string); ok && resp.StatusCode == http.StatusOK {
		return kimiTokenFromResponse(data)
	}
	if code, _ := data["error"].(string); resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden || code == "invalid_grant" {
		return kimiStoredToken{}, errKimiRefreshRefused
	}
	return kimiStoredToken{}, fmt.Errorf("token endpoint -> %d", resp.StatusCode)
}

// kimiTokenFromResponse is a token response as the CLI takes it (tokenFromResponse): no new pair
// without both tokens and a lifetime, so nothing is stored that would leave the account without one.
func kimiTokenFromResponse(data map[string]interface{}) (kimiStoredToken, error) {
	token := kimiStoredToken{TokenType: "Bearer"}
	token.AccessToken, _ = data["access_token"].(string)
	token.RefreshToken, _ = data["refresh_token"].(string)
	expiresIn, ok := kimiNumber(data["expires_in"])
	if token.AccessToken == "" || token.RefreshToken == "" || !ok || expiresIn <= 0 {
		return kimiStoredToken{}, errors.New("token endpoint answered without a new token pair")
	}
	token.ExpiresIn = expiresIn
	token.ExpiresAt = float64(time.Now().Unix()) + token.ExpiresIn
	if scope, ok := data["scope"].(string); ok {
		token.Scope = scope
	}
	if tokenType, ok := data["token_type"].(string); ok {
		token.TokenType = tokenType
	}
	return token, nil
}

// kimiDeviceHeaders are the identity headers Kimi Code sends with every token request
// (createKimiDefaultHeaders): the CLI's name and version, this machine, and the account's device id —
// <home>/device_id, made at sign-in, which the account's tokens are issued to.
func kimiDeviceHeaders(home string) (http.Header, error) {
	cliVersion, err := kimiCLIVersion()
	if err != nil {
		return nil, err
	}
	b, err := os.ReadFile(filepath.Join(home, "device_id"))
	if err != nil {
		return nil, fmt.Errorf("no device id to refresh as: %w", err)
	}
	deviceID := strings.TrimSpace(string(b))
	if deviceID == "" {
		return nil, errors.New("no device id to refresh as")
	}
	hostname, _ := os.Hostname()
	sysname, release := kimiUname()
	h := http.Header{}
	h.Set("User-Agent", "kimi-code-cli/"+cliVersion)
	h.Set("X-Msh-Platform", "kimi_code_cli")
	h.Set("X-Msh-Version", cliVersion)
	h.Set("X-Msh-Device-Name", kimiASCIIHeader(hostname))
	h.Set("X-Msh-Device-Model", kimiASCIIHeader(kimiDeviceModel(sysname, release)))
	h.Set("X-Msh-Os-Version", kimiASCIIHeader(release))
	h.Set("X-Msh-Device-Id", deviceID)
	return h, nil
}

// kimiASCIIHeader is a header value as the CLI cleans one: printable ASCII only, else "unknown".
func kimiASCIIHeader(value string) string {
	cleaned := strings.TrimSpace(strings.Map(func(r rune) rune {
		if r < 0x20 || r > 0x7e {
			return -1
		}
		return r
	}, value))
	if cleaned == "" {
		return "unknown"
	}
	return cleaned
}

// kimiUname is Node's os.type() and os.release(), which the CLI's device headers carry.
var kimiUname = sync.OnceValues(func() (string, string) {
	out, err := exec.Command("uname", "-s", "-r").Output()
	if err != nil {
		return "", ""
	}
	sysname, release, _ := strings.Cut(strings.TrimSpace(string(out)), " ")
	return sysname, release
})

// kimiDeviceModel is the CLI's deviceModel(): os.type(), os.release() and Node's name for the
// architecture — on macOS, the product version in place of the kernel's.
func kimiDeviceModel(sysname, release string) string {
	arch := map[string]string{"amd64": "x64", "386": "ia32"}[runtime.GOARCH]
	if arch == "" {
		arch = runtime.GOARCH
	}
	if sysname == "Darwin" {
		if plist, err := os.ReadFile("/System/Library/CoreServices/SystemVersion.plist"); err == nil {
			if m := macOSProductVersion.FindSubmatch(plist); m != nil && strings.TrimSpace(string(m[1])) != "" {
				release = strings.TrimSpace(string(m[1]))
			}
		}
		return "macOS " + release + " " + arch
	}
	return strings.TrimSpace(sysname + " " + release + " " + arch)
}

var macOSProductVersion = regexp.MustCompile(`<key>ProductVersion</key>\s*<string>([^<]*)</string>`)

// kimiVersionSeen is the last `kimi --version` asked, kept until the binary it asked changes.
var kimiVersionSeen struct {
	sync.Mutex
	path    string
	size    int64
	modTime time.Time
	version string
}

// kimiCLIVersion is the version of the `kimi` a session would run, which its device headers name.
func kimiCLIVersion() (string, error) {
	path, err := exec.LookPath(providerKimi)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	kimiVersionSeen.Lock()
	defer kimiVersionSeen.Unlock()
	if kimiVersionSeen.path != path || kimiVersionSeen.size != info.Size() || !kimiVersionSeen.modTime.Equal(info.ModTime()) {
		kimiVersionSeen.path, kimiVersionSeen.size, kimiVersionSeen.modTime = path, info.Size(), info.ModTime()
		kimiVersionSeen.version = kimiASCIIHeader(engineVersion(path))
	}
	if kimiVersionSeen.version == "unknown" {
		kimiVersionSeen.path = ""
		return "", errors.New("kimi --version answered nothing")
	}
	return kimiVersionSeen.version, nil
}

// parseKimiPlanUsage maps a `<base_url>/usages` answer to Kimi's windows. Kimi Code reads it leniently
// (parseManagedUsagePayload) and so does this: a limit that is missing, or whose used_ratio is not a
// number, is a window not reported, never a bogus 0%.
func parseKimiPlanUsage(body []byte) (*PlanUsage, error) {
	var raw struct {
		Usages json.RawMessage `json:"usages"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, err
	}
	var limits map[string]json.RawMessage
	_ = json.Unmarshal(raw.Usages, &limits)
	return &PlanUsage{
		Provider:  providerKimi,
		FiveHour:  kimiUsageWindow(limits["limit_5h"]),
		SevenDay:  kimiUsageWindow(limits["limit_7d"]),
		Month:     kimiUsageWindow(limits["limit_month_total"]),
		MonthCode: kimiUsageWindow(limits["limit_month_code"]),
		FetchedAt: time.Now().UTC().Format(time.RFC3339),
	}, nil
}

// kimiUsageWindow is one {used_ratio, reset_time} limit as a window: utilization = used_ratio × 100,
// to six places of the ratio as the CLI rounds it, and resetsAt = reset_time as Kimi sent it.
func kimiUsageWindow(raw json.RawMessage) *PlanUsageWindow {
	var entry map[string]interface{}
	if json.Unmarshal(raw, &entry) != nil || entry == nil {
		return nil
	}
	ratio, ok := kimiNumber(entry["used_ratio"])
	if !ok {
		return nil
	}
	w := &PlanUsageWindow{Utilization: math.Round(ratio*1e6) / 1e4}
	if reset, _ := entry["reset_time"].(string); reset != "" {
		w.ResetsAt = reset
	}
	return w
}

// kimiNumber is a value Kimi Code reads with Number(): a finite number, or a string holding one.
func kimiNumber(v interface{}) (float64, bool) {
	n, ok := numberValue(v)
	if s, isString := v.(string); isString {
		var err error
		n, err = strconv.ParseFloat(strings.TrimSpace(s), 64)
		ok = err == nil
	}
	return n, ok && !math.IsInf(n, 0) && !math.IsNaN(n)
}
