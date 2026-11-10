package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// localFileScope is the one rule for a file of this machine on its way to the control plane, whichever door it leaves
// by: file_upload, a file a reply links, a legacy artifact request or Codex's generated image. It goes by where a path
// really is, with its links resolved, against the roots newLocalFileScope allows, and open is the only way it hands a
// file on, so that what was judged is what is read.
//
// The doors need one rule because they share an end: file_list and file_fetch read back whatever a session's rows hold,
// so a door that read further than the others would widen all of them. These tools are also always allowed, with no
// prompt in any permission mode, and they run outside the engine's sandbox.
//
// Orbit's own directory is refused first and whatever the roots say: it holds the machine's credentials, kept in a file
// so that they stay out of the engine (cmdMcp), and a root can hold it. It is known by what it is, not only by its name
// (inOrbitsDirectory).
//
// A background shell's live output is the one door with a narrower rule of its own: it reads one file the engine made for
// one of its own calls, and nothing else (bgTailer.onToolResult).
type localFileScope struct {
	// Orbit's own directory (machineHome), and what stands there. Nil when nothing could be read of it.
	home     string
	homeInfo os.FileInfo
	// The roots inside it, which are the session's own.
	own []string
	// Where a path may be.
	roots []string
}

// The reasons a path is refused, which also say so to whoever reads a refusal.
const (
	localFileInOrbitsDirectory = "inside Orbit's own directory, which holds this machine's credentials"
	localFileOutsideTheSession = "outside this session's checkout and uploads directory"
)

// localFileRefused is the scope's answer for a path it will not read.
type localFileRefused struct{ reason string }

func (e *localFileRefused) Error() string { return "the path is " + e.reason }

// newLocalFileScope takes a session's own directories, which may be under Orbit's, and any other root, which never
// makes anything there readable. Orbit's directory itself, or one that holds it, is nobody's own.
//
// A session's own directory goes by its name and not by where that leads (sessionRoot), so that what stands at the name
// cannot move the boundary. Another root goes by where it leads: it is the owner's project directory, which is theirs to
// link.
func newLocalFileScope(sessionDirs []string, otherRoots ...string) localFileScope {
	home := realPath(machineHome())
	scope := localFileScope{home: home}
	if info, err := os.Stat(home); err == nil {
		scope.homeInfo = info
	}
	for _, dir := range sessionDirs {
		root, ok := sessionRoot(dir, home)
		if !ok {
			continue
		}
		scope.roots = append(scope.roots, root)
		if root != home && pathInsideAny(root, home) {
			scope.own = append(scope.own, root)
		}
	}
	for _, dir := range otherRoots {
		scope.roots = append(scope.roots, realPath(dir))
	}
	return scope
}

// sessionRoot is the root a session's own directory stands for, and false when it stands for none. Only a real directory
// at its own name counts: a link there is no root, whatever it leads to, as saveLocalFile will not write through one. The
// directories above it are the runner's and resolve as they will: a home can be a link, as /tmp is on macOS, and worktrees
// can live on another disk. A directory inside a worktree stands for the worktree, which covers it: on its own it would
// be a name the checkout itself can rewrite.
func sessionRoot(dir, home string) (string, bool) {
	entry := worktreeHolding(absPath(dir), home)
	info, err := os.Lstat(entry)
	if err != nil || !info.IsDir() {
		return "", false
	}
	return filepath.Join(realPath(filepath.Dir(entry)), filepath.Base(entry)), true
}

// worktreeHolding is the checkout dir is named inside, or dir when it is in none, whichever way Orbit's directory is
// spelled. This goes by name because a link inside the checkout must not change the answer.
func worktreeHolding(dir, home string) string {
	for _, orbit := range []string{absPath(machineHome()), home} {
		worktrees := filepath.Join(orbit, "worktrees")
		if pathInsideAny(dir, worktrees) {
			rel, _ := filepath.Rel(worktrees, dir)
			return filepath.Join(worktrees, strings.Split(rel, string(filepath.Separator))[0])
		}
	}
	return dir
}

// namedInSessionsOwnDirectory reports whether dir is named in the checkout or the uploads directory of the session that
// uploads belongs to, whichever way Orbit's directory or the session's id is spelled. The session is known from that
// directory because only the runner names it, from the claim (uploadsDir). This goes by name, as worktreeHolding does:
// what stands at the name is sessionRoot's to judge.
func namedInSessionsOwnDirectory(dir, uploads string) bool {
	orbits := []string{absPath(machineHome()), realPath(machineHome())}
	session := ""
	for _, orbit := range orbits {
		if filepath.Dir(absPath(uploads)) == filepath.Join(orbit, "uploads") {
			session = decodeSessionID(filepath.Base(uploads))
		}
	}
	if session == "" {
		return false
	}
	for _, orbit := range orbits {
		for _, parent := range []string{"worktrees", "uploads"} {
			if name := nameBelow(filepath.Join(orbit, parent), dir); name != "" && decodeSessionID(name) == session {
				return true
			}
		}
	}
	return false
}

// nameBelow is the name dir goes by directly under parent, and "" when dir is parent itself or not under it.
func nameBelow(parent, dir string) string {
	rel, err := filepath.Rel(parent, dir)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return ""
	}
	return strings.Split(rel, string(filepath.Separator))[0]
}

// refuses says why a path, with its links resolved, may not be read, and "" when it may.
func (s localFileScope) refuses(real string) string {
	if !pathInsideAny(real, s.own...) && s.inOrbitsDirectory(real) {
		return localFileInOrbitsDirectory
	}
	if !pathInsideAny(real, s.roots...) {
		return localFileOutsideTheSession
	}
	return ""
}

// inOrbitsDirectory reports whether a path is in Orbit's directory under any name for it. A filesystem can take one
// directory under spellings nobody could list: another case on a Mac's by default, another Unicode form on APFS. So this
// goes by what the directories above the path are. The name counts as well, for a scope that could not look at them.
func (s localFileScope) inOrbitsDirectory(real string) bool {
	return pathInsideAny(real, s.home) || insideDirectory(real, s.homeInfo)
}

// insideDirectory reports whether path is the directory dir describes or under it, going by what each directory on the
// way up is.
func insideDirectory(path string, dir os.FileInfo) bool {
	for {
		if info, err := os.Stat(path); err == nil && os.SameFile(info, dir) {
			return true
		}
		parent := filepath.Dir(path)
		if parent == path {
			return false
		}
		path = parent
	}
}

// open judges path and opens what it judged. The open goes down from the root a directory handle at a time and fails
// closed on a link or a replacement anywhere in the resolved path, and it does not block on a FIFO
// (openWorktreeArtifactFile). What is true of the file, its type and size and what sniffing it says, is read from the
// handle: the path may mean something else by then.
func (s localFileScope) open(path string) (*os.File, os.FileInfo, error) {
	real, err := filepath.EvalSymlinks(path)
	if err != nil {
		return nil, nil, err
	}
	if reason := s.refuses(real); reason != "" {
		return nil, nil, &localFileRefused{reason: reason}
	}
	for _, root := range s.roots {
		if !pathInsideAny(real, root) {
			continue
		}
		rootInfo, err := os.Lstat(root)
		if err != nil {
			return nil, nil, err
		}
		rel, err := filepath.Rel(root, real)
		if err != nil {
			return nil, nil, err
		}
		file, err := openWorktreeArtifactFile(root, rel, rootInfo)
		if err != nil {
			return nil, nil, err
		}
		info, err := file.Stat()
		if err == nil && !info.Mode().IsRegular() {
			err = errors.New("not a regular file")
		}
		if err == nil {
			err = refuseFileHoldingSecret(file, real)
		}
		if err != nil {
			file.Close()
			return nil, nil, err
		}
		return file, info, nil
	}
	return nil, nil, &localFileRefused{reason: localFileOutsideTheSession}
}

// absPath is the absolute path, its links left as they are.
func absPath(path string) string {
	if abs, err := filepath.Abs(path); err == nil {
		return abs
	}
	return filepath.Clean(path)
}

// realPath is the absolute path with its links resolved, or as it stands when it does not exist yet.
func realPath(path string) string {
	path = absPath(path)
	if real, err := filepath.EvalSymlinks(path); err == nil {
		return real
	}
	return path
}

// asDirectory names a directory so that opening it refuses anything else at once. os.OpenRoot and os.Root's OpenRoot open
// the last element of a path with no O_DIRECTORY, so a FIFO put at that name would hold the call until a writer came. A
// trailing "." makes it the element before the last, which has to be a directory.
func asDirectory(name string) string { return name + string(filepath.Separator) + "." }

// pathInsideAny reports whether path is one of the roots or under one.
func pathInsideAny(path string, roots ...string) bool {
	for _, root := range roots {
		rel, err := filepath.Rel(root, path)
		if err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

// errLocalPathChanged is saveLocalFile's refusal: something it would have gone through is not the directory it should be.
var errLocalPathChanged = errors.New("a link or something other than a directory is in the way, so nothing was saved")

// checkLocalSaveTarget refuses a name that is already something other than a file, and is what makes a link at the last
// level a refusal like one at any other: a rename would only have replaced it.
func checkLocalSaveTarget(info os.FileInfo, err error) error {
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("%s: %w", info.Name(), errLocalPathChanged)
	}
	return nil
}

// errFileHoldsOwnerSecret refuses a file that holds the value of an owner-request secret this runner holds.
var errFileHoldsOwnerSecret = errors.New("the file holds the value of a secret the owner delivered to this runner, so it is not sent")

// refuseFileHoldingSecret scans a file inside the roots for every owner-request secret's value before it leaves this
// machine (docs/design/owner-request-secrets.md §7.2), and leaves it read from the start again. The runner process
// holds the values and scans the handle itself; `orbit mcp` holds none, and asks the runner over the session's socket.
// A runner that cannot be asked, or is too old to know the question, does not stop the file: this check is the
// accident net (level B), and a failure to reach the runner fails open.
func refuseFileHoldingSecret(file *os.File, path string) error {
	// After its grant has gone the value is not known here, but a file that was held back for holding it is: its blob
	// id is recorded (secret_taint.go). Asked first, in the runner and in `orbit mcp` alike, which read the same record.
	recorded, err := fileIsRecordedSecretBlob(file)
	if _, seekErr := file.Seek(0, io.SeekStart); err == nil {
		err = seekErr
	}
	if err != nil {
		return err
	}
	if recorded {
		return errFileHoldsOwnerSecret
	}
	if store := runnerSecrets(); store != nil {
		holds, err := store.readerHolds(file)
		if _, seekErr := file.Seek(0, io.SeekStart); err == nil {
			err = seekErr
		}
		if err != nil {
			return err
		}
		if holds {
			return errFileHoldsOwnerSecret
		}
		return nil
	}
	socket, token := os.Getenv(envBgSocket), os.Getenv(envBgToken)
	if socket == "" || token == "" {
		return nil
	}
	raw, err := bgSocketCall(socket, token, "secret_scan", map[string]interface{}{"path": path})
	if err != nil {
		return nil
	}
	var answer struct {
		Holds bool `json:"holds"`
	}
	if json.Unmarshal(raw, &answer) == nil && answer.Holds {
		return errFileHoldsOwnerSecret
	}
	return nil
}

// fileIsRecordedSecretBlob reports whether file's content is a blob the taint record names, in either object format
// git uses. A record that cannot be read, or that a removal has not finished writing, counts as naming every file.
func fileIsRecordedSecretBlob(file *os.File) (bool, error) {
	ids, readable := taintObjectsChecked("")
	if !readable {
		return true, nil
	}
	if len(ids) == 0 {
		return false, nil
	}
	info, err := file.Stat()
	if err != nil {
		return false, err
	}
	if !info.Mode().IsRegular() || info.Size() > secretScanFileMax {
		return false, nil
	}
	data, err := io.ReadAll(io.LimitReader(file, secretScanFileMax+1))
	if err != nil {
		return false, err
	}
	for _, id := range rawBlobIDsOf(data) {
		if _, ok := ids[id]; ok {
			return true, nil
		}
	}
	return false, nil
}
