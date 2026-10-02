package main

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// codexAccountMoveCapabilityV1 declares that this runner carries a Codex session's thread onto the
// account its claim names (moveCodexThreadToClaimedAccount). The control plane moves a session off an
// account whose usage limit stopped it only on a runner that declares it: one that does not would
// resume it where its thread is, on the spent account, whatever the claim said.
const codexAccountMoveCapabilityV1 = "codex-account-move/v1"

// moveCodexThreadToClaimedAccount follows a Codex session onto the account its claim names, when that
// is not the account its state was first opened under.
//
// A session keeps that account for life (resolveCodexStateDir): its thread lives in that CODEX_HOME.
// The control plane moves a session off an account whose usage limit stopped it (runner-api
// turn-complete, which rewrites Session.codexAccount), and the claim that re-sends it names the new
// account's CODEX_HOME. The thread goes with it: its rollout, and those of the sub-agents it spawned,
// are copied into the new home at the same relative paths — Codex resumes a thread by id from the
// rollouts under its CODEX_HOME even when that home's state database has never seen it (codex 0.159,
// measured) — and the session's meta is pointed at the new home, so the sign-in preflight, the state
// partition and the app-server that follow all resolve there. The old home keeps its copy.
//
// Only between two of this runner's accounts, and only onto one that is signed in: a claim naming a
// CODEX_HOME no account is, or an account that is signed out, leaves the session where its thread is —
// the account it is switched to may not be signed in yet, and that is no reason to refuse a session
// that can go on where it was. A thread whose rollout cannot be found stays too: resuming it
// elsewhere would fail. Reports whether it moved the session.
//
// A credential-isolated session (isolatedCodexStateForEnv) revived without those credentials — its
// provider switched to the built-in one — moves the same way, from the home of its own, which holds no
// login, onto the account its claim now names.
func moveCodexThreadToClaimedAccount(job *ClaimedSession, scratchDir, execDir string) (bool, error) {
	meta := readSessionMeta(filepath.Join(scratchDir, "meta.json"))
	if meta == nil || meta.CodexStateHome == "" {
		return false, nil
	}
	from := filepath.Clean(meta.CodexStateHome)
	switch meta.CodexStateLayout {
	case codexStateLayoutShared:
		if _, ok := codexAccountSlotOfHome(from); !ok {
			return false, nil
		}
	case codexStateLayoutIsolated:
		// Only once it runs without the credentials that isolated it, by the rule that placed it.
		if !codexSharedStateAllowed(envWithAgent(job.Agent.Env)) {
			return false, nil
		}
	default:
		return false, nil
	}
	processEnv := envWithAgent(job.Agent.Env)
	if _, ok := codexSessionAccountSlot(job.Agent.Env, processEnv, execDir); !ok {
		return false, nil
	}
	to, err := effectiveCodexHome(processEnv, execDir)
	if err != nil || to == from {
		return false, err
	}
	if engineAuthPreflight(providerCodex, job.Agent.Env) != "" {
		return false, nil
	}
	thread := currentRuntimeSessionID(job)
	if thread == "" {
		thread = meta.RuntimeSessionID
	}
	if thread != "" {
		rollouts, err := codexThreadRollouts(from, thread)
		if err != nil {
			return false, err
		}
		if len(rollouts) == 0 {
			return false, nil
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
	writeSessionMetaWithCodexState(scratchDir, job, execDir, codexStateLayoutShared, codexStatePartition(to), to)
	return true, nil
}

// codexThreadRollouts is every rollout under home that belongs to thread: its own, found by the id in
// its file name, and those of the sub-agents it spawned — a sub-agent's rollout is named by its own
// id, and says which thread it belongs to in its first line (session_meta's session_id, the thread
// that began it all, for a sub-agent's own sub-agents too). A sub-agent is spawned after its thread
// began, so only the days from the thread's own on are read, and of each rollout only its head.
func codexThreadRollouts(home, thread string) ([]string, error) {
	own, err := filepath.Glob(filepath.Join(home, "sessions", "*", "*", "*", "rollout-*-"+thread+".jsonl"))
	if err != nil || len(own) == 0 {
		return nil, err
	}
	all, err := filepath.Glob(filepath.Join(home, "sessions", "*", "*", "*", "rollout-*.jsonl"))
	if err != nil {
		return nil, err
	}
	firstDay := filepath.Dir(own[0])
	marker := []byte(`"session_id":"` + thread + `"`)
	out := append([]string(nil), own...)
	for _, path := range all {
		if filepath.Dir(path) < firstDay || strings.HasSuffix(path, "-"+thread+".jsonl") {
			continue
		}
		if bytes.Contains(codexRolloutHead(path), marker) {
			out = append(out, path)
		}
	}
	return out, nil
}

// codexRolloutHead is the start of a rollout: enough of its first line to hold session_meta's ids,
// which Codex writes before the instructions that make the line long.
func codexRolloutHead(path string) []byte {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	head := make([]byte, 4096)
	n, _ := io.ReadFull(f, head)
	return head[:n]
}

// copyCodexRollout writes src's bytes over dst in one rename, so an app-server never reads half a
// thread; dst's directory is made as Codex makes it.
func copyCodexRollout(src, dst string) error {
	info, err := os.Stat(src)
	if err != nil {
		return err
	}
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	return writeFileAtomically(dst, data, info.Mode().Perm())
}
