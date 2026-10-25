package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"strings"
	"time"
)

// The connection token (src/apiserver/src/runner-api/runner-link-token.ts, docs/runner-link-design.md §5.4): a
// compact JWS signed EdDSA over Ed25519, which the gateway checks with the public key alone and without asking any
// database. verify accepts and refuses exactly the tokens the apiserver's verifyRunnerLinkToken does, for the same
// four reasons (testdata/a3-tokens.json holds tokens and verdicts from that code), and then makes the gateway's own
// checks: the claims it serves by are present, the token is for this cell, and its credential is not revoked.

const linkAudience = "orbit-runner-link"

// tokenRefusal names why a token was refused. The first four are runner-link-token.ts's own reasons.
type tokenRefusal string

const (
	refuseMalformed tokenRefusal = "MALFORMED"
	refuseSignature tokenRefusal = "SIGNATURE"
	refuseAudience  tokenRefusal = "AUDIENCE"
	refuseExpired   tokenRefusal = "EXPIRED"
	refuseMissing   tokenRefusal = "MISSING"
	refuseClaims    tokenRefusal = "CLAIMS"
	refuseCell      tokenRefusal = "CELL"
	refuseRevoked   tokenRefusal = "REVOKED"
)

type tokenError struct {
	reason tokenRefusal
	detail string
}

func (e *tokenError) Error() string {
	if e.detail == "" {
		return "link token refused: " + string(e.reason)
	}
	return "link token refused: " + string(e.reason) + ": " + e.detail
}

func refuse(reason tokenRefusal, detail string) error {
	return &tokenError{reason: reason, detail: detail}
}

// refusalOf is the reason a verify error carries.
func refusalOf(err error) tokenRefusal {
	var te *tokenError
	if errors.As(err, &te) {
		return te.reason
	}
	return refuseMalformed
}

// linkClaims is what a verified token says.
type linkClaims struct {
	JTI        string
	RunnerID   string
	OwnerID    string
	CellID     string
	LinkURL    string
	LeaseOwner string
	Credential string
	ExpiresAt  time.Time
}

type verifierKey struct {
	kid string
	pub ed25519.PublicKey
}

// tokenVerifier holds the public keys tokens may be signed with.
type tokenVerifier struct {
	keys []verifierKey
}

func newTokenVerifier(keys []ed25519.PublicKey) *tokenVerifier {
	v := &tokenVerifier{}
	for _, k := range keys {
		v.keys = append(v.keys, verifierKey{kid: keyThumbprint(k), pub: k})
	}
	return v
}

// verifySignedToken is runner-link-token.ts's verifyRunnerLinkToken: the token's form, its signature, its audience
// and its expiry, in that order and with the same reasons.
func (v *tokenVerifier) verifySignedToken(token string, now time.Time) (map[string]json.RawMessage, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, refuse(refuseMalformed, "not three dot-separated parts")
	}
	headerBytes, err := decodeSegment(parts[0])
	if err != nil {
		return nil, refuse(refuseMalformed, "header is not base64url")
	}
	payloadBytes, err := decodeSegment(parts[1])
	if err != nil {
		return nil, refuse(refuseMalformed, "payload is not base64url")
	}
	var header any
	if err := json.Unmarshal(headerBytes, &header); err != nil {
		return nil, refuse(refuseMalformed, "header is not JSON")
	}
	var payload any
	if err := json.Unmarshal(payloadBytes, &payload); err != nil {
		return nil, refuse(refuseMalformed, "payload is not JSON")
	}
	head, _ := header.(map[string]any)
	if alg, _ := head["alg"].(string); alg != "EdDSA" {
		return nil, refuse(refuseMalformed, "alg is not EdDSA")
	}
	signature, err := decodeSegment(parts[2])
	if err != nil || !v.signedByAKey(head, []byte(parts[0]+"."+parts[1]), signature) {
		return nil, refuse(refuseSignature, "")
	}
	claims, ok := payload.(map[string]any)
	if !ok || claims["aud"] != linkAudience {
		return nil, refuse(refuseAudience, "")
	}
	exp, ok := claims["exp"].(float64)
	if !ok || float64(now.UnixMilli()) >= exp*1000 {
		return nil, refuse(refuseExpired, "")
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(payloadBytes, &raw); err != nil {
		return nil, refuse(refuseMalformed, "payload is not a JSON object")
	}
	return raw, nil
}

// signedByAKey checks the signature with the key the header's kid names; with no kid, or one naming no key it
// holds, with every key it holds, which is what the single-key verifier in runner-link-token.ts amounts to.
func (v *tokenVerifier) signedByAKey(head map[string]any, input, signature []byte) bool {
	if len(signature) != ed25519.SignatureSize {
		return false
	}
	kid, _ := head["kid"].(string)
	candidates := v.keys
	for _, k := range v.keys {
		if kid != "" && k.kid == kid {
			candidates = []verifierKey{k}
			break
		}
	}
	for _, k := range candidates {
		if ed25519.Verify(k.pub, input, signature) {
			return true
		}
	}
	return false
}

// verify is what the gateway does with the token of an upgrade request: verifySignedToken, then the gateway's own
// checks, in this order: the claims it serves by, the cell, the revocations.
func (v *tokenVerifier) verify(token, cellID string, deny *denyList, now time.Time) (*linkClaims, error) {
	if token == "" {
		return nil, refuse(refuseMissing, "no Authorization: Bearer header")
	}
	raw, err := v.verifySignedToken(token, now)
	if err != nil {
		return nil, err
	}
	c := &linkClaims{}
	fields := []struct {
		name string
		dst  *string
	}{
		{"jti", &c.JTI}, {"runnerId", &c.RunnerID}, {"ownerId", &c.OwnerID}, {"cellId", &c.CellID},
		{"linkUrl", &c.LinkURL}, {"leaseOwner", &c.LeaseOwner}, {"credential", &c.Credential},
	}
	for _, f := range fields {
		if json.Unmarshal(raw[f.name], f.dst) != nil || *f.dst == "" {
			return nil, refuse(refuseClaims, f.name+" is missing")
		}
	}
	var exp float64
	_ = json.Unmarshal(raw["exp"], &exp)
	c.ExpiresAt = time.UnixMilli(int64(exp * 1000))
	if c.CellID != cellID {
		return nil, refuse(refuseCell, fmt.Sprintf("token is for %s, this gateway serves %s", c.CellID, cellID))
	}
	if deny.revoked(c.Credential) {
		return nil, refuse(refuseRevoked, "")
	}
	return c, nil
}

// decodeSegment reads base64url as leniently as Node's Buffer.from(s, 'base64url'), which the signer's counterpart
// uses: padding is ignored and the standard alphabet's + and / are read as - and _.
func decodeSegment(s string) ([]byte, error) {
	s = strings.TrimRight(s, "=")
	s = strings.NewReplacer("+", "-", "/", "_").Replace(s)
	return base64.RawURLEncoding.DecodeString(s)
}

// keyThumbprint is a key's RFC 7638 thumbprint, the kid the apiserver puts in each token's header.
func keyThumbprint(pub ed25519.PublicKey) string {
	jwk := fmt.Sprintf(`{"crv":"Ed25519","kty":"OKP","x":"%s"}`, base64.RawURLEncoding.EncodeToString(pub))
	sum := sha256.Sum256([]byte(jwk))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// parsePublicKeys reads LINK_PUBLIC_KEYS: PEM text, or base64 of PEM, each holding one or more Ed25519 public keys,
// several base64 values separated by commas or spaces. A private key is refused: the gateway is never given one.
func parsePublicKeys(v string) ([]ed25519.PublicKey, error) {
	v = strings.TrimSpace(v)
	if v == "" {
		return nil, errors.New("LINK_PUBLIC_KEYS is required: the public half of the apiserver's RUNNER_LINK_SIGNING_KEY " +
			"(openssl pkey -in runner-link.pem -pubout | base64 -w0)")
	}
	var pems [][]byte
	if strings.HasPrefix(v, "-----BEGIN") {
		pems = append(pems, []byte(v))
	} else {
		for _, item := range splitList(v) {
			b, err := base64.StdEncoding.DecodeString(item)
			if err != nil {
				return nil, errors.New("LINK_PUBLIC_KEYS is neither PEM nor base64 of PEM")
			}
			pems = append(pems, b)
		}
	}
	var keys []ed25519.PublicKey
	for _, data := range pems {
		data = bytes.TrimSpace(data)
		for len(data) > 0 {
			block, rest := pem.Decode(data)
			if block == nil {
				return nil, errors.New("LINK_PUBLIC_KEYS holds something that is not a PEM block")
			}
			data = bytes.TrimSpace(rest)
			if strings.Contains(block.Type, "PRIVATE") {
				return nil, errors.New("LINK_PUBLIC_KEYS holds a private key: give the gateway the public key only " +
					"(openssl pkey -in runner-link.pem -pubout)")
			}
			parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
			if err != nil {
				return nil, fmt.Errorf("LINK_PUBLIC_KEYS: %v", err)
			}
			key, ok := parsed.(ed25519.PublicKey)
			if !ok {
				return nil, errors.New("LINK_PUBLIC_KEYS holds a key that is not Ed25519")
			}
			keys = append(keys, key)
		}
	}
	if len(keys) == 0 {
		return nil, errors.New("LINK_PUBLIC_KEYS holds no key")
	}
	return keys, nil
}
