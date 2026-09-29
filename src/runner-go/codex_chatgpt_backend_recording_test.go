package main

// What the official codex CLI sends to ChatGPT's Codex backend, and what it makes of the answers, read
// off the installed engine.
//
// A pool of the account owner's own ChatGPT login (migrations 0323/0324) runs its sessions' codex on the
// configured provider "orbit", pointed at the pool gateway, and the gateway sends each request on to
// https://chatgpt.com/backend-api/codex with the login's credential in place of the session token
// (src/apiserver/src/providers/pool-gateway.service.ts). What that backend is sent, how it answers and
// what codex does with the answers are claims about the official CLI signed in with a ChatGPT login, so
// they are measured here: a real `codex app-server` signed in with a login of fake, unsigned tokens
// naming a fake account, its ChatGPT backend a recorder behind TLS on this machine, and every other host
// sent to a proxy that is not there — nothing leaves the machine and no account is involved.
//
// Four exchanges, each on a codex of its own:
//
//   - turn: the turn's request — POST <backend>/codex/responses with `Authorization: Bearer <access
//     token>` and `ChatGPT-Account-ID: <account id>`, and whatever else codex sends there — and the
//     stream it completes its turn on, with the x-codex-* window headers it reads its limits from;
//   - refresh: codex's own recovery from a 401 — the refresh it sends to the token endpoint
//     (CODEX_REFRESH_TOKEN_URL_OVERRIDE stands where https://auth.openai.com/oauth/token does) and the
//     request sent again on the access token that came back;
//   - usage limit: a 429 `usage_limit_reached` naming `resets_at` — codex reports usageLimitExceeded and
//     does not ask again;
//   - rate limit: a 429 `rate_limit_exceeded` — codex does not ask again either, which is why the gateway
//     waits one out on the same login itself.
//
// Before a turn codex 0.158 asks the backend where the account's workspace lives
// (GET <backend>/wham/accounts/check): the recorder answers NO_CONSTRAINT, a personal workspace's
// answer, which keeps codex on the backend it was configured with. It tries a websocket first; the
// recorder answers 426, on which codex goes to HTTPS at once.
//
// With ORBIT_RECORD_CODEX_CHATGPT_FIXTURE=<file> it writes the four exchanges to that file, which
// src/apiserver/src/providers/pool-login-gateway.pg.spec.ts replays through the real gateway. Re-record
// it when codex is upgraded:
//
//   env -u ORBIT_SESSION_ID -u ORBIT_TASK_ID -u ORBIT_AGENT_ID \
//     ORBIT_RECORD_CODEX_CHATGPT_FIXTURE=$PWD/../apiserver/src/providers/fixtures/codex-chatgpt-backend-recording.json \
//     go test -run TestRealCodexOnAChatGPTLogin -count=1 .
//
// It skips without a `codex` on PATH.

import (
	"bufio"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

// The login's fakes. Unsigned JWTs whose claims name an account nobody has; codex reads the claims and
// never verifies a signature, and nothing it holds reaches anything but the recorder.
const (
	recordedChatGPTAccount = "acct-RECORDED-0000-1111"
	recordedChatGPTEmail   = "owner@recorded.invalid"
	recordedRefreshToken   = "rt_RECORDEDxRECORDEDxRECORDED"
	recordedRefreshedToken = "rt_REFRESHEDxREFRESHEDxREFRESHED"
	// The official CLI's OAuth client (codex-rs login CLIENT_ID), which its refresh names.
	codexOAuthClientID = "app_EMoamEEZ73f0CkXaXp7hrann"
	// Where the window headers say the spent limit resets: far enough ahead that a replay of the fixture
	// is never looking at a reset that has passed.
	recordedResetsAt = int64(4102444800) // 2100-01-01T00:00:00Z
)

func recordedJWT(claims map[string]interface{}) string {
	part := func(v interface{}) string {
		data, _ := json.Marshal(v)
		return base64.RawURLEncoding.EncodeToString(data)
	}
	return part(map[string]interface{}{"alg": "RS256", "typ": "JWT"}) + "." + part(claims) + ".signature"
}

func recordedLoginClaims(fresh bool) map[string]interface{} {
	now := time.Now().Unix()
	claims := map[string]interface{}{
		"email": recordedChatGPTEmail,
		"iat":   now,
		"exp":   now + 10*24*3600,
		"https://api.openai.com/auth": map[string]interface{}{
			"chatgpt_account_id": recordedChatGPTAccount,
			"chatgpt_plan_type":  "plus",
			"chatgpt_user_id":    "user-RECORDED",
		},
	}
	if fresh {
		// Only so the recorder can tell the refreshed access token from the first one.
		claims["orbit_recorded"] = "refreshed"
	}
	return claims
}

// The x-codex-* window headers of a ChatGPT subscription, as codex-api rate_limits.rs reads them.
func recordedWindowHeaders(primaryUsed string) [][2]string {
	return [][2]string{
		{"x-codex-primary-used-percent", primaryUsed},
		{"x-codex-primary-window-minutes", "300"},
		{"x-codex-primary-reset-at", fmt.Sprint(recordedResetsAt)},
		{"x-codex-secondary-used-percent", "64.0"},
		{"x-codex-secondary-window-minutes", "10080"},
		{"x-codex-secondary-reset-at", fmt.Sprint(recordedResetsAt + 3*24*3600)},
	}
}

// What codex said about a turn, off its app-server notifications.
type recordedCodexVerdict struct {
	TurnStatus     string      `json:"turnStatus"`
	Requests       int         `json:"requests"`
	ErrorMessage   string      `json:"errorMessage,omitempty"`
	CodexErrorInfo interface{} `json:"codexErrorInfo,omitempty"`
	WillRetry      bool        `json:"willRetry"`
	// The limits codex reported off the answer's window headers (account/rateLimits/updated).
	RateLimits interface{} `json:"rateLimits,omitempty"`
}

type chatgptRecordedExchange struct {
	Request  recordedExchange `json:"request"`
	Response recordedAnswer   `json:"response"`
}

type chatgptRecording struct {
	Note  string `json:"note"`
	Codex string `json:"codex"`
	// The fake login codex held: an account id, and the refresh token its refresh names. The access
	// tokens are in the requests' own headers.
	Account      string `json:"account"`
	RefreshToken string `json:"refreshToken"`
	// What the recorder answered codex's workspace routing with.
	Routing json.RawMessage `json:"routing"`
	Turn    struct {
		chatgptRecordedExchange
		Codex recordedCodexVerdict `json:"codex"`
	} `json:"turn"`
	Refresh struct {
		// The backend's 401, the refresh codex sent for it and its answer, and the turn sent again.
		Rejected chatgptRecordedExchange `json:"rejected"`
		Token    chatgptRecordedExchange `json:"token"`
		Resent   recordedExchange        `json:"resent"`
		Codex    recordedCodexVerdict    `json:"codex"`
	} `json:"refresh"`
	UsageLimit struct {
		chatgptRecordedExchange
		Codex recordedCodexVerdict `json:"codex"`
	} `json:"usageLimit"`
	RateLimit struct {
		chatgptRecordedExchange
		Codex recordedCodexVerdict `json:"codex"`
	} `json:"rateLimit"`
}

// chatgptRecorder stands where https://chatgpt.com/backend-api and the token endpoint stand, keeping
// every request codex sends and every answer it gives the turn's requests.
type chatgptRecorder struct {
	scenario string
	mu       sync.Mutex
	seen     []chatgptRecordedExchange
	routing  []byte
	// The access token the login starts with, and the one the refresh hands out — so a request sent on
	// the second can be told from one on the first.
	access          string
	refreshedAccess string
}

func recordedHeaders(r *http.Request) [][2]string {
	headers := make([][2]string, 0, len(r.Header)+1)
	for name, values := range r.Header {
		for _, value := range values {
			headers = append(headers, [2]string{strings.ToLower(name), value})
		}
	}
	headers = append(headers, [2]string{"host", r.Host})
	sort.Slice(headers, func(i, j int) bool { return headers[i][0] < headers[j][0] })
	return headers
}

func (rec *chatgptRecorder) answer(w http.ResponseWriter, r *http.Request, body []byte, status int, headers [][2]string, out []byte) {
	for _, h := range headers {
		w.Header().Add(h[0], h[1])
	}
	w.WriteHeader(status)
	_, _ = w.Write(out)
	rec.mu.Lock()
	defer rec.mu.Unlock()
	rec.seen = append(rec.seen, chatgptRecordedExchange{
		Request: recordedExchange{
			Method: r.Method, Path: r.URL.RequestURI(), Headers: recordedHeaders(r), BodyBase64: base64.StdEncoding.EncodeToString(body),
		},
		Response: recordedAnswer{Status: status, Headers: headers, BodyBase64: base64.StdEncoding.EncodeToString(out)},
	})
}

func (rec *chatgptRecorder) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	jsonAnswer := func(status int, value interface{}, extra ...[2]string) {
		data, _ := json.Marshal(value)
		rec.answer(w, r, body, status, append([][2]string{{"content-type", "application/json"}}, extra...), data)
	}
	switch {
	case strings.EqualFold(r.Header.Get("Upgrade"), "websocket"):
		// No websocket here: codex goes to HTTPS at once on a 426.
		jsonAnswer(http.StatusUpgradeRequired, map[string]interface{}{"error": map[string]interface{}{"message": "the recorder speaks HTTPS only"}})
	case r.Method == http.MethodGet && r.URL.Path == "/backend-api/wham/accounts/check":
		routing := map[string]interface{}{
			"accounts": []interface{}{map[string]interface{}{
				"id": recordedChatGPTAccount, "name": nil, "plan_type": "plus", "structure": "personal",
				"workspace_backend_origin": "NO_CONSTRAINT", "account_routing_override": "NO_CONSTRAINT",
				"profile_picture_url": nil,
			}},
			"account_ordering":   []string{recordedChatGPTAccount},
			"default_account_id": recordedChatGPTAccount,
		}
		rec.mu.Lock()
		rec.routing, _ = json.Marshal(routing)
		rec.mu.Unlock()
		jsonAnswer(http.StatusOK, routing)
	case r.Method == http.MethodPost && r.URL.Path == "/oauth/token":
		jsonAnswer(http.StatusOK, map[string]interface{}{
			"id_token":      recordedJWT(recordedLoginClaims(true)),
			"access_token":  rec.refreshedAccess,
			"refresh_token": recordedRefreshedToken,
		})
	case r.Method == http.MethodPost && r.URL.Path == "/backend-api/codex/responses":
		var req struct {
			Model string `json:"model"`
		}
		_ = json.Unmarshal(body, &req) // a compressed body names no model; the stream then names its own
		turn := func() {
			rec.answer(w, r, body, http.StatusOK, append([][2]string{
				{"content-type", "text/event-stream; charset=utf-8"}, {"x-request-id", "req_recorded"},
			}, recordedWindowHeaders("42.0")...), recordedResponsesStream(req.Model))
		}
		switch rec.scenario {
		case "turn":
			turn()
		case "refresh":
			if r.Header.Get("Authorization") == "Bearer "+rec.refreshedAccess {
				turn()
				return
			}
			jsonAnswer(http.StatusUnauthorized, map[string]interface{}{"error": map[string]interface{}{
				"message": "Your authentication token has expired. Please try signing in again.",
				"type":    "invalid_request_error", "code": "token_expired", "param": nil,
			}})
		case "usageLimit":
			jsonAnswer(http.StatusTooManyRequests, map[string]interface{}{"error": map[string]interface{}{
				"type": "usage_limit_reached", "message": "The usage limit has been reached", "plan_type": "plus",
				"resets_at": recordedResetsAt,
			}}, recordedWindowHeaders("100.0")...)
		case "rateLimit":
			jsonAnswer(http.StatusTooManyRequests, map[string]interface{}{"error": map[string]interface{}{
				"type": "rate_limit_exceeded", "code": "rate_limit_exceeded",
				"message": "Rate limit reached. Please try again in 2s.",
			}}, [2]string{"retry-after", "2"})
		}
	default:
		// Everything else codex asks a ChatGPT backend for at startup (models, plugins, settings,
		// analytics, its apps MCP server): not what this recording is about, and nothing it needs for a turn.
		jsonAnswer(http.StatusNotFound, map[string]interface{}{"detail": "Not Found"})
	}
}

// runChatGPTScenario drives one real codex app-server, signed in with the fake login, through one turn
// against `rec`, and says what codex said about it.
func runChatGPTScenario(t *testing.T, exe string, server *httptest.Server, caFile string, rec *chatgptRecorder) recordedCodexVerdict {
	t.Helper()
	probe, home := isolatedCodexProbeEnv(t)
	// No key of any kind: the login is the only credential this codex has.
	env := make([]string, 0, len(probe))
	for _, entry := range probe {
		key, _, _ := strings.Cut(entry, "=")
		if key != "OPENAI_API_KEY" && key != "OPENAI_BASE_URL" && key != "CODEX_API_KEY" && !strings.HasPrefix(key, "ORBIT_") {
			env = append(env, entry)
		}
	}
	// Every host but the recorder goes to a proxy that is not there.
	for _, key := range []string{"HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy", "ALL_PROXY", "all_proxy"} {
		env = envWithValue(env, key, "http://127.0.0.1:9")
	}
	env = envWithValue(env, "NO_PROXY", "127.0.0.1,localhost")
	env = envWithValue(env, "no_proxy", "127.0.0.1,localhost")
	env = envWithValue(env, "CODEX_CA_CERTIFICATE", caFile)
	env = envWithValue(env, "CODEX_REFRESH_TOKEN_URL_OVERRIDE", server.URL+"/oauth/token")
	auth, _ := json.Marshal(map[string]interface{}{
		"auth_mode":      "chatgpt",
		"OPENAI_API_KEY": nil,
		"tokens": map[string]interface{}{
			"id_token":      rec.access,
			"access_token":  rec.access,
			"refresh_token": recordedRefreshToken,
			"account_id":    recordedChatGPTAccount,
		},
		"last_refresh": time.Now().UTC().Format(time.RFC3339Nano),
	})
	if err := os.WriteFile(filepath.Join(home, "auth.json"), auth, 0o600); err != nil {
		t.Fatal(err)
	}

	// Production's own builders, with no configured provider: the built-in OpenAI one, on the login.
	job := &ClaimedSession{Agent: AgentExecConfig{Model: "gpt-5.1-codex"}}
	args := append(codexAppServerCommandArgs(job, home+"/state", ""),
		"-c", fmt.Sprintf("openai_base_url=%q", server.URL+"/backend-api/codex"),
		"-c", fmt.Sprintf("chatgpt_base_url=%q", server.URL+"/backend-api/"),
	)
	cmd := exec.Command(exe, args...)
	cmd.Env = env
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Skipf("cannot run %s app-server: %v", exe, err)
	}
	defer func() { stdin.Close(); _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	out := bufio.NewReaderSize(stdout, 1<<20)
	next := 0
	send := func(msg map[string]interface{}) {
		b, _ := json.Marshal(msg)
		if _, err := stdin.Write(append(b, '\n')); err != nil {
			t.Fatalf("write %v: %v", msg["method"], err)
		}
	}
	read := func() codexRPCMessage {
		line, err := out.ReadBytes('\n')
		if err != nil {
			t.Fatalf("reading the app-server: %v", err)
		}
		var msg codexRPCMessage
		if json.Unmarshal(line, &msg) != nil {
			return codexRPCMessage{}
		}
		return msg
	}
	request := func(method string, params map[string]interface{}) codexRPCMessage {
		next++
		id := next
		send(map[string]interface{}{"id": id, "method": method, "params": params})
		for {
			msg := read()
			if msg.Method == "" && fmt.Sprint(msg.ID) == fmt.Sprint(id) {
				return msg
			}
		}
	}
	request("initialize", map[string]interface{}{
		"clientInfo":   map[string]interface{}{"name": "orbit", "title": "Orbit", "version": "0.1.0"},
		"capabilities": map[string]interface{}{"experimentalApi": true},
	})
	send(map[string]interface{}{"method": "initialized", "params": map[string]interface{}{}})

	dir := t.TempDir()
	started := request("thread/start", codexThreadParams(job, dir, dir))
	if started.Error != nil {
		t.Fatalf("thread/start: %v", started.Error.Message)
	}
	threadID := threadIDFromResult(rawObject(started.Result))
	turn := codexTurnParams(threadID, job, dir, dir, "orbit-chatgpt-recording-turn", "Say DONE.", nil, codexTurnContextOptions{})
	if resp := request("turn/start", turn); resp.Error != nil {
		t.Fatalf("turn/start: %v", resp.Error.Message)
	}
	var verdict recordedCodexVerdict
	deadline := time.Now().Add(90 * time.Second)
	for verdict.TurnStatus == "" && time.Now().Before(deadline) {
		msg := read()
		params := rawObject(msg.Params)
		switch msg.Method {
		case "account/rateLimits/updated":
			verdict.RateLimits = params["rateLimits"]
		case "error":
			if willRetry, _ := params["willRetry"].(bool); !willRetry {
				errorObject, _ := params["error"].(map[string]interface{})
				verdict.ErrorMessage, _ = errorObject["message"].(string)
				verdict.CodexErrorInfo = errorObject["codexErrorInfo"]
			} else {
				verdict.WillRetry = true
			}
		case "turn/completed":
			verdict.TurnStatus = strings.ToLower(nestedString(params, "turn", "status"))
		}
	}
	if verdict.TurnStatus == "" {
		t.Fatalf("%s: codex never finished its turn", rec.scenario)
	}
	rec.mu.Lock()
	for _, exchange := range rec.seen {
		if exchange.Request.Method == http.MethodPost && strings.HasPrefix(exchange.Request.Path, "/backend-api/codex/responses") {
			verdict.Requests++
		}
	}
	rec.mu.Unlock()
	return verdict
}

// recorderTLS makes a CA of the test's own and a certificate for 127.0.0.1 it signs, and returns the
// CA as the PEM file codex is told to trust (CODEX_CA_CERTIFICATE) and the certificate the recorder
// serves. Two certificates, because codex's TLS stack refuses a CA certificate presented as a server's
// own — which is what httptest's built-in one is.
func recorderTLS(t *testing.T) (string, tls.Certificate) {
	t.Helper()
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	caTemplate := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "orbit recording CA"},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(24 * time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	caCert, err := x509.ParseCertificate(caDER)
	if err != nil {
		t.Fatal(err)
	}
	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	leafDER, err := x509.CreateCertificate(rand.Reader, &x509.Certificate{
		SerialNumber:          big.NewInt(2),
		Subject:               pkix.Name{CommonName: "127.0.0.1"},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(24 * time.Hour),
		IPAddresses:           []net.IP{net.ParseIP("127.0.0.1")},
		DNSNames:              []string{"localhost"},
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}, caCert, &leafKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	caFile := filepath.Join(t.TempDir(), "recorder-ca.pem")
	if err := os.WriteFile(caFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER}), 0o600); err != nil {
		t.Fatal(err)
	}
	return caFile, tls.Certificate{Certificate: [][]byte{leafDER}, PrivateKey: leafKey}
}

func headerOf(headers [][2]string, name string) string {
	for _, h := range headers {
		if h[0] == name {
			return h[1]
		}
	}
	return ""
}

// The exchanges of `rec` that were `method path`, in order.
func (rec *chatgptRecorder) exchanges(method, path string) []chatgptRecordedExchange {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	var found []chatgptRecordedExchange
	for _, exchange := range rec.seen {
		if exchange.Request.Method == method && strings.SplitN(exchange.Request.Path, "?", 2)[0] == path {
			found = append(found, exchange)
		}
	}
	return found
}

func TestRealCodexOnAChatGPTLogin(t *testing.T) {
	exe, err := exec.LookPath("codex")
	if err != nil {
		t.Skip("no codex on PATH; this recording needs a real app-server")
	}
	caFile, serving := recorderTLS(t)
	record := func(scenario string) (*chatgptRecorder, recordedCodexVerdict) {
		rec := &chatgptRecorder{
			scenario: scenario, access: recordedJWT(recordedLoginClaims(false)), refreshedAccess: recordedJWT(recordedLoginClaims(true)),
		}
		server := httptest.NewUnstartedServer(rec)
		server.TLS = &tls.Config{Certificates: []tls.Certificate{serving}}
		server.StartTLS()
		t.Cleanup(server.Close)
		return rec, runChatGPTScenario(t, exe, server, caFile, rec)
	}
	const responses = "/backend-api/codex/responses"
	access := func(exchange chatgptRecordedExchange) string {
		return headerOf(exchange.Request.Headers, "authorization")
	}

	// The turn: POST <backend>/codex/responses, on the login's credential and account.
	turnRec, turnVerdict := record("turn")
	if turnVerdict.TurnStatus != "completed" {
		t.Fatalf("codex did not complete its turn on the recorded stream (%+v)", turnVerdict)
	}
	turns := turnRec.exchanges(http.MethodPost, responses)
	if len(turns) != 1 {
		t.Fatalf("codex sent the backend %d turn requests, want 1", len(turns))
	}
	if got := access(turns[0]); got != "Bearer "+turnRec.access {
		t.Fatalf("codex authenticated its turn with %q, not the login's access token", got)
	}
	if got := headerOf(turns[0].Request.Headers, "chatgpt-account-id"); got != recordedChatGPTAccount {
		t.Fatalf("codex named the account %q, want %q", got, recordedChatGPTAccount)
	}

	// A 401: codex refreshes on the token endpoint, and sends the turn again on what came back.
	refreshRec, refreshVerdict := record("refresh")
	if refreshVerdict.TurnStatus != "completed" {
		t.Fatalf("codex did not recover from the 401 (%+v)", refreshVerdict)
	}
	tokens := refreshRec.exchanges(http.MethodPost, "/oauth/token")
	if len(tokens) != 1 {
		t.Fatalf("codex refreshed %d times, want 1", len(tokens))
	}
	sent, _ := base64.StdEncoding.DecodeString(tokens[0].Request.BodyBase64)
	var refresh map[string]interface{}
	if err := json.Unmarshal(sent, &refresh); err != nil {
		t.Fatalf("codex's refresh is not JSON: %q", sent)
	}
	want := map[string]interface{}{"client_id": codexOAuthClientID, "grant_type": "refresh_token", "refresh_token": recordedRefreshToken}
	if fmt.Sprint(refresh) != fmt.Sprint(want) {
		t.Fatalf("codex's refresh is %v, want %v", refresh, want)
	}
	if got := headerOf(tokens[0].Request.Headers, "content-type"); got != "application/json" {
		t.Fatalf("codex's refresh is sent as %q", got)
	}
	attempts := refreshRec.exchanges(http.MethodPost, responses)
	resent := attempts[len(attempts)-1]
	if access(resent) != "Bearer "+refreshRec.refreshedAccess || resent.Response.Status != http.StatusOK {
		t.Fatalf("codex did not send the turn again on the refreshed access token")
	}

	// A spent subscription: usageLimitExceeded, and not asked again.
	usageRec, usageVerdict := record("usageLimit")
	if usageVerdict.Requests != 1 || usageVerdict.TurnStatus != "failed" || fmt.Sprint(usageVerdict.CodexErrorInfo) != "usageLimitExceeded" {
		t.Fatalf("codex on usage_limit_reached: %+v", usageVerdict)
	}

	// A rate limit: not asked again either.
	rateRec, rateVerdict := record("rateLimit")
	if rateVerdict.Requests != 1 || rateVerdict.TurnStatus != "failed" {
		t.Fatalf("codex on rate_limit_exceeded: %+v", rateVerdict)
	}

	target := os.Getenv("ORBIT_RECORD_CODEX_CHATGPT_FIXTURE")
	if target == "" {
		return
	}
	version, _ := exec.Command(exe, "--version").Output()
	var fixture chatgptRecording
	fixture.Note = "Written by src/runner-go/codex_chatgpt_backend_recording_test.go from a real codex app-server signed in " +
		"with a fake ChatGPT login against a recorder; replayed through the real gateway by pool-login-gateway.pg.spec.ts. " +
		"Re-record on a codex upgrade."
	fixture.Codex = strings.TrimSpace(string(version))
	fixture.Account = recordedChatGPTAccount
	fixture.RefreshToken = recordedRefreshToken
	fixture.Routing = turnRec.routing
	fixture.Turn.chatgptRecordedExchange = turns[0]
	fixture.Turn.Codex = turnVerdict
	fixture.Refresh.Rejected = attempts[0]
	fixture.Refresh.Token = tokens[0]
	fixture.Refresh.Resent = resent.Request
	fixture.Refresh.Codex = refreshVerdict
	fixture.UsageLimit.chatgptRecordedExchange = usageRec.exchanges(http.MethodPost, responses)[0]
	fixture.UsageLimit.Codex = usageVerdict
	fixture.RateLimit.chatgptRecordedExchange = rateRec.exchanges(http.MethodPost, responses)[0]
	fixture.RateLimit.Codex = rateVerdict
	data, err := json.MarshalIndent(fixture, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, append(data, '\n'), 0o644); err != nil {
		t.Fatalf("writing the fixture: %v", err)
	}
	t.Logf("recorded %s against a ChatGPT login to %s", fixture.Codex, target)
}
