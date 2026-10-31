package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"
)

// Link tokens as the apiserver mints them (signRunnerLinkToken, src/apiserver/src/runner-api/runner-link-token.ts): a
// compact JWS, EdDSA over Ed25519, with the key's RFC 7638 thumbprint as its kid and the same claims in the same order.
// The gateway verifies them with the public half alone (src/link-gateway/token.go).
//
// A runner token here is not a secret anyone stores: linkstub.<runnerId>.<ownerId>, which `linkstub fleet` writes. The
// stub reads the runner and its owner from it, so it needs no fleet and no database to mint for any runner.

const (
	linkAudience      = "orbit-runner-link"
	runnerTokenPrefix = "linkstub."
)

// readSigningKey reads an Ed25519 private key in PKCS #8 PEM, as `openssl genpkey -algorithm ed25519` writes it, the
// form of the apiserver's RUNNER_LINK_SIGNING_KEY.
func readSigningKey(path string) (ed25519.PrivateKey, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(data)
	if block == nil {
		return nil, fmt.Errorf("%s holds no PEM block", path)
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("%s: %v", path, err)
	}
	key, ok := parsed.(ed25519.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("%s holds a key that is not Ed25519", path)
	}
	return key, nil
}

// keyThumbprint is a key's RFC 7638 thumbprint, the kid the apiserver puts in each token's header.
func keyThumbprint(pub ed25519.PublicKey) string {
	jwk := fmt.Sprintf(`{"crv":"Ed25519","kty":"OKP","x":"%s"}`, base64.RawURLEncoding.EncodeToString(pub))
	sum := sha256.Sum256([]byte(jwk))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func runnerToken(runnerID, ownerID string) string {
	return runnerTokenPrefix + runnerID + "." + ownerID
}

// parseRunnerToken reads the runner and owner a runner token names.
func parseRunnerToken(token string) (runnerID, ownerID string, ok bool) {
	rest, found := strings.CutPrefix(token, runnerTokenPrefix)
	if !found {
		return "", "", false
	}
	runnerID, ownerID, found = strings.Cut(rest, ".")
	if !found || !isUUID(runnerID) || !isUUID(ownerID) {
		return "", "", false
	}
	return runnerID, ownerID, true
}

func isUUID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i, c := range s {
		switch {
		case i == 8 || i == 13 || i == 18 || i == 23:
			if c != '-' {
				return false
			}
		case c >= '0' && c <= '9', c >= 'a' && c <= 'f':
		default:
			return false
		}
	}
	return true
}

// linkClaims are RunnerLinkClaims, in the order the apiserver writes them.
type linkClaims struct {
	Aud        string `json:"aud"`
	JTI        string `json:"jti"`
	RunnerID   string `json:"runnerId"`
	OwnerID    string `json:"ownerId"`
	CellID     string `json:"cellId"`
	LinkURL    string `json:"linkUrl"`
	LeaseOwner string `json:"leaseOwner"`
	Credential string `json:"credential"`
	IAT        int64  `json:"iat"`
	EXP        int64  `json:"exp"`
}

// mint answers POST /api/runner/link-token as runner-link-token.controller.ts does: a token for the runner its runner
// token names, under the process its body asks for, and when it expires, its cell and the link address it names.
func (s *stub) mint(r *http.Request, body []byte) (int, []byte) {
	token := bearer(r)
	runnerID, ownerID, ok := parseRunnerToken(token)
	if !ok {
		return http.StatusUnauthorized, refusal("UNAUTHENTICATED", "the runner token is not one linkstub fleet writes")
	}
	var asked struct {
		LeaseOwner string `json:"leaseOwner"`
	}
	if err := json.Unmarshal(body, &asked); err != nil || strings.TrimSpace(asked.LeaseOwner) == "" {
		return http.StatusBadRequest, refusal("VALIDATION", "the body names no leaseOwner")
	}
	iat := s.now().Unix()
	claims := linkClaims{
		Aud: linkAudience, JTI: randomUUID(), RunnerID: runnerID, OwnerID: ownerID, CellID: s.cell, LinkURL: s.linkURL,
		LeaseOwner: asked.LeaseOwner, Credential: credentialOf(token), IAT: iat, EXP: iat + max(int64(s.tokenTTL/time.Second), 1),
	}
	b, _ := json.Marshal(map[string]string{
		"token": s.sign(claims), "expiresAt": iso(time.Unix(claims.EXP, 0)), "cellId": s.cell, "linkUrl": s.linkURL,
	})
	return http.StatusOK, b
}

func (s *stub) sign(claims linkClaims) string {
	header, _ := json.Marshal(map[string]string{"alg": "EdDSA", "typ": "JWT", "kid": s.kid})
	payload, _ := json.Marshal(claims)
	input := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(payload)
	return input + "." + base64.RawURLEncoding.EncodeToString(ed25519.Sign(s.key, []byte(input)))
}

// credentialOf is the credential claim, as runnerLinkCredential derives it from the hash a runner row keeps of its token.
func credentialOf(token string) string {
	hash := sha256.Sum256([]byte(token))
	sum := sha256.Sum256([]byte("orbit-runner-link:" + hex.EncodeToString(hash[:])))
	return hex.EncodeToString(sum[:])[:32]
}

func randomUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return formatUUID(b)
}

func formatUUID(b [16]byte) string {
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}
