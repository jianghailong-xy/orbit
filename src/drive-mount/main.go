// Command orbit-drive-mount presents the account's Drive at /run/orbit-drive/drive (docs/drive-technical-design.md §5), which the runner shows its agents as /home/orbit/Drive.
//
//	orbit-drive-mount mount --root /run/orbit-drive --spool /var/lib/orbit-drive-spool/<runner> --server URL \
//	    --token-file FILE --generation N --pod-uid UID [serve flags...]
//
// is the privileged parent (root): it mounts and starts the daemon as an unprivileged user, replaces it if it dies or
// freezes, and answers attribution. The parent passes the daemon its FUSE descriptor and runs
//
//	orbit-drive-mount serve --fuse-fd 3 ...
//
// itself. For development, serve can also mount a directory on its own (--mountpoint), through fusermount.
//
//	orbit-drive-mount csi --endpoint unix:///csi/csi.sock --node-id NODE --managed-namespace NS --server URL ...
//
// is drive.orbit.dev, the CSI node plugin that runs the privileged parent of every runner Pod's drive on its node
// (package csi; deploy/managed-runner/drive-csi).
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/hanwen/go-fuse/v2/fuse"

	"orbit/drive-mount/csi"
	"orbit/drive-mount/door"
	"orbit/drive-mount/drivefs"
	"orbit/drive-mount/parent"
	"orbit/drive-mount/sandbox"
)

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	switch os.Args[1] {
	case "serve":
		os.Exit(serve(os.Args[2:]))
	case "mount":
		os.Exit(mount(os.Args[2:]))
	case "csi":
		os.Exit(csiPlugin(os.Args[2:]))
	default:
		usage()
	}
}

// mountTokenFromEnv is $ORBIT_DRIVE_MOUNT_TOKEN, or $ORBIT_DOCUMENTS_MOUNT_TOKEN and then $ORBIT_FILES_MOUNT_TOKEN, its
// names before the drive was renamed back to Drive, when the new one is unset.
func mountTokenFromEnv() string {
	for _, name := range []string{"ORBIT_DRIVE_MOUNT_TOKEN", "ORBIT_DOCUMENTS_MOUNT_TOKEN", "ORBIT_FILES_MOUNT_TOKEN"} {
		if token := strings.TrimSpace(os.Getenv(name)); token != "" {
			return token
		}
	}
	return ""
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: orbit-drive-mount mount|serve|csi [flags]")
	os.Exit(2)
}

// serveFlags are the daemon's own: the parent passes them through.
type serveFlags struct {
	fuseFD, errorsFD, statusFD, whoisFD, tokenFD int
	mountpoint                                   string
	server, generation, podUID                   string
	stateDir, shownStateDir, displayRoot         string
	spool                                        string
	spoolLimit, cacheLimit, unsentLimit          string
	uid, gid                                     uint
	idleCommit, maxCommit, closeWait, feedWait   time.Duration
	noSandbox, debug                             bool
}

func (f *serveFlags) register(fs *flag.FlagSet) {
	fs.IntVar(&f.fuseFD, "fuse-fd", -1, "an open /dev/fuse descriptor, mounted by the privileged parent")
	fs.StringVar(&f.mountpoint, "mountpoint", "", "for development: mount this directory itself instead")
	fs.StringVar(&f.server, "server", "", "the Orbit server's root URL")
	fs.IntVar(&f.tokenFD, "token-fd", -1, "a descriptor to read the mount credential from (else $ORBIT_DRIVE_MOUNT_TOKEN)")
	fs.StringVar(&f.generation, "generation", "", "the managed-runner generation the credential was issued for")
	fs.StringVar(&f.podUID, "pod-uid", "", "the runner instance's UID (the Pod UID on Kubernetes)")
	fs.StringVar(&f.stateDir, "state-dir", "", "the plain parent directory holding errors.log, status.json and unsent/")
	fs.StringVar(&f.shownStateDir, "shown-state-dir", "/run/orbit-drive", "the parent directory as agents know it")
	fs.StringVar(&f.displayRoot, "display-root", "/home/orbit/Drive", "the drive's path as agents know it")
	fs.IntVar(&f.errorsFD, "errors-fd", -1, "errors.log, opened by the parent")
	fs.IntVar(&f.statusFD, "status-fd", -1, "status.json, opened by the parent")
	fs.IntVar(&f.whoisFD, "whois-fd", -1, "a socket to the parent, which tells a caller's session")
	fs.StringVar(&f.spool, "spool", "", "the spool and chunk cache directory, on the node's disk")
	fs.StringVar(&f.spoolLimit, "spool-limit", "4GiB", "the spool's limit")
	fs.StringVar(&f.cacheLimit, "cache-limit", "1GiB", "the chunk cache's limit")
	fs.StringVar(&f.unsentLimit, "unsent-limit", "1GiB", "unsent/'s limit")
	fs.UintVar(&f.uid, "uid", 10001, "the uid every entry shows")
	fs.UintVar(&f.gid, "gid", 10001, "the gid every entry shows")
	fs.DurationVar(&f.idleCommit, "idle-commit", 30*time.Second, "a dirty write commits after this long without a write")
	fs.DurationVar(&f.maxCommit, "max-commit-interval", 5*time.Minute, "and at least this often while writing continues")
	fs.DurationVar(&f.closeWait, "close-wait", 30*time.Second, "how long a close waits for an unreachable server")
	fs.DurationVar(&f.feedWait, "feed-wait", 15*time.Second, "the change feed's long-poll wait")
	fs.BoolVar(&f.noSandbox, "no-sandbox", false, "for development: no seccomp filter")
	fs.BoolVar(&f.debug, "debug", false, "log every FUSE request")
}

func parseSize(s string) (int64, error) {
	s = strings.TrimSpace(s)
	units := []struct {
		suffix string
		mult   int64
	}{{"GiB", 1 << 30}, {"MiB", 1 << 20}, {"KiB", 1 << 10}, {"G", 1 << 30}, {"M", 1 << 20}, {"K", 1 << 10}, {"B", 1}}
	for _, u := range units {
		if strings.HasSuffix(s, u.suffix) {
			n, err := strconv.ParseInt(strings.TrimSuffix(s, u.suffix), 10, 64)
			return n * u.mult, err
		}
	}
	return strconv.ParseInt(s, 10, 64)
}

func serve(args []string) int {
	var f serveFlags
	flags := flag.NewFlagSet("serve", flag.ExitOnError)
	f.register(flags)
	_ = flags.Parse(args)
	logger := log.New(os.Stderr, "orbit-drive-mount: ", log.LstdFlags)

	token := mountTokenFromEnv()
	if f.tokenFD >= 0 {
		file := os.NewFile(uintptr(f.tokenFD), "token")
		data, err := io.ReadAll(io.LimitReader(file, 4096))
		file.Close()
		if err != nil {
			logger.Printf("reading the credential: %v", err)
			return 2
		}
		token = strings.TrimSpace(string(data))
	}
	if f.server == "" || token == "" {
		logger.Print("--server and a credential are required")
		return 2
	}
	var sizes [3]int64
	for i, s := range []string{f.spoolLimit, f.cacheLimit, f.unsentLimit} {
		n, err := parseSize(s)
		if err != nil || n <= 0 {
			logger.Printf("bad size %q", s)
			return 2
		}
		sizes[i] = n
	}
	client := door.New(door.Config{BaseURL: f.server, Token: token, Generation: f.generation, PodUID: f.podUID})
	ropts := drivefs.ReporterOptions{Dir: f.stateDir, ShownDir: f.shownStateDir, UnsentLimit: sizes[2], Echo: os.Stderr}
	if f.errorsFD >= 0 {
		ropts.ErrorsFile = os.NewFile(uintptr(f.errorsFD), "errors.log")
	}
	if f.statusFD >= 0 {
		ropts.StatusFile = os.NewFile(uintptr(f.statusFD), "status.json")
	}
	if ropts.Dir == "" && f.shownStateDir != "" && f.errorsFD < 0 {
		ropts.ShownDir = ""
	}
	rep := drivefs.NewReporter(ropts)

	var attributor drivefs.Attributor
	if f.whoisFD >= 0 {
		conn, err := net.FileConn(os.NewFile(uintptr(f.whoisFD), "whois"))
		if err == nil {
			attributor = drivefs.NewSocketAttributor(conn)
		}
	}
	exit := make(chan int, 1)
	fsys, err := drivefs.New(client, drivefs.Options{
		UID: uint32(f.uid), GID: uint32(f.gid), DisplayRoot: f.displayRoot, SpoolDir: f.spool,
		SpoolLimit: sizes[0], CacheLimit: sizes[1], IdleCommit: f.idleCommit, MaxCommitInterval: f.maxCommit,
		CloseWait: f.closeWait, FeedWait: f.feedWait, Reporter: rep, Attributor: attributor, Debug: f.debug,
		OnFenced: func(reason string) {
			logger.Printf("fenced (%s): leaving", reason)
			select {
			case exit <- parent.ExitFenced:
			default:
			}
		},
	})
	if err != nil {
		logger.Printf("%v", err)
		return 1
	}
	mountpoint := f.mountpoint
	opts := drivefs.MountOptions(f.debug)
	if f.fuseFD >= 0 {
		mountpoint = fmt.Sprintf("/dev/fd/%d", f.fuseFD)
	} else if mountpoint == "" {
		logger.Print("--fuse-fd or --mountpoint is required")
		return 2
	} else {
		opts.DirectMount = os.Geteuid() == 0
	}
	server, err := fuse.NewServer(fsys, mountpoint, opts)
	if err != nil {
		logger.Printf("serving %s: %v", mountpoint, err)
		return 1
	}
	if !f.noSandbox {
		if err := sandbox.Lockdown(); err != nil {
			logger.Printf("sandbox: %v", err)
			return 1
		}
	}
	go server.Serve()
	if err := server.WaitMount(); err != nil {
		logger.Printf("mount: %v", err)
		return 1
	}
	fsys.Start()
	rep.WriteStatus()

	signals := make(chan os.Signal, 2)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
	served := make(chan struct{})
	go func() {
		server.Wait()
		close(served)
	}()
	status := 0
	select {
	case <-signals:
		// Stopping: open writes commit, what cannot is kept in unsent/, then the mount goes (the parent unmounts it).
		fsys.Shutdown(30 * time.Second)
	case status = <-exit:
	case <-served:
	}
	fsys.Stop()
	if f.fuseFD < 0 {
		_ = server.Unmount()
	}
	return status
}

func mount(args []string) int {
	var f serveFlags
	flags := flag.NewFlagSet("mount", flag.ExitOnError)
	root := flags.String("root", "/run/orbit-drive", "the plain per-runner directory; the drive is mounted at <root>/drive")
	tokenFile := flags.String("token-file", "", "the mount credential (else $ORBIT_DRIVE_MOUNT_TOKEN)")
	uid := flags.Int("daemon-uid", 65532, "the daemon's uid")
	gid := flags.Int("daemon-gid", 65532, "the daemon's gid")
	watchdog := flags.Duration("watchdog", 10*time.Second, "how often the mount is checked")
	attributeIn := flags.String("attribute-cgroup", "", "attribute only processes whose cgroup names this (default: --pod-uid; - for any)")
	f.register(flags)
	_ = flags.Parse(args)
	logger := log.New(os.Stderr, "orbit-drive-mount: ", log.LstdFlags)
	if os.Geteuid() != 0 {
		logger.Print("mount must run as root: it opens /dev/fuse and mounts")
		return 2
	}
	token := mountTokenFromEnv()
	if *tokenFile != "" {
		data, err := os.ReadFile(*tokenFile)
		if err != nil {
			logger.Printf("%v", err)
			return 2
		}
		token = strings.TrimSpace(string(data))
	}
	self, err := os.Executable()
	if err != nil {
		logger.Printf("%v", err)
		return 1
	}
	// The daemon's flags: everything given here but what the parent decides itself.
	pass := []string{}
	flags.Visit(func(fl *flag.Flag) {
		switch fl.Name {
		case "root", "token-file", "daemon-uid", "daemon-gid", "watchdog", "attribute-cgroup", "fuse-fd", "errors-fd",
			"status-fd", "whois-fd", "token-fd", "state-dir", "spool", "mountpoint":
			return
		}
		pass = append(pass, "--"+fl.Name+"="+fl.Value.String())
	})
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()
	podCgroup := f.podUID
	if *attributeIn != "" {
		podCgroup = *attributeIn
	}
	err = parent.Run(ctx, parent.Config{
		Root: *root, SpoolDir: f.spool, Daemon: self, Args: pass, Token: token, UID: *uid, GID: *gid,
		PodUID: podCgroup, Watchdog: *watchdog, Log: logger,
	})
	if err != nil && !errors.Is(err, context.Canceled) {
		logger.Printf("%v", err)
		return 1
	}
	return 0
}

func csiPlugin(args []string) int {
	flags := flag.NewFlagSet("csi", flag.ExitOnError)
	endpoint := flags.String("endpoint", "unix:///csi/csi.sock", "the CSI socket the kubelet and the sidecars use")
	nodeID := flags.String("node-id", os.Getenv("NODE_NAME"), "this node's name")
	managed := flags.String("managed-namespace", "", "the managed-runner namespace: the only one whose Pods may have the drive")
	secrets := flags.String("secrets-namespace", "orbit-drive-system", "where Secret mrf-<runner uuid> is")
	server := flags.String("server", "", "the Orbit server's root URL")
	root := flags.String("root", "/var/lib/orbit-drive", "the per-runner directories each runner Pod receives as /run/orbit-drive")
	spool := flags.String("spool-root", "/var/lib/orbit-drive-spool", "the per-runner spools, on the node's disk")
	state := flags.String("state-dir", "/var/lib/orbit-drive-state", "what the plugin keeps of each published drive")
	uidBase := flags.Int("daemon-uid-base", 200000, "the first uid a runner's daemon runs as; each runner on the node gets its own")
	_ = flags.Parse(args)
	logger := log.New(os.Stderr, "orbit-drive-csi: ", log.LstdFlags)
	if os.Geteuid() != 0 {
		logger.Print("csi must run as root: it mounts")
		return 2
	}
	if *nodeID == "" || *managed == "" || *server == "" {
		logger.Print("--node-id, --managed-namespace and --server are required")
		return 2
	}
	self, err := os.Executable()
	if err != nil {
		logger.Printf("%v", err)
		return 1
	}
	// The watchdog aborts a frozen daemon's connection through fusectl (§5.7); a node whose init did not mount it gets
	// it mounted here, in the plugin's own mount namespace.
	if !parent.Mounted("/sys/fs/fuse/connections") {
		if err := syscall.Mount("fusectl", "/sys/fs/fuse/connections", "fusectl", 0, ""); err != nil {
			logger.Printf("fusectl is not mounted, and mounting it failed (a frozen daemon cannot be aborted): %v", err)
		}
	}
	reader, err := csi.NewInClusterSecrets()
	if err != nil {
		logger.Printf("%v", err)
		return 1
	}
	// The daemon's own flags, passed through: everything after "--".
	driver := csi.New(csi.Config{
		NodeID: *nodeID, ManagedNamespace: *managed, SecretsNamespace: *secrets, Server: *server, Root: *root,
		SpoolRoot: *spool, StateDir: *state, Daemon: self, DaemonArgs: flags.Args(), UIDBase: *uidBase,
		Secrets: reader, Log: logger,
	})
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()
	logger.Printf("adopted %d drives published before this start", driver.Adopt(ctx))
	err = csi.Serve(ctx, *endpoint, driver)
	// Stopping (an upgrade, a restart): every daemon commits what it can; the mounts stay for the next start.
	driver.Shutdown()
	if err != nil && ctx.Err() == nil {
		logger.Printf("%v", err)
		return 1
	}
	return 0
}
