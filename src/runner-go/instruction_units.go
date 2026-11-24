package main

// Instruction units: the paragraphs of what the runner tells an agent (the primer, agent_primer.go, and the paragraphs
// orbitCLIInstructions adds after it), each under a stable id. The id is how the agent-contract eval names a paragraph
// it runs without (docs/agent-contract-eval.md §Leaving a unit out), so that what a paragraph is worth is measured by
// the scenario that guards it failing more often when it is gone (docs/agent-instructions-design.md §6, step 0).

// The primer's paragraphs.
const (
	unitPrimerLead          = "primer.lead"
	unitPrimerObjects       = "primer.objects"
	unitPrimerStart         = "primer.start"
	unitPrimerCards         = "primer.cards"
	unitPrimerCLI           = "primer.cli"
	unitPrimerReceipts      = "primer.receipts"
	unitPrimerOrchestration = "primer.orchestration"
	unitPrimerSettings      = "primer.settings"
	unitPrimerRederive      = "primer.rederive"
)

// The paragraphs orbitCLIInstructions adds after the primer, in the order it adds them.
const (
	unitSubAgents     = "subagents"
	unitReplyFiles    = "reply-files"
	unitEvidenceFiles = "evidence-files"
	unitDrive         = "drive"
	unitProject       = "project"
	unitProgress      = "progress"
	unitWait          = "wait"
	unitNotify        = "notify"
	unitDelegate      = "delegate"
	unitWorkflow      = "workflow"
	unitWikiPath      = "wiki"
	unitCLI           = "cli"
)

// instructionUnitIDs is every unit, in the order an engine's instructions carry them.
var instructionUnitIDs = []string{
	unitPrimerLead, unitPrimerObjects, unitPrimerStart, unitPrimerCards, unitPrimerCLI, unitPrimerReceipts,
	unitPrimerOrchestration, unitPrimerSettings, unitPrimerRederive,
	unitSubAgents, unitReplyFiles, unitEvidenceFiles, unitDrive, unitProject, unitProgress, unitWait, unitNotify,
	unitDelegate, unitWorkflow, unitWikiPath, unitCLI,
}

// instructionUnitsLeftOut is the units this process leaves out of everything it tells an agent. Only the
// agent-contract eval's test binary sets it (agent_eval_leave_out_test.go); it is nil in every production process,
// where every unit is sent and the text is byte for byte what it was before units had ids.
var instructionUnitsLeftOut map[string]bool

// instructionUnit is text, or "" when the eval left the unit id out.
func instructionUnit(id, text string) string {
	if instructionUnitsLeftOut[id] {
		return ""
	}
	return text
}
