package main

// A scripted stand-in for the `kimi` CLI speaking ACP over stdio, the fake_claude_test.go
// pattern for the Kimi engine: TestMain re-enters this binary as the child when the shim's
// env var is set, so the runner's exec.CommandContext("kimi", "acp") lands here.
//
// The script is the list of session/update payloads to stream when a session/prompt arrives,
// in order; {"sleepMs": N} is not an update but a beat of silence between two of them, which
// a test times a stretch of reasoning against. On the same prompt the child also writes the
// main agent's wire (turn.prompt + turn.ended) under the KIMI_CODE_HOME it was spawned with —
// through the overlay's sessions link, so it lands in the account home the runner reads the
// turn's outcome from (kimiTurnUsageLimit).

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// fakeKimiACPDirEnv starts this test binary as a scripted `kimi` CLI (TestMain).
const fakeKimiACPDirEnv = "ORBIT_FAKE_KIMI_ACP_DIR"

// The session id the fake's handshake hands back; the wire is written under it.
const fakeKimiACPSession = "kimi-fake-acp-session"

func runFakeKimiACP(dir string) int {
	if len(os.Args) < 2 || os.Args[1] != "acp" {
		// Anything but an ACP session (a version probe) answers like the CLI would.
		fmt.Println("kimi 0.0.0-test")
		return 0
	}
	var updates []map[string]interface{}
	if data, err := os.ReadFile(filepath.Join(dir, "script.json")); err == nil {
		_ = json.Unmarshal(data, &updates)
	}
	out := bufio.NewWriter(os.Stdout)
	write := func(msg map[string]interface{}) {
		line, err := json.Marshal(msg)
		if err == nil {
			_, _ = out.Write(line)
			_ = out.WriteByte('\n')
			_ = out.Flush()
		}
	}
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 1<<20), 1<<20)
	for scanner.Scan() {
		var msg map[string]interface{}
		if json.Unmarshal(scanner.Bytes(), &msg) != nil {
			continue
		}
		id, isRequest := msg["id"]
		if !isRequest {
			continue // a notification (session/cancel): nothing to answer
		}
		method, _ := msg["method"].(string)
		result := map[string]interface{}{}
		switch method {
		case "initialize":
			result["protocolVersion"] = 1
		case "authenticate", "session/set_config_option":
		case "session/new", "session/resume":
			result["sessionId"] = fakeKimiACPSession
		case "session/prompt":
			for _, update := range updates {
				if ms := update["sleepMs"]; ms != nil {
					if f, ok := ms.(float64); ok {
						time.Sleep(time.Duration(f) * time.Millisecond)
					}
					continue
				}
				write(map[string]interface{}{
					"jsonrpc": "2.0",
					"method":  "session/update",
					"params": map[string]interface{}{
						"sessionId": fakeKimiACPSession,
						"update":    update,
					},
				})
			}
			writeFakeKimiACPWire(os.Getenv("KIMI_CODE_HOME"))
			result["stopReason"] = "end_turn"
		default:
			write(map[string]interface{}{
				"jsonrpc": "2.0",
				"id":      id,
				"error":   map[string]interface{}{"code": -32601, "message": "no such method: " + method},
			})
			continue
		}
		write(map[string]interface{}{"jsonrpc": "2.0", "id": id, "result": result})
	}
	return 0
}

// writeFakeKimiACPWire writes the records the runner reads the turn's outcome from. state.json
// is what makes the session's directory real to kimiSessionDirIn.
func writeFakeKimiACPWire(home string) {
	if home == "" {
		return
	}
	dir := filepath.Join(home, "sessions", "b", fakeKimiACPSession)
	wireDir := filepath.Join(dir, "agents", "main")
	if err := os.MkdirAll(wireDir, 0o755); err != nil {
		return
	}
	_ = os.WriteFile(filepath.Join(dir, "state.json"), []byte(`{}`), 0o600)
	records := []map[string]interface{}{
		{"type": "turn.prompt", "agentId": "main", "turnId": "t-1"},
		{"type": "turn.ended", "agentId": "main", "turnId": "t-1", "reason": "completed"},
	}
	var wire []byte
	for _, rec := range records {
		line, err := json.Marshal(rec)
		if err == nil {
			wire = append(wire, line...)
			wire = append(wire, '\n')
		}
	}
	_ = os.WriteFile(filepath.Join(wireDir, "wire.jsonl"), wire, 0o600)
}

type fakeKimiEngine struct {
	t   *testing.T
	Dir string // holds the `kimi` shim; prepend to PATH to have it spawned as the CLI
}

// newFakeKimi writes a `kimi` shim streaming the scripted session/update entries on each
// session/prompt, then answering end_turn.
func newFakeKimiEngine(t *testing.T, updates ...map[string]interface{}) *fakeKimiEngine {
	t.Helper()
	base := t.TempDir()
	binDir, rec := filepath.Join(base, "bin"), filepath.Join(base, "rec")
	for _, d := range []string{binDir, rec} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	script, err := json.Marshal(updates)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(rec, "script.json"), script, 0o644); err != nil {
		t.Fatal(err)
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	// The env var is set by the shim, not exported into the test process, so no other
	// subprocess a test spawns can be turned into a fake CLI by accident.
	shim := "#!/bin/sh\n" + fakeKimiACPDirEnv + "='" + rec + "' exec '" + self + "' \"$@\"\n"
	if err := os.WriteFile(filepath.Join(binDir, "kimi"), []byte(shim), 0o755); err != nil {
		t.Fatal(err)
	}
	return &fakeKimiEngine{t: t, Dir: binDir}
}
