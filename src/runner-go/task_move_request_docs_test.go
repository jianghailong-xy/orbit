package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// A move of a task that already exists is a REQUEST that the account owner's confirmation applies
// (2026-10-06): `task_update` with a projectId and a `handoff` files a MOVE_TASK request, comes back
// CROSS_PROJECT_APPROVAL_REQUIRED or APPROVAL_PENDING with the task where it was, and the owner's
// yes moves the task — nobody sends anything again. Until then every description an agent reads
// said the opposite, that such a move is refused PROJECT_SCOPE_MISMATCH declared or not, and a
// model that believes it never asks. These pin the new sentences where an agent meets them, and
// the absence of the old one everywhere.

// staleMoveClaims are the ways the old descriptions said a declared move goes nowhere.
var staleMoveClaims = []string{
	"whether or not it is declared",
	"declared or not",
	"MOVING a task that already exists is refused",
	"this door files no question",
	"take that one to the owner yourself",
	"re-filing is therefore the owner's",
	"a re-filing is the owner's",
}

func assertSaysNoStaleMoveClaim(t *testing.T, where, text string) {
	t.Helper()
	for _, stale := range staleMoveClaims {
		if strings.Contains(text, stale) {
			t.Errorf("%s still says %q:\n%s", where, stale, text)
		}
	}
}

func TestMCPTaskUpdateDescribesTheMoveRequestAndItsConfirmation(t *testing.T) {
	tools := toolDescriptors(false, false)
	props := mcpToolProps(tools, "task_update")

	assertSaysAll(t, "the task_update tool description", mcpToolDescription(tools, "task_update"),
		"PROJECT_SCOPE_MISMATCH for another project unless it asks for the move with `handoff`",
		"files a move request, answers CROSS_PROJECT_APPROVAL_REQUIRED or APPROVAL_PENDING and leaves the task where it is",
		"the account owner's confirmation moves the task at once, with nothing to send again",
	)

	handoff, _ := props["handoff"].(map[string]interface{})
	description, _ := handoff["description"].(string)
	assertSaysAll(t, "task_update's handoff description", description,
		// What the request is, and what it is not.
		"a REQUEST for the move",
		"it moves nothing, it asks",
		"The server files a MOVE_TASK request and answers CROSS_PROJECT_APPROVAL_REQUIRED (filed now) or APPROVAL_PENDING",
		"and the task stays where it is",
		// Who answers, and that the answer is the move.
		"Only the ACCOUNT OWNER answers it",
		"Their confirmation IS the move: the task joins the target project at once and nothing has to be sent again",
		"project_crossings",
		// Who may ask.
		"is the move's source or its target; any other session is refused PROJECT_SCOPE_MISMATCH",
		// What a request may carry.
		"optionally criterionKey, a key of the TARGET project's criteria",
		"what it declares in its current project is withdrawn by the move",
		"MOVE_TASK_EXTRA_FIELDS",
		"to change it, the owner refuses it and you ask again",
		// Which moves are refused before anybody is asked.
		"OUT of a settled (DONE or CANCELLED) project, only a task that serves none of that project's acceptance criteria may be moved",
		"INTO a settled project, nothing may (PROJECT_REOPEN_REQUIRED)",
		"MOVE_TASK_LANDING_IN_FLIGHT",
	)

	project, _ := props["projectId"].(map[string]interface{})
	projectText, _ := project["description"].(string)
	assertSaysAll(t, "task_update's projectId description", projectText,
		"PROJECT_SCOPE_MISMATCH for another project unless it ASKS for the move with `handoff`",
		"Asking moves nothing by itself",
		"once the ACCOUNT OWNER confirms it, the task moves at once and nothing has to be sent again",
		"a requested move withdraws the one the task has in its current project by itself",
	)

	for name, text := range map[string]string{
		"the task_update tool description":    mcpToolDescription(tools, "task_update"),
		"task_update's handoff description":   description,
		"task_update's projectId description": projectText,
	} {
		assertSaysNoStaleMoveClaim(t, name, text)
	}
}

func TestTaskUpdateHelpDescribesTheMoveRequestAndItsConfirmation(t *testing.T) {
	help := taskActionHelp["update"]

	// The two flags, each where somebody reading about it meets it.
	project := help[strings.Index(help, "--project PROJECT_ID"):]
	project = project[:strings.Index(project, "--no-project")]
	assertSaysAll(t, "the --project help", project,
		"PROJECT_SCOPE_MISMATCH unless it asks for the move with\n                              --handoff-reason",
		"answers CROSS_PROJECT_APPROVAL_REQUIRED or APPROVAL_PENDING",
		"owner's confirmation on the project page moves the task at once",
		"with nothing to send again",
	)
	reason := help[strings.Index(help, "--handoff-reason TEXT"):]
	reason = reason[:strings.Index(reason, "--fixes-open-item-id")]
	assertSaysAll(t, "the --handoff-reason help", reason,
		"Ask for the move --project names, and say why",
		"stays where it is until the ACCOUNT OWNER confirms the request",
		"their confirmation is the move",
	)

	// The paragraph that says what a request is and which ones are refused.
	assertSaysAll(t, "`orbit task update --help`", help,
		"--project with --handoff-reason ASKS for a move rather than making one",
		"MOVE_TASK request for the account owner and answers CROSS_PROJECT_APPROVAL_REQUIRED (filed now) or\nAPPROVAL_PENDING",
		"the task moves at once, as their\nact: do not send the update again",
		"must be the move's source or its target; any other session\n    is refused PROJECT_SCOPE_MISMATCH",
		"optionally --criterion-key, a key of the\n    TARGET project's criteria that the task declares once it has moved",
		"MOVE_TASK_EXTRA_FIELDS",
		"withdrawn by the move",
		"out of a settled (DONE or CANCELLED) project, only a task that serves none of that project's\n    acceptance criteria may be moved, and into a settled project nothing may\n    (PROJECT_REOPEN_REQUIRED)",
		"MOVE_TASK_LANDING_IN_FLIGHT",
	)
	assertSaysNoStaleMoveClaim(t, "`orbit task update --help`", help)

	var spec cliCapabilitySpec
	for _, candidate := range baseCLICapabilities {
		if candidate.Tool == "task_update" {
			spec = candidate
		}
	}
	arguments := strings.Join(spec.Arguments, "\n")
	assertSaysAll(t, "`orbit capabilities` for task_update", arguments,
		"PROJECT_SCOPE_MISMATCH for the second unless it asks for the move with --handoff-reason, which files a request, answers CROSS_PROJECT_APPROVAL_REQUIRED or APPROVAL_PENDING and leaves the task where it is",
		"The owner's confirmation moves the task at once, with nothing to send again",
		"--handoff-reason <text> (handoff: ASK for the move --project names, and why.",
		"the task stays where it is until the ACCOUNT OWNER confirms it, which moves the task at once with nothing to send again",
		"Only a session whose own project is the move's source or its target may ask, any other is refused PROJECT_SCOPE_MISMATCH",
		"optionally --criterion-key, a criterion of the TARGET project that the task declares once moved",
		"Out of a settled (DONE or CANCELLED) project only a task serving none of that project's acceptance criteria may move; into a settled project nothing may (PROJECT_REOPEN_REQUIRED)",
	)
	assertSaysAll(t, "`orbit capabilities` task_update description", spec.Description,
		"--project with --handoff-reason asks for a move rather than making one: the request waits for the account owner, and their confirmation moves the task, with nothing to send again.",
	)
	assertSaysNoStaleMoveClaim(t, "`orbit capabilities` for task_update", arguments+"\n"+spec.Description)
}

// The refusals that send an agent towards a move say the same thing as the descriptions: asking is
// open to a task that already exists, and the owner's yes is the move.
func TestCrossingRefusalsSayAConfirmedMoveNeedsNothingSentAgain(t *testing.T) {
	refusal := func(body map[string]interface{}) error {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		return &transportHTTPError{method: "PATCH", path: "/tasks/t1", statusCode: 403, body: string(raw)}
	}

	how := crossProjectCrossingGuidance(refusal(map[string]interface{}{
		"code":           "PROJECT_SCOPE_MISMATCH",
		"requiredAction": "FILE_IN_OWN_PROJECT_OR_REQUEST_HANDOFF",
		"message":        "PROJECT_SCOPE_MISMATCH: declare the crossing and ask.",
	}))
	assertSaysAll(t, "the PROJECT_SCOPE_MISMATCH guidance", how,
		"--handoff-reason TEXT",
		"New work (task_create, task_create_batch) is filed by sending the write again once that says APPROVED.",
		"A move of a task that already exists (task_update) can be asked for when this session's own project is the move's source or its target, and the owner's confirmation moves the task: nothing has to be sent again.",
	)
	assertSaysNoStaleMoveClaim(t, "the PROJECT_SCOPE_MISMATCH guidance", how)

	for _, code := range []string{"CROSS_PROJECT_APPROVAL_REQUIRED", "APPROVAL_PENDING"} {
		where := crossProjectCrossingGuidance(refusal(map[string]interface{}{
			"code":           code,
			"requiredAction": "AWAIT_HANDOFF_APPROVAL",
			"handoffId":      "AAACrossing",
			"message":        code + ": the move waits for the account owner.",
		}))
		assertSaysAll(t, "the "+code+" guidance", where,
			"Only the ACCOUNT OWNER can answer it",
			"A request to MOVE a task that already exists is done by their confirmation: once they confirm it, the task is in the target project and nothing has to be sent again.",
		)
	}
}

// Nowhere an agent reads about this binary's tools and commands says the old thing.
func TestNoDescriptionSaysADeclaredMoveIsRefused(t *testing.T) {
	tools, err := json.Marshal(toolDescriptors(true, true))
	if err != nil {
		t.Fatal(err)
	}
	// Marshalled, so the check reads the text as a model receives it; JSON escapes no character any
	// of the stale phrases contains.
	assertSaysNoStaleMoveClaim(t, "the MCP tool descriptors", string(tools))

	for _, list := range [][]cliCapabilitySpec{
		baseCLICapabilities, providerCLICapabilities, projectCLICapabilities, notifyCLICapabilities,
		mergeReceiptCLICapabilities, sessionCLICapabilities, agentCLICapabilities,
		watchCLICapabilities, wikiCLICapabilities, wikiImportCLICapabilities, wikiPlanCLICapabilities,
		userCLICapabilities,
	} {
		for _, spec := range list {
			assertSaysNoStaleMoveClaim(t, "`orbit capabilities` for "+spec.Tool,
				strings.Join(spec.Arguments, "\n")+"\n"+spec.Description)
		}
	}
	for family, helps := range map[string]map[string]string{
		"task": taskActionHelp, "project": projectActionHelp,
	} {
		for action, help := range helps {
			assertSaysNoStaleMoveClaim(t, "`orbit "+family+" "+action+" --help`", help)
		}
	}
}
