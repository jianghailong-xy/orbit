package main

// Checking a Cursor API key somebody is waiting on (docs/cursor-runtime-contract.md §9): one typed into
// the connect form, or a saved one checked again. The control plane never uses a Cursor key itself: it
// hands the key to this runner on a heartbeat (HeartbeatResponse.CursorKeyChecks), only once this binary
// declares cursor-key-check/v1 and reports the pinned Cursor CLI installed, and the runner asks that
// CLI's `agent models` with it exactly as a session's start does (checkCursorAPIKey): in a throwaway home,
// the key in the CLI's environment with its credentials held in memory, never the ACP handshake, and no
// request spent. The answer goes back by its own POST (/runner/cursor-key-check-result), naming the check
// and the key's fingerprint, never the key, within cursorKeyCheckTimeout.

import (
	"context"
	"encoding/json"
	"strings"
	"time"
)

// cursorKeyCheckCapabilityV1 is what this binary declares to be handed Cursor API keys to check.
const cursorKeyCheckCapabilityV1 = "cursor-key-check/v1"

// cursorKeyCheckTimeout bounds one check from hand-over to answer. `agent models` answers in about 2–4 s
// (§9), somebody is waiting on it, and the control plane stops waiting at 25 s (CURSOR_KEY_CHECK_WAIT_MS).
var cursorKeyCheckTimeout = 15 * time.Second

// CursorKeyCheckCommand is one Cursor API key to check, as a heartbeat hands it over. It carries the key,
// so it never prints or serializes it.
type CursorKeyCheckCommand struct {
	CheckID string `json:"checkId"`
	APIKey  string `json:"apiKey"`
}

func (c CursorKeyCheckCommand) String() string { return "Cursor key check " + c.CheckID }

func (c CursorKeyCheckCommand) GoString() string { return c.String() }

func (c CursorKeyCheckCommand) MarshalJSON() ([]byte, error) {
	return json.Marshal(map[string]string{"checkId": c.CheckID})
}

// CursorKeyCheckResult answers a CursorKeyCheckCommand (POST /runner/cursor-key-check-result): what Cursor
// said of the key, and the key it was about by its fingerprint.
type CursorKeyCheckResult struct {
	CheckID        string `json:"checkId"`
	State          string `json:"state"`
	KeyFingerprint string `json:"keyFingerprint"`
}

// startCursorKeyChecks answers each check a heartbeat handed over, on a goroutine of its own — `agent
// models` takes seconds, and the answer travels by its own POST — counted in ops, which a runner that
// stops waits for. Handed over once, so there is no second delivery to guard against.
func startCursorKeyChecks(checks []CursorKeyCheckCommand, ops *countedOps, report func(CursorKeyCheckResult) error) {
	for _, check := range checks {
		ops.Add(1)
		go func(check CursorKeyCheckCommand) {
			defer ops.Done()
			answerCursorKeyCheck(context.Background(), check, report)
		}(check)
	}
}

// answerCursorKeyCheck checks the command's key with the pinned CLI and reports what Cursor answered, by
// the deadline whatever the CLI does. An answer that is no verdict — no pinned CLI here, none by the
// deadline, or words §9 never measured — is UNREACHABLE: the key could not be checked, which says nothing
// against it.
func answerCursorKeyCheck(ctx context.Context, check CursorKeyCheckCommand, report func(CursorKeyCheckResult) error) {
	key := strings.TrimSpace(check.APIKey)
	ctx, cancel := context.WithTimeout(ctx, cursorKeyCheckTimeout)
	defer cancel()
	answered := make(chan string, 1)
	go func() {
		exe, err := cursorExecutablePath()
		if err != nil {
			logln("cursor: no pinned Cursor CLI to check a key with:", err)
			answered <- ""
			return
		}
		answered <- checkCursorAPIKey(ctx, exe, key)
	}()
	state := cursorKeyUnreachable
	select {
	case said := <-answered:
		if said != "" {
			state = said
		}
	case <-ctx.Done():
	}
	if err := report(CursorKeyCheckResult{CheckID: check.CheckID, State: state, KeyFingerprint: cursorKeyFingerprint(key)}); err != nil {
		logln("cursor: could not report a key check:", err)
	}
}
