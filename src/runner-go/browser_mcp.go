package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

// The agent's browser tool (docs/runner-browser-design.md §3): a `browser` MCP server given to Claude Code and
// Codex sessions while the runner's browser is active, the way `orbit mcp` is given to every session.
//
// The server is this binary as `orbit browser-mcp`, a stdio proxy in front of @playwright/mcp from the image
// (`playwright-mcp --cdp-endpoint` at the runner's Chrome). The proxy forwards every message unchanged, except that
// before it forwards a tools/call it asks the runner for the browser lease over the session's background-job
// socket (op browser_acquire): the runner starts the browser if needed and answers, or refuses with the holder's
// name, and a refusal comes back to the agent as that tool call's error. Playwright connects to Chrome on its first
// tool call, so nothing touches the browser before the lease is held.

const (
	browserMCPServerName = "browser"
	browserMCPCommand    = "browser-mcp"
	browserMCPAcquireOp  = "browser_acquire"
	// browser_request_sign_in's two ops: give the lease up while the owner signs in, and take it back after.
	browserSignInYieldOp = "browser_sign_in_yield"
	browserSignInEndOp   = "browser_sign_in_end"
	// playwrightMCPBinary is @playwright/mcp's cli.js, linked onto the image's PATH (deploy/managed-runner/image).
	playwrightMCPBinary = "playwright-mcp"
	// How long a tools/call waits, after the lease is granted, for a Chrome just started to answer on DevTools.
	browserDevToolsReadyWait = 20 * time.Second
	// A single MCP message may carry a screenshot; past this the proxy gives up on the line.
	browserMCPLineCap = 64 * 1024 * 1024
)

// runnerBrowserForSpawn is the browser a spawn decides by. A var so a test can give it a supervisor of its own.
var runnerBrowserForSpawn = runnerBrowser

// browserMCPActive reports whether a session spawned now is given the browser tool: the runner is a managed runner
// (it has a browser supervisor) and its current connection's Welcome offers the browser. Off means absent: with
// either missing the engine's configuration has no `browser` server at all.
func browserMCPActive() bool {
	return runnerBrowserForSpawn().Offered()
}

// browserMCPArgs is the argv after the Orbit executable that serves the browser tool.
func browserMCPArgs() []string { return []string{browserMCPCommand} }

// codexBrowserMCPEnvVarsConfig: Codex passes a stdio MCP server an allowlist of the session's variables (see
// codexOrbitMCPEnvVarsConfig). The proxy needs the socket to ask for the lease.
const codexBrowserMCPEnvVarsConfig = `mcp_servers.` + browserMCPServerName + `.env_vars=["ORBIT_BG_SOCKET","ORBIT_BG_TOKEN","ORBIT_SESSION_ID"]`

// appendCodexBrowserMCPConfig adds the browser server to a Codex spawn while the browser is active.
func appendCodexBrowserMCPConfig(args []string, exe string) []string {
	if exe == "" || !browserMCPActive() {
		return args
	}
	argv, _ := json.Marshal(browserMCPArgs())
	return append(args,
		"-c", fmt.Sprintf("mcp_servers.%s.command=%q", browserMCPServerName, exe),
		"-c", fmt.Sprintf("mcp_servers.%s.args=%s", browserMCPServerName, argv),
		"-c", codexBrowserMCPEnvVarsConfig,
	)
}

// addClaudeBrowserMCPServer adds the browser server to a Claude Code spawn's --mcp-config while the browser is
// active. It replaces an agent's own server of the same name, as the orbit entry does.
func addClaudeBrowserMCPServer(servers map[string]interface{}, exe string) {
	if exe == "" || !browserMCPActive() {
		return
	}
	servers[browserMCPServerName] = map[string]interface{}{
		"command": exe,
		"args":    browserMCPArgs(),
	}
}

// serveBrowserAcquire is the runner's half of op browser_acquire: one browser tool call by this socket's session.
func (s *bgJobService) serveBrowserAcquire() bgSocketResponse {
	title := ""
	if s.job != nil {
		title = s.job.Title
	}
	b := runnerBrowserForSpawn()
	if err := b.Acquire(s.sessionID, title); err != nil {
		return bgSocketResponse{Error: err.Error()}
	}
	return bgSocketResponse{OK: true, Result: map[string]string{"devTools": b.DevToolsEndpoint()}}
}

// serveBrowserSignInYield is the runner's half of op browser_sign_in_yield: this socket's session gives the lease up
// while the owner is asked to sign in (browserSupervisor.YieldForSignIn). It answers whether the session held it.
func (s *bgJobService) serveBrowserSignInYield() bgSocketResponse {
	title := ""
	if s.job != nil {
		title = s.job.Title
	}
	held, err := runnerBrowserForSpawn().YieldForSignIn(s.sessionID, title)
	if err != nil {
		return bgSocketResponse{Error: err.Error()}
	}
	return bgSocketResponse{OK: true, Result: map[string]bool{"held": held}}
}

// serveBrowserSignInEnd is op browser_sign_in_end: the wait is over, and with retake the session takes the lease back.
func (s *bgJobService) serveBrowserSignInEnd(retake bool) bgSocketResponse {
	title := ""
	if s.job != nil {
		title = s.job.Title
	}
	if err := runnerBrowserForSpawn().EndSignIn(s.sessionID, title, retake); err != nil {
		return bgSocketResponse{Error: err.Error()}
	}
	return bgSocketResponse{OK: true, Result: map[string]bool{"retaken": retake}}
}

// browserMCPProxy is one `orbit browser-mcp`: the engine on in/out, playwright-mcp on child.
type browserMCPProxy struct {
	// acquire asks the runner for the lease and answers the DevTools endpoint to wait for.
	acquire func() (devTools string, err error)
	// waitReady waits for Chrome at devTools to answer (a no-op when it already does).
	waitReady func(devTools string)
	out       io.Writer
	outMu     sync.Mutex
}

// cmdBrowserMCP runs `orbit browser-mcp`, serving the engine on stdin/stdout until it closes stdin.
func cmdBrowserMCP() {
	socket, token := os.Getenv(envBgSocket), os.Getenv(envBgToken)
	p := &browserMCPProxy{
		acquire: func() (string, error) {
			raw, err := bgSocketCall(socket, token, browserMCPAcquireOp, nil)
			if err != nil {
				return "", err
			}
			var res struct {
				DevTools string `json:"devTools"`
			}
			_ = json.Unmarshal(raw, &res)
			return res.DevTools, nil
		},
		waitReady: waitBrowserDevTools,
		out:       os.Stdout,
	}
	cmd := exec.Command(playwrightMCPBinary, playwrightMCPArgs(socket)...)
	cmd.Stderr = os.Stderr
	if err := p.run(cmd, os.Stdin); err != nil {
		fmt.Fprintln(os.Stderr, "orbit browser-mcp:", err)
		os.Exit(1)
	}
}

// playwrightMCPArgs is playwright-mcp's argv: Chrome's DevTools endpoint, and where it writes its snapshots and
// screenshots. Left to itself it writes them under the engine's working directory, which is the session's checkout,
// where they would be committed with the session's work; they go to the session's run directory instead, beside its
// socket (runDir), or under the temporary directory when there is no socket.
func playwrightMCPArgs(socket string) []string {
	out := filepath.Join(os.TempDir(), "orbit-browser-mcp")
	if socket != "" {
		out = filepath.Join(filepath.Dir(socket), "browser-output")
	}
	return []string{
		"--cdp-endpoint", "http://" + browserDevToolsHost + ":" + strconv.Itoa(browserDevToolsPort),
		"--output-dir", out,
	}
}

// run starts child and relays until the engine closes in, then closes the child's stdin and waits for it.
func (p *browserMCPProxy) run(child *exec.Cmd, in io.Reader) error {
	childIn, err := child.StdinPipe()
	if err != nil {
		return err
	}
	childOut, err := child.StdoutPipe()
	if err != nil {
		return err
	}
	if err := child.Start(); err != nil {
		return fmt.Errorf("start %s: %w", child.Path, err)
	}
	relayed := make(chan struct{})
	go func() {
		defer close(relayed)
		r := bufio.NewReaderSize(childOut, 64*1024)
		for {
			line, err := readMCPLine(r)
			if len(line) > 0 {
				p.write(line)
			}
			if err != nil {
				return
			}
		}
	}()
	r := bufio.NewReaderSize(in, 64*1024)
	for {
		line, rerr := readMCPLine(r)
		if len(line) > 0 {
			if reply := p.intercept(line); reply != nil {
				p.write(reply)
			} else if _, err := childIn.Write(line); err != nil {
				break
			}
		}
		if rerr != nil {
			break
		}
	}
	_ = childIn.Close()
	<-relayed
	return child.Wait()
}

// intercept looks at one message from the engine. A tools/call first takes the lease: refused, it answers the call
// itself with a tool error naming the holder and the message goes no further; granted, it waits for Chrome and lets
// the message through. Anything else goes through untouched.
func (p *browserMCPProxy) intercept(line []byte) []byte {
	var msg struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
	}
	if json.Unmarshal(bytes.TrimSpace(line), &msg) != nil || msg.Method != "tools/call" || len(msg.ID) == 0 {
		return nil
	}
	devTools, err := p.acquire()
	if err != nil {
		reply, _ := json.Marshal(map[string]interface{}{
			"jsonrpc": "2.0",
			"id":      msg.ID,
			"result": map[string]interface{}{
				"content": []map[string]string{{"type": "text", "text": err.Error()}},
				"isError": true,
			},
		})
		return append(reply, '\n')
	}
	if devTools != "" && p.waitReady != nil {
		p.waitReady(devTools)
	}
	return nil
}

func (p *browserMCPProxy) write(line []byte) {
	p.outMu.Lock()
	defer p.outMu.Unlock()
	_, _ = p.out.Write(line)
}

// readMCPLine reads one newline-delimited message (the stdio transport's framing), newline included.
func readMCPLine(r *bufio.Reader) ([]byte, error) {
	var buf []byte
	for {
		chunk, err := r.ReadSlice('\n')
		buf = append(buf, chunk...)
		if len(buf) > browserMCPLineCap {
			return nil, errors.New("message too large")
		}
		if err == bufio.ErrBufferFull {
			continue
		}
		return buf, err
	}
}

// waitBrowserDevTools polls Chrome's /json/version until it answers or browserDevToolsReadyWait passes. A Chrome
// that never answers is left for playwright to report on the tool call.
func waitBrowserDevTools(devTools string) {
	client := &http.Client{Timeout: 2 * time.Second}
	deadline := time.Now().Add(browserDevToolsReadyWait)
	for {
		resp, err := client.Get(devTools + "/json/version")
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return
			}
		}
		if time.Now().After(deadline) {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
}
