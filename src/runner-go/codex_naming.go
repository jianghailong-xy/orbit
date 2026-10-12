package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"
)

// Naming a Codex session through the app-server already running it (see session_naming.go).
//
// The app-server has no request that names a thread: Codex's own TUI titles one by running a
// temporary structured turn on an ephemeral thread of the same process and keeping its answer. The
// runner does the same — one ephemeral thread (no rollout, nothing added to the account's history),
// one turn under Orbit's naming instructions whose answer must match codexNamingSchema, then
// unsubscribed. The session's own thread never sees that traffic (routeSideThread), the side thread
// asks nobody for anything (handleServerRequest declines it all), and it works in an empty directory
// under a read-only sandbox.

// codexNamingTimeout bounds the whole side thread: starting it, its one turn, and its cleanup. One
// short turn answers in seconds; past this the fallback title simply stays.
const codexNamingTimeout = 2 * time.Minute

// codexNamingSchema is the answer the naming turn must give (TurnStartParams.outputSchema), in the
// strict form structured outputs take: every property required, nothing else allowed.
var codexNamingSchema = map[string]interface{}{
	"type":                 "object",
	"properties":           map[string]interface{}{"title": map[string]interface{}{"type": "string"}},
	"required":             []string{"title"},
	"additionalProperties": false,
}

type codexNaming struct {
	Title string `json:"title"`
}

// nameCodexSession names the session in a side thread and reports the answer. Best-effort: any
// failure is logged and leaves the title as it is.
func nameCodexSession(ctx context.Context, t *Transport, app *codexAppServer, job *ClaimedSession) {
	ctx, cancel := context.WithTimeout(ctx, codexNamingTimeout)
	defer cancel()
	naming, err := runCodexNamingTurn(ctx, app, job)
	if err != nil {
		logln("session title: codex did not name", job.SessionID+":", err)
		return
	}
	reportSessionNaming(t, job, naming.Title)
}

// runCodexNamingTurn runs the side thread's one turn and returns its parsed answer. The thread runs
// the session's own model, so it spends the sign-in the session runs on and nothing else; low effort,
// since naming takes little thought.
func runCodexNamingTurn(ctx context.Context, app *codexAppServer, job *ClaimedSession) (*codexNaming, error) {
	dir, err := os.MkdirTemp("", "orbit-codex-naming-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	params := map[string]interface{}{
		"ephemeral":      true,
		"cwd":            dir,
		"approvalPolicy": "never",
		"sandbox":        "read-only",
		// Beside Codex's own base instructions rather than in place of them: a ChatGPT sign-in's
		// backend is particular about those.
		"developerInstructions": job.Naming.Instructions,
	}
	if job.Agent.Model != "" {
		params["model"] = job.Agent.Model
	}
	// A thread that only names needs no Orbit tools, so the server that brings them is not started
	// for it. A dotted key: a nested table replaces the server's whole config, and the key alone
	// names a server with no transport, which fails the thread/start of a process started without
	// one (both measured on 0.162.0).
	if app.orbitMCP {
		params["config"] = map[string]interface{}{"mcp_servers." + codexOrbitMCPServer + ".enabled": false}
	}
	started, err := app.request(ctx, "thread/start", params)
	if err != nil {
		return nil, err
	}
	threadID := threadIDFromResult(started)
	if threadID == "" {
		return nil, errors.New("thread/start answered without a thread id")
	}
	// Routed before the turn starts: Codex can say a turn's first things before it answers the
	// turn/start that began it.
	events := app.openSideThread(threadID)
	defer app.closeSideThread(threadID)
	turn, err := app.request(ctx, "turn/start", map[string]interface{}{
		"threadId":     threadID,
		"input":        []interface{}{map[string]interface{}{"type": "text", "text": job.Naming.Description}},
		"outputSchema": codexNamingSchema,
		"effort":       "low",
	})
	if err != nil {
		return nil, err
	}
	turnID := turnIDFromResult(turn)
	answer := ""
	for {
		select {
		case msg := <-events:
			note := rawObject(msg.Params)
			switch msg.Method {
			case "item/completed":
				item := mapValue(note["item"])
				switch strings.ToLower(firstString(item, "type")) {
				case "agentmessage", "agent_message", "message":
					if text := codexText(item); text != "" {
						answer = text
					}
				}
			case "turn/completed":
				if status := nestedString(note, "turn", "status"); status != "completed" {
					return nil, fmt.Errorf("naming turn ended %s: %s", status, nestedString(note, "turn", "error", "message"))
				}
				var naming codexNaming
				if err := json.Unmarshal([]byte(strings.TrimSpace(answer)), &naming); err != nil {
					return nil, fmt.Errorf("naming turn answered no JSON: %w", err)
				}
				return &naming, nil
			}
		case <-ctx.Done():
			if turnID != "" {
				stop, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				_, _ = app.request(stop, "turn/interrupt", map[string]interface{}{"threadId": threadID, "turnId": turnID})
				cancel()
			}
			return nil, ctx.Err()
		}
	}
}

// openSideThread starts routing a thread's notifications to the channel it returns. The buffer holds
// one short turn's notifications; routeSideThread drops what does not fit rather than stall the
// reader.
func (a *codexAppServer) openSideThread(threadID string) <-chan codexRPCMessage {
	ch := make(chan codexRPCMessage, 256)
	a.mu.Lock()
	if a.sideThreads == nil {
		a.sideThreads = map[string]chan codexRPCMessage{}
	}
	a.sideThreads[threadID] = ch
	a.mu.Unlock()
	return ch
}

// closeSideThread unsubscribes from a side thread — an ephemeral thread nobody else subscribes to is
// unloaded — and only then stops routing it, so what it says while it goes is still kept off the
// session's thread.
func (a *codexAppServer) closeSideThread(threadID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := a.request(ctx, "thread/unsubscribe", map[string]interface{}{"threadId": threadID}); err != nil {
		logln("codex side thread", threadID, "unsubscribe failed:", err)
	}
	a.mu.Lock()
	delete(a.sideThreads, threadID)
	a.mu.Unlock()
}

// isSideThread reports whether threadID is a thread Orbit opened for itself.
func (a *codexAppServer) isSideThread(threadID string) bool {
	if threadID == "" {
		return false
	}
	a.mu.Lock()
	_, ok := a.sideThreads[threadID]
	a.mu.Unlock()
	return ok
}

// routeSideThread hands a side thread's notification to the goroutine waiting on it and reports
// whether it was one. It never blocks the only reader of codex's stdout: a frame that does not fit is
// dropped, and the wait it belonged to ends at its deadline.
func (a *codexAppServer) routeSideThread(msg codexRPCMessage) bool {
	threadID := codexNotificationThreadID(msg)
	if threadID == "" {
		return false
	}
	a.mu.Lock()
	ch, ok := a.sideThreads[threadID]
	a.mu.Unlock()
	if !ok {
		return false
	}
	select {
	case ch <- msg:
	default:
		logln("codex side thread notification dropped:", msg.Method)
	}
	return true
}
