package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"os"
)

// Claude Code reports a turn's cost and tokens as running totals of its process: `total_cost_usd`
// and `modelUsage` in every `result` are all the process has spent, on top of what it restored
// when it started. The control plane books a turn's own share by difference, so a completion says
// which process its totals are of and what that process started from (RunningTotals). Measured on
// 2.1.318 against a scripted model (task 34sjn2yQvNJg1JhQIARvd):
//
//   - `result.usage` is the turn's own, the sum of that turn's requests. `total_cost_usd` and
//     `modelUsage` count every request of the process, including one made after a result (a
//     prompt suggestion), which the next result carries.
//   - A process that exits on its own (stdin EOF, SIGTERM) appends a `cost-state` record of its
//     totals to the transcript. One killed with SIGKILL appends nothing, and that is how this
//     runner stops a claude it recycles, reloads or drains (terminateSessionProcessTree).
//   - `--resume` restores the session's last valid `cost-state` in the transcript it reads,
//     whichever config directory that is in. With none (a transcript Orbit rebuilt from events, a
//     conversation no process has exited gracefully from) it starts from zero, as `--session-id`
//     does.
//
// So what a process starts from is knowable only here, before it starts, from the file it is about
// to read, and it is often older than the totals the process before it reported.

// claudeUsageTotals is Claude Code's running totals, as a `result` reports them.
type claudeUsageTotals struct {
	CostUsd    float64                `json:"costUsd"`
	ModelUsage map[string]interface{} `json:"modelUsage"`
}

// RunningTotals says that a completion's costUsd and modelUsage are running totals of one engine
// process, and what that process started from.
type RunningTotals struct {
	// Process is one id per engine process this runner started.
	Process string `json:"process"`
	// Restored is what the process restored when it started: its first completion is measured
	// from these, each later one from the completion before it.
	Restored claudeUsageTotals `json:"restored"`
}

// claudeCostStateLineMax bounds the transcript lines read as a cost-state record. One is a few
// hundred bytes a model, while a line holding a tool's output runs to megabytes.
const claudeCostStateLineMax = 1 << 20

// claudeRunningTotals names the claude process about to start: a new id, and what it will restore.
// A first spawn opens a new conversation, which restores nothing. Nil when that cannot be known
// (no id could be drawn, the transcript could not be read), which leaves the control plane to
// measure the totals as an older runner's.
func claudeRunningTotals(job *ClaimedSession, execDir string, firstSpawn bool) *RunningTotals {
	id, err := randomUUID()
	if err != nil {
		return nil
	}
	totals := &RunningTotals{Process: id, Restored: claudeUsageTotals{ModelUsage: map[string]interface{}{}}}
	if firstSpawn {
		return totals
	}
	base, err := claudeSessionAccountDir(job.Agent.Env, execDir)
	if err != nil {
		return nil
	}
	path, err := claudeTranscriptPathIn(base, execDir, job.SessionUUID)
	if err != nil {
		return nil
	}
	restored, found, err := lastClaudeCostState(path, job.SessionUUID)
	if err != nil {
		logln("running totals: cannot read the transcript", path+":", err)
		return nil
	}
	if found {
		totals.Restored = restored
	}
	return totals
}

// lastClaudeCostState is the session's last valid cost-state record in the transcript at path,
// which is what `claude --resume` restores. Read from the end, where the record a process wrote when
// it last exited gracefully is. A missing file holds none.
func lastClaudeCostState(path, sessionUUID string) (claudeUsageTotals, bool, error) {
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return claudeUsageTotals{}, false, nil
	}
	if err != nil {
		return claudeUsageTotals{}, false, err
	}
	defer f.Close()
	pos, err := f.Seek(0, io.SeekEnd)
	if err != nil {
		return claudeUsageTotals{}, false, err
	}
	buf := make([]byte, 64<<10)
	// tail is the part already read of the line that ends where the bytes read so far begin; long
	// says that line is longer than any cost-state record, so its bytes are not kept.
	var tail []byte
	long := false
	for pos > 0 {
		n := int64(len(buf))
		if n > pos {
			n = pos
		}
		pos -= n
		if _, err := f.ReadAt(buf[:n], pos); err != nil {
			return claudeUsageTotals{}, false, err
		}
		chunk := buf[:n]
		for {
			i := bytes.LastIndexByte(chunk, '\n')
			if i < 0 {
				break
			}
			if !long {
				line := append(append([]byte(nil), chunk[i+1:]...), tail...)
				if totals, ok := parseClaudeCostState(line, sessionUUID); ok {
					return totals, true, nil
				}
			}
			tail, long = nil, false
			chunk = chunk[:i]
		}
		if !long {
			tail = append(append([]byte(nil), chunk...), tail...)
			if len(tail) > claudeCostStateLineMax {
				tail, long = nil, true
			}
		}
	}
	if !long {
		if totals, ok := parseClaudeCostState(tail, sessionUUID); ok {
			return totals, true, nil
		}
	}
	return claudeUsageTotals{}, false, nil
}

// parseClaudeCostState reads one transcript line as the session's cost-state record. The CLI skips
// a record its schema refuses and restores an earlier one; this checks only the fields it uses, so
// a record the CLI would skip is at worst taken here as newer than what it restored. That books a
// turn short, never twice.
func parseClaudeCostState(line []byte, sessionUUID string) (claudeUsageTotals, bool) {
	if !bytes.Contains(line, []byte(`"cost-state"`)) {
		return claudeUsageTotals{}, false
	}
	var rec struct {
		Type         string                     `json:"type"`
		SessionID    string                     `json:"sessionId"`
		TotalCostUSD *float64                   `json:"totalCostUSD"`
		ModelUsage   map[string]json.RawMessage `json:"modelUsage"`
	}
	if json.Unmarshal(line, &rec) != nil || rec.Type != "cost-state" || rec.SessionID != sessionUUID ||
		rec.TotalCostUSD == nil || !claudeCount(*rec.TotalCostUSD) || rec.ModelUsage == nil {
		return claudeUsageTotals{}, false
	}
	models := make(map[string]interface{}, len(rec.ModelUsage))
	for model, raw := range rec.ModelUsage {
		var counts map[string]interface{}
		if json.Unmarshal(raw, &counts) != nil || counts == nil {
			return claudeUsageTotals{}, false
		}
		models[model] = counts
	}
	return claudeUsageTotals{CostUsd: *rec.TotalCostUSD, ModelUsage: models}, true
}

func claudeCount(v float64) bool {
	return v >= 0 && !math.IsInf(v, 0) && !math.IsNaN(v)
}
