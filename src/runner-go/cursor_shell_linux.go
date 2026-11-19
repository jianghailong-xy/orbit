package main

import (
	"bytes"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// AF_UNIX has a short sockaddr path limit, even when the session directory is
// long. Resolve the same socket relative to an open directory descriptor.
func cursorShellSocketPath(path string) (string, func(), error) {
	dir, err := os.Open(filepath.Dir(path))
	if err != nil {
		return "", func() {}, err
	}
	return filepath.Join("/proc/self/fd", strconv.FormatUint(uint64(dir.Fd()), 10), filepath.Base(path)), func() { _ = dir.Close() }, nil
}

// Only the installed helper, directly spawned by this live CLI, may consume.
// Same UID or a claimed PID alone is insufficient. A shell inside bwrap has its
// own PID namespace and /proc, and cannot become this host CLI's direct child.
func cursorShellPeer(conn net.Conn, cliPID int, helper, cliDir, configPath, cliStart string) (string, string, bool) {
	peer, err := hostdPeerCredential(conn)
	if err != nil || int(peer.UID) != os.Getuid() || cliPID <= 0 || cliStart == "" || cursorShellStartIdentity(cliPID) != cliStart {
		return "", "", false
	}
	pid := int(peer.PID)
	path := filepath.Join("/proc", strconv.Itoa(pid))
	actual, err := os.Stat(path + "/exe")
	if err != nil {
		return "", "", false
	}
	want, err := os.Stat(helper)
	if err != nil || !os.SameFile(actual, want) {
		return "", "", false
	}
	argv, err := os.ReadFile(path + "/cmdline")
	if err != nil {
		return "", "", false
	}
	parts := bytes.Split(argv, []byte{0})
	if len(parts) != 9 || string(parts[1]) != cursorShellCommand || string(parts[2]) != configPath {
		return "", "", false
	}
	args := make([]string, 0, 5)
	for _, p := range parts[3 : len(parts)-1] {
		args = append(args, string(p))
	}
	if !cursorLoaderArgs(args) {
		return "", "", false
	}
	parent := cursorShellParent(pid)
	parentExe, err := os.Readlink(filepath.Join("/proc", strconv.Itoa(parent), "exe"))
	if err != nil || (parentExe != filepath.Join(cliDir, "node") && parentExe != filepath.Join(cliDir, "cursor-agent-sea")) {
		return "", "", false
	}
	// Only runner scope/recording processes may separate the CLI from its anchor.
	// An arbitrary descendant, even one running the pinned node, is insufficient.
	found := false
	for p, n := parent, 0; p > 1 && n < 16; n++ {
		if p == cliPID {
			found = true
			break
		}
		p = cursorShellParent(p)
		if p != cliPID {
			info, err := os.Stat(filepath.Join("/proc", strconv.Itoa(p), "exe"))
			if err != nil || !os.SameFile(info, want) {
				return "", "", false
			}
			line, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(p), "cmdline"))
			if err != nil || bytes.Contains(line, []byte(cursorShellCommand)) {
				return "", "", false
			}
		}
	}
	if !found {
		return "", "", false
	}
	cwd, err := os.Readlink(path + "/cwd")
	if err != nil {
		return "", "", false
	}
	env, err := os.ReadFile(path + "/environ")
	if err != nil {
		return "", "", false
	}
	for _, entry := range bytes.Split(env, []byte{0}) {
		if value, ok := strings.CutPrefix(string(entry), "CURSOR_CONVERSATION_ID="); ok && value != "" {
			return cwd, value, true
		}
	}
	return "", "", false
}

func cursorShellStartIdentity(pid int) string {
	data, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "stat"))
	if err != nil {
		return ""
	}
	i := strings.LastIndex(string(data), ") ")
	if i < 0 {
		return ""
	}
	fields := strings.Fields(string(data)[i+2:])
	if len(fields) < 20 {
		return ""
	}
	return fields[19]
}

func cursorShellParent(pid int) int {
	data, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "stat"))
	if err != nil {
		return 0
	}
	i := strings.LastIndex(string(data), ") ")
	if i < 0 {
		return 0
	}
	fields := strings.Fields(string(data)[i+2:])
	if len(fields) < 2 {
		return 0
	}
	parent, _ := strconv.Atoi(fields[1])
	return parent
}
