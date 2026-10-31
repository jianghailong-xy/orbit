//go:build unix

package main

import (
	"testing"
)

// The rule this verb exists around, asserted where it is actually enforced: every command that
// runs the downloaded binary — the version self-test and the write-contract check alike — carries
// a Credential, so the exec lands as the account that asked and not as the root daemon that
// fetched it.
func TestHostdUpdateProbesTheDownloadAsTheCallerNotAsRoot(t *testing.T) {
	h := newHostdUpdateHarness(t, rolloutTestPrevious, newRolloutRelease(t, rolloutTestLatest))

	if resp := h.ask(1000); !resp.OK {
		t.Fatalf("update failed: %s", resp.Error)
	}
	if len(h.probed) != 2 {
		t.Fatalf("probed %d times, want the version and the write-contract checks", len(h.probed))
	}
	for _, probe := range h.probed {
		attr := probe.SysProcAttr
		if attr == nil || attr.Credential == nil {
			t.Fatalf("%v ran the download with no credential — as root", probe.Args)
		}
		if got := attr.Credential.Uid; got != 1000 {
			t.Errorf("%v: uid = %d, want the caller's 1000", probe.Args, got)
		}
		if got := attr.Credential.Gid; got != 1000 {
			t.Errorf("%v: gid = %d, want the caller's primary group 1000", probe.Args, got)
		}
		if attr.Credential.NoSetGroups {
			t.Errorf("%v kept root's supplementary groups", probe.Args)
		}
		if len(attr.Credential.Groups) != 0 {
			t.Errorf("%v: groups = %v, want none", probe.Args, attr.Credential.Groups)
		}
	}
}

// Dropping is what a root daemon owes its caller, not a ritual: an unprivileged hostd (a developer
// running it in the foreground) already has no privileges to shed, and asking for a Credential it
// cannot set would only fail the exec.
func TestHostdUpdateProbeDoesNotTryToDropWhenItIsNotRoot(t *testing.T) {
	h := newHostdUpdateHarness(t, rolloutTestPrevious, newRolloutRelease(t, rolloutTestLatest))
	h.update.geteuid = func() int { return 1000 }

	if resp := h.ask(1000); !resp.OK {
		t.Fatalf("update failed: %s", resp.Error)
	}
	if len(h.probed) != 2 {
		t.Fatalf("probed %d times, want 2", len(h.probed))
	}
	for _, probe := range h.probed {
		if attr := probe.SysProcAttr; attr != nil && attr.Credential != nil {
			t.Errorf("an unprivileged hostd tried to setuid for %v: %+v", probe.Args, *attr.Credential)
		}
	}
}

// And uid 0 is only refused where the refusal means something: on a root daemon. A foreground
// hostd running as an ordinary user has nothing to escalate.
func TestHostdUpdateFromRootIsRefusedOnlyByARootDaemon(t *testing.T) {
	h := newHostdUpdateHarness(t, rolloutTestPrevious, newRolloutRelease(t, rolloutTestLatest))
	h.update.geteuid = func() int { return 1000 }

	resp := h.ask(0)
	if !resp.OK {
		t.Fatalf("an unprivileged hostd refused a uid 0 caller: %s", resp.Error)
	}
	if len(h.probed) != 2 {
		t.Fatalf("probed %d times, want 2", len(h.probed))
	}
	for _, probe := range h.probed {
		if attr := probe.SysProcAttr; attr != nil && attr.Credential != nil {
			t.Errorf("probe %v asked to setuid without being root: %+v", probe.Args, *attr.Credential)
		}
	}
}
