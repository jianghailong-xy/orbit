package main

import (
	"bytes"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// execwatch records every process whose argv[0] starts with prefix, with the uids it runs under,
// until it is killed. It is the run's own witness that hostd never executes a download as root:
// installRelease runs the freshly downloaded file from <binary>.new-<pid> to ask it its version and
// its write contract, and those execs are what this sees.
//
// It polls /proc, which a short-lived process can in principle slip between: the script asserts
// that it saw at least one exec, so a miss fails the run rather than passing it unwitnessed.
func execwatch(prefix, out string) error {
	f, err := os.OpenFile(out, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	seen := map[string]bool{}
	for {
		entries, err := os.ReadDir("/proc")
		if err != nil {
			return err
		}
		for _, e := range entries {
			pid := e.Name()
			if _, err := strconv.Atoi(pid); err != nil {
				continue
			}
			cmdline, err := os.ReadFile("/proc/" + pid + "/cmdline")
			if err != nil || !bytes.HasPrefix(cmdline, []byte(prefix)) {
				continue
			}
			status, err := os.ReadFile("/proc/" + pid + "/status")
			if err != nil {
				continue
			}
			// The same pid with the same argv is one exec, however many polls catch it.
			key := pid + "\x00" + string(cmdline)
			if seen[key] {
				continue
			}
			seen[key] = true
			argv := strings.Split(strings.TrimRight(string(cmdline), "\x00"), "\x00")
			fmt.Fprintf(f, "pid=%s uids=%s argv=%q\n", pid, statusUids(status), argv)
		}
		time.Sleep(500 * time.Microsecond)
	}
}

// statusUids is the real, effective, saved and filesystem uid from /proc/<pid>/status, comma-joined.
func statusUids(status []byte) string {
	for _, line := range strings.Split(string(status), "\n") {
		if rest, ok := strings.CutPrefix(line, "Uid:"); ok {
			return strings.Join(strings.Fields(rest), ",")
		}
	}
	return "?"
}
