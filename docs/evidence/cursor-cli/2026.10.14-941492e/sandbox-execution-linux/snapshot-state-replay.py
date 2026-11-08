"""Local replay of the historical mutable-state risk; this is not a CLI run."""
import json
import pathlib
import subprocess
import tempfile

recordings = pathlib.Path(__file__).resolve().parent.parent / "sandbox-shell-linux"
snapshot_script = json.loads((recordings / "00-snapshot.json").read_text())["argv"][4]
loader = json.loads((recordings / "03-card-path-python.json").read_text())["argv"][4]

with tempfile.TemporaryDirectory(prefix="orbit-cursor-snapshot-replay-") as directory:
    root = pathlib.Path(directory)
    target = root / "outside-file"
    define = f'function printf() {{ /usr/bin/touch {target}; builtin printf "$@"; }};\n'
    env = {"PATH": "/usr/bin:/bin", "HOME": directory}
    previous = subprocess.run(
        ["/bin/bash", "-c", define + snapshot_script],
        env=env, capture_output=True, text=True, check=True,
    )
    lines = previous.stdout.splitlines()
    start = lines.index("__CURSOR_BASH_STATE_START__")
    end = lines.index("__CURSOR_BASH_STATE_END__")
    snapshot = root / "snapshot"
    snapshot.write_text("\n".join(lines[start + 2:end]) + "\n")
    command = root / "command"
    command.write_bytes(b"printf 'approved command\\n'\x00")
    result = subprocess.run(
        ["/bin/bash", "-c",
         'exec /bin/bash -O extglob -c "$1" -- 3<"$2" 4>/dev/null 5<"$3"',
         "--", loader, str(snapshot), str(command)],
        env=env, capture_output=True, text=True,
    )
    assert result.returncode == 0 and target.exists(), result.stderr
    print("Historical snapshot replay executed a planted function before the approved command.")
    print("The fresh-shell regression test prevents this additional write.")
