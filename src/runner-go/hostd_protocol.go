package main

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// The wire protocol between a user's `orbit` CLI and orbit-hostd, the root-owned
// machine broker. One connection carries exactly one JSON request and exactly one
// JSON response, then closes: there is no session to resynchronise, no framing
// beyond "one JSON value", and no state a caller can leave behind.
const (
	hostdProtocolVersion = 1
	// A request is a verb plus, at most, a handful of scalars. Anything larger is a
	// client bug or an attempt to make a root daemon chew on attacker-sized input.
	hostdMaxRequestBytes = 64 << 10
)

// hostdRequest is the caller's half of the exchange. It carries no identity field by
// construction: whose runner a verb acts on comes from the connection's peer
// credentials, never from the body — see hostdIdentityField.
type hostdRequest struct {
	V    int    `json:"v"`
	Verb string `json:"verb"`
}

// hostdResponse is hostd's half. Data is verb-specific and absent on failure.
type hostdResponse struct {
	OK    bool           `json:"ok"`
	Error string         `json:"error,omitempty"`
	Data  map[string]any `json:"data,omitempty"`
}

func hostdOK(data map[string]any) hostdResponse {
	return hostdResponse{OK: true, Data: data}
}

func hostdFail(format string, a ...any) hostdResponse {
	return hostdResponse{Error: fmt.Sprintf(format, a...)}
}

// hostdVerb executes one request. peer is the kernel's word on who is calling, and
// the only thing about identity a verb is given.
type hostdVerb func(peer hostdPeer, req hostdRequest) hostdResponse

// hostdHandle applies the protocol rules to one raw request body and returns the
// response to write back. Pure — no I/O, no syscalls — so every rule below is
// testable without a socket, and every failure is a response rather than a crash:
// hostd stays up for the next caller no matter what this one sent.
func hostdHandle(raw []byte, peer hostdPeer, verbs map[string]hostdVerb) hostdResponse {
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		return hostdFail("malformed request: %v", err)
	}
	if field := hostdIdentityField(body); field != "" {
		return hostdFail("request field %q is refused: hostd derives the target from the caller's peer credentials, never from the request body", field)
	}
	var req hostdRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		return hostdFail("malformed request: %v", err)
	}
	if req.V != hostdProtocolVersion {
		return hostdFail("unsupported protocol version %d: this hostd speaks v%d", req.V, hostdProtocolVersion)
	}
	if req.Verb == "" {
		return hostdFail("missing verb")
	}
	verb, ok := verbs[req.Verb]
	if !ok {
		return hostdFail("unknown verb %q", req.Verb)
	}
	return verb(peer, req)
}

// hostdIdentityFragments are the name fragments that make a request field look like it
// picks *whose* runner to act on.
//
// Deliberately broad, and deliberately a refusal rather than a silent ignore: a field
// hostd quietly dropped would still read, to whoever wrote the caller, like a way to
// name a target — and the day something downstream honoured it, hostd would be a
// confused deputy handing root's authority to whoever asked nicely. Failing at the
// door means that mistake can only ever be made once, loudly. New protocol fields must
// keep clear of these fragments.
var hostdIdentityFragments = []string{
	"user", "uid", "gid", "target", "account", "identity",
	"impersonat", "runas", "behalf", "principal", "owner", "login", "subject",
}

// hostdIdentityField returns the first field name in a decoded request that looks like
// it names a target identity, or "" when the body is clean. Nested objects and arrays
// are walked too: the invariant is about the whole body, not just its top level. Keys
// are visited in sorted order so a body with several offenders always names the same
// one back.
func hostdIdentityField(v any) string {
	switch t := v.(type) {
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			if hostdLooksLikeIdentity(k) {
				return k
			}
			if nested := hostdIdentityField(t[k]); nested != "" {
				return nested
			}
		}
	case []any:
		for _, item := range t {
			if nested := hostdIdentityField(item); nested != "" {
				return nested
			}
		}
	}
	return ""
}

// hostdLooksLikeIdentity matches a field name against the fragments above, ignoring
// case and separators — "targetUser", "target_user" and "TARGET-USER" are one name.
func hostdLooksLikeIdentity(field string) bool {
	norm := strings.Map(func(r rune) rune {
		switch {
		case r >= 'A' && r <= 'Z':
			return r + ('a' - 'A')
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			return r
		default:
			return -1
		}
	}, field)
	for _, fragment := range hostdIdentityFragments {
		if strings.Contains(norm, fragment) {
			return true
		}
	}
	return false
}
