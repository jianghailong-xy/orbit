package main

import "os/exec"

func waitSessionProcessTree(cmd *exec.Cmd) error {
	err := cmd.Wait()
	terminateErr := terminateSessionProcessTree(cmd)
	if err != nil {
		return err
	}
	return terminateErr
}

func combinedOutputSessionProcessTree(cmd *exec.Cmd) ([]byte, error) {
	out, err := cmd.CombinedOutput()
	terminateErr := terminateSessionProcessTree(cmd)
	if err != nil {
		return out, err
	}
	return out, terminateErr
}
