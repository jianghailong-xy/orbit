#!/usr/bin/env python3
"""One D09 P02/P03 collection on an emulator, from a real build: the OrbitPerf lines A15's collector reads.

  perf-marks-device-test.py APK NEW_OUTPUT_DIR [--serial emulator-5554] [--port 18786]

APK is a package of its own (never the shared io.orbitd.android[.debug]), normally a test-signed release from
build-release.sh. Holding /var/lib/orbit/android/ui.lock for the whole round (the API 36 emulator service is started
for it when it is down, and stopped again), it:
  - serves the DS3 transcript fixture on host 127.0.0.1:PORT, which the emulator reaches as http://10.0.2.2:PORT;
  - installs APK on cleared data, turns the tag on (setprop log.tag.OrbitPerf D) and records
    `logcat -v epoch -s OrbitPerf:D` to perf.log;
  - signs in through the login page (three taps on the logo open the Server dialog, as a person does);
  - opens "Long conversation" from its workspace with a tap: a P02 entry with nothing cached (source=network); goes
    back and opens it again (source=cache);
  - scrolls the transcript, opens the session's menu (a popup) and Session details (a dialog), closes it, waits for a
    10 s summary and leaves the app (the pause summary);
  - turns the tag off, uninstalls the package, and checks perf.log: summary.json/summary.txt, exit 0 when every
    expected line is there.
It is a controlled fixture and an emulator: the lines' shape and how they are collected, not D09 numbers.
"""
import argparse
import fcntl
import json
import os
import re
import struct
import subprocess
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET

SDK = os.environ.get('ANDROID_HOME', '/opt/android-sdk')
ADB_BIN = os.path.join(SDK, 'platform-tools', 'adb')
TOOLS = os.path.join(SDK, 'build-tools', '36.0.0')
LOCK = os.environ.get('ANDROID_DEVICE_LOCK', '/var/lib/orbit/android/ui.lock')
HERE = os.path.dirname(os.path.abspath(__file__))
SHARED = ('io.orbitd.android', 'io.orbitd.android.debug')

parser = argparse.ArgumentParser()
parser.add_argument('apk')
parser.add_argument('output')
parser.add_argument('--serial', default='emulator-5554')
parser.add_argument('--port', type=int, default=18786)
args = parser.parse_args()
apk, out, serial, port = os.path.abspath(args.apk), os.path.abspath(args.output), args.serial, args.port
os.makedirs(out, exist_ok=True)
if os.listdir(out):
    sys.exit('Use a new output directory')
journal = open(os.path.join(out, 'steps.txt'), 'a', buffering=1)


def note(line):
    stamp = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    journal.write(f'{stamp} {line}\n')
    print(f'{stamp} {line}', flush=True)


def adb(*command, check=True, timeout=120):
    return subprocess.run([ADB_BIN, '-s', serial, *command], capture_output=True, timeout=timeout, check=check)


def shell(command, **kwargs):
    return adb('shell', command, **kwargs).stdout.decode('utf-8', 'replace').strip()


def save(name, text):
    with open(os.path.join(out, name), 'w') as f:
        f.write(text if text.endswith('\n') else text + '\n')


badging = subprocess.run([os.path.join(TOOLS, 'aapt'), 'dump', 'badging', apk], capture_output=True, text=True, check=True).stdout
package = re.search(r"package: name='([^']+)'", badging).group(1)
if package in SHARED:
    sys.exit(f'{package} is shared with other tasks: build a package of your own (build-release.sh, *.upgradetest)')

# The adb server first, so no daemon it starts can inherit the lock's descriptor.
subprocess.run([ADB_BIN, 'start-server'], check=True, capture_output=True)
lock = open(LOCK, 'a')
deadline = time.time() + 7200
while True:
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        break
    except BlockingIOError:
        if time.time() > deadline:
            sys.exit('ui.lock not free within 2 h')
        time.sleep(5)
note(f'holding {LOCK}')

started_emulator = False
fixture = logcat = None
old_handwriting = None


def devices():
    return subprocess.run([ADB_BIN, 'devices'], capture_output=True, text=True).stdout


def cleanup():
    try:
        shell('setprop log.tag.OrbitPerf INFO', check=False)
        if old_handwriting is not None:
            shell('settings delete secure stylus_handwriting_enabled' if old_handwriting == 'null'
                  else f'settings put secure stylus_handwriting_enabled {old_handwriting}', check=False)
        if logcat:
            logcat.terminate()
        adb('uninstall', package, check=False)
        note(f'uninstalled {package}')
    finally:
        if fixture:
            fixture.terminate()
        if started_emulator:
            shell('sync', check=False)
            time.sleep(15)
            subprocess.run(['systemctl', 'stop', 'orbit-android-emulator.service'], check=False)
            note('stopped the emulator service this round started')


try:
    if f'{serial}\tdevice' not in devices():
        if serial != 'emulator-5554':
            sys.exit(f'{serial} is not connected')
        subprocess.run(['systemctl', 'start', 'orbit-android-emulator.service'], check=True)
        started_emulator = True
        note('started orbit-android-emulator.service')
    subprocess.run([ADB_BIN, '-s', serial, 'wait-for-device'], timeout=300, check=True)
    deadline = time.time() + 300
    while shell('getprop sys.boot_completed', check=False) != '1':
        if time.time() > deadline:
            sys.exit('boot timed out')
        time.sleep(2)
    save('device.txt', '\n'.join(f'{p}={shell("getprop " + p)}' for p in
        ('ro.product.model', 'ro.build.version.release', 'ro.build.version.sdk', 'ro.build.fingerprint', 'ro.kernel.qemu'))
        + f'\nserial={serial}\n{shell("wm size")}\n{shell("wm density")}\n'
        + shell('dumpsys display | grep -m3 -E "mRefreshRate|renderFrameRate|fps="', check=False))
    certs = subprocess.run([os.path.join(TOOLS, 'apksigner'), 'verify', '--print-certs', apk], capture_output=True, text=True).stdout
    sha = subprocess.run(['sha256sum', apk], capture_output=True, text=True).stdout
    save('apk.txt', sha + badging.splitlines()[0] + '\n' + certs)

    subprocess.run([sys.executable, '-I', os.path.join(HERE, 'transcript-fixture.py'), '--manifest', os.path.join(out, 'datasets')], check=True)
    fixture = subprocess.Popen([sys.executable, '-I', os.path.join(HERE, 'transcript-fixture.py'), '--port', str(port)],
                               stdout=open(os.path.join(out, 'fixture.log'), 'w'), stderr=subprocess.STDOUT)
    for _ in range(50):
        try:
            urllib.request.urlopen(f'http://127.0.0.1:{port}/__stats', timeout=1)
            break
        except OSError:
            time.sleep(0.2)
    else:
        sys.exit('fixture did not start')

    shell('input keyevent KEYCODE_WAKEUP'); shell('wm dismiss-keyguard', check=False)
    old_handwriting = shell('settings get secure stylus_handwriting_enabled', check=False) or 'null'
    shell('settings put secure stylus_handwriting_enabled 0', check=False)
    if package in shell(f'pm list packages {package}'):
        adb('uninstall', package)
    note('install: ' + adb('install', apk, timeout=300).stdout.decode().strip().splitlines()[-1])
    flags = re.findall(r'flags=\[ ([^\]]*) \]', shell(f'dumpsys package {package}'))
    note(f'package flags: {flags[0] if flags else "?"}')

    shell('setprop log.tag.OrbitPerf D')
    adb('logcat', '-c')
    logcat = subprocess.Popen([ADB_BIN, '-s', serial, 'logcat', '-v', 'epoch', '-s', 'OrbitPerf:D'],
                              stdout=open(os.path.join(out, 'perf.log'), 'w'), stderr=subprocess.STDOUT)
    note(f'log.tag.OrbitPerf={shell("getprop log.tag.OrbitPerf")}; logcat -v epoch -s OrbitPerf:D > perf.log')

    width, height = map(int, re.search(r'(\d+)x(\d+)', shell('wm size').splitlines()[-1]).groups())

    def nodes():
        for _ in range(5):
            raw = adb('exec-out', 'uiautomator', 'dump', '/dev/tty', check=False).stdout.decode('utf-8', 'replace')
            start, end = raw.find('<?xml'), raw.rfind('</hierarchy>')
            if start >= 0 and end > start:
                found = []
                for n in ET.fromstring(raw[start:end + len('</hierarchy>')]).iter('node'):
                    b = list(map(int, re.findall(r'\d+', n.get('bounds', ''))))
                    # On screen only: the closed drawer is composed off its left edge.
                    if len(b) == 4 and b[0] >= 0 and b[2] > b[0] and b[3] > b[1]:
                        found.append(dict(text=n.get('text', ''), desc=n.get('content-desc', ''), pkg=n.get('package', ''), bounds=b))
                return found
            time.sleep(1)
        sys.exit('uiautomator dump failed')

    def find(pattern):
        rx = re.compile(pattern)
        return [n for n in nodes() if rx.search(n['text']) or rx.search(n['desc'])]

    def capture(name):
        time.sleep(1)  # swiftshader's screencap lags the UI
        with open(os.path.join(out, f'{name}.png'), 'wb') as f:
            f.write(adb('exec-out', 'screencap', '-p').stdout)

    def wait(pattern, seconds=60):
        deadline = time.time() + seconds
        while time.time() < deadline:
            hits = find(pattern)
            if hits:
                return hits[0]
            refusal = find("^Don.t allow$")  # Android 13+'s notification prompt
            if refusal:
                tap_node(refusal[0])
            time.sleep(1)
        capture('timeout')
        sys.exit(f'timed out waiting for {pattern!r}')

    def centre(node):
        x1, y1, x2, y2 = node['bounds']
        return (x1 + x2) // 2, (y1 + y2) // 2

    def tap_node(node):
        x, y = centre(node)
        shell(f'input tap {x} {y}')

    def tap(pattern, seconds=60):
        node = wait(pattern, seconds)
        tap_node(node)
        note(f'tap {pattern!r} at {centre(node)}')

    def triple_tap(node):
        """Three touches ~150 ms apart through the touchscreen's evdev node (input tap is too slow), with pressure."""
        x, y = centre(node)
        X, Y = x * 32767 // width, y * 32767 // height

        def ev(t, c, v):
            return struct.pack('<qqHHi', 0, 0, t, c, v)
        folder = '/data/local/tmp/a06g-taps'
        shell(f'mkdir -p {folder}')
        for i in range(3):
            data = ev(3, 47, 0) + ev(3, 57, 300 + i) + ev(3, 53, X) + ev(3, 54, Y) + ev(3, 58, 512) + ev(3, 48, 5) + ev(0, 0, 0)
            local = os.path.join(out, f'tap-down{i}')
            open(local, 'wb').write(data)
            adb('push', local, f'{folder}/down{i}')
            os.remove(local)
        local = os.path.join(out, 'tap-up')
        open(local, 'wb').write(ev(3, 58, 0) + ev(3, 57, -1) + ev(0, 0, 0))
        adb('push', local, f'{folder}/up')
        os.remove(local)
        script = '; '.join(f'cat {folder}/down{i} > /dev/input/event2; sleep 0.05; cat {folder}/up > /dev/input/event2; sleep 0.1'
                           for i in range(3))
        adb('shell', 'su', '0', 'sh', '-c', f"'{script}'")
        note(f'triple tap at {x},{y}')

    def dismiss_stylus_sheet():
        for _ in find(r'(?i)stylus'):
            for c in find(r'^(Cancel|Not now|Close|Dismiss)$'):
                if c['pkg'] != package:
                    tap_node(c)
                    note('dismissed the keyboard stylus sheet')
                    time.sleep(1)
                    return

    def replace_field(label, value):
        tap(f'^{re.escape(label)}$')
        dismiss_stylus_sheet()
        tap(f'^{re.escape(label)}$')
        shell('input keyevent KEYCODE_MOVE_END')
        shell('input keyevent ' + ' '.join(['KEYCODE_DEL'] * 40))
        shell(f'input text {value}')

    def perf(ev):
        with open(os.path.join(out, 'perf.log')) as f:
            return [line for line in f if f' v=1 ev={ev} ' in line]

    def wait_line(ev, count, seconds=120):
        deadline = time.time() + seconds
        while len(perf(ev)) < count:
            if time.time() > deadline:
                capture(f'timeout-{ev}')
                sys.exit(f'no {count}th {ev} line within {seconds} s')
            time.sleep(0.5)
        note(f'{ev} #{count}: {perf(ev)[count - 1].strip()}')

    shell(f'am start -W -n {package}/io.orbitd.android.MainActivity')
    wait('^Welcome back$', 120)
    triple_tap(wait('^Orbit$'))
    wait('^Server address$', 20)
    dismiss_stylus_sheet()
    replace_field('Server address', f'http://10.0.2.2:{port}')
    tap('^Save$')
    deadline = time.time() + 20
    while find('^Server address$'):
        if time.time() > deadline:
            capture('timeout-server')
            sys.exit('the Server dialog stayed open')
        time.sleep(1)
    replace_field('Email', 'a06@example.test')
    replace_field('Password', 'a06-fixture-password')
    tap('^Sign In$')
    tap('^Reader fixture$', 120)
    note('signed in; workspace open')

    # P02: the same session opened twice from its list, first with nothing cached, then from the device's copy.
    for entry in (1, 2):
        tap('Long conversation', 60)
        wait_line('p02_ready', entry)
        capture(f'p02-entry{entry}')
        if entry == 1:
            shell('input keyevent KEYCODE_BACK')
            wait('Long conversation', 30)

    # P03: a reading journey in MainActivity's window, then the session's menu (a popup) and its details (a dialog).
    for direction in ('down', 'down', 'down', 'up', 'up', 'up'):
        y1, y2 = (height * 3 // 10, height * 7 // 10) if direction == 'down' else (height * 7 // 10, height * 3 // 10)
        shell(f'input swipe {width // 2} {y1} {width // 2} {y2} 300')
        time.sleep(1)
    note('scrolled the transcript')
    tap('^Session actions$')
    tap('^Session details$', 20)
    time.sleep(3)
    capture('p03-dialog')
    shell('input keyevent KEYCODE_BACK')
    time.sleep(12)
    shell('input keyevent KEYCODE_HOME')
    time.sleep(3)
    note('left the app: the pause summary')
    save('crash.txt', adb('logcat', '-d', '-b', 'crash', check=False).stdout.decode('utf-8', 'replace'))
finally:
    cleanup()

lines = [line.strip() for line in open(os.path.join(out, 'perf.log')) if ' v=1 ev=' in line]


def fields(line):
    return dict(part.split('=', 1) for part in line[line.index('v=1 '):].split() if '=' in part)


events = [fields(line) for line in lines]
starts = [e for e in events if e['ev'] == 'p02_start']
readies = [e for e in events if e['ev'] == 'p02_ready']
summaries = [e for e in events if e['ev'] == 'frames']
entries = []
for start, ready in zip(starts, readies):
    entry = {'via': start['via'], 'inputMono': start['inputMono'], 'source': ready['source'], 'tailSeq': ready['tailSeq'],
             'dropped': ready['dropped'], 'frameTotalNs': ready['frameTotalNs']}
    if start['inputMono'] != 'na' and ready['frameEndMono'] != 'na':
        entry['tapToFrameEndMs'] = (int(ready['frameEndMono']) - int(start['inputMono'])) / 1e6
    entries.append(entry)
last = {}
for s in summaries:
    last[s['win']] = s
crashed = package in open(os.path.join(out, 'crash.txt')).read()
checks = {
    'two P02 entries from the list, each with its tap time': len(starts) == 2 and all(s['via'] == 'list' and s['inputMono'].isdigit() for s in starts),
    'one p02_ready per entry: network, then cache': [r['source'] for r in readies] == ['network', 'cache'],
    'a frames summary for MainActivity\'s window': 'main' in last,
    'a frames summary for the Session details dialog': any(w.startswith('dialog:') for w in last),
    'the session menu said it has no window to watch': any(e['ev'] == 'window_unobserved' for e in events),
    'no crash': not crashed,
}
result = {'package': package, 'p02': entries, 'frames': last, 'gt700': [e for e in events if e['ev'] == 'frame_gt700'],
          'unobserved': [e['win'] for e in events if e['ev'] == 'window_unobserved'], 'checks': checks}
with open(os.path.join(out, 'summary.json'), 'w') as f:
    json.dump(result, f, indent=2)
save('summary.txt', '\n'.join([*(f'{"PASS" if ok else "FAIL"} {name}' for name, ok in checks.items()), '', *lines]))
print(open(os.path.join(out, 'summary.txt')).read())
sys.exit(0 if all(checks.values()) else 1)
