# Helpers scripts/hostd-e2e.sh runs inside its container:  bash -c '. /opt/orbit-e2e/in-container.sh; ...'

# runner_pids UID — the `orbit run` processes whose real or effective uid is UID, one pid per line.
# Every runner on the machine, whichever unit started it: two of them for one account is exactly
# what the legacy-unit migration exists to prevent.
runner_pids() {
  local d cmd uids
  for d in /proc/[0-9]*; do
    cmd=$(tr '\0' ' ' <"$d/cmdline" 2>/dev/null) || continue
    case "$cmd" in "/usr/local/bin/orbit run ") ;; *) continue ;; esac
    uids=$(awk '/^Uid:/ { print $2, $3 }' "$d/status" 2>/dev/null) || continue
    case " $uids " in *" $1 "*) echo "${d#/proc/}" ;; esac
  done
}

# euid PID — the effective uid the process runs with.
euid() { awk '/^Uid:/ { print $3 }' "/proc/$1/status"; }

# unit_of PID — the unit whose cgroup the process lives in.
unit_of() { sed -n 's|^0::.*/||p' "/proc/$1/cgroup"; }

# has_sudo — succeeds when sudo is installed or resolves on this shell's PATH.
has_sudo() {
  command -v sudo >/dev/null 2>&1 || [ -e /usr/bin/sudo ] || [ -e /usr/sbin/sudo ] || [ -e /bin/sudo ] || [ -e /sbin/sudo ]
}
