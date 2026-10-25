package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"strings"

	"orbit/link-gateway/linkpb"
)

// What the simulated runners say: heartbeat parts shaped like a runner's (HeartbeatRequest, src/runner-go/types.go)
// and durable events shaped like an engine's (the payloads the ingest derives from, runner-api.controller.ts).

// runnerVersion is what Hello and every heartbeat name: the release runners had when this test was written.
const runnerVersion = "0.1.237"

// runnerCapabilities is what a runner of that release declares in Hello (runnerCapabilitiesV1, src/runner-go/transport.go),
// which the gateway sends on with every call, as X-Orbit-Runner-Capabilities: the heartbeat route decides what it drains
// for the runner by them.
var runnerCapabilities = []string{
	"session-orchestration-credential-v1", "session-terminal-handoff-v1", "session-worktree-ops-v1",
	"session-merge-recovery-v1", "session-current-work-routing-v1", "session-claude-steer-withdraw-v1",
	"session-claude-coordinator-context-v1", "session-codex-coordinator-context-v1", "source-pin/v1",
	"codex-rate-limit-reset-v1", "integration-job/v1", "integration-progress/v2", "promotion-automatic-land/v1",
	"codex-account-login/v1", "codex-account-remove/v1", "codex-account-move/v1", "claude-account-login/v1",
	"claude-account-remove/v1", "claude-account-move/v1", "session-move/v1", "wiki-repo-op/v1", "wiki-repo-op-read/v1",
}

var supportedProviders = []string{"claude", "codex"}

// The write contract a runner of that release speaks (src/runner-go/protocol_contract.go).
var writeContract = &linkpb.WriteContract{CapabilityRevision: 2, SchemaRevision: 2,
	ContractDigest: "bbdd980c70dc56bfd09dfc311c41b3fdff8727912642ee4f529d8ddf36d3a696"}

func hello(process string) *linkpb.Hello {
	return &linkpb.Hello{
		ProcessId: process, RunnerVersion: runnerVersion, Os: "linux",
		MinProtocolVersion: 1, MaxProtocolVersion: 1,
		Capabilities: runnerCapabilities, SupportedProviders: supportedProviders, WriteContract: writeContract,
	}
}

// fact is one heartbeat part: its JSON and the digest of exactly those bytes.
func fact(kind string, value any) *linkpb.Fact {
	b, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	sum := sha256.Sum256(b)
	return &linkpb.Fact{Kind: kind, Sha256: hex.EncodeToString(sum[:]), Json: b}
}

// sharedFacts are the parts every simulated runner reports alike: two engines installed and signed in, their model
// catalogs, and the slash commands and skills found on the machine. Built once; about 7 KB of JSON.
var sharedFacts = buildSharedFacts()

func buildSharedFacts() []*linkpb.Fact {
	type model struct {
		Value                 string   `json:"value"`
		Label                 string   `json:"label"`
		ContextWindow         int      `json:"contextWindow,omitempty"`
		ReasoningLevels       []string `json:"reasoningLevels,omitempty"`
		DefaultReasoningLevel string   `json:"defaultReasoningLevel,omitempty"`
		PermissionModes       []string `json:"permissionModes,omitempty"`
		FastMode              *bool    `json:"fastMode,omitempty"`
	}
	yes, no := true, false
	modes := []string{"default", "acceptEdits", "plan", "auto", "bypassPermissions"}
	claude := []model{
		{Value: "claude-opus-5-5", Label: "Opus 5.5", ContextWindow: 1000000, PermissionModes: modes, FastMode: &yes},
		{Value: "claude-sonnet-5-5", Label: "Sonnet 5.5", ContextWindow: 1000000, PermissionModes: modes, FastMode: &no},
		{Value: "claude-haiku-5-5", Label: "Haiku 5.5", ContextWindow: 200000, PermissionModes: modes, FastMode: &no},
		{Value: "claude-fable-5-1", Label: "Fable 5.1", ContextWindow: 400000, PermissionModes: modes, FastMode: &no},
	}
	levels := []string{"minimal", "low", "medium", "high", "xhigh"}
	var codex []model
	for _, name := range []string{"gpt-5.5-codex", "gpt-5.5", "gpt-5.5-mini", "gpt-5.4-codex", "gpt-5.4", "o5-pro"} {
		codex = append(codex, model{Value: name, Label: strings.ToUpper(name[:1]) + name[1:], ContextWindow: 400000,
			ReasoningLevels: levels, DefaultReasoningLevel: "medium", PermissionModes: []string{"default", "auto"}})
	}
	type command struct {
		Name        string `json:"name"`
		Description string `json:"description,omitempty"`
		Type        string `json:"type,omitempty"`
		Builtin     bool   `json:"builtin,omitempty"`
	}
	var commands, skills []command
	for i, name := range []string{"review", "commit", "release-notes", "triage", "deploy-check", "fix-lint", "bench",
		"explain", "test-plan", "migrate", "changelog", "security-review", "init", "simplify", "pr"} {
		commands = append(commands, command{Name: name, Type: "command", Builtin: i%3 == 0,
			Description: fmt.Sprintf("Run the %s workflow over the current changes and report what it found", name)})
	}
	for _, name := range []string{"dataviz", "pdf", "spreadsheet", "slides", "api-client", "sql", "docker", "k8s",
		"terraform", "frontend-design"} {
		skills = append(skills, command{Name: name, Type: "skill",
			Description: fmt.Sprintf("Use when the task involves %s: conventions, pitfalls and a worked example", name)})
	}
	type update struct {
		Status string `json:"status"`
		At     string `json:"at"`
		OkAt   string `json:"okAt,omitempty"`
	}
	type account struct {
		ID   string `json:"id"`
		Auth string `json:"auth"`
	}
	type engine struct {
		Engine    string    `json:"engine"`
		Installed bool      `json:"installed"`
		Version   string    `json:"version,omitempty"`
		Auth      string    `json:"auth"`
		Update    *update   `json:"update,omitempty"`
		Accounts  []account `json:"accounts,omitempty"`
	}
	checked := &update{Status: "checked", At: "2026-10-25T09:00:00Z", OkAt: "2026-10-25T09:00:00Z"}
	engines := []engine{
		{Engine: "claude", Installed: true, Version: "2.3.0 (Claude Code)", Auth: "yes", Update: checked},
		{Engine: "codex", Installed: true, Version: "codex-cli 0.164.0", Auth: "yes", Update: checked,
			Accounts: []account{{ID: "default", Auth: "yes"}}},
		{Engine: "kimi", Installed: false, Auth: "unknown"},
		{Engine: "opencode", Installed: false, Auth: "unknown"},
	}
	return []*linkpb.Fact{
		fact("engines", engines),
		fact("modelCatalog", map[string]any{"claude": claude, "codex": codex}),
		fact("commands", commands),
		fact("skills", skills),
		fact("runtimeDefaultModels", map[string]string{"claude": "claude-opus-5-5", "codex": "gpt-5.5-codex"}),
		fact("runsAsRoot", false),
	}
}

// runnerFacts are a runner's heartbeat parts: the shared ones and those naming its own machine.
func runnerFacts(n int) []*linkpb.Fact {
	home := fmt.Sprintf("/home/u%05d", n)
	own := []*linkpb.Fact{
		fact("reposRoot", home+"/orbit-repos"),
		fact("selfUpdate", map[string]string{"state": "enabled", "installDir": home + "/.local/bin"}),
		fact("repos", []map[string]any{{"root": home + "/src/app", "branch": "main", "state": "clean"}}),
	}
	return append(append([]*linkpb.Fact{}, sharedFacts...), own...)
}

// digestsOf is the same parts by digest alone, as a runner sends them once the gateway holds them.
func digestsOf(facts []*linkpb.Fact) []*linkpb.Fact {
	out := make([]*linkpb.Fact, len(facts))
	for i, f := range facts {
		out[i] = &linkpb.Fact{Kind: f.GetKind(), Sha256: f.GetSha256()}
	}
	return out
}

// words are what synthetic text is made of: prose-like, so it compresses as an engine's text does.
var words = strings.Fields(`the a to of and in is that for it with as on be this by are from at an or not can which we
have will if has all but more one their there file test function value error change run build return when then each
other into only also new should would code session runner event batch link gateway route heartbeat seq acknowledged
stored database index query latency commit lease token connection credit drain hint read write state branch merge
review check package module config handler request response server client retry timeout because so now first next
last line output input path directory command result failed passed update create delete list type field struct`)

func text(r *rand.Rand, n int) string {
	var b strings.Builder
	b.Grow(n + 16)
	for b.Len() < n {
		if b.Len() > 0 {
			if r.IntN(12) == 0 {
				b.WriteString(". ")
			} else {
				b.WriteByte(' ')
			}
		}
		b.WriteString(words[r.IntN(len(words))])
	}
	return b.String()
}

func between(r *rand.Rand, lo, hi int) int { return lo + r.IntN(hi-lo+1) }

// The event cycle each active session streams: an engine's step is a thought, a message, a tool call and its result.
// The result is a boundary event: a runner sends its batch at once rather than at the next 1–3 s flush (§5.8).
var cycle = []string{"thinking", "assistant", "tool_use", "tool_result"}

// stepsPerTurn is how many steps share a turn id before the session moves to the next turn.
const stepsPerTurn = 12

// nextEvent is the session's next durable event, and whether it is a boundary. ts is the event's time.
func (s *session) nextEvent(r *rand.Rand, tsUnixMs int64) (*linkpb.Event, bool) {
	kind := cycle[s.step%len(cycle)]
	if s.step%(len(cycle)*stepsPerTurn) == 0 {
		s.turn = newUUID(r)
	}
	if kind == "tool_use" {
		s.toolUse = "toolu_" + randomID(r, 24)
	}
	s.step++
	var payload any
	switch kind {
	case "thinking":
		payload = map[string]any{"text": text(r, between(r, 200, 800))}
	case "assistant":
		payload = map[string]any{"text": text(r, between(r, 100, 600))}
	case "tool_use":
		payload = map[string]any{"id": s.toolUse, "name": "Bash", "input": map[string]string{
			"command": "cd /home/user/src/app && " + text(r, between(r, 40, 160)), "description": text(r, between(r, 20, 50)),
		}}
	case "tool_result":
		size := between(r, 200, 1500)
		if r.IntN(100) < 15 {
			size = between(r, 1500, 8000)
		}
		payload = map[string]any{"toolUseId": s.toolUse, "content": text(r, size), "isError": r.IntN(50) == 0}
	}
	b, err := json.Marshal(payload)
	if err != nil {
		panic(err)
	}
	s.seq++
	return &linkpb.Event{Seq: s.seq, Type: kind, TsUnixMs: tsUnixMs, TurnId: s.turn, PayloadJson: b}, kind == "tool_result"
}

const idAlphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

func randomID(r *rand.Rand, n int) string {
	b := make([]byte, n)
	for i := range b {
		b[i] = idAlphabet[r.IntN(len(idAlphabet))]
	}
	return string(b)
}

func newUUID(r *rand.Rand) string {
	var b [16]byte
	for i := 0; i < 16; i += 8 {
		v := r.Uint64()
		for j := 0; j < 8; j++ {
			b[i+j] = byte(v >> (8 * j))
		}
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}
