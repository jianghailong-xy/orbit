package main

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// The opener (browser_opener.go): a CLI tool an agent runs on the Orbit Cloud runner, with the browser switch on, opens
// its sign-in page in the runner's shared Chrome through $BROWSER or xdg-open. These pin:
//   - BROWSER and the xdg-open shim are in an engine's environment only with the switch on (the claim's
//     browserEnabled) and on the Orbit Cloud runner; with either off, nothing is set and PATH is untouched;
//   - the engines' own sign-ins run in the runner's environment, which never gains them;
//   - the opener opens the page as a new tab through DevTools, starting the browser first when it is not running, and
//     prints one line naming the host, never the address's query (codes, state) nor its path.

// openerEnvFor sets the runner's own environment for one case: on the Orbit Cloud runner or not.
func openerEnvFor(t *testing.T, managed bool) {
	t.Helper()
	t.Setenv("ORBIT_HOME", t.TempDir())
	if managed {
		t.Setenv(envManagedRunnerGeneration, "3")
	} else {
		t.Setenv(envManagedRunnerGeneration, "")
		os.Unsetenv(envManagedRunnerGeneration)
	}
}

func TestBrowserOpenerEnvOnlyWithTheSwitchOnOnTheOrbitCloudRunner(t *testing.T) {
	base := []string{"PATH=/usr/local/bin:/usr/bin", "HOME=/home/orbit"}
	for _, c := range []struct {
		managed, enabled bool
	}{{true, true}, {true, false}, {false, true}, {false, false}} {
		openerEnvFor(t, c.managed)
		env := browserOpenerEnv(append([]string{}, base...), c.enabled)
		on := c.managed && c.enabled
		dir := browserOpenerDir()
		browser := envValue(env, "BROWSER")
		path := envValue(env, "PATH")
		if on {
			if browser != filepath.Join(dir, browserOpenerShim) {
				t.Errorf("managed=%v enabled=%v: BROWSER = %q, want the opener", c.managed, c.enabled, browser)
			}
			if path != dir+":/usr/local/bin:/usr/bin" {
				t.Errorf("managed=%v enabled=%v: PATH = %q, want the opener's directory first", c.managed, c.enabled, path)
			}
			for _, shim := range []string{browserOpenerShim, browserOpenerXdg} {
				body, err := os.ReadFile(filepath.Join(dir, shim))
				info, statErr := os.Stat(filepath.Join(dir, shim))
				if err != nil || statErr != nil || info.Mode()&0o111 == 0 {
					t.Fatalf("shim %s: %v %v", shim, err, statErr)
				}
				if !strings.Contains(string(body), " "+browserOpenerCommand) {
					t.Errorf("shim %s does not run the opener: %s", shim, body)
				}
				if (shim == browserOpenerXdg) != strings.Contains(string(body), "--xdg-open") {
					t.Errorf("shim %s: %s", shim, body)
				}
			}
			// A second spawn leads PATH with it once.
			again := browserOpenerEnv(env, true)
			if envValue(again, "PATH") != path {
				t.Errorf("a second pass: PATH = %q", envValue(again, "PATH"))
			}
			continue
		}
		if strings.Join(env, "\n") != strings.Join(base, "\n") {
			t.Errorf("managed=%v enabled=%v: the environment changed: %v", c.managed, c.enabled, env)
		}
		if _, err := os.Stat(dir); err == nil {
			t.Errorf("managed=%v enabled=%v: the shims were written", c.managed, c.enabled)
		}
	}
}

// The real spawn: a Claude Code process (and the shell its Bash tool runs) gets BROWSER and the xdg-open shim with the
// switch on on the Orbit Cloud runner, and neither otherwise; a self-hosted runner's own BROWSER is left as it is.
func TestClaudeSpawnCarriesTheOpenerOnlyWithTheSwitchOnOnTheOrbitCloudRunner(t *testing.T) {
	for _, c := range []struct {
		managed, enabled bool
	}{{true, true}, {true, false}, {false, true}, {false, false}} {
		fake := newFakeClaude(t, fakeStep{Emit: "no-such-frame"})
		job := claudeSpawnJob(t)
		job.BrowserEnabled = c.enabled
		job.WorkflowsDisabled = c.enabled // the Agent's Workflows switch, an independent line beside the browser's
		openerEnvFor(t, c.managed)
		t.Setenv("BROWSER", "")
		os.Unsetenv("BROWSER")
		if !c.managed {
			t.Setenv("BROWSER", "/usr/bin/firefox") // a person's own, on a self-hosted machine
		}
		t.Setenv("PATH", fake.Dir+string(os.PathListSeparator)+os.Getenv("PATH"))
		ctx, cancel := context.WithCancel(context.Background())
		proc, err := spawnClaude(ctx, job, t.TempDir(), claudeCommandArgs(job, t.TempDir(), true))
		if err != nil {
			cancel()
			t.Fatal(err)
		}
		env := proc.cmd.Env
		proc.stdin.Close()
		_, _ = io.ReadAll(proc.stderr)
		_ = proc.cmd.Wait()
		cancel()

		where := map[bool]string{true: "Orbit Cloud runner", false: "self-hosted runner"}[c.managed] +
			map[bool]string{true: ", switch on", false: ", switch off"}[c.enabled]
		// The session context the browser and workflows switches put beside the opener: both, each as the claim said.
		if envValue(env, envBrowser) != browserEnv(c.enabled) || envValue(env, envWorkflows) != workflowsEnv(c.enabled) {
			t.Errorf("%s: %s=%q %s=%q", where, envBrowser, envValue(env, envBrowser), envWorkflows, envValue(env, envWorkflows))
		}
		dir := browserOpenerDir()
		firstPath := strings.SplitN(envValue(env, "PATH"), ":", 2)[0]
		switch {
		case c.managed && c.enabled:
			if envValue(env, "BROWSER") != filepath.Join(dir, browserOpenerShim) || firstPath != dir {
				t.Errorf("%s: BROWSER=%q, PATH starts %q; want the opener", where, envValue(env, "BROWSER"), firstPath)
			}
		case c.managed:
			if _, set := lookupEnvIn(env, "BROWSER"); set || firstPath == dir {
				t.Errorf("%s: BROWSER=%q, PATH starts %q; want neither", where, envValue(env, "BROWSER"), firstPath)
			}
		default:
			if envValue(env, "BROWSER") != "/usr/bin/firefox" || firstPath == dir {
				t.Errorf("%s: BROWSER=%q, PATH starts %q; want the machine's own and no shim", where, envValue(env, "BROWSER"), firstPath)
			}
		}
	}
}

// A job the agent hands the runner (bg_run) opens its pages as the engine's shell does, and only then. Its login shell
// (`bash -lc`) keeps BROWSER; Debian's /etc/profile resets PATH, which the image's profile.d snippet puts the shim back
// on (TestTheImageProfileKeepsTheXdgOpenShimFirst).
func TestBackgroundJobCarriesTheOpenerOnlyWithTheSwitchOn(t *testing.T) {
	for _, enabled := range []bool{true, false} {
		openerEnvFor(t, true)
		svc, bg, stop := newTestBgJobService(t)
		svc.job = &ClaimedSession{SessionID: "sess-1", BrowserEnabled: enabled}
		resp := svc.handle(bgSocketRequest{Op: "run", Args: map[string]interface{}{
			"command": `printf '%s|%s' "${BROWSER-unset}" "$(command -v xdg-open || echo none)"`, "kind": bgKindJob}})
		status, ok := resp.Result.(bgJobStatus)
		if !resp.OK || !ok {
			stop()
			t.Fatalf("bg_run refused: %#v", resp)
		}
		deadline := time.Now().Add(10 * time.Second)
		for {
			if st, _ := bg.jobStatus(status.JobID); st.Status != "running" || time.Now().After(deadline) {
				break
			}
			time.Sleep(20 * time.Millisecond)
		}
		out, _ := os.ReadFile(status.OutputPath)
		stop()
		browser, xdg, _ := strings.Cut(string(out), "|")
		dir := browserOpenerDir()
		if enabled && browser != filepath.Join(dir, browserOpenerShim) {
			t.Errorf("switch on: the job saw BROWSER=%q", browser)
		}
		if !enabled && (browser != "unset" || strings.HasPrefix(xdg, dir)) {
			t.Errorf("switch off: the job saw BROWSER=%q xdg-open=%q", browser, xdg)
		}
	}
}

// The managed image's /etc/profile.d snippet: a login shell whose BROWSER is the opener gets the opener's directory back
// in front of the PATH /etc/profile reset, once; with any other BROWSER, or none, PATH is left alone.
func TestTheImageProfileKeepsTheXdgOpenShimFirst(t *testing.T) {
	snippet, err := filepath.Abs("../../deploy/managed-runner/image/orbit-browser-opener.sh")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(snippet); err != nil {
		t.Fatal(err)
	}
	dir := "/home/orbit/.orbit/browser-opener"
	for _, c := range []struct{ browser, want string }{
		{dir + "/orbit-browser", dir + ":/usr/local/bin:/usr/bin:/bin"},
		{"", "/usr/local/bin:/usr/bin:/bin"},
		{"/usr/bin/firefox", "/usr/local/bin:/usr/bin:/bin"},
	} {
		cmd := exec.Command("/bin/sh", "-c", `. "$1"; . "$1"; printf %s "$PATH"`, "sh", snippet)
		cmd.Env = []string{"PATH=/usr/local/bin:/usr/bin:/bin"}
		if c.browser != "" {
			cmd.Env = append(cmd.Env, "BROWSER="+c.browser)
		}
		out, err := cmd.Output()
		if err != nil || string(out) != c.want {
			t.Errorf("BROWSER=%q: PATH=%q (%v), want %q", c.browser, out, err, c.want)
		}
	}
}

// The engines' own sign-ins (login.go, doctor.go, the account slots) run in the runner's own environment or a slot's,
// which spawning engines with the opener never touches; Cursor's still says NO_OPEN_BROWSER.
func TestEngineSignInsAreNotRoutedThroughTheOpener(t *testing.T) {
	openerEnvFor(t, true)
	t.Setenv("BROWSER", "")
	os.Unsetenv("BROWSER")
	before := os.Getenv("PATH")
	_ = browserOpenerEnv(os.Environ(), true)
	if _, set := os.LookupEnv("BROWSER"); set || os.Getenv("PATH") != before {
		t.Fatalf("the runner's own environment changed: BROWSER set=%v PATH=%q", set, os.Getenv("PATH"))
	}
	login := cursorLoginEnv(t.TempDir())
	if _, set := lookupEnvIn(login, "BROWSER"); set || envValue(login, "NO_OPEN_BROWSER") != "1" {
		t.Errorf("Cursor's sign-in environment: BROWSER set=%v NO_OPEN_BROWSER=%q", set, envValue(login, "NO_OPEN_BROWSER"))
	}
	if strings.HasPrefix(envValue(login, "PATH"), browserOpenerDir()) {
		t.Errorf("Cursor's sign-in PATH leads with the opener: %q", envValue(login, "PATH"))
	}
}

// fakeOpenerDevTools stands in for Chrome's DevTools: down until started, then answering /json/version, /json/new and
// /json/activate, and keeping the pages it was asked to open.
type fakeOpenerDevTools struct {
	up        atomic.Bool
	mu        sync.Mutex
	opened    []string
	activated []string
	methods   []string
}

func (f *fakeOpenerDevTools) serve(t *testing.T) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !f.up.Load() {
			http.Error(w, "down", http.StatusServiceUnavailable)
			return
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		switch {
		case r.URL.Path == "/json/version":
			_, _ = io.WriteString(w, `{"Browser":"Chrome/140"}`)
		case r.URL.Path == "/json/new":
			f.methods = append(f.methods, r.Method)
			page, _ := url.QueryUnescape(r.URL.RawQuery)
			f.opened = append(f.opened, page)
			_, _ = io.WriteString(w, `{"id":"TAB1","type":"page"}`)
		case strings.HasPrefix(r.URL.Path, "/json/activate/"):
			f.activated = append(f.activated, strings.TrimPrefix(r.URL.Path, "/json/activate/"))
			_, _ = io.WriteString(w, "Target activated")
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func useFakeDevTools(t *testing.T, f *fakeOpenerDevTools, start func() error) {
	t.Helper()
	srv := f.serve(t)
	prevEndpoint, prevStart := browserOpenerEndpoint, browserOpenerStart
	browserOpenerEndpoint, browserOpenerStart = srv.URL, start
	t.Cleanup(func() { browserOpenerEndpoint, browserOpenerStart = prevEndpoint, prevStart })
}

const openerSignInURL = "https://github.com/login/oauth/authorize?client_id=Iv1.abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A43117%2Fcallback&state=SECRET-STATE-7f3a&code_challenge=SECRET-CHALLENGE"

func TestBrowserOpenerOpensANewTabAndNamesOnlyTheHost(t *testing.T) {
	f := &fakeOpenerDevTools{}
	f.up.Store(true)
	started := 0
	useFakeDevTools(t, f, func() error { started++; return nil })
	var stdout, stderr bytes.Buffer
	if code := runBrowserOpener([]string{openerSignInURL}, &stdout, &stderr); code != 0 {
		t.Fatalf("exit %d: %s", code, stderr.String())
	}
	if started != 0 {
		t.Errorf("a running browser was started again (%d)", started)
	}
	if len(f.opened) != 1 || f.opened[0] != openerSignInURL || f.methods[0] != http.MethodPut {
		t.Fatalf("DevTools were asked for %v (%v), want one new tab on the whole address", f.opened, f.methods)
	}
	if len(f.activated) != 1 || f.activated[0] != "TAB1" {
		t.Errorf("the new tab was not brought to the front: %v", f.activated)
	}
	line := stdout.String()
	if strings.Count(line, "\n") != 1 || !strings.Contains(line, "Orbit Cloud browser") ||
		!strings.Contains(line, "browser_request_sign_in with site github.com") {
		t.Errorf("the opener said %q", line)
	}
	for _, secret := range []string{"SECRET", "state=", "client_id", "/login/oauth", "127.0.0.1"} {
		if strings.Contains(stdout.String()+stderr.String(), secret) {
			t.Errorf("the opener's output carries %q: %q %q", secret, stdout.String(), stderr.String())
		}
	}
}

func TestBrowserOpenerStartsTheBrowserFirst(t *testing.T) {
	f := &fakeOpenerDevTools{}
	started := 0
	useFakeDevTools(t, f, func() error { started++; f.up.Store(true); return nil })
	var stdout, stderr bytes.Buffer
	if code := runBrowserOpener([]string{"--xdg-open", openerSignInURL}, &stdout, &stderr); code != 0 {
		t.Fatalf("exit %d: %s", code, stderr.String())
	}
	if started != 1 || len(f.opened) != 1 {
		t.Fatalf("started %d time(s), opened %v; want a start, then the page", started, f.opened)
	}
}

func TestBrowserOpenerErrorsNeverQuoteTheAddress(t *testing.T) {
	f := &fakeOpenerDevTools{}
	useFakeDevTools(t, f, func() error { return errBrowserUnavailable })
	var stdout, stderr bytes.Buffer
	if code := runBrowserOpener([]string{openerSignInURL}, &stdout, &stderr); code == 0 {
		t.Fatal("a browser that cannot start: exit 0")
	}
	if out := stdout.String() + stderr.String(); strings.Contains(out, "SECRET") || strings.Contains(out, "github.com") {
		t.Errorf("the failure quotes the address: %q", out)
	}
	if !strings.Contains(stderr.String(), "could not be started") {
		t.Errorf("stderr = %q", stderr.String())
	}
}

// As xdg-open, what is not a web page goes to the system's xdg-open (never back to the shim), or is refused with
// xdg-open's own "no tool" status when the runner has none. As BROWSER, it is refused.
func TestBrowserOpenerLeavesWhatIsNotAWebPageToTheSystem(t *testing.T) {
	openerEnvFor(t, true)
	own, err := writeBrowserOpenerShims(browserOpenerDir())
	if err != nil {
		t.Fatal(err)
	}
	system := t.TempDir()
	if err := os.WriteFile(filepath.Join(system, browserOpenerXdg), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	var execd []string
	prev := browserOpenerExec
	browserOpenerExec = func(path string, argv []string, _ []string) error {
		execd = append([]string{path}, argv...)
		return nil
	}
	t.Cleanup(func() { browserOpenerExec = prev })

	t.Setenv("PATH", own+":"+system)
	var stdout, stderr bytes.Buffer
	if code := runBrowserOpener([]string{"--xdg-open", "/tmp/report.pdf"}, &stdout, &stderr); code != 0 {
		t.Fatalf("exit %d: %s", code, stderr.String())
	}
	if len(execd) != 3 || execd[0] != filepath.Join(system, browserOpenerXdg) || execd[2] != "/tmp/report.pdf" {
		t.Errorf("handed to %v, want the system's xdg-open", execd)
	}

	execd = nil
	t.Setenv("PATH", own)
	if code := runBrowserOpener([]string{"--xdg-open", "mailto:a@b.c"}, &stdout, &stderr); code != 3 || execd != nil {
		t.Errorf("no system xdg-open: exit %d, handed to %v", code, execd)
	}
	if code := runBrowserOpener([]string{"file:///tmp/x.html"}, &stdout, &stderr); code != 1 {
		t.Errorf("as BROWSER, a file: exit %d", code)
	}
}

func lookupEnvIn(env []string, key string) (string, bool) {
	for i := len(env) - 1; i >= 0; i-- {
		if k, v, ok := strings.Cut(env[i], "="); ok && k == key {
			return v, true
		}
	}
	return "", false
}
