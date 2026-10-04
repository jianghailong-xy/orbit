"""Drive the debug probe on an already booted device, under the shared UI flock."""
import argparse
import hashlib
import importlib.util
import json
import pathlib
import subprocess
import sys
import time
import traceback

sys.dont_write_bytecode = True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("serial")
    parser.add_argument("apk", type=pathlib.Path)
    parser.add_argument("output", type=pathlib.Path)
    parser.add_argument("--sdk", default="/opt/android-sdk")
    args = parser.parse_args()
    output = args.output
    output.mkdir(parents=True, exist_ok=True)
    assert not (output / "report.json").exists(), "Use a new evidence directory"
    spec = importlib.util.spec_from_file_location("fixture", pathlib.Path(__file__).with_name("realtime-fixture.py"))
    fixture_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fixture_module)
    fixture = fixture_module.Fixture()
    server = fixture.server()
    package = "io.orbitd.android.debug"
    component = package + "/io.orbitd.android.realtime.RealtimeFixtureActivity"
    state_path = f"/sdcard/Android/data/{package}/files/a04-realtime/state.json"
    commands, phases = [], []
    started = time.time()

    def adb(*argv, check=True, binary=False):
        command = [args.sdk + "/platform-tools/adb", "-s", args.serial, *argv]
        result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=90)
        commands.append({"argv": argv, "exitCode": result.returncode, "time": time.time()})
        if check and result.returncode:
            raise AssertionError(f"adb {argv} failed: {result.stderr.decode(errors='replace')}")
        return result.stdout if binary else result.stdout.decode(errors="replace").strip()

    def wait(predicate, timeout=30):
        deadline = time.monotonic() + timeout
        last = None
        while time.monotonic() < deadline:
            try:
                last = json.loads(adb("shell", "cat", state_path, check=False))
                if predicate(last):
                    return last
            except (ValueError, KeyError, TypeError):
                pass
            time.sleep(0.2)
        raise AssertionError(f"State did not converge in {timeout}s: {last}")

    def phase(name, predicate, timeout=30):
        state = wait(predicate, timeout)
        phases.append({"name": name, "state": state, "monotonic": time.monotonic()})
        (output / f"{name}.json").write_text(json.dumps(state, ensure_ascii=False, indent=2))
        (output / f"{name}.png").write_bytes(adb("exec-out", "screencap", "-p", binary=True))
        (output / f"{name}-connectivity.txt").write_text(adb("shell", "dumpsys", "connectivity"))
        print(f"PASS {name}: pid={state['pid']} seq={state['maxSeq']} fresh={state['sessionFresh']}", flush=True)
        return state

    def ready(state):
        return state["control"] == state["sessionConnection"] == "CONNECTED" and state["directoryFresh"] and state["sessionFresh"]

    original = {key: adb("shell", "settings", "get", area, key) for area, key in
                (("system", "accelerometer_rotation"), ("system", "user_rotation"), ("global", "wifi_on"), ("global", "mobile_data"))}
    status, error = "FAILED", None
    try:
        identity = {key: adb("shell", "getprop", key) for key in
                    ("ro.product.model", "ro.build.version.release", "ro.build.version.sdk", "ro.build.fingerprint", "ro.kernel.qemu")}
        identity["serial"] = args.serial
        (output / "device.json").write_text(json.dumps(identity, indent=2))
        (output / "apk.sha256").write_text(hashlib.sha256(args.apk.read_bytes()).hexdigest() + "\n")
        for tool, params, filename in (("aapt", ["dump", "badging"], "apk-badging.txt"),
                                       ("apksigner", ["verify", "--print-certs"], "signature.txt")):
            result = subprocess.run([args.sdk + "/build-tools/36.0.0/" + tool, *params, str(args.apk)],
                                    capture_output=True, text=True, check=True)
            (output / filename).write_text(result.stdout)
        (output / "install.txt").write_text(adb("install", "-r", str(args.apk)))
        adb("reverse", "tcp:18769", "tcp:" + str(server.server_port))
        adb("shell", "svc", "wifi", "enable")
        adb("shell", "svc", "data", "enable")
        adb("shell", "input", "keyevent", "KEYCODE_WAKEUP")
        adb("shell", "wm", "dismiss-keyguard")
        adb("shell", "am", "start", "-W", "-n", component, "--ez", "reset_fixture", "true")
        first = phase("01-initial", lambda s: ready(s) and s["maxSeq"] == 2 and s["approvals"] == 1)
        assert fixture.stats["activeControl"] == fixture.stats["activeSession"] == 1
        old_connections = fixture.stats["sessionConnections"]
        fixture.drop()
        fixture.advance(3, "caught up after socket loss")
        caught = phase("02-disconnect-catchup", lambda s: ready(s) and s["seqs"] == [1, 2, 3] and s["approvals"] == s["queue"] == s["background"] == 0)
        assert fixture.stats["sessionConnections"] > old_connections
        assert len(caught["seqs"]) == len(set(caught["seqs"]))

        adb("shell", "settings", "put", "system", "accelerometer_rotation", "0")
        adb("shell", "settings", "put", "system", "user_rotation", "0" if original["user_rotation"] == "1" else "1")
        rotated = phase("03-rotation", lambda s: ready(s) and s["activityInstance"] > first["activityInstance"] and s["seqs"] == [1, 2, 3])
        assert rotated["pid"] == first["pid"]
        assert fixture.stats["activeControl"] == fixture.stats["activeSession"] == 1

        adb("shell", "svc", "wifi", "disable")
        cellular = phase("04-network-switch", lambda s: ready(s) and s["defaultNetwork"] != rotated["defaultNetwork"] and s["defaultNetwork"] != "")
        assert cellular["seqs"] == [1, 2, 3]
        adb("shell", "svc", "data", "disable")
        phase("05-offline", lambda s: s["control"] == s["sessionConnection"] == "STOPPED" and not s["sessionFresh"])
        fixture.advance(4, "reply while offline")
        adb("shell", "input", "keyevent", "KEYCODE_HOME")
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            marker = json.loads(adb("shell", "cat", state_path.replace("state.json", "lifecycle.json")))
            if marker["pid"] == first["pid"] and marker["stage"] == "stopped":
                break
            time.sleep(0.2)
        assert marker["pid"] == first["pid"] and marker["stage"] == "stopped", "Activity has not finished moving to background"
        (output / "before-reclaim-processes.txt").write_text(adb("shell", "dumpsys", "activity", "processes"))
        # am kill asks Android to reclaim only a background process; no force-stop and no data clear.
        adb("shell", "am", "kill", package)
        deadline = time.monotonic() + 10
        while adb("shell", "pidof", package, check=False) and time.monotonic() < deadline:
            time.sleep(0.2)
        assert not adb("shell", "pidof", package, check=False), "Android did not reclaim the background process"
        adb("shell", "am", "start", "-W", "-n", component)
        restored = phase("06-process-offline-cache", lambda s: s["pid"] != first["pid"] and s["directoryCached"] and
                         s["seqs"] == [1, 2, 3] and s["approvals"] == -1 and not s["sessionFresh"])
        adb("shell", "svc", "wifi", "enable")
        phase("07-process-online-reconcile", lambda s: ready(s) and s["seqs"] == [1, 2, 3, 4] and s["approvals"] == s["queue"] == 0)

        fixture.resync()
        tail = phase("08-window-resync", lambda s: ready(s) and s["maxSeq"] == 1210 and len(s["seqs"]) == 200)
        assert tail["seqs"] == list(range(1011, 1211))
        assert 1210 in fixture.stats["sinceSeqs"]

        adb("shell", "input", "keyevent", "KEYCODE_HOME")
        phase("09-background-stopped", lambda s: s["control"] == s["sessionConnection"] == "STOPPED")
        fixture.advance(1211, "reply while backgrounded")
        adb("shell", "am", "start", "-W", "-n", component)
        phase("10-foreground-reconcile", lambda s: ready(s) and s["maxSeq"] == 1211 and s["approvals"] == 0)
        assert not fixture.stats["errors"], fixture.stats["errors"]
        status = "PASS"
    except Exception:
        error = traceback.format_exc()
        print(error, flush=True)
    finally:
        # Restore the shared device before releasing ui.lock, even when a check failed.
        for key in ("accelerometer_rotation", "user_rotation"):
            adb("shell", "settings", "put", "system", key, original[key], check=False)
        for setting, service in (("wifi_on", "wifi"), ("mobile_data", "data")):
            adb("shell", "svc", service, "enable" if original[setting] == "1" else "disable", check=False)
        adb("shell", "am", "start", "-W", "-n", component, "--ez", "finish_fixture", "true", check=False)
        pids = {p["state"]["pid"] for p in phases}
        for pid in pids:
            (output / f"logcat-{pid}.txt").write_text(adb("logcat", "-d", "-v", "threadtime", f"--pid={pid}", "-T", str(int(started)) + ".000", check=False))
        adb("reverse", "--remove", "tcp:18769", check=False)
        fixture.drop()
        server.shutdown()
        server.server_close()
        (output / "server.json").write_text(json.dumps(fixture.stats, indent=2))
        (output / "commands.json").write_text(json.dumps(commands, indent=2))
        for log in output.glob("*.txt"):
            content = log.read_text(errors="replace")
            if any(secret in content for secret in ("a04-fixture-access", "a04-fixture-refresh", "a04-fixture-password")):
                status, error = "FAILED", "Fixture credential found in " + log.name
        (output / "report.json").write_text(json.dumps({"status": status, "error": error, "phases": phases,
            "started": started, "finished": time.time(), "scope": "Controlled debug fixture; no physical-phone or production-server claim"}, ensure_ascii=False, indent=2))
    if status != "PASS":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
