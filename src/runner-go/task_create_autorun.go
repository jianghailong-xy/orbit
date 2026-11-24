package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
	"sync"
	"time"
)

// Two mechanisms that replace sentences the primer used to carry (docs/agent-instructions-design.md §7, D3 and D4).

const runnerTaskAutoRunDeclarationError = "autoRunWhenReady is required when an agent creates a task: true means the task starts by " +
	"itself once it is ready (an assignee, every prerequisite DONE and, in a project, the project started); false means it " +
	"stays recorded until someone starts it. Pass the one the person asked for"

// requireRunnerTaskAutoRunDeclaration is the D3 check: a create from an agent session says whether the task starts by
// itself. The user/JWT API (the web UI) keeps its default; the server cannot tell an agent's omission from a person's,
// so the runner is where it is refused, on the MCP tools and the CLI alike.
func requireRunnerTaskAutoRunDeclaration(item map[string]interface{}) error {
	if !autoRunDeclarationRequired {
		return nil
	}
	if value, present := item["autoRunWhenReady"]; present {
		if _, ok := value.(bool); ok {
			return nil
		}
	}
	return fmt.Errorf("%s", runnerTaskAutoRunDeclarationError)
}

// createKeyWindow is how long a key `orbit mcp` derived stays the same for identical arguments: about the length of a
// retry storm, so a retry after a timeout files once, and a deliberate re-create of the same content later files anew.
const createKeyWindow = 10 * time.Minute

// derivedCreateKeys remembers, per session, when each derived key's window opened.
type derivedCreateKeys struct {
	mu    sync.Mutex
	opens map[string]time.Time
}

// derive returns the idempotency key for a task_create or task_create_batch call that carries none: a hash of the
// session id, the tool and the canonical arguments, suffixed with the second its window opened. Identical calls inside
// the window get the first key back, so the server answers with the first write; a call after it opens a new window.
func (d *derivedCreateKeys) derive(sessionID, tool string, args map[string]interface{}, now time.Time) string {
	canonical := make(map[string]interface{}, len(args))
	for key, value := range args {
		if key != "idempotencyKey" && key != "dryRun" {
			canonical[key] = value
		}
	}
	raw, _ := json.Marshal(canonical) // map keys are written sorted
	sum := sha256.Sum256([]byte(sessionID + "\x00" + tool + "\x00" + string(raw)))
	hash := hex.EncodeToString(sum[:])[:24]
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.opens == nil {
		d.opens = map[string]time.Time{}
	}
	opened, ok := d.opens[hash]
	if !ok || now.Sub(opened) >= createKeyWindow {
		opened = now
		d.opens[hash] = opened
	}
	return "auto-" + hash + "-" + strconv.FormatInt(opened.Unix(), 36)
}

// createKeyNow is the clock the derived keys read; tests replace it.
var createKeyNow = time.Now

// autoRunDeclarationRequired is on in every process but the unit-test binary's own (TestMain).
var autoRunDeclarationRequired = true
