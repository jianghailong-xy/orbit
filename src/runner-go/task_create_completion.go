package main

import (
	"fmt"
)

const runnerTaskCompletionDeclarationError = "completionCriterion is required for runner task creation because omission would implicitly create EVIDENCE_JUDGMENT; set EXECUTABLE, VERIFICATION, or EVIDENCE_JUDGMENT explicitly (command, policy, and verifier fields do not replace that declaration)"

// requireRunnerTaskCompletionDeclaration is the client-side copy of the runner HTTP boundary.
// Keeping the rejection here means a stale/partial command fails before it can create a human
// obligation; the server repeats the invariant because old runner binaries cannot be trusted to
// have this function. The user/JWT API deliberately does not share this guard.
func requireRunnerTaskCompletionDeclaration(item map[string]interface{}) error {
	if criterion, present := item["completionCriterion"]; present && criterion != nil {
		return nil
	}
	return fmt.Errorf("%s", runnerTaskCompletionDeclarationError)
}
