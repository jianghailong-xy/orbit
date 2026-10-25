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

// cursorUsageLimitText is how a turn Cursor ended on the account's usage limit is reported. Cursor CLI says
// only `said` ("Upgrade your plan to continue") — the limit, its window and its reset stay in its own
// debug log (docs/cursor-runtime-contract.md §11, §12) — so the sentence opens with the words the control
// plane and every client read as a spent quota (@orbit/shared USAGE_LIMIT_ERROR_MARKERS, "hit your usage
// limit"), the title Cursor's server gave the measured case, and quotes Cursor after them.
func cursorUsageLimitText(said string) string {
	return `You've hit your usage limit on Cursor. Cursor said: "` + said + `."`
}
