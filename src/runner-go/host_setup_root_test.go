package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func rootMoveHost(t *testing.T, settings string) (*moveHost, string) {
	t.Helper()
	home := t.TempDir()
	h := newMoveHost(t, moveAccount{0, "root", home, true})
	setInstance(h.f, rootLegacyUnit, "root", "enabled", "active")
	setInstance(h.f, unitForAccount("root"), "root", "disabled", "inactive")
	h.owner[rootLegacyUnit], h.owner[unitForAccount("root")] = "root", "root"
	if err := os.WriteFile(filepath.Join(h.env.sys.unitDir, rootLegacyUnit), []byte("[Service]\nUser=root\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	query := h.env.sys.query
	h.env.sys.query = func(name string, args ...string) (string, error) {
		if len(args) > 8 && args[0] == "show" && args[1] == rootLegacyUnit {
			return "User=root\n" + strings.ReplaceAll(settings, "{HOME}", home), nil
		}
		return query(name, args...)
	}
	return h, home
}

func TestHostSetupRootMoveKeepsRegistrationAndReportsEveryDropIn(t *testing.T) {
	h, home := rootMoveHost(t, "Environment=HOME={HOME} ORBIT_HOME={HOME}/.orbit PATH=/opt/node/bin\nDropInPaths=/usr/lib/systemd/system/service.d/10-vendor.conf\n")
	config := filepath.Join(home, ".orbit", "config.json")
	if err := os.MkdirAll(filepath.Dir(config), 0o700); err != nil {
		t.Fatal(err)
	}
	credential := []byte(`{"runnerId":"same-runner","runnerToken":"same-credential"}`)
	if err := os.WriteFile(config, credential, 0o600); err != nil {
		t.Fatal(err)
	}
	var drops []string
	for i, dir := range []string{"/etc/systemd/system", "/etc/systemd/system.control", "/run/systemd/system.control", "/run/systemd/system"} {
		path := filepath.Join(dir, rootLegacyUnit+".d", fmt.Sprintf("%d-setting.conf", i))
		drops = append(drops, path)
		if err := os.MkdirAll(filepath.Dir(h.env.path(path)), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(h.env.path(path), []byte("[Service]\nCPUWeight=50\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// The legacy file must still exist while start is running; all old units must be down.
	h.f.onRun = func(argv []string) {
		if strings.Join(argv, " ") == "systemctl start "+unitForAccount("root") {
			if _, err := os.Stat(filepath.Join(h.env.sys.unitDir, rootLegacyUnit)); err != nil {
				t.Error("legacy file removed before start")
			}
		}
	}
	if err := hostSetup(h.env, "https://orbit.example.com"); err != nil {
		t.Fatal(err)
	}
	if len(h.violations) > 0 {
		t.Fatal(h.violations)
	}
	if got := fileBytes(t, config); string(got) != string(credential) {
		t.Fatal("registration changed")
	}
	if st, err := os.Stat(config); err != nil || st.Mode().Perm() != 0o600 {
		t.Fatal("credential mode changed", err)
	}
	if _, err := os.Stat(filepath.Join(h.env.sys.unitDir, rootLegacyUnit)); !os.IsNotExist(err) {
		t.Fatal("legacy unit file remains", err)
	}
	out := h.env.out.(*strings.Builder).String()
	if !strings.Contains(out, "Not carried over: /usr/lib/systemd/system/service.d/10-vendor.conf") {
		t.Fatal("effective vendor drop-in omitted")
	}
	for _, path := range drops {
		if !strings.Contains(out, "Not carried over: "+path) {
			t.Error("missing notice", path)
		}
		if _, err := os.Stat(h.env.path(path)); err != nil {
			t.Error("drop-in deleted", err)
		}
	}
	for _, want := range []string{"orbit-runner@root.service.d/", "systemctl set-property orbit-runner@root.service", "runner registration and credential kept"} {
		if !strings.Contains(out, want) {
			t.Error("missing", want)
		}
	}
}

func TestHostSetupRootMoveRefusesChangedConfiguration(t *testing.T) {
	for _, setting := range []string{"Environment=HOME=/other", "Environment=ORBIT_HOME=/other", "Environment=ORBIT_SERVER=https://other", "EnvironmentFiles=/etc/runner.env (ignore_errors=no)", "WorkingDirectory=/other", "PassEnvironment=ORBIT_HOME", "RootDirectory=/other", `Environment="ORBIT_HOME=/root/.orbit other"`, `Environment="HOME=/root other"`} {
		t.Run(setting, func(t *testing.T) {
			h, _ := rootMoveHost(t, setting+"\n")
			err := hostSetup(h.env, "https://orbit.example.com")
			key, _, _ := strings.Cut(setting, "=")
			if err == nil || !strings.Contains(err.Error(), key) {
				t.Fatalf("error=%v", err)
			}
			if h.f.units[rootLegacyUnit].activeState != "active" {
				t.Fatal("legacy stopped")
			}
			for _, argv := range h.f.ran {
				if strings.Join(argv, " ") == "systemctl start "+unitForAccount("root") {
					t.Fatal("instance started")
				}
			}
		})
	}
}

func TestHostSetupRootCopyMissingPresentAndNonExecutable(t *testing.T) {
	for _, mode := range []os.FileMode{0, 0o755, 0o644} {
		t.Run(fmt.Sprint(mode), func(t *testing.T) {
			h, home := rootMoveHost(t, "")
			target := userBinPath(home)
			old := []byte("existing root copy")
			if mode != 0 {
				if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(target, old, mode); err != nil {
					t.Fatal(err)
				}
			}
			if err := hostSetup(h.env, "https://orbit.example.com"); err != nil {
				t.Fatal(err)
			}
			want := fileBytes(t, h.env.path(machineBinaryPath))
			if mode == 0o755 {
				want = old
			}
			if got := fileBytes(t, target); string(got) != string(want) {
				t.Fatal("wrong copy")
			}
			st, err := os.Stat(target)
			if err != nil || st.Mode().Perm() != 0o755 {
				t.Fatal("copy mode", err)
			}
			st, err = os.Stat(filepath.Dir(target))
			if err != nil || st.Mode().Perm() != 0o755 {
				t.Fatal("bin directory mode", err)
			}
			if uid, ok := fileOwnerUID(st); !ok || uid != h.env.rootUID {
				t.Fatal("bin directory ownership")
			}
		})
	}
}

func TestHostSetupRootCopyFailureLeavesLegacyRunning(t *testing.T) {
	h, home := rootMoveHost(t, "")
	if err := os.WriteFile(filepath.Join(home, ".orbit"), []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := hostSetup(h.env, "https://orbit.example.com"); err == nil {
		t.Fatal("move succeeded without copy")
	}
	if h.f.units[rootLegacyUnit].activeState != "active" || h.f.units[unitForAccount("root")].activeState != "inactive" {
		t.Fatal("runners changed on copy failure")
	}
}

func TestHostSetupRootMoveDrainsUidInstanceToo(t *testing.T) {
	h, _ := rootMoveHost(t, "")
	// The legacy unit is enabled but down; the old uid instance is the only live root runner.
	h.f.units[rootLegacyUnit].activeState = "inactive"
	h.instance(0, "enabled", "active", true)
	if err := hostSetup(h.env, "https://orbit.example.com"); err != nil {
		t.Fatal(err)
	}
	if len(h.violations) > 0 {
		t.Fatal(h.violations)
	}
	if h.f.units[unitForUid(0)].activeState != "inactive" || h.f.units[unitForAccount("root")].activeState != "active" {
		t.Fatal("wrong root instance after move")
	}
}

func TestHostSetupRootMoveNeverStartsBeforeDrainAndConfirmsDown(t *testing.T) {
	for _, stuck := range []bool{false, true} {
		t.Run(fmt.Sprint(stuck), func(t *testing.T) {
			h, _ := rootMoveHost(t, "")
			h.f.units[rootLegacyUnit].stuck = stuck
			err := hostSetup(h.env, "https://orbit.example.com")
			if stuck {
				if err == nil {
					t.Fatal("accepted failed drain")
				}
				if h.f.units[unitForAccount("root")].activeState != "inactive" {
					t.Fatal("started despite failed drain")
				}
			} else if err != nil {
				t.Fatal(err)
			}
			if len(h.violations) > 0 {
				t.Fatal(h.violations)
			}
		})
	}
}

func TestHostSetupRootFailedStartRestoresOnlyAfterNewInstanceDown(t *testing.T) {
	for _, stuck := range []bool{false, true} {
		t.Run(fmt.Sprint(stuck), func(t *testing.T) {
			h, _ := rootMoveHost(t, "")
			to := unitForAccount("root")
			h.f.fail["systemctl start "+to] = fmt.Errorf("lost reply")
			h.f.onRun = func(argv []string) {
				if strings.Join(argv, " ") == "systemctl start "+to {
					h.f.units[to].activeState = "active"
					h.f.units[to].stuck = stuck
				}
			}
			if err := hostSetup(h.env, "https://orbit.example.com"); err == nil {
				t.Fatal("move succeeded")
			}
			if got := h.f.units[rootLegacyUnit].activeState == "active"; got == stuck {
				t.Fatal("unsafe or missing restoration")
			}
			if len(h.violations) > 0 {
				t.Fatal(h.violations)
			}
		})
	}
}
