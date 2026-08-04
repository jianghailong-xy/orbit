package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
	"time"
)

// orbit token — mint, list and revoke the narrow credentials a HEADLESS process runs on.
//
// A launchd/cron bridge belongs to no session, so it can hold none of the session-bound proofs
// orchestration uses. It could authenticate as the machine, but the runner credential sits in
// plaintext in config.json and is what every claim authenticates with: promoting it to "may spawn
// any agent with any prompt" would make one leaked file equal arbitrary execution. A service
// token instead names exactly what it may do, is pinned to one agent when it may start sessions,
// expires on its own, and is revoked individually without re-registering the machine.

const envServiceToken = "ORBIT_SERVICE_TOKEN"

const tokenHelp = `orbit token — service credentials for headless processes

Usage:
  orbit token mint --scope SCOPE[,SCOPE...] [--agent-id ID] [--ttl DURATION] [--label TEXT] [--json]
  orbit token list [--json]
  orbit token revoke TOKEN_ID [--json]

Scopes: session:get, session:list, session:send, session:create
The destructive verbs (interrupt, merge, end, complete) are not grantable at all.

A minted token is printed once and never stored by the CLI. Put it in the launchd/cron
environment as ORBIT_SERVICE_TOKEN; ` + "`orbit session`" + ` uses it in place of the runner
credential and the control plane confines it to its scopes, this runner, and its agent.
`

var tokenActionHelp = map[string]string{
	"mint": `orbit token mint — mint a service credential for a headless process

Usage:
  orbit token mint --scope SCOPE[,SCOPE...] [--agent-id ID] [--ttl DURATION] [--label TEXT] [--json]

Options:
  --scope SCOPE[,SCOPE...]  Repeatable. session:get | session:list | session:send | session:create
  --agent-id ID             Confine the token to one agent. REQUIRED with session:create, so a
                            leaked token can only ever start the agent it was minted for.
  --ttl DURATION            Lifetime, e.g. 24h, 30m, 90d (default 24h, max 90d)
  --label TEXT              Shown by 'orbit token list' to identify it later
  --json

Minting takes the machine's runner credential, so a service token can never mint another.
`,
	"list": `orbit token list — list this runner's service credentials

Usage:
  orbit token list [--json]

Shows scope, agent pin, expiry and last use — enough to tell whether a token is still
in use before revoking it. The credential itself is never recoverable.
`,
	"revoke": `orbit token revoke — revoke a service credential immediately

Usage:
  orbit token revoke TOKEN_ID [--json]

Revocation takes effect on the next request; it does not wait for the token to expire.
`,
}

var serviceTokenScopes = []string{"session:get", "session:list", "session:send", "session:create"}

const (
	defaultServiceTokenTTL = 24 * time.Hour
	maxServiceTokenTTL     = 90 * 24 * time.Hour
	minServiceTokenTTL     = time.Minute
)

func cmdTokenCLI(args []string, out io.Writer) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		_, err := fmt.Fprint(out, tokenHelp)
		return err
	}
	if args[0] == "help" {
		if len(args) == 1 {
			_, err := fmt.Fprint(out, tokenHelp)
			return err
		}
		h, ok := tokenActionHelp[args[1]]
		if !ok {
			return fmt.Errorf("unknown command %q", args[1])
		}
		_, err := fmt.Fprint(out, h)
		return err
	}
	action := args[0]
	h, known := tokenActionHelp[action]
	if !known {
		return fmt.Errorf("unknown command %q\n\n%s", action, tokenHelp)
	}
	if wantsHelp(args[1:]) {
		_, err := fmt.Fprint(out, h)
		return err
	}
	switch action {
	case "mint":
		return cliTokenMint(args[1:], out)
	case "list":
		return cliTokenList(args[1:], out)
	case "revoke":
		return cliTokenRevoke(args[1:], out)
	default:
		panic("unreachable token command")
	}
}

// repeatableFlag collects --scope a,b --scope c into one list.
type repeatableFlag []string

func (r *repeatableFlag) String() string { return strings.Join(*r, ",") }

func (r *repeatableFlag) Set(value string) error {
	for _, part := range strings.Split(value, ",") {
		if part = strings.TrimSpace(part); part != "" {
			*r = append(*r, part)
		}
	}
	return nil
}

func cliTokenMint(args []string, out io.Writer) error {
	fs := newCLIFlagSet("orbit token mint")
	var scopes repeatableFlag
	fs.Var(&scopes, "scope", "granted scope (repeatable, comma-separated)")
	agentID := fs.String("agent-id", "", "confine the token to one agent")
	label := fs.String("label", "", "human label")
	ttl := fs.String("ttl", "", "lifetime, e.g. 24h (default 24h, max 90d)")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	requested, err := normalizeServiceTokenScopes(scopes)
	if err != nil {
		return err
	}
	ttlSeconds, err := parseServiceTokenTTL(*ttl)
	if err != nil {
		return err
	}
	body := map[string]interface{}{"scopes": requested, "ttlSeconds": ttlSeconds}
	if flagWasSet(fs, "agent-id") {
		if err := validatePathSegmentID(strings.TrimSpace(*agentID)); err != nil {
			return fmt.Errorf("agent %w", err)
		}
		body["agentId"] = strings.TrimSpace(*agentID)
	} else if contains(requested, "session:create") {
		// Fail here rather than round-tripping: the pin is the whole authorization for create.
		return fmt.Errorf("--agent-id is required with the session:create scope")
	}
	if flagWasSet(fs, "label") {
		if strings.TrimSpace(*label) == "" {
			return fmt.Errorf("--label cannot be empty")
		}
		body["label"] = *label
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.mintServiceToken(body)
	if err != nil {
		return fmt.Errorf("mint service token: %w", err)
	}
	if *jsonOut {
		return writeCLIRawJSON(out, raw, true)
	}
	var minted struct {
		ID        string   `json:"id"`
		Token     string   `json:"token"`
		Scopes    []string `json:"scopes"`
		AgentID   string   `json:"agentId"`
		ExpiresAt string   `json:"expiresAt"`
	}
	if err := json.Unmarshal(raw, &minted); err != nil {
		return writeCLIRawJSON(out, raw, false)
	}
	fmt.Fprintf(out, "id:      %s\n", minted.ID)
	fmt.Fprintf(out, "scopes:  %s\n", strings.Join(minted.Scopes, ", "))
	if minted.AgentID != "" {
		fmt.Fprintf(out, "agent:   %s\n", minted.AgentID)
	}
	fmt.Fprintf(out, "expires: %s\n", minted.ExpiresAt)
	fmt.Fprintf(out, "\n%s\n\n", minted.Token)
	fmt.Fprintf(out, "Shown once. Put it in the job environment as %s=<token>.\n", envServiceToken)
	fmt.Fprintf(out, "Revoke with: orbit token revoke %s\n", minted.ID)
	return nil
}

func cliTokenList(args []string, out io.Writer) error {
	fs := newCLIFlagSet("orbit token list")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.listServiceTokens()
	if err != nil {
		return fmt.Errorf("list service tokens: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

func cliTokenRevoke(args []string, out io.Writer) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit token revoke")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	if id == "" && len(fs.Args()) == 1 {
		id = fs.Args()[0]
	} else if len(fs.Args()) > 0 {
		return fmt.Errorf("unexpected arguments: %s", strings.Join(fs.Args(), " "))
	}
	if id == "" {
		return fmt.Errorf("token id is required")
	}
	if err := validatePathSegmentID(id); err != nil {
		return fmt.Errorf("token %w", err)
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.revokeServiceToken(id)
	if err != nil {
		return fmt.Errorf("revoke service token: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

func normalizeServiceTokenScopes(requested []string) ([]string, error) {
	if len(requested) == 0 {
		return nil, fmt.Errorf("--scope is required (one of: %s)", strings.Join(serviceTokenScopes, ", "))
	}
	seen := map[string]bool{}
	var scopes []string
	for _, scope := range requested {
		scope = strings.TrimSpace(scope)
		if !contains(serviceTokenScopes, scope) {
			return nil, fmt.Errorf("unknown scope %q (allowed: %s)", scope, strings.Join(serviceTokenScopes, ", "))
		}
		if !seen[scope] {
			seen[scope] = true
			scopes = append(scopes, scope)
		}
	}
	return scopes, nil
}

// parseServiceTokenTTL accepts Go durations plus a `d` suffix for days, which is how a human
// thinks about a credential's life ("90d" reads better than "2160h").
func parseServiceTokenTTL(value string) (int, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return int(defaultServiceTokenTTL.Seconds()), nil
	}
	var d time.Duration
	var err error
	if strings.HasSuffix(value, "d") {
		var days float64
		if _, err = fmt.Sscanf(strings.TrimSuffix(value, "d"), "%g", &days); err == nil {
			d = time.Duration(days * float64(24*time.Hour))
		}
	} else {
		d, err = time.ParseDuration(value)
	}
	if err != nil || d <= 0 {
		return 0, fmt.Errorf("--ttl must be a duration like 30m, 24h or 90d")
	}
	if d < minServiceTokenTTL || d > maxServiceTokenTTL {
		return 0, fmt.Errorf("--ttl must be between 1m and 90d")
	}
	return int(d.Seconds()), nil
}

func contains(values []string, needle string) bool {
	for _, value := range values {
		if value == needle {
			return true
		}
	}
	return false
}

// ── Reading the token this process was given ───────────────────────────────

type serviceTokenClaims struct {
	Scopes  []string `json:"scopes"`
	AgentID string   `json:"agentId"`
	Exp     int64    `json:"exp"`
}

// currentServiceToken returns the token in the environment, if any. It is passed straight to the
// control plane; nothing here trusts its contents.
func currentServiceToken() string {
	return strings.TrimSpace(os.Getenv(envServiceToken))
}

// decodeServiceTokenClaims reads the payload WITHOUT verifying the signature — the control plane
// is the only thing that authorizes anything. This is purely so `orbit capabilities` can describe
// the credential this process holds without a network round-trip, the way it describes everything
// else. A malformed or expired token yields no claims, so capabilities under-promise rather than
// over-promise.
func decodeServiceTokenClaims(token string) *serviceTokenClaims {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil
	}
	var claims serviceTokenClaims
	if json.Unmarshal(payload, &claims) != nil {
		return nil
	}
	if claims.Exp > 0 && time.Now().Unix() >= claims.Exp {
		return nil
	}
	var known []string
	for _, scope := range claims.Scopes {
		if contains(serviceTokenScopes, scope) {
			known = append(known, scope)
		}
	}
	sort.Strings(known)
	claims.Scopes = known
	return &claims
}
