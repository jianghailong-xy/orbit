#!/usr/bin/env python3
"""In-app update on a device, against real GitHub releases.

Downloads the FROM release's APK from GitHub and checks it against its .sha256 and
android-update.json, installs it, optionally seeds sign-in and account-scoped data with the
same-signer UpgradeDeviceTest (a disposable *.upgradetest package), waits until the TO release is
published, then starts the app and lets it update itself: the automatic prompt, the download,
"Install unknown apps" in Settings and Android's own confirmation. It then checks an in-place
update (same UID, firstInstallTime and signer; higher versionCode), shows Settings → About
reporting the new version as current, and verifies the seeded data survived. The whole device
part holds the shared UI lock. Nothing is uninstalled or cleared between the two versions; only a
disposable *.upgradetest package is removed afterwards."""
import argparse
import fcntl
import hashlib
import json
import os
import pathlib
import re
import signal
import subprocess
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET

SDK = os.environ.get('ANDROID_HOME', '/opt/android-sdk')
ADB = f'{SDK}/platform-tools/adb'
AAPT = f'{SDK}/build-tools/36.0.0/aapt'
APKSIGNER = f'{SDK}/build-tools/36.0.0/apksigner'
ACTIVITY = 'io.orbitd.android.MainActivity'
REMOTE_DUMP = '/data/local/tmp/a14-update-window.xml'


def utc():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


class Device:
    def __init__(self, serial, output):
        self.serial, self.output, self.step = serial, output, 0
        self.log = open(output / 'steps.log', 'a', encoding='utf-8')

    def note(self, message):
        line = f'{utc()} {message}'
        print(line, flush=True)
        self.log.write(line + '\n')
        self.log.flush()

    def adb(self, *args, check=True, timeout=180):
        result = subprocess.run([ADB, '-s', self.serial, *args], capture_output=True, text=True, timeout=timeout)
        if check and result.returncode:
            raise RuntimeError(f'adb {" ".join(args)} failed: {result.stdout}{result.stderr}')
        return result.stdout

    def shell(self, command, **kwargs):
        return self.adb('shell', command, **kwargs)

    def save(self, name, text):
        (self.output / name).write_text(text, encoding='utf-8')
        return text

    def screenshot(self, name):
        self.step += 1
        data = subprocess.run([ADB, '-s', self.serial, 'exec-out', 'screencap', '-p'], capture_output=True, timeout=60).stdout
        (self.output / f'screen-{self.step:02d}-{name}.png').write_bytes(data)

    def window(self):
        for _ in range(10):
            result = self.shell(f'uiautomator dump {REMOTE_DUMP}', check=False)
            if 'dumped to' in result:
                return ET.fromstring(self.shell(f'cat {REMOTE_DUMP}'))
            time.sleep(1)  # An animating progress bar can keep the window from becoming idle.
        raise RuntimeError('uiautomator could not dump the window')

    def find(self, texts=(), descriptions=(), timeout=90, absent_ok=False):
        deadline = time.time() + timeout
        while time.time() < deadline:
            for node in self.window().iter('node'):
                if node.get('text') in texts or node.get('content-desc') in descriptions:
                    return node
            time.sleep(1)
        if absent_ok:
            return None
        raise RuntimeError(f'Timed out waiting for {texts or descriptions}')

    def tap(self, node):
        left, top, right, bottom = map(int, re.findall(r'\d+', node.get('bounds')))
        self.shell(f'input tap {(left + right) // 2} {(top + bottom) // 2}')

    def package(self, package):
        text = self.shell(f'dumpsys package {package}')
        fields = {key: (re.search(pattern, text) or [None, None])[1] for key, pattern in {
            'appId': r'\b(?:userId|appId)=(\d+)', 'versionCode': r'\bversionCode=(\d+)',
            'versionName': r'\bversionName=(\S+)', 'firstInstallTime': r'firstInstallTime=([^\r\n]+)',
            'lastUpdateTime': r'lastUpdateTime=([^\r\n]+)', 'installerPackageName': r'installerPackageName=(\S+)',
            'dataDir': r'dataDir=(\S+)'}.items()}
        return fields, text


def sha256(path):
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()


def download(url, path):
    request = urllib.request.Request(url, headers={'User-Agent': 'orbit-a14-update-device-test'})
    with urllib.request.urlopen(request, timeout=120) as response:
        path.write_bytes(response.read())
    return path


def fetch_release(repository, tag, folder, extra=()):
    """Release assets by their public download URLs (no API quota), checked against each other."""
    folder.mkdir(parents=True)
    base = f'https://github.com/{repository}/releases/download/{tag}'
    manifest = json.loads(download(f'{base}/android-update.json', folder / 'android-update.json').read_text())
    apk = download(manifest['apkUrl'], folder / manifest['apkName'])
    listed = download(f"{manifest['apkUrl']}.sha256", folder / f"{manifest['apkName']}.sha256").read_text().split()[0]
    assert manifest['apkUrl'] == f"{base}/{manifest['apkName']}", 'apkUrl is not this release'
    assert sha256(apk) == manifest['sha256'] == listed, 'APK, .sha256 and manifest disagree'
    assert tag == f"android-v{manifest['versionName']}"
    badging = subprocess.run([AAPT, 'dump', 'badging', str(apk)], capture_output=True, text=True, check=True).stdout
    signing = subprocess.run([APKSIGNER, 'verify', '--verbose', '--print-certs', str(apk)], capture_output=True, text=True,
                             check=True).stdout
    (folder / 'badging.txt').write_text(badging)
    (folder / 'signing.txt').write_text(signing)
    package = re.search(r"package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'", badging)
    certs = re.findall(r'^Signer #\d+ certificate SHA-256 digest: ([0-9a-f]+)$', signing, re.M)
    assert package and (package[1], int(package[2]), package[3]) == (
        manifest['applicationId'], manifest['versionCode'], manifest['versionName']), 'APK identity differs from manifest'
    assert certs == [manifest['certSha256']], 'APK signer differs from manifest certSha256'
    assert 'application-debuggable' not in badging
    files = {name: download(f'{base}/{name}', folder / name) for name in extra}
    return dict(tag=tag, url=f'https://github.com/{repository}/releases/tag/{tag}', manifest=manifest,
                apkSha256=sha256(apk), certificateSha256=certs[0], apk=str(apk),
                extra={name: dict(path=str(path), sha256=sha256(path)) for name, path in files.items()})


def instrument(device, package, phase, release):
    runner = f'{package}.test/androidx.test.runner.AndroidJUnitRunner'
    device.shell(f'am force-stop {package}')
    text = device.adb('shell', 'am', 'instrument', '-w', '-r', '-e', 'class', 'io.orbitd.android.release.UpgradeDeviceTest',
                      '-e', 'a14_phase', phase, '-e', 'a14_expected_version_name', release['manifest']['versionName'],
                      '-e', 'a14_expected_version_code', str(release['manifest']['versionCode']), runner, timeout=300)
    device.save(f'instrument-{phase}.txt', text)
    assert 'OK (1 test)' in text and not re.search(r'FAILURES!!!|INSTRUMENTATION_FAILED|Process crashed', text), text
    return dict(re.findall(r'INSTRUMENTATION_STATUS: (a14_\w+)=(.*)', text))


def wait_for_release(repository, tag, device, timeout):
    device.note(f'Waiting up to {timeout}s for {tag} to be published')
    deadline = time.time() + timeout
    while time.time() < deadline:
        tags = subprocess.run(['git', 'ls-remote', '--tags', f'https://github.com/{repository}', f'refs/tags/{tag}'],
                              capture_output=True, text=True, timeout=60).stdout
        if tags.strip():
            try:
                urllib.request.urlopen(urllib.request.Request(
                    f'https://github.com/{repository}/releases/download/{tag}/android-update.json',
                    headers={'User-Agent': 'orbit-a14-update-device-test'}), timeout=60).read()
                device.note(f'{tag} is published')
                return
            except Exception:  # noqa: BLE001 - published tag, assets not served yet
                pass
        time.sleep(15)
    raise RuntimeError(f'{tag} was not published in time')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repository', default='jianghailong-xy/orbit')
    parser.add_argument('--from-tag', required=True)
    parser.add_argument('--to-tag', required=True)
    parser.add_argument('--test-apk-asset', help='same-signer instrumentation APK asset of the FROM release (seed/verify data)')
    parser.add_argument('--serial', default='emulator-5554')
    parser.add_argument('--publish-timeout', type=int, default=3600)
    parser.add_argument('--lock-timeout', type=int, default=7200)
    parser.add_argument('--remove-stale-disposable', action='store_true',
                        help='record and uninstall a leftover *.upgradetest install of an earlier run first')
    parser.add_argument('--output', required=True, type=pathlib.Path)
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True)
    assert not any(output.iterdir()), 'Use a new evidence directory'
    device = Device(args.serial, output)
    result = dict(scope='GitHub-published APKs; emulator; in-app updater', started=utc(), exit='incomplete')
    try:
        old = fetch_release(args.repository, args.from_tag, output / 'from', (args.test_apk_asset,) if args.test_apk_asset else ())
        package = old['manifest']['applicationId']
        disposable = package.endswith('.upgradetest')
        assert not args.test_apk_asset or disposable, 'Data seeding uses the disposable *.upgradetest package only'
        result['from'] = old
        # Start the adb server before locking so a daemon spawned later cannot inherit the lock.
        # subprocess closes inherited descriptors anyway; every adb call names the serial.
        subprocess.run([ADB, 'start-server'], check=True, capture_output=True, timeout=60)
        lock = open(os.environ.get('ANDROID_DEVICE_LOCK', '/var/lib/orbit/android/ui.lock'), 'w')
        # Queue like flock(1) does: a blocking wait, bounded by an alarm.
        signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(TimeoutError('UI lock is busy')))
        signal.alarm(args.lock_timeout)
        fcntl.flock(lock, fcntl.LOCK_EX)
        signal.alarm(0)
        device.note(f'Holding the UI lock for {args.serial}')
        assert device.adb('get-state').strip() == 'device'
        device.save('device.txt', ''.join(f"{p}={device.shell(f'getprop {p}').strip()}\n" for p in (
            'ro.product.model', 'ro.build.version.release', 'ro.build.version.sdk', 'ro.build.fingerprint', 'ro.kernel.qemu')))
        before_packages = device.save('packages-before.txt', device.shell(f'pm list packages {package}'))
        if f'package:{package}\n' in before_packages.replace('\r', '') + '\n':
            assert disposable and args.remove_stale_disposable, f'{package} is already installed'
            device.save('stale-package.txt', device.package(package)[1])
            device.save('stale-uninstall.txt', device.adb('uninstall', package) + device.adb('uninstall', f'{package}.test', check=False))
            device.note(f'Removed a leftover disposable {package} install of an earlier run')

        device.save('install-from.txt', device.adb('install', old['apk']))
        assert 'Success' in (output / 'install-from.txt').read_text()
        if args.test_apk_asset:
            device.save('install-tests.txt', device.adb('install', '-r', old['extra'][args.test_apk_asset]['path']))
            result['seed'] = instrument(device, package, 'seed', old)
        installed, text = device.package(package)
        device.save('package-from.txt', text)
        result['installedFrom'] = installed
        device.save('appops-before.txt', device.shell(f'appops get {package} REQUEST_INSTALL_PACKAGES', check=False))

        wait_for_release(args.repository, args.to_tag, device, args.publish_timeout)
        new = fetch_release(args.repository, args.to_tag, output / 'to')
        result['to'] = new
        assert new['manifest']['applicationId'] == package and new['certificateSha256'] == old['certificateSha256']
        assert new['manifest']['versionCode'] > old['manifest']['versionCode']

        # First start since installation: the automatic check finds the TO release and prompts.
        device.note(device.shell(f'am start -W -n {package}/{ACTIVITY}'))
        device.find(texts=('Update available',), timeout=120)
        offered = f"Orbit {new['manifest']['versionName']} ({new['manifest']['versionCode']}) is available."
        assert device.find(texts=(offered,), timeout=10), offered
        device.screenshot('prompt')
        device.tap(device.find(texts=('Update',)))
        device.note('Accepted the update prompt')
        node = device.find(texts=('Open settings', 'Waiting for Android to install the update…'), timeout=180)
        if node.get('text') == 'Open settings':
            device.screenshot('permission-guidance')
            pid = device.shell(f'pidof {package}', check=False).strip()
            device.tap(node)
            toggle = device.find(texts=('Allow from this source',), timeout=60)
            device.screenshot('unknown-apps-setting')
            device.tap(toggle)
            time.sleep(1)
            device.save('appops-granted.txt', device.shell(f'appops get {package} REQUEST_INSTALL_PACKAGES', check=False))
            device.screenshot('unknown-apps-allowed')
            device.shell('input keyevent KEYCODE_BACK')
            time.sleep(2)
            result['processAfterPermission'] = dict(before=pid, after=device.shell(f'pidof {package}', check=False).strip())
            device.note(f"Allowed installs from Orbit and returned; app pid {result['processAfterPermission']}")
        # Android's installer asks for confirmation. If Android restarted Orbit meanwhile, Orbit offers
        # the same verified update again first.
        deadline, confirmed = time.time() + 240, False
        while not confirmed:
            assert time.time() < deadline, 'Android did not ask to confirm the update'
            for node in device.window().iter('node'):
                text, owner = node.get('text'), node.get('package', '')
                if 'packageinstaller' in owner and text in ('Update', 'UPDATE', 'Install', 'INSTALL'):
                    device.screenshot('android-confirmation')
                    device.tap(node)
                    confirmed = True
                    break
                if owner == package and text == 'Update':
                    device.note('Orbit offered the verified update again')
                    device.screenshot('prompt-again')
                    device.tap(node)
                    time.sleep(2)
                    break
            else:
                time.sleep(1)
        device.note('Confirmed Android installer')
        deadline = time.time() + 180
        while device.package(package)[0]['versionCode'] != str(new['manifest']['versionCode']):
            assert time.time() < deadline, 'The update did not install'
            time.sleep(2)
        updated, text = device.package(package)
        device.save('package-to.txt', text)
        result['installedTo'] = updated
        for key in ('appId', 'firstInstallTime', 'dataDir'):
            assert installed[key] == updated[key], f'{key} changed: not an in-place update'
        assert updated['versionName'] == new['manifest']['versionName']
        device.note(f"Updated in place: {installed['versionCode']} -> {updated['versionCode']}")

        # Settings → About on the new version: version shown, manual check finds nothing newer.
        device.note(device.shell(f'am start -W -n {package}/{ACTIVITY}'))
        if args.test_apk_asset:
            device.tap(device.find(descriptions=('Open navigation',), timeout=60))
            device.tap(device.find(texts=('Settings',)))
            device.find(texts=(f"Orbit {new['manifest']['versionName']} ({new['manifest']['versionCode']})",), timeout=30)
            device.tap(device.find(texts=('Check for updates',)))
            device.find(texts=('Orbit is up to date.',), timeout=90)
            device.screenshot('about-up-to-date')
            result['verify'] = instrument(device, package, 'verify', new)
        else:
            device.screenshot('relaunched')
        if disposable:
            device.save('uninstall.txt', device.adb('uninstall', package) + device.adb('uninstall', f'{package}.test', check=False))
        result['exit'] = 'PASS'
    except Exception as error:  # noqa: BLE001 - record and fail
        result['error'] = repr(error)
        device.note(f'FAILED: {error!r}')
        try:
            device.screenshot('failure')
        except Exception:  # noqa: BLE001
            pass
        raise
    finally:
        device.shell(f'rm -f {REMOTE_DUMP}', check=False)
        result['finished'] = utc()
        (output / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(f"PASS: {args.from_tag} -> {args.to_tag}; evidence {output}")


if __name__ == '__main__':
    sys.exit(main())
