package main

import (
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"strings"
	"time"

	"orbit/link-gateway/linkpb"
)

// The reports a runner's heartbeat carries that move in production, moved at the rate src/runner-go moves them
// (-volatile; task O1). Without it every simulated runner reports the same parts on every beat, which is what C2
// measured; a control plane that answers an unchanged beat from runner_presence alone answers almost every one of them
// that way. With it:
//
//   - planUsage: the provider's quota is read again every 5 minutes while a session runs on the machine and every 10
//     minutes otherwise (planUsageActiveInterval, planUsageIdleInterval, src/runner-go/planusage.go), and each read
//     moves the windows' utilization;
//   - agentDirProbes: the workspaces' directories are stat'ed again when a heartbeat answer names them
//     (agentDirs.trigger, src/runner-go/runloop.go), which an answer that reconciled in full does, and the free space
//     the scan finds has moved since the last one;
//   - sessions: a running session's worktree snapshot (SessionLiveState) moves with each edit its turn lands, which
//     -volatile-edits says how often: the share of a running session's beats on which it moved;
//   - engines: the engine update check stamps its time every 30 minutes (src/runner-go/enginehealth.go).
//
// Each moved part goes whole on the next beat, as the runner's link mode sends a part whose digest the connection has
// not carried (linkWorkConn.beat, src/runner-go/link_heartbeat.go).

const (
	planUsageActiveEvery = 5 * time.Minute
	planUsageIdleEvery   = 10 * time.Minute
	engineCheckEvery     = 30 * time.Minute
)

// volatile is one runner's moving parts.
type volatile struct {
	planUsageAt   time.Time
	enginesAt     time.Time
	planUsageRead int
	engineChecks  int
	// dirs are the directories the last answer that named them asked for; probesDue, that they are to be scanned.
	dirs      []agentDir
	probesDue bool
	scans     int
	// edits counts each running session's landed edits.
	edits map[string]int
}

type agentDir struct {
	AgentID string `json:"agentId"`
	WorkDir string `json:"workDir"`
}

// newVolatile starts each clock at a random point of its period, as a fleet's machines are at every point of theirs.
func newVolatile(rng *rand.Rand, now time.Time, active bool) *volatile {
	planEvery := planUsageIdleEvery
	if active {
		planEvery = planUsageActiveEvery
	}
	return &volatile{
		planUsageAt: now.Add(time.Duration(rng.Float64() * float64(planEvery))),
		enginesAt:   now.Add(time.Duration(rng.Float64() * float64(engineCheckEvery))),
		edits:       map[string]int{},
	}
}

// moveVolatile moves what is due before a beat and puts the moved parts in the runner's facts.
func (r *runner) moveVolatile(now time.Time) {
	v := r.vol
	if !now.Before(v.planUsageAt) {
		v.planUsageRead++
		every := planUsageIdleEvery
		if len(r.active) > 0 {
			every = planUsageActiveEvery
		}
		v.planUsageAt = now.Add(every)
		r.setFact(fact("planUsage", planUsageReport(r.n, v.planUsageRead)))
	}
	if !now.Before(v.enginesAt) {
		v.engineChecks++
		v.enginesAt = now.Add(engineCheckEvery)
		r.setFact(fact("engines", enginesChecked(now)))
	}
	if v.probesDue && len(v.dirs) > 0 {
		v.probesDue = false
		v.scans++
		r.setFact(fact("agentDirProbes", probesOf(v.dirs, r.n, v.scans)))
	}
	if len(r.active) > 0 {
		moved := false
		for _, s := range r.active {
			if r.rng.Float64() < r.g.o.volatileEdits {
				v.edits[s.id]++
				moved = true
			}
		}
		if moved || r.factOf("sessions") == nil {
			r.setFact(fact("sessions", snapshotsOf(r.active, v.edits)))
		}
	}
}

// volatileFacts moves what is due and is the beat's parts: each whole when this connection has not carried its digest
// whole (all of them on its first beat, or after the gateway asked), by digest otherwise.
func (r *runner) volatileFacts(now time.Time) []*linkpb.Fact {
	r.moveVolatile(now)
	if r.beatWhole || r.sent == nil {
		r.sent = map[string]string{}
	}
	out := make([]*linkpb.Fact, 0, len(r.facts))
	for _, f := range r.facts {
		if r.sent[f.GetKind()] == f.GetSha256() {
			out = append(out, &linkpb.Fact{Kind: f.GetKind(), Sha256: f.GetSha256()})
			continue
		}
		out = append(out, f)
		r.sent[f.GetKind()] = f.GetSha256()
	}
	return out
}

// onAnswer reads what a full answer asks of the runner's scans: the directories it names.
func (v *volatile) onAnswer(reconcile []byte) {
	if !strings.Contains(string(reconcile), `"agentDirs"`) {
		return
	}
	var answer struct {
		AgentDirs []agentDir `json:"agentDirs"`
	}
	if json.Unmarshal(reconcile, &answer) == nil && answer.AgentDirs != nil {
		v.dirs = answer.AgentDirs
		v.probesDue = true
	}
}

// setFact replaces the runner's part of fact's kind, or adds it.
func (r *runner) setFact(f *linkpb.Fact) {
	for i, have := range r.facts {
		if have.GetKind() == f.GetKind() {
			r.facts[i] = f
			return
		}
	}
	r.facts = append(r.facts, f)
}

func (r *runner) factOf(kind string) *linkpb.Fact {
	for _, f := range r.facts {
		if f.GetKind() == kind {
			return f
		}
	}
	return nil
}

func planUsageReport(n, read int) map[string]any {
	used := float64((n*7+read*3)%100) + 0.5
	return map[string]any{
		"claude": map[string]any{
			"provider": "claude",
			"fiveHour": map[string]any{"utilization": used, "resetsAt": "2026-10-26T12:00:00Z"},
			"sevenDay": map[string]any{"utilization": used / 4, "resetsAt": "2026-10-30T00:00:00Z"},
		},
		"codex": map[string]any{
			"provider": "codex",
			"primary":  map[string]any{"utilization": used / 2, "windowDurationMins": 300},
		},
	}
}

func enginesChecked(at time.Time) []map[string]any {
	stamp := at.UTC().Format(time.RFC3339)
	checked := map[string]any{"status": "checked", "at": stamp, "okAt": stamp}
	return []map[string]any{
		{"engine": "claude", "installed": true, "version": "2.3.0 (Claude Code)", "auth": "yes", "update": checked},
		{"engine": "codex", "installed": true, "version": "codex-cli 0.164.0", "auth": "yes", "update": checked,
			"accounts": []map[string]any{{"id": "default", "auth": "yes"}}},
		{"engine": "kimi", "installed": false, "auth": "unknown"},
		{"engine": "opencode", "installed": false, "auth": "unknown"},
	}
}

func probesOf(dirs []agentDir, n, scan int) []map[string]any {
	out := make([]map[string]any, 0, len(dirs))
	for _, d := range dirs {
		out = append(out, map[string]any{
			"agentId": d.AgentID, "workDir": d.WorkDir, "exists": true, "isGitRepo": true,
			"freeBytes": int64(200e9) - int64(n%1000)*int64(1e8) - int64(scan)*int64(37e6), "totalBytes": int64(500e9),
		})
	}
	return out
}

func snapshotsOf(active []*session, edits map[string]int) []map[string]any {
	out := make([]map[string]any, 0, len(active))
	for _, s := range active {
		k := edits[s.id]
		files := []map[string]any{{"path": "src/app/main.go", "additions": 3 * k, "deletions": k, "status": "M"}}
		if k > 4 {
			files = append(files, map[string]any{"path": fmt.Sprintf("src/app/part_%d.go", k/5), "additions": k, "deletions": 0, "status": "A"})
		}
		out = append(out, map[string]any{
			"sessionId": s.id, "isolationStatus": "isolated", "changedFiles": files, "worktreeDirty": k > 0, "branchMerged": false,
		})
	}
	return out
}
