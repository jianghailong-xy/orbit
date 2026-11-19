package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// The Orbit Cloud browser's agent tools (docs/runner-browser-design.md; board docs/mocks/runner-browser/03-agent-tools.html
// ②): browser_status first, and after it browser_open, browser_clear_logins and browser_request_sign_in. Each is an
// MCP tool and an `orbit browser` command, and every one of them rides the one gate below.
//
// The gate. The apiserver says on every claim whether its browser switch is on (`browserEnabled`: its
// ORBIT_MANAGED_RUNNER_BROWSER_ENABLED, with managed runners on; managed-runner-browser-gate.ts browserClaimFields).
// The runner writes that into the engine's environment as ORBIT_BROWSER, and `orbit mcp` and the CLI read it from
// there. Off means absent, not refused: the tools are not in `orbit mcp`'s tool list, the `orbit browser` family is not
// in `orbit capabilities`, and `orbit browser` is an unknown command. Only an explicit on turns them on, so a runner or
// server that predates the switch offers none. A spawn reads the flag once, as for the wiki.
//
// Nothing here logs or keeps page content, cookies or site names: the status says only whether saved logins exist.
const envBrowser = "ORBIT_BROWSER"

// browserEnv renders the ORBIT_BROWSER value the runner injects at spawn.
func browserEnv(enabled bool) string {
	if enabled {
		return "on"
	}
	return "off"
}

// browserToolsEnabledFromEnv reads ORBIT_BROWSER: the one place every browser tool and command asks whether it exists.
func browserToolsEnabledFromEnv() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(envBrowser))) {
	case "on", "1", "true", "yes":
		return true
	default:
		return false
	}
}

// browserToolNames is the set callBrowserTool answers for, and what `orbit mcp` leaves out while the switch is off.
var browserToolNames = map[string]bool{
	"browser_status":         true,
	browserRequestSignInTool: true,
}

// browserRequestSignInTool asks the owner to sign in to a site in the Orbit Cloud runner's browser (board ①). It is
// the one browser tool that exists only for sessions on the Orbit Cloud runner: a login is saved in that runner's
// browser, which no other runner's agents can use. Elsewhere it is absent like every browser tool with the switch off,
// and the server refuses it if called anyway (403 BROWSER_SIGN_IN_NOT_ORBIT_CLOUD).
const browserRequestSignInTool = "browser_request_sign_in"

// onOrbitCloudRunner reports whether this process runs under the account's Orbit Cloud (managed) runner: the managed
// image's entrypoint sets ORBIT_MANAGED_RUNNER_GENERATION, and the runner's environment reaches its engines' children.
func onOrbitCloudRunner() bool {
	return declaresBrowserClear(os.LookupEnv)
}

// browserSignInAbsent: browser_request_sign_in is not this session's — the browser is off, or this is not the Orbit
// Cloud runner.
func browserSignInAbsent() bool {
	return !browserToolsEnabledFromEnv() || !onOrbitCloudRunner()
}

// withoutBrowserSignIn is tools without browser_request_sign_in: what a session off the Orbit Cloud runner lists.
func withoutBrowserSignIn(tools []map[string]interface{}) []map[string]interface{} {
	kept := make([]map[string]interface{}, 0, len(tools))
	for _, tool := range tools {
		if name, _ := tool["name"].(string); name == browserRequestSignInTool {
			continue
		}
		kept = append(kept, tool)
	}
	return kept
}

// withoutBrowserTools is tools without the browser tools: what `orbit mcp` lists while the browser is off.
func withoutBrowserTools(tools []map[string]interface{}) []map[string]interface{} {
	kept := make([]map[string]interface{}, 0, len(tools))
	for _, tool := range tools {
		if name, _ := tool["name"].(string); browserToolNames[name] {
			continue
		}
		kept = append(kept, tool)
	}
	return kept
}

// browserOpAbsent: op is one of the browser's operations and this process was spawned with the browser off. Every
// listing of the catalogue a session reads leaves it out then — `orbit capabilities` and its --summary, --family and --id
// views, `orbit mcp help` — as tools/list does (withoutBrowserTools) and the CLI does (`orbit browser` is unknown).
func browserOpAbsent(op *operation) bool {
	if op == nil || op.Object != objectBrowser {
		return false
	}
	return !browserToolsEnabledFromEnv() || (op.Tool == browserRequestSignInTool && !onOrbitCloudRunner())
}

// browserOffMessage is what a browser tool or command says in a session spawned with the browser off, for the doors
// that answer for a catalogued operation by name (`orbit capabilities --id`, a stray tools/call).
func browserOffMessage(what string) string {
	return what + ": the Orbit Cloud browser is switched off on this Orbit server (ORBIT_BROWSER is not on for this " +
		"session), so there is no browser to read or open"
}

func browserToolDescriptors(obj func(map[string]interface{}, ...string) map[string]interface{}) []map[string]interface{} {
	str := map[string]interface{}{"type": "string"}
	nullableStr := map[string]interface{}{"type": []string{"string", "null"}}
	return []map[string]interface{}{
		{
			"name": "browser_status",
			"description": "Read the state of this account's Orbit Cloud browser, the one shared Chrome on the Orbit Cloud " +
				"runner: whether the feature is on, whether the browser is running, which session holds it (one session " +
				"uses it at a time), how many people are watching it, and whether saved logins exist. It says only " +
				"whether saved logins exist, never which sites. Read-only; any session of the account may call it. " +
				"While another session holds the browser, wait or do other work, then read this again.",
			"inputSchema": obj(map[string]interface{}{}),
			"outputSchema": obj(map[string]interface{}{
				"enabled":         map[string]interface{}{"type": "boolean", "description": "The browser feature is on on this Orbit server. false: nothing else is said."},
				"runnerId":        map[string]interface{}{"type": []string{"string", "null"}, "description": "The account's Orbit Cloud runner, or null when it has none."},
				"state":           map[string]interface{}{"type": "string", "enum": []string{"RUNNING", "IDLE", "UNKNOWN"}, "description": "RUNNING: Chrome is started. IDLE: it is not. UNKNOWN: the runner has not reported the browser."},
				"running":         map[string]interface{}{"type": "boolean"},
				"holderSessionId": nullableStr,
				"holderTitle":     nullableStr,
				"viewers":         map[string]interface{}{"type": "integer", "description": "How many viewers are connected."},
				"savedLogins":     map[string]interface{}{"type": []string{"boolean", "null"}, "description": "Whether saved logins exist; null when the runner has not said. Never which sites."},
				"reportedAt":      nullableStr,
				"message":         str,
			}, "enabled"),
			"annotations": map[string]interface{}{"readOnlyHint": true},
		},
		{
			"name": browserRequestSignInTool,
			"description": "Ask the account owner to sign in to a site in this runner's shared browser, when a page you " +
				"opened with the browser tools needs a login you do not have. Say which site and why. The owner gets a " +
				"Waiting-on-you card and signs in themselves in the browser; Orbit never sees their password, and the " +
				"login stays in this runner's browser for every agent on it. This call waits until the owner answers: " +
				"while it waits you give up the browser, so do not use it; afterwards you hold it again, on the page you " +
				"were on. answer is SIGNED_IN (reload or carry on where you were) or NOT_NOW (the owner will not sign " +
				"in now: decide your next step, such as working without the login or ending your turn saying what needs " +
				"it). Only on the Orbit Cloud runner. Never put a password or code in reason.",
			"inputSchema": obj(map[string]interface{}{
				"site":   map[string]interface{}{"type": "string", "description": "The site to sign in to, as a host (github.com). A URL is cut to its host."},
				"reason": map[string]interface{}{"type": "string", "description": "Why you need the login, in one or two sentences the owner reads on the card: which account and what for."},
			}, "site", "reason"),
			"outputSchema": obj(map[string]interface{}{
				"requestId":     str,
				"site":          str,
				"answer":        map[string]interface{}{"type": "string", "enum": []string{"SIGNED_IN", "NOT_NOW", "EXPIRED", "WITHDRAWN"}},
				"leaseReleased": map[string]interface{}{"type": "boolean", "description": "You held the browser and gave it up while the owner signed in."},
				"leaseRetaken":  map[string]interface{}{"type": "boolean", "description": "You hold the browser again."},
				"message":       str,
			}, "requestId", "site", "answer", "message"),
		},
	}
}

// browserCLICapabilities are listed only while the browser switch is on (buildCLICapabilities), and inside a session
// only: the server answers for the session's account, which a terminal outside one has none of.
var browserCLICapabilities = []cliCapabilitySpec{
	{
		Tool:        "browser_status",
		Argv:        []string{"orbit", "browser", "status"},
		Usage:       "orbit browser status [--json]",
		Arguments:   []string{"--json"},
		SessionOnly: true,
	},
	{
		Tool:        browserRequestSignInTool,
		Argv:        []string{"orbit", "browser", "request-sign-in"},
		Usage:       "orbit browser request-sign-in --site HOST --reason TEXT [--json]",
		Arguments:   []string{"--site <host> (required)", "--reason <text> (required)", "--json"},
		SessionOnly: true,
	},
}

// browserCLICapabilitiesHere is browserCLICapabilities as this process may offer them: request-sign-in only on the
// Orbit Cloud runner.
func browserCLICapabilitiesHere() []cliCapabilitySpec {
	if !onOrbitCloudRunner() {
		return withoutCLISpec(browserCLICapabilities, browserRequestSignInTool)
	}
	return browserCLICapabilities
}

func withoutCLISpec(specs []cliCapabilitySpec, tool string) []cliCapabilitySpec {
	kept := make([]cliCapabilitySpec, 0, len(specs))
	for _, spec := range specs {
		if spec.Tool != tool {
			kept = append(kept, spec)
		}
	}
	return kept
}

// callBrowserTool runs one browser tool for the session this server runs in, and reports whether it handled the name.
func (s *mcpServer) callBrowserTool(name string, args map[string]interface{}) (map[string]interface{}, bool) {
	if !browserToolNames[name] {
		return nil, false
	}
	if !s.browserOn {
		return toolResult(browserOffMessage(name), true), true
	}
	if name == browserRequestSignInTool {
		if !onOrbitCloudRunner() {
			return toolResult(browserSignInNotHereMessage, true), true
		}
		// An engine that ends a tool call on its own deadline gets the wait in a runner-hosted job, as for every call
		// that waits for the owner (handOffOwnerWait).
		if s.callTimeout > 0 && s.sessionID != "" {
			return s.handOffOwnerWait(name, args), true
		}
		out, err := runBrowserRequestSignIn(s.t, s.sessionID, getString(args, "site"), getString(args, "reason"),
			socketBrowserLease(), browserSignInPoll)
		if err != nil {
			return toolResult(err.Error(), true), true
		}
		text, _ := json.MarshalIndent(out, "", "  ")
		return toolResultWithData(out.Message+"\n"+string(text), out, false), true
	}
	status, err := runBrowserStatus(s.t, s.sessionID)
	if err != nil {
		return toolResult(err.Error(), true), true
	}
	text, _ := json.MarshalIndent(status, "", "  ")
	return toolResultWithData(string(text), status, false), true
}

// browserStatus is browser_status's answer: RunnerBrowserStatus as GET /runner/browser sends it, or `enabled: false`
// with a message when the server has the switch off (it answers that route 404, as for a path it does not have).
type browserStatus struct {
	Enabled         bool    `json:"enabled"`
	RunnerID        *string `json:"runnerId"`
	State           string  `json:"state,omitempty"`
	Running         bool    `json:"running"`
	HolderSessionID *string `json:"holderSessionId"`
	HolderTitle     *string `json:"holderTitle"`
	Viewers         int     `json:"viewers"`
	SavedLogins     *bool   `json:"savedLogins"`
	ReportedAt      *string `json:"reportedAt"`
	Message         string  `json:"message,omitempty"`
}

// runBrowserStatus is one browser_status call, from either door.
func runBrowserStatus(t *Transport, sessionID string) (*browserStatus, error) {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return nil, errors.New("browser_status reads the Orbit Cloud browser of the account of the session it is called " +
			"from, and this is not running inside one (ORBIT_SESSION_ID is unset)")
	}
	var out browserStatus
	err := t.doHeaders(nil, "GET", "/runner/browser", nil, &out, taskOpTimeout, sessionHeader(sessionID))
	var httpErr *transportHTTPError
	if errors.As(err, &httpErr) && httpErr.statusCode == http.StatusNotFound {
		return &browserStatus{Enabled: false, Message: "The Orbit Cloud browser is switched off on this Orbit server."}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("browser_status failed: %w", err)
	}
	if out.RunnerID == nil {
		out.Message = "This account has no Orbit Cloud runner, so there is no browser."
	}
	return &out, nil
}

// browserSignInNotHereMessage refuses browser_request_sign_in off the Orbit Cloud runner, at the doors that answer for
// a catalogued name (a stray tools/call).
const browserSignInNotHereMessage = "browser_request_sign_in is only for sessions on the account's Orbit Cloud " +
	"runner: a login is saved in that runner's browser, which this runner's agents cannot use"

// browserSignInPoll is how often the waiting call reads the card while the owner has not answered.
var browserSignInPoll = 3 * time.Second

// browserSignInLease is the runner's lease door for a sign-in: give it up while the owner signs in, take it back after.
type browserSignInLease interface {
	yield() (held bool, err error)
	end(retake bool) error
}

// socketBrowserLease reaches the runner's browser supervisor over the session's background-job socket, as the
// `browser` MCP server's lease does (browser_mcp.go).
type socketLease struct{ socket, token string }

func socketBrowserLease() browserSignInLease {
	return socketLease{socket: os.Getenv(envBgSocket), token: os.Getenv(envBgToken)}
}

func (l socketLease) yield() (bool, error) {
	if l.socket == "" || l.token == "" {
		return false, errors.New("this session has no runner socket to give the browser up through (ORBIT_BG_SOCKET is unset)")
	}
	raw, err := bgSocketCall(l.socket, l.token, browserSignInYieldOp, nil)
	if err != nil {
		return false, err
	}
	var res struct {
		Held bool `json:"held"`
	}
	_ = json.Unmarshal(raw, &res)
	return res.Held, nil
}

func (l socketLease) end(retake bool) error {
	_, err := bgSocketCall(l.socket, l.token, browserSignInEndOp, map[string]interface{}{"retake": retake})
	return err
}

// browserSignInResult is browser_request_sign_in's answer.
type browserSignInResult struct {
	RequestID     string `json:"requestId"`
	Site          string `json:"site"`
	Answer        string `json:"answer"`
	LeaseReleased bool   `json:"leaseReleased"`
	LeaseRetaken  bool   `json:"leaseRetaken"`
	Message       string `json:"message"`
}

// ownerRequestRead is what the sign-in reads of its card: only its state and the owner's note.
type ownerRequestRead struct {
	ID             string  `json:"id"`
	State          string  `json:"state"`
	BrowserSite    *string `json:"browserSite"`
	ResolutionNote *string `json:"resolutionNote"`
}

// runBrowserRequestSignIn is one browser_request_sign_in, from either door (board ①; Q1, Q2 = A). In order: the
// session gives the browser lease up and reserves the browser for the owner (Chrome and its page stay), the card is
// filed, the call waits for the owner's answer, and the session takes the lease back. Only the site name is sent or
// kept; nothing of the page, its cookies or the login is read.
func runBrowserRequestSignIn(t *Transport, sessionID, site, reason string, lease browserSignInLease, poll time.Duration) (*browserSignInResult, error) {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return nil, errors.New("browser_request_sign_in asks for the session it is called from, and this is not running " +
			"inside one (ORBIT_SESSION_ID is unset)")
	}
	site, reason = strings.TrimSpace(site), strings.TrimSpace(reason)
	if site == "" {
		return nil, errors.New("site is required: the host to sign in to, such as github.com")
	}
	if reason == "" {
		return nil, errors.New("reason is required: say which account you need and what for; the owner reads it on the card")
	}
	held, err := lease.yield()
	if err != nil {
		return nil, fmt.Errorf("browser_request_sign_in was not filed: %w", err)
	}
	var card ownerRequestRead
	err = t.doHeaders(nil, "POST", "/runner/browser/sign-in-requests",
		map[string]interface{}{"site": site, "reason": reason, "clientRequestId": "browser-sign-in-" + randomHex(8)},
		&card, taskOpTimeout, sessionHeader(sessionID))
	if err != nil {
		// Nothing is waiting for the owner: the session takes back what it held.
		_ = lease.end(held)
		var httpErr *transportHTTPError
		if errors.As(err, &httpErr) && httpErr.statusCode == http.StatusNotFound {
			return nil, errors.New("browser_request_sign_in: the Orbit Cloud browser is switched off on this Orbit server")
		}
		return nil, fmt.Errorf("browser_request_sign_in failed: %w", err)
	}
	if card.BrowserSite != nil {
		site = *card.BrowserSite
	}
	for card.State == "PENDING" || card.State == "" {
		time.Sleep(poll)
		var read ownerRequestRead
		// A failed read is read again: the card is in front of the owner, and only their answer ends the wait.
		if err := t.doHeaders(nil, "GET", "/runner/owner-requests/"+url.PathEscape(card.ID), nil, &read, taskOpTimeout,
			sessionHeader(sessionID)); err == nil {
			read.ID = card.ID
			if read.BrowserSite == nil {
				read.BrowserSite = card.BrowserSite
			}
			card = read
		}
	}
	out := &browserSignInResult{RequestID: card.ID, Site: site, LeaseReleased: held}
	switch card.State {
	case "DONE":
		out.Answer = "SIGNED_IN"
		out.Message = "The owner signed in to " + site + ". The login is saved in this runner's browser; carry on where you were."
	case "DECLINED":
		out.Answer = "NOT_NOW"
		out.Message = "The owner chose Not now: they will not sign in to " + site + " now. Decide your next step: work " +
			"without the login, or end your turn saying what needs it."
		if card.ResolutionNote != nil {
			if note := strings.TrimSpace(*card.ResolutionNote); note != "" && note != "Not now" {
				out.Message += " The owner said: " + note
			}
		}
	case "EXPIRED":
		out.Answer = "EXPIRED"
		out.Message = "The sign-in request expired before the owner answered."
	default:
		out.Answer = "WITHDRAWN"
		out.Message = "The sign-in request was withdrawn before the owner answered."
	}
	if err := lease.end(held); err != nil {
		out.Message += " The browser could not be taken back: " + err.Error()
	} else {
		out.LeaseRetaken = held
	}
	return out, nil
}

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

const browserHelp = `orbit browser — the account's Orbit Cloud browser

Usage:
  orbit browser status [--json]
  orbit browser request-sign-in --site HOST --reason TEXT [--json]

  status            Whether the browser is running, which session holds it, how many viewers
                    are connected, and whether saved logins exist (never which sites).
  request-sign-in   Ask the owner to sign in to a site in the browser, and wait for their
                    answer (Orbit Cloud runner only).

Acts for the Orbit session it runs in (ORBIT_SESSION_ID). Present only while the Orbit Cloud
browser is switched on on this Orbit server.
`

var browserActionHelp = map[string]string{
	"status": `orbit browser status — read the account's Orbit Cloud browser

Usage:
  orbit browser status [--json]

Prints whether the browser feature is on, whether the browser is running, which session holds it
(one session uses it at a time), how many viewers are connected, and whether saved logins exist.
It never says which sites the logins are for. Read-only; any session of the account may run it.
`,
	"request-sign-in": `orbit browser request-sign-in — ask the owner to sign in to a site in the browser

Usage:
  orbit browser request-sign-in --site HOST --reason TEXT [--json]

Puts a Waiting-on-you card in front of the account owner naming the site and quoting your reason,
and waits until they answer. While it waits this session gives the browser up so the owner's clicks
and yours do not collide; afterwards it holds it again, on the page it was on. Prints answer
SIGNED_IN or NOT_NOW. The owner signs in themselves; Orbit never sees the password, and the login
stays in this runner's browser for every agent on it. Only on the Orbit Cloud runner.
`,
}

func cmdBrowserCLI(args []string, out io.Writer) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" || args[0] == "help" {
		if len(args) > 1 && args[0] == "help" {
			h, ok := browserActionHelp[args[1]]
			if !ok {
				return fmt.Errorf("unknown command %q", args[1])
			}
			_, err := fmt.Fprint(out, h)
			return err
		}
		_, err := fmt.Fprint(out, browserHelp)
		return err
	}
	action := args[0]
	h, known := browserActionHelp[action]
	if action == "request-sign-in" && !onOrbitCloudRunner() {
		known = false
	}
	if !known {
		return fmt.Errorf("unknown command %q\n\n%s", action, browserHelp)
	}
	if wantsHelp(args[1:]) {
		_, err := fmt.Fprint(out, h)
		return err
	}
	switch action {
	case "status":
		fs := newCLIFlagSet("orbit browser status")
		jsonOut := fs.Bool("json", false, "emit compact JSON")
		if err := fs.Parse(args[1:]); err != nil {
			return err
		}
		if err := rejectTrailing(fs); err != nil {
			return err
		}
		t, err := cliTransport()
		if err != nil {
			return err
		}
		status, err := runBrowserStatus(t, os.Getenv("ORBIT_SESSION_ID"))
		if err != nil {
			return err
		}
		raw, _ := json.Marshal(status)
		return writeCLIRawJSON(out, raw, *jsonOut)
	case "request-sign-in":
		fs := newCLIFlagSet("orbit browser request-sign-in")
		site := fs.String("site", "", "the host to sign in to")
		reason := fs.String("reason", "", "why the login is needed")
		jsonOut := fs.Bool("json", false, "emit compact JSON")
		if err := fs.Parse(args[1:]); err != nil {
			return err
		}
		if err := rejectTrailing(fs); err != nil {
			return err
		}
		t, err := cliTransport()
		if err != nil {
			return err
		}
		res, err := runBrowserRequestSignIn(t, os.Getenv("ORBIT_SESSION_ID"), *site, *reason, socketBrowserLease(), browserSignInPoll)
		if err != nil {
			return err
		}
		raw, _ := json.Marshal(res)
		return writeCLIRawJSON(out, raw, *jsonOut)
	}
	return fmt.Errorf("unknown command %q", action)
}
