//go:build linux

package parent

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// §6.1 "Restart and upgrade": a dead daemon's open writes are kept in unsent/, never deleted by the next daemon.
func TestSalvageMovesADeadDaemonsChunksIntoUnsent(t *testing.T) {
	root, spool := t.TempDir(), t.TempDir()
	w := filepath.Join(spool, "w")
	if err := os.MkdirAll(w, 0o700); err != nil {
		t.Fatal(err)
	}
	for name, data := range map[string]string{"k1-1": "first chunk", "k1-2": "second", "k2-1": "other write", "k3-1": ""} {
		if err := os.WriteFile(filepath.Join(w, name), []byte(data), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if n := Salvage(root, spool, 1<<30); n != 3 {
		t.Fatalf("moved %d", n)
	}
	if left, _ := os.ReadDir(w); len(left) != 0 {
		t.Fatalf("left in the spool: %v", left)
	}
	files, _ := os.ReadDir(filepath.Join(root, "unsent"))
	var kept []string
	for _, f := range files {
		if !f.IsDir() {
			kept = append(kept, f.Name())
		}
	}
	if len(kept) != 3 {
		t.Fatalf("unsent %v", kept)
	}
	data, _ := os.ReadFile(filepath.Join(root, "unsent", kept[0]))
	if string(data) != "first chunk" || !strings.HasSuffix(kept[0], "salvaged-k1-chunk-1") {
		t.Fatalf("%s: %q", kept[0], data)
	}
	var rec map[string]interface{}
	meta, _ := os.ReadFile(filepath.Join(root, "unsent", ".state", kept[0]+".json"))
	if json.Unmarshal(meta, &rec) != nil || rec["mode"] != "SALVAGED" {
		t.Fatalf("record %s", meta)
	}
	log, _ := os.ReadFile(filepath.Join(root, "errors.log"))
	if !strings.Contains(string(log), "/run/orbit-drive/unsent/"+kept[0]) || strings.Count(string(log), "EIO salvage ") != 3 {
		t.Fatalf("errors.log:\n%s", log)
	}
	if Salvage(root, spool, 1<<30) != 0 {
		t.Fatal("nothing twice")
	}
}

func TestSalvageKeepsUnsentUnderItsLimit(t *testing.T) {
	root, spool := t.TempDir(), t.TempDir()
	_ = os.MkdirAll(filepath.Join(spool, "w"), 0o700)
	for _, name := range []string{"a-1", "a-2", "a-3"} {
		_ = os.WriteFile(filepath.Join(spool, "w", name), make([]byte, 100), 0o600)
	}
	Salvage(root, spool, 250)
	var total int64
	files, _ := os.ReadDir(filepath.Join(root, "unsent"))
	for _, f := range files {
		if info, err := f.Info(); err == nil && !f.IsDir() {
			total += info.Size()
		}
	}
	if total > 250 {
		t.Fatalf("unsent/ holds %d bytes", total)
	}
}
