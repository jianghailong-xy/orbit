package main

import "strings"

// Orbit's agent instructions as a registry of units, composed per session shape and engine
// (docs/agent-instructions-design.md §4.1-4.3). Every carrier -- Claude Code's --append-system-prompt, Codex's
// application context, Kimi's and Cursor's prompts, Antigravity's rules file, DeepSeek Harness's overlay, OpenCode's
// instructions file -- and `orbit mcp` initialize take their text from compose. A unit's text is written once, with
// the spellings that differ per engine as placeholders that the engine's profile renders.

// instructionKind is what decision a unit is about (design §3). Only A and F belong in always-on text.
type instructionKind string

const (
	kindDisposition instructionKind = "A" // choosing Orbit over an engine built-in
	kindSelection   instructionKind = "B" // which Orbit object or tool
	kindMechanics   instructionKind = "C" // how to call a tool
	kindRecovery    instructionKind = "D" // what a result means and what to do next
	kindSituation   instructionKind = "E" // true only for this session or this moment
	kindEnvironment instructionKind = "F" // facts only the runner knows
)

// instructionChannel is where a unit is delivered.
type instructionChannel string

const (
	// channelSystem is the engine's own carrier for Orbit's instructions, whatever form it takes (EngineProfile.Carrier).
	channelSystem instructionChannel = "system"
	// channelMCP is what `orbit mcp` answers initialize with.
	channelMCP instructionChannel = "mcp-initialize"
)

// instructionUnit is one row of the registry.
type instructionUnit struct {
	id    string
	owner string // the feature area, and the tools it covers
	kind  instructionKind
	// appliesTo says which session shapes get the unit.
	appliesTo func(SessionShape) bool
	// channels are where the unit is delivered, in this order of preference.
	channels []instructionChannel
	// core is the text, with {{placeholders}} for what an engine spells its own way (renderInstructionUnit).
	core string
	// tools are the Orbit tools the core names: a session served none of them is not given the unit.
	tools []string
	// detail is where the longer form of the unit lives: a tool description, a receipt note or a guide topic.
	detail string
	// guardedBy are the agent-contract eval cases that fail without the unit.
	guardedBy []string
	// conflicts are units that must not be delivered with this one.
	conflicts []string
}

// sessionRole is what a session is there to do.
type sessionRole string

const (
	roleTopLevel  sessionRole = "top-level"
	roleTaskRun   sessionRole = "task-run"
	roleSubAgent  sessionRole = "subagent"
	roleCheckOnly sessionRole = "scheduled-check-only"
	roleHelpAsk   sessionRole = "help-ask"
	// roleCoordinator is a project's coordinator. The runner cannot tell one from a top-level session yet: the
	// server tells the coordinator its role in the context it attaches to each turn.
	roleCoordinator sessionRole = "coordinator"
)

// SessionShape is what decides which units a session is given.
type SessionShape struct {
	Role sessionRole
	// InsideRecordedWork: the session runs a task Orbit has recorded (insideRecordedWork). True of a task run, and of
	// a SubAgent or a check-only run started inside one.
	InsideRecordedWork bool
	// The switches the session was spawned with.
	Watches       bool
	Browser       bool
	Orchestration bool
	Wiki          bool
	Workflows     bool // the Agent's Workflows switch; the tool is offered only to a session that also delegates
	DriveMounted  bool // the Orbit Files drive is mounted on this runner (driveMounted)
	// Tools is the set of Orbit tools the session is served, by name; nil when the carrier does not know it, and then
	// every unit's tools count as served.
	Tools map[string]bool
	// CLI is the absolute path of the Orbit CLI the session is told to run.
	CLI string
}

// delegates reports whether the session is offered delegate: every one but a SubAgent's.
func (s SessionShape) delegates() bool { return s.Role != roleSubAgent }

func (s SessionShape) serves(tools []string) bool {
	if s.Tools == nil || len(tools) == 0 {
		return true
	}
	for _, tool := range tools {
		if s.Tools[tool] {
			return true
		}
	}
	return false
}

// sessionShape is this claimed session's shape, told to run the CLI at cli.
func (s *ClaimedSession) sessionShape(cli string) SessionShape {
	if s == nil {
		s = &ClaimedSession{}
	}
	role := roleTopLevel
	switch {
	case !agentDelegates(s.Agent):
		role = roleSubAgent
	case s.Agent.ScheduledCheckOnly:
		role = roleCheckOnly
	case s.TaskID != "":
		role = roleTaskRun
	}
	return SessionShape{
		Role:               role,
		InsideRecordedWork: s.insideRecordedWork(),
		Watches:            s.watchesOn(),
		Browser:            s.BrowserEnabled,
		Orchestration:      s.AllowOrchestration,
		Wiki:               !s.WikiDisabled,
		Workflows:          s.workflowsOn(),
		DriveMounted:       driveMounted(),
		CLI:                cli,
	}
}

// probe is an engine fact as far as it has been measured.
type probe string

const (
	probeYes     probe = "yes"
	probeNo      probe = "no"
	probeUnknown probe = "unknown"
)

// mcpInstructionsVisibility is how much of `orbit mcp`'s initialize instructions an engine shows its model.
type mcpInstructionsVisibility string

const (
	mcpInstructionsWhole   mcpInstructionsVisibility = "whole"
	mcpInstructionsHead    mcpInstructionsVisibility = "head"
	mcpInstructionsNone    mcpInstructionsVisibility = "none"
	mcpInstructionsUnknown mcpInstructionsVisibility = "unknown"
)

// toolDescriptionLoading is whether an engine shows Orbit's tool descriptions up front or only once a tool is loaded.
type toolDescriptionLoading string

const (
	toolDescriptionsEager    toolDescriptionLoading = "eager"
	toolDescriptionsDeferred toolDescriptionLoading = "deferred"
	toolDescriptionsUnknown  toolDescriptionLoading = "unknown"
)

// instructionCarrier is how an engine is given Orbit's channelSystem text.
type instructionCarrier string

const (
	carrierSystemPrompt instructionCarrier = "system-prompt" // once, in the system prompt or its equivalent
	carrierPerTurn      instructionCarrier = "per-turn"      // context the engine is given again each turn
	carrierEveryPrompt  instructionCarrier = "every-prompt"  // written into every prompt
	carrierFirstPrompt  instructionCarrier = "first-prompt"  // ahead of the conversation's first prompt
)

// EngineProfile is what Orbit knows about one engine's handling of its instructions. A value not measured yet is
// the conservative one, which is what the runner did before profiles existed.
type EngineProfile struct {
	Engine string
	// MCPInstructions is how much of the initialize instructions the engine shows.
	MCPInstructions mcpInstructionsVisibility
	// ToolDescriptions is whether tool descriptions are eager or deferred.
	ToolDescriptions toolDescriptionLoading
	// AlwaysLoad is whether the engine honours a tool's alwaysLoad mark.
	AlwaysLoad probe
	// Carrier is how the engine is given channelSystem text.
	Carrier instructionCarrier
	// SurvivesCompaction is whether that text is still in front of the model after a compaction.
	SurvivesCompaction probe
	// ValueCapBytes is the most one carrier value holds (0: no cap); longer text is split into values.
	ValueCapBytes int
	// ResetNote is whether the engine's next message carries Orbit's note after a compaction or resume
	// (context_reset_note.go).
	ResetNote bool
	// OrbitTools renders {{orbit_tools}}: how the text names Orbit's MCP tools as a family.
	OrbitTools string
	// ToolSearchNotes renders {{toolsearch:<tool>}}: whether the text keeps its sentence on loading a deferred tool
	// with Claude Code's ToolSearch.
	ToolSearchNotes bool
}

var (
	claudeCodeProfile = EngineProfile{
		Engine:             providerClaude,
		MCPInstructions:    mcpInstructionsWhole,
		ToolDescriptions:   toolDescriptionsDeferred, // behind ToolSearch
		AlwaysLoad:         probeUnknown,
		Carrier:            carrierSystemPrompt, // --append-system-prompt
		SurvivesCompaction: probeYes,            // the appended prompt stays and the MCP instructions are attached again
		ResetNote:          true,
		OrbitTools:         "the `mcp__orbit__*` tools",
		ToolSearchNotes:    true,
	}
	codexProfile = EngineProfile{
		Engine:             providerCodex,
		MCPInstructions:    mcpInstructionsHead, // the first 250 characters
		ToolDescriptions:   toolDescriptionsUnknown,
		AlwaysLoad:         probeUnknown,
		Carrier:            carrierPerTurn, // application context (or a developer message, or the turn input)
		SurvivesCompaction: probeNo,        // given again in a new context generation (codexNotificationCompacted)
		ValueCapBytes:      codexContextValueMaxBytes,
		ResetNote:          true,
		OrbitTools:         "the `mcp__orbit__*` tools",
		ToolSearchNotes:    true,
	}
	kimiProfile = EngineProfile{
		Engine:             providerKimi,
		MCPInstructions:    mcpInstructionsUnknown,
		ToolDescriptions:   toolDescriptionsUnknown,
		AlwaysLoad:         probeUnknown,
		Carrier:            carrierEveryPrompt, // kimiPromptText
		SurvivesCompaction: probeUnknown,
		OrbitTools:         "the `mcp__orbit__*` tools",
		ToolSearchNotes:    true,
	}
	cursorProfile = EngineProfile{
		Engine:             providerCursor,
		MCPInstructions:    mcpInstructionsUnknown,
		ToolDescriptions:   toolDescriptionsUnknown,
		AlwaysLoad:         probeUnknown,
		Carrier:            carrierFirstPrompt, // no user-level rules file reaches the model (cursorAgentInstructions)
		SurvivesCompaction: probeUnknown,
		// Cursor shows a server's tools rather than mcp__orbit__* names, so no ToolSearch sentence either.
		OrbitTools:      "the tools of the `orbit` MCP server",
		ToolSearchNotes: false,
	}
	antigravityProfile = EngineProfile{
		Engine:             providerAntigravity,
		MCPInstructions:    mcpInstructionsUnknown,
		ToolDescriptions:   toolDescriptionsUnknown,
		AlwaysLoad:         probeUnknown,
		Carrier:            carrierSystemPrompt, // the global rules file, in agy's system instruction
		SurvivesCompaction: probeUnknown,
		// agy reaches an MCP tool through its generic call_mcp_tool rather than by the tool's own name.
		OrbitTools:      "the tools of the `orbit` MCP server (call_mcp_tool with ServerName \"orbit\")",
		ToolSearchNotes: true,
	}
	dshProfile = EngineProfile{
		Engine:             providerDsh,
		MCPInstructions:    mcpInstructionsUnknown,
		ToolDescriptions:   toolDescriptionsUnknown,
		AlwaysLoad:         probeUnknown,
		Carrier:            carrierSystemPrompt, // the agent overlay's appended system prompt
		SurvivesCompaction: probeUnknown,
		OrbitTools:         "the `mcp__orbit__*` tools",
		ToolSearchNotes:    true,
	}
	openCodeProfile = EngineProfile{
		Engine:             providerOpenCode,
		MCPInstructions:    mcpInstructionsUnknown,
		ToolDescriptions:   toolDescriptionsUnknown,
		AlwaysLoad:         probeUnknown,
		Carrier:            carrierSystemPrompt, // the instructions file in its config
		SurvivesCompaction: probeUnknown,
		OrbitTools:         "the `orbit_*` tools", // OpenCode names a server's tools <server>_<tool>
		ToolSearchNotes:    true,
	}
	// unknownEngineProfile is for a reader that cannot tell which engine it serves: `orbit mcp`.
	unknownEngineProfile = EngineProfile{
		Engine:             "",
		MCPInstructions:    mcpInstructionsUnknown,
		ToolDescriptions:   toolDescriptionsUnknown,
		AlwaysLoad:         probeUnknown,
		Carrier:            carrierSystemPrompt,
		SurvivesCompaction: probeUnknown,
		OrbitTools:         "the `mcp__orbit__*` tools",
		ToolSearchNotes:    true,
	}
)

// engineProfiles is every engine's profile, one per engine carrier.
var engineProfiles = []EngineProfile{claudeCodeProfile, codexProfile, kimiProfile, cursorProfile, antigravityProfile, dshProfile, openCodeProfile}

// orbitSession is every shape but a help-center Ask's, which is served the help reads and nothing else.
func orbitSession(s SessionShape) bool { return s.Role != roleHelpAsk }

var bothChannels = []instructionChannel{channelSystem, channelMCP}

// instructionUnits is the registry, in the order the units are composed.
var instructionUnits = []instructionUnit{
	{id: "primer.lead", owner: "primer: task_create, task_create_batch, project_create", kind: kindDisposition,
		appliesTo: orbitSession, channels: bothChannels, core: agentPrimerLead,
		detail: "guide", guardedBy: []string{"E1-record-task", "E2-private-plan"}},
	{id: "primer.objects", owner: "primer: guide", kind: kindSelection,
		appliesTo: orbitSession, channels: bothChannels, core: agentPrimerObjects,
		detail: "guide", guardedBy: []string{"E4-batch-plan"}},
	{id: "primer.start", owner: "primer: task_start, task_create", kind: kindSelection,
		appliesTo: orbitSession, channels: bothChannels, core: agentPrimerStart,
		detail: "task_create and task_start descriptions", guardedBy: []string{"E3-create-no-start"}},
	{id: "primer.cards", owner: "primer: approvals", kind: kindRecovery,
		appliesTo: orbitSession, channels: bothChannels, core: agentPrimerCards,
		detail: "receipt approval notes", guardedBy: []string{"X2-approval-declined", "X3-approval-chat"}},
	{id: "primer.cli", owner: "primer: the Orbit CLI", kind: kindDisposition,
		appliesTo: orbitSession, channels: bothChannels, core: agentPrimerCLI,
		detail: "capabilities --json", guardedBy: []string{"X1-mcp-missing-cli-fallback"}},
	{id: "primer.receipts", owner: "primer: receipts, references", kind: kindRecovery,
		appliesTo: orbitSession, channels: bothChannels, core: agentPrimerReceipts,
		detail: "receipt error.retry", guardedBy: []string{"X4-lost-answer-retry"}},
	{id: "primer.orchestration", owner: "primer: session orchestration", kind: kindSituation,
		appliesTo: orbitSession, channels: bothChannels, core: agentPrimerOrchestration,
		detail: "guide", guardedBy: []string{"E7-no-orchestration"}},
	{id: "primer.settings", owner: "primer: settings_get, settings_propose", kind: kindSelection,
		appliesTo: orbitSession, channels: bothChannels, core: agentPrimerSettings,
		detail: "settings_propose description", guardedBy: []string{"I8-settings-propose"}},
	{id: "primer.rederive", owner: "primer: task_get after a reset", kind: kindSituation,
		appliesTo: orbitSession, channels: bothChannels, core: agentPrimerRederive,
		detail: "context reset note (context_reset_note.go)", guardedBy: []string{"E8-compaction-recovery"}},
	{id: "help.ask", owner: "help center Ask: the help reads", kind: kindEnvironment,
		appliesTo: func(s SessionShape) bool { return s.Role == roleHelpAsk }, channels: []instructionChannel{channelMCP},
		core: helpAskInstructions, detail: "help tool descriptions"},

	{id: "subagent.engine-private", owner: "delegation: task_list, task_start, task_create, session_create", kind: kindDisposition,
		appliesTo: orbitSession, channels: []instructionChannel{channelSystem}, core: orbitSubAgentInstructions,
		detail: "guide", guardedBy: []string{"E6-immediate-delegation", "E7-no-orchestration"}},
	{id: "files.reply-links", owner: "reply attachments", kind: kindEnvironment,
		appliesTo: orbitSession, channels: []instructionChannel{channelSystem}, core: orbitReplyFileInstructions,
		detail: "guide topic files", guardedBy: []string{"I4-reply-file-link"}},
	{id: "files.evidence", owner: "evidence files: file_upload", kind: kindDisposition,
		appliesTo: orbitSession, channels: []instructionChannel{channelSystem}, core: orbitEvidenceFileInstructions,
		tools: []string{"file_upload"}, detail: "file_upload description", guardedBy: []string{"I5-evidence-file-upload"}},
	{id: "drive.tools", owner: "Documents drive: documents_*", kind: kindEnvironment,
		appliesTo: func(s SessionShape) bool { return orbitSession(s) && orbitDocumentsShown() && !s.DriveMounted }, channels: []instructionChannel{channelSystem},
		core: orbitDriveToolInstructions, detail: "guide topic files (orbitDriveGuide)", conflicts: []string{"drive.mount"}},
	{id: "drive.mount", owner: "Documents drive: ~/Documents", kind: kindEnvironment,
		appliesTo: func(s SessionShape) bool { return orbitSession(s) && orbitDocumentsShown() && s.DriveMounted }, channels: []instructionChannel{channelSystem},
		core: orbitDriveMountInstructions, detail: "guide topic files (orbitDriveGuide)", conflicts: []string{"drive.tools"}},
	{id: "project.inside-recorded-work", owner: "projects: task_create, project_create", kind: kindSelection,
		appliesTo: func(s SessionShape) bool { return orbitSession(s) && s.InsideRecordedWork }, channels: []instructionChannel{channelSystem},
		core: orbitProjectInsideInstructions, detail: "project_create description", conflicts: []string{"project.propose"}},
	{id: "project.propose", owner: "projects: project_create", kind: kindSelection,
		appliesTo: func(s SessionShape) bool { return orbitSession(s) && !s.InsideRecordedWork }, channels: []instructionChannel{channelSystem},
		core: orbitProjectProposeInstructions, detail: "project_create description", guardedBy: []string{"I9-no-project-for-ordinary-work"}, conflicts: []string{"project.inside-recorded-work"}},
	{id: "progress.report", owner: "progress: task_progress_report", kind: kindDisposition,
		appliesTo: func(s SessionShape) bool { return orbitSession(s) && s.InsideRecordedWork }, channels: []instructionChannel{channelSystem},
		core: orbitProgressInstructions, tools: []string{"task_progress_report"}, detail: "task_progress_report description", guardedBy: []string{"I6-progress-report"}},
	{id: "wait.use-await", owner: "watches: task_await, session_await, watch_create", kind: kindDisposition,
		appliesTo: func(s SessionShape) bool { return orbitSession(s) && s.Watches }, channels: []instructionChannel{channelSystem},
		core: orbitWaitInstructions, tools: []string{"task_await", "session_await", "watch_create"}, detail: "task_await description", guardedBy: []string{"I1-wait-await"}},
	{id: "notify.when-asked", owner: "notify", kind: kindDisposition,
		appliesTo: orbitSession, channels: []instructionChannel{channelSystem}, core: orbitNotifyInstructions,
		tools: []string{"notify"}, detail: "notify description", guardedBy: []string{"I2-notify-when-done"}},
	{id: "delegate.use-delegate", owner: "SubAgents: delegate", kind: kindDisposition,
		appliesTo: func(s SessionShape) bool { return orbitSession(s) && s.delegates() }, channels: []instructionChannel{channelSystem},
		core: orbitDelegateInstructions, tools: []string{"delegate"}, detail: "delegate description",
		guardedBy: []string{"I3-delegate-subagent", "I3-delegate-subagent/background"}},
	{id: "workflow.use-workflow", owner: "SubAgents: workflow", kind: kindDisposition,
		appliesTo: func(s SessionShape) bool { return orbitSession(s) && s.delegates() && s.Workflows }, channels: []instructionChannel{channelSystem},
		core: orbitWorkflowInstructions, tools: []string{"workflow"}, detail: "workflow description"},
	{id: "wiki.search-by-path", owner: "wiki: wiki_search", kind: kindSelection,
		appliesTo: orbitSession, channels: []instructionChannel{channelSystem}, core: orbitWikiPathInstructions,
		tools: []string{"wiki_search"}, detail: "wiki_search description", guardedBy: []string{"I7-wiki-path-search"}},
	{id: "cli.prefer-mcp", owner: "the Orbit CLI: guide, capabilities", kind: kindEnvironment,
		appliesTo: orbitSession, channels: []instructionChannel{channelSystem}, core: orbitCLIPreferMCPInstructions,
		detail: "capabilities --json", guardedBy: []string{"X1-mcp-missing-cli-fallback"}},
}

// composedInstructions is what compose gives a session on one engine.
type composedInstructions struct {
	// System is the engine carrier's text; "" when the session has no CLI path that is safe to print.
	System string
	// MCP is what `orbit mcp` answers initialize with.
	MCP string
}

// compose renders the registry for one session shape on one engine: each unit that applies to the shape and names a
// tool it is served, on each channel it is delivered on, paragraphs separated by a blank line.
func compose(shape SessionShape, profile EngineProfile) composedInstructions {
	composed := composedInstructions{MCP: composeChannel(shape, profile, channelMCP)}
	// The CLI path is printed into the text, so a path that could change its meaning gets no text at all.
	if shape.CLI = orbitCLIInstructionExecutable(shape.CLI); shape.CLI != "" {
		composed.System = composeChannel(shape, profile, channelSystem)
	}
	return composed
}

// instructionUnitsLeftOut is the units, by id, this process leaves out of everything it composes. Only the
// agent-contract eval's test binary sets it (--leave-out, agent_eval_leave_out_test.go), to measure what a unit is
// worth by the scenario that guards it; it is nil in every production process, where every unit is composed.
var instructionUnitsLeftOut map[string]bool

func composeChannel(shape SessionShape, profile EngineProfile, channel instructionChannel) string {
	var paragraphs []string
	for _, unit := range instructionUnits {
		if instructionUnitsLeftOut[unit.id] {
			continue
		}
		if unit.deliveredOn(channel) && unit.appliesTo(shape) && shape.serves(unit.tools) {
			paragraphs = append(paragraphs, renderInstructionUnit(unit.core, shape, profile))
		}
	}
	return strings.Join(paragraphs, "\n\n")
}

func (u instructionUnit) deliveredOn(channel instructionChannel) bool {
	for _, c := range u.channels {
		if c == channel {
			return true
		}
	}
	return false
}

// renderInstructionUnit fills a unit's placeholders in the engine's spelling:
//
//	{{cli}}              the shell-quoted path of the Orbit CLI
//	{{orbit_tools}}      Orbit's MCP tools as a family (EngineProfile.OrbitTools)
//	{{toolsearch:<tool>}} the sentence on loading a deferred tool with ToolSearch, or nothing (EngineProfile.ToolSearchNotes)
//	{{drive_root}}       the Documents mount's directory on this machine (driveParentPath)
//
// A placeholder it does not know is left as it is, which TestEveryUnitRendersOnEveryEngine catches.
func renderInstructionUnit(core string, shape SessionShape, profile EngineProfile) string {
	var b strings.Builder
	for {
		start := strings.Index(core, "{{")
		if start < 0 {
			break
		}
		end := strings.Index(core[start:], "}}")
		if end < 0 {
			break
		}
		b.WriteString(core[:start])
		name := core[start+2 : start+end]
		switch {
		case name == "cli":
			b.WriteString(shellQuote(shape.CLI))
		case name == "orbit_tools":
			b.WriteString(profile.OrbitTools)
		case name == "drive_root":
			b.WriteString(driveParentPath)
		case strings.HasPrefix(name, "toolsearch:"):
			if profile.ToolSearchNotes {
				b.WriteString(" In Claude Code, if it is deferred, load it with ToolSearch select:mcp__orbit__" +
					strings.TrimPrefix(name, "toolsearch:") + ".")
			}
		default:
			b.WriteString(core[start : start+end+2])
		}
		core = core[start+end+2:]
	}
	b.WriteString(core)
	return b.String()
}

// withOrbitInstructions is configured, the agent's own appended text, followed by Orbit's.
func withOrbitInstructions(configured, orbit string) string {
	if orbit == "" {
		return configured
	}
	if strings.TrimSpace(configured) == "" {
		return orbit
	}
	return strings.TrimRight(configured, "\r\n") + "\n\n" + orbit
}
