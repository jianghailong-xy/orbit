package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

// The real binary's dispatch, run as a child of the test binary: os.Args is what `orbit …` would get, and
// stdin is /dev/null and stdout a pipe, so it is not on a terminal.
func TestBareOrbitMainHelper(t *testing.T) {
	raw := os.Getenv("ORBIT_BARE_MAIN_ARGS")
	if raw == "" {
		t.Skip("helper process for TestBareOrbitOffATerminalPrintsHelp")
	}
	var args []string
	if err := json.Unmarshal([]byte(raw), &args); err != nil {
		os.Exit(99)
	}
	os.Args = append([]string{"orbit"}, args...)
	main()
	os.Exit(0)
}

func runOrbitMain(t *testing.T, args ...string) (stdout, stderr string, code int) {
	t.Helper()
	raw, _ := json.Marshal(args)
	cmd := exec.Command(os.Args[0], "-test.run=^TestBareOrbitMainHelper$")
	cmd.Env = append(os.Environ(), "ORBIT_BARE_MAIN_ARGS="+string(raw), "ORBIT_HOME="+t.TempDir(), "ORBIT_NO_SELFUPDATE=1")
	var out, errOut bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errOut
	err := cmd.Run()
	code = 0
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		code = exitErr.ExitCode()
	} else if err != nil {
		t.Fatal(err)
	}
	return out.String(), errOut.String(), code
}

func TestBareOrbitOffATerminalPrintsHelp(t *testing.T) {
	for _, args := range [][]string{{}, {"help"}, {"--help"}, {"-h"}} {
		out, errOut, code := runOrbitMain(t, args...)
		if code != 0 || out != usage {
			t.Fatalf("orbit %v: exit %d, stdout %q, stderr %q", args, code, out, errOut)
		}
	}
	// The flags only open the terminal client, so off a terminal they say so rather than print help.
	_, errOut, code := runOrbitMain(t, "--pick")
	if code != 2 || !strings.Contains(errOut, "needs a terminal") {
		t.Fatalf("orbit --pick off a terminal: exit %d, stderr %q", code, errOut)
	}
}

func TestIsBareOrbit(t *testing.T) {
	for _, args := range [][]string{nil, {"--pick"}, {"--engine", "codex"}, {"--engine=codex"}, {"--model", "m"}, {"--model=m", "--engine", "x"}} {
		if !isBareOrbit(args) {
			t.Errorf("%v is bare orbit", args)
		}
	}
	for _, args := range [][]string{{"help"}, {"--help"}, {"-h"}, {"resume", "x"}, {"run"}, {"--version"}} {
		if isBareOrbit(args) {
			t.Errorf("%v is not bare orbit", args)
		}
	}
}

// stubBareOpen records what bare `orbit` would open, and opens nothing.
func stubBareOpen(t *testing.T) *[]newSessionRequest {
	var opened []newSessionRequest
	prev := bareOpenNewSession
	bareOpenNewSession = func(req newSessionRequest, cwd string, in io.Reader, out io.Writer) error {
		if wd, _ := os.Getwd(); cwd != wd {
			t.Errorf("cwd %q, want %q", cwd, wd)
		}
		opened = append(opened, req)
		return nil
	}
	t.Cleanup(func() { bareOpenNewSession = prev })
	return &opened
}

func writeTestRunnerConfig(t *testing.T) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("ORBIT_HOME", home)
	cfg := `{"serverUrl":"https://orbit.example","runnerId":"01a113f1-eec1-77dc-b73f-d222d66a53e5","runnerToken":"orbit_runner_x","name":"dev-laptop"}`
	if err := os.WriteFile(configPath(), []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestBareOrbitOnATerminalOpensANewSession(t *testing.T) {
	writeTestRunnerConfig(t)
	opened := stubBareOpen(t)
	cases := []struct {
		args []string
		want newSessionRequest
	}{
		{nil, newSessionRequest{}},
		{[]string{"--engine", "codex", "--model", "gpt-5.5"}, newSessionRequest{Engine: "codex", Model: "gpt-5.5"}},
		{[]string{"--model=claude-sonnet-5-5", "--engine=claude"}, newSessionRequest{Engine: "claude", Model: "claude-sonnet-5-5"}},
		{[]string{"--pick"}, newSessionRequest{Pick: true}},
	}
	for _, c := range cases {
		var out, errOut bytes.Buffer
		if code := cmdBareOrbit(c.args, true, &out, &errOut); code != 0 {
			t.Fatalf("orbit %v: exit %d, stderr %q", c.args, code, errOut.String())
		}
		if strings.Contains(out.String(), "Usage:") {
			t.Fatalf("orbit %v on a terminal printed the help", c.args)
		}
	}
	var got []newSessionRequest
	for _, c := range cases {
		got = append(got, c.want)
	}
	if !reflect.DeepEqual(*opened, got) {
		t.Fatalf("opened %+v, want %+v", *opened, got)
	}

	// A malformed command line opens nothing.
	for _, args := range [][]string{{"--engine"}, {"--pick", "--engine", "codex"}, {"--engine", "codex", "stray"}, {"--pick=yes"}} {
		var out, errOut bytes.Buffer
		if code := cmdBareOrbit(args, true, &out, &errOut); code != 2 {
			t.Fatalf("orbit %v: exit %d", args, code)
		}
	}
	if len(*opened) != len(cases) {
		t.Fatalf("a malformed command line opened a session: %+v", *opened)
	}
}

func TestBareOrbitWithNoRunnerSaysToRegister(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	opened := stubBareOpen(t)
	for _, args := range [][]string{nil, {"--pick"}} {
		var out, errOut bytes.Buffer
		code := cmdBareOrbit(args, true, &out, &errOut)
		if code == 0 || !strings.Contains(tuiPlain(errOut.String()), "✗ "+noRunnerMessage) {
			t.Fatalf("orbit %v with no runner: exit %d, stderr %q", args, code, errOut.String())
		}
	}
	if len(*opened) != 0 {
		t.Fatalf("opened %+v with no runner", *opened)
	}
	if !strings.Contains(noRunnerMessage, "Run `orbit register` first.") {
		t.Fatal(noRunnerMessage)
	}
}

func boolPtr(b bool) *bool { return &b }

func TestWorkspaceForDir(t *testing.T) {
	root := t.TempDir()
	shop := filepath.Join(root, "shop")
	nested := filepath.Join(shop, "packages", "api")
	sibling := filepath.Join(root, "shop-api")
	off := filepath.Join(root, "off")
	for _, d := range []string{nested, sibling, off} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	link := filepath.Join(root, "link-to-shop")
	if err := os.Symlink(shop, link); err != nil {
		t.Fatal(err)
	}
	list := []tuiWorkspace{
		{ID: "w-root", Name: "root", WorkDir: root},
		{ID: "w-shop", Name: "shop", WorkDir: shop + "/"},
		{ID: "w-api", Name: "api", WorkDir: nested},
		{ID: "w-off", Name: "off", WorkDir: off, Enabled: boolPtr(false)},
		{ID: "w-none", Name: "no dir"},
	}
	for dir, want := range map[string]string{
		shop:                            "w-shop",
		filepath.Join(shop, "packages"): "w-shop",
		nested:                          "w-api",  // the deepest workspace holding it
		sibling:                         "w-root", // shop-api is not inside shop
		link:                            "w-shop", // through a symlink
		off:                             "w-root", // a disabled workspace starts nothing
	} {
		got, ok := workspaceForDir(list, dir)
		if !ok || got.ID != want {
			t.Errorf("%s: got %q (%v), want %q", dir, got.ID, ok, want)
		}
	}
	if got, ok := workspaceForDir(list[1:3], sibling); ok {
		t.Errorf("shop-api is in no workspace, got %q", got.ID)
	}
}

func TestFirstMessageComposer(t *testing.T) {
	m := &tuiFirstMessageModel{header: "◆ Orbit shop · dev-laptop"}
	if _, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter}); cmd != nil || m.done {
		t.Fatal("an empty message was sent")
	}
	m.Update(tuiRunes("add rate limitx"))
	m.Update(tea.KeyMsg{Type: tea.KeyBackspace})
	m.Update(tea.KeyMsg{Type: tea.KeySpace})
	m.Update(tuiRunes("ing"))
	if view := tuiPlain(m.View()); !strings.Contains(view, "◆ Orbit shop · dev-laptop\n\n› add rate limit ing█") {
		t.Fatalf("view:\n%s", view)
	}
	if _, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter}); cmd == nil || !m.done || m.View() != "" {
		t.Fatal("enter did not send")
	}
	for _, k := range []tea.KeyType{tea.KeyEsc, tea.KeyCtrlD, tea.KeyCtrlC} {
		m := &tuiFirstMessageModel{}
		m.Update(tuiRunes("draft"))
		if m.Update(tea.KeyMsg{Type: k}); !m.canceled || m.done {
			t.Fatalf("%v did not leave", k)
		}
	}
}

const bareTestRunner = "01a113f1-eec1-77dc-b73f-d222d66a53e5"

// keysAfter writes keys into the pipe once the output shows want: the next program is then reading. It runs on
// its own goroutine, so it reports with Errorf and answers false rather than stopping the test.
func keysAfter(t *testing.T, w *os.File, out *lockedBuffer, want, keys string) bool {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !strings.Contains(tuiPlain(out.String()), want) {
		if time.Now().After(deadline) {
			t.Errorf("never showed %q; output:\n%s", want, tuiPlain(out.String()))
			return false
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, err := w.WriteString(keys); err != nil {
		t.Errorf("writing %q: %v", keys, err)
		return false
	}
	return true
}

// What bare `orbit` sends once it has its credential: the workspace holding the cwd on this machine's
// runner, no worktree, the engine and model it was told, and the first message as the prompt.
func TestStartSessionInDirPostsNoWorktree(t *testing.T) {
	dir := t.TempDir()
	cred := &terminalCredential{RunnerID: bareTestRunner, MachineName: "dev-laptop"}
	for _, c := range []struct {
		req  newSessionRequest
		want map[string]any
	}{
		{newSessionRequest{}, map[string]any{}},
		{newSessionRequest{Engine: "codex", Model: "gpt-5.5"}, map[string]any{"engine": "codex", "model": "gpt-5.5"}},
	} {
		f := newTUIFakeServer(t)
		raw, _ := json.Marshal([]tuiWorkspace{{ID: "w-other", Name: "other", WorkDir: t.TempDir()}, {ID: "w-shop", Name: "shop-api", WorkDir: dir}})
		f.workspacesJSON = string(raw)
		r, w, _ := os.Pipe()
		var out lockedBuffer
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		go keysAfter(t, w, &out, "enter send", "add rate limiting\r")
		id, prompt, err := startSessionInDir(ctx, newTUIClient(f.URL, "orbit_term_test"), cred, c.req, dir, r, &out)
		cancel()
		r.Close()
		w.Close()
		if err != nil {
			t.Fatalf("%+v: %v; output:\n%s", c.req, err, tuiPlain(out.String()))
		}
		if id != "new-session-1" || prompt != "add rate limiting" {
			t.Fatalf("id %q prompt %q", id, prompt)
		}
		want := map[string]any{"workspaceId": "w-shop", "assignedRunnerId": bareTestRunner, "worktree": false, "prompt": "add rate limiting"}
		for k, v := range c.want {
			want[k] = v
		}
		if got := f.body("POST /api/sessions"); !reflect.DeepEqual(got, want) {
			t.Fatalf("POST /sessions body\n got: %v\nwant: %v", got, want)
		}
	}
}

// `orbit --pick`: T8's picker first, then the first message, then POST /sessions with both.
func TestStartSessionInDirPickOpensThePicker(t *testing.T) {
	dir := t.TempDir()
	f := newTUIFakeServer(t)
	f.runnersJSON, f.providersJSON = tuiTestRunnersJSON, tuiTestProvidersJSON
	raw, _ := json.Marshal([]tuiWorkspace{{ID: "w-shop", Name: "shop-api", WorkDir: dir}})
	f.workspacesJSON = string(raw)
	r, w, _ := os.Pipe()
	defer r.Close()
	defer w.Close()
	var out lockedBuffer
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	go func() {
		_ = keysAfter(t, w, &out, "Engine for the new session", "\r") &&
			keysAfter(t, w, &out, "Model for Claude Code", "jj\r") && // Sonnet 5.5
			keysAfter(t, w, &out, "enter send", "hi\r")
	}()
	cred := &terminalCredential{RunnerID: bareTestRunner, MachineName: "dev-laptop"}
	id, _, err := startSessionInDir(ctx, newTUIClient(f.URL, "orbit_term_test"), cred, newSessionRequest{Pick: true}, dir, r, &out)
	if err != nil {
		t.Fatalf("%v; output:\n%s", err, tuiPlain(out.String()))
	}
	if id != "new-session-1" {
		t.Fatalf("id %q", id)
	}
	if !strings.Contains(tuiPlain(out.String()), "◆ Orbit shop-api · dev-laptop · Claude Code · claude-sonnet-5-5") {
		t.Fatalf("status line; output:\n%s", tuiPlain(out.String()))
	}
	want := map[string]any{"workspaceId": "w-shop", "assignedRunnerId": bareTestRunner, "worktree": false, "prompt": "hi",
		"engine": "claude", "provider": "claude", "model": "claude-sonnet-5-5"}
	if got := f.body("POST /api/sessions"); !reflect.DeepEqual(got, want) {
		t.Fatalf("POST /sessions body\n got: %v\nwant: %v", got, want)
	}
}

// A cwd in no workspace on this machine creates nothing (T7 adds the [Y/n]).
func TestStartSessionInDirRefusesACwdInNoWorkspace(t *testing.T) {
	f := newTUIFakeServer(t)
	raw, _ := json.Marshal([]tuiWorkspace{{ID: "w-shop", Name: "shop-api", WorkDir: t.TempDir()}})
	f.workspacesJSON = string(raw)
	dir := t.TempDir()
	var out lockedBuffer
	cred := &terminalCredential{RunnerID: bareTestRunner, MachineName: "dev-laptop"}
	_, _, err := startSessionInDir(context.Background(), newTUIClient(f.URL, "orbit_term_test"), cred, newSessionRequest{}, dir, strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), dir+" is not in a workspace on dev-laptop") {
		t.Fatalf("err %v", err)
	}
	if posts := f.posts(); len(posts) != 0 {
		t.Fatalf("posted %v", posts)
	}
}
