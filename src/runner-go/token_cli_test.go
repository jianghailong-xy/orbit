package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// fakeServiceToken builds a token shaped like a minted one. Nothing client-side verifies the
// signature — the control plane is the only authority — so an unsigned third segment is enough
// to exercise every local path.
func fakeServiceToken(t *testing.T, scopes []string, agentID string, expiresIn time.Duration) string {
	t.Helper()
	payload, err := json.Marshal(map[string]interface{}{
		"scopes":  scopes,
		"agentId": agentID,
		"exp":     time.Now().Add(expiresIn).Unix(),
	})
	if err != nil {
		t.Fatal(err)
	}
	return "header." + base64.RawURLEncoding.EncodeToString(payload) + ".signature"
}

func TestTokenCLIMintValidatesScopesTTLAndAgentPin(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	tests := []struct {
		name      string
		args      []string
		wantError string
	}{
		{name: "no scope", args: []string{"mint"}, wantError: "--scope is required"},
		{name: "unknown scope", args: []string{"mint", "--scope", "session:end"}, wantError: `unknown scope "session:end"`},
		{name: "destructive scope", args: []string{"mint", "--scope", "session:interrupt"}, wantError: "unknown scope"},
		{
			name:      "create without agent pin",
			args:      []string{"mint", "--scope", "session:create"},
			wantError: "--agent-id is required with the session:create scope",
		},
		{
			name:      "ttl too long",
			args:      []string{"mint", "--scope", "session:get", "--ttl", "365d"},
			wantError: "--ttl must be between 1m and 90d",
		},
		{
			name:      "ttl unparseable",
			args:      []string{"mint", "--scope", "session:get", "--ttl", "soon"},
			wantError: "--ttl must be a duration",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var out bytes.Buffer
			err := cmdTokenCLI(tc.args, &out)
			if err == nil || !strings.Contains(err.Error(), tc.wantError) {
				t.Fatalf("error = %v, want containing %q", err, tc.wantError)
			}
			if out.Len() != 0 {
				t.Fatalf("rejected mint wrote output: %q", out.String())
			}
		})
	}
}

func TestTokenCLIMintSendsScopesAndPrintsTokenOnce(t *testing.T) {
	var body map[string]interface{}
	var authorization string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/runner/service-tokens" {
			t.Errorf("request = %s %s", r.Method, r.URL.Path)
		}
		authorization = r.Header.Get("Authorization")
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"id":"token-1","token":"minted.jwt.value","scopes":["session:get","session:create"],"agentId":"agent-1","expiresAt":"2026-08-05T00:00:00.000Z"}`))
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	args := []string{"mint", "--scope", "session:get,session:create", "--agent-id", "agent-1", "--ttl", "2h", "--label", "feishu bridge"}
	if err := cmdTokenCLI(args, &out); err != nil {
		t.Fatal(err)
	}
	// Minting authenticates as the MACHINE: a service token can never mint another.
	if authorization != "Bearer runner-secret" {
		t.Errorf("authorization = %q, want the runner credential", authorization)
	}
	scopes, _ := body["scopes"].([]interface{})
	if len(scopes) != 2 || scopes[0] != "session:get" || scopes[1] != "session:create" {
		t.Errorf("scopes = %#v", body["scopes"])
	}
	if body["agentId"] != "agent-1" || body["label"] != "feishu bridge" {
		t.Errorf("body = %#v", body)
	}
	if body["ttlSeconds"] != float64(2*60*60) {
		t.Errorf("ttlSeconds = %#v, want 7200", body["ttlSeconds"])
	}
	printed := out.String()
	for _, want := range []string{"minted.jwt.value", "Shown once", envServiceToken, "orbit token revoke token-1"} {
		if !strings.Contains(printed, want) {
			t.Errorf("mint output %q is missing %q", printed, want)
		}
	}
}

func TestTokenCLIRevokeRequiresAnExplicitId(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	var out bytes.Buffer
	if err := cmdTokenCLI([]string{"revoke"}, &out); err == nil || !strings.Contains(err.Error(), "token id is required") {
		t.Fatalf("error = %v", err)
	}

	var path string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.Method + " " + r.URL.Path
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"id":"token-1","revokedAt":"2026-08-04T00:00:00.000Z"}`))
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)
	out.Reset()
	if err := cmdTokenCLI([]string{"revoke", "token-1", "--json"}, &out); err != nil {
		t.Fatal(err)
	}
	if path != "DELETE /api/runner/service-tokens/token-1" {
		t.Fatalf("request = %q", path)
	}
}

func TestServiceTokenClaimsAreReadLocallyForDiscoveryOnly(t *testing.T) {
	valid := fakeServiceToken(t, []string{"session:get", "session:create", "session:end"}, "agent-1", time.Hour)
	claims := decodeServiceTokenClaims(valid)
	if claims == nil {
		t.Fatal("valid token did not decode")
	}
	// A scope this CLI does not know about is dropped rather than surfaced: capabilities must
	// never advertise something the control plane would refuse.
	if strings.Join(claims.Scopes, ",") != "session:create,session:get" {
		t.Errorf("scopes = %#v", claims.Scopes)
	}
	if claims.AgentID != "agent-1" {
		t.Errorf("agentId = %q", claims.AgentID)
	}
	if decodeServiceTokenClaims(fakeServiceToken(t, []string{"session:get"}, "", -time.Minute)) != nil {
		t.Error("an expired token must not describe itself as usable")
	}
	for _, malformed := range []string{"", "not-a-jwt", "a.b", "a.!!!.c"} {
		if decodeServiceTokenClaims(malformed) != nil {
			t.Errorf("malformed token %q decoded", malformed)
		}
	}
}
