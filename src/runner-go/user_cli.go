package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"strings"
	"time"
)

// orbit login / logout / whoami / api — the CLI acting as the person, with a personal access token
// (docs/personal-access-token-design.md §7.3). The token is read from stdin only, saved in
// $ORBIT_HOME/user.json (user_identity.go), and sent to the server it belongs to and nowhere else.

var loginHelp = `orbit login — act as yourself, with a personal access token

Usage:
  orbit login [--server URL] [--name NAME] [--scopes PRESET|LIST] [--expires 90d|never]
  orbit login --with-token [--server URL] < token.txt

Signs in through the browser: asks the server for a personal access token, opens
<server>/cli-login?code=… — sign in to Orbit there, check the token's name, scopes, expiry and
this host, and approve it — and waits up to ten minutes for the token. With --with-token it reads
a token already issued under Settings → Access tokens from stdin instead — never from an argument,
so it stays out of your shell history. Either way it checks the token with the server and saves it
with the server's URL in $ORBIT_HOME/user.json (default ~/.orbit/user.json, 0600, in a 0700
directory).

ORBIT_USER_TOKEN (with ORBIT_SERVER_URL) takes precedence over a saved login, for CI and
containers. The runner service never reads user.json, and inside an Orbit session the CLI ignores
it. On a runner machine whose service runs as this OS user, though, every agent session the runner
starts can read the file: orbit login warns when that is the case.

Options:
  --server <url>           The Orbit server (default: ORBIT_SERVER_URL, the saved login's server,
                           this machine's runner's server, or ` + defaultServer + `)
  --name <name>            The token's name (default: orbit CLI on <this host's name>)
  --scopes <preset|list>   read-only (default), read-write, or scopes separated by commas, such
                           as tasks:read,tasks:write
  --expires <lifetime>     30d, 90d (default), 365d or never
  --with-token             Read an issued token from stdin instead of signing in through the browser
`

const logoutHelp = `orbit logout — stop acting as yourself here

Usage:
  orbit logout [--keep-token]

Revokes the personal access token 'orbit login' saved — on the server, at once — and removes
$ORBIT_HOME/user.json. When the server cannot be reached nothing is removed, so a token is never
left working without a trace of it here.

Options:
  --keep-token             Only remove the saved login: the token keeps working until it expires
                           or is revoked under Settings → Access tokens

A token in ORBIT_USER_TOKEN is not orbit's to remove: unset the variable.
`

const whoamiHelp = `orbit whoami — show who the CLI acts as, and why

Usage:
  orbit whoami [--json]

The first of these that is present decides:
  1. ORBIT_SESSION_ID         the Orbit session this runs in; personal access tokens are ignored
  2. ORBIT_SERVICE_TOKEN      a service token from 'orbit token mint'
  3. ORBIT_USER_TOKEN, or the login 'orbit login' saved in $ORBIT_HOME/user.json — you
  4. the runner credential in $ORBIT_HOME/config.json — this machine

As you, it asks the server about the token and shows your email and the token's name, scopes,
workspaces and expiry. It exits non-zero when the token is refused or there is no identity.

Options:
  --json                   Print JSON
`

const apiHelp = `orbit api — call the Orbit REST API as yourself

Usage:
  orbit api [-X METHOD] PATH [--data JSON | --data-file -] [--paginate] [--json]

Sends one request to PATH under /api on your Orbit server, with your personal access token, and
prints the answer. PATH is /api/tasks, or just tasks. A token may call what its scopes open;
the owner's own decisions (confirmation cards, evidence verdicts, approvals) are never open to one.

Options:
  -X <method>              GET, POST, PUT, PATCH or DELETE (default: GET, or POST with a body)
  --data <json>            The JSON request body
  --data-file -            Read the JSON request body from stdin
  --paginate               Follow nextCursor (as GET /api/tasks/page answers) and print every page
  --json                   Print compact JSON (default: indented)

An answer other than 2xx is printed too, and the command exits non-zero. A 401 means the token is
invalid, revoked or expired: run 'orbit login' again.
`

// The commands that act as the person (§7.3), in `orbit capabilities`. Human terminal doors, withheld
// from a running agent (HeadlessOnly): inside a session the CLI acts as the session and ignores
// personal access tokens, so an agent could only be refused by them. No MCP tool stands beside them
// and none is needed — MCP runs only inside sessions (§2) — so each carries its own schema, and the
// parity test, which asks every MCP tool for a command and not the reverse, asks nothing of them.
var userCLICapabilities = []cliCapabilitySpec{
	{
		Tool:  "login",
		Argv:  []string{"orbit", "login"},
		Usage: "orbit login [--server URL] [--name NAME] [--scopes PRESET|LIST] [--expires 90d|never], or orbit login --with-token [--server URL] < token.txt",
		Arguments: []string{
			"--server <url> (default: ORBIT_SERVER_URL, the saved login's server, this runner's server, or the built-in one)",
			"--name <name> (the token's name; default: orbit CLI on <this host's name>)",
			"--scopes <read-only|read-write|scope,scope,...> (default read-only)",
			"--expires <30d|90d|365d|never> (default 90d)",
			"--with-token (read an issued token from stdin, never from an argument, instead of signing in through the browser)",
		},
		Description: "Log in as yourself: ask the server for a personal access token, open <server>/cli-login to approve it signed in to Orbit, wait for it, check it and save it in $ORBIT_HOME/user.json (0600) — or, with --with-token, read one issued under Settings → Access tokens from stdin. Warns when this machine's runner runs as the same OS user, whose agents could read that file.",
		Mutates:     true,
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"server":    map[string]interface{}{"type": "string", "description": "The Orbit server's URL."},
				"name":      map[string]interface{}{"type": "string", "description": "The token's name."},
				"scopes":    map[string]interface{}{"type": "string", "description": "read-only, read-write, or scopes separated by commas."},
				"expires":   map[string]interface{}{"type": "string", "enum": []string{"30d", "90d", "365d", "never"}},
				"withToken": map[string]interface{}{"type": "boolean", "description": "Read an issued token from stdin instead of signing in through the browser."},
			},
		},
		HeadlessOnly: true,
	},
	{
		Tool:        "logout",
		Argv:        []string{"orbit", "logout"},
		Usage:       "orbit logout [--keep-token]",
		Arguments:   []string{"--keep-token (only remove the saved login; the token keeps working)"},
		Description: "Revoke the personal access token `orbit login` saved and remove $ORBIT_HOME/user.json. Nothing is removed when the server cannot revoke it.",
		Mutates:     true,
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"keepToken": map[string]interface{}{"type": "boolean", "description": "Only remove the saved login; the token keeps working until it expires or is revoked."},
			},
		},
		HeadlessOnly: true,
	},
	{
		Tool:         "whoami",
		Argv:         []string{"orbit", "whoami"},
		Usage:        "orbit whoami [--json]",
		Arguments:    []string{"--json"},
		Description:  "Show who the CLI acts as — session, service token, you, or this machine's runner — and which rule chose it; as you, the token's email, name, scopes, workspaces and expiry, as the server reports them.",
		InputSchema:  map[string]interface{}{"type": "object", "properties": map[string]interface{}{}},
		HeadlessOnly: true,
	},
	{
		Tool:  "api",
		Argv:  []string{"orbit", "api"},
		Usage: "orbit api [-X METHOD] PATH [--data JSON | --data-file -] [--paginate] [--json]",
		Arguments: []string{
			"-X <GET|POST|PUT|PATCH|DELETE> (default GET, or POST with a body)",
			"<path> (required; under /api, e.g. /api/tasks)",
			"--data <json>",
			"--data-file - (read the JSON body from stdin)",
			"--paginate (follow nextCursor and print every page)",
			"--json",
		},
		Description: "Call the Orbit REST API as yourself with your personal access token, like `gh api`: one request under /api on your server, the answer printed. A non-2xx answer exits non-zero; 401 means the token is invalid, revoked or expired.",
		Mutates:     true,
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"method":   map[string]interface{}{"type": "string", "enum": []string{"GET", "POST", "PUT", "PATCH", "DELETE"}},
				"path":     map[string]interface{}{"type": "string", "description": "A path under /api, such as /api/tasks."},
				"data":     map[string]interface{}{"type": "string", "description": "The JSON request body."},
				"dataFile": map[string]interface{}{"type": "string", "enum": []string{"-"}, "description": "Read the JSON request body from stdin."},
				"paginate": map[string]interface{}{"type": "boolean", "description": "Follow nextCursor and print every page."},
			},
			"required": []string{"path"},
		},
		HeadlessOnly: true,
	},
}

func insideSession() bool { return strings.TrimSpace(os.Getenv("ORBIT_SESSION_ID")) != "" }

func cmdLoginCLI(args []string, in io.Reader, out, errOut io.Writer) error {
	fs := newCLIFlagSet("orbit login")
	withToken := fs.Bool("with-token", false, "read a personal access token from stdin")
	server := fs.String("server", "", "the Orbit server")
	name := fs.String("name", "", "the token's name")
	scopes := fs.String("scopes", "", "read-only, read-write, or scopes separated by commas")
	expires := fs.String("expires", "", "30d, 90d, 365d or never")
	if err := fs.Parse(args); err != nil {
		return err
	}
	for _, arg := range fs.Args() {
		if strings.HasPrefix(arg, userTokenPrefix) {
			return errors.New("a token is read from stdin, never from an argument, where shell history and process lists keep it: run `orbit login --with-token < token.txt`")
		}
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	if insideSession() {
		return errors.New("refused inside an Orbit session (ORBIT_SESSION_ID is set): a session acts as itself, and a personal access token is its user's alone — log in from your own terminal")
	}
	var request *deviceLoginRequest
	if *withToken {
		for _, flag := range []string{"name", "scopes", "expires"} {
			if flagWasSet(fs, flag) {
				return fmt.Errorf("--%s describes the token orbit login asks for through the browser; a token read with --with-token was issued already, with its own", flag)
			}
		}
	} else {
		r, err := newDeviceLoginRequest(*name, *scopes, *expires)
		if err != nil {
			return err
		}
		request = r
	}
	base, err := normalizeServerURL(firstNonEmpty(strings.TrimSpace(*server), loginServerDefault()))
	if err != nil {
		return err
	}
	var token string
	if request != nil {
		token, err = signInThroughBrowser(base, *request, errOut)
	} else {
		token, err = readTokenFromStdin(in, errOut)
	}
	if err != nil {
		return err
	}
	self, refused, err := readPatSelf(base, token)
	if err != nil {
		return fmt.Errorf("checking the token with %s: %w", base, err)
	}
	if refused {
		if request != nil {
			return fmt.Errorf("%s refused the token it had just issued (401): it was revoked or has expired already. Run `orbit login` again", base)
		}
		return fmt.Errorf("%s refused the token (401): it is invalid, revoked or expired. Issue a new one under Settings → Access tokens and run `orbit login --with-token` again", base)
	}
	previous, _ := loadUserLogin()
	if err := saveUserLogin(userLogin{ServerURL: base, Token: token, TokenID: self.Token.ID, Name: self.Token.Name, Email: self.Email}); err != nil {
		return fmt.Errorf("saving the login: %w", err)
	}
	var granted cliIdentity
	granted.confirm(self)
	fmt.Fprintf(out, "Logged in to %s as %s with the token %q (%s; %s).\n", base, self.Email, self.Token.Name,
		strings.Join(self.Token.Scopes, ", "), granted.expiryText())
	fmt.Fprintf(out, "Saved to %s.\n", userLoginFile())
	if previous != nil && previous.TokenID != self.Token.ID {
		fmt.Fprintf(errOut, "The login this replaces used the token %q, which keeps working until it expires or is revoked under Settings → Access tokens.\n", previous.Name)
	}
	if effective := resolveCLIIdentity(); effective.Source != userLoginFile() {
		fmt.Fprintf(errOut, "Note: %s and comes first, so commands in this environment do not act as this login while it is.\n", effective.Reason)
	}
	if runner := runnerSharingThisLogin(); runner != nil {
		fmt.Fprint(errOut, runnerSharesLoginWarning(runner))
	}
	return nil
}

// deviceLoginRequest is POST /api/access-tokens/device/start: the token `orbit login` asks the server
// for through the browser (§7.3) — its name, its scopes listed or as a preset, its lifetime in days
// (null: it never expires), and this host, which the approval page shows.
type deviceLoginRequest struct {
	Name          string   `json:"name"`
	Scopes        []string `json:"scopes,omitempty"`
	Preset        string   `json:"preset,omitempty"`
	ExpiresInDays *int     `json:"expiresInDays"`
	Hostname      string   `json:"hostname,omitempty"`
}

// The presets --scopes names. The server expands them from its own list of scopes, so a CLI built
// before a scope was added still asks for all of them.
var loginScopePresets = []string{"read-only", "read-write"}

// newDeviceLoginRequest is what --name, --scopes and --expires ask for, defaulted as the Settings
// page's New token dialog defaults them: read-only, for 90 days.
func newDeviceLoginRequest(name, scopes, expires string) (*deviceLoginRequest, error) {
	host := hostnameOr()
	request := &deviceLoginRequest{Name: strings.TrimSpace(name), Hostname: host}
	if request.Name == "" {
		request.Name = "orbit CLI on " + host
	}
	switch scopes = strings.TrimSpace(scopes); {
	case scopes == "":
		request.Preset = "read-only"
	case contains(loginScopePresets, scopes):
		request.Preset = scopes
	default:
		for _, scope := range strings.Split(scopes, ",") {
			if scope = strings.TrimSpace(scope); scope != "" {
				request.Scopes = append(request.Scopes, scope)
			}
		}
		if len(request.Scopes) == 0 {
			return nil, errors.New("--scopes names no scope: pass read-only, read-write, or scopes separated by commas, such as tasks:read,tasks:write")
		}
	}
	days := map[string]int{"": 90, "30d": 30, "90d": 90, "365d": 365}
	switch expires = strings.TrimSpace(expires); {
	case expires == "never":
		// Left nil: sent as null, a token that never expires.
	case days[expires] != 0:
		lifetime := days[expires]
		request.ExpiresInDays = &lifetime
	default:
		return nil, fmt.Errorf("--expires must be 30d, 90d, 365d or never, not %q", expires)
	}
	return request, nil
}

// openLoginPage opens the approval page for `orbit login`: a variable so tests can stand in for the
// person at the browser.
var openLoginPage = openBrowser

// loginPollFloor is the shortest wait between two polls, whatever the server asks for.
var loginPollFloor = time.Second

// deviceLoginStart is the answer to POST /api/access-tokens/device/start.
type deviceLoginStart struct {
	DeviceCode string `json:"deviceCode"`
	UserCode   string `json:"userCode"`
	Interval   int    `json:"interval"`
	ExpiresIn  int    `json:"expiresIn"`
}

// signInThroughBrowser is `orbit login` without --with-token (§7.3), in `orbit register`'s device-flow
// shape: ask the server for a token, send the person to <server>/cli-login?code=… to approve it signed
// in to Orbit, and poll until the server answers with the token — issued to whoever approved, in that
// one answer — or says the request was denied or ran out. Neither request carries a credential: the
// device code, which only this process holds, is what the poll is made with.
func signInThroughBrowser(base string, request deviceLoginRequest, errOut io.Writer) (string, error) {
	body, err := json.Marshal(request)
	if err != nil {
		return "", err
	}
	res, err := userAPIRequest(base, "", http.MethodPost, "/api/access-tokens/device/start", body)
	if err != nil {
		return "", fmt.Errorf("asking %s for a token: %w", base, err)
	}
	if res.status == http.StatusNotFound {
		return "", fmt.Errorf("%s does not offer signing in through the browser (404): issue a token under Settings → Access tokens and run `orbit login --with-token`", base)
	}
	if res.status < 200 || res.status >= 300 {
		return "", fmt.Errorf("%s refused the login request (%d): %s", base, res.status, answerMessage(res.body))
	}
	var start deviceLoginStart
	if err := json.Unmarshal(res.body, &start); err != nil || start.DeviceCode == "" || start.UserCode == "" {
		return "", fmt.Errorf("%s did not answer the login request with a code", base)
	}
	link := base + "/cli-login?code=" + url.QueryEscape(start.UserCode)
	fmt.Fprintf(errOut, "\nTo log in, open this page, sign in to Orbit and approve the request:\n\n  %s\n\n  Verification code: %s\n\n"+
		"It asks for a token named %q. Waiting for approval...\n", link, start.UserCode, request.Name)
	openLoginPage(link)

	poll, err := json.Marshal(map[string]string{"deviceCode": start.DeviceCode})
	if err != nil {
		return "", err
	}
	interval := time.Duration(start.Interval) * time.Second
	if interval < loginPollFloor {
		interval = loginPollFloor
	}
	for deadline := time.Now().Add(time.Duration(start.ExpiresIn) * time.Second); time.Now().Before(deadline); {
		time.Sleep(interval)
		res, err := userAPIRequest(base, "", http.MethodPost, "/api/access-tokens/device/poll", poll)
		if err != nil || res.status >= 500 || res.status == http.StatusTooManyRequests {
			continue // transient: keep waiting until the request runs out
		}
		if res.status < 200 || res.status >= 300 {
			return "", fmt.Errorf("%s refused the login (%d): %s", base, res.status, answerMessage(res.body))
		}
		var answer struct {
			Status string `json:"status"`
			Token  string `json:"token"`
		}
		if err := json.Unmarshal(res.body, &answer); err != nil {
			continue
		}
		switch answer.Status {
		case "pending":
			continue
		case "approved":
			if !strings.HasPrefix(answer.Token, userTokenPrefix) {
				return "", fmt.Errorf("%s approved the login but answered no personal access token", base)
			}
			return answer.Token, nil
		case "denied":
			return "", errors.New("the login request was denied in the browser; no token was issued")
		case "expired":
			return "", errors.New("the login request expired before it was approved: run `orbit login` again")
		case "delivered":
			return "", fmt.Errorf("the token was issued to an earlier answer that never arrived here: revoke %q under Settings → Access tokens and run `orbit login` again", request.Name)
		default:
			return "", fmt.Errorf("%s answered the login with %q", base, answer.Status)
		}
	}
	return "", errors.New("timed out waiting for approval: run `orbit login` again")
}

// answerMessage is what an answer's body says: its `message` (a list of them joined), or the body.
func answerMessage(body []byte) string {
	var answer struct {
		Message any `json:"message"`
	}
	if json.Unmarshal(body, &answer) == nil {
		switch message := answer.Message.(type) {
		case string:
			if message != "" {
				return message
			}
		case []any:
			parts := make([]string, 0, len(message))
			for _, part := range message {
				parts = append(parts, fmt.Sprint(part))
			}
			return strings.Join(parts, "; ")
		}
	}
	return strings.TrimSpace(string(body))
}

// loginServerDefault is the server `orbit login` signs in to without --server: ORBIT_SERVER_URL, the
// server of the login it replaces, this machine's runner's, or the one this binary was built for.
func loginServerDefault() string {
	saved := ""
	if login, err := loadUserLogin(); err == nil && login != nil {
		saved = login.ServerURL
	}
	return firstNonEmpty(strings.TrimSpace(os.Getenv(envUserServerURL)), saved, runnerServerURL(), defaultServer)
}

// maxUserTokenBytes bounds what `orbit login --with-token` reads; a token is 53 characters.
const maxUserTokenBytes = 4096

// readTokenFromStdin reads the token `orbit login --with-token` is handed: the first line of stdin,
// piped from a file or a secret store, or pasted at the prompt and ended with Enter. Stdin is the only
// place it takes one from, so a token never sits in an argument list or a shell history (§7.3).
func readTokenFromStdin(in io.Reader, errOut io.Writer) (string, error) {
	if f, ok := in.(*os.File); ok && f == os.Stdin && interactive() {
		fmt.Fprint(errOut, "Paste a personal access token (Settings → Access tokens) and press Enter: ")
	}
	line, err := bufio.NewReader(io.LimitReader(in, maxUserTokenBytes)).ReadString('\n')
	if err != nil && err != io.EOF {
		return "", fmt.Errorf("reading the token from stdin: %w", err)
	}
	token := strings.TrimSpace(line)
	if token == "" {
		return "", errors.New("no token on stdin: pipe one in, as in `orbit login --with-token < token.txt`")
	}
	if !strings.HasPrefix(token, userTokenPrefix) {
		return "", fmt.Errorf("that is not a personal access token, which starts with %s: issue one under Settings → Access tokens", userTokenPrefix)
	}
	return token, nil
}

// runnerSharingThisLogin is this machine's runner when the agents it runs could read the login just
// saved, nil otherwise (§8). The runner keeps config.json in its ORBIT_HOME, which is where user.json
// goes too, and that directory is 0700: a runner reading its config there runs as this OS user (or as
// root), and so does every agent session it starts.
func runnerSharingThisLogin() *RunnerConfig {
	if cfg := loadConfig(); cfg != nil && cfg.RunnerToken != "" {
		return cfg
	}
	return nil
}

func runnerSharesLoginWarning(runner *RunnerConfig) string {
	return fmt.Sprintf(`
Warning: this machine is the registered Orbit runner %q, and its service runs as this OS user.
Every agent session it runs can read %s — file permissions do not keep them out —
and act as you with it. The CLI ignores this token inside a session, but that is not a boundary.
Safer:
  - do your own scripting here as a separate OS user, or
  - give the token used here only the scopes it needs, confine it to workspaces and keep its
    expiry short (Settings → Access tokens).
`, runner.Name, userLoginFile())
}

func cmdLogoutCLI(args []string, out, errOut io.Writer) error {
	fs := newCLIFlagSet("orbit logout")
	keepToken := fs.Bool("keep-token", false, "only remove the saved login")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	if insideSession() {
		return errors.New("refused inside an Orbit session (ORBIT_SESSION_ID is set): a session never acts as your login — log out from your own terminal")
	}
	path := userLoginFile()
	if !exists(path) {
		if strings.TrimSpace(os.Getenv(envUserToken)) != "" {
			return fmt.Errorf("no login is saved at %s. The token in ORBIT_USER_TOKEN is not one orbit keeps: unset the variable, and revoke the token under Settings → Access tokens if it should stop working", path)
		}
		return fmt.Errorf("not logged in: no login is saved at %s", path)
	}
	login, loadErr := loadUserLogin()
	ended := false
	if !*keepToken {
		if loadErr != nil {
			return fmt.Errorf("%v. Its token is not sent anywhere to be revoked: revoke it under Settings → Access tokens, then remove the file with `orbit logout --keep-token`", loadErr)
		}
		res, err := userAPIRequest(login.ServerURL, login.Token, http.MethodDelete, "/api/pat/self", nil)
		if err == nil && res.status != http.StatusUnauthorized && (res.status < 200 || res.status >= 300) {
			err = &transportHTTPError{method: http.MethodDelete, path: "/api/pat/self", statusCode: res.status, body: string(res.body)}
		}
		if err != nil {
			return fmt.Errorf("could not revoke the token at %s: %v\nNothing was removed: try again, or run `orbit logout --keep-token` and revoke it under Settings → Access tokens", login.ServerURL, err)
		}
		// Refused is a token that no longer works — invalid, revoked or expired: nothing is left to revoke.
		ended = res.status == http.StatusUnauthorized
	}
	if err := removeUserLogin(); err != nil {
		return err
	}
	token := "its token"
	if login != nil && login.Name != "" {
		token = fmt.Sprintf("the token %q", login.Name)
	}
	switch {
	case *keepToken:
		fmt.Fprintf(out, "Logged out: removed %s. %s keeps working until it expires or is revoked under Settings → Access tokens.\n", path, capitalized(token))
	case ended:
		fmt.Fprintf(out, "Logged out: removed %s. %s was already invalid, revoked or expired.\n", path, capitalized(token))
	default:
		fmt.Fprintf(out, "Logged out of %s: revoked %s and removed %s.\n", login.ServerURL, token, path)
	}
	if strings.TrimSpace(os.Getenv(envUserToken)) != "" {
		fmt.Fprintln(errOut, "Note: ORBIT_USER_TOKEN is still set, so commands in this environment act as that token.")
	}
	return nil
}

func capitalized(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

func cmdWhoamiCLI(args []string, out, errOut io.Writer) error {
	fs := newCLIFlagSet("orbit whoami")
	jsonOut := fs.Bool("json", false, "print JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	identity := resolveCLIIdentity()
	noteUserTokenIgnored(identity, errOut)
	var problem error
	if identity.Problem != "" {
		problem = errors.New(identity.Problem)
	} else if identity.Kind == identityUser {
		self, refused, err := readPatSelf(identity.ServerURL, identity.token)
		switch {
		case err != nil:
			problem = fmt.Errorf("checking the token with %s: %w", identity.ServerURL, err)
		case refused:
			problem = userTokenRefused(identity)
		default:
			identity.confirm(self)
		}
		if problem != nil {
			identity.Problem = problem.Error()
		}
	}
	if *jsonOut {
		enc := json.NewEncoder(out)
		enc.SetEscapeHTML(false)
		if err := enc.Encode(identity); err != nil {
			return err
		}
	} else if err := writeIdentity(out, identity); err != nil {
		return err
	}
	return problem
}

// writeIdentity is `orbit whoami` for a person: one line for each thing this process knows. What is
// wrong with it is not among them — that is the command's error, on stderr — and neither is a token
// ignored inside a session, which noteUserTokenIgnored has said there already.
func writeIdentity(out io.Writer, identity cliIdentity) error {
	var b strings.Builder
	line := func(key, value string) {
		if value != "" {
			fmt.Fprintf(&b, "%-12s%s\n", key+":", value)
		}
	}
	line("identity", identity.Kind)
	line("reason", identity.Reason)
	line("server", identity.ServerURL)
	line("session", identity.SessionID)
	line("runner", strings.TrimSpace(identity.RunnerName+" "+parenthesized(identity.RunnerID)))
	line("email", identity.Email)
	line("token", strings.TrimSpace(identity.TokenName+" "+parenthesized(identity.TokenID)))
	line("scopes", strings.Join(identity.Scopes, ", "))
	workspaces := strings.Join(identity.WorkspaceIDs, ", ")
	if workspaces == "" && identity.verified {
		workspaces = "all (not confined)"
	}
	line("workspaces", workspaces)
	expires := identity.ExpiresAt
	if identity.NeverExpires {
		expires = "never"
	}
	line("expires", expires)
	_, err := io.WriteString(out, b.String())
	return err
}

func parenthesized(s string) string {
	if s == "" {
		return ""
	}
	return "(" + s + ")"
}

// expiryText is when the credential expires, "never" for a token issued not to, and "" when this
// process does not know.
func (identity cliIdentity) expiryText() string {
	if identity.NeverExpires {
		return "never expires"
	}
	if identity.ExpiresAt != "" {
		return "expires " + identity.ExpiresAt
	}
	return ""
}

// patSelf is GET /api/pat/self, a token reading itself (§6.5).
type patSelf struct {
	UserID string `json:"userId"`
	Email  string `json:"email"`
	Token  struct {
		ID           string   `json:"id"`
		Name         string   `json:"name"`
		Scopes       []string `json:"scopes"`
		WorkspaceIDs []string `json:"workspaceIds"`
		ExpiresAt    *string  `json:"expiresAt"`
	} `json:"token"`
}

// readPatSelf asks server about token. refused is a 401: a token that is invalid, revoked or expired —
// the server does not say which.
func readPatSelf(server, token string) (self *patSelf, refused bool, err error) {
	res, err := userAPIRequest(server, token, http.MethodGet, "/api/pat/self", nil)
	if err != nil {
		return nil, false, err
	}
	if res.status == http.StatusUnauthorized {
		return nil, true, nil
	}
	if res.status < 200 || res.status >= 300 {
		return nil, false, &transportHTTPError{method: http.MethodGet, path: "/api/pat/self", statusCode: res.status, body: string(res.body)}
	}
	var answer patSelf
	if err := json.Unmarshal(res.body, &answer); err != nil || answer.Token.ID == "" {
		return nil, false, errors.New("GET /api/pat/self did not answer with a token")
	}
	return &answer, false, nil
}

// confirm fills a user's identity in from what the server said about the token.
func (identity *cliIdentity) confirm(self *patSelf) {
	identity.UserID = self.UserID
	identity.Email = self.Email
	identity.TokenID = self.Token.ID
	identity.TokenName = self.Token.Name
	identity.Scopes = self.Token.Scopes
	identity.WorkspaceIDs = self.Token.WorkspaceIDs
	identity.ExpiresAt, identity.NeverExpires = "", self.Token.ExpiresAt == nil
	if self.Token.ExpiresAt != nil {
		identity.ExpiresAt = *self.Token.ExpiresAt
	}
	identity.verified = true
}

// userTokenRefused is what every command acting as the person says to a 401 (§6.1): the server does
// not tell a token that never existed from one revoked or expired, and the way out is the same.
func userTokenRefused(identity cliIdentity) error {
	if identity.Source == envUserToken {
		return errors.New("the personal access token in ORBIT_USER_TOKEN was refused (401): it is invalid, revoked or expired. Set a new one (Settings → Access tokens), or unset it and run `orbit login`")
	}
	return errors.New("the personal access token `orbit login` saved was refused (401): it is invalid, revoked or expired. Run `orbit login` again")
}

// actingUser is nil when this process acts as its user, and otherwise why a command that acts as them
// cannot run here. The order is not stepped around to reach a personal access token (§7.2), and
// nothing falls back to the runner's credential (§7.3).
func actingUser(identity cliIdentity) error {
	switch identity.Kind {
	case identityUser:
		if identity.Problem != "" {
			return errors.New(identity.Problem)
		}
		return nil
	case identitySession:
		return errors.New("it acts as you, and inside an Orbit session (ORBIT_SESSION_ID is set) the CLI acts as the session: a personal access token is never used there")
	case identityService:
		return errors.New("it acts as you, and ORBIT_SERVICE_TOKEN is set, which comes first: unset it to act as yourself")
	default:
		return errors.New("it acts as you, and you are not logged in: run `orbit login` (or set ORBIT_USER_TOKEN); the runner's credential is the machine's, never yours")
	}
}

func cmdAPICLI(args []string, in io.Reader, out, errOut io.Writer) error {
	fs := newCLIFlagSet("orbit api")
	method := fs.String("X", "", "HTTP method")
	data := fs.String("data", "", "JSON request body")
	dataFile := fs.String("data-file", "", "read the JSON request body from stdin (-)")
	paginate := fs.Bool("paginate", false, "follow nextCursor and print every page")
	jsonOut := fs.Bool("json", false, "print compact JSON")
	positionals, err := parseInterspersed(fs, args)
	if err != nil {
		return err
	}
	if len(positionals) != 1 {
		return fmt.Errorf("expected one PATH, as in `orbit api /api/tasks`; got %d arguments", len(positionals))
	}
	target, err := apiRequestPath(positionals[0])
	if err != nil {
		return err
	}
	text, hasBody, err := readCLIText(in, *data, flagWasSet(fs, "data"), *dataFile, flagWasSet(fs, "data-file"), "data")
	if err != nil {
		return err
	}
	var body []byte
	if hasBody {
		if !json.Valid([]byte(text)) {
			return errors.New("the request body is not valid JSON")
		}
		body = []byte(text)
	}
	verb := strings.ToUpper(strings.TrimSpace(*method))
	if verb == "" {
		verb = http.MethodGet
		if body != nil {
			verb = http.MethodPost
		}
	}
	switch verb {
	case http.MethodGet, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
	default:
		return fmt.Errorf("-X must be GET, POST, PUT, PATCH or DELETE, not %q", *method)
	}
	if body != nil && verb == http.MethodGet {
		return errors.New("a GET takes no body: pass -X POST, PUT, PATCH or DELETE with --data")
	}
	if *paginate && verb != http.MethodGet {
		return errors.New("--paginate pages through a GET")
	}

	identity := resolveCLIIdentity()
	noteUserTokenIgnored(identity, errOut)
	if err := actingUser(identity); err != nil {
		return err
	}
	seen := map[string]bool{}
	for {
		res, err := userAPIRequest(identity.ServerURL, identity.token, verb, target, body)
		if err != nil {
			return err
		}
		if err := writeAPIAnswer(out, res.body, *jsonOut); err != nil {
			return err
		}
		if res.status == http.StatusUnauthorized {
			return userTokenRefused(identity)
		}
		if res.status < 200 || res.status >= 300 {
			return apiStatusError(verb, target, res)
		}
		if !*paginate {
			return nil
		}
		cursor := nextCursorOf(res.body)
		if cursor == "" {
			return nil
		}
		if seen[cursor] {
			return fmt.Errorf("--paginate: the server answered the cursor %q a second time; stopping", cursor)
		}
		seen[cursor] = true
		target = withCursor(target, cursor)
	}
}

// parseInterspersed parses fs from args with positional arguments anywhere among the flags, as in
// `orbit api -X POST /api/tasks --data …`, where Go's flag package stops at the first of them.
func parseInterspersed(fs *flag.FlagSet, args []string) ([]string, error) {
	var positionals []string
	for {
		if err := fs.Parse(args); err != nil {
			return nil, err
		}
		if fs.NArg() == 0 {
			return positionals, nil
		}
		positionals = append(positionals, fs.Arg(0))
		args = fs.Args()[1:]
	}
}

// apiRequestPath is PATH as `orbit api` requests it, always under /api on the token's own server:
// /api/tasks, api/tasks and tasks alike. A URL is refused — the token is sent to the server it was
// saved with and to no other — and so is a path that climbs out of /api.
func apiRequestPath(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", errors.New("PATH is empty: name a path under /api, such as /api/tasks")
	}
	if strings.Contains(raw, "://") || strings.HasPrefix(raw, "//") {
		return "", errors.New("PATH is a path on your Orbit server, such as /api/tasks, not a URL: a personal access token is sent only to the server it belongs to")
	}
	p, query, hasQuery := strings.Cut(raw, "?")
	p = "/" + strings.TrimLeft(p, "/")
	if p != "/api" && !strings.HasPrefix(p, "/api/") {
		p = "/api" + p
	}
	p = path.Clean(p)
	if !strings.HasPrefix(p, "/api/") {
		return "", fmt.Errorf("PATH %q is not under /api", raw)
	}
	if hasQuery {
		p += "?" + query
	}
	return p, nil
}

// writeAPIAnswer prints an answer's body: JSON indented, or compact with --json; anything else as it came.
func writeAPIAnswer(out io.Writer, body []byte, compact bool) error {
	if len(bytes.TrimSpace(body)) == 0 {
		return nil
	}
	if json.Valid(body) {
		return writeCLIRawJSON(out, body, compact)
	}
	if _, err := out.Write(body); err != nil {
		return err
	}
	if body[len(body)-1] != '\n' {
		_, err := io.WriteString(out, "\n")
		return err
	}
	return nil
}

// apiStatusError is a non-2xx answer `orbit api` has already printed: the status, and the refusal's
// code and next step when its body names them.
func apiStatusError(method, target string, res *userAPIResponse) error {
	refusal := (&transportHTTPError{body: string(res.body)}).refusal()
	if refusal == "" {
		return fmt.Errorf("%s %s -> %d", method, target, res.status)
	}
	return fmt.Errorf("%s %s -> %d\n%s", method, target, res.status, strings.TrimRight(refusal, "\n"))
}

// nextCursorOf is the cursor a paged answer names for its next page — {items, nextCursor}, as GET
// /api/tasks/page answers — or "" when it names none.
func nextCursorOf(body []byte) string {
	var page struct {
		NextCursor *string `json:"nextCursor"`
	}
	if json.Unmarshal(body, &page) != nil || page.NextCursor == nil {
		return ""
	}
	return *page.NextCursor
}

// withCursor is target asking for the page cursor starts.
func withCursor(target, cursor string) string {
	p, query, _ := strings.Cut(target, "?")
	values, _ := url.ParseQuery(query)
	values.Set("cursor", cursor)
	return p + "?" + values.Encode()
}

// userAPITimeout bounds each request a command acting as the person makes, so a script is not left
// waiting on a server that stopped answering.
const userAPITimeout = 2 * time.Minute

// userAPIClient sends the person's requests. A personal access token goes to the origin it was issued
// by and no other, so a redirect that changes the scheme or the host is not followed: Go drops the
// Authorization header across hosts by itself, but would carry it from https to http.
var userAPIClient = &http.Client{
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		first := via[0].URL
		if req.URL.Scheme != first.Scheme || !strings.EqualFold(req.URL.Host, first.Host) {
			return fmt.Errorf("refusing the redirect to %s: a personal access token is sent only to %s://%s", req.URL.Redacted(), first.Scheme, first.Host)
		}
		if len(via) >= 10 {
			return errors.New("stopped after 10 redirects")
		}
		return nil
	},
}

type userAPIResponse struct {
	status int
	body   []byte
}

// userAPIRequest sends one request to target — a path under /api, with its query — on server, as token
// (none when token is empty).
func userAPIRequest(server, token, method, target string, body []byte) (*userAPIResponse, error) {
	return userAPIRequestWithin(server, token, method, target, body, userAPITimeout)
}

// userAPIRequestWithin is userAPIRequest bounded by timeout instead, for a request the server holds open
// on purpose: `orbit session merge --wait-seconds`.
func userAPIRequestWithin(server, token, method, target string, body []byte, timeout time.Duration) (*userAPIResponse, error) {
	base, err := normalizeServerURL(server)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, base+target, reader)
	if err != nil {
		return nil, err
	}
	// `orbit login` starts and polls with no credential at all.
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	// The settings page shows the client a token was last used from.
	req.Header.Set("User-Agent", "orbit-cli/"+version)
	resp, err := userAPIClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("%s %s: reading the answer: %w", method, target, err)
	}
	return &userAPIResponse{status: resp.StatusCode, body: data}, nil
}

// normalizeServerURL is a server's base URL as the CLI keeps it: http or https, a host, no trailing slash.
func normalizeServerURL(raw string) (string, error) {
	trimmed := strings.TrimRight(strings.TrimSpace(raw), "/")
	u, err := url.Parse(trimmed)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.RawQuery != "" || u.Fragment != "" {
		return "", fmt.Errorf("%q is not a server URL such as https://orbit.example.com", raw)
	}
	return trimmed, nil
}
