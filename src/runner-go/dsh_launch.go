package main

import "context"

const providerDsh = "dsh"
const dshSupportedVersion = "0.2.0-rc.2"

// DshLaunchSpec is P0's boundary between environment preparation and ACP.
// Env is supplied by the environment preparer; the driver never adds ambient credentials.
type DshLaunchSpec struct {
	Executable string
	Args       []string
	Env        []string
	Cwd        string
	DshHome    string
	Version    string
	ConfigHash string
}

// prepareDshSessionLaunch is the production seam to P2's preparer. P2's executionDir is
// the session checkout, never the run's disposable scratch directory, and its file policy
// must be one P0 verified; the preparer itself rejects anything else.
var prepareDshSessionLaunch = func(ctx context.Context, job *ClaimedSession, execDir string) (DshLaunchSpec, error) {
	return PrepareDshSessionLaunch(ctx, job, execDir, dshFileModeForPermission(job.Agent.PermissionMode))
}

// dsh has two verified file policies. Plan mode never writes; every other Orbit mode gets the
// workspace sandbox and never more, since writes outside it reach dsh's permission request.
func dshFileModeForPermission(mode string) string {
	if mode == "plan" {
		return "read-only"
	}
	return "workspace-write"
}
