package main

import (
	"context"
	"fmt"
)

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

// P2 installs this preparer when its environment implementation is integrated.
// Keeping preparation outside the driver avoids a second credential/configuration path.
var prepareDshSessionLaunch = func(ctx context.Context, job *ClaimedSession, scratchDir, execDir string) (DshLaunchSpec, error) {
	return DshLaunchSpec{}, fmt.Errorf("DeepSeek Harness session environment is not available; integrate the dsh environment preparer before starting production sessions")
}
