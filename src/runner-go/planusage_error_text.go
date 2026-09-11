package main

import "errors"

// planUsageErrorText is how a failed usage read is logged. A Codex app-server's error answer is named by its
// method only: its text is the provider's own and can name the account, which no log line may carry
// (docs/codex-rate-limit-reset-runbook.md). Every other failure keeps its own text.
func planUsageErrorText(err error) string {
	var answered *codexRPCCallError
	if errors.As(err, &answered) {
		return answered.method + ": the app-server answered an error"
	}
	return err.Error()
}
