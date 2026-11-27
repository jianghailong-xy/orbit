package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"

	"orbit/link-gateway/linkpb"
)

// What the gateway writes goes in pieces of at most sendPieceBytes (§15.15), however large the frame and however many
// tiers are in the middle of one: each tier can be in the middle of one frame, so a runner holds up to four partial
// frames at once, which is its bound (src/runner-go/link_frame.go, linkMaxPartialFrames).

// bigFrame is a frame whose encoded size, once its id is a one-byte varint, is size.
func bigFrame(size int) *linkpb.Frame {
	f := &linkpb.Frame{Id: 1, Body: &linkpb.Frame_RpcResult{RpcResult: &linkpb.RpcResult{RequestId: fmt.Sprintf("r-%d", size),
		Outcome: &linkpb.RpcResult_Tunnel{Tunnel: &linkpb.TunnelResponse{Status: 200}}}}}
	body := size - proto.Size(f)
	for {
		f.GetRpcResult().GetTunnel().JsonBody = bytes.Repeat([]byte("x"), body)
		over := proto.Size(f) - size
		if over == 0 {
			break
		}
		body -= over
	}
	f.Id = 0
	return f
}

// frameDigest identifies a frame by its deterministic encoding, the same in either module's generated code.
func frameDigest(f *linkpb.Frame) string {
	b, err := proto.MarshalOptions{Deterministic: true}.Marshal(f)
	if err != nil {
		panic(err)
	}
	sum := sha256.Sum256(b)
	return fmt.Sprintf("frame %d %s", f.GetId(), hex.EncodeToString(sum[:]))
}

func TestFourTiersInPiecesAtOnceIncludingAnEightMiBFrame(t *testing.T) {
	c, w := writerConn(t)
	// Each message the writer writes is taken, joined by the gateway's own reassembler as its stub runner joins them,
	// and its write let go on.
	var msgs [][]byte
	var r reassembler
	var joined []string
	open := 0
	take := func() {
		t.Helper()
		var b []byte
		select {
		case b = <-w.written:
		case <-time.After(10 * time.Second):
			t.Fatal("the writer wrote nothing")
		}
		msgs = append(msgs, b)
		if len(b) > sendPieceBytes+64 {
			t.Fatalf("message %d is %d bytes", len(msgs)-1, len(b))
		}
		var f linkpb.Frame
		if err := proto.Unmarshal(b, &f); err != nil {
			t.Fatal(err)
		}
		if f.GetChunk() == nil {
			t.Fatalf("a whole frame %s, every one here is over sendPieceBytes", summarize(&f))
		}
		j, err := r.add(f.GetChunk())
		if err != nil {
			t.Fatal(err)
		}
		open = max(open, len(r.partials))
		if j != nil {
			joined = append(joined, frameDigest(j))
		}
	}
	step := func() { w.step <- struct{}{} }

	// The lowest tier first; each tier above is queued while the one below is in its first piece, so its frame is
	// started between two pieces of the lower one's.
	frames := []*linkpb.Frame{bigFrame(100 << 10), bigFrame(200 << 10), bigFrame(300 << 10), bigFrame(8 << 20)}
	tiers := []tier{tierStream, tierLive, tierNormal, tierControl}
	for i, f := range frames {
		c.sendTier(f, tiers[i])
		if i > 0 {
			step()
		}
		take()
	}
	for len(joined) < len(frames) {
		step()
		take()
	}
	step()

	largest := 0
	for _, m := range msgs {
		largest = max(largest, len(m))
	}
	t.Logf("%d messages, the largest %d bytes", len(msgs), largest)
	want := map[string]bool{}
	for _, f := range frames {
		want[frameDigest(f)] = true
	}
	if open != 4 {
		t.Fatalf("%d frames in pieces at once at most, want 4", open)
	}
	for _, d := range joined {
		if !want[d] {
			t.Fatalf("joined a frame that was not sent: %s", d)
		}
		delete(want, d)
	}

	// And so does the runner's, src/runner-go/link_frame.go as it is in this checkout.
	got := runnerReassembles(t, msgs)
	wantOut := strings.Join(joined, "\n") + "\nopen 4\n"
	if got != wantOut {
		t.Fatalf("the runner's reassembler printed\n%s\nwant\n%s", got, wantOut)
	}
}

// runnerJoin is the main of a program built from the runner's reassembler: it joins the messages in the file it is
// given and prints a digest of each frame, then how many frames were open at once at most.
const runnerJoin = `package main

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"os"

	"google.golang.org/protobuf/proto"

	"orbit/linkpb"
)

func main() {
	data, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(err)
	}
	var r linkReassembler
	open := 0
	for len(data) > 0 {
		n := binary.BigEndian.Uint32(data)
		m := data[4 : 4+n]
		data = data[4+n:]
		f := &linkpb.Frame{}
		if err := proto.Unmarshal(m, f); err != nil {
			panic(err)
		}
		if c := f.GetChunk(); c != nil {
			j, err := r.add(c)
			if err != nil {
				fmt.Println("error", err)
				os.Exit(1)
			}
			open = max(open, len(r.partials))
			if j == nil {
				continue
			}
			f = j
		}
		b, err := proto.MarshalOptions{Deterministic: true}.Marshal(f)
		if err != nil {
			panic(err)
		}
		sum := sha256.Sum256(b)
		fmt.Printf("frame %d %s\n", f.GetId(), hex.EncodeToString(sum[:]))
	}
	fmt.Printf("open %d\n", open)
}
`

// runnerReassembles feeds msgs to the runner's reassembler, built from the runner module's source in this checkout
// into a module of its own (the runner's is package main, which nothing imports), and returns what it printed.
func runnerReassembles(t *testing.T, msgs [][]byte) string {
	t.Helper()
	runner := filepath.Join("..", "runner-go")
	if _, err := os.Stat(filepath.Join(runner, "link_frame.go")); err != nil {
		t.Skipf("no runner source beside the gateway: %v", err)
	}
	goBin, err := exec.LookPath("go")
	if err != nil {
		t.Skip("no go command")
	}
	dir := t.TempDir()
	copyFile := func(from, to string) {
		b, err := os.ReadFile(from)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(filepath.Dir(to), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(to, b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	copyFile(filepath.Join(runner, "link_frame.go"), filepath.Join(dir, "link_frame.go"))
	copyFile(filepath.Join(runner, "linkpb", "runner_link.pb.go"), filepath.Join(dir, "linkpb", "runner_link.pb.go"))
	// The gateway's go.sum: both modules require the same protobuf (go.mod), which this one is held to.
	copyFile("go.sum", filepath.Join(dir, "go.sum"))
	protobuf := ""
	mod, _ := os.ReadFile("go.mod")
	for _, line := range strings.Split(string(mod), "\n") {
		if f := strings.Fields(line); len(f) == 2 && f[0] == "google.golang.org/protobuf" {
			protobuf = f[1]
		}
	}
	files := map[string]string{
		"go.mod":  "module orbit\n\ngo 1.26.0\n\nrequire google.golang.org/protobuf " + protobuf + "\n",
		"main.go": runnerJoin,
	}
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	var in bytes.Buffer
	for _, m := range msgs {
		_ = binary.Write(&in, binary.BigEndian, uint32(len(m)))
		in.Write(m)
	}
	capture := filepath.Join(dir, "messages.bin")
	if err := os.WriteFile(capture, in.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(goBin, "run", ".", capture)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GOWORK=off", "GOFLAGS=-mod=mod")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("the runner's reassembler: %v\n%s", err, out)
	}
	return string(out)
}
