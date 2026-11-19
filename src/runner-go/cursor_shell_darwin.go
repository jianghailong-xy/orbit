package main

import (
	"bytes"
	"encoding/binary"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/unix"
)

const (
	cursorDarwinPIDInfo       = 2  // PROC_INFO_CALL_PIDINFO
	cursorDarwinBSDInfo       = 3  // PROC_PIDTBSDINFO
	cursorDarwinVnodePathInfo = 9  // PROC_PIDVNODEPATHINFO
	cursorDarwinPathInfo      = 11 // PROC_PIDPATHINFO
	cursorDarwinXucredVersion = 0  // XUCRED_VERSION
)

// proc_info is the kernel interface used by libproc's proc_pidinfo and
// proc_pidpath. Calling it directly keeps the runner cgo-free. Layouts and
// flavors below are from Darwin's sys/proc_info.h (identical on arm64/amd64).
func cursorDarwinProcInfo(pid, flavor int, data []byte) bool {
	if pid <= 0 || len(data) == 0 {
		return false
	}
	n, _, err := syscall.Syscall6(unix.SYS_PROC_INFO, cursorDarwinPIDInfo, uintptr(pid), uintptr(flavor), 0, uintptr(unsafe.Pointer(&data[0])), uintptr(len(data)))
	return err == 0 && int(n) == len(data)
}

type cursorDarwinProcess struct {
	pid, parent int
	uid         uint32
	start, path string
	argv, env   []string
	cwd         string
}

func cursorDarwinBSD(pid int) (cursorDarwinProcess, bool) {
	var data [136]byte // struct proc_bsdinfo
	if !cursorDarwinProcInfo(pid, cursorDarwinBSDInfo, data[:]) {
		return cursorDarwinProcess{}, false
	}
	p := cursorDarwinProcess{pid: int(binary.LittleEndian.Uint32(data[12:])), parent: int(binary.LittleEndian.Uint32(data[16:])), uid: binary.LittleEndian.Uint32(data[20:])}
	sec, usec := binary.LittleEndian.Uint64(data[120:]), binary.LittleEndian.Uint64(data[128:])
	if p.pid != pid || sec == 0 || usec >= 1000000 {
		return cursorDarwinProcess{}, false
	}
	p.start = strconv.FormatUint(sec, 10) + ":" + strconv.FormatUint(usec, 10)
	return p, true
}

func cursorShellStartIdentity(pid int) string {
	p, ok := cursorDarwinBSD(pid)
	if !ok {
		return ""
	}
	return p.start
}

func cursorDarwinPath(pid int) string {
	var data [4096]byte // PROC_PIDPATHINFO_MAXSIZE
	// The kernel returns zero on success; libproc derives its return length from the NUL.
	_, _, err := syscall.Syscall6(unix.SYS_PROC_INFO, cursorDarwinPIDInfo, uintptr(pid), cursorDarwinPathInfo, 0, uintptr(unsafe.Pointer(&data[0])), uintptr(len(data)))
	if pid <= 0 || err != 0 {
		return ""
	}
	end := bytes.IndexByte(data[:], 0)
	if end <= 0 || data[0] != '/' {
		return ""
	}
	return string(data[:end])
}

func cursorDarwinArgs(pid int) (argv, env []string, ok bool) {
	data, err := unix.SysctlRaw("kern.procargs2", pid)
	if err != nil || len(data) < 5 {
		return nil, nil, false
	}
	argc := int(binary.LittleEndian.Uint32(data))
	if argc < 1 || argc > len(data) {
		return nil, nil, false
	}
	data = data[4:]
	end := bytes.IndexByte(data, 0) // saved executable path, followed by padding
	if end < 0 {
		return nil, nil, false
	}
	data = bytes.TrimLeft(data[end:], "\x00")
	for i := 0; i < argc; i++ {
		end = bytes.IndexByte(data, 0)
		if end < 0 {
			return nil, nil, false
		}
		argv = append(argv, string(data[:end]))
		data = data[end+1:]
	}
	for len(data) > 0 && data[0] != 0 {
		end = bytes.IndexByte(data, 0)
		if end < 0 {
			return nil, nil, false
		}
		env = append(env, string(data[:end]))
		data = data[end+1:]
	}
	return argv, env, true
}

func cursorDarwinReadProcess(pid int, context bool) (cursorDarwinProcess, bool) {
	p, ok := cursorDarwinBSD(pid)
	if !ok {
		return p, false
	}
	p.path = cursorDarwinPath(pid)
	p.argv, p.env, ok = cursorDarwinArgs(pid)
	if !ok || p.path == "" {
		return p, false
	}
	if context {
		var data [2352]byte // proc_vnodepathinfo: two 1176-byte vnode_info_path
		if !cursorDarwinProcInfo(pid, cursorDarwinVnodePathInfo, data[:]) {
			return p, false
		}
		path := data[152:1176] // vnode_info (152 bytes), then vip_path[MAXPATHLEN]
		end := bytes.IndexByte(path, 0)
		if end <= 0 || path[0] != '/' {
			return p, false
		}
		p.cwd = string(path[:end])
	}
	// Reject a PID recycled during the multi-call snapshot, or a reparented process.
	after, ok := cursorDarwinBSD(pid)
	return p, ok && after.start == p.start && after.parent == p.parent && after.uid == p.uid && cursorDarwinPath(pid) == p.path
}

func cursorDarwinPeer(conn net.Conn) (pid int, uid uint32, ok bool) {
	uc, ok := conn.(*net.UnixConn)
	if !ok {
		return 0, 0, false
	}
	raw, err := uc.SyscallConn()
	if err != nil {
		return 0, 0, false
	}
	var cred *unix.Xucred
	var peerErr error
	err = raw.Control(func(fd uintptr) {
		pid, peerErr = unix.GetsockoptInt(int(fd), unix.SOL_LOCAL, unix.LOCAL_PEERPID)
		if peerErr == nil {
			cred, peerErr = unix.GetsockoptXucred(int(fd), unix.SOL_LOCAL, unix.LOCAL_PEERCRED)
		}
	})
	if err != nil || peerErr != nil || cred == nil || cred.Version != cursorDarwinXucredVersion || pid <= 0 {
		return 0, 0, false
	}
	return pid, cred.Uid, true
}

func cursorShellPeer(conn net.Conn, cliPID int, helper, cliDir, configPath, cliStart string) (string, string, bool) {
	pid, uid, ok := cursorDarwinPeer(conn)
	if !ok {
		return "", "", false
	}
	return cursorDarwinAuthenticate(pid, uid, cliPID, helper, cliDir, configPath, cliStart)
}

func cursorDarwinSameFile(path string, want os.FileInfo) bool {
	actual, err := os.Stat(path)
	return err == nil && os.SameFile(actual, want)
}

func cursorDarwinAuthenticate(pid int, uid uint32, cliPID int, helper, cliDir, configPath, cliStart string) (string, string, bool) {
	if uid != uint32(os.Getuid()) || cliPID <= 0 || cliStart == "" || cursorShellStartIdentity(cliPID) != cliStart {
		return "", "", false
	}
	p, ok := cursorDarwinReadProcess(pid, true)
	want, err := os.Stat(helper)
	if !ok || p.uid != uid || err != nil || !cursorDarwinSameFile(p.path, want) {
		return "", "", false
	}
	if len(p.argv) != 8 || p.argv[1] != cursorShellCommand || p.argv[2] != configPath || !cursorLoaderArgs(p.argv[3:]) {
		return "", "", false
	}
	cliDir, err = filepath.EvalSymlinks(cliDir)
	if err != nil {
		return "", "", false
	}
	parent, ok := cursorDarwinReadProcess(p.parent, false)
	if !ok || (parent.path != filepath.Join(cliDir, "node") && parent.path != filepath.Join(cliDir, "cursor-agent-sea")) {
		return "", "", false
	}
	// As on Linux, only runner scope/recording processes may bridge to the CLI.
	chain := []cursorDarwinProcess{p}
	found := false
	for n := 0; parent.pid > 1 && n < 16; n++ {
		chain = append(chain, parent)
		if parent.pid == cliPID {
			found = true
			break
		}
		parent, ok = cursorDarwinReadProcess(parent.parent, false)
		if !ok {
			return "", "", false
		}
		if parent.pid != cliPID && (!cursorDarwinSameFile(parent.path, want) || strings.Contains(strings.Join(parent.argv, "\x00"), cursorShellCommand)) {
			return "", "", false
		}
	}
	if !found {
		return "", "", false
	}
	// Revalidate every generation after walking ancestry, including the anchor.
	for _, process := range chain {
		after, ok := cursorDarwinBSD(process.pid)
		if !ok || after.start != process.start || after.parent != process.parent || after.uid != process.uid || cursorDarwinPath(process.pid) != process.path {
			return "", "", false
		}
	}
	if cursorShellStartIdentity(cliPID) != cliStart {
		return "", "", false
	}
	conversation := ""
	for _, entry := range p.env {
		if value, ok := strings.CutPrefix(entry, "CURSOR_CONVERSATION_ID="); ok {
			if value == "" || conversation != "" {
				return "", "", false
			}
			conversation = value
		}
	}
	return p.cwd, conversation, conversation != ""
}
