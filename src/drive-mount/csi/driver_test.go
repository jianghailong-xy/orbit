//go:build linux

package csi

import (
	"context"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	csipb "github.com/container-storage-interface/spec/lib/go/csi"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"orbit/drive-mount/door"
	"orbit/drive-mount/parent"
)

const (
	runnerA = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"
	runnerB = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c"
	managed = "orbit-managed"
)

type fakeSecrets map[string]*Secret

func (f fakeSecrets) Get(_ context.Context, namespace, name string) (*Secret, error) {
	return f[namespace+"/"+name], nil
}

func mountSecret(runnerID, generation, token string) *Secret {
	return &Secret{
		Annotations: map[string]string{runnerIDAnnot: runnerID, generationAnnot: generation},
		Data:        map[string][]byte{"token": []byte(token), "generation": []byte(generation)},
	}
}

// world is a driver whose parent, door and mounts are fakes, recording what it was asked.
type world struct {
	t       *testing.T
	d       *Driver
	dir     string
	secrets fakeSecrets
	probe   error

	mu     sync.Mutex
	bound  map[string]string // target → source
	runs   []parent.Config
	active map[string]bool // roots with a parent running
}

func newWorld(t *testing.T) *world {
	w := &world{t: t, dir: t.TempDir(), secrets: fakeSecrets{}, bound: map[string]string{}, active: map[string]bool{}}
	w.secrets["orbit-drive-system/mrf-"+runnerA] = mountSecret(runnerA, "4", "orbit_drive_mount_a")
	w.secrets["orbit-drive-system/mrf-"+runnerB] = mountSecret(runnerB, "1", "orbit_drive_mount_b")
	w.d = New(w.config())
	return w
}

func (w *world) config() Config {
	return Config{
		NodeID: "node-a", ManagedNamespace: managed, SecretsNamespace: "orbit-drive-system", Server: "https://orbit.invalid",
		Root: filepath.Join(w.dir, "root"), SpoolRoot: filepath.Join(w.dir, "spool"), StateDir: filepath.Join(w.dir, "state"),
		Daemon: "/bin/false", Secrets: w.secrets, MountTimeout: 2 * time.Second, Log: log.New(io.Discard, "", 0),
		Probe: func(context.Context, string, string, string) error { return w.probe },
		Run: func(ctx context.Context, cfg parent.Config) error {
			w.mu.Lock()
			w.runs = append(w.runs, cfg)
			w.active[cfg.Root] = true
			w.mu.Unlock()
			cfg.OnMount()
			<-ctx.Done()
			w.mu.Lock()
			delete(w.active, cfg.Root)
			w.mu.Unlock()
			return ctx.Err()
		},
		Bind: func(source, target string) error {
			w.mu.Lock()
			defer w.mu.Unlock()
			w.bound[target] = source
			return nil
		},
		Unbind: func(target string) error {
			w.mu.Lock()
			defer w.mu.Unlock()
			delete(w.bound, target)
			return nil
		},
		Bound: func(target string) bool {
			w.mu.Lock()
			defer w.mu.Unlock()
			_, ok := w.bound[target]
			return ok
		},
	}
}

func publishRequest(runnerID, podUID string, change func(r *csipb.NodePublishVolumeRequest)) *csipb.NodePublishVolumeRequest {
	r := &csipb.NodePublishVolumeRequest{
		VolumeId:   "csi-" + podUID,
		TargetPath: "/var/lib/kubelet/pods/" + podUID + "/volumes/kubernetes.io~csi/orbit-drive/mount",
		VolumeCapability: &csipb.VolumeCapability{
			AccessType: &csipb.VolumeCapability_Mount{Mount: &csipb.VolumeCapability_MountVolume{}},
		},
		VolumeContext: map[string]string{
			runnerIDKey: runnerID, ephemeralKey: "true", podNamespaceKey: managed, podUIDKey: podUID,
			podNameKey: "mr-" + runnerID, "csi.storage.k8s.io/serviceAccount.name": "default",
		},
	}
	if change != nil {
		change(r)
	}
	return r
}

func (w *world) publish(r *csipb.NodePublishVolumeRequest) error {
	r.TargetPath = filepath.Join(w.dir, r.TargetPath)
	_, err := w.d.NodePublishVolume(context.Background(), r)
	return err
}

func codeOf(err error) codes.Code { return status.Code(err) }

// B13, layer 3: only a Pod of the managed namespace, only an inline volume naming nothing but its runner.
func TestPublishRefusesAnythingButAManagedRunnerPodsInlineDrive(t *testing.T) {
	cases := []struct {
		name   string
		change func(r *csipb.NodePublishVolumeRequest)
		code   codes.Code
	}{
		{"another namespace", func(r *csipb.NodePublishVolumeRequest) { r.VolumeContext[podNamespaceKey] = "tenant" }, codes.PermissionDenied},
		{"no namespace", func(r *csipb.NodePublishVolumeRequest) { delete(r.VolumeContext, podNamespaceKey) }, codes.PermissionDenied},
		{"a persistent volume", func(r *csipb.NodePublishVolumeRequest) { delete(r.VolumeContext, ephemeralKey) }, codes.InvalidArgument},
		{"an attribute beyond runnerId", func(r *csipb.NodePublishVolumeRequest) { r.VolumeContext["root"] = "/" }, codes.InvalidArgument},
		{"no runnerId", func(r *csipb.NodePublishVolumeRequest) { delete(r.VolumeContext, runnerIDKey) }, codes.InvalidArgument},
		{"a runnerId that is no uuid", func(r *csipb.NodePublishVolumeRequest) { r.VolumeContext[runnerIDKey] = "../" + runnerA }, codes.InvalidArgument},
		{"read-only", func(r *csipb.NodePublishVolumeRequest) { r.Readonly = true }, codes.InvalidArgument},
		{"a block volume", func(r *csipb.NodePublishVolumeRequest) {
			r.VolumeCapability = &csipb.VolumeCapability{AccessType: &csipb.VolumeCapability_Block{Block: &csipb.VolumeCapability_BlockVolume{}}}
		}, codes.InvalidArgument},
		{"publish secrets", func(r *csipb.NodePublishVolumeRequest) { r.Secrets = map[string]string{"token": "x"} }, codes.InvalidArgument},
		{"no pod uid", func(r *csipb.NodePublishVolumeRequest) { delete(r.VolumeContext, podUIDKey) }, codes.InvalidArgument},
	}
	for _, c := range cases {
		w := newWorld(t)
		if err := w.publish(publishRequest(runnerA, "pod-1", c.change)); codeOf(err) != c.code {
			t.Errorf("%s: %v, want %s", c.name, err, c.code)
		}
		if len(w.runs) != 0 || len(w.bound) != 0 {
			t.Errorf("%s: something was started or mounted", c.name)
		}
	}
}

// §6.1 step 4: 503 PENDING is retried by the kubelet (UNAVAILABLE); a refusal is PERMISSION_DENIED.
func TestPublishAnswersTheDoorsVerdict(t *testing.T) {
	cases := []struct {
		name string
		err  error
		code codes.Code
	}{
		{"pending", &door.HTTPError{Status: 503, Code: door.CodeInstancePending}, codes.Unavailable},
		{"unreachable", &door.TransportError{Method: "GET", Route: "/changes", Err: io.ErrUnexpectedEOF}, codes.Unavailable},
		{"another Pod", &door.FencedError{Code: door.CodeInstanceNotAuth}, codes.PermissionDenied},
		{"superseded", &door.FencedError{Code: door.CodeInstanceSuperseded}, codes.PermissionDenied},
		{"revoked", &door.FencedError{Code: door.CodeCredentialRefused}, codes.PermissionDenied},
		{"forbidden", &door.HTTPError{Status: 403, Code: "SOMETHING"}, codes.PermissionDenied},
	}
	for _, c := range cases {
		w := newWorld(t)
		w.probe = c.err
		if err := w.publish(publishRequest(runnerA, "pod-1", nil)); codeOf(err) != c.code {
			t.Errorf("%s: %v, want %s", c.name, err, c.code)
		}
		if len(w.runs) != 0 {
			t.Errorf("%s: a daemon was started", c.name)
		}
	}
}

func TestPublishWaitsForItsSecret(t *testing.T) {
	w := newWorld(t)
	delete(w.secrets, "orbit-drive-system/mrf-"+runnerA)
	if err := w.publish(publishRequest(runnerA, "pod-1", nil)); codeOf(err) != codes.Unavailable {
		t.Fatalf("no Secret yet: %v", err)
	}
	w.secrets["orbit-drive-system/mrf-"+runnerA] = mountSecret(runnerB, "4", "x")
	if err := w.publish(publishRequest(runnerA, "pod-1", nil)); codeOf(err) != codes.PermissionDenied {
		t.Fatalf("a Secret of another runner: %v", err)
	}
}

func TestPublishMountsThePlainDirectoryAndUnpublishUndoesIt(t *testing.T) {
	w := newWorld(t)
	r := publishRequest(runnerA, "pod-1", nil)
	if err := w.publish(r); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(w.dir, "root", runnerA)
	if w.bound[r.TargetPath] != root {
		t.Fatalf("bound %v; want the plain directory %s, never drive/", w.bound, root)
	}
	run := w.runs[0]
	if run.Root != root || run.Token != "orbit_drive_mount_a" || run.PodUID != "pod-1" || !run.KeepMountOnStop || run.UID < 200000 || run.UID != run.GID {
		t.Fatalf("parent config %+v", run)
	}
	if !strings.Contains(strings.Join(run.Args, " "), "--generation=4") || !strings.Contains(strings.Join(run.Args, " "), "--pod-uid=pod-1") {
		t.Fatalf("daemon args %v", run.Args)
	}
	if strings.Contains(strings.Join(run.Args, " "), "orbit_drive_mount_a") {
		t.Fatal("the credential never goes on the daemon's command line")
	}
	state, err := w.d.readState(filepath.Join(w.dir, "state", runnerA+".json"))
	if err != nil || state.PodUID != "pod-1" || state.Generation != "4" || state.TargetPath != r.TargetPath {
		t.Fatalf("state %+v %v", state, err)
	}
	// Published again by the kubelet: the same answer, nothing new started.
	if _, err := w.d.NodePublishVolume(context.Background(), r); err != nil || len(w.runs) != 1 {
		t.Fatalf("idempotent publish: %v, %d runs", err, len(w.runs))
	}
	// Another Pod of the runner waits for this one's unpublish.
	if err := w.publish(publishRequest(runnerA, "pod-2", nil)); codeOf(err) != codes.Unavailable {
		t.Fatalf("a second Pod while the first holds the drive: %v", err)
	}

	if _, err := w.d.NodeUnpublishVolume(context.Background(), &csipb.NodeUnpublishVolumeRequest{VolumeId: r.VolumeId, TargetPath: r.TargetPath}); err != nil {
		t.Fatal(err)
	}
	if len(w.bound) != 0 || len(w.active) != 0 {
		t.Fatalf("after unpublish: bound %v, running %v", w.bound, w.active)
	}
	if _, err := os.Stat(filepath.Join(w.dir, "state", runnerA+".json")); !os.IsNotExist(err) {
		t.Fatalf("state file kept: %v", err)
	}
	// Unpublished again: nothing to do.
	if _, err := w.d.NodeUnpublishVolume(context.Background(), &csipb.NodeUnpublishVolumeRequest{VolumeId: r.VolumeId, TargetPath: r.TargetPath}); err != nil {
		t.Fatal(err)
	}
	// Now the next Pod's.
	if err := w.publish(publishRequest(runnerA, "pod-2", nil)); err != nil {
		t.Fatal(err)
	}
}

// Each runner's daemon on a node has its own uid, so no daemon can read another runner's spool.
func TestEveryRunnerOnTheNodeGetsItsOwnDaemonUID(t *testing.T) {
	w := newWorld(t)
	if err := w.publish(publishRequest(runnerA, "pod-a", nil)); err != nil {
		t.Fatal(err)
	}
	if err := w.publish(publishRequest(runnerB, "pod-b", nil)); err != nil {
		t.Fatal(err)
	}
	if w.runs[0].UID == w.runs[1].UID || w.runs[0].UID == 65532 || w.runs[1].UID == 65532 {
		t.Fatalf("uids %d and %d", w.runs[0].UID, w.runs[1].UID)
	}
}

// Review A8: a restarted plugin mounts again every drive whose Pod still has it, and forgets the rest.
func TestAdoptMountsAgainWhatAPreviousStartPublished(t *testing.T) {
	w := newWorld(t)
	live := publishRequest(runnerA, "pod-a", nil)
	gone := publishRequest(runnerB, "pod-b", nil)
	if err := w.publish(live); err != nil {
		t.Fatal(err)
	}
	if err := w.publish(gone); err != nil {
		t.Fatal(err)
	}
	uid := w.runs[0].UID
	w.d.Shutdown()
	if len(w.active) != 0 {
		t.Fatal("the daemons are stopped")
	}
	if len(w.bound) != 2 {
		t.Fatal("stopping leaves every mount")
	}
	// Pod b was unpublished while the plugin was down: the kubelet unmounted its target.
	delete(w.bound, gone.TargetPath)

	cfg := w.config()
	run := cfg.Run
	started := make(chan parent.Config, 1)
	cfg.Run = func(ctx context.Context, conf parent.Config) error {
		select {
		case started <- conf:
		case <-ctx.Done():
			return ctx.Err()
		}
		return run(ctx, conf)
	}
	restarted := New(cfg)
	t.Cleanup(restarted.Shutdown)
	if n := restarted.Adopt(context.Background()); n != 1 {
		t.Fatalf("adopted %d", n)
	}
	select {
	case adopted := <-started:
		if adopted.PodUID != "pod-a" || adopted.UID != uid || adopted.Token != "orbit_drive_mount_a" {
			t.Fatalf("adopted run %+v", adopted)
		}
	case <-time.After(cfg.MountTimeout):
		t.Fatal("the adopted daemon did not start")
	}
	if _, err := os.Stat(filepath.Join(w.dir, "state", runnerB+".json")); !os.IsNotExist(err) {
		t.Fatal("the gone Pod's state is removed")
	}
	// And it is unpublished as any other.
	if _, err := restarted.NodeUnpublishVolume(context.Background(), &csipb.NodeUnpublishVolumeRequest{VolumeId: live.VolumeId, TargetPath: live.TargetPath}); err != nil {
		t.Fatal(err)
	}
	if len(w.active) != 0 || len(w.bound) != 0 {
		t.Fatalf("after unpublish: %v %v", w.active, w.bound)
	}
}

// A Pod whose generation was superseded while the plugin was down gets no drive again.
func TestAdoptLeavesASupersededInstanceUnmounted(t *testing.T) {
	w := newWorld(t)
	if err := w.publish(publishRequest(runnerA, "pod-a", nil)); err != nil {
		t.Fatal(err)
	}
	w.d.Shutdown()
	w.secrets["orbit-drive-system/mrf-"+runnerA] = mountSecret(runnerA, "5", "orbit_drive_mount_a5")
	w.runs = nil
	if n := New(w.config()).Adopt(context.Background()); n != 0 || len(w.runs) != 0 {
		t.Fatalf("adopted %d, runs %v", n, w.runs)
	}
}

func TestIdentity(t *testing.T) {
	w := newWorld(t)
	info, _ := w.d.GetPluginInfo(context.Background(), nil)
	node, _ := w.d.NodeGetInfo(context.Background(), nil)
	caps, _ := w.d.NodeGetCapabilities(context.Background(), nil)
	if info.Name != "drive.orbit.dev" || node.NodeId != "node-a" || len(caps.Capabilities) != 0 {
		t.Fatalf("%v %v %v", info, node, caps)
	}
}
