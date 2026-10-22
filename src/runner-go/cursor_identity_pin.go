package main

// A Cursor CLI conversation stays on the identity it was opened on. Whether Cursor continues a conversation
// under another account or key is not known yet (docs/cursor-runtime-contract.md §13.2), and the owner decided
// D5 on 2026-10-17: until two real identities show it does, only a session that has not talked moves to
// another. The control plane refuses every door that moves a talked session (P6b). A session that follows its
// workspace — no account of its own, or the workspace's own key or token — has no door: its next claim simply
// runs on whatever the workspace was edited to. So the line is held where every start of the CLI passes, here.
// The session's record (meta.json, beside the conversation store it names) keeps the identity its conversation
// was opened on, and a process that would continue that conversation on another is refused before anything
// starts, in D5's words, unless this runner declares cursor-account-move/v1, which none does yet. A session
// with nothing said yet opens its conversation on whatever it runs on now, and that is what it keeps.
//
// An identity names a credential without carrying it: one of the runner's accounts by its id — a login's token
// changes with every sign-in, the account it belongs to does not — and a key or a token by its fingerprint,
// the one the control plane names a key by (cursorKeyFingerprint).

import (
	"path/filepath"
	"strings"
)

// cursorAccountMoveCapabilityV1 declares that this runner carries a Cursor CLI conversation to another account
// or key. Not declared until two real identities show Cursor continues one (D5, §13.3): the control plane moves
// a talked session only on a runner that does (account-move-capability.ts), and so does this one.
const cursorAccountMoveCapabilityV1 = "cursor-account-move/v1"

// cursorConversationMoveRefusal is how a talked session's start on another account or key is refused: the
// control plane's CURSOR_CONVERSATION_MOVE_REFUSAL, word for word (T0 board, Web 6 ② and iOS 6).
const cursorConversationMoveRefusal = "Cursor CLI can't carry a conversation to another account or key yet. Start a new session to use a different one."

// cursorCredentialIdentity names the credential the session's CLI runs on, as cursorLaunchCredential chooses
// it: "key:" and the fingerprint of the key it was dispatched with; "account:" and the id of the runner's
// account whose login it borrows (cursorSessionAccount), Default's included; else what its workspace brings —
// "key:" for a CURSOR_API_KEY, "token:" for a CURSOR_AUTH_TOKEN, both when it brings both, since which one the
// CLI signs in with then is unmeasured. "" when it cannot run on any, which its launch refuses on its own.
func cursorCredentialIdentity(job *ClaimedSession) string {
	if key := cursorSessionKey(job); key != "" {
		return "key:" + cursorKeyFingerprint(key)
	}
	if account := cursorSessionAccount(job); account != "" {
		return "account:" + account
	}
	if _, err := cursorSessionAccountDir(job.Agent.Env); err != nil {
		return ""
	}
	var own []string
	if key := strings.TrimSpace(job.Agent.Env["CURSOR_API_KEY"]); key != "" {
		own = append(own, "key:"+cursorKeyFingerprint(key))
	}
	if token := strings.TrimSpace(job.Agent.Env["CURSOR_AUTH_TOKEN"]); token != "" {
		own = append(own, "token:"+cursorKeyFingerprint(token))
	}
	return strings.Join(own, "+")
}

// cursorCarriesConversations is whether this runner carries a Cursor CLI conversation to another account or
// key: whether it declares cursor-account-move/v1.
func cursorCarriesConversations() bool {
	return strings.Contains(","+runnerCapabilitiesV1+",", ","+cursorAccountMoveCapabilityV1+",")
}

// cursorIdentityRefusal is why the session's Cursor CLI may not start on identity, or "" when it may. A
// conversation the session has talked in — one the driver would load rather than open (runCursorSessionProcess)
// — continues only on the identity its record says it was opened on, unless this runner carries it. A session
// with no conversation yet, or one never prompted (cursorConversationUnspoken), opens one on whatever it runs on
// now; so does one whose record names no identity, written before the record kept one.
func cursorIdentityRefusal(scratch string, job *ClaimedSession, identity string) string {
	if job.RuntimeSessionID == "" || identity == "" {
		return ""
	}
	dir, err := cursorSessionDir(job.SessionID)
	if err != nil || cursorConversationUnspoken(filepath.Join(dir, "config"), job.RuntimeSessionID) {
		return ""
	}
	meta := readSessionMeta(filepath.Join(scratch, "meta.json"))
	if meta == nil || meta.CursorIdentity == "" || meta.CursorIdentity == identity || cursorCarriesConversations() {
		return ""
	}
	return cursorConversationMoveRefusal
}
