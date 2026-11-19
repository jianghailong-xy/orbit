package main

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// On a host set up with `orbit host setup`, an account's runner is the template instance that
// runs the account's own ~/.orbit/bin/orbit. So before `orbit register` asks the broker to enable
// it, it puts that copy in place itself, as the account: hostd only checks that the file is there
// and the account can execute it, and never writes into a home.

// placeOwnCopyForBroker is register's copy step on a host whose broker it is about to ask: when the
// socket is there, the running binary is put at the account's ~/.orbit/bin/orbit. A copy
// that cannot be put there is said and is not the end of the registration: the broker has the
// last word, and its refusal says what is missing and what to run.
func placeOwnCopyForBroker(socketPath, exe string) {
	if _, err := os.Stat(socketPath); err != nil {
		return
	}
	u, err := currentUser()
	if err != nil {
		return
	}
	home := u.HomeDir
	if home == "" || home == "/nonexistent" || !filepath.IsAbs(home) {
		// No home to keep a copy in; the broker's refusal says so.
		return
	}
	to, copied, err := placeOwnCopy(exe, home)
	switch {
	case err != nil:
		fmt.Fprintf(os.Stderr, "note: could not put this account's own copy of orbit at %s: %v\n", userBinPath(home), err)
	case copied:
		fmt.Printf("    ✓ Put this account's own copy of orbit at %s, which its runner runs and updates.\n", to)
	}
}

// placeOwnCopy puts the binary at exe at userBinPath(home), the way install.sh does: ~/.orbit made
// 0700 if it is not there (it holds the runner's credential), then a new file in ~/.orbit/bin,
// mode 0755, renamed over the old one, which a runner may be running. Nothing is written when exe
// already is that file, through a symlink or not, and nothing outside home is written at all.
// It reports the path and whether it copied.
func placeOwnCopy(exe, home string) (string, bool, error) {
	to := userBinPath(home)
	if sameFile(exe, to) {
		return to, false, nil
	}
	binDir := filepath.Dir(to)
	if err := os.Mkdir(filepath.Dir(binDir), machineHomePerm); err != nil && !os.IsExist(err) {
		return to, false, err
	}
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		return to, false, err
	}
	src, err := os.Open(exe)
	if err != nil {
		return to, false, err
	}
	defer src.Close()
	tmp, err := os.CreateTemp(binDir, ".orbit.")
	if err != nil {
		return to, false, err
	}
	_, err = io.Copy(tmp, src)
	if err == nil {
		err = tmp.Chmod(0o755)
	}
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(tmp.Name(), to)
	}
	if err != nil {
		_ = os.Remove(tmp.Name())
		return to, false, err
	}
	return to, true, nil
}
