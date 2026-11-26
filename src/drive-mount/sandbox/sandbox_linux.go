//go:build linux

// Package sandbox locks the mount daemon down once it holds what it needs (docs/drive-technical-design.md
// §5.1): the daemon parses what agents write, so it keeps no privilege. It already runs as an unprivileged user with
// no capabilities; this adds no_new_privs, makes it undumpable (so no process of the same user can read its memory or
// its /proc files, where another runner's daemon would find its credential), and a seccomp filter refusing the
// system calls a FUSE server never makes: mounting, namespaces, tracing, modules, keys, BPF.
package sandbox

import (
	"fmt"
	"runtime"
	"syscall"
	"unsafe"

	"golang.org/x/sys/unix"
)

// denied are the system calls the filter answers EPERM.
var denied = []uintptr{
	unix.SYS_MOUNT, unix.SYS_UMOUNT2, unix.SYS_PIVOT_ROOT, unix.SYS_CHROOT,
	unix.SYS_FSOPEN, unix.SYS_FSCONFIG, unix.SYS_FSMOUNT, unix.SYS_FSPICK, unix.SYS_MOVE_MOUNT, unix.SYS_OPEN_TREE,
	unix.SYS_MOUNT_SETATTR,
	unix.SYS_UNSHARE, unix.SYS_SETNS,
	unix.SYS_PTRACE, unix.SYS_PROCESS_VM_READV, unix.SYS_PROCESS_VM_WRITEV, unix.SYS_PIDFD_GETFD,
	unix.SYS_KEXEC_LOAD, unix.SYS_KEXEC_FILE_LOAD, unix.SYS_INIT_MODULE, unix.SYS_FINIT_MODULE, unix.SYS_DELETE_MODULE,
	unix.SYS_BPF, unix.SYS_PERF_EVENT_OPEN, unix.SYS_USERFAULTFD,
	unix.SYS_KEYCTL, unix.SYS_ADD_KEY, unix.SYS_REQUEST_KEY,
	unix.SYS_OPEN_BY_HANDLE_AT, unix.SYS_NAME_TO_HANDLE_AT,
	unix.SYS_SWAPON, unix.SYS_SWAPOFF, unix.SYS_REBOOT, unix.SYS_ACCT, unix.SYS_QUOTACTL,
	unix.SYS_SETTIMEOFDAY, unix.SYS_CLOCK_SETTIME, unix.SYS_ADJTIMEX, unix.SYS_CLOCK_ADJTIME,
	unix.SYS_SETHOSTNAME, unix.SYS_SETDOMAINNAME, unix.SYS_PERSONALITY, unix.SYS_VHANGUP,
}

const (
	seccompRetAllow = 0x7fff0000
	seccompRetErrno = 0x00050000
	x32Bit          = 0x40000000
)

func auditArch() (uint32, error) {
	switch runtime.GOARCH {
	case "amd64":
		return 0xc000003e, nil // AUDIT_ARCH_X86_64
	case "arm64":
		return 0xc00000b7, nil // AUDIT_ARCH_AARCH64
	}
	return 0, fmt.Errorf("no seccomp filter for %s", runtime.GOARCH)
}

func stmt(code uint16, k uint32) unix.SockFilter { return unix.SockFilter{Code: code, K: k} }

func jump(code uint16, k uint32, jt, jf uint8) unix.SockFilter {
	return unix.SockFilter{Code: code, Jt: jt, Jf: jf, K: k}
}

// filter is the BPF program: another architecture's calls, and x32's, are refused; each denied call answers EPERM.
func filter() ([]unix.SockFilter, error) {
	arch, err := auditArch()
	if err != nil {
		return nil, err
	}
	eperm := uint32(seccompRetErrno | uint32(syscall.EPERM))
	prog := []unix.SockFilter{
		stmt(unix.BPF_LD|unix.BPF_W|unix.BPF_ABS, 4), // seccomp_data.arch
		jump(unix.BPF_JMP|unix.BPF_JEQ|unix.BPF_K, arch, 1, 0),
		stmt(unix.BPF_RET|unix.BPF_K, eperm),
		stmt(unix.BPF_LD|unix.BPF_W|unix.BPF_ABS, 0), // seccomp_data.nr
	}
	if runtime.GOARCH == "amd64" {
		prog = append(prog,
			jump(unix.BPF_JMP|unix.BPF_JGE|unix.BPF_K, x32Bit, 0, 1),
			stmt(unix.BPF_RET|unix.BPF_K, eperm),
		)
	}
	for _, nr := range denied {
		prog = append(prog,
			jump(unix.BPF_JMP|unix.BPF_JEQ|unix.BPF_K, uint32(nr), 0, 1),
			stmt(unix.BPF_RET|unix.BPF_K, eperm),
		)
	}
	prog = append(prog, stmt(unix.BPF_RET|unix.BPF_K, seccompRetAllow))
	return prog, nil
}

// Lockdown applies no_new_privs and the filter to every thread of the process, and makes it undumpable.
func Lockdown() error {
	if err := unix.Prctl(unix.PR_SET_DUMPABLE, 0, 0, 0, 0); err != nil {
		return fmt.Errorf("PR_SET_DUMPABLE: %w", err)
	}
	if _, _, errno := syscall.AllThreadsSyscall(syscall.SYS_PRCTL, unix.PR_SET_NO_NEW_PRIVS, 1, 0); errno != 0 {
		return fmt.Errorf("PR_SET_NO_NEW_PRIVS: %w", errno)
	}
	prog, err := filter()
	if err != nil {
		return err
	}
	fprog := unix.SockFprog{Len: uint16(len(prog)), Filter: &prog[0]}
	if _, _, errno := unix.Syscall(unix.SYS_SECCOMP, unix.SECCOMP_SET_MODE_FILTER, unix.SECCOMP_FILTER_FLAG_TSYNC,
		uintptr(unsafe.Pointer(&fprog))); errno != 0 {
		return fmt.Errorf("seccomp: %w", errno)
	}
	runtime.KeepAlive(prog)
	return nil
}
