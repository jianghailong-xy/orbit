//go:build !linux

package main

import (
	"fmt"
	"os/exec"
	"runtime"
)

// Background job limits need Linux cgroup v2 (bg_cgroup_linux.go). Elsewhere a job runs without them, and
// bg_run says so.

func setupBgCgroups() {}

type bgJobCgroup struct{}

func newBgJobCgroup(string, bgJobLimits) (*bgJobCgroup, error) {
	return nil, fmt.Errorf("CPU and memory limits need Linux cgroup v2, and this runner runs on %s", runtime.GOOS)
}

func (*bgJobCgroup) attach(*exec.Cmd) {}
func (*bgJobCgroup) started()         {}
func (*bgJobCgroup) oomKilled() bool  { return false }
func (*bgJobCgroup) remove()          {}
func (*bgJobCgroup) killAll()         {}

func adoptBgJobCgroup(string) *bgJobCgroup { return nil }
