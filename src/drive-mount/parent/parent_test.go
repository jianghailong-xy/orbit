//go:build linux

package parent

import (
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestProcStatReadsStartAndParent(t *testing.T) {
	start, ppid, ok := procStat(os.Getpid())
	if !ok || start == 0 || ppid != os.Getppid() {
		t.Fatalf("start %d ppid %d ok %v", start, ppid, ok)
	}
	if _, _, ok := procStat(1 << 30); ok {
		t.Fatal("no such process")
	}
}

// A session is the ORBIT_SESSION_ID of the writer or its nearest ancestor that has one, never past the runner Pod.
func TestWhoisWalksUpToTheSessionAndStopsAtThePod(t *testing.T) {
	cmd := exec.Command("sh", "-c", "env -u ORBIT_SESSION_ID sleep 30 & echo $!; wait")
	cmd.Env = append(os.Environ(), "ORBIT_SESSION_ID=s-walked")
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	}()
	buf := make([]byte, 32)
	n, _ := out.Read(buf)
	var pid int
	for _, c := range strings.TrimSpace(string(buf[:n])) {
		pid = pid*10 + int(c-'0')
	}
	time.Sleep(100 * time.Millisecond)
	if env := environValue(pid, "ORBIT_SESSION_ID"); env != "" {
		t.Fatalf("the sleep has no session of its own, has %q", env)
	}
	start, session := newWhois("-").lookup(pid)
	if start == 0 || session != "s-walked" {
		t.Fatalf("start %d session %q", start, session)
	}
	// Not in the Pod's cgroup: nothing, whatever the environment says.
	if _, session := newWhois("no-such-pod-uid").lookup(pid); session != "" {
		t.Fatalf("outside the pod: %q", session)
	}
	cgroup, _ := os.ReadFile("/proc/self/cgroup")
	own := strings.TrimSpace(strings.SplitN(string(cgroup), "::", 2)[1])
	if !inPod(pid, own) {
		t.Fatalf("the child is in %s", own)
	}
}

func TestConnectionReadsMountinfo(t *testing.T) {
	if _, err := connection("/no/such/mount"); err == nil {
		t.Fatal("not mounted")
	}
	if mounted(t.TempDir()) {
		t.Fatal("a plain directory is not mounted")
	}
}
