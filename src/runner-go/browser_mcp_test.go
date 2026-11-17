package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// The three states a spawn can find the runner in: not managed (no supervisor), managed with the browser not
// offered (the switch off), managed and offered (the switch on).
var browserSpawnStates = []struct {
	name    string
	managed bool
	offered bool
	want    bool
}{
	{"self-hosted runner, switch on", false, true, false},
	{"managed runner, switch off", true, false, false},
	{"managed runner, switch on", true, true, true},
}

func useSpawnBrowser(t *testing.T, managed, offered bool) *browserSupervisor {
	t.Helper()
	lookup := noEnv
	if managed {
		lookup = managedEnv
	}
	b := newRunnerBrowser(lookup, t.TempDir(), newFakePoolClock(), &fakeBrowserStarter{}, nil)
	// SetOffered on a nil supervisor is what a self-hosted runner's link does with Welcome.browser.
	b.SetOffered(offered)
	prev := runnerBrowserForSpawn
	runnerBrowserForSpawn = func() *browserSupervisor { return b }
	t.Cleanup(func() { runnerBrowserForSpawn = prev })
	return b
}

func TestClaudeGetsTheBrowserMCPServerOnlyWhenTheBrowserIsActive(t *testing.T) {
	for _, tc := range browserSpawnStates {
		t.Run(tc.name, func(t *testing.T) {
			useSpawnBrowser(t, tc.managed, tc.offered)
			scratch := t.TempDir()
			claudeCommandArgs(claudeSpawnJob(t), scratch, true)
			body, err := os.ReadFile(filepath.Join(scratch, "mcp.json"))
			if err != nil {
				t.Fatal(err)
			}
			var cfg struct {
				MCPServers map[string]struct {
					Command string   `json:"command"`
					Args    []string `json:"args"`
				} `json:"mcpServers"`
			}
			if err := json.Unmarshal(body, &cfg); err != nil {
				t.Fatal(err)
			}
			if _, ok := cfg.MCPServers["orbit"]; !ok {
				t.Fatalf("mcp.json has no orbit server: %s", body)
			}
			got, ok := cfg.MCPServers["browser"]
			if ok != tc.want {
				t.Fatalf("browser server present = %v, want %v: %s", ok, tc.want, body)
			}
			if tc.want && (got.Command != orbitCLIExecutable() || strings.Join(got.Args, " ") != "browser-mcp") {
				t.Fatalf("browser server = %+v, want this binary as `browser-mcp`", got)
			}
		})
	}
}

func TestCodexGetsTheBrowserMCPServerOnlyWhenTheBrowserIsActive(t *testing.T) {
	const exe = "/opt/orbit/bin/orbit"
	for _, tc := range browserSpawnStates {
		t.Run(tc.name, func(t *testing.T) {
			useSpawnBrowser(t, tc.managed, tc.offered)
			job := &ClaimedSession{Agent: AgentExecConfig{Model: "gpt-5.5"}}
			dir := t.TempDir()
			for path, args := range map[string][]string{
				"exec":       codexExecCommandArgs(job, dir, dir, nil, exe),
				"app-server": codexAppServerCommandArgs(job, dir, exe),
			} {
				joined := strings.Join(args, "\n")
				if !strings.Contains(joined, `mcp_servers.orbit.command=`) {
					t.Fatalf("%s: no orbit server in %v", path, args)
				}
				has := strings.Contains(joined, `mcp_servers.browser.`)
				if has != tc.want {
					t.Fatalf("%s: browser server present = %v, want %v: %v", path, has, tc.want, args)
				}
				if !tc.want {
					continue
				}
				for _, want := range [][]string{
					{"-c", `mcp_servers.browser.command="` + exe + `"`},
					{"-c", `mcp_servers.browser.args=["browser-mcp"]`},
					{"-c", codexBrowserMCPEnvVarsConfig},
				} {
					if !containsArgs(args, want) {
						t.Errorf("%s: argv is missing %v: %v", path, want, args)
					}
				}
			}
		})
	}
}

// The socket op takes the lease for the socket's own session, starting the browser, and another session's
// call is refused with the holder named.
func TestBrowserAcquireOverTheSessionSocket(t *testing.T) {
	b := useSpawnBrowser(t, true, true)
	call := func(sessionID, title string) error {
		svc, _, stop := newTestBgJobService(t)
		defer stop()
		svc.sessionID = sessionID
		svc.job = &ClaimedSession{SessionID: sessionID, Title: title}
		socket := filepath.Join(t.TempDir(), "bg.sock")
		stopService, err := startBgJobService(context.Background(), svc, socket, filepath.Join(t.TempDir(), "bg.token"))
		if err != nil {
			t.Fatal(err)
		}
		defer stopService()
		_, err = bgSocketCall(socket, "test-token", browserMCPAcquireOp, nil)
		return err
	}
	if err := call("sess-a", "Read the docs"); err != nil {
		t.Fatalf("first acquire refused: %v", err)
	}
	if !b.Running() || b.Holder() != "sess-a" {
		t.Fatalf("running=%v holder=%q after the first acquire", b.Running(), b.Holder())
	}
	err := call("sess-b", "Other")
	if err == nil || !strings.Contains(err.Error(), `"Read the docs" (sess-a)`) {
		t.Fatalf("second session's acquire = %v, want a refusal naming the holder", err)
	}
}

// The proxy: everything goes through to playwright-mcp untouched, except a tools/call whose lease is refused, which
// the proxy answers itself with a tool error carrying the refusal.
func TestBrowserMCPProxyTakesTheLeaseBeforeEachToolCall(t *testing.T) {
	refusal := `The browser is in use by session "Other" (sess-b); try again after it finishes`
	acquires, ready := 0, []string{}
	refuse := false
	var out bytes.Buffer
	p := &browserMCPProxy{
		acquire: func() (string, error) {
			acquires++
			if refuse {
				return "", errors.New(refusal)
			}
			return "http://127.0.0.1:9222", nil
		},
		waitReady: func(d string) { ready = append(ready, d) },
		out:       &out,
	}
	initialize := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}` + "\n"
	list := `{"jsonrpc":"2.0","id":2,"method":"tools/list"}` + "\n"
	call := `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"browser_navigate","arguments":{"url":"https://example.com"}}}` + "\n"
	refused := `{"jsonrpc":"2.0","id":"r4","method":"tools/call","params":{"name":"browser_snapshot","arguments":{}}}` + "\n"

	// `cat` stands in for playwright-mcp: whatever reaches it comes back on the proxy's stdout.
	var in bytes.Buffer
	in.WriteString(initialize + list + call)
	if err := p.run(exec.Command("cat"), &in); err != nil {
		t.Fatal(err)
	}
	if got, want := out.String(), initialize+list+call; got != want {
		t.Fatalf("forwarded %q, want %q", got, want)
	}
	if acquires != 1 || len(ready) != 1 || ready[0] != "http://127.0.0.1:9222" {
		t.Fatalf("acquires=%d ready=%v: want one acquire, for the tools/call alone, then a wait for Chrome", acquires, ready)
	}

	out.Reset()
	refuse = true
	in.WriteString(refused)
	if err := p.run(exec.Command("cat"), &in); err != nil {
		t.Fatal(err)
	}
	var reply struct {
		ID     string `json:"id"`
		Result struct {
			IsError bool `json:"isError"`
			Content []struct {
				Type, Text string
			} `json:"content"`
		} `json:"result"`
	}
	if err := json.Unmarshal(out.Bytes(), &reply); err != nil {
		t.Fatalf("refused call's reply %q: %v (it must be the only output: nothing forwarded)", out.String(), err)
	}
	if reply.ID != "r4" || !reply.Result.IsError || len(reply.Result.Content) != 1 || reply.Result.Content[0].Text != refusal {
		t.Fatalf("refused call's reply = %+v, want a tool error for id r4 carrying the refusal", reply)
	}
}
