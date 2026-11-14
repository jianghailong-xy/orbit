package main

import (
	"encoding/json"
	"sort"
	"strings"
	"sync"
	"time"
)

// The Agent Tools report: what one session's engine was actually given and actually took from Orbit — its
// MCP connection as the engine itself reports it, the tools it lists by family and why any family is short,
// the versions of the contract, catalogue, primer and guide it runs under, the switches it was spawned with,
// how Orbit's runtime instructions reached it, and whether it took the playbooks skill (contract §2.7).
//
// The runner sends it as one system event, `{"subtype": "agent_tools", "agentTools": <report>}`, which the
// control plane keeps as the session's agentTools (migration 0770) and the clients draw in Agent tools.
// It is sent when the engine says something new about it and not otherwise: Claude Code names its MCP
// servers in the init frame it writes at the start of every turn, and an unchanged report is not sent again.
//
// Where the engine's own word is the source: Claude Code's system/init (`mcp_servers[].status`, the
// `mcp__orbit__*` tools in `tools`, the plugin skills in `skills`), and Codex's app server
// (`mcpServer/startupStatus/updated` for Orbit's server: starting, ready, failed with its error, cancelled).
// Measured on Claude Code 2.1.325 and Codex 0.167.2 on 2026-11-14. The other engines report no MCP connection
// to the runner, and no report is sent for them: Agent tools says so.

// agentToolsReportVersion is the shape of the report. A field removed or changed in meaning is a new version.
const agentToolsReportVersion = 1

// agentToolsEventSubtype is the system event subtype the report travels as.
const agentToolsEventSubtype = "agent_tools"

type agentToolsReport struct {
	V              int                     `json:"v"`
	At             string                  `json:"at"`
	Engine         string                  `json:"engine"`
	EngineVersion  string                  `json:"engineVersion,omitempty"`
	RunnerVersion  string                  `json:"runnerVersion,omitempty"`
	Versions       agentToolsVersions      `json:"versions"`
	MCP            agentToolsMCP           `json:"mcp"`
	Families       []agentToolsFamilyCount `json:"families"`
	Switches       agentToolsSwitches      `json:"switches"`
	PermissionMode string                  `json:"permissionMode,omitempty"`
	Instructions   agentToolsInstructions  `json:"instructions"`
	Skill          agentToolsSkill         `json:"skill"`
}

type agentToolsVersions struct {
	Contract  string `json:"contract"`
	Catalog   string `json:"catalog"`
	Primer    string `json:"primer"`
	Guide     string `json:"guide"`
	Playbooks string `json:"playbooks"`
}

// agentToolsMCP is the engine's own word on Orbit's MCP server. Status is one of agentToolsMCPStatuses;
// Detail is the engine's error text when it gave one; Tools is how many Orbit tools the session has, the
// engine's permission bridge not counted.
type agentToolsMCP struct {
	Status string `json:"status"`
	Detail string `json:"detail,omitempty"`
	Tools  int    `json:"tools"`
}

// agentToolsFamilyCount is one family (agentToolsFamilyDefs): how many of its tools the session has of how
// many the catalogue declares, and, when it has fewer, why (a key of agentToolsSwitchReasons).
type agentToolsFamilyCount struct {
	ID     string `json:"id"`
	Served int    `json:"served"`
	Total  int    `json:"total"`
	Reason string `json:"reason,omitempty"`
}

// agentToolsSwitches are the account's switches as this session's engine was spawned with them.
type agentToolsSwitches struct {
	Orchestration bool `json:"orchestration"`
	Watches       bool `json:"watches"`
	Wiki          bool `json:"wiki"`
}

// agentToolsInstructions is how Orbit's runtime instructions reached the model: the carrier (Claude Code's
// appended system prompt, or one of Codex's three), and whether the workspace replaces the engine's own
// prompt or adds runtime instructions of its own, and how long they are.
type agentToolsInstructions struct {
	Carrier        string `json:"carrier"`
	Base           bool   `json:"base,omitempty"`
	Workspace      bool   `json:"workspace,omitempty"`
	WorkspaceChars int    `json:"workspaceChars,omitempty"`
}

// agentToolsSkill is the playbooks skill on this session: offered by the runner, and taken by the engine
// when it says so (Loaded is absent when the engine does not say).
type agentToolsSkill struct {
	Name    string `json:"name"`
	Offered bool   `json:"offered"`
	Loaded  *bool  `json:"loaded,omitempty"`
	Reason  string `json:"reason,omitempty"`
}

// The carriers Orbit's runtime instructions travel by: Claude Code's --append-system-prompt, and Codex's
// application context, one developer message, or the turn's own input (codexInstructionMode).
const (
	carrierAppendSystemPrompt = "append_system_prompt"
	carrierAdditionalContext  = "additional_context"
	carrierDeveloperMessage   = "developer_message"
	carrierTurnInput          = "turn_input"
)

func codexInstructionCarrier(mode codexInstructionMode) string {
	switch mode {
	case codexInstructionsAdditionalContext:
		return carrierAdditionalContext
	case codexInstructionsInjectItems:
		return carrierDeveloperMessage
	default:
		return carrierTurnInput
	}
}

// newAgentToolsReport is the report as the runner knows it before the engine has said anything: the
// versions, the switches and the instructions this spawn was given, and an MCP server still starting.
func newAgentToolsReport(job *ClaimedSession, engine, carrier string) *agentToolsReport {
	r := &agentToolsReport{
		V:             agentToolsReportVersion,
		Engine:        engine,
		RunnerVersion: version,
		Versions: agentToolsVersions{
			Contract:  agentContractVersion,
			Catalog:   operationCatalogVersion,
			Primer:    agentPrimerVersion,
			Guide:     agentGuideVersion,
			Playbooks: agentToolsGuideVersion,
		},
		MCP: agentToolsMCP{Status: "starting"},
	}
	if job != nil {
		r.Switches = agentToolsSwitches{Orchestration: job.AllowOrchestration, Watches: job.watchesOn(), Wiki: !job.WikiDisabled}
		r.PermissionMode = job.Agent.PermissionMode
		workspace := strings.TrimSpace(job.Agent.AppendSystemPrompt)
		r.Instructions = agentToolsInstructions{
			Carrier:        carrier,
			Base:           strings.TrimSpace(job.Agent.SystemPrompt) != "",
			Workspace:      workspace != "",
			WorkspaceChars: len([]rune(workspace)),
		}
	} else {
		r.Instructions = agentToolsInstructions{Carrier: carrier}
	}
	r.countFamilies(nil)
	return r
}

// agentToolsWithheldBy is the switch that keeps op out of a session spawned with sw, or "" when none does.
func agentToolsWithheldBy(op *operation, sw agentToolsSwitches) string {
	if op.Gate == gateOrchestration && !sw.Orchestration {
		return "orchestration"
	}
	if watchToolNames[op.Tool] && !sw.Watches {
		return "watches"
	}
	if wikiToolNames[op.Tool] && !sw.Wiki {
		return "wiki"
	}
	return ""
}

// countFamilies fills the families from what the session has: the engine's own list of Orbit tools when it
// gave one (listed), else what `orbit mcp` serves under the session's switches. Not connected, it has none.
func (r *agentToolsReport) countFamilies(listed map[string]bool) {
	connected := r.MCP.Status == "connected"
	counts := map[string]*agentToolsFamilyCount{}
	reasons := map[string]map[string]int{}
	for _, def := range agentToolsFamilyDefs {
		counts[def.ID] = &agentToolsFamilyCount{ID: def.ID}
		reasons[def.ID] = map[string]int{}
	}
	served := 0
	for _, op := range operationCatalog().Ops {
		family := agentToolsFamilyOf(op)
		if family == "" {
			continue
		}
		c := counts[family]
		c.Total++
		withheld := agentToolsWithheldBy(op, r.Switches)
		has := connected && withheld == ""
		if connected && listed != nil {
			has = listed[op.Tool]
		}
		if has {
			c.Served++
			served++
			continue
		}
		switch {
		case !connected:
			reasons[family]["not_connected"]++
		case withheld != "":
			reasons[family][withheld]++
		}
	}
	r.Families = r.Families[:0]
	for _, def := range agentToolsFamilyDefs {
		c := counts[def.ID]
		c.Reason = mostFrequent(reasons[def.ID])
		r.Families = append(r.Families, *c)
	}
	r.MCP.Tools = served
}

// mostFrequent is the key counted most often, the alphabetically first of a tie, or "" for none.
func mostFrequent(counts map[string]int) string {
	keys := make([]string, 0, len(counts))
	for key := range counts {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	best, n := "", 0
	for _, key := range keys {
		if counts[key] > n {
			best, n = key, counts[key]
		}
	}
	return best
}

// payload is the report as the event carries it.
func (r *agentToolsReport) payload() map[string]interface{} {
	blob, _ := json.Marshal(r)
	var m map[string]interface{}
	_ = json.Unmarshal(blob, &m)
	return map[string]interface{}{"subtype": agentToolsEventSubtype, "agentTools": m}
}

// agentToolsReporter sends a session's report when it changes, and not otherwise.
type agentToolsReporter struct {
	mu   sync.Mutex
	last string
	now  func() time.Time
}

// send emits r unless it says what the last one sent said; the time it was built is not part of what it says.
func (rep *agentToolsReporter) send(r *agentToolsReport, emit emitFn) {
	if r == nil || emit == nil {
		return
	}
	stamp := r.At
	r.At = ""
	blob, _ := json.Marshal(r)
	rep.mu.Lock()
	same := string(blob) == rep.last
	if !same {
		rep.last = string(blob)
	}
	rep.mu.Unlock()
	if same {
		r.At = stamp
		return
	}
	now := time.Now
	if rep.now != nil {
		now = rep.now
	}
	r.At = now().UTC().Format(time.RFC3339)
	emit(evSystem, r.payload())
}

// ── Claude Code ──────────────────────────────────────────────────────────────────────────────────

// claudeManagedPluginFloor is the oldest `claude` Orbit passes --plugin-dir to: the version the plugin's
// skill was measured loading as orbit:playbooks on (2026-11-14), not where the flag began. An older CLI that
// does not know a flag refuses to start at all, so the floor errs high, as claudePromptSuggestionsFloor does.
const claudeManagedPluginFloor = "2.1.325"

// claudeManagedPluginOn reports whether this spawn is given the playbooks plugin.
func claudeManagedPluginOn() bool {
	return claudeVersionAtLeast(claudeSpawnVersion(), claudeManagedPluginFloor)
}

// claudeMCPStatus is Claude Code's status of an MCP server (its init frame's mcp_servers[].status) in the
// report's words.
func claudeMCPStatus(status string) string {
	switch status {
	case "connected":
		return "connected"
	case "pending":
		return "starting"
	case "failed":
		return "failed"
	case "needs-auth":
		return "needs_auth"
	case "":
		return "not_configured"
	}
	return "failed"
}

// claudeAgentToolsReport reads Claude Code's init frame into the session's report: the status it gives
// Orbit's server, the Orbit tools it lists, its version and mode, and whether it took the playbooks.
func claudeAgentToolsReport(job *ClaimedSession, msg map[string]interface{}) *agentToolsReport {
	r := newAgentToolsReport(job, providerClaude, carrierAppendSystemPrompt)
	r.EngineVersion, _ = msg["claude_code_version"].(string)
	if mode, _ := msg["permissionMode"].(string); mode != "" {
		r.PermissionMode = mode
	}
	status := ""
	if servers, ok := msg["mcp_servers"].([]interface{}); ok {
		for _, s := range servers {
			server, _ := s.(map[string]interface{})
			if name, _ := server["name"].(string); name == "orbit" {
				status, _ = server["status"].(string)
				if status == "" {
					status = "unknown"
				}
			}
		}
	}
	r.MCP.Status = claudeMCPStatus(status)
	listed := map[string]bool{}
	prefix := claudeToolName("")
	for _, name := range stringsFromJSON(msg["tools"]) {
		if strings.HasPrefix(name, prefix) {
			listed[strings.TrimPrefix(name, prefix)] = true
		}
	}
	r.countFamilies(listed)
	r.Skill = agentToolsSkill{Name: claudeManagedSkillID, Offered: claudeManagedPluginOn()}
	if r.Skill.Offered {
		loaded := false
		for _, skill := range stringsFromJSON(msg["skills"]) {
			if skill == claudeManagedSkillID {
				loaded = true
			}
		}
		r.Skill.Loaded = &loaded
	} else {
		r.Skill.Reason = "Claude Code " + claudeSpawnVersion() + " is older than " + claudeManagedPluginFloor +
			", the first version Orbit gives the playbooks to."
	}
	return r
}

// ── Codex ────────────────────────────────────────────────────────────────────────────────────────

// codexMCPStatus is Codex's startup state of an MCP server (McpServerStartupState) in the report's words.
func codexMCPStatus(state string) string {
	switch state {
	case "ready":
		return "connected"
	case "starting":
		return "starting"
	case "cancelled":
		return "cancelled"
	}
	return "failed"
}

// codexVersionFromUserAgent is the version an app server's initialize names in its user agent
// ("codex_cli_rs/0.167.2 (Debian 13.0.0; x86_64) ..."), or "".
func codexVersionFromUserAgent(userAgent string) string {
	fields := strings.Fields(userAgent)
	if len(fields) == 0 {
		return ""
	}
	slash := strings.IndexByte(fields[0], '/')
	if slash < 0 || slash == len(fields[0])-1 {
		return ""
	}
	return fields[0][slash+1:]
}

// codexAgentTools is one Codex session's report as its app server speaks: the startup states of Orbit's
// MCP server, the skill root it took or refused, and the carrier its instructions travel by.
type codexAgentTools struct {
	mu       sync.Mutex
	report   *agentToolsReport
	reporter agentToolsReporter
	emit     emitFn
}

func newCodexAgentTools(job *ClaimedSession, app *codexAppServer, emit emitFn) *codexAgentTools {
	r := newAgentToolsReport(job, providerCodex, codexInstructionCarrier(app.currentInstructionMode()))
	r.EngineVersion = app.engineVersion
	r.Skill = agentToolsSkill{Name: codexManagedSkillName}
	return &codexAgentTools{report: r, emit: emit}
}

// skillRoot says how handing Codex the playbooks went: the error its app server answered, or nil.
func (c *codexAgentTools) skillRoot(err error, root string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	switch {
	case root == "":
		c.report.Skill.Reason = "The runner could not write the skill into this session's directory."
	case err != nil:
		c.report.Skill.Reason = "Codex did not take the skill root: " + err.Error()
	default:
		c.report.Skill.Offered = true
	}
}

// mcpStatus records Codex's startup state of Orbit's server and sends the report if it changed.
func (c *codexAgentTools) mcpStatus(state, errText string) {
	c.mu.Lock()
	c.report.MCP.Status = codexMCPStatus(state)
	c.report.MCP.Detail = strings.TrimSpace(errText)
	c.report.countFamilies(nil)
	snapshot := c.snapshot()
	c.mu.Unlock()
	c.reporter.send(snapshot, c.emit)
}

// snapshot is a copy of the report that sending cannot race with; the caller holds mu.
func (c *codexAgentTools) snapshot() *agentToolsReport {
	copied := *c.report
	copied.Families = append([]agentToolsFamilyCount(nil), c.report.Families...)
	return &copied
}

// send sends the report as it stands, if it changed.
func (c *codexAgentTools) send() {
	c.mu.Lock()
	snapshot := c.snapshot()
	c.mu.Unlock()
	c.reporter.send(snapshot, c.emit)
}

// carrier records the carrier Orbit's instructions now travel by (a turn can find inject_items missing and
// fall back to the turn's input) and sends the report if it changed.
func (c *codexAgentTools) carrier(mode codexInstructionMode) {
	c.mu.Lock()
	c.report.Instructions.Carrier = codexInstructionCarrier(mode)
	snapshot := c.snapshot()
	c.mu.Unlock()
	c.reporter.send(snapshot, c.emit)
}
