package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
)

// startSessionProcess starts one interactive runtime and, when the start fails, replaces
// exec's error with one that names what is actually missing.
//
// Every session process is made the leader of its own process group
// (configureSessionProcessTree), and os.startProcess only double-checks the working
// directory — turning a failed chdir into a clear `chdir <dir>` error — when SysProcAttr
// is nil. With it set that check is skipped, so the child's chdir ENOENT comes back
// wrapped around argv0 instead: `fork/exec /root/.local/bin/claude: no such file or
// directory`. That reads as a missing engine binary and sends whoever is debugging it to
// reinstall claude or restart the runner, when the engine was never the problem — the
// agent's workDir was. Undo the mislabeling here, at the one place that knows both.
func startSessionProcess(cmd *exec.Cmd) error {
	if err := cmd.Start(); err != nil {
		return explainSpawnError(cmd.Dir, err)
	}
	return nil
}

// explainSpawnError rewrites a spawn ENOENT that is really about the working directory.
// Everything else is returned untouched — including a genuinely missing binary, where the
// path already in the error IS the thing that's missing and the message is honest.
func explainSpawnError(dir string, err error) error {
	if dir == "" || !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	_, statErr := os.Stat(dir)
	switch {
	case statErr == nil:
		return err
	case errors.Is(statErr, fs.ErrNotExist):
		return fmt.Errorf("working directory %s does not exist", dir)
	default:
		return fmt.Errorf("working directory %s is not usable: %w", dir, statErr)
	}
}
