package main

// Removing an account its sessions were moved off, when those sessions have no engine running.
//
// The control plane answers a removal refused over sessions in the account by moving each of them to
// another account and queuing a reload, which carries the conversation as it stops the engine
// (moveIdleSessionToItsAccount). A session the pool holds with no engine at all — between turns for
// weeks, its process long since reaped — takes no reload until its next claim, so its record keeps
// naming the account, liveDirs keeps counting it, and the removal was refused every heartbeat until it
// timed out (2026-11-17: 16 Codex sessions parked since early October). The removal now names each
// session's new account (AccountRemoveCommand.Moves), and the runner makes the move the next spawn
// would make, here: the conversation first, then the record, so a session whose conversation could
// not be carried keeps its account, and the account stays.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// carryColdSessionsOff carries every session in `moves` that is in account `id`'s directory (`live`,
// kind.liveDirs) and has no engine running (`cold`) onto the account it was moved to. Returns the
// account's directory and the sessions it carried, which the caller checks are still cold before
// removing anything: a claim that arrived meanwhile starts an engine that may be reading the old copy.
func carryColdSessionsOff(kind accountSlotKind, id string, moves []AccountRemoveMove, live accountDirSessions, cold func(string) bool) (string, []string) {
	carry := carryColdFor(kind.engine)
	if carry == nil || len(moves) == 0 || id == accountSlotDefaultID {
		return "", nil
	}
	from, err := kind.home(id)
	if err != nil {
		return "", nil // nothing on the machine to carry from
	}
	from = filepath.Clean(from)
	in := map[string]bool{}
	for _, sessionID := range live[from] {
		in[sessionID] = true
	}
	var carried []string
	for _, move := range moves {
		if !in[move.SessionID] || move.Account == id || !cold(move.SessionID) {
			continue
		}
		to, err := kind.home(move.Account)
		if err != nil {
			logln(kind.engine, "session", move.SessionID, "stays on account", id, "for now: the account it moved to is not here:", err)
			continue
		}
		ok, err := carry(move.SessionID, from, filepath.Clean(to))
		switch {
		case err != nil:
			logln(kind.engine, "session", move.SessionID, "stays on account", id, "for now: carrying its conversation failed:", err)
		case ok:
			logln(kind.engine, "session", move.SessionID, "carried from account", id, "to", move.Account, "for its removal")
			carried = append(carried, move.SessionID)
		}
	}
	return from, carried
}

// accountLiveDirsAfterColdCarry is the directories this runner's sessions hold, as a removal reads
// them, once the sessions the control plane moved off the account and that have no engine running
// have been carried (carryColdSessionsOff). One a claim started meanwhile still holds the account:
// its new engine may be reading the old copy.
func accountLiveDirsAfterColdCarry(kind accountSlotKind, rr *AccountRemoveCommand, pool *sessionPool) accountDirSessions {
	live := kind.liveDirs(pool.sessionIDs())
	dir, carried := carryColdSessionsOff(kind, rr.Account, rr.Moves, live, pool.isCold)
	if len(carried) == 0 {
		return live
	}
	live = kind.liveDirs(pool.sessionIDs())
	for _, id := range carried {
		if !pool.isCold(id) {
			live[dir] = append(live[dir], id)
		}
	}
	return live
}

// carryColdFor is how one session with no engine running is carried from account directory `from` to
// `to` — its conversation, then its record — the way its next spawn on `to` would. False leaves it where
// it is. Nil for an engine that keeps no conversation in an account (Antigravity), or cannot carry one
// (Cursor CLI). A switch rather than a field of accountSlotKind: each carry reads its engine's kind,
// which a field would make an initialization cycle.
func carryColdFor(engine string) func(sessionID, from, to string) (bool, error) {
	switch engine {
	case providerCodex:
		return carryColdCodexSession
	case providerClaude:
		return carryColdClaudeSession
	case providerKimi:
		return carryColdKimiSession
	}
	return nil
}

// writeSessionMetaFile replaces a session's record whole, as writeSessionMetaRecord does.
func writeSessionMetaFile(scratch string, meta *sessionMeta) error {
	b, err := json.Marshal(meta)
	if err != nil {
		return err
	}
	return writeFileAtomically(filepath.Join(scratch, "meta.json"), b, 0o644)
}

// carryColdCodexSession is moveCodexThreadToClaimedAccount for a session no engine runs: its thread's
// rollouts, and its sub-agents', are copied into `to` at the same relative paths, and its record points
// at `to`'s shared state. One with no thread yet has nothing to carry and moves at once.
func carryColdCodexSession(sessionID, from, to string) (bool, error) {
	scratch := runDir(sessionID)
	meta := readSessionMeta(filepath.Join(scratch, "meta.json"))
	if meta == nil || meta.CodexStateLayout != codexStateLayoutShared || filepath.Clean(meta.CodexStateHome) != from || to == from {
		return false, nil
	}
	if thread := meta.RuntimeSessionID; thread != "" {
		rollouts, err := codexThreadRollouts(from, thread)
		if err != nil {
			return false, err
		}
		for _, src := range rollouts {
			rel, err := filepath.Rel(from, src)
			if err != nil {
				return false, err
			}
			if err := copyCodexRollout(src, filepath.Join(to, rel)); err != nil {
				return false, fmt.Errorf("copy %s: %w", rel, err)
			}
		}
	}
	partition := codexStatePartition(to)
	if _, err := ensureSharedCodexStateDir(partition); err != nil {
		return false, err
	}
	meta.CodexStateHome, meta.CodexStatePartition = to, partition
	return true, writeSessionMetaFile(scratch, meta)
}

// carryColdClaudeSession is moveIdleClaudeConversation for a session no engine runs: its transcript is
// carried into `to` (carryClaudeConversation), and its record names `to` — or nothing, when `to` is
// the runner's own Default — once `to` holds it. One that has not talked moves at once.
func carryColdClaudeSession(sessionID, from, to string) (bool, error) {
	scratch := runDir(sessionID)
	meta := readSessionMeta(filepath.Join(scratch, "meta.json"))
	if meta == nil || filepath.Clean(meta.ClaudeConfigDir) != from || to == from {
		return false, nil
	}
	if meta.SessionUUID != "" && meta.WorkDir != "" {
		src, err := claudeTranscriptPathIn(from, meta.WorkDir, meta.SessionUUID)
		if err != nil {
			return false, err
		}
		if claudeTranscriptHasConversation(src) {
			dst, err := claudeTranscriptPathIn(to, meta.WorkDir, meta.SessionUUID)
			if err != nil {
				return false, err
			}
			carryClaudeConversation(to, meta.WorkDir, meta.SessionUUID, dst)
			if !claudeTranscriptHasConversation(dst) {
				return false, nil
			}
		}
	}
	meta.ClaudeConfigDir = to
	if own, err := effectiveClaudeConfigDir(os.Environ(), meta.WorkDir); err == nil && filepath.Clean(own) == to {
		meta.ClaudeConfigDir = ""
	}
	return true, writeSessionMetaFile(scratch, meta)
}

// carryColdKimiSession is moveIdleKimiConversation for a session no engine runs: its conversation is
// carried into `to` (carryKimiConversation), and its record names `to` — or nothing, on the runner's
// own Default — once `to` holds it. One that has not talked moves at once.
func carryColdKimiSession(sessionID, from, to string) (bool, error) {
	scratch := runDir(sessionID)
	meta := readSessionMeta(filepath.Join(scratch, "meta.json"))
	if meta == nil || filepath.Clean(meta.KimiCodeHome) != from || to == from {
		return false, nil
	}
	if thread := meta.RuntimeSessionID; thread != "" {
		if err := ensureKimiHomeStores(to); err != nil {
			return false, err
		}
		if _, err := carryKimiConversation(to, thread, from); err != nil {
			return false, err
		}
		if kimiSessionDirIn(to, thread) == "" {
			return false, nil
		}
	}
	meta.KimiCodeHome = to
	if own, err := effectiveKimiHome(os.Environ(), meta.WorkDir); err == nil && filepath.Clean(own) == to {
		meta.KimiCodeHome = ""
	}
	return true, writeSessionMetaFile(scratch, meta)
}
