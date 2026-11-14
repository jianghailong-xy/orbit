package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// The TERMINAL credential (docs/terminal-session-design.md, "The terminal credential"): what `orbit` in a terminal
// acts with. The owner approves this machine's terminal in the Orbit app once, and the credential is remembered for
// the 30 days the server gives it (D7 = B).
//
// It is kept in the OS keychain — the macOS Keychain through /usr/bin/security, the Linux Secret Service through
// secret-tool — and where there is none, in a 0600 file under ORBIT_HOME. Never in the environment: no variable is
// read or set for it, and the keychain tools are handed it on stdin, never as an argument another process could list.

const terminalHelp = `orbit terminal — sign this terminal in to Orbit

Usage:
  orbit terminal login      Approve this terminal in the Orbit app, or reuse the approval it already has
  orbit terminal logout     Revoke this terminal's credential on the server and forget it here

A terminal signs in with this machine's runner: run 'orbit register' first. 'orbit terminal login'
asks the Orbit app on your phone to approve "Terminal on <this machine>" and shows the code the app
shows; once you approve, the credential is remembered for 30 days in the OS keychain (macOS
Keychain, or the Linux Secret Service when one is running), and otherwise in
$ORBIT_HOME/terminal.json (0600). It is never put in the environment. A credential that expired or
that the server refuses (revoked in Settings → Terminals) is replaced by asking again.
`

const (
	terminalTokenPrefix     = "orbit_term_"
	terminalKeychainService = "orbit-terminal"
	terminalKeychainLabel   = "Orbit terminal"
	// What /usr/bin/security exits with when the item is not there (errSecItemNotFound).
	securityItemNotFound = 44
)

// terminalCredential is what is remembered of an approved terminal: the server and runner it belongs to, the
// credential, and when the server said it ends.
type terminalCredential struct {
	ServerURL   string    `json:"serverUrl"`
	RunnerID    string    `json:"runnerId"`
	TerminalID  string    `json:"terminalId"`
	MachineName string    `json:"machineName"`
	Token       string    `json:"token"`
	ExpiresAt   time.Time `json:"expiresAt"`
}

func (c *terminalCredential) live(now time.Time) bool {
	return c != nil && strings.HasPrefix(c.Token, terminalTokenPrefix) && now.Before(c.ExpiresAt)
}

// terminalKeychainOS and terminalLookPath pick the keychain: variables so the tests can stand a fake tool in for
// either platform's.
var (
	terminalKeychainOS = runtime.GOOS
	terminalLookPath   = exec.LookPath
)

// terminalKeychain is the OS keychain's tool, or nil when this machine has none the CLI can use.
type terminalKeychain struct {
	kind string // "macOS Keychain" | "Secret Service"
	path string
}

func findTerminalKeychain() *terminalKeychain {
	switch terminalKeychainOS {
	case "darwin":
		if path, err := terminalLookPath("security"); err == nil {
			return &terminalKeychain{kind: "macOS Keychain", path: path}
		}
	case "linux", "freebsd", "openbsd", "netbsd":
		// secret-tool talks to the Secret Service over the session bus; with no bus there is no keychain to reach.
		if os.Getenv("DBUS_SESSION_BUS_ADDRESS") == "" {
			return nil
		}
		if path, err := terminalLookPath("secret-tool"); err == nil {
			return &terminalKeychain{kind: "Secret Service", path: path}
		}
	}
	return nil
}

// account is the keychain item's account: one terminal credential per server.
func terminalKeychainAccount(server string) string { return server }

func (k *terminalKeychain) save(server string, secret []byte) error {
	var cmd *exec.Cmd
	if k.kind == "macOS Keychain" {
		// `security -i` reads its commands from stdin; -X takes the password hex-encoded, so the secret is never an
		// argument of any process.
		cmd = exec.Command(k.path, "-i")
		cmd.Stdin = strings.NewReader(fmt.Sprintf("add-generic-password -U -s %s -a %s -l %s -X %x\n",
			shellWord(terminalKeychainService), shellWord(terminalKeychainAccount(server)), shellWord(terminalKeychainLabel), secret))
	} else {
		// secret-tool store reads the secret from stdin.
		cmd = exec.Command(k.path, "store", "--label="+terminalKeychainLabel,
			"service", terminalKeychainService, "account", terminalKeychainAccount(server))
		cmd.Stdin = bytes.NewReader(secret)
	}
	cmd.Env = terminalToolEnv()
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("%s: %v %s", k.kind, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// load answers the item, or nil with no error when there is none.
func (k *terminalKeychain) load(server string) ([]byte, error) {
	var cmd *exec.Cmd
	if k.kind == "macOS Keychain" {
		cmd = exec.Command(k.path, "find-generic-password", "-s", terminalKeychainService, "-a", terminalKeychainAccount(server), "-w")
	} else {
		cmd = exec.Command(k.path, "lookup", "service", terminalKeychainService, "account", terminalKeychainAccount(server))
	}
	cmd.Env = terminalToolEnv()
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		// security: 44 is "not found". secret-tool lookup exits 1 with nothing printed when there is no item.
		if (k.kind == "macOS Keychain" && exit.ExitCode() == securityItemNotFound) || (k.kind != "macOS Keychain" && stdout.Len() == 0) {
			return nil, nil
		}
	}
	if err != nil {
		return nil, fmt.Errorf("%s: %v %s", k.kind, err, strings.TrimSpace(stderr.String()))
	}
	return bytes.TrimSpace(stdout.Bytes()), nil
}

func (k *terminalKeychain) remove(server string) error {
	var cmd *exec.Cmd
	if k.kind == "macOS Keychain" {
		cmd = exec.Command(k.path, "delete-generic-password", "-s", terminalKeychainService, "-a", terminalKeychainAccount(server))
	} else {
		cmd = exec.Command(k.path, "clear", "service", terminalKeychainService, "account", terminalKeychainAccount(server))
	}
	cmd.Env = terminalToolEnv()
	_ = cmd.Run() // an item that is not there is already removed
	return nil
}

// terminalToolEnv is the environment the keychain tools run with: the CLI's own, which carries no credential of a
// terminal — nothing ever puts one there.
func terminalToolEnv() []string { return os.Environ() }

// shellWord quotes a word for `security -i`, which splits its command lines as a shell does.
func shellWord(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// terminalCredentialFile is where the credential is kept when there is no keychain.
func terminalCredentialFile() string { return filepath.Join(machineHome(), "terminal.json") }

// saveTerminalCredential keeps c in the keychain, or in a 0600 file under ORBIT_HOME when there is none or it refuses.
// It answers where it was kept.
func saveTerminalCredential(c *terminalCredential) (string, error) {
	data, err := json.Marshal(c)
	if err != nil {
		return "", err
	}
	if keychain := findTerminalKeychain(); keychain != nil {
		if err := keychain.save(c.ServerURL, data); err == nil {
			// A copy an earlier run left in the file is not left behind.
			_ = os.Remove(terminalCredentialFile())
			return keychain.kind, nil
		}
	}
	if err := writePrivateFile(terminalCredentialFile(), data); err != nil {
		return "", err
	}
	return terminalCredentialFile(), nil
}

// writePrivateFile writes data to path, mode 0600, in a 0700 directory, through a file of that mode renamed into
// place: at no moment is the credential in a file another account could read.
func writePrivateFile(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, machineHomePerm); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".terminal-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(configFilePerm); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return err
	}
	return os.Chmod(path, configFilePerm)
}

// loadTerminalCredential is the credential kept for server: the keychain's, else the file's; nil when there is none.
func loadTerminalCredential(server string) *terminalCredential {
	var data []byte
	if keychain := findTerminalKeychain(); keychain != nil {
		data, _ = keychain.load(server)
	}
	if len(data) == 0 {
		if b, err := os.ReadFile(terminalCredentialFile()); err == nil {
			data = b
		}
	}
	if len(data) == 0 {
		return nil
	}
	var c terminalCredential
	if json.Unmarshal(data, &c) != nil || c.ServerURL != server {
		return nil
	}
	return &c
}

// forgetTerminalCredential removes what is kept for server, wherever it is.
func forgetTerminalCredential(server string) {
	if keychain := findTerminalKeychain(); keychain != nil {
		_ = keychain.remove(server)
	}
	_ = os.Remove(terminalCredentialFile())
}

// terminalLoginSleep is the wait between polls: a variable so tests do not wait.
var terminalLoginSleep = time.Sleep

// ensureTerminalCredential answers this machine's terminal credential: the one kept, while it has not expired and the
// server does not refuse it (401); otherwise a new one, from the owner's approval in the app.
func ensureTerminalCredential(out io.Writer) (*terminalCredential, error) {
	if insideSession() {
		return nil, errors.New("refused inside an Orbit session (ORBIT_SESSION_ID is set): a terminal signs in from your own terminal")
	}
	cfg := loadConfig()
	if cfg == nil || cfg.RunnerToken == "" {
		return nil, errors.New(noRunnerMessage)
	}
	server, err := normalizeServerURL(cfg.ServerURL)
	if err != nil {
		return nil, err
	}
	if kept := loadTerminalCredential(server); kept.live(time.Now()) && kept.RunnerID == cfg.RunnerID {
		res, err := userAPIRequest(server, kept.Token, http.MethodGet, "/api/terminals/self", nil)
		if err != nil {
			return nil, fmt.Errorf("checking this terminal's credential with %s: %w", server, err)
		}
		if res.status != http.StatusUnauthorized {
			return kept, nil
		}
	}
	forgetTerminalCredential(server)
	return terminalSignIn(server, cfg, out)
}

// terminalLoginStart is the answer to POST /api/runner/terminal-login/start.
type terminalLoginStart struct {
	DeviceCode  string `json:"deviceCode"`
	UserCode    string `json:"userCode"`
	MachineName string `json:"machineName"`
	Interval    int    `json:"interval"`
	ExpiresIn   int    `json:"expiresIn"`
}

// terminalSignIn asks the owner to approve this terminal and waits for the credential: started and polled with the
// machine's runner credential, which is what binds the credential to this runner.
func terminalSignIn(server string, cfg *RunnerConfig, out io.Writer) (*terminalCredential, error) {
	res, err := userAPIRequest(server, cfg.RunnerToken, http.MethodPost, "/api/runner/terminal-login/start", []byte("{}"))
	if err != nil {
		return nil, fmt.Errorf("asking %s to approve this terminal: %w", server, err)
	}
	if res.status == http.StatusNotFound {
		return nil, fmt.Errorf("%s does not offer terminal sign-in yet (404): upgrade the server", server)
	}
	if res.status < 200 || res.status >= 300 {
		return nil, fmt.Errorf("%s refused the terminal sign-in (%d): %s", server, res.status, answerMessage(res.body))
	}
	var start terminalLoginStart
	if err := json.Unmarshal(res.body, &start); err != nil || start.DeviceCode == "" || start.UserCode == "" {
		return nil, fmt.Errorf("%s did not answer the terminal sign-in with a code", server)
	}
	fmt.Fprintf(out, "Approve this terminal in the Orbit app on your phone.\n  Terminal on %s · code %s\n  Waiting… (ctrl-c to cancel)\n",
		start.MachineName, start.UserCode)

	poll, _ := json.Marshal(map[string]string{"deviceCode": start.DeviceCode})
	interval := time.Duration(max(1, start.Interval)) * time.Second
	for deadline := time.Now().Add(time.Duration(start.ExpiresIn) * time.Second); time.Now().Before(deadline); {
		terminalLoginSleep(interval)
		res, err := userAPIRequest(server, cfg.RunnerToken, http.MethodPost, "/api/runner/terminal-login/poll", poll)
		if err != nil || res.status >= 500 || res.status == http.StatusTooManyRequests {
			continue // transient: keep waiting until the request runs out
		}
		if res.status < 200 || res.status >= 300 {
			return nil, fmt.Errorf("%s refused the terminal sign-in (%d): %s", server, res.status, answerMessage(res.body))
		}
		var answer struct {
			Status      string    `json:"status"`
			Token       string    `json:"token"`
			TerminalID  string    `json:"terminalId"`
			MachineName string    `json:"machineName"`
			ExpiresAt   time.Time `json:"expiresAt"`
		}
		if json.Unmarshal(res.body, &answer) != nil {
			continue
		}
		switch answer.Status {
		case "pending":
			continue
		case "approved":
			cred := &terminalCredential{
				ServerURL: server, RunnerID: cfg.RunnerID, TerminalID: answer.TerminalID,
				MachineName: answer.MachineName, Token: answer.Token, ExpiresAt: answer.ExpiresAt,
			}
			if !cred.live(time.Now()) {
				return nil, fmt.Errorf("%s approved the terminal but answered no terminal credential", server)
			}
			where, err := saveTerminalCredential(cred)
			if err != nil {
				return nil, fmt.Errorf("saving this terminal's credential: %w", err)
			}
			fmt.Fprintf(out, "✓ Approved. This terminal is remembered until %s (%s).\n", cred.ExpiresAt.Local().Format("Jan 2, 2006"), where)
			return cred, nil
		case "denied":
			return nil, errors.New("the terminal was denied in the Orbit app; nothing was saved")
		case "expired":
			return nil, errors.New("the approval request expired before it was approved: run `orbit terminal login` again")
		case "delivered":
			return nil, errors.New("the credential was handed to an earlier answer that never arrived here: revoke it in Settings → Terminals and run `orbit terminal login` again")
		default:
			return nil, fmt.Errorf("%s answered the terminal sign-in with %q", server, answer.Status)
		}
	}
	return nil, errors.New("timed out waiting for approval: run `orbit terminal login` again")
}

// cmdTerminalCLI is `orbit terminal login|logout`.
func cmdTerminalCLI(args []string, out io.Writer) error {
	if len(args) == 0 || wantsHelp(args) {
		fmt.Fprint(out, terminalHelp)
		return nil
	}
	switch args[0] {
	case "login":
		cred, err := ensureTerminalCredential(out)
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "Signed in: Terminal on %s, until %s.\n", cred.MachineName, cred.ExpiresAt.Local().Format("Jan 2, 2006"))
		return nil
	case "logout":
		cfg := loadConfig()
		if cfg == nil {
			return errors.New("No runner is registered on this machine, so there is no terminal to sign out.")
		}
		server, err := normalizeServerURL(cfg.ServerURL)
		if err != nil {
			return err
		}
		kept := loadTerminalCredential(server)
		if kept == nil {
			fmt.Fprintln(out, "This terminal is not signed in.")
			return nil
		}
		res, err := userAPIRequest(server, kept.Token, http.MethodDelete, "/api/terminals/self", nil)
		if err != nil {
			return fmt.Errorf("revoking this terminal on %s: %w (nothing was removed)", server, err)
		}
		if res.status != http.StatusUnauthorized && (res.status < 200 || res.status >= 300) {
			return fmt.Errorf("%s refused to revoke this terminal (%d): %s (nothing was removed)", server, res.status, answerMessage(res.body))
		}
		forgetTerminalCredential(server)
		fmt.Fprintln(out, "Signed out: this terminal's credential is revoked and forgotten.")
		return nil
	default:
		return fmt.Errorf("unknown terminal command %q\n\n%s", args[0], terminalHelp)
	}
}
