package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// mountinfo as the two backends' runner containers see it: the Docker test host's (D10, a local
// volume on the host's ext4) and a Kubernetes Pod's (an RBD volume, its own ext4), with the image's
// overlay root and a few mounts beside them.
const dockerMountinfo = `1991 1890 0:178 / / ro,relatime master:476 - overlay overlay rw,lowerdir=/var/lib/docker/overlay2/l/A,upperdir=/var/lib/docker/overlay2/x/diff
1992 1991 0:181 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw
2004 1991 0:183 / /tmp rw,nosuid,nodev - tmpfs tmpfs rw,size=1048576k,mode=1777
2005 1991 8:16 /tmp/34ilx9dqVOKBeYZObuIjI/dind/docker/volumes/mr-data-01a155a1-d3c3-76fe-b73f-dfb5b6cd3305/_data /var/lib/orbit rw,noatime master:478 - ext4 /dev/sdb rw
2006 1991 8:16 /tmp/34ilx9dqVOKBeYZObuIjI/dind/docker/volumes/mr-boot-01a155a1-d3c3-76fe-b73f-dfb5b6cd3305-g2/_data /run/orbit-bootstrap ro,noatime master:478 - ext4 /dev/sdb rw
`

const kubernetesMountinfo = `3001 2900 0:301 / / rw,relatime - overlay overlay rw,lowerdir=/var/lib/rancher/k3s/agent/containerd/snapshots/1/fs
3010 3001 252:0 / /var/lib/orbit rw,relatime - ext4 /dev/rbd0 rw,stripe=16
3011 3001 0:310 / /run/orbit-bootstrap ro,relatime - tmpfs tmpfs rw,size=1024k
3012 3001 253:1 /var/lib/kubelet/pods/0a/etc-hosts /etc/hosts rw,relatime - ext4 /dev/vda1 rw
`

func withMountinfo(t *testing.T, table string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "mountinfo")
	if err := os.WriteFile(path, []byte(table), 0o600); err != nil {
		t.Fatal(err)
	}
	saved := mountinfoPath
	mountinfoPath = path
	t.Cleanup(func() { mountinfoPath = saved })
}

func TestVolumeFilesystemTellsADockerVolumeFromAnRBDVolume(t *testing.T) {
	for _, tc := range []struct {
		name, table, path, filesystem string
		shared                        bool
	}{
		{"a Docker local volume: a directory of the host's ext4", dockerMountinfo, "/var/lib/orbit/home/.orbit", "/dev/sdb (ext4)", true},
		{"the Docker volume's own mount point", dockerMountinfo, "/var/lib/orbit", "/dev/sdb (ext4)", true},
		{"a Kubernetes volume on RBD: an ext4 of its own", kubernetesMountinfo, "/var/lib/orbit/home/.orbit", "/dev/rbd0 (ext4)", false},
		{"not on the volume: the image's root", dockerMountinfo, "/var/lib/orbitx", "overlay (overlay)", false},
		{"a tmpfs", dockerMountinfo, "/tmp/build", "tmpfs (tmpfs)", false},
		{"a file a Pod mounts from its node's disk", kubernetesMountinfo, "/etc/hosts", "/dev/vda1 (ext4)", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			withMountinfo(t, tc.table)
			filesystem, shared, err := volumeFilesystemOf(tc.path)
			if err != nil || filesystem != tc.filesystem || shared != tc.shared {
				t.Fatalf("volumeFilesystemOf(%s) = %q, shared %t, %v; want %q, shared %t", tc.path, filesystem, shared, err, tc.filesystem, tc.shared)
			}
		})
	}
}

// The later of two mounts at one point is the one a path reaches; escaped characters are undone.
func TestVolumeFilesystemTakesTheVisibleMountAndUnescapesIt(t *testing.T) {
	withMountinfo(t, `1 0 0:1 / / rw - overlay overlay rw
2 1 8:16 /volumes/old/_data /var/lib/orbit rw - ext4 /dev/sdb rw
3 1 252:0 / /var/lib/orbit rw - ext4 /dev/rbd1 rw
4 1 8:17 /a\040dir /mnt/with\040space rw shared:7 - xfs /dev/sdc\134x rw
`)
	if filesystem, shared, err := volumeFilesystemOf("/var/lib/orbit/home"); err != nil || filesystem != "/dev/rbd1 (ext4)" || shared {
		t.Fatalf("over a hidden mount: %q, shared %t, %v; want the later RBD mount, not shared", filesystem, shared, err)
	}
	if filesystem, shared, err := volumeFilesystemOf("/mnt/with space/x"); err != nil || filesystem != `/dev/sdc\x (xfs)` || !shared {
		t.Fatalf("an escaped mount point: %q, shared %t, %v", filesystem, shared, err)
	}
}

// A table that cannot be read is an error, which the runner takes as a volume of its own.
func TestVolumeFilesystemWithoutMountinfo(t *testing.T) {
	saved := mountinfoPath
	mountinfoPath = filepath.Join(t.TempDir(), "missing")
	t.Cleanup(func() { mountinfoPath = saved })
	if _, shared, err := volumeFilesystemOf("/var/lib/orbit"); err == nil || shared {
		t.Fatalf("without mountinfo: shared %t, %v; want an error", shared, err)
	}
}

// The start says which syncs the runner makes, with the filesystem it read; a self-managed runner
// says nothing.
func TestTheStartSaysWhichVolumeSyncsTheRunnerMakes(t *testing.T) {
	t.Setenv("ORBIT_HOME", "/var/lib/orbit/home/.orbit")
	withMountinfo(t, dockerMountinfo)
	withoutManagedInstance(t)
	if logs := captureLogs(t, logManagedVolumeSyncs); logs != "" {
		t.Fatalf("a self-managed runner logged %q", logs)
	}
	withManagedInstance(t, "4", testManagedPodUID)
	volumeSharedAs(t, true)
	logs := captureLogs(t, logManagedVolumeSyncs)
	if !strings.Contains(logs, "volume syncs: before reports only; the volume is a directory of /dev/sdb (ext4), which it shares") {
		t.Fatalf("on a Docker volume the start logged %q", logs)
	}
	withMountinfo(t, kubernetesMountinfo)
	volumeSharedAs(t, false)
	logs = captureLogs(t, logManagedVolumeSyncs)
	if !strings.Contains(logs, "volume syncs: before reports and behind every tool; the volume is /dev/rbd0 (ext4), a filesystem of its own") {
		t.Fatalf("on an RBD volume the start logged %q", logs)
	}
}

// volumeSharesItsFilesystem reads the mount that holds ORBIT_HOME: a Docker local volume shares its
// filesystem, an RBD volume does not, and a table it cannot read keeps T02c's syncs.
func TestManagedVolumeSharedReadsTheMountOfOrbitHome(t *testing.T) {
	t.Setenv("ORBIT_HOME", "/var/lib/orbit/home/.orbit")
	saved := mountinfoPath
	t.Cleanup(func() { mountinfoPath = saved })
	for _, tc := range []struct {
		name, table string
		want        bool
	}{{"Docker", dockerMountinfo, true}, {"Kubernetes", kubernetesMountinfo, false}, {"unreadable", "", false}} {
		if tc.table == "" {
			mountinfoPath = filepath.Join(t.TempDir(), "missing")
		} else {
			withMountinfo(t, tc.table)
		}
		if got := volumeSharesItsFilesystem(); got != tc.want {
			t.Fatalf("%s: shared %t, want %t", tc.name, got, tc.want)
		}
	}
}
