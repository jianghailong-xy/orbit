//go:build linux

// Package parent is the privileged parent of one runner's mount daemon (docs/drive-technical-design.md
// §5.1, §5.7, §5.8): it opens /dev/fuse, mounts fuse.orbit-drive at <root>/drive, and starts the daemon with the FUSE
// descriptor inherited, as an unprivileged user with no capabilities, which serves it through go-fuse's /dev/fd/N
// mountpoint. It is what the CSI plugin (Kubernetes) or the Docker mounter runs per runner.
//
//   - A daemon that dies is replaced: the dead mount is lazily unmounted and mounted again, and the parent-directory
//     layout lets the running runner see the new mount (row 53).
//   - A watchdog stats the mount's root every 10 s, forcing the kernel to ask the daemon, which answers it from memory,
//     never the server, so an outage is not a freeze. A miss of 5 s aborts the FUSE connection (callers get ENOTCONN
//     at once), kills the daemon and mounts again (row 54).
//   - It answers the daemon's "which session is host pid P?" from /proc, for attribution (§5.8).
//   - A daemon fenced by the door (exit 3) is not replaced: its instance was superseded (§8.2).
//   - What a dead daemon left in its spool, the chunks of its open writes, is moved into unsent/ before another daemon
//     starts on that spool (§6.1 "Restart and upgrade"): its writers were told by ENOTCONN or EIO, and the bytes stay
//     readable to the agent for 24 h.
package parent

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// ExitFenced is the daemon's exit status when its instance may no longer use the drive.
const ExitFenced = 3

// Config is one runner's mount.
type Config struct {
	// Root is the plain per-runner directory the runner receives as /run/orbit-drive; the drive is mounted at
	// Root/drive, and errors.log, status.json and unsent/ sit beside it.
	Root string
	// SpoolDir is on the node's disk, never the runner's volume (§5.3).
	SpoolDir string
	// Daemon is the daemon's executable; Args are its serve flags beyond the descriptors this package passes.
	Daemon string
	Args   []string
	// Token is the mount credential, handed to the daemon through a pipe, never its arguments or environment.
	Token string
	// UID and GID are the daemon's (65532).
	UID, GID int
	// PodUID, when set, is the runner Pod's UID: only a process whose cgroup names it is attributed (§5.8). "-" checks
	// nothing (a runner that is not a Pod).
	PodUID string
	// Watchdog is how often the mount is checked (10 s); WatchdogDeadline how long an answer may take (5 s).
	Watchdog         time.Duration
	WatchdogDeadline time.Duration
	// StopWait is how long a stopping daemon may take to commit its open writes (60 s).
	StopWait time.Duration
	// UnsentLimit bounds unsent/, as the daemon's --unsent-limit (1 GiB): what salvage moves there is held to it too.
	UnsentLimit int64
	// OnMount, when set, is called each time a daemon answers on a new mount: the CSI plugin publishes on the first.
	OnMount func()
	// KeepMountOnStop leaves the mount in place when ctx ends: the daemon is still stopped and commits what it can,
	// and callers meet ENOTCONN until a later parent mounts again over it. The CSI plugin stops so when it is
	// restarted or upgraded, and unmounts only on NodeUnpublishVolume (Detach).
	KeepMountOnStop bool
	Log             *log.Logger
}

func (c *Config) defaults() {
	if c.Watchdog == 0 {
		c.Watchdog = 10 * time.Second
	}
	if c.WatchdogDeadline == 0 {
		c.WatchdogDeadline = 5 * time.Second
	}
	if c.StopWait == 0 {
		c.StopWait = 60 * time.Second
	}
	if c.UID == 0 && c.GID == 0 {
		c.UID, c.GID = 65532, 65532
	}
	if c.UnsentLimit == 0 {
		c.UnsentLimit = 1 << 30
	}
	if c.Log == nil {
		c.Log = log.New(os.Stderr, "orbit-drive-mount: ", log.LstdFlags)
	}
}

// MountPoint is where the drive is mounted.
func (c *Config) MountPoint() string { return filepath.Join(c.Root, "drive") }

// Run mounts the drive and keeps it mounted until ctx ends; then it stops the daemon, letting it commit, and unmounts.
func Run(ctx context.Context, cfg Config) error {
	cfg.defaults()
	if err := prepare(&cfg); err != nil {
		return err
	}
	who := newWhois(cfg.PodUID)
	layers := 0
	for attempt := 0; ; attempt++ {
		if n := Salvage(cfg.Root, cfg.SpoolDir, cfg.UnsentLimit); n > 0 {
			cfg.Log.Printf("moved %d spool chunks of a dead daemon into %s", n, filepath.Join(cfg.Root, "unsent"))
		}
		d, err := start(ctx, &cfg, who)
		if err != nil {
			cfg.Log.Printf("mount failed: %v", err)
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(2 * time.Second):
				continue
			}
		}
		cfg.Log.Printf("mounted %s (daemon pid %d, connection %d)", cfg.MountPoint(), d.cmd.Process.Pid, d.conn)
		if cfg.OnMount != nil {
			cfg.OnMount()
		}
		missed := make(chan struct{}, 1)
		watchCtx, stopWatch := context.WithCancel(ctx)
		go watchdog(watchCtx, &cfg, missed)
		select {
		case <-ctx.Done():
			stopWatch()
			d.stop(cfg.StopWait)
			if !cfg.KeepMountOnStop {
				detach(cfg.MountPoint())
			}
			return nil
		case <-d.exited:
			stopWatch()
			if d.status == ExitFenced {
				cfg.Log.Printf("the daemon was fenced: its instance may no longer use the drive; not mounting again")
				<-ctx.Done()
				detach(cfg.MountPoint())
				return nil
			}
			cfg.Log.Printf("the daemon exited (%s); mounting again", d.how)
		case <-missed:
			stopWatch()
			cfg.Log.Printf("the daemon did not answer within %s: aborting connection %d and mounting again", cfg.WatchdogDeadline, d.conn)
			abort(d.conn)
			_ = d.cmd.Process.Kill()
			<-d.exited
		}
		// The dead mount stays until the new one is mounted over it: a caller meets ENOTCONN or the new drive, never
		// the empty directory below (§5.9 row 53). Dead layers go when the drive is unmounted; a daemon that keeps
		// dying starts over clean rather than pile them up.
		layers++
		if layers >= 16 {
			detach(cfg.MountPoint())
			layers = 0
		}
	}
}

// prepare makes the plain directory, the mountpoint and what the daemon writes beside it, never while mounted.
func prepare(cfg *Config) error {
	if err := os.MkdirAll(cfg.Root, 0o755); err != nil {
		return err
	}
	if err := os.Chmod(cfg.Root, 0o755); err != nil {
		return err
	}
	mp := cfg.MountPoint()
	if mounted(mp) {
		detach(mp)
	}
	if err := os.MkdirAll(mp, 0o555); err != nil {
		return err
	}
	_ = os.Chmod(mp, 0o555)
	unsent := filepath.Join(cfg.Root, "unsent")
	if err := os.MkdirAll(filepath.Join(unsent, ".state"), 0o755); err != nil {
		return err
	}
	for _, dir := range []string{unsent, filepath.Join(unsent, ".state")} {
		if err := os.Chown(dir, cfg.UID, cfg.GID); err != nil {
			return err
		}
		_ = os.Chmod(dir, 0o755)
	}
	if err := os.MkdirAll(cfg.SpoolDir, 0o700); err != nil {
		return err
	}
	return filepath.Walk(cfg.SpoolDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		return os.Lchown(path, cfg.UID, cfg.GID)
	})
}

// daemon is one started daemon.
type daemon struct {
	cmd    *exec.Cmd
	conn   int
	exited chan struct{}
	status int
	how    string
}

// start opens /dev/fuse, mounts, and starts the daemon with the descriptor.
func start(ctx context.Context, cfg *Config, who *whois) (*daemon, error) {
	mp := cfg.MountPoint()
	fd, err := unix.Open("/dev/fuse", unix.O_RDWR|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, fmt.Errorf("open /dev/fuse: %w", err)
	}
	fuseFile := os.NewFile(uintptr(fd), "/dev/fuse")
	defer fuseFile.Close() // the daemon holds the only descriptor: when it dies, the connection ends (ENOTCONN)
	data := fmt.Sprintf("fd=%d,rootmode=40000,user_id=0,group_id=0,default_permissions,allow_other,max_read=%d", fd, 1<<20)
	if err := unix.Mount("orbit-drive", mp, "fuse.orbit-drive", unix.MS_NOSUID|unix.MS_NODEV|unix.MS_NOEXEC, data); err != nil {
		return nil, fmt.Errorf("mount %s: %w", mp, err)
	}
	conn, _ := connection(mp)
	errorsFile, err := os.OpenFile(filepath.Join(cfg.Root, "errors.log"), os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		detach(mp)
		return nil, err
	}
	defer errorsFile.Close()
	statusFile, err := os.OpenFile(filepath.Join(cfg.Root, "status.json"), os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		detach(mp)
		return nil, err
	}
	defer statusFile.Close()
	pair, err := unix.Socketpair(unix.AF_UNIX, unix.SOCK_STREAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		detach(mp)
		return nil, err
	}
	ours, theirs := os.NewFile(uintptr(pair[0]), "whois"), os.NewFile(uintptr(pair[1]), "whois")
	defer theirs.Close()
	tokenRead, tokenWrite, err := os.Pipe()
	if err != nil {
		ours.Close()
		detach(mp)
		return nil, err
	}
	defer tokenRead.Close()

	args := append([]string{"serve",
		"--fuse-fd=3", "--errors-fd=4", "--status-fd=5", "--whois-fd=6", "--token-fd=7",
		"--state-dir=" + cfg.Root, "--spool=" + cfg.SpoolDir,
	}, cfg.Args...)
	cmd := exec.Command(cfg.Daemon, args...)
	cmd.Env = []string{"PATH=/usr/bin:/bin", "GOTRACEBACK=single"}
	cmd.Stdout, cmd.Stderr = os.Stderr, os.Stderr
	cmd.ExtraFiles = []*os.File{fuseFile, errorsFile, statusFile, theirs, tokenRead}
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Credential: &syscall.Credential{Uid: uint32(cfg.UID), Gid: uint32(cfg.GID), Groups: []uint32{}},
		Setsid:     true,
		Pdeathsig:  syscall.SIGTERM,
	}
	d := &daemon{cmd: cmd, conn: conn, exited: make(chan struct{})}
	started := make(chan error, 1)
	go func() {
		// Pdeathsig follows the thread that forked: it stays locked for the daemon's life.
		runtime.LockOSThread()
		if err := cmd.Start(); err != nil {
			started <- err
			return
		}
		started <- nil
		err := cmd.Wait()
		d.status, d.how = 0, "exit 0"
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			if ws, ok := exit.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
				d.status, d.how = -1, "killed by "+unix.SignalName(ws.Signal())
			} else {
				d.status, d.how = exit.ExitCode(), fmt.Sprintf("exit %d", exit.ExitCode())
			}
		}
		close(d.exited)
	}()
	if err := <-started; err != nil {
		ours.Close()
		tokenWrite.Close()
		detach(mp)
		return nil, err
	}
	_, _ = tokenWrite.WriteString(cfg.Token)
	tokenWrite.Close()
	go who.serve(ours)
	// The daemon answers the forced stat of the root once it has the kernel's INIT.
	deadline := time.Now().Add(15 * time.Second)
	for {
		if answered(mp, time.Second) {
			return d, nil
		}
		select {
		case <-d.exited:
			detach(mp)
			return nil, fmt.Errorf("the daemon exited before it answered (%s)", d.how)
		default:
		}
		if time.Now().After(deadline) {
			_ = cmd.Process.Kill()
			<-d.exited
			detach(mp)
			return nil, errors.New("the daemon did not answer within 15 s")
		}
	}
}

// stop asks the daemon to commit what it holds and exit, killing it after wait.
func (d *daemon) stop(wait time.Duration) {
	_ = d.cmd.Process.Signal(syscall.SIGTERM)
	select {
	case <-d.exited:
	case <-time.After(wait):
		_ = d.cmd.Process.Kill()
		<-d.exited
	}
}

// answered stats the mount's root with AT_STATX_FORCE_SYNC, so the kernel asks the daemon whatever it cached, within
// deadline. A stat that hangs past it is left to end when the connection is aborted.
func answered(mp string, deadline time.Duration) bool {
	done := make(chan error, 1)
	go func() {
		var st unix.Statx_t
		done <- unix.Statx(unix.AT_FDCWD, mp, unix.AT_STATX_FORCE_SYNC, unix.STATX_BASIC_STATS, &st)
	}()
	select {
	case err := <-done:
		return err == nil
	case <-time.After(deadline):
		return false
	}
}

// watchdog reports a mount whose daemon does not answer: alive but frozen, the one case that would hang callers (§5.7).
func watchdog(ctx context.Context, cfg *Config, missed chan<- struct{}) {
	ticker := time.NewTicker(cfg.Watchdog)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		if !answered(cfg.MountPoint(), cfg.WatchdogDeadline) {
			if ctx.Err() == nil {
				missed <- struct{}{}
			}
			return
		}
	}
}

// connection is the FUSE connection's number, the mount's device minor, read from mountinfo so the frozen mount is
// never touched.
func connection(mp string) (int, error) {
	data, err := os.ReadFile("/proc/self/mountinfo")
	if err != nil {
		return 0, err
	}
	conn := -1
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 5 || fields[4] != mp {
			continue
		}
		parts := strings.SplitN(fields[2], ":", 2)
		if len(parts) == 2 {
			if minor, err := strconv.Atoi(parts[1]); err == nil {
				conn = minor
			}
		}
	}
	if conn < 0 {
		return 0, fmt.Errorf("%s is not mounted", mp)
	}
	return conn, nil
}

func mounted(mp string) bool {
	_, err := connection(mp)
	return err == nil
}

// abort ends a FUSE connection at once: every caller gets ENOTCONN (§5.7).
func abort(conn int) {
	_ = os.WriteFile(fmt.Sprintf("/sys/fs/fuse/connections/%d/abort", conn), []byte("1"), 0o200)
}

// Detach lazily unmounts every mount stacked at mp.
func Detach(mp string) { detach(mp) }

// Mounted reports whether mp is a mount point.
func Mounted(mp string) bool { return mounted(mp) }

// detach lazily unmounts every mount stacked at mp.
func detach(mp string) {
	for i := 0; i < 64 && mounted(mp); i++ {
		if err := unix.Unmount(mp, unix.MNT_DETACH); err != nil {
			return
		}
	}
}

// ── attribution (§5.8) ───────────────────────────────────────────────────────────────────────────

// whois answers which session a host pid belongs to: the ORBIT_SESSION_ID of the process or its nearest ancestor that
// has one (the runner sets it for engines and background jobs), only for a process of the runner Pod when its UID is
// known. Cached by pid and start time, so a reused pid is never answered as the earlier process.
type whois struct {
	podUID string
	mu     sync.Mutex
	cache  map[string]string
}

func newWhois(podUID string) *whois {
	if podUID == "-" {
		podUID = ""
	}
	return &whois{podUID: podUID, cache: map[string]string{}}
}

func (w *whois) serve(conn *os.File) {
	defer conn.Close()
	r := bufio.NewReader(conn)
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return
		}
		pid, err := strconv.Atoi(strings.TrimSpace(line))
		if err != nil || pid <= 0 {
			continue
		}
		start, session := w.lookup(pid)
		if session == "" {
			session = "-"
		}
		if _, err := fmt.Fprintf(conn, "%d %d %s\n", pid, start, session); err != nil {
			return
		}
	}
}

func (w *whois) lookup(pid int) (uint64, string) {
	start, _, ok := procStat(pid)
	if !ok {
		return 0, ""
	}
	key := fmt.Sprintf("%d:%d", pid, start)
	w.mu.Lock()
	if s, hit := w.cache[key]; hit {
		w.mu.Unlock()
		return start, s
	}
	w.mu.Unlock()
	session := ""
	// Up the process's ancestors, never past the runner Pod: a process outside it says nothing of this runner.
	for p, depth := pid, 0; p > 1 && depth < 64; depth++ {
		if w.podUID != "" && !inPod(p, w.podUID) {
			break
		}
		if s := environValue(p, "ORBIT_SESSION_ID"); s != "" {
			session = s
			break
		}
		_, parent, ok := procStat(p)
		if !ok {
			break
		}
		p = parent
	}
	w.mu.Lock()
	if len(w.cache) > 8192 {
		w.cache = map[string]string{}
	}
	w.cache[key] = session
	w.mu.Unlock()
	return start, session
}

// procStat is a process's start time and parent, from /proc/<pid>/stat (whose name field may hold spaces and parens).
func procStat(pid int) (start uint64, ppid int, ok bool) {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return 0, 0, false
	}
	text := string(data)
	close := strings.LastIndexByte(text, ')')
	if close < 0 {
		return 0, 0, false
	}
	fields := strings.Fields(text[close+1:])
	// fields[0] is the state (field 3); ppid is field 4, starttime field 22.
	if len(fields) < 20 {
		return 0, 0, false
	}
	ppid, _ = strconv.Atoi(fields[1])
	start, _ = strconv.ParseUint(fields[19], 10, 64)
	return start, ppid, true
}

func environValue(pid int, name string) string {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/environ", pid))
	if err != nil {
		return ""
	}
	prefix := name + "="
	for _, kv := range strings.Split(string(data), "\x00") {
		if strings.HasPrefix(kv, prefix) {
			return strings.TrimSpace(kv[len(prefix):])
		}
	}
	return ""
}

// inPod reports whether the process's cgroup is the runner Pod's (the kubelet names it by the Pod UID, with
// underscores under the systemd driver).
func inPod(pid int, podUID string) bool {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/cgroup", pid))
	if err != nil {
		return false
	}
	text := string(data)
	return strings.Contains(text, podUID) || strings.Contains(text, strings.ReplaceAll(podUID, "-", "_"))
}
