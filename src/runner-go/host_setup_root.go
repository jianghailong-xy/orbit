package main

import (
	"crypto/sha256"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

const rootLegacyUnit = "orbit-runner-root.service"

// Setup, rather than hostd, may install root's copy. Registration storage is never opened.
func (env hostSetupEnv) moveRootLegacy(exe string) error {
	file := filepath.Join(env.sys.unitDir, rootLegacyUnit)
	if _, err := os.Stat(file); os.IsNotExist(err) {
		return nil
	} else if err != nil {
		return err
	}
	sys := env.sys
	t, refusal, ok := sys.target(hostdPeer{UID: 0}, "enable")
	if !ok {
		return fmt.Errorf("cannot move %s: %s", rootLegacyUnit, refusal.Error)
	}
	was, err := sys.unitState(rootLegacyUnit)
	if err != nil {
		return err
	}
	if !t.isAccount(was["User"]) {
		return fmt.Errorf("refusing to move %s: User=%s is not root", rootLegacyUnit, was["User"])
	}
	out, err := sys.query("systemctl", "show", rootLegacyUnit, "-p", "User", "-p", "Environment", "-p", "EnvironmentFiles", "-p", "PassEnvironment", "-p", "UnsetEnvironment", "-p", "WorkingDirectory", "-p", "RootDirectory", "-p", "RootImage", "-p", "DropInPaths")
	if err != nil {
		return fmt.Errorf("cannot inspect %s settings: %w", rootLegacyUnit, err)
	}
	props := hostdShowProperties(out)
	if err := rootLegacySettings(props, t.account.HomeDir); err != nil {
		return fmt.Errorf("refusing to move %s: %w; the legacy runner is left in place", rootLegacyUnit, err)
	}
	drops, err := env.rootLegacyDropIns(props["DropInPaths"])
	if err != nil {
		return err
	}
	if err := env.placeRootCopy(env.path(exe), t.account.HomeDir); err != nil {
		return fmt.Errorf("cannot install root's runner copy: %w; the legacy runner is left in place", err)
	}
	// Keep the file until the new instance is up, so a failed start can restore the old unit.
	if err := sys.takeDownOlderUnitsRemovingFiles(t, false); err != nil {
		return err
	}
	if err = sys.systemctl("enable", t.unit); err == nil {
		err = sys.systemctl("start", t.unit)
	}
	if err == nil {
		var st hostdUnitState
		st, err = sys.unitState(t.unit)
		if err == nil && st["ActiveState"] != "active" {
			err = fmt.Errorf("%s is not active (ActiveState=%s)", t.unit, st["ActiveState"])
		}
	}
	if err != nil {
		if downErr := takeDownNameInstance(sys, t.unit); downErr != nil {
			return fmt.Errorf("move failed: %v; %v; %s stays stopped to avoid two runners", err, downErr, rootLegacyUnit)
		}
		restored, _ := env.restore(rootLegacyUnit, was)
		return fmt.Errorf("move failed: %v%s", err, restored)
	}
	if err := os.Remove(file); err != nil {
		return fmt.Errorf("%s is running, but cannot remove %s: %w", t.unit, file, err)
	}
	if err := sys.systemctl("daemon-reload"); err != nil {
		return err
	}
	fmt.Fprintf(env.out, "\n  Moved %s → %s; runner registration and credential kept.\n", rootLegacyUnit, t.unit)
	for _, path := range drops {
		fmt.Fprintf(env.out, "  Not carried over: %s. Review and recreate this setting under %s.d/; for resource properties, use systemctl set-property %s <property>=<value>. Drop-ins can override User= or ExecStart= and are not copied automatically. The drop-in file is left in place.\n", path, t.unit, t.unit)
	}
	return nil
}

func rootLegacySettings(p map[string]string, home string) error {
	if home == "" || home == "/nonexistent" || !filepath.IsAbs(home) {
		return fmt.Errorf("passwd home %q cannot hold root's registration", home)
	}
	for _, key := range []string{"EnvironmentFiles", "PassEnvironment", "UnsetEnvironment", "RootDirectory", "RootImage"} {
		if p[key] != "" {
			return fmt.Errorf("%s=%s cannot be carried over safely", key, p[key])
		}
	}
	if wd := p["WorkingDirectory"]; wd != "" && wd != "/" && wd != home {
		return fmt.Errorf("WorkingDirectory=%s differs from root's passwd home", wd)
	}
	words, err := systemdShowWords(p["Environment"])
	if err != nil {
		return fmt.Errorf("Environment cannot be inspected safely: %w", err)
	}
	for _, word := range words {
		name, value, _ := strings.Cut(word, "=")
		if name == "HOME" && value != home || name == "ORBIT_HOME" && value != filepath.Join(home, ".orbit") || strings.HasPrefix(name, "ORBIT_") && name != "ORBIT_HOME" {
			return fmt.Errorf("Environment setting %s would change the runner's configuration", word)
		}
	}
	return nil
}

func (env hostSetupEnv) rootLegacyDropIns(effective string) ([]string, error) {
	seen := map[string]bool{}
	paths, err := systemdShowWords(effective)
	if err != nil {
		return nil, fmt.Errorf("cannot inspect DropInPaths: %w", err)
	}
	for _, path := range paths {
		seen[path] = true
	}
	for _, dir := range []string{"/etc/systemd/system", "/etc/systemd/system.control", "/run/systemd/system.control", "/run/systemd/system"} {
		entries, err := os.ReadDir(env.path(filepath.Join(dir, rootLegacyUnit+".d")))
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return nil, err
		}
		for _, entry := range entries {
			if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".conf") {
				seen[filepath.Join(dir, rootLegacyUnit+".d", entry.Name())] = true
			}
		}
	}
	paths = make([]string, 0, len(seen))
	for path := range seen {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	return paths, nil
}

// systemctl show quotes whitespace-containing words and uses C escapes for special bytes.
// Parse those words without invoking a shell or silently accepting malformed quoting.
func systemdShowWords(value string) ([]string, error) {
	var words []string
	for value = strings.TrimSpace(value); value != ""; value = strings.TrimSpace(value) {
		var word strings.Builder
		quoted := false
		for len(value) > 0 {
			c := value[0]
			if !quoted && (c == ' ' || c == '\t' || c == '\n') {
				break
			}
			if c == '"' {
				quoted = !quoted
				value = value[1:]
				continue
			}
			if c == '\\' {
				r, _, rest, err := strconv.UnquoteChar(value, '"')
				if err != nil {
					return nil, err
				}
				word.WriteRune(r)
				value = rest
			} else {
				word.WriteByte(c)
				value = value[1:]
			}
		}
		if quoted {
			return nil, fmt.Errorf("unterminated quote")
		}
		words = append(words, word.String())
	}
	return words, nil
}

func (env hostSetupEnv) placeRootCopy(exe, home string) error {
	target := userBinPath(home)
	for _, dir := range []struct {
		path string
		mode os.FileMode
	}{{home, 0o700}, {filepath.Join(home, ".orbit"), 0o700}, {filepath.Dir(target), 0o755}} {
		if err := os.Mkdir(dir.path, dir.mode); err == nil {
			if err := os.Chmod(dir.path, dir.mode); err != nil {
				return err
			}
		} else if !os.IsExist(err) {
			return err
		}
		st, err := os.Lstat(dir.path)
		if err != nil {
			return err
		}
		uid, ok := fileOwnerUID(st)
		if !st.IsDir() || !ok || uid != env.rootUID || st.Mode().Perm()&0o022 != 0 {
			return fmt.Errorf("%s must be a root-owned directory only root can write", dir.path)
		}
	}
	if st, err := os.Stat(target); err == nil && st.Mode().IsRegular() && st.Mode()&0o111 != 0 {
		return checkMachineBinary(target, home, env.rootUID)
	}
	if _, _, err := placeOwnCopy(exe, home); err != nil {
		return err
	}
	digest := func(path string) ([32]byte, error) {
		var sum [32]byte
		f, err := os.Open(path)
		if err != nil {
			return sum, err
		}
		defer f.Close()
		h := sha256.New()
		if _, err := io.Copy(h, f); err != nil {
			return sum, err
		}
		copy(sum[:], h.Sum(nil))
		return sum, nil
	}
	from, err := digest(exe)
	if err != nil {
		return err
	}
	to, err := digest(target)
	if err != nil {
		return err
	}
	if from != to {
		return fmt.Errorf("%s digest differs from the checked machine binary", target)
	}
	return checkMachineBinary(target, home, env.rootUID)
}
