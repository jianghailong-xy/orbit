package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// volumeFilesystemOf says which filesystem holds path, from /proc/self/mountinfo: the mount whose
// mount point is the longest one above path, as "<source> (<type>)", and whether that mount is only a
// directory of its filesystem (its root, the fourth field, is not "/"). A Docker local volume is a
// directory of the Docker host's filesystem bind-mounted into the container, so its root names
// that directory; a Kubernetes volume on RBD is the root of an ext4 of its own.
func volumeFilesystemOf(path string) (filesystem string, shared bool, err error) {
	data, err := os.ReadFile(mountinfoPath)
	if err != nil {
		return "", false, err
	}
	path = filepath.Clean(path)
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		path = resolved
	}
	best := -1
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		separator := -1
		for i, field := range fields {
			if field == "-" {
				separator = i
				break
			}
		}
		if len(fields) < 5 || separator < 6 || len(fields) < separator+3 {
			continue
		}
		point := unescapeMountinfo(fields[4])
		if point != "/" && path != point && !strings.HasPrefix(path, point+"/") {
			continue
		}
		// The longest mount point holds path; of two mounts at one point, the later hides the earlier.
		if len(point) < best {
			continue
		}
		best = len(point)
		filesystem = fmt.Sprintf("%s (%s)", unescapeMountinfo(fields[separator+2]), fields[separator+1])
		shared = unescapeMountinfo(fields[3]) != "/"
	}
	if best < 0 {
		return "", false, fmt.Errorf("no mount holds %s", path)
	}
	return filesystem, shared, nil
}

// mountinfoPath is a variable so tests can give their own table.
var mountinfoPath = "/proc/self/mountinfo"

// unescapeMountinfo undoes the kernel's octal escapes of a mountinfo field (\040 for a space).
func unescapeMountinfo(field string) string {
	if !strings.Contains(field, `\`) {
		return field
	}
	var b strings.Builder
	for i := 0; i < len(field); i++ {
		if field[i] == '\\' && i+3 < len(field) {
			if n, err := strconv.ParseUint(field[i+1:i+4], 8, 8); err == nil {
				b.WriteByte(byte(n))
				i += 3
				continue
			}
		}
		b.WriteByte(field[i])
	}
	return b.String()
}
