package main

// Test helpers that name a session shape by the four facts the instructions turned on before the unit registry:
// whether the session runs a recorded task, has Watch on, is offered delegate (is not a SubAgent) and has Workflows on.

// testShape is that shape, told to run the CLI at exe, on a runner whose drive is as driveMounted says.
func testShape(exe string, insideRecordedWork, watches, delegates, workflows bool) SessionShape {
	role := roleTopLevel
	switch {
	case !delegates:
		role = roleSubAgent
	case insideRecordedWork:
		role = roleTaskRun
	}
	return SessionShape{Role: role, InsideRecordedWork: insideRecordedWork, Watches: watches, Wiki: true,
		Workflows: workflows, DriveMounted: driveMounted(), CLI: exe}
}

// orbitCLIInstructions is Orbit's own instructions for that shape, in Claude Code's spelling.
func orbitCLIInstructions(exe string, insideRecordedWork, watches, delegates, workflows bool) string {
	return compose(testShape(exe, insideRecordedWork, watches, delegates, workflows), claudeCodeProfile).System
}

// withOrbitCLIInstructions is configured followed by orbitCLIInstructions.
func withOrbitCLIInstructions(configured, exe string, insideRecordedWork, watches, delegates, workflows bool) string {
	return withOrbitInstructions(configured, orbitCLIInstructions(exe, insideRecordedWork, watches, delegates, workflows))
}

// The ToolSearch sentences of the delegate and workflow paragraphs, as every engine but Cursor is given them.
var (
	orbitDelegateClaudeCodeLoad = renderInstructionUnit("{{toolsearch:delegate}}", SessionShape{}, claudeCodeProfile)
	orbitWorkflowClaudeCodeLoad = renderInstructionUnit("{{toolsearch:workflow}}", SessionShape{}, claudeCodeProfile)
)

// agentShape is testShape for a session run with agent: a SubAgent's agent is not offered delegate.
func agentShape(agent AgentExecConfig, exe string, insideRecordedWork, watches, workflows bool) SessionShape {
	return testShape(exe, insideRecordedWork, watches, agentDelegates(agent), workflows)
}

// The carriers, called with the positional facts the tests name shapes by.

func claudeInstructionArgs(args []string, agent AgentExecConfig, exe string, orchestration, insideRecordedWork, watches, browser, workflows bool) []string {
	shape := agentShape(agent, exe, insideRecordedWork, watches, workflows)
	shape.Orchestration, shape.Browser = orchestration, browser
	return appendClaudeAgentInstructionArgs(args, agent, shape)
}

func codexAgentContextOf(agent AgentExecConfig, exe string, insideRecordedWork, watches, workflows bool) string {
	return codexAgentContext(agent, agentShape(agent, exe, insideRecordedWork, watches, workflows))
}

func codexInjectedAgentItemsOf(agent AgentExecConfig, exe string, insideRecordedWork, watches, workflows bool) []map[string]interface{} {
	return codexInjectedAgentItems(agent, agentShape(agent, exe, insideRecordedWork, watches, workflows))
}

func codexAgentAdditionalContextOf(agent AgentExecConfig, exe string, generation uint64, insideRecordedWork, watches, workflows bool) map[string]interface{} {
	return codexAgentAdditionalContext(agent, agentShape(agent, exe, insideRecordedWork, watches, workflows), generation)
}

func codexLegacyAgentContextOf(agent AgentExecConfig, exe string, insideRecordedWork, watches, workflows bool) string {
	return codexLegacyAgentContext(agent, agentShape(agent, exe, insideRecordedWork, watches, workflows))
}

func kimiAgentInstructionsOf(agent AgentExecConfig, exe string, insideRecordedWork, watches, workflows bool) string {
	return kimiAgentInstructions(agent, agentShape(agent, exe, insideRecordedWork, watches, workflows))
}

func kimiPromptTextOf(agent AgentExecConfig, exe, text string, insideRecordedWork, watches, workflows bool) string {
	return kimiPromptText(agent, agentShape(agent, exe, insideRecordedWork, watches, workflows), text)
}

// openCodeOrbitCLIInstructions is Orbit's own instructions for that shape, as OpenCode is given them.
func openCodeOrbitCLIInstructions(exe string, insideRecordedWork, watches, delegates, workflows bool) string {
	return compose(testShape(exe, insideRecordedWork, watches, delegates, workflows), openCodeProfile).System
}
