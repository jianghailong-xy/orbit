package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// The Orbit Cloud browser as a command-line tool's browser (board docs/mocks/runner-browser/03-agent-tools.html; task
// "a CLI tool's sign-in page opens in the runner's Chrome"). A tool an agent runs on the Orbit Cloud runner that signs
// in through a browser (`gh auth login --web`, `gcloud auth login`, an OAuth flow with a localhost callback) opens its
// page through $BROWSER or xdg-open. On that runner, with the browser switch on, both reach the opener below, which opens
// the page as a new tab of the runner's shared Chrome. Chrome runs on the runner, so a redirect to
// http://localhost:PORT/callback reaches the tool; the agent can then ask the owner to finish the sign-in there with
// browser_request_sign_in.
//
// Off means absent: with the switch off, on a runner that is not the Orbit Cloud runner, or for any process that is not
// an engine's (the engines' own sign-ins in doctor.go, account_slot.go and cursor_account_slot.go among them), no
// BROWSER is set and xdg-open is not touched.
//
// The opener never prints or logs the page's address beyond its host: a sign-in URL's query carries codes and state.

// browserOpenerCommand is the hidden `orbit` command the shims run (main.go routes it ahead of the CLI).
const browserOpenerCommand = "browser-opener"

// The shims, in browserOpenerDir: BROWSER names the first; the second is first on PATH as xdg-open.
const (
	browserOpenerShim = "orbit-browser"
	browserOpenerXdg  = "xdg-open"
	envBrowserVar     = "BROWSER"
)

// browserOpenerDir is where the runner writes the shims: under the runner's own home, beside nothing an engine reads.
func browserOpenerDir() string { return filepath.Join(machineHome(), "browser-opener") }

// browserOpenerEnv is env with the opener in it, for an engine of a session claimed with browserEnabled: BROWSER names
// the opener and its directory leads PATH, so xdg-open resolves to it. Unchanged unless the browser is on for the
// session and this is the Orbit Cloud runner; unchanged too if the shims cannot be written (the page then goes where it
// went before: nowhere).
func browserOpenerEnv(env []string, browserEnabled bool) []string {
	if !browserEnabled || !onOrbitCloudRunner() {
		return env
	}
	dir, err := writeBrowserOpenerShims(browserOpenerDir())
	if err != nil {
		logln("browser opener: the shims could not be written:", err)
		return env
	}
	env = envWithValue(env, envBrowserVar, filepath.Join(dir, browserOpenerShim))
	path := dir
	for _, entry := range filepath.SplitList(envValue(env, "PATH")) {
		if entry != "" && entry != dir {
			path += string(os.PathListSeparator) + entry
		}
	}
	return envWithValue(env, "PATH", path)
}

// writeBrowserOpenerShims writes the two shims into dir, each running this binary's opener, and returns dir. A shim
// already as it should be is left alone, so concurrent spawns do not race on it.
func writeBrowserOpenerShims(dir string) (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	shims := map[string]string{
		browserOpenerShim: browserOpenerScript(exe, false),
		browserOpenerXdg:  browserOpenerScript(exe, true),
	}
	for name, body := range shims {
		path := filepath.Join(dir, name)
		if current, err := os.ReadFile(path); err == nil && string(current) == body {
			continue
		}
		tmp, err := os.CreateTemp(dir, "."+name+"-*")
		if err != nil {
			return "", err
		}
		_, werr := tmp.WriteString(body)
		cerr := tmp.Close()
		if werr == nil {
			werr = cerr
		}
		if werr == nil {
			werr = os.Chmod(tmp.Name(), 0o755)
		}
		if werr == nil {
			werr = os.Rename(tmp.Name(), path)
		}
		if werr != nil {
			_ = os.Remove(tmp.Name())
			return "", werr
		}
	}
	return dir, nil
}

func browserOpenerScript(exe string, xdg bool) string {
	mode := ""
	if xdg {
		mode = " --xdg-open"
	}
	return "#!/bin/sh\n# Written by the Orbit runner: opens web pages in the Orbit Cloud browser.\nexec " +
		shellQuote(exe) + " " + browserOpenerCommand + mode + " \"$@\"\n"
}

// browserOpenerTimeout bounds one open, from asking the runner to start Chrome to the new tab.
var browserOpenerTimeout = 90 * time.Second

// browserOpenerStart asks for the shared browser to be started, as browser_open does without a page. A var so a test can
// stand in for the server.
var browserOpenerStart = func() error {
	t, err := cliTransport()
	if err != nil {
		return err
	}
	res, err := runBrowserOpen(t, os.Getenv("ORBIT_SESSION_ID"), "")
	if err != nil {
		return err
	}
	if !res.Enabled {
		return errors.New(res.Message)
	}
	return nil
}

// browserOpenerEndpoint is the shared Chrome's DevTools. A var so a test can stand in for Chrome.
var browserOpenerEndpoint = "http://" + browserDevToolsHost + ":" + fmt.Sprint(browserDevToolsPort)

// browserOpenerExec replaces this process with another opener (xdg-open for what is not a web page). A var for tests.
var browserOpenerExec = func(path string, argv []string, env []string) error { return syscall.Exec(path, argv, env) }

// runBrowserOpener is `orbit browser-opener [--xdg-open] URL...`: BROWSER's and xdg-open's command on the Orbit Cloud
// runner. It opens the first argument as a new tab of the shared Chrome, starting the browser first if it is not
// running, and prints one line naming only the page's host. As xdg-open, anything that is not an http(s) address goes
// to the system's xdg-open, if there is one. Returns the exit code.
func runBrowserOpener(args []string, stdout, stderr io.Writer) int {
	xdg := len(args) > 0 && args[0] == "--xdg-open"
	if xdg {
		args = args[1:]
	}
	target := ""
	if len(args) > 0 {
		target = strings.TrimSpace(args[0])
	}
	parsed, err := url.Parse(target)
	web := err == nil && (strings.EqualFold(parsed.Scheme, "http") || strings.EqualFold(parsed.Scheme, "https")) && parsed.Host != ""
	if !web {
		if xdg {
			return systemXdgOpen(args, stderr)
		}
		fmt.Fprintln(stderr, "orbit: only http and https pages open in the Orbit Cloud browser")
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), browserOpenerTimeout)
	defer cancel()
	if !browserDevToolsAnswer(ctx, browserOpenerEndpoint) {
		if err := browserOpenerStart(); err != nil {
			fmt.Fprintln(stderr, "orbit: the Orbit Cloud browser could not be started:", err)
			return 1
		}
		for !browserDevToolsAnswer(ctx, browserOpenerEndpoint) {
			select {
			case <-ctx.Done():
				fmt.Fprintln(stderr, "orbit: the Orbit Cloud browser did not start in time; the page was not opened")
				return 1
			case <-time.After(500 * time.Millisecond):
			}
		}
	}
	if err := openBrowserTab(ctx, browserOpenerEndpoint, parsed.String()); err != nil {
		fmt.Fprintln(stderr, "orbit: the page could not be opened in the Orbit Cloud browser:", err)
		return 1
	}
	host := strings.ToLower(parsed.Host)
	fmt.Fprintf(stdout, "Opened a page of %s in the Orbit Cloud browser (this runner's shared Chrome). If it needs the "+
		"owner to sign in, call browser_request_sign_in with site %s so the owner finishes it there.\n", host, host)
	return 0
}

// browserDevToolsAnswer reports whether Chrome's DevTools answer at endpoint.
func browserDevToolsAnswer(ctx context.Context, endpoint string) bool {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint+"/json/version", nil)
	if err != nil {
		return false
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

// systemXdgOpen hands what is not a web page to the system's xdg-open: the first one on PATH that is not this shim.
func systemXdgOpen(args []string, stderr io.Writer) int {
	own, _ := filepath.Abs(browserOpenerDir())
	for _, dir := range filepath.SplitList(os.Getenv("PATH")) {
		if dir == "" {
			continue
		}
		if abs, _ := filepath.Abs(dir); abs == own {
			continue
		}
		candidate := filepath.Join(dir, browserOpenerXdg)
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() && info.Mode()&0o111 != 0 {
			if err := browserOpenerExec(candidate, append([]string{browserOpenerXdg}, args...), os.Environ()); err != nil {
				fmt.Fprintln(stderr, "xdg-open:", err)
				return 1
			}
			return 0
		}
	}
	fmt.Fprintln(stderr, "xdg-open: only http and https pages open on this runner, in the Orbit Cloud browser")
	return 3
}
