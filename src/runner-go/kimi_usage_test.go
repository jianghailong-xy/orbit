package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeKimiService stands in for one Kimi Code site: its token endpoint, which rotates the refresh token
// on every refresh and takes each one once, and its API's /usages. A refresh is checked for what it has
// to be — Kimi Code's client and form, made while the home's refresh lock is held and fresh, no other
// refresh in flight — and every breach is kept as a violation.
type fakeKimiService struct {
	*httptest.Server
	// lockDir is the refresh lock every refresh must be made under.
	lockDir string

	mu            sync.Mutex
	refreshToken  string          // the one refresh token still good
	accessTokens  map[string]bool // the access tokens it would take
	issued        int
	inFlight      int
	refreshDelay  time.Duration
	refreshes     []http.Header // the headers of every refresh it granted, in order
	refreshStatus int           // non-zero: what every refresh is answered, granted or not
	violations    []string
	usagesStatus  int
	usagesBody    string
	usagesAuth    []string
}

func newFakeKimiService(t *testing.T) *fakeKimiService {
	t.Helper()
	s := &fakeKimiService{accessTokens: map[string]bool{}, usagesBody: `{"usages":{}}`}
	s.Server = httptest.NewServer(http.HandlerFunc(s.serve))
	t.Cleanup(s.Close)
	t.Cleanup(func() {
		for _, v := range s.violationList() {
			t.Errorf("fake Kimi service: %s", v)
		}
	})
	return s
}

func (s *fakeKimiService) violate(format string, args ...any) {
	s.violations = append(s.violations, fmt.Sprintf(format, args...))
}

func (s *fakeKimiService) violationList() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.violations...)
}

func (s *fakeKimiService) granted() []http.Header {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]http.Header(nil), s.refreshes...)
}

func (s *fakeKimiService) usages() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.usagesAuth...)
}

func (s *fakeKimiService) currentRefreshToken() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.refreshToken
}

// lockHeldFresh reports whether the refresh lock is there and kept fresh — what a refresh needs.
func (s *fakeKimiService) lockHeldFresh() bool {
	info, err := os.Stat(s.lockDir)
	return err == nil && time.Since(info.ModTime()) <= kimiRefreshLockStale
}

func (s *fakeKimiService) serve(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.Method == http.MethodPost && r.URL.Path == "/api/oauth/token":
		s.serveRefresh(w, r)
	case r.Method == http.MethodGet && r.URL.Path == "/coding/v1/usages":
		s.mu.Lock()
		s.usagesAuth = append(s.usagesAuth, r.Header.Get("Authorization"))
		good := s.accessTokens[strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")]
		status, body := s.usagesStatus, s.usagesBody
		s.mu.Unlock()
		if !good {
			status = http.StatusUnauthorized
		}
		if status == 0 {
			status = http.StatusOK
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	case r.URL.Path == "/coding/v1/chat/completions":
		// The real CLI's turn once its token is ready (kimi_usage_real_test.go): sent with a token the
		// service would take — whoever stored it — and refused, so that the CLI exits at once.
		s.mu.Lock()
		if !s.accessTokens[strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")] {
			s.violate("kimi sent its turn with a token the service does not take: %q", r.Header.Get("Authorization"))
		}
		s.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":{"message":"fake Kimi service: no chat here","type":"invalid_request_error"}}`))
	default:
		http.NotFound(w, r)
	}
}

func (s *fakeKimiService) serveRefresh(w http.ResponseWriter, r *http.Request) {
	_ = r.ParseForm()
	s.mu.Lock()
	s.inFlight++
	if s.inFlight > 1 {
		s.violate("two refreshes in flight at once")
	}
	if !s.lockHeldFresh() {
		s.violate("a refresh was made outside Kimi Code's refresh lock (%s)", r.Header.Get("X-Msh-Version"))
	}
	if r.PostForm.Get("client_id") != kimiOAuthClientID || r.PostForm.Get("grant_type") != "refresh_token" {
		s.violate("a refresh not in Kimi Code's form: %v", r.PostForm)
	}
	delay := s.refreshDelay
	s.mu.Unlock()
	time.Sleep(delay)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.inFlight--
	if !s.lockHeldFresh() {
		s.violate("the refresh lock went stale or away while a refresh was in flight (%s)", r.Header.Get("X-Msh-Version"))
	}
	w.Header().Set("Content-Type", "application/json")
	if s.refreshStatus != 0 {
		w.WriteHeader(s.refreshStatus)
		_, _ = w.Write([]byte(`{"error":"invalid_grant","error_description":"refused by the test"}`))
		return
	}
	if sent := r.PostForm.Get("refresh_token"); sent != s.refreshToken {
		s.violate("a spent refresh token was sent: %q (good one: %q)", sent, s.refreshToken)
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"invalid_grant","error_description":"refresh token already used"}`))
		return
	}
	s.issued++
	access, refresh := fmt.Sprintf("at-%d", s.issued), fmt.Sprintf("rt-%d", s.issued)
	s.refreshToken = refresh
	s.accessTokens[access] = true
	s.refreshes = append(s.refreshes, r.Header.Clone())
	_ = json.NewEncoder(w).Encode(map[string]any{
		"access_token": access, "refresh_token": refresh, "expires_in": 900, "scope": "kimi-code", "token_type": "Bearer",
	})
}

// signInFakeKimi leaves home signed in on svc as Kimi Code's own sign-in leaves a home: config.toml with
// the managed provider on svc's API and sign-in site, the token under the name the CLI derives from
// them, and the device id. The token's access token is one svc takes until a refresh replaces it.
func signInFakeKimi(t *testing.T, home string, svc *fakeKimiService, access, refresh string, expiresAt int64) kimiLogin {
	t.Helper()
	baseURL := svc.URL + "/coding/v1"
	storage := kimiTokenStorageName(svc.URL, baseURL)
	config := fmt.Sprintf(`default_model = "kimi-code/kimi-for-coding"

[providers."managed:kimi-code"]
type = "kimi"
api_key = ""
base_url = %q

[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/%s"
oauth_host = %q

[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
model = "kimi-for-coding"
max_context_size = 262144
capabilities = [ "thinking", "tool_use" ]
`, baseURL, storage, svc.URL)
	for _, dir := range []string{home, filepath.Join(home, "credentials")} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "device_id"), []byte("0f1e2d3c-4b5a-4968-8776-655443322110"), 0o600); err != nil {
		t.Fatal(err)
	}
	login := kimiLogin{home: home, baseURL: baseURL, oauthHost: svc.URL, storage: storage}
	storeFakeKimiToken(t, login, access, refresh, expiresAt)
	svc.mu.Lock()
	svc.lockDir = kimiRefreshLockDir(home, storage)
	svc.refreshToken = refresh
	svc.accessTokens[access] = expiresAt > time.Now().Unix()
	svc.mu.Unlock()
	return login
}

// storeFakeKimiToken writes a token file the way Kimi Code writes one.
func storeFakeKimiToken(t *testing.T, login kimiLogin, access, refresh string, expiresAt int64) {
	t.Helper()
	body := fmt.Sprintf("{\n  \"access_token\": %q,\n  \"refresh_token\": %q,\n  \"expires_at\": %d,\n  \"scope\": \"kimi-code\",\n  \"token_type\": \"Bearer\",\n  \"expires_in\": 900\n}\n", access, refresh, expiresAt)
	if err := os.WriteFile(login.tokenPath(), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

// installFakeKimiVersion puts a `kimi` first on PATH that only answers --version, which the runner's
// refresh names in its device headers.
func installFakeKimiVersion(t *testing.T, version string) {
	t.Helper()
	dir := t.TempDir()
	writeFakeBin(t, dir, providerKimi, `[ "$1" = --version ] && echo `+version)
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("KIMI_DISABLE_OAUTH_LOCK", "")
}

func TestParseKimiPlanUsageMapsEachLimit(t *testing.T) {
	cases := []struct {
		name string
		body string
		want map[string]*PlanUsageWindow // by window name; nil: not reported
	}{
		{
			name: "every limit",
			body: `{"usages":{
				"limit_5h":{"used_ratio":0.25,"reset_time":"2026-10-08T17:00:00Z"},
				"limit_7d":{"used_ratio":0.07,"reset_time":"2026-10-13T00:00:00Z"},
				"limit_month_total":{"used_ratio":0.5,"reset_time":"2026-11-01T00:00:00Z"},
				"limit_month_code":{"used_ratio":0.125,"reset_time":"2026-11-01T00:00:00Z"}},
				"boosterWallet":{"balance":{"type":"BOOSTER","amount":0}}}`,
			want: map[string]*PlanUsageWindow{
				"fiveHour":  {Utilization: 25, ResetsAt: "2026-10-08T17:00:00Z"},
				"sevenDay":  {Utilization: 7, ResetsAt: "2026-10-13T00:00:00Z"},
				"month":     {Utilization: 50, ResetsAt: "2026-11-01T00:00:00Z"},
				"monthCode": {Utilization: 12.5, ResetsAt: "2026-11-01T00:00:00Z"},
			},
		},
		{
			name: "limits Kimi did not send, or sent without a ratio, are not reported",
			body: `{"usages":{
				"limit_5h":{"used_ratio":"0.9"},
				"limit_7d":{"reset_time":"2026-10-13T00:00:00Z"},
				"limit_month_total":"full",
				"limit_month_code":{"used_ratio":"lots"}}}`,
			want: map[string]*PlanUsageWindow{"fiveHour": {Utilization: 90}},
		},
		{
			name: "over the limit is over 100%, never clamped",
			body: `{"usages":{"limit_5h":{"used_ratio":1.2,"reset_time":"2026-10-08T17:00:00Z"}}}`,
			want: map[string]*PlanUsageWindow{"fiveHour": {Utilization: 120, ResetsAt: "2026-10-08T17:00:00Z"}},
		},
		{name: "no usages at all", body: `{"boosterWallet":null}`, want: map[string]*PlanUsageWindow{}},
		{name: "usages that are not an object", body: `{"usages":[1,2]}`, want: map[string]*PlanUsageWindow{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseKimiPlanUsage([]byte(tc.body))
			if err != nil {
				t.Fatal(err)
			}
			if got.Provider != providerKimi || got.FetchedAt == "" {
				t.Fatalf("snapshot = %#v, want provider kimi with fetchedAt", got)
			}
			windows := map[string]*PlanUsageWindow{"fiveHour": got.FiveHour, "sevenDay": got.SevenDay, "month": got.Month, "monthCode": got.MonthCode}
			for name, w := range windows {
				want := tc.want[name]
				if (w == nil) != (want == nil) || (w != nil && *w != *want) {
					t.Errorf("%s = %#v, want %#v", name, w, want)
				}
			}
			if got.SevenDayOpus != nil || got.Primary != nil || got.Accounts != nil {
				t.Errorf("windows no Kimi limit maps to: %#v", got)
			}
		})
	}
	if _, err := parseKimiPlanUsage([]byte("<html>gateway timeout</html>")); err == nil {
		t.Error("an answer that is not JSON read as a snapshot")
	}
}

// The name a login's token is stored under is the CLI's own derivation. Two pinned against Kimi Code
// 2.1.1 itself: kimi.ai's is the credentials file a real kimi.ai sign-in wrote, and the loopback one is
// the name the real CLI found its token under when pointed at a fake site.
func TestKimiTokenStorageNameIsTheCLIs(t *testing.T) {
	for _, tc := range []struct{ oauthHost, baseURL, want string }{
		{"https://auth.kimi.com", "https://api.kimi.com/coding/v1", "kimi-code"},
		{"https://auth.kimi.ai", "https://api.kimi.ai/coding/v1", "kimi-code-env-0e4f99c69cc27850"},
		{"http://127.0.0.1:18931", "http://127.0.0.1:18931/coding/v1", "kimi-code-env-9391f4efa3fb82b8"},
	} {
		if got := kimiTokenStorageName(tc.oauthHost, tc.baseURL); got != tc.want {
			t.Errorf("kimiTokenStorageName(%q, %q) = %q, want %q", tc.oauthHost, tc.baseURL, got, tc.want)
		}
	}
}

func TestReadKimiLoginFromConfig(t *testing.T) {
	write := func(t *testing.T, config string) string {
		t.Helper()
		home := t.TempDir()
		if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(config), 0o600); err != nil {
			t.Fatal(err)
		}
		return home
	}
	t.Run("a kimi.ai login, laid out as the CLI writes it", func(t *testing.T) {
		home := write(t, `default_model = "kimi-code/kimi-for-coding"

[providers."managed:kimi-code"]
type = "kimi"
api_key = ""
base_url = "https://api.kimi.ai/coding/v1"

[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code-env-0e4f99c69cc27850"
oauth_host = "https://auth.kimi.ai"

[models."kimi-code/k3"]
provider = "managed:kimi-code"
capabilities = [ "thinking", "image_in" ]

[services.moonshot_search]
base_url = "https://api.kimi.ai/coding/v1/search"

[services.moonshot_search.oauth]
key = "oauth/kimi-code-env-0e4f99c69cc27850"
oauth_host = "https://elsewhere.example"
`)
		login, err := readKimiLogin(home)
		if err != nil {
			t.Fatal(err)
		}
		want := kimiLogin{home: home, baseURL: "https://api.kimi.ai/coding/v1", oauthHost: "https://auth.kimi.ai", storage: "kimi-code-env-0e4f99c69cc27850"}
		if login != want {
			t.Fatalf("login = %#v, want %#v", login, want)
		}
	})
	t.Run("a kimi.com login persists no site of its own", func(t *testing.T) {
		home := write(t, "[providers.\"managed:kimi-code\"]\ntype = \"kimi\"\nbase_url = \"https://api.kimi.com/coding/v1/\" # trailing slash\n[providers.\"managed:kimi-code\".oauth]\nstorage = 'file'\nkey = \"oauth/kimi-code\"\n")
		login, err := readKimiLogin(home)
		if err != nil {
			t.Fatal(err)
		}
		if login.baseURL != kimiDefaultBaseURL || login.oauthHost != kimiDefaultOAuthHost || login.storage != "kimi-code" {
			t.Fatalf("login = %#v", login)
		}
	})
	t.Run("a key the CLI would not use is overridden as the CLI overrides it", func(t *testing.T) {
		home := write(t, "[ providers . \"managed:kimi-code\" ]\nbase_url = \"https://api.kimi.ai/coding/v1\"\n[providers.\"managed:kimi-code\".oauth]\nkey = \"oauth/kimi-code\"\noauth_host = \"https://auth.kimi.ai/\"\n")
		login, err := readKimiLogin(home)
		if err != nil {
			t.Fatal(err)
		}
		if login.storage != "kimi-code-env-0e4f99c69cc27850" {
			t.Fatalf("storage = %q", login.storage)
		}
	})
	for _, tc := range []struct{ name, config string }{
		{"no config at all", ""},
		{"no managed provider", "default_model = \"x\"\n[providers.other]\nbase_url = \"https://example.com\"\n"},
		{"an API-key provider, no OAuth login", "[providers.\"managed:kimi-code\"]\napi_key = \"sk-not-oauth\"\nbase_url = \"https://api.kimi.com/coding/v1\"\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			home := t.TempDir()
			if tc.config != "" {
				home = write(t, tc.config)
			}
			if _, err := readKimiLogin(home); !errors.Is(err, errKimiNotSignedIn) {
				t.Fatalf("readKimiLogin = %v, want not signed in", err)
			}
		})
	}
	t.Run("a token kept anywhere but in a file is not read", func(t *testing.T) {
		home := write(t, "[providers.\"managed:kimi-code\".oauth]\nstorage = \"keyring\"\nkey = \"oauth/kimi-code\"\n")
		if _, err := readKimiLogin(home); err == nil || !strings.Contains(err.Error(), "keyring") {
			t.Fatalf("readKimiLogin = %v, want the storage refused", err)
		}
	})
}

// A good token is read with as it is: GET <base_url>/usages with it as the bearer, nothing refreshed.
func TestKimiUsageReadSendsTheAccountsTokenToItsOwnAPI(t *testing.T) {
	svc := newFakeKimiService(t)
	svc.usagesBody = `{"usages":{"limit_5h":{"used_ratio":0.31,"reset_time":"2026-10-08T17:00:00Z"},"limit_7d":{"used_ratio":0.12,"reset_time":"2026-10-13T00:00:00Z"},"limit_month_total":{"used_ratio":0.4,"reset_time":"2026-11-01T00:00:00Z"},"limit_month_code":{"used_ratio":0.25,"reset_time":"2026-11-01T00:00:00Z"}}}`
	home := t.TempDir()
	signInFakeKimi(t, home, svc, "at-good", "rt-0", time.Now().Add(10*time.Minute).Unix())

	got, err := (&kimiUsageRead{}).fetch(context.Background(), svc.Client(), home)
	if err != nil {
		t.Fatal(err)
	}
	if got.FiveHour == nil || got.FiveHour.Utilization != 31 || got.SevenDay == nil || got.SevenDay.Utilization != 12 ||
		got.Month == nil || got.Month.Utilization != 40 || got.MonthCode == nil || got.MonthCode.Utilization != 25 {
		t.Fatalf("windows = %#v", got)
	}
	if auth := svc.usages(); auth[0] != "Bearer at-good" || len(svc.granted()) != 0 {
		t.Fatalf("usages auth = %q, refreshes = %d — want the stored token and no refresh", auth, len(svc.granted()))
	}
	if _, err := os.Stat(filepath.Join(home, "oauth")); !os.IsNotExist(err) {
		t.Fatalf("a read with a good token touched the refresh lock's directory: %v", err)
	}
}

// 401: the token is not sent again — every other token is, the moment it is stored. 404: an endpoint
// this API does not have. Either way the probe keeps its last reading, as of when it was read.
func TestKimiUsageReadRefusalsKeepTheLastReading(t *testing.T) {
	svc := newFakeKimiService(t)
	svc.usagesBody = `{"usages":{"limit_5h":{"used_ratio":0.5,"reset_time":"2026-10-08T17:00:00Z"}}}`
	home := t.TempDir()
	login := signInFakeKimi(t, home, svc, "at-good", "rt-0", time.Now().Add(10*time.Minute).Unix())
	read := &kimiUsageRead{}
	probe := &planUsageProbe{client: svc.Client(), name: "kimi plan-usage", fetch: func(ctx context.Context, c *http.Client) (*PlanUsage, error) {
		return read.fetch(ctx, c, home)
	}}
	first := readKimiProbe(t, probe)
	if first.FiveHour == nil || first.FiveHour.Utilization != 50 {
		t.Fatalf("first reading = %#v", first)
	}

	svc.mu.Lock()
	svc.accessTokens["at-good"] = false // revoked: the endpoint answers 401
	svc.mu.Unlock()
	for i := 0; i < 2; i++ {
		if _, err := probe.fetch(context.Background(), probe.client); !errors.Is(err, errKimiTokenRefused) {
			t.Fatalf("read %d with a refused token = %v, want errKimiTokenRefused", i, err)
		}
	}
	if asked := len(svc.usages()); asked != 2 {
		t.Fatalf("usages asked %d times, want the refused token sent once more and then never", asked)
	}

	storeFakeKimiToken(t, login, "at-new", "rt-0", time.Now().Add(10*time.Minute).Unix())
	svc.mu.Lock()
	svc.accessTokens["at-new"] = true
	svc.usagesStatus = http.StatusNotFound
	svc.mu.Unlock()
	if _, err := probe.fetch(context.Background(), probe.client); err == nil || !strings.Contains(err.Error(), "404") {
		t.Fatalf("read on an API with no /usages = %v, want its 404", err)
	}
	if auth := svc.usages(); auth[len(auth)-1] != "Bearer at-new" {
		t.Fatalf("a new token was not sent at once: %q", auth)
	}

	// The loop itself: the failing reads leave the first reading in place, stamped with when it was
	// read, which is how a page tells it is stale.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	before := len(svc.usages())
	go probe.runWithIntervals(ctx, func() int { return 1 }, func() bool { return true }, time.Millisecond, time.Millisecond, time.Millisecond)
	deadline := time.Now().Add(5 * time.Second)
	for {
		if len(svc.usages()) >= before+3 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the probe loop never read again")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if got := probe.snapshot(); got != first {
		t.Fatalf("snapshot after failing reads = %#v, want the first reading kept (%#v)", got, first)
	}
}

// readKimiProbe is one pass of a probe, stored as the loop stores it.
func readKimiProbe(t *testing.T, probe *planUsageProbe) *PlanUsage {
	t.Helper()
	usage, err := probe.fetch(context.Background(), probe.client)
	if err != nil {
		t.Fatalf("read %s: %v", probe.name, err)
	}
	probe.store(usage)
	return probe.snapshot()
}

// An expired token is refreshed the way Kimi Code refreshes it — under its lock, as its client, with
// its device headers — and the new pair is stored whole, in the CLI's own format, before it is used.
func TestKimiUsageReadRefreshesAnExpiredTokenAsTheCLIDoes(t *testing.T) {
	installFakeKimiVersion(t, "2.1.1-orbit-test")
	svc := newFakeKimiService(t)
	svc.usagesBody = `{"usages":{"limit_5h":{"used_ratio":0.1,"reset_time":"2026-10-08T17:00:00Z"}}}`
	home := t.TempDir()
	login := signInFakeKimi(t, home, svc, "at-expired", "rt-0", time.Now().Add(-20*time.Hour).Unix())

	got, err := (&kimiUsageRead{}).fetch(context.Background(), svc.Client(), home)
	if err != nil {
		t.Fatal(err)
	}
	if got.FiveHour == nil || got.FiveHour.Utilization != 10 {
		t.Fatalf("windows = %#v", got)
	}
	granted := svc.granted()
	if auth := svc.usages(); len(granted) != 1 || auth[0] != "Bearer at-1" {
		t.Fatalf("refreshes = %d, usages auth = %q — want one refresh and its token used", len(granted), auth)
	}
	h := granted[0]
	for name, want := range map[string]string{
		"User-Agent":         "kimi-code-cli/2.1.1-orbit-test",
		"X-Msh-Platform":     "kimi_code_cli",
		"X-Msh-Version":      "2.1.1-orbit-test",
		"X-Msh-Device-Id":    "0f1e2d3c-4b5a-4968-8776-655443322110",
		"X-Msh-Device-Model": kimiASCIIHeader(kimiDeviceModel(kimiUname())),
		"Content-Type":       "application/x-www-form-urlencoded",
		"Accept":             "application/json",
	} {
		if h.Get(name) != want {
			t.Errorf("%s = %q, want %q", name, h.Get(name), want)
		}
	}
	for _, name := range []string{"X-Msh-Device-Name", "X-Msh-Os-Version"} {
		if h.Get(name) == "" {
			t.Errorf("%s missing", name)
		}
	}

	// Stored as the CLI stores it, byte for byte but for the expiry it computes.
	body, err := os.ReadFile(login.tokenPath())
	if err != nil {
		t.Fatal(err)
	}
	var stored kimiStoredToken
	if err := json.Unmarshal(body, &stored); err != nil {
		t.Fatal(err)
	}
	want := fmt.Sprintf("{\n  \"access_token\": \"at-1\",\n  \"refresh_token\": \"rt-1\",\n  \"expires_at\": %d,\n  \"scope\": \"kimi-code\",\n  \"token_type\": \"Bearer\",\n  \"expires_in\": 900\n}\n", int64(stored.ExpiresAt))
	if string(body) != want {
		t.Fatalf("stored token =\n%s\nwant\n%s", body, want)
	}
	if left := stored.ExpiresAt - float64(time.Now().Unix()); left < 890 || left > 900 {
		t.Fatalf("stored expiry %v s away, want 900 from now", left)
	}
	if info, err := os.Stat(login.tokenPath()); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("stored token mode = %v, %v", info.Mode(), err)
	}
	// The lock is given back; only its directory, which the CLI makes too, stays.
	if _, err := os.Stat(kimiRefreshLockDir(home, login.storage)); !os.IsNotExist(err) {
		t.Fatalf("lock left behind: %v", err)
	}
	if entries, _ := os.ReadDir(filepath.Join(home, "credentials")); len(entries) != 1 {
		t.Fatalf("credentials/ = %v, want the one token file and no temporary", entries)
	}
}

// A refresh token the endpoint refuses stays as it is on disk — the CLI's to tombstone, not the
// runner's — and is never sent again. A login the CLI already signed out is not refreshed at all.
func TestKimiUsageReadNeverRetriesARefusedRefreshToken(t *testing.T) {
	installFakeKimiVersion(t, "2.1.1-orbit-test")
	svc := newFakeKimiService(t)
	svc.refreshStatus = http.StatusUnauthorized
	home := t.TempDir()
	login := signInFakeKimi(t, home, svc, "at-expired", "rt-0", time.Now().Add(-time.Hour).Unix())
	before, _ := os.ReadFile(login.tokenPath())
	read := &kimiUsageRead{}

	var posts atomic.Int32
	counting := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.Method == http.MethodPost {
			posts.Add(1)
		}
		return http.DefaultTransport.RoundTrip(r)
	})}
	for i := 0; i < 3; i++ {
		if _, err := read.fetch(context.Background(), counting, home); !errors.Is(err, errKimiRefreshRefused) {
			t.Fatalf("read %d = %v, want the refresh refused", i, err)
		}
	}
	if posts.Load() != 1 {
		t.Fatalf("refresh requests = %d, want the refused refresh token sent once", posts.Load())
	}
	if after, _ := os.ReadFile(login.tokenPath()); string(after) != string(before) {
		t.Fatalf("a refused refresh rewrote the token:\n%s", after)
	}

	tombstone := "{\n  \"access_token\": \"\",\n  \"refresh_token\": \"\",\n  \"expires_at\": 0,\n  \"scope\": \"kimi-code\",\n  \"token_type\": \"Bearer\",\n  \"expires_in\": 0\n}\n"
	if err := os.WriteFile(login.tokenPath(), []byte(tombstone), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := read.fetch(context.Background(), counting, home); !errors.Is(err, errKimiSignedOut) {
		t.Fatalf("read of a signed-out login = %v, want errKimiSignedOut", err)
	}
	if posts.Load() != 1 {
		t.Fatal("a signed-out login was refreshed")
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// Where Kimi Code takes no lock, there is nothing to refresh beside, so the runner never refreshes.
func TestKimiUsageReadDoesNotRefreshWhereTheCLITakesNoLock(t *testing.T) {
	installFakeKimiVersion(t, "2.1.1-orbit-test")
	t.Setenv("KIMI_DISABLE_OAUTH_LOCK", "1")
	svc := newFakeKimiService(t)
	home := t.TempDir()
	signInFakeKimi(t, home, svc, "at-expired", "rt-0", time.Now().Add(-time.Hour).Unix())
	if _, err := (&kimiUsageRead{}).fetch(context.Background(), svc.Client(), home); err == nil || !strings.Contains(err.Error(), "no refresh lock") {
		t.Fatalf("read = %v, want an expired token left to the CLI", err)
	}
	if len(svc.granted()) != 0 || len(svc.usages()) != 0 {
		t.Fatal("refreshed, or read with an expired token, where the CLI takes no lock")
	}
}

// Each account is read from its own home with its own token; the heartbeat carries Default's windows
// as planUsage.kimi's own and the added account's under its id, and a removed account is read no more.
func TestKimiAccountUsageReportsEveryAccountUnderPlanUsageKimi(t *testing.T) {
	defaultHome, _ := kimiAccountTestHomes(t)
	svc := newFakeKimiService(t)
	svc.usagesBody = `{"usages":{"limit_5h":{"used_ratio":0.2,"reset_time":"2026-10-08T17:00:00Z"},"limit_month_total":{"used_ratio":0.6,"reset_time":"2026-11-01T00:00:00Z"}}}`
	signInFakeKimi(t, defaultHome, svc, "at-default", "rt-default", time.Now().Add(10*time.Minute).Unix())
	work, err := kimiAccountKind.create("Work")
	if err != nil {
		t.Fatal(err)
	}
	svcWork := newFakeKimiService(t)
	svcWork.usagesBody = `{"usages":{"limit_5h":{"used_ratio":1,"reset_time":"2026-10-08T15:00:00Z"},"limit_7d":{"used_ratio":0.3,"reset_time":"2026-10-13T00:00:00Z"}}}`
	signInFakeKimi(t, work.Dir, svcWork, "at-work", "rt-work", time.Now().Add(10*time.Minute).Unix())

	usage := newKimiAccountUsage()
	usage.syncSlots(context.Background(), func(context.Context, *planUsageProbe) {})
	readKimiProbe(t, usage.def)
	readKimiProbe(t, usage.slot(work.ID).probe)

	wire, err := json.Marshal(HeartbeatRequest{PlanUsage: combinePlanUsage(nil, nil, usage.snapshot())})
	if err != nil {
		t.Fatal(err)
	}
	var hb struct {
		PlanUsage struct {
			Provider string `json:"provider"`
			Kimi     *struct {
				Provider  string                     `json:"provider"`
				FiveHour  *PlanUsageWindow           `json:"fiveHour"`
				Month     *PlanUsageWindow           `json:"month"`
				FetchedAt string                     `json:"fetchedAt"`
				Accounts  map[string]json.RawMessage `json:"accounts"`
			} `json:"kimi"`
		} `json:"planUsage"`
	}
	if err := json.Unmarshal(wire, &hb); err != nil {
		t.Fatal(err)
	}
	kimi := hb.PlanUsage.Kimi
	if hb.PlanUsage.Provider != "" || kimi == nil || kimi.Provider != providerKimi || kimi.FetchedAt == "" {
		t.Fatalf("planUsage = %s, want Kimi's snapshot nested under kimi", wire)
	}
	if kimi.FiveHour == nil || kimi.FiveHour.Utilization != 20 || kimi.Month == nil || kimi.Month.Utilization != 60 {
		t.Fatalf("Default's windows = %s", wire)
	}
	if len(kimi.Accounts) != 1 || !strings.Contains(string(kimi.Accounts[work.ID]), `"fiveHour":{"utilization":100,"resetsAt":"2026-10-08T15:00:00Z"}`) {
		t.Fatalf("accounts = %s, want Work's own windows under its id", wire)
	}
	if svc.usages()[0] != "Bearer at-default" || svcWork.usages()[0] != "Bearer at-work" {
		t.Fatalf("tokens = %q / %q, want each account's own", svc.usages(), svcWork.usages())
	}

	if err := removeAccount(kimiAccountKind, nil, nil, usage, work.ID, nil); err != nil {
		t.Fatal(err)
	}
	if got := usage.snapshot(); got == nil || got.Accounts != nil {
		t.Fatalf("snapshot after removal = %#v, want Default's alone", got)
	}
	usage.syncSlots(context.Background(), func(context.Context, *planUsageProbe) {
		t.Fatal("a read loop was started for a removed account")
	})
}

func TestCombinePlanUsageNestsKimiAlways(t *testing.T) {
	claude := &PlanUsage{Provider: providerClaude, FetchedAt: "2026-10-08T10:00:00Z"}
	kimi := &PlanUsage{Provider: providerKimi, FetchedAt: "2026-10-08T11:00:00Z"}
	if got := combinePlanUsage(claude, nil, nil); got != claude {
		t.Fatalf("a lone Claude snapshot = %#v, want the payload itself, as before", got)
	}
	got := combinePlanUsage(claude, nil, kimi)
	if got.Provider != "" || got.Claude != claude || got.Kimi != kimi || got.Codex != nil || got.FetchedAt != kimi.FetchedAt {
		t.Fatalf("combinePlanUsage(claude, nil, kimi) = %#v", got)
	}
	if got := combinePlanUsage(nil, nil, kimi); got.Kimi != kimi || got.Provider != "" {
		t.Fatalf("a lone Kimi snapshot = %#v, want it under kimi", got)
	}
}

// A Kimi window that resets is read again shortly after, monthly ones included.
func TestPlanUsageRefreshDueAfterAKimiWindowResets(t *testing.T) {
	now := time.Date(2026, 10, 31, 23, 0, 0, 0, time.UTC)
	usage := combinePlanUsage(nil, nil, &PlanUsage{Provider: providerKimi, MonthCode: &PlanUsageWindow{Utilization: 100, ResetsAt: "2026-11-01T00:00:00Z"}})
	if reset, ok := nextPlanUsageResetAfter(usage, now); !ok || !reset.Equal(time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("next reset = %v, %v", reset, ok)
	}
	if planUsageRefreshDue(now, usage, now.Add(61*time.Minute), 10*time.Hour) != true {
		t.Fatal("not read again after the monthly window reset")
	}
}

// kimiPlanUsageFixture is Kimi Code quota from end to end (src/shared/src/kimi-plan-usage.fixture.json):
// @orbit/shared's planUsage.spec.ts decides from each case's planUsage what the case says.
const kimiPlanUsageFixture = "../shared/src/kimi-plan-usage.fixture.json"

// For each case's raw /usages readings — Default's and an added account's — the runner sends that
// case's planUsage: Kimi's snapshot nested under kimi, Default's windows its own, the account's under
// its id.
func TestKimiPlanUsageFixture(t *testing.T) {
	b, err := os.ReadFile(kimiPlanUsageFixture)
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Cases []struct {
			Name      string                     `json:"name"`
			Usages    map[string]json.RawMessage `json:"usages"`
			PlanUsage json.RawMessage            `json:"planUsage"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(b, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Cases) == 0 {
		t.Fatal("no cases")
	}
	for _, c := range fixture.Cases {
		t.Run(c.Name, func(t *testing.T) {
			usage := newKimiAccountUsage()
			for id, body := range c.Usages {
				read, err := parseKimiPlanUsage(body)
				if err != nil {
					t.Fatal(err)
				}
				if id == accountSlotDefaultID {
					usage.def.store(read)
				} else {
					usage.slot(id).probe.store(read)
				}
			}
			wire, err := json.Marshal(combinePlanUsage(nil, nil, usage.snapshot()))
			if err != nil {
				t.Fatal(err)
			}
			var got, want any
			if err := json.Unmarshal(wire, &got); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(c.PlanUsage, &want); err != nil {
				t.Fatal(err)
			}
			if got = withoutFetchedAt(got); !reflect.DeepEqual(got, want) {
				t.Fatalf("planUsage =\n%s\nwant\n%s", wire, c.PlanUsage)
			}
		})
	}
}

// withoutFetchedAt is v with every fetchedAt taken out: when a reading was made is not the fixture's.
func withoutFetchedAt(v any) any {
	m, ok := v.(map[string]any)
	if !ok {
		return v
	}
	delete(m, "fetchedAt")
	for k, inner := range m {
		m[k] = withoutFetchedAt(inner)
	}
	return m
}
