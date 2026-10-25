package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"os"
	"strings"
	"testing"
	"time"
)

// The Go verifier accepts and refuses exactly the tokens the apiserver's verifyRunnerLinkToken does, for the same
// reasons: testdata/a3-tokens.json holds tokens signed by runner-link-token.ts and that module's verdict on each
// (scripts/runner-link/gen-token-fixtures.mjs).
func TestVerifierAgreesWithTheApiserver(t *testing.T) {
	raw, err := os.ReadFile("testdata/a3-tokens.json")
	if err != nil {
		t.Fatal(err)
	}
	var fx struct {
		PublicKeyPem string `json:"publicKeyPem"`
		Kid          string `json:"kid"`
		Cases        []struct {
			Name    string         `json:"name"`
			Token   string         `json:"token"`
			NowMs   int64          `json:"nowMs"`
			Verdict string         `json:"verdict"`
			Claims  map[string]any `json:"claims"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatal(err)
	}
	keys, err := parsePublicKeys(fx.PublicKeyPem)
	if err != nil {
		t.Fatal(err)
	}
	if got := keyThumbprint(keys[0]); got != fx.Kid {
		t.Fatalf("thumbprint %s, the apiserver's kid %s", got, fx.Kid)
	}
	v := newTokenVerifier(keys)
	if len(fx.Cases) < 20 {
		t.Fatalf("only %d cases", len(fx.Cases))
	}
	for _, c := range fx.Cases {
		t.Run(c.Name, func(t *testing.T) {
			claims, err := v.verifySignedToken(c.Token, time.UnixMilli(c.NowMs))
			got := "OK"
			if err != nil {
				got = string(refusalOf(err))
			}
			if got != c.Verdict {
				t.Fatalf("verdict %s, the apiserver's %s (err %v)", got, c.Verdict, err)
			}
			if c.Verdict != "OK" {
				return
			}
			for _, name := range []string{"runnerId", "ownerId", "cellId", "leaseOwner", "credential", "jti"} {
				var s string
				_ = json.Unmarshal(claims[name], &s)
				if s != c.Claims[name] {
					t.Errorf("%s = %q, the apiserver's %q", name, s, c.Claims[name])
				}
			}
		})
	}
}

// testKeys is a signing key and the verifier for it, for tokens a test makes itself.
type testKeys struct {
	priv ed25519.PrivateKey
	pub  ed25519.PublicKey
}

func newTestKeys(t testing.TB) testKeys {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return testKeys{priv: priv, pub: pub}
}

// sign makes a token the way runner-link-token.ts does.
func (k testKeys) sign(claims map[string]any) string {
	seg := func(v any) string {
		b, _ := json.Marshal(v)
		return base64.RawURLEncoding.EncodeToString(b)
	}
	input := seg(map[string]any{"alg": "EdDSA", "typ": "JWT", "kid": keyThumbprint(k.pub)}) + "." + seg(claims)
	return input + "." + base64.RawURLEncoding.EncodeToString(ed25519.Sign(k.priv, []byte(input)))
}

func tokenClaims(runner, process string, exp time.Time) map[string]any {
	return map[string]any{
		"aud": linkAudience, "jti": "jti-" + runner + "-" + process, "runnerId": runner, "ownerId": "owner-1",
		"cellId": "cell-1", "linkUrl": "wss://link.test.invalid", "leaseOwner": process,
		"credential": "cred-" + runner, "iat": exp.Add(-time.Hour).Unix(), "exp": exp.Unix(),
	}
}

func TestVerifyMakesTheGatewaysOwnChecks(t *testing.T) {
	k := newTestKeys(t)
	v := newTokenVerifier([]ed25519.PublicKey{k.pub})
	deny := &denyList{set: map[string]struct{}{}}
	now := time.Now()
	exp := now.Add(time.Hour)

	good := tokenClaims("r1", "0190a0b0-0000-4000-8000-000000000003", exp)
	c, err := v.verify(k.sign(good), "cell-1", deny, now)
	if err != nil {
		t.Fatal(err)
	}
	if c.RunnerID != "r1" || c.Credential != "cred-r1" || c.ExpiresAt.Unix() != exp.Unix() {
		t.Fatalf("claims %+v", c)
	}

	check := func(name string, token, cell string, want tokenRefusal) {
		t.Helper()
		_, err := v.verify(token, cell, deny, now)
		if got := refusalOf(err); err == nil || got != want {
			t.Errorf("%s: refused %v (%v), want %s", name, got, err, want)
		}
	}
	check("no token", "", "cell-1", refuseMissing)
	check("another cell", k.sign(good), "cell-2", refuseCell)
	for _, name := range []string{"runnerId", "leaseOwner", "credential", "cellId"} {
		missing := tokenClaims("r1", "p1", exp)
		delete(missing, name)
		check("no "+name, k.sign(missing), "cell-1", refuseClaims)
	}
	deny.replace(map[string]struct{}{"cred-r1": {}})
	check("revoked credential", k.sign(good), "cell-1", refuseRevoked)
	deny.replace(map[string]struct{}{})
	if _, err := v.verify(k.sign(good), "cell-1", deny, now); err != nil {
		t.Fatalf("a credential that left the list vouches again: %v", err)
	}
}

func TestTwoKeysWhileTheSigningKeyIsReplaced(t *testing.T) {
	old, next := newTestKeys(t), newTestKeys(t)
	v := newTokenVerifier([]ed25519.PublicKey{old.pub, next.pub})
	deny := &denyList{set: map[string]struct{}{}}
	claims := tokenClaims("r1", "p1", time.Now().Add(time.Hour))
	for name, k := range map[string]testKeys{"old": old, "new": next} {
		if _, err := v.verify(k.sign(claims), "cell-1", deny, time.Now()); err != nil {
			t.Errorf("token signed by the %s key refused: %v", name, err)
		}
	}
	stranger := newTestKeys(t)
	if _, err := v.verify(stranger.sign(claims), "cell-1", deny, time.Now()); refusalOf(err) != refuseSignature {
		t.Errorf("a key the gateway does not hold: %v", err)
	}
}

func TestPublicKeysConfiguration(t *testing.T) {
	k := newTestKeys(t)
	pemText := publicPEM(t, k.pub)
	if keys, err := parsePublicKeys(pemText); err != nil || len(keys) != 1 {
		t.Fatalf("PEM: %v %v", keys, err)
	}
	b64 := base64.StdEncoding.EncodeToString([]byte(pemText))
	k2 := newTestKeys(t)
	two := b64 + "," + base64.StdEncoding.EncodeToString([]byte(publicPEM(t, k2.pub)))
	if keys, err := parsePublicKeys(two); err != nil || len(keys) != 2 {
		t.Fatalf("two base64 keys: %v %v", keys, err)
	}
	if keys, err := parsePublicKeys(publicPEM(t, k.pub) + publicPEM(t, k2.pub)); err != nil || len(keys) != 2 {
		t.Fatalf("two PEM blocks: %v %v", keys, err)
	}
	if _, err := parsePublicKeys(""); err == nil {
		t.Error("no key accepted")
	}
	der, err := x509.MarshalPKCS8PrivateKey(k.priv)
	if err != nil {
		t.Fatal(err)
	}
	priv := string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
	if _, err := parsePublicKeys(priv); err == nil || !strings.Contains(err.Error(), "private key") {
		t.Errorf("a private key: %v", err)
	}
}
