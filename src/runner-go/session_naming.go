package main

import (
	"context"
	"strings"
	"time"
)

// Naming a session through the engine running it.
//
// A session the control plane cannot name itself — it holds no DeepSeek key, and the session runs on
// an engine's own sign-in, which only this machine holds — reaches the claim with a Naming job. The
// engine answers from inside the process already running the session, so no second process is
// started and no other credential is spent: Claude Code through its own generate_session_title
// request (below), Codex through a side thread in its app-server (codex_naming.go). Either way the
// answer goes back to the control plane, which keeps it only while the session still carries the
// title it was claimed with.

// claudeNamingTimeout bounds generate_session_title. Measured on Claude Code 2.1.295 it answers in
// about a second, alongside the turn it was sent beside; past this the fallback title simply stays.
const claudeNamingTimeout = time.Minute

// askClaudeSessionTitle has the running Claude Code name its session. persist false: the CLI only
// answers, and writes no title of its own into the conversation. An older CLI refuses the subtype,
// which is logged and leaves the title as it is.
func askClaudeSessionTitle(ctx context.Context, t *Transport, rt *claudeRuntime, job *ClaimedSession) {
	w, err := rt.requestControlWith(ctrlGenerateSessionTitle, map[string]interface{}{
		"description": job.Naming.Description,
		"persist":     false,
	})
	if err == nil {
		err = rt.awaitControl(ctx, w, claudeNamingTimeout)
	}
	if err != nil {
		logln("session title: claude did not name", job.SessionID+":", err)
		return
	}
	title, _ := w.resp.Response["title"].(string)
	reportSessionNaming(t, job, title)
}

// reportSessionNaming hands an engine's answer to the control plane, against the title the claim
// carried. An empty title is no answer.
func reportSessionNaming(t *Transport, job *ClaimedSession, title string) {
	title = strings.TrimSpace(title)
	if title == "" {
		logln("session title: the engine gave", job.SessionID, "no title")
		return
	}
	if err := t.sessionNaming(job.SessionID, SessionNamingRequest{Replaces: job.Title, Title: title}); err != nil {
		logln("session title: could not report the title of", job.SessionID+":", err)
	}
}
