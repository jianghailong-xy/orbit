//go:build linux

// Package csi is drive.orbit.dev, the Drive CSI node plugin (docs/drive-technical-design.md §6.1): it
// gives a managed runner Pod its drive as one inline CSI volume. Identity and Node services only, no controller.
//
//   - NodePublishVolume refuses unless the Pod is in the managed-runner namespace (the kubelet's pod info) and the
//     volume's attributes are exactly { runnerId }; reads Secret mrf-<runnerId> (the mount credential and its
//     generation); asks the door whether this Pod may use the drive (503 PENDING answers UNAVAILABLE, which the
//     kubelet retries; a refusal answers PERMISSION_DENIED); starts that runner's privileged parent (package parent:
//     the daemon, its watchdog and its remounts); and once the mount answers, bind-mounts the plain per-runner
//     directory, never drive/, onto the kubelet's target, and writes a state file.
//   - NodeUnpublishVolume unmounts the target, stops the daemon after its open commits (at most 60 s), unmounts the
//     drive and removes the state file.
//   - On start, every state file whose target is still mounted is adopted again (review A8): the daemons died with the
//     plugin's container, and the kubelet does not publish a running Pod's volume again. The parent salvages the dead
//     daemon's spool into unsent/ and mounts over the dead drive, which the parent-directory layout carries into the
//     running Pod.
//   - Stopping, the plugin stops every daemon and leaves its mount: callers meet ENOTCONN until the next start.
package csi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	csipb "github.com/container-storage-interface/spec/lib/go/csi"
	"golang.org/x/sys/unix"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"orbit/drive-mount/door"
	"orbit/drive-mount/parent"
)

// DriverName is the CSI driver every runner Pod's drive volume names.
const DriverName = "drive.orbit.dev"

// The kubelet's pod info on NodePublishVolume (CSIDriver podInfoOnMount), and its ephemeral marker.
const (
	podNameKey      = "csi.storage.k8s.io/pod.name"
	podNamespaceKey = "csi.storage.k8s.io/pod.namespace"
	podUIDKey       = "csi.storage.k8s.io/pod.uid"
	ephemeralKey    = "csi.storage.k8s.io/ephemeral"
	kubeletPrefix   = "csi.storage.k8s.io/"
	runnerIDKey     = "runnerId"
	runnerIDAnnot   = "orbit.dev/runner-id"
	generationAnnot = "orbit.dev/generation"
)

var canonicalUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// Secret is the part of a Kubernetes Secret the plugin reads.
type Secret struct {
	Annotations map[string]string
	Data        map[string][]byte
}

// Secrets reads one Secret, or nil when there is none.
type Secrets interface {
	Get(ctx context.Context, namespace, name string) (*Secret, error)
}

// Config is one node's plugin.
type Config struct {
	NodeID           string
	ManagedNamespace string // the managed-runner namespace: the only one whose Pods may have the drive
	SecretsNamespace string // where Secret mrf-<runnerId> is (orbit-drive-system)
	Server           string // the Orbit server the daemons speak to
	Root             string // /var/lib/orbit-drive: <runnerId>/ is what a Pod receives as /run/orbit-drive
	SpoolRoot        string // /var/lib/orbit-drive-spool
	StateDir         string // /var/lib/orbit-drive-state
	Daemon           string // the daemon's executable (this one)
	DaemonArgs       []string
	// UIDBase is the first uid a runner's daemon may run as; each runner on the node gets its own (65532 is never
	// used), so no daemon can read another runner's spool.
	UIDBase      int
	MountTimeout time.Duration // how long a publish waits for the mount to answer (30 s)
	Secrets      Secrets
	Log          *log.Logger

	// For tests: the door's answer to a Pod, the parent, and the mounts the plugin makes.
	Probe  func(ctx context.Context, token, generation, podUID string) error
	Run    func(ctx context.Context, cfg parent.Config) error
	Bind   func(source, target string) error
	Unbind func(target string) error
	Bound  func(target string) bool
}

// State is what the plugin keeps of one published drive, in StateDir/<runnerId>.json.
type State struct {
	RunnerID   string `json:"runnerId"`
	VolumeID   string `json:"volumeId"`
	PodUID     string `json:"podUid"`
	PodName    string `json:"podName"`
	Generation string `json:"generation"`
	TargetPath string `json:"targetPath"`
	DaemonUID  int    `json:"daemonUid"`
}

type volume struct {
	State
	cancel context.CancelFunc
	done   chan struct{}
}

// Driver serves the CSI Identity and Node services.
type Driver struct {
	csipb.UnimplementedIdentityServer
	csipb.UnimplementedNodeServer

	cfg     Config
	mu      sync.Mutex
	volumes map[string]*volume // by runner id
	busy    map[string]bool    // runner ids with a publish or unpublish in progress
}

// New makes a driver; Adopt and serving are the caller's.
func New(cfg Config) *Driver {
	if cfg.UIDBase == 0 {
		cfg.UIDBase = 200000
	}
	if cfg.MountTimeout == 0 {
		cfg.MountTimeout = 30 * time.Second
	}
	if cfg.Log == nil {
		cfg.Log = log.New(os.Stderr, "orbit-drive-csi: ", log.LstdFlags)
	}
	if cfg.Run == nil {
		cfg.Run = parent.Run
	}
	if cfg.Bind == nil {
		cfg.Bind = func(source, target string) error {
			return unix.Mount(source, target, "", unix.MS_BIND|unix.MS_REC, "")
		}
	}
	if cfg.Unbind == nil {
		cfg.Unbind = func(target string) error { return unix.Unmount(target, unix.MNT_DETACH) }
	}
	if cfg.Bound == nil {
		cfg.Bound = parent.Mounted
	}
	if cfg.Probe == nil {
		cfg.Probe = func(ctx context.Context, token, generation, podUID string) error {
			return door.New(door.Config{BaseURL: cfg.Server, Token: token, Generation: generation, PodUID: podUID}).Probe(ctx)
		}
	}
	return &Driver{cfg: cfg, volumes: map[string]*volume{}, busy: map[string]bool{}}
}

// ── identity ─────────────────────────────────────────────────────────────────────────────────────

func (d *Driver) GetPluginInfo(context.Context, *csipb.GetPluginInfoRequest) (*csipb.GetPluginInfoResponse, error) {
	return &csipb.GetPluginInfoResponse{Name: DriverName, VendorVersion: "1"}, nil
}

func (d *Driver) GetPluginCapabilities(context.Context, *csipb.GetPluginCapabilitiesRequest) (*csipb.GetPluginCapabilitiesResponse, error) {
	return &csipb.GetPluginCapabilitiesResponse{}, nil
}

func (d *Driver) Probe(context.Context, *csipb.ProbeRequest) (*csipb.ProbeResponse, error) {
	return &csipb.ProbeResponse{}, nil
}

// ── node ─────────────────────────────────────────────────────────────────────────────────────────

func (d *Driver) NodeGetCapabilities(context.Context, *csipb.NodeGetCapabilitiesRequest) (*csipb.NodeGetCapabilitiesResponse, error) {
	return &csipb.NodeGetCapabilitiesResponse{}, nil
}

func (d *Driver) NodeGetInfo(context.Context, *csipb.NodeGetInfoRequest) (*csipb.NodeGetInfoResponse, error) {
	return &csipb.NodeGetInfoResponse{NodeId: d.cfg.NodeID}, nil
}

// request is a publish, checked: whose drive, for which Pod.
type request struct {
	runnerID, podUID, podName string
}

// checkPublish is why a publish may not be served, or the runner and Pod it is for. Only a Pod of the managed
// namespace may have the drive, and only as an inline volume naming nothing but its runner (B13, layer 3).
func (d *Driver) checkPublish(req *csipb.NodePublishVolumeRequest) (request, error) {
	if req.GetVolumeId() == "" || req.GetTargetPath() == "" {
		return request{}, status.Error(codes.InvalidArgument, "a volume id and a target path are required")
	}
	if req.GetVolumeCapability().GetMount() == nil {
		return request{}, status.Error(codes.InvalidArgument, "the drive is a mounted file system, not a block device")
	}
	if req.GetReadonly() {
		return request{}, status.Error(codes.InvalidArgument, "the drive is not mounted read-only")
	}
	attrs := req.GetVolumeContext()
	if attrs[ephemeralKey] != "true" {
		return request{}, status.Error(codes.InvalidArgument, "the drive is only an inline (ephemeral) volume of a runner Pod")
	}
	if ns := attrs[podNamespaceKey]; ns != d.cfg.ManagedNamespace {
		return request{}, status.Errorf(codes.PermissionDenied, "a Pod of namespace %q may not have the drive", ns)
	}
	var own []string
	for key := range attrs {
		if !strings.HasPrefix(key, kubeletPrefix) {
			own = append(own, key)
		}
	}
	runnerID := attrs[runnerIDKey]
	if len(own) != 1 || !canonicalUUID.MatchString(runnerID) {
		return request{}, status.Error(codes.InvalidArgument, "the volume's attributes must be exactly { runnerId: <runner uuid> }")
	}
	if len(req.GetSecrets()) > 0 {
		return request{}, status.Error(codes.InvalidArgument, "the drive takes no publish secrets")
	}
	podUID := attrs[podUIDKey]
	if podUID == "" {
		return request{}, status.Error(codes.InvalidArgument, "the kubelet sent no Pod UID (CSIDriver podInfoOnMount)")
	}
	return request{runnerID: runnerID, podUID: podUID, podName: attrs[podNameKey]}, nil
}

// credential is the mount credential of runnerID's current generation, from Secret mrf-<runnerID>.
func (d *Driver) credential(ctx context.Context, runnerID string) (token, generation string, err error) {
	secret, err := d.cfg.Secrets.Get(ctx, d.cfg.SecretsNamespace, "mrf-"+runnerID)
	if err != nil {
		return "", "", status.Errorf(codes.Unavailable, "reading Secret %s/mrf-%s: %v", d.cfg.SecretsNamespace, runnerID, err)
	}
	if secret == nil {
		return "", "", status.Errorf(codes.Unavailable, "Secret %s/mrf-%s is not there yet", d.cfg.SecretsNamespace, runnerID)
	}
	if secret.Annotations[runnerIDAnnot] != runnerID {
		return "", "", status.Errorf(codes.PermissionDenied, "Secret mrf-%s names another runner", runnerID)
	}
	token = strings.TrimSpace(string(secret.Data["token"]))
	generation = strings.TrimSpace(string(secret.Data["generation"]))
	if token == "" || generation == "" || secret.Annotations[generationAnnot] != generation {
		return "", "", status.Errorf(codes.Unavailable, "Secret mrf-%s carries no credential of one generation", runnerID)
	}
	return token, generation, nil
}

// refusal is the gRPC answer to what the door said about a Pod.
func refusal(err error) error {
	var fenced *door.FencedError
	switch {
	case err == nil:
		return nil
	case errors.As(err, &fenced):
		return status.Errorf(codes.PermissionDenied, "the door refused this Pod the drive: %v", err)
	case door.CodeOf(err) == door.CodeInstancePending, door.Transient(err):
		// The manager has not recorded the Pod's UID yet, or the server did not answer: the kubelet retries.
		return status.Errorf(codes.Unavailable, "the door cannot admit this Pod yet: %v", err)
	case door.StatusOf(err) == 401 || door.StatusOf(err) == 403:
		return status.Errorf(codes.PermissionDenied, "the door refused this Pod the drive: %v", err)
	default:
		return status.Errorf(codes.Unavailable, "the door: %v", err)
	}
}

func (d *Driver) claim(runnerID string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.busy[runnerID] {
		return false
	}
	d.busy[runnerID] = true
	return true
}

func (d *Driver) release(runnerID string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	delete(d.busy, runnerID)
}

func (d *Driver) NodePublishVolume(ctx context.Context, req *csipb.NodePublishVolumeRequest) (*csipb.NodePublishVolumeResponse, error) {
	r, err := d.checkPublish(req)
	if err != nil {
		d.cfg.Log.Printf("publish %s refused: %v", req.GetVolumeId(), err)
		return nil, err
	}
	if !d.claim(r.runnerID) {
		return nil, status.Errorf(codes.Aborted, "the drive of runner %s is being published or unpublished", r.runnerID)
	}
	defer d.release(r.runnerID)

	d.mu.Lock()
	existing := d.volumes[r.runnerID]
	d.mu.Unlock()
	if existing != nil {
		if existing.VolumeID == req.GetVolumeId() && existing.TargetPath == req.GetTargetPath() && d.cfg.Bound(existing.TargetPath) {
			return &csipb.NodePublishVolumeResponse{}, nil
		}
		// The drive is the runner's, one Pod at a time: the earlier Pod's is unpublished first (never while mounted).
		return nil, status.Errorf(codes.Unavailable, "the drive of runner %s is still published for Pod %s", r.runnerID, existing.PodUID)
	}

	token, generation, err := d.credential(ctx, r.runnerID)
	if err != nil {
		return nil, err
	}
	if err := refusal(d.cfg.Probe(ctx, token, generation, r.podUID)); err != nil {
		d.cfg.Log.Printf("publish of runner %s for Pod %s: %v", r.runnerID, r.podUID, err)
		return nil, err
	}

	v := &volume{State: State{
		RunnerID: r.runnerID, VolumeID: req.GetVolumeId(), PodUID: r.podUID, PodName: r.podName,
		Generation: generation, TargetPath: req.GetTargetPath(), DaemonUID: d.freeUID(),
	}}
	mounted := d.start(v, token)
	select {
	case <-mounted:
	case <-v.done:
		return nil, status.Errorf(codes.Unavailable, "the drive of runner %s did not mount", r.runnerID)
	case <-time.After(d.cfg.MountTimeout):
		d.stop(v)
		return nil, status.Errorf(codes.Unavailable, "the drive of runner %s did not answer within %s", r.runnerID, d.cfg.MountTimeout)
	case <-ctx.Done():
		d.stop(v)
		return nil, status.FromContextError(ctx.Err()).Err()
	}
	if err := os.MkdirAll(v.TargetPath, 0o750); err != nil {
		d.stop(v)
		return nil, status.Errorf(codes.Internal, "target %s: %v", v.TargetPath, err)
	}
	// The plain directory, never drive/: a remount of drive/ reaches the Pod through it (§6.1).
	if err := d.cfg.Bind(d.runnerRoot(r.runnerID), v.TargetPath); err != nil {
		d.stop(v)
		return nil, status.Errorf(codes.Internal, "binding the drive onto %s: %v", v.TargetPath, err)
	}
	if err := d.writeState(v.State); err != nil {
		_ = d.cfg.Unbind(v.TargetPath)
		d.stop(v)
		return nil, status.Errorf(codes.Internal, "writing the state of runner %s: %v", r.runnerID, err)
	}
	d.cfg.Log.Printf("published the drive of runner %s (generation %s) for Pod %s at %s", r.runnerID, generation, r.podUID, v.TargetPath)
	return &csipb.NodePublishVolumeResponse{}, nil
}

func (d *Driver) NodeUnpublishVolume(ctx context.Context, req *csipb.NodeUnpublishVolumeRequest) (*csipb.NodeUnpublishVolumeResponse, error) {
	if req.GetVolumeId() == "" || req.GetTargetPath() == "" {
		return nil, status.Error(codes.InvalidArgument, "a volume id and a target path are required")
	}
	target := req.GetTargetPath()
	for d.cfg.Bound(target) {
		if err := d.cfg.Unbind(target); err != nil {
			return nil, status.Errorf(codes.Internal, "unmounting %s: %v", target, err)
		}
	}
	_ = os.Remove(target)

	var found *volume
	d.mu.Lock()
	for _, v := range d.volumes {
		if v.VolumeID == req.GetVolumeId() {
			found = v
		}
	}
	d.mu.Unlock()
	var state *State
	if found != nil {
		state = &found.State
	} else if s := d.stateOfVolume(req.GetVolumeId()); s != nil {
		state = s
	}
	if state == nil {
		return &csipb.NodeUnpublishVolumeResponse{}, nil
	}
	if !d.claim(state.RunnerID) {
		return nil, status.Errorf(codes.Aborted, "the drive of runner %s is being published or unpublished", state.RunnerID)
	}
	defer d.release(state.RunnerID)
	// The Pod's processes are gone: every handle has been closed, and the daemon commits what is open, then the
	// drive goes.
	if found != nil {
		d.stop(found)
	}
	parent.Detach(filepath.Join(d.runnerRoot(state.RunnerID), "drive"))
	_ = os.Remove(d.statePath(state.RunnerID))
	d.cfg.Log.Printf("unpublished the drive of runner %s for Pod %s", state.RunnerID, state.PodUID)
	return &csipb.NodeUnpublishVolumeResponse{}, nil
}

// start runs a runner's parent and answers a channel closed once its first mount answers.
func (d *Driver) start(v *volume, token string) <-chan struct{} {
	mounted := make(chan struct{})
	var once sync.Once
	ctx, cancel := context.WithCancel(context.Background())
	v.cancel, v.done = cancel, make(chan struct{})
	args := append([]string{"--server=" + d.cfg.Server, "--generation=" + v.Generation, "--pod-uid=" + v.PodUID}, d.cfg.DaemonArgs...)
	cfg := parent.Config{
		Root: d.runnerRoot(v.RunnerID), SpoolDir: filepath.Join(d.cfg.SpoolRoot, v.RunnerID), Daemon: d.cfg.Daemon,
		Args: args, Token: token, UID: v.DaemonUID, GID: v.DaemonUID, PodUID: v.PodUID, KeepMountOnStop: true,
		OnMount: func() { once.Do(func() { close(mounted) }) },
		Log:     log.New(d.cfg.Log.Writer(), fmt.Sprintf("orbit-drive-mount[%s]: ", v.RunnerID), log.LstdFlags),
	}
	d.mu.Lock()
	d.volumes[v.RunnerID] = v
	d.mu.Unlock()
	go func() {
		defer close(v.done)
		if err := d.cfg.Run(ctx, cfg); err != nil && !errors.Is(err, context.Canceled) {
			d.cfg.Log.Printf("the drive of runner %s stopped: %v", v.RunnerID, err)
		}
	}()
	return mounted
}

// stop stops a runner's daemon, letting it commit, and forgets the volume; the mount stays (KeepMountOnStop).
func (d *Driver) stop(v *volume) {
	v.cancel()
	<-v.done
	d.mu.Lock()
	if d.volumes[v.RunnerID] == v {
		delete(d.volumes, v.RunnerID)
	}
	d.mu.Unlock()
}

// Shutdown stops every daemon, each committing what it can, and leaves every mount for the next start to adopt.
func (d *Driver) Shutdown() {
	d.mu.Lock()
	all := make([]*volume, 0, len(d.volumes))
	for _, v := range d.volumes {
		all = append(all, v)
	}
	d.mu.Unlock()
	var wg sync.WaitGroup
	for _, v := range all {
		wg.Add(1)
		go func(v *volume) {
			defer wg.Done()
			d.stop(v)
		}(v)
	}
	wg.Wait()
}

// Adopt mounts again every drive a state file says was published and whose target is still mounted: the daemons died
// with the plugin's last container (review A8). A state file whose target is gone is the drive of a Pod unpublished
// while the plugin was down: its drive is unmounted and the file removed. It answers how many it adopted.
func (d *Driver) Adopt(ctx context.Context) int {
	entries, _ := os.ReadDir(d.cfg.StateDir)
	adopted := 0
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		s, err := d.readState(filepath.Join(d.cfg.StateDir, e.Name()))
		if err != nil {
			d.cfg.Log.Printf("state %s: %v", e.Name(), err)
			continue
		}
		if !d.cfg.Bound(s.TargetPath) {
			d.cfg.Log.Printf("runner %s: its Pod %s is gone; unmounting its drive", s.RunnerID, s.PodUID)
			parent.Detach(filepath.Join(d.runnerRoot(s.RunnerID), "drive"))
			_ = os.Remove(d.statePath(s.RunnerID))
			continue
		}
		token, generation, err := d.credential(ctx, s.RunnerID)
		if err == nil && generation != s.Generation {
			err = fmt.Errorf("its Secret is of generation %s, the Pod of %s: superseded", generation, s.Generation)
		}
		if err != nil {
			// Left unmounted (ENOTCONN) until its Pod is unpublished: a superseded instance gets no drive.
			d.cfg.Log.Printf("runner %s: not mounted again: %v", s.RunnerID, err)
			continue
		}
		d.start(&volume{State: s}, token)
		adopted++
		d.cfg.Log.Printf("runner %s: adopted the drive of Pod %s (generation %s) again", s.RunnerID, s.PodUID, s.Generation)
	}
	return adopted
}

// freeUID is the lowest daemon uid from UIDBase no runner on this node has, by the plugin's volumes and state files.
func (d *Driver) freeUID() int {
	used := map[int]bool{}
	d.mu.Lock()
	for _, v := range d.volumes {
		used[v.DaemonUID] = true
	}
	d.mu.Unlock()
	entries, _ := os.ReadDir(d.cfg.StateDir)
	for _, e := range entries {
		if s, err := d.readState(filepath.Join(d.cfg.StateDir, e.Name())); err == nil {
			used[s.DaemonUID] = true
		}
	}
	for uid := d.cfg.UIDBase; ; uid++ {
		if !used[uid] {
			return uid
		}
	}
}

func (d *Driver) runnerRoot(runnerID string) string { return filepath.Join(d.cfg.Root, runnerID) }

func (d *Driver) statePath(runnerID string) string {
	return filepath.Join(d.cfg.StateDir, runnerID+".json")
}

func (d *Driver) writeState(s State) error {
	if err := os.MkdirAll(d.cfg.StateDir, 0o700); err != nil {
		return err
	}
	data, err := json.Marshal(s)
	if err != nil {
		return err
	}
	tmp := d.statePath(s.RunnerID) + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, d.statePath(s.RunnerID))
}

func (d *Driver) readState(path string) (State, error) {
	var s State
	data, err := os.ReadFile(path)
	if err != nil {
		return s, err
	}
	if err := json.Unmarshal(data, &s); err != nil {
		return s, err
	}
	if !canonicalUUID.MatchString(s.RunnerID) || filepath.Base(path) != s.RunnerID+".json" || s.TargetPath == "" || s.DaemonUID <= 0 {
		return s, errors.New("not a state file of this plugin")
	}
	if _, err := strconv.Atoi(s.Generation); err != nil {
		return s, errors.New("no generation")
	}
	return s, nil
}

func (d *Driver) stateOfVolume(volumeID string) *State {
	entries, _ := os.ReadDir(d.cfg.StateDir)
	for _, e := range entries {
		if s, err := d.readState(filepath.Join(d.cfg.StateDir, e.Name())); err == nil && s.VolumeID == volumeID {
			return &s
		}
	}
	return nil
}
