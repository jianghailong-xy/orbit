package main

// The Node DeepSeek Harness runs on.
//
// dsh 0.2.0-rc.2 is admitted on Node 26 only: P0 measured it on the official v26.10.0 build with its
// npm 11.19.1, and on nothing else (docs/deepseek-harness-runtime-contract.md §1). A runner whose
// service PATH has Node 26 runs dsh on it, as it always has. Any other Linux x64 runner gets Node 26
// from the install itself: that same official build, downloaded from nodejs.org, checked against the
// size and SHA-256 its signed SHASUMS256.txt records, and unpacked into a directory of Orbit's own,
// <orbit home>/engines/node/v26.10.0, which is never rewritten afterwards.
//
// That copy goes on no PATH a session sees. dsh is started as `<that node> <dsh entry point>`, and dsh
// starts each Node process of its own on process.execPath, so the agent's commands keep the machine's
// own node, or none. Before this, a runner without Node 26 could not run Harness at all until somebody
// put Node 26 first on the runner service's PATH, under every engine's sessions on that machine
// (docs/evidence/deepseek-harness/production-rollout/batch-2.md).

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const dshNodeVersion = "v26.10.0"

// dshNodeBuild is the official linux-x64 build of dshNodeVersion: the tarball's name, which is also the
// one directory it holds everything under, and the size and SHA-256 of node-v26.10.0-linux-x64.tar.gz.
// The digest is SHASUMS256.txt's, whose signature by a Node.js release key listed in nodejs/node's
// README (5BE8A3F6C8A5C01D106C0AD820B1A390B168D356) was verified when it was pinned. Tests replace it
// with a tarball of their own.
var dshNodeBuild = struct {
	name, sha256 string
	size         int64
}{
	name:   "node-v26.10.0-linux-x64",
	sha256: "cb5c9ce9c80d7b8821e3a258543c71b939138cf17c74d5cc44bbe85d6dbc5ad8",
	size:   62659089,
}

// dshNodeDownloadBase is where Node builds are fetched from. Tests point it at a server of their own.
var dshNodeDownloadBase = "https://nodejs.org/dist"

func dshNodeDir() string { return filepath.Join(machineHome(), "engines", "node", dshNodeVersion) }

func dshNodeTarballURL() string {
	return dshNodeDownloadBase + "/" + dshNodeVersion + "/" + dshNodeBuild.name + ".tar.gz"
}

// errDshNodeMissing is a runner with no Node 26 dsh can run on yet, which is the install's to fix.
var errDshNodeMissing = errors.New("DSH_NOT_INSTALLED: DeepSeek Harness runs on Node 26, which this runner's service PATH does not have, " +
	"and Orbit has not installed its own copy here yet; install DeepSeek Harness from Orbit, which fetches it, or run `orbit doctor` on this runner")

// dshNode is the Node dsh runs on here: "" for the service PATH's own node when it is Node 26, which
// the entry point's `#!/usr/bin/env node` finds by itself, else the node of Orbit's copy.
func dshNode() (string, error) {
	if path, ok := lookPathIn("node", dshServicePath()); ok {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, path, "--version")
		cmd.Env = []string{"PATH=" + dshServicePath(), "HOME=" + userHome()}
		if out, err := cmd.Output(); err == nil && dshPlatformAdmission(runtime.GOOS, runtime.GOARCH, string(out)) == nil {
			return "", nil
		}
	}
	return dshManagedNode()
}

// dshManagedNode is the node of Orbit's copy, checked as dshExecutableIn checks dsh's entry point: a
// directory Orbit published rather than a link to one, holding bin/node as an executable file. It
// started before it was published (installDshNode), and every dsh probe runs on it after.
func dshManagedNode() (string, error) {
	dir := dshNodeDir()
	info, err := os.Lstat(dir)
	if errors.Is(err, os.ErrNotExist) {
		return "", errDshNodeMissing
	}
	if err != nil {
		return "", fmt.Errorf("DSH_INSTALL_FAILED: Orbit's Node directory %s cannot be read: %w", dir, err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return "", fmt.Errorf("DSH_INSTALL_FAILED: Orbit's Node directory %s is not a directory Orbit published", dir)
	}
	node := filepath.Join(dir, "bin", "node")
	if stat, err := os.Lstat(node); err != nil || !stat.Mode().IsRegular() || stat.Mode()&0o111 == 0 {
		return "", fmt.Errorf("DSH_INSTALL_FAILED: Orbit's Node directory %s has no executable bin/node", dir)
	}
	return node, nil
}

// dshCommand is the command line that runs dsh's entry point with args on node, as dshNode names it.
func dshCommand(node, entry string, args ...string) (string, []string) {
	if node == "" {
		return entry, args
	}
	return node, append([]string{entry}, args...)
}

// installDshNode publishes Orbit's copy of Node 26. The caller holds engineInstall.mu (installDsh).
func installDshNode(ctx context.Context, proxyVars []envVar) error {
	target := dshNodeDir()
	parent := filepath.Dir(target)
	if err := os.MkdirAll(parent, machineHomePerm); err != nil {
		return err
	}
	stage, err := os.MkdirTemp(parent, ".install-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	tarball := filepath.Join(stage, dshNodeBuild.name+".tar.gz")
	if err := downloadDshNode(ctx, tarball, proxyVars); err != nil {
		return err
	}
	unpacked := filepath.Join(stage, "node")
	if err := unpackDshNode(tarball, unpacked); err != nil {
		return err
	}
	// The checked bytes can still need a glibc or a library this machine does not have.
	probeCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(probeCtx, filepath.Join(unpacked, "bin", "node"), "--version")
	cmd.Env = []string{"PATH=" + dshServicePath(), "HOME=" + userHome()}
	if out, err := cmd.CombinedOutput(); err != nil {
		reason := firstLine(strings.TrimSpace(string(out)))
		if reason == "" {
			reason = firstLine(err.Error())
		}
		return fmt.Errorf("DSH_NODE_UNSUPPORTED: Node %s, which DeepSeek Harness runs on, does not start on this runner (%s)", dshNodeVersion, reason)
	}
	return os.Rename(unpacked, target)
}

// downloadDshNode fetches the pinned tarball into dest and refuses it unless it is exactly the bytes
// SHASUMS256.txt names, the way downloadCursorTarball refuses Cursor CLI's: nothing is unpacked from a
// tarball that failed either check, and a server that keeps sending is cut off one byte past the size.
func downloadDshNode(ctx context.Context, dest string, proxyVars []envVar) error {
	source := dshNodeTarballURL()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, source, nil)
	if err != nil {
		return err
	}
	// Through the proxy the runner's engine installs use, as Cursor CLI's pinned build is fetched.
	resp, err := cursorDownloadClient(proxyVars).Do(req)
	if err != nil {
		return fmt.Errorf("DSH_INSTALL_FAILED: downloading Node %s for DeepSeek Harness failed (%s)", dshNodeVersion, firstLine(err.Error()))
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("DSH_INSTALL_FAILED: downloading Node %s for DeepSeek Harness failed: %s answered %s", dshNodeVersion, source, resp.Status)
	}
	file, err := os.OpenFile(dest, os.O_WRONLY|os.O_CREATE|os.O_EXCL, configFilePerm)
	if err != nil {
		return err
	}
	digest := sha256.New()
	n, copyErr := io.Copy(io.MultiWriter(file, digest), io.LimitReader(resp.Body, dshNodeBuild.size+1))
	closeErr := file.Close()
	if copyErr != nil {
		return fmt.Errorf("DSH_INSTALL_FAILED: downloading Node %s for DeepSeek Harness failed (%s)", dshNodeVersion, firstLine(copyErr.Error()))
	}
	if closeErr != nil {
		return closeErr
	}
	if n != dshNodeBuild.size || hex.EncodeToString(digest.Sum(nil)) != dshNodeBuild.sha256 {
		return fmt.Errorf("DSH_INSTALL_FAILED: the Node %s tarball from %s does not match its pinned size and SHA-256; nothing was installed", dshNodeVersion, source)
	}
	return nil
}

// unpackDshNode unpacks the build's one top directory into dir. The checked tarball holds files,
// directories and two links, bin/npm and bin/npx, each relative and inside the build; any other kind of
// entry, or a path or link that leaves the build, is refused rather than skipped.
func unpackDshNode(tarball, dir string) error {
	file, err := os.Open(tarball)
	if err != nil {
		return err
	}
	defer file.Close()
	gz, err := gzip.NewReader(file)
	if err != nil {
		return fmt.Errorf("DSH_INSTALL_FAILED: the Node tarball is not gzip: %w", err)
	}
	defer gz.Close()
	if err := os.Mkdir(dir, 0o755); err != nil {
		return err
	}
	inside := func(rel string) bool {
		return rel != "" && rel != "." && rel != ".." && !strings.HasPrefix(rel, "../")
	}
	archive := tar.NewReader(gz)
	for {
		header, err := archive.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("DSH_INSTALL_FAILED: the Node tarball cannot be read: %w", err)
		}
		name := path.Clean(header.Name)
		if name == dshNodeBuild.name {
			continue
		}
		rel, ok := strings.CutPrefix(name, dshNodeBuild.name+"/")
		if !ok || !inside(rel) {
			return fmt.Errorf("DSH_INSTALL_FAILED: the Node tarball holds %q outside %s/", header.Name, dshNodeBuild.name)
		}
		target := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, header.FileInfo().Mode().Perm()&0o755)
			if err != nil {
				return err
			}
			_, copyErr := io.Copy(out, archive)
			closeErr := out.Close()
			if copyErr != nil {
				return copyErr
			}
			if closeErr != nil {
				return closeErr
			}
		case tar.TypeSymlink:
			if path.IsAbs(header.Linkname) || !inside(path.Join(path.Dir(rel), header.Linkname)) {
				return fmt.Errorf("DSH_INSTALL_FAILED: the Node tarball links %q outside %s/", header.Name, dshNodeBuild.name)
			}
			if err := os.Symlink(header.Linkname, target); err != nil {
				return err
			}
		default:
			return fmt.Errorf("DSH_INSTALL_FAILED: the Node tarball holds %q, which is not a file, a directory or a link", header.Name)
		}
	}
}
