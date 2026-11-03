//go:build darwin

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"
)

// launchd itself answers whether the window in the plist is real: it reads the plist register writes, says what
// it will give, and then stops a job that takes the longest a Mac's stop can take to leave. A job launchd kills
// never writes the file it writes on its way out. Run on GitHub's Macs by .github/workflows/runner-launchd.yml.
func TestLaunchdGivesTheRunnerItsWholeStop(t *testing.T) {
	if testing.Short() {
		t.Skip("sits through a whole stop")
	}
	latest := hostStopBudget.envelope() + shutdownLastBeatWait + linkCloseWait
	dir := t.TempDir()
	label := fmt.Sprintf("com.orbit.probe.stop-%d", os.Getpid())
	ready := filepath.Join(dir, "ready")
	left := filepath.Join(dir, "left-by-itself")
	exe := filepath.Join(dir, "orbit")
	stub := fmt.Sprintf(`#!/bin/bash
trap 'sleep %d; : > %q; exit 0' TERM
: > %q
while :; do sleep 1; done
`, int(latest.Seconds()), left, ready)
	if err := os.WriteFile(exe, []byte(stub), 0o755); err != nil {
		t.Fatal(err)
	}

	uid := launchdUID()
	plist := renderLaunchdPlist(exe, dir, label, dir, "/usr/bin:/bin", filepath.Join(dir, "log"), launchdNeedsBackground(uid), nil)
	plistPath := filepath.Join(dir, label+".plist")
	if err := os.WriteFile(plistPath, []byte(plist), 0o644); err != nil {
		t.Fatal(err)
	}
	domain := launchdDomain(plist, uid)
	target := domain + "/" + label
	if out, err := exec.Command("launchctl", "bootstrap", domain, plistPath).CombinedOutput(); err != nil {
		t.Fatalf("launchctl bootstrap %s: %v: %s", domain, err, out)
	}
	t.Cleanup(func() {
		_ = exec.Command("launchctl", "bootout", target).Run()
		_ = exec.Command("launchctl", "kill", "SIGKILL", target).Run()
	})

	printed, err := exec.Command("launchctl", "print", target).CombinedOutput()
	if err != nil {
		t.Fatalf("launchctl print %s: %v: %s", target, err, printed)
	}
	match := regexp.MustCompile(`(?m)^\s*exit timeout = (\d+)$`).FindSubmatch(printed)
	if match == nil {
		t.Fatalf("launchctl print does not say the exit timeout any more:\n%s", printed)
	}
	seconds, _ := strconv.Atoi(string(match[1]))
	if time.Duration(seconds)*time.Second <= latest {
		t.Fatalf("launchd gives %d s for a plist asking %d, and a Mac's stop can take %v", seconds, launchdExitTimeOutSeconds, latest)
	}
	pid := regexp.MustCompile(`(?m)^\s*pid = (\d+)$`).FindSubmatch(printed)
	if pid == nil {
		t.Fatalf("launchd did not start the job:\n%s", printed)
	}
	waitForFile := func(path string, within time.Duration) bool {
		deadline := time.Now().Add(within)
		for time.Now().Before(deadline) {
			if _, err := os.Stat(path); err == nil {
				return true
			}
			time.Sleep(100 * time.Millisecond)
		}
		return false
	}
	if !waitForFile(ready, 10*time.Second) {
		t.Fatal("the job never got as far as waiting for its signal")
	}

	began := time.Now()
	if out, err := exec.Command("launchctl", "bootout", target).CombinedOutput(); err != nil {
		t.Fatalf("launchctl bootout: %v: %s", err, out)
	}
	for time.Since(began) < time.Duration(seconds+10)*time.Second {
		if out, err := exec.Command("ps", "-p", string(pid[1]), "-o", "pid=").Output(); err != nil || strings.TrimSpace(string(out)) == "" {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	took := time.Since(began)
	if _, err := os.Stat(left); err != nil {
		t.Fatalf("launchd killed a job %v into a stop that takes %v: the runner would be killed mid-stop too", took.Round(time.Second), latest)
	}
	t.Logf("launchd says %d s; the job left by itself %v into the stop", seconds, took.Round(100*time.Millisecond))
}
