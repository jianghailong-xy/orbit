package main

import (
	"slices"
	"strings"
	"testing"
)

// An OOM kill of one process in the runner's unit must not stop the runner. A session's
// processes (a test's tsc, chrome, Gradle) run in the runner's own cgroup, and systemd's default,
// OOMPolicy=stop, answers the kernel killing any one of them by stopping the whole unit: the
// runner drains for 100 s, tears down every turn still running at the drain timeout, and the
// restart then installs any deferred release at startup, before the turn gate exists.
//
// That is what stopped four running turns on workstation-gpu on 2026-11-10: the kernel killed a
// tsc in orbit-runner-root.service at 16:16:15Z, the runner began its stop at 16:16:15.780Z,
// tore the turns down at 16:17:55Z, systemd restarted it at 16:18:05Z ("Failed with result
// 'oom-kill'"), and the new 0.1.251 process updated itself to 0.1.252 at 16:18:06Z with no
// session open. The same path stopped it on 2026-10-09.
//
// Both units this binary writes must therefore keep the runner up: the per-user unit
// installSystemd writes and the per-account template `orbit host setup` writes.
func TestARunnerUnitSurvivesAnOOMKillInsideIt(t *testing.T) {
	units := map[string]string{
		"renderSystemdUnit":  renderSystemdUnit("alice", "alice", "/home/alice/.orbit/bin/orbit", "/home/alice", "/home/alice/.orbit", "/usr/bin:/bin", nil),
		"hostRunnerTemplate": hostRunnerTemplate(),
	}
	for name, unit := range units {
		directives := unitDirectives(unit)
		service := slices.Index(directives, "[Service]")
		install := slices.Index(directives, "[Install]")
		if service < 0 || install < service {
			t.Fatalf("%s has no [Service] section before [Install]:\n%s", name, unit)
		}
		policies := 0
		for i, d := range directives {
			if strings.HasPrefix(d, "OOMPolicy=") {
				policies++
				if d != "OOMPolicy=continue" || i < service || i > install {
					t.Errorf("%s sets %q at directive %d, want OOMPolicy=continue inside [Service]", name, d, i)
				}
			}
		}
		if policies != 1 {
			t.Errorf("%s sets OOMPolicy %d time(s), want once (OOMPolicy=continue): systemd's default stops the runner on any OOM kill in its unit\n%s", name, policies, unit)
		}
	}
}
