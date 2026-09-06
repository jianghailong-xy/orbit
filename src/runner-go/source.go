package main

import (
	"context"
	"fmt"
	"regexp"
	"strings"
)

// The SOURCE handshake's runner half (docs/project-source-contract.md §6.3).
//
// The control plane has no checkout, so it cannot turn a ref into a commit; this process has one,
// so it must not be the only place the answer lives. Hence the three steps: the server hands over
// the frozen selector, this machine RESOLVES it, and the server FREEZES the result by
// compare-and-set. Only then may a worktree be created, and only then may an engine be spawned
// (SR33).
//
// The admission gate's levels are now spread across two files, in SR21's order. G1 (repository
// identity) is here, ahead of G2/G3, because those ask the authority THROUGH a checkout and a
// foreign checkout is the wrong thing to ask through. G4 (object availability) and G6 (isolation)
// are in worktree.go's setupSourceWorktree, which is where a baseline stops being a string and
// becomes a checkout. G5 (dependency containment) is the one level this build does not run at all;
// it belongs to the checkpoint/closure task (34IMkgyuwfAZfobPNphTB), and setupWorktree's dispatch
// names the hole rather than letting the gate read as complete.

const (
	sourceStateUnbound  = "UNBOUND"
	sourceStateSelected = "SELECTED"
	sourceStatePinned   = "PINNED"
	sourceStateRefused  = "REFUSED"

	refAuthorityRemote      = "REMOTE"
	refAuthorityRunnerLocal = "RUNNER_LOCAL"

	// §10.1's codes, spelled here only where this file can actually report one.
	sourceRefusalAuthorityUnreachable = "SOURCE_AUTHORITY_UNREACHABLE"
	sourceRefusalRefNotFound          = "BASE_REF_NOT_FOUND"
	sourceRefusalShaUnavailable       = "BASE_SHA_UNAVAILABLE"
	sourceRefusalRepoMismatch         = "BASE_REPO_MISMATCH"
	sourceRefusalWorktreeRequired     = "WORKTREE_REQUIRED"
)

var fullSha = regexp.MustCompile(`^[0-9a-f]{40}$`)

// needsSourcePin reports whether this job must complete the handshake before it may run at all.
//
// Nil source, or UNBOUND, is the Legacy path and answers false: those sessions behave exactly as
// they did before migration 0231, down to the three degradations in §0 that new-style sessions are
// forbidden (SR45/SR46).
func needsSourcePin(job *ClaimedSession) bool {
	return job != nil && job.Source != nil && job.Source.State != "" && job.Source.State != sourceStateUnbound
}

// ensureSourcePinned runs steps 2 and 3 for one job and reports whether the run may proceed.
//
// On success job.Source.State is PINNED and job.Source.BaseSha is the commit the whole run is about
// — the value the CONTROL PLANE holds, which is not always the one this machine computed: a runner
// that lost the race adopts the winner's pin, because a worktree already stands on it (SR30).
//
// A session that arrives already PINNED does no resolution at all. That is the entire content of
// "resume, reclaim and takeover reuse the same snapshot" (SR29): the recovery paths read, and a
// ref that has moved, a binding that was reconfigured or a `configRevision` that was bumped since
// change nothing about where this run started.
func ensureSourcePinned(ctx context.Context, t *Transport, job *ClaimedSession) error {
	if !needsSourcePin(job) {
		return nil
	}
	src := job.Source
	switch src.State {
	case sourceStatePinned:
		if !fullSha.MatchString(src.BaseSha) {
			return fmt.Errorf("session %s is pinned to %q, which is not a commit SHA", job.SessionID, src.BaseSha)
		}
		return nil
	case sourceStateRefused:
		// Terminal (SR34). Recovery is a NEW session, frozen against the configuration as it is
		// then — never a second resolution of this one, which would quietly give the run a
		// different meaning than the one it was refused for.
		return fmt.Errorf("session %s refused its SOURCE (%s); recovery is a new run", job.SessionID, src.RefusalCode)
	case sourceStateSelected:
	default:
		return fmt.Errorf("session %s has an unknown SOURCE state %q", job.SessionID, src.State)
	}

	sha, refusal := resolveSourceSha(job)
	var req SourcePinRequest
	if refusal != nil {
		req = SourcePinRequest{Refusal: refusal}
	} else {
		req = SourcePinRequest{BaseSha: sha}
	}
	res, err := t.pinSessionSource(ctx, job.SessionID, req)
	if err != nil {
		// The pin never happened, so nothing is frozen and nothing may start. A later claim
		// resolves again from scratch, and is ALLOWED to reach a different commit — the ref moving
		// between two attempts that both failed to freeze is legal (§6.4, first row).
		return fmt.Errorf("cannot freeze SOURCE for session %s: %w", job.SessionID, err)
	}
	if res.State != sourceStatePinned || !fullSha.MatchString(res.BaseSha) {
		return fmt.Errorf("session %s did not reach a pinned SOURCE (state %s, refusal %s)",
			job.SessionID, res.State, res.RefusalCode)
	}
	if !res.WonRace && res.BaseSha != sha {
		// Not an error and not something to correct: another claim froze first and a checkout may
		// already exist on its commit. One session, one baseline — this one adopts it and says so,
		// because a divergence nobody recorded is one nobody can investigate.
		logln(fmt.Sprintf("session %s — SOURCE already pinned to %s by %s; this runner resolved %s and is using the pinned one",
			job.SessionID, shortSha(res.BaseSha), res.ResolvedByRunnerID, shortSha(sha)))
	}
	src.State = res.State
	src.BaseSha = res.BaseSha
	src.ResolvedAt = res.ResolvedAt
	src.ResolvedByRunnerID = res.ResolvedByRunnerID
	return nil
}

// resolveSourceSha turns the frozen selector into a commit, or into one of §10.1's refusal codes.
//
// SHA-valued selectors are already the answer and are returned untouched — deliberately without
// checking that the object is present here, because that check is gate G4 and belongs with the rest
// of the gate on the worktree task; reporting "unavailable" from two places would be two answers.
//
// Ref-valued selectors are FETCHED and THEN resolved, as one sequence (SR38). Reading a local ref
// that some earlier operation happened to leave behind is not allowed: that value may be a commit
// which was never the authority's tip at any moment, and a baseline has to be something that
// really existed. There is no time window that excuses skipping the fetch (SR39) — fetching IS
// what "fresh" means here.
func resolveSourceSha(job *ClaimedSession) (string, *SourcePinRefusal) {
	src := job.Source
	if src.RevisionSha != "" {
		sha := strings.ToLower(strings.TrimSpace(src.RevisionSha))
		if !fullSha.MatchString(sha) {
			return "", &SourcePinRefusal{
				Code:   sourceRefusalShaUnavailable,
				Detail: map[string]interface{}{"sha": src.RevisionSha, "sourceKind": src.Kind},
			}
		}
		return sha, nil
	}
	if src.Ref == "" {
		return "", &SourcePinRefusal{
			Code:   sourceRefusalRefNotFound,
			Detail: map[string]interface{}{"ref": "", "refAuthority": src.RefAuthority},
		}
	}
	dir := job.WorkDir
	if dir == "" || !isGitRepo(dir) {
		// Not "the ref is missing" and not "the object is gone": this machine cannot ask the
		// authority at all, which is gate G2 (§5). Keeping it separate from G3 is what lets a
		// retry mean something — an unreachable authority may work on the next attempt, a ref that
		// does not exist will not.
		return "", &SourcePinRefusal{
			Code: sourceRefusalAuthorityUnreachable,
			Detail: map[string]interface{}{
				"refAuthority": src.RefAuthority,
				"reason":       "this runner has no git checkout to ask the authority through",
			},
		}
	}
	// G1 before G2 (SR21's total order, for SR23's reason). The authority is asked THROUGH this
	// checkout: fetching into a repository that is not the one the snapshot named would write
	// objects into somebody else's repo and could freeze a commit that never belonged to this
	// codebase — and a pin is immutable, so noticing at G4 would be noticing too late.
	if refusal := repoIdentityRefusal(dir, src); refusal != nil {
		return "", refusal
	}
	switch src.RefAuthority {
	case refAuthorityRunnerLocal:
		// This machine's own checkout IS the authority (SR31 guarantees the binding names exactly
		// one machine, and the WHERE chain is what keeps the work on it). No fetch: there is no
		// remote to be fresh against, and the local ref is the authoritative answer by definition.
		out, err := git(dir, "rev-parse", "--verify", src.Ref+"^{commit}")
		if err != nil || !fullSha.MatchString(strings.ToLower(out)) {
			return "", &SourcePinRefusal{
				Code: sourceRefusalRefNotFound,
				Detail: map[string]interface{}{
					"ref": src.Ref, "refAuthority": src.RefAuthority, "stderr": gitStderr(err),
				},
			}
		}
		return strings.ToLower(out), nil
	case refAuthorityRemote:
	default:
		// A vocabulary this build does not know. Refusing beats guessing REMOTE: guessing would
		// resolve against something the binding did not name, which is a baseline nobody chose.
		return "", &SourcePinRefusal{
			Code: sourceRefusalAuthorityUnreachable,
			Detail: map[string]interface{}{
				"refAuthority": src.RefAuthority,
				"reason":       "this runner does not understand that ref authority",
			},
		}
	}
	remote := src.RemoteName
	if remote == "" {
		remote = "origin"
	}
	if _, err := git(dir, "fetch", "--no-tags", remote, src.Ref); err != nil {
		// One fetch failure, two possible meanings, and the codes have to stay apart because the
		// answers differ: "I could not ask" is retryable and "that ref is not there" is a
		// configuration error that will fail identically forever (§10.2). git says which by
		// naming the ref it could not find.
		code := sourceRefusalAuthorityUnreachable
		if mentionsMissingRef(err) {
			code = sourceRefusalRefNotFound
		}
		return "", &SourcePinRefusal{
			Code: code,
			Detail: map[string]interface{}{
				"ref": src.Ref, "refAuthority": src.RefAuthority, "remoteName": remote,
				"stderr": gitStderr(err),
			},
		}
	}
	out, err := git(dir, "rev-parse", "--verify", "FETCH_HEAD^{commit}")
	if err != nil || !fullSha.MatchString(strings.ToLower(out)) {
		return "", &SourcePinRefusal{
			Code: sourceRefusalRefNotFound,
			Detail: map[string]interface{}{
				"ref": src.Ref, "refAuthority": src.RefAuthority, "remoteName": remote,
				"stderr": gitStderr(err),
			},
		}
	}
	return strings.ToLower(out), nil
}

// mentionsMissingRef distinguishes "the remote answered and does not have that ref" from every
// other reason a fetch fails (no network, bad credentials, no such remote).
func mentionsMissingRef(err error) bool {
	text := strings.ToLower(gitStderr(err))
	return strings.Contains(text, "couldn't find remote ref") ||
		strings.Contains(text, "could not find remote ref") ||
		strings.Contains(text, "no such ref")
}

// canonicalizeRepoURL is SR36's pure function: a repository's IDENTITY, computed the same way on
// both sides of every comparison and used for nothing else — a clone is still run with the value
// the user wrote. Two spellings of the same repository (`git@host:owner/repo.git`,
// `ssh://git@host/owner/repo`, `https://host/owner/repo/`) must answer the same string, because
// the alternative is a workspace that holds exactly the right code being refused over a suffix.
//
// It shares its decomposition with clone.go's cloneDirName (SR36), and
// TestCanonicalRepoURLAgreesWithCloneDirName is the differential that keeps the two from drifting
// apart — including a negative half, because a canonicaliser that collapsed everything would make
// G1 answer "yes" to any workspace at all.
func canonicalizeRepoURL(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return ""
	}
	if i := strings.Index(s, "://"); i >= 0 {
		scheme := strings.ToLower(s[:i])
		rest := s[i+3:]
		slash := strings.Index(rest, "/")
		// Drop a `user@` prefix: it is a credential, and the same repository read by two accounts
		// is one repository.
		if at := strings.LastIndex(rest, "@"); at >= 0 && (slash < 0 || at < slash) {
			rest = rest[at+1:]
			slash = strings.Index(rest, "/")
		}
		host, path := rest, ""
		if slash >= 0 {
			host, path = rest[:slash], rest[slash+1:]
		}
		if scheme == "file" {
			s = "/" + path // file:///srv/repo names a path, not a host
		} else {
			s = strings.ToLower(host) + "/" + path
		}
	} else if colon := strings.Index(s, ":"); colon > 0 && !strings.ContainsAny(s[:colon], "/\\") {
		// scp-like `git@host:owner/repo` — the same repository as `ssh://git@host/owner/repo`.
		host, path := s[:colon], strings.TrimPrefix(s[colon+1:], "/")
		if at := strings.LastIndex(host, "@"); at >= 0 {
			host = host[at+1:]
		}
		s = strings.ToLower(host) + "/" + path
	}
	s = strings.TrimSuffix(s, "/")
	s = strings.TrimSuffix(s, ".git")
	return strings.TrimSuffix(s, "/")
}

// repoRootCommits lists every root commit in the checkout at dir — `--all`, not `HEAD`, because a
// workspace parked on an unrelated branch is still the same repository and identity may not depend
// on which branch somebody happens to have checked out.
func repoRootCommits(dir string) []string {
	out, err := git(dir, "rev-list", "--max-parents=0", "--all")
	if err != nil || out == "" {
		return nil
	}
	return strings.Fields(strings.ToLower(out))
}

// repoIdentityRefusal answers gate G1 (§5) for the checkout at dir: nil when this checkout IS the
// repository the snapshot froze, a BASE_REPO_MISMATCH otherwise.
//
// This is the whole of "identity is MATCHED, never inherited". The frozen `(canonicalRepoUrl,
// rootCommitSha)` pair is the question and the local checkout is the candidate answer; a checkout
// that does not answer it is refused, and the run does NOT continue against that workspace's own
// HEAD, ref or remote. SR37 makes the test a disjunction on purpose: URL alone breaks the day a
// remote is migrated, root commit alone cannot separate two forks.
//
// Why it runs BEFORE the authority is asked (SR21/SR23): asking through a foreign checkout means
// `git fetch` into somebody else's repository, and then freezing whatever ref of that name it
// happens to carry. That is the exact substitution this gate exists to prevent, and by the time
// G4 noticed, the pin would already be immutable.
func repoIdentityRefusal(dir string, src *SessionSource) *SourcePinRefusal {
	want := canonicalizeRepoURL(src.RepoURL)
	remote := src.RemoteName
	if remote == "" {
		remote = "origin"
	}
	gotURL, urlErr := git(dir, "remote", "get-url", remote)
	got := canonicalizeRepoURL(gotURL)
	if want != "" && got != "" && want == got {
		return nil
	}
	wantRoot := strings.ToLower(strings.TrimSpace(src.RootCommitSha))
	gotRoots := repoRootCommits(dir)
	if wantRoot != "" {
		for _, root := range gotRoots {
			if root == wantRoot {
				return nil
			}
		}
	}
	detail := map[string]interface{}{
		"expectedRepoUrl":       src.RepoURL,
		"actualRepoUrl":         gotURL,
		"remoteName":            remote,
		"expectedRootCommitSha": src.RootCommitSha,
		"actualRootCommitShas":  gotRoots,
		"codebaseId":            src.CodebaseID,
	}
	if urlErr != nil {
		// Not a different repository — a checkout that states no identity at all. Same refusal:
		// "I cannot show this is the right repository" and "this is the wrong one" both have to
		// fail closed, and both are fixed by the same action (point the workspace at the repo).
		detail["reason"] = "this checkout has no " + remote + " remote to identify it by"
		detail["stderr"] = gitStderr(urlErr)
	}
	return &SourcePinRefusal{Code: sourceRefusalRepoMismatch, Detail: detail}
}
