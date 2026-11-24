//go:build linux

package parent

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/hanwen/go-fuse/v2/fuse"

	"orbit/drive-mount/drivefs"
)

// Salvage moves what a dead daemon left in spool's write area (<spool>/w, one file per chunk of an open write, named
// <handle key>-<n>) into root's unsent/, as the next daemon would otherwise delete it (§6.1 "Restart and upgrade").
// The daemon keeps no index on disk, so a chunk's file and offset are not known: each chunk is kept as it is, named
// after its write and its order, and errors.log says so. Chunks whose bytes were already uploaded are kept as well;
// they cannot be told apart. unsent/ stays under limit, the oldest going first. It answers how many chunks it moved.
func Salvage(root, spool string, limit int64) int {
	dir := filepath.Join(spool, "w")
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) == 0 {
		return 0
	}
	rep := drivefs.NewReporter(drivefs.ReporterOptions{Dir: root, ShownDir: "/run/orbit-drive", UnsentLimit: limit})
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if e.Type().IsRegular() {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	moved := 0
	for _, name := range names {
		path := filepath.Join(dir, name)
		data, err := os.ReadFile(path)
		_ = os.Remove(path)
		if err != nil || len(data) == 0 {
			continue
		}
		handle, n := name, ""
		if i := strings.LastIndex(name, "-"); i > 0 {
			handle, n = name[:i], name[i+1:]
		}
		file := rep.SaveUnsent(fmt.Sprintf("salvaged-%s-chunk-%s", handle, n), data, drivefs.UnsentRecord{Mode: "SALVAGED"})
		if file == "" {
			continue
		}
		moved++
		rep.Log(fuse.EIO, "salvage", rep.UnsentPath(file), "",
			fmt.Sprintf("the drive's daemon stopped with this write open; %d bytes of it (chunk %s of write %s, its place in the file unknown) were kept here", len(data), n, handle))
	}
	return moved
}
