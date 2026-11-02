//go:build linux || darwin

package main

import (
	"path/filepath"
	"strings"
	"testing"
)

// TestIntegrationFetchFailureCodes is what a landing's and a promotion's FETCH reports when the fetch
// got nowhere (J-S1, M-S1). BASE_REF_NOT_FOUND and SOURCE_BRANCH_MISSING say that a branch is missing,
// and a reader acts on them by going to look at it, so they are given only when the remote answered and
// has no such ref. A remote that refused the saved credential, or that could not be reached, is
// FETCH_FAILED, and the detail says what happened.
//
// Not parallel: the remote that refuses the credential is newCredentialFixture's, which sets the user's
// git configuration with t.Setenv.
func TestIntegrationFetchFailureCodes(t *testing.T) {
	// The two jobs whose fetch this is: a LAND_TASK of one task's branch onto a project branch
	// (integrateOnce), and the owner-confirmed LAND_PROMOTION of a checked project branch (promoteOnce).
	land := func(t *testing.T, r *integrationRepo) IntegrationJobCommand {
		r.checkoutNew("task/a", "main")
		r.write("a.txt", "from a\n")
		r.commit("task a")
		r.push("task/a")
		r.checkout("main")
		return r.command("task/a", "project/line")
	}
	promote := func(t *testing.T, r *integrationRepo) IntegrationJobCommand {
		sourceSha, checked := checkedProjectBranch(t, r)
		return ownerLanding(r, sourceSha, checked)
	}

	// What makes the fetch fail, once the job is ready to run. Each answers the ref the failure is
	// about.
	//
	// origin answers every request 401, and the user has a credential saved for it.
	refusing := func(t *testing.T, r *integrationRepo, cmd *IntegrationJobCommand) string {
		url := mustGit(t, newCredentialFixture(t, true).work, "remote", "get-url", "origin")
		mustRun(t, r.work, "git", "remote", "set-url", "origin", url)
		return cmd.UpstreamRef
	}
	// origin names a path no repository was ever made at.
	unreachable := func(t *testing.T, r *integrationRepo, cmd *IntegrationJobCommand) string {
		mustRun(t, r.work, "git", "remote", "set-url", "origin", filepath.Join(t.TempDir(), "no-such-repository"))
		return cmd.UpstreamRef
	}
	// origin answers, and has no such upstream.
	upstreamMissing := func(t *testing.T, r *integrationRepo, cmd *IntegrationJobCommand) string {
		cmd.UpstreamRef = "refs/heads/no-such-branch"
		return cmd.UpstreamRef
	}
	// origin answers, and the project branch was deleted from it after its check.
	sourceMissing := func(t *testing.T, r *integrationRepo, cmd *IntegrationJobCommand) string {
		mustRun(t, r.work, "git", "push", "--quiet", "origin", "--delete", "project/p")
		return cmd.SourceRef
	}

	const refused = "the remote refused the saved Git credential"
	cases := []struct {
		name   string
		job    func(*testing.T, *integrationRepo) IntegrationJobCommand
		fail   func(*testing.T, *integrationRepo, *IntegrationJobCommand) string
		code   string
		detail string // what the detail must say; "" when it only has to say something
	}{
		{"land_credential_refused", land, refusing, "FETCH_FAILED", refused},
		{"land_remote_unreachable", land, unreachable, "FETCH_FAILED", "no-such-repository"},
		{"land_upstream_missing", land, upstreamMissing, "BASE_REF_NOT_FOUND", ""},
		{"promote_credential_refused", promote, refusing, "FETCH_FAILED", refused},
		{"promote_remote_unreachable", promote, unreachable, "FETCH_FAILED", "no-such-repository"},
		{"promote_upstream_missing", promote, upstreamMissing, "BASE_REF_NOT_FOUND", ""},
		{"promote_source_missing", promote, sourceMissing, "SOURCE_BRANCH_MISSING", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := newIntegrationRepo(t)
			cmd := c.job(t, r)
			ref := c.fail(t, r, &cmd)

			result := runIntegrationJob(cmd, silent)
			if result.State != "ERROR" || result.Phase != "FETCH" || result.ErrorCode != c.code {
				t.Fatalf("result = %s %s (%s %v), want ERROR FETCH %s",
					result.State, result.Phase, result.ErrorCode, result.ErrorDetail, c.code)
			}
			if got, _ := result.ErrorDetail["ref"].(string); got != ref {
				t.Errorf("errorDetail = %v, want it to name %s, the ref the failed fetch was for", result.ErrorDetail, ref)
			}
			if detail, _ := result.ErrorDetail["detail"].(string); detail == "" || !strings.Contains(detail, c.detail) {
				t.Errorf("the detail is %q, want it to say %q", detail, c.detail)
			}
		})
	}
}
