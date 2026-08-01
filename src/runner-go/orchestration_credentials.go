package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

const (
	orchestrationCredentialsDirName = "session-credentials"
	orchestrationCredentialDirPerm  = os.FileMode(0o700)
	orchestrationCredentialFilePerm = os.FileMode(0o600)
	maxOrchestrationCredentialBytes = 64 * 1024
)

func orchestrationCredentialsDir() string {
	return filepath.Join(machineHome(), orchestrationCredentialsDirName)
}

func orchestrationCredentialPath(sessionID string) (string, error) {
	if err := validatePathSegmentID(sessionID); err != nil {
		return "", fmt.Errorf("session %w", err)
	}
	return filepath.Join(orchestrationCredentialsDir(), sessionID), nil
}

// validatePrivateDirectory checks a credential directory without following a
// symlink. Agent-invoked CLI/MCP processes must never repair an unsafe path: an
// unexpected owner or mode is surfaced as an error instead.
func validatePrivateDirectory(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return fmt.Errorf("%s is not a private directory", path)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != orchestrationCredentialDirPerm {
		return fmt.Errorf("%s has permissions %04o, want 0700", path, info.Mode().Perm())
	}
	return nil
}

func ensureOrchestrationCredentialsDir() error {
	root := machineHome()
	if err := validatePrivateDirectory(root); err != nil {
		return fmt.Errorf("credential root is not private: %w", err)
	}
	dir := orchestrationCredentialsDir()
	err := os.Mkdir(dir, orchestrationCredentialDirPerm)
	if err != nil && !os.IsExist(err) {
		return err
	}
	if err == nil && runtime.GOOS != "windows" {
		// Make the intended mode independent of the process umask.
		if err := os.Chmod(dir, orchestrationCredentialDirPerm); err != nil {
			return err
		}
	}
	return validatePrivateDirectory(dir)
}

func validatePrivateCredentialFile(path string) (os.FileInfo, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return nil, fmt.Errorf("%s is not a private regular file", path)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != orchestrationCredentialFilePerm {
		return nil, fmt.Errorf("%s has permissions %04o, want 0600", path, info.Mode().Perm())
	}
	return info, nil
}

// loadOrchestrationCredential reads the session credential afresh for every
// orchestration operation. This lets a long-lived MCP process observe a token
// refreshed by any other process without being restarted.
func loadOrchestrationCredential(sessionID string) (string, error) {
	path, err := orchestrationCredentialPath(sessionID)
	if err != nil {
		return "", err
	}
	if err := validatePrivateDirectory(orchestrationCredentialsDir()); err != nil {
		return "", err
	}
	// A concurrent refresh atomically renames the credential between Lstat and
	// Open. Retry that benign identity mismatch once instead of failing an
	// otherwise valid orchestration call; all other path/mode errors remain
	// fail-closed.
	for attempt := 0; attempt < 2; attempt++ {
		before, err := validatePrivateCredentialFile(path)
		if err != nil {
			return "", err
		}
		f, err := os.Open(path)
		if err != nil {
			return "", err
		}
		after, statErr := f.Stat()
		if statErr != nil {
			_ = f.Close()
			return "", statErr
		}
		if !os.SameFile(before, after) {
			_ = f.Close()
			if attempt == 0 {
				continue
			}
			return "", fmt.Errorf("%s changed while opening", path)
		}
		if !after.Mode().IsRegular() {
			_ = f.Close()
			return "", fmt.Errorf("%s is not a private regular file", path)
		}
		if runtime.GOOS != "windows" && after.Mode().Perm() != orchestrationCredentialFilePerm {
			_ = f.Close()
			return "", fmt.Errorf("%s has permissions %04o, want 0600", path, after.Mode().Perm())
		}
		b, readErr := io.ReadAll(io.LimitReader(f, maxOrchestrationCredentialBytes+1))
		_ = f.Close()
		if readErr != nil {
			return "", readErr
		}
		if len(b) > maxOrchestrationCredentialBytes {
			return "", fmt.Errorf("session orchestration credential is unexpectedly large")
		}
		token := strings.TrimSpace(string(b))
		if token == "" {
			return "", fmt.Errorf("session orchestration credential is empty")
		}
		return token, nil
	}
	return "", fmt.Errorf("%s changed while opening", path)
}

// storeOrchestrationCredential atomically replaces one session's private
// credential. The token is deliberately never included in an error or log line.
func storeOrchestrationCredential(sessionID, token string) error {
	path, err := orchestrationCredentialPath(sessionID)
	if err != nil {
		return err
	}
	token = strings.TrimSpace(token)
	if token == "" {
		return fmt.Errorf("session orchestration credential is empty")
	}
	if len(token) > maxOrchestrationCredentialBytes {
		return fmt.Errorf("session orchestration credential is unexpectedly large")
	}
	if err := ensureOrchestrationCredentialsDir(); err != nil {
		return err
	}
	if _, err := os.Lstat(path); err == nil {
		if _, err := validatePrivateCredentialFile(path); err != nil {
			return err
		}
	} else if !os.IsNotExist(err) {
		return err
	}

	tmp, err := os.CreateTemp(orchestrationCredentialsDir(), ".credential-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	keepTemp := true
	defer func() {
		_ = tmp.Close()
		if keepTemp {
			_ = os.Remove(tmpPath)
		}
	}()
	if err := tmp.Chmod(orchestrationCredentialFilePerm); err != nil {
		return err
	}
	if _, err := io.WriteString(tmp, token); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return err
	}
	keepTemp = false

	// Best-effort directory sync makes the rename durable on filesystems that
	// support it. A platform that rejects directory fsync still has an atomic file.
	if dir, err := os.Open(orchestrationCredentialsDir()); err == nil {
		_ = dir.Sync()
		_ = dir.Close()
	}
	return nil
}

func removeOrchestrationCredential(sessionID string) error {
	path, err := orchestrationCredentialPath(sessionID)
	if err != nil {
		return err
	}
	if err := validatePrivateDirectory(orchestrationCredentialsDir()); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if _, err := validatePrivateCredentialFile(path); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	return os.Remove(path)
}

// stageOrchestrationCredential moves the claim/reclaim proof out of the in-memory
// job before a provider is spawned. An empty proof is allowed for rolling upgrades:
// the first orchestration request can obtain one from the refresh endpoint.
func stageOrchestrationCredential(job *ClaimedSession) error {
	defer func() { job.OrchestrationToken = "" }()
	if !job.AllowOrchestration {
		return removeOrchestrationCredential(job.SessionID)
	}
	if strings.TrimSpace(job.OrchestrationToken) == "" {
		return nil
	}
	return storeOrchestrationCredential(job.SessionID, job.OrchestrationToken)
}

// pruneOrchestrationCredentials removes credentials left by a crashed runner,
// retaining only the exact session ids returned by reclaim. Unsafe or non-file
// entries are never followed or removed.
func pruneOrchestrationCredentials(liveSet map[string]bool) error {
	dir := orchestrationCredentialsDir()
	if err := validatePrivateDirectory(dir); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	var errs []error
	for _, entry := range entries {
		name := entry.Name()
		if liveSet[name] {
			continue
		}
		if err := validatePathSegmentID(name); err != nil {
			errs = append(errs, fmt.Errorf("refusing unsafe credential entry %q", name))
			continue
		}
		path := filepath.Join(dir, name)
		if _, err := validatePrivateCredentialFile(path); err != nil {
			errs = append(errs, err)
			continue
		}
		if err := os.Remove(path); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}
