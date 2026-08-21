package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// What `turn/steer` does on the wire, asked of a real `codex app-server`.
//
// docs/codex-turn-steer-contract.md freezes a handful of literal strings — the method name, and
// the exact error messages Orbit classifies a refusal by. They are load-bearing: Codex answers
// EVERY failure with the same JSON-RPC code (-32600, including "that method does not exist"), so
// the message text is the only thing that separates "the turn just ended, re-queue this safely"
// from "this Codex is too old, stop trying" from "something we do not understand, do not retry".
// A Codex release that reworded any of them would silently push every refusal into the
// unrecognised bucket, where the contract says to fail the message rather than guess.
//
// So this test asks the installed engine rather than trusting a comment. None of the cases below
// reach a model: they are all rejected before the input is read, so it costs no tokens and needs
// no login. It skips when there is no `codex` on PATH (CI images that carry no engine), which is
// also why the assertions stay on the cheap side of the protocol — the mid-turn behaviour that
// needs a live turn lives in docs/evidence/codex-turn-steer-0.149.0/probe.mjs instead.

// codexAppServerProbe is one initialized app-server connection, spoken to over stdio.
type codexAppServerProbe struct {
	t    *testing.T
	cmd  *exec.Cmd
	in   *os.File
	out  *bufio.Reader
	next int
}

func startCodexAppServerProbe(t *testing.T) *codexAppServerProbe {
	t.Helper()
	exe, err := exec.LookPath("codex")
	if err != nil {
		t.Skip("no codex on PATH; this protocol check needs a real app-server")
	}
	// Its own SQLite home, so a probe never touches the developer's real thread history.
	cmd := exec.Command(exe, "app-server", "--stdio", "-c",
		fmt.Sprintf("sqlite_home=%q", filepath.Join(t.TempDir(), "state")))
	stdinR, stdinW, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	stdoutR, stdoutW, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = stdinR, stdoutW, nil
	if err := cmd.Start(); err != nil {
		t.Skipf("cannot run %s app-server: %v", exe, err)
	}
	stdinR.Close()
	stdoutW.Close()
	p := &codexAppServerProbe{t: t, cmd: cmd, in: stdinW, out: bufio.NewReaderSize(stdoutR, 1<<20)}
	t.Cleanup(func() {
		stdinW.Close()
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		stdoutR.Close()
	})
	// A cold app-server can spend a while bringing up its state before it answers; bound the
	// whole exchange rather than any single read.
	_ = stdoutR.SetReadDeadline(time.Now().Add(90 * time.Second))
	p.request("initialize", map[string]interface{}{
		"clientInfo":   map[string]interface{}{"name": "orbit-test", "title": "Orbit", "version": "0.1.0"},
		"capabilities": map[string]interface{}{"experimentalApi": true},
	})
	p.write(map[string]interface{}{"method": "initialized", "params": map[string]interface{}{}})
	return p
}

func (p *codexAppServerProbe) write(msg map[string]interface{}) {
	p.t.Helper()
	b, err := json.Marshal(msg)
	if err != nil {
		p.t.Fatalf("marshal: %v", err)
	}
	if _, err := p.in.Write(append(b, '\n')); err != nil {
		p.t.Fatalf("write %v: %v", msg["method"], err)
	}
}

// request sends one JSON-RPC request and returns its response, skipping the notifications the
// server interleaves. Responses come back in order because the probe only has one outstanding.
func (p *codexAppServerProbe) request(method string, params map[string]interface{}) codexRPCMessage {
	p.t.Helper()
	p.next++
	id := p.next
	p.write(map[string]interface{}{"id": id, "method": method, "params": params})
	for {
		line, err := p.out.ReadBytes('\n')
		if err != nil {
			p.t.Fatalf("reading the response to %s: %v", method, err)
		}
		var msg codexRPCMessage
		if err := json.Unmarshal(line, &msg); err != nil {
			continue // app-server may print non-JSON diagnostics
		}
		// Method being empty is what separates a response from a server-initiated request:
		// those carry an id too, drawn from the server's own counter, so it can collide.
		if msg.Method == "" && fmt.Sprint(msg.ID) == fmt.Sprint(id) {
			return msg
		}
	}
}

// startThread opens a thread to address the steer requests at. No turn is ever started on it.
func (p *codexAppServerProbe) startThread() string {
	p.t.Helper()
	resp := p.request("thread/start", map[string]interface{}{
		"cwd":            p.t.TempDir(),
		"approvalPolicy": "never",
		"sandbox":        "danger-full-access",
		"threadSource":   "orbit-test",
	})
	if resp.Error != nil {
		p.t.Fatalf("thread/start: %v", resp.Error.Message)
	}
	id := threadIDFromResult(rawObject(resp.Result))
	if id == "" {
		p.t.Fatalf("thread/start returned no thread id: %s", resp.Result)
	}
	return id
}

// A turn id that is well-formed (app-server parses it before it looks anything up) but belongs to
// no turn, so every case below is refused on the "which turn" question rather than on parsing.
const codexProbeAbsentTurnID = "01a02538-0000-7000-8000-000000000000"

// One app-server, every refusal Orbit has to tell apart. They share a connection because
// bringing a cold app-server up costs about a minute, and none of these cases disturbs it: no
// turn is ever started, so each request is refused on its own and leaves no state behind.
func TestCodexTurnSteerRefusalsKeepTheirContractWording(t *testing.T) {
	p := startCodexAppServerProbe(t)
	threadID := p.startThread()

	// The rows of docs/codex-turn-steer-contract.md §4.2 that can be provoked without a turn.
	for _, tc := range []struct {
		name   string
		id     string
		method string
		params map[string]interface{}
		want   string
	}{
		{
			name:   "the turn ended, or never started",
			id:     "E-NO-ACTIVE",
			method: "turn/steer",
			params: map[string]interface{}{
				"threadId": threadID, "expectedTurnId": codexProbeAbsentTurnID,
				"input":               []map[string]interface{}{{"type": "text", "text": "hello"}},
				"clientUserMessageId": "orbit-test",
			},
			want: "no active turn to steer",
		},
		{
			name:   "expectedTurnId is not optional on the wire",
			id:     "E-BAD-REQUEST",
			method: "turn/steer",
			params: map[string]interface{}{
				"threadId": threadID,
				"input":    []map[string]interface{}{{"type": "text", "text": "hello"}},
			},
			want: "missing field `expectedTurnId`",
		},
		{
			// The one refusal that is not about this turn but about this Codex. A build with no
			// `turn/steer` at all answers with an "unknown variant" naming the method, and the
			// contract makes that string the runtime signal to stop steering this engine (§5.2).
			// Asked here of a method that is absent on purpose, since the installed engine does
			// have `turn/steer` — TestCodexBuildHasTurnSteer reads that out of the same reply.
			name:   "a method this build does not have",
			id:     "E-UNSUPPORTED",
			method: "turn/steerNotAMethod",
			params: map[string]interface{}{"threadId": threadID},
			want:   "unknown variant `turn/steerNotAMethod`",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resp := p.request(tc.method, tc.params)
			if resp.Error == nil {
				t.Fatalf("%s: expected a refusal, got result %s", tc.id, resp.Result)
			}
			// Every refusal is -32600 — even an absent method, which is NOT -32601. That is
			// exactly why the message text has to carry the meaning.
			if resp.Error.Code != -32600 {
				t.Errorf("%s: code = %d, want -32600 (contract §4.1)", tc.id, resp.Error.Code)
			}
			if !strings.Contains(resp.Error.Message, tc.want) {
				t.Errorf("%s: message = %q, want it to contain %q (contract §4.2).\n"+
					"Codex reworded a string Orbit classifies refusals by — re-run "+
					"docs/evidence/codex-turn-steer-0.149.0/probe.mjs and update the contract.",
					tc.id, resp.Error.Message, tc.want)
			}
		})
	}

	// The same "unknown variant" reply enumerates what this build DOES support, which is where
	// the contract reads "this engine has turn/steer" from (§5.2). An engine too old for the
	// feature would omit it here, and this whole project would not apply to it.
	t.Run("this build has turn/steer", func(t *testing.T) {
		resp := p.request("turn/steerNotAMethod", map[string]interface{}{"threadId": threadID})
		if resp.Error == nil {
			t.Fatalf("expected a refusal, got %s", resp.Result)
		}
		if !strings.Contains(resp.Error.Message, "`turn/steer`") {
			t.Errorf("this codex does not list turn/steer among its methods, so it predates the "+
				"feature this contract is about: %q", resp.Error.Message)
		}
	})
}

// The request shape Orbit builds, checked against the schema the installed engine publishes.
// `expectedTurnId` being required is what makes a steer addressed rather than merely aimed at a
// thread, and `clientUserMessageId` is the only correlation key there is (contract §3) — if a
// release dropped it, the runner would have no way to tell its own steer's echo from anyone
// else's.
func TestCodexTurnSteerParamsSchemaMatchesTheContract(t *testing.T) {
	exe, err := exec.LookPath("codex")
	if err != nil {
		t.Skip("no codex on PATH; this schema check needs a real engine")
	}
	dir := t.TempDir()
	out, err := exec.Command(exe, "app-server", "generate-json-schema", "--out", dir).CombinedOutput()
	if err != nil {
		t.Skipf("cannot generate the app-server schema: %v: %s", err, out)
	}
	blob, err := os.ReadFile(filepath.Join(dir, "v2", "TurnSteerParams.json"))
	if err != nil {
		t.Fatalf("this codex publishes no TurnSteerParams schema, so it predates turn/steer: %v", err)
	}
	var schema struct {
		Required   []string                   `json:"required"`
		Properties map[string]json.RawMessage `json:"properties"`
	}
	if err := json.Unmarshal(blob, &schema); err != nil {
		t.Fatalf("unmarshal TurnSteerParams: %v", err)
	}

	required := map[string]bool{}
	for _, r := range schema.Required {
		required[r] = true
	}
	for _, field := range []string{"threadId", "expectedTurnId", "input"} {
		if !required[field] {
			t.Errorf("%q is no longer required by turn/steer (required = %v); contract §1 assumes it is",
				field, schema.Required)
		}
	}
	if _, ok := schema.Properties["clientUserMessageId"]; !ok {
		t.Errorf("turn/steer no longer accepts clientUserMessageId; it is the only key Orbit can "+
			"correlate a steer's echo by (contract §3). properties = %v", keysOf(schema.Properties))
	}
	// Contract §1: a steer joins a turn whose model/cwd/sandbox are already settled, so it takes
	// no turn-level overrides. 0.149.0 ignores such fields silently instead of rejecting them,
	// which is exactly why this is asserted against the schema rather than against a live reply.
	for _, override := range []string{"model", "cwd", "sandboxPolicy", "outputSchema", "effort"} {
		if _, ok := schema.Properties[override]; ok {
			t.Errorf("turn/steer now accepts a %q override; contract §1 says it takes none, and the "+
				"runner deliberately does not send one", override)
		}
	}
}

func keysOf(m map[string]json.RawMessage) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
