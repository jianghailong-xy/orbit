package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"runtime"
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
	"browser_status": true,
	"browser_open":   true,
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
	return op != nil && op.Object == objectBrowser && !browserToolsEnabledFromEnv()
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
			"name": "browser_open",
			"description": "Open this account's Orbit Cloud browser, the one shared Chrome on the Orbit Cloud runner: start it " +
				"if it is not running, and answer the address of its browser tab on this Orbit server (tabUrl), where a " +
				"person can watch it or take control. Give url to have the browser open that page (http or https); that is " +
				"refused while another session holds the browser, which is then left as it is. Hand tabUrl to the user " +
				"when they should look at the browser. Any session of the account may call it; it never signs in anywhere.",
			"inputSchema": obj(map[string]interface{}{
				"url": map[string]interface{}{"type": "string", "description": "A page for the browser to open (http or https). Leave it out to start the browser and leave it on its page."},
			}),
			"outputSchema": obj(map[string]interface{}{
				"enabled":     map[string]interface{}{"type": "boolean", "description": "The browser feature is on on this Orbit server. false: nothing else is said."},
				"runnerId":    nullableStr,
				"tabUrl":      map[string]interface{}{"type": []string{"string", "null"}, "description": "The browser's tab on this Orbit server (/runners/:id/browser)."},
				"url":         map[string]interface{}{"type": []string{"string", "null"}, "description": "The page asked for, or null."},
				"requestedAt": nullableStr,
				"running":     map[string]interface{}{"type": "boolean", "description": "The runner has reported the browser running since the open was asked for."},
				"message":     str,
			}, "enabled"),
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
		Tool:        "browser_open",
		Argv:        []string{"orbit", "browser", "open"},
		Usage:       "orbit browser open [--url <url>] [--no-open] [--json]",
		Arguments:   []string{"--url <url>", "--no-open", "--json"},
		SessionOnly: true,
	},
}

// callBrowserTool runs one browser tool for the session this server runs in, and reports whether it handled the name.
func (s *mcpServer) callBrowserTool(name string, args map[string]interface{}) (map[string]interface{}, bool) {
	if !browserToolNames[name] {
		return nil, false
	}
	if !s.browserOn {
		return toolResult(browserOffMessage(name), true), true
	}
	var data interface{}
	var err error
	switch name {
	case "browser_open":
		target, _ := args["url"].(string)
		data, err = runBrowserOpen(s.t, s.sessionID, target)
	default:
		data, err = runBrowserStatus(s.t, s.sessionID)
	}
	if err != nil {
		return toolResult(err.Error(), true), true
	}
	text, _ := json.MarshalIndent(data, "", "  ")
	return toolResultWithData(string(text), data, false), true
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

// browserOpenResult is browser_open's answer: RunnerBrowserOpenResponse as POST /runner/browser/open sends it, with
// whether the runner has since reported the browser running; or `enabled: false` when the server has the switch off.
type browserOpenResult struct {
	Enabled     bool    `json:"enabled"`
	RunnerID    *string `json:"runnerId"`
	TabURL      *string `json:"tabUrl"`
	URL         *string `json:"url"`
	RequestedAt *string `json:"requestedAt"`
	Running     bool    `json:"running"`
	Message     string  `json:"message,omitempty"`
	// OpenedLocally: `orbit browser open` started a browser on this machine on tabUrl. Only the command says it.
	OpenedLocally *bool `json:"openedLocally,omitempty"`
}

// How long browser_open waits for the runner to report the browser running, and how often it reads.
var (
	browserOpenRunningWait = 30 * time.Second
	browserOpenPoll        = time.Second
)

// runBrowserOpen is one browser_open call, from either door: ask the server to open the browser (and the page), then
// read the status until the runner reports the browser running or browserOpenRunningWait passes.
func runBrowserOpen(t *Transport, sessionID, target string) (*browserOpenResult, error) {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return nil, errors.New("browser_open opens the Orbit Cloud browser of the account of the session it is called " +
			"from, and this is not running inside one (ORBIT_SESSION_ID is unset)")
	}
	body := map[string]interface{}{}
	if target = strings.TrimSpace(target); target != "" {
		body["url"] = target
	}
	var out browserOpenResult
	err := t.doHeaders(nil, "POST", "/runner/browser/open", body, &out, taskOpTimeout, sessionHeader(sessionID))
	var httpErr *transportHTTPError
	if errors.As(err, &httpErr) && httpErr.statusCode == http.StatusNotFound {
		return &browserOpenResult{Enabled: false, Message: "The Orbit Cloud browser is switched off on this Orbit server."}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("browser_open failed: %w", err)
	}
	out.Enabled = true
	deadline := time.Now().Add(browserOpenRunningWait)
	for {
		status, err := runBrowserStatus(t, sessionID)
		if err == nil && status.Running && status.ReportedAt != nil && out.RequestedAt != nil && *status.ReportedAt >= *out.RequestedAt {
			out.Running = true
			break
		}
		if time.Now().After(deadline) {
			break
		}
		time.Sleep(browserOpenPoll)
	}
	switch {
	case !out.Running:
		out.Message = "The Orbit Cloud runner has been asked to open the browser and has not yet reported it running; " +
			"read browser_status in a moment."
	case out.URL != nil:
		out.Message = "The browser is running and has been asked to open the page."
	default:
		out.Message = "The browser is running."
	}
	return &out, nil
}

// openTabLocally starts this machine's browser on link, and reports whether there was one to start: $BROWSER, else
// the platform's opener (on Linux only with a display). A var so a test can stand in for it.
var openTabLocally = func(link string) bool {
	if b := strings.TrimSpace(os.Getenv("BROWSER")); b != "" {
		return exec.Command(b, link).Start() == nil
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", link)
	case "windows":
		cmd = exec.Command("cmd", "/c", "start", "", link)
	default:
		if os.Getenv("DISPLAY") == "" && os.Getenv("WAYLAND_DISPLAY") == "" {
			return false
		}
		if _, err := exec.LookPath("xdg-open"); err != nil {
			return false
		}
		cmd = exec.Command("xdg-open", link)
	}
	return cmd.Start() == nil
}

const browserHelp = `orbit browser — the account's Orbit Cloud browser

Usage:
  orbit browser status [--json]
  orbit browser open [--url <url>] [--no-open] [--json]

  status   Whether the browser is running, which session holds it, how many viewers are
           connected, and whether saved logins exist (never which sites).
  open     Start the browser if it is not running, open its tab here, and with --url
           have it open that page.

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
	"open": `orbit browser open — open the account's Orbit Cloud browser

Usage:
  orbit browser open [--url <url>] [--no-open] [--json]

Starts the browser if it is not running and prints the address of its tab on this Orbit server
(/runners/:id/browser), which it opens in this machine's browser; with no browser to open it in,
it prints the address to open yourself. With --url the remote browser opens that page (http or
https), unless another session holds the browser. Any session of the account may run it.

  --url <url>   a page for the remote browser to open
  --no-open     print the tab's address without opening it here
  --json        emit compact JSON
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
	case "open":
		fs := newCLIFlagSet("orbit browser open")
		target := fs.String("url", "", "a page for the remote browser to open")
		noOpen := fs.Bool("no-open", false, "print the tab's address without opening it here")
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
		res, err := runBrowserOpen(t, os.Getenv("ORBIT_SESSION_ID"), *target)
		if err != nil {
			return err
		}
		if res.TabURL != nil {
			opened := !*noOpen && openTabLocally(*res.TabURL)
			res.OpenedLocally = &opened
			if !*jsonOut {
				if opened {
					fmt.Fprintf(out, "Opened the browser tab: %s\n", *res.TabURL)
				} else {
					fmt.Fprintf(out, "Open the browser tab: %s\n", *res.TabURL)
				}
			}
		}
		raw, _ := json.Marshal(res)
		return writeCLIRawJSON(out, raw, *jsonOut)
	}
	return fmt.Errorf("unknown command %q", action)
}
