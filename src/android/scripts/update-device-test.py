#!/usr/bin/env python3
"""In-app update on a device, against a local stand-in for GitHub (fake-github.py, through adb reverse).

Takes two test-signed release APKs of a disposable *.upgradetest package built for the stand-in
(build-release.sh with ORBIT_ANDROID_UPDATE_API=http://127.0.0.1:<port>), their identity.json files and
the same-signer UpgradeDeviceTest APK. FROM is published the way release.yml publishes: github-release.py
validate, a release holding the macOS files (dmg's job), github-release.py manifest, the APK and .sha256
attached, android-update.json last, verify-published. Beside it go a newer macOS-only v* release, a draft
v* release carrying an Android manifest and an android-v* release carrying one.

With the UI lock held it installs FROM, seeds sign-in and account-scoped data (UpgradeDeviceTest seed),
and shows that neither the automatic check at launch nor Settings → About → Check for updates offers an
update. Then TO is published the same way, and the app finds it, downloads it, checks its SHA-256 and
certificate, asks for "Install unknown apps" and hands it to Android's installer. It checks an in-place
update (same UID, firstInstallTime and data directory; higher versionCode), that About shows TO as
current, and that sign-in and data survived (UpgradeDeviceTest verify). Nothing is uninstalled or cleared
between the versions; the disposable packages and the adb reverse rule are removed at the end."""
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
import xml.etree.ElementTree as ET

SDK = os.environ.get('ANDROID_HOME', '/opt/android-sdk')
ADB = f'{SDK}/platform-tools/adb'
AAPT = f'{SDK}/build-tools/36.0.0/aapt'
APKSIGNER = f'{SDK}/build-tools/36.0.0/apksigner'
ACTIVITY = 'io.orbitd.android.MainActivity'
REMOTE_DUMP = '/data/local/tmp/a14-update-window.xml'
HERE = pathlib.Path(__file__).resolve().parent
RELEASE_SCRIPT = HERE / 'github-release.py'
FAKE_GITHUB = HERE / 'fake-github.py'


def utc():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def sha256(path):
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()


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
        return result.stdout + result.stderr

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

    def visible(self, texts, attempts=8):
        """The node, swiped into the upper part of the screen first when the page has to scroll."""
        width, height = map(int, re.search(r'(\d+)x(\d+)', self.shell('wm size')).groups())
        for _ in range(attempts):
            node = self.find(texts=texts, timeout=30)
            left, top, right, bottom = map(int, re.findall(r'\d+', node.get('bounds')))
            if bottom > top and 0 <= top and bottom <= height * 0.85:
                return node
            self.shell(f'input swipe {width // 2} {height * 3 // 4} {width // 2} {height // 4} 400')
            time.sleep(1)
        raise RuntimeError(f'{texts} did not scroll into view')

    def package(self, package):
        text = self.shell(f'dumpsys package {package}')
        fields = {key: (re.search(pattern, text) or [None, None])[1] for key, pattern in {
            'appId': r'\b(?:userId|appId)=(\d+)', 'versionCode': r'\bversionCode=(\d+)',
            'versionName': r'\bversionName=(\S+)', 'firstInstallTime': r'firstInstallTime=([^\r\n]+)',
            'lastUpdateTime': r'lastUpdateTime=([^\r\n]+)', 'installerPackageName': r'installerPackageName=(\S+)',
            'dataDir': r'dataDir=(\S+)'}.items()}
        return fields, text


def inspect(apk, identity_path, folder):
    """The APK's own identity (aapt, apksigner) must be the one build-release.sh recorded."""
    folder.mkdir(parents=True)
    identity = json.loads(pathlib.Path(identity_path).read_text())
    badging = subprocess.run([AAPT, 'dump', 'badging', str(apk)], capture_output=True, text=True, check=True).stdout
    signing = subprocess.run([APKSIGNER, 'verify', '--verbose', '--print-certs', str(apk)], capture_output=True,
                             text=True, check=True).stdout
    tree = subprocess.run([AAPT, 'dump', 'xmltree', str(apk), 'AndroidManifest.xml'], capture_output=True, text=True,
                          check=True).stdout
    for name, text in (('badging.txt', badging), ('signing.txt', signing), ('manifest-tree.txt', tree)):
        (folder / name).write_text(text)
    (folder / 'identity.json').write_text(json.dumps(identity, indent=2) + '\n')
    package = re.search(r"package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'", badging)
    certs = re.findall(r'^Signer #\d+ certificate SHA-256 digest: ([0-9a-f]+)$', signing, re.M)
    assert package and (package[1], int(package[2]), package[3]) == (
        identity['applicationId'], identity['versionCode'], identity['versionName']), 'APK identity differs from identity.json'
    assert certs == [identity['certificateSha256']], 'APK signer differs from identity.json'
    assert sha256(apk) == identity['apkSha256'], 'APK bytes differ from identity.json'
    assert identity['signingPurpose'] == 'test' and identity['distributionSignature'] is False, 'test signature only'
    assert identity['applicationId'].endswith('.upgradetest'), 'disposable *.upgradetest package only'
    assert 'application-debuggable' not in badging and identity['sourceDirty'] is False
    assert 'networkSecurityConfig' in tree, 'a rehearsal build carries the loopback network config'
    return identity


class Releases:
    """releases.json and files/ of the stand-in, written the way GitHub would show them, newest first."""

    def __init__(self, state, origin, repository):
        self.state, self.origin, self.repository = state, origin, repository
        (state / 'files').mkdir(parents=True)
        self.save([])

    def load(self):
        return json.loads((self.state / 'releases.json').read_text())

    def save(self, releases):
        temporary = self.state / 'releases.json.tmp'
        temporary.write_text(json.dumps(releases, indent=2) + '\n')
        temporary.replace(self.state / 'releases.json')

    def asset(self, tag, name, data):
        folder = self.state / 'files' / tag
        folder.mkdir(parents=True, exist_ok=True)
        (folder / name).write_bytes(data)
        return dict(name=name, size=len(data), state='uploaded', digest=f'sha256:{hashlib.sha256(data).hexdigest()}',
                    browser_download_url=f'{self.origin}/{self.repository}/releases/download/{tag}/{name}')

    def create(self, tag, files, draft=False):
        """gh release create, as the dmg job runs it: a pre-release when the tag has a suffix."""
        releases = self.load()
        assert all(r['tag_name'] != tag for r in releases), f'{tag} exists'
        releases.insert(0, dict(tag_name=tag, name=tag, draft=draft, prerelease='-' in tag, immutable=False,
                                html_url=f'{self.origin}/{self.repository}/releases/tag/{tag}',
                                assets=[self.asset(tag, name, data) for name, data in files.items()]))
        self.save(releases)

    def upload(self, tag, paths):
        """gh release upload without --clobber."""
        releases = self.load()
        release = next(r for r in releases if r['tag_name'] == tag)
        for path in paths:
            assert all(a['name'] != path.name for a in release['assets']), f'{path.name} would be overwritten'
            release['assets'].append(self.asset(tag, path.name, path.read_bytes()))
        self.save(releases)


def apple_files(tag):
    return {f'Orbit-{tag}-arm64.dmg': f'stand-in DMG for {tag}\n'.encode(),
            f'Orbit-{tag}-arm64.zip': f'stand-in Sparkle zip for {tag}\n'.encode()}


def run_release_script(folder, name, env, *args):
    result = subprocess.run([sys.executable, '-I', str(RELEASE_SCRIPT), *map(str, args)], env=env, capture_output=True,
                            text=True, timeout=300)
    (folder / f'{name}.txt').write_text(f'$ github-release.py {" ".join(map(str, args))}\nexit={result.returncode}\n'
                                        f'{result.stdout}{result.stderr}')
    assert result.returncode == 0, f'github-release.py {name} failed: {result.stdout}{result.stderr}'
    return result


def publish_android(releases, env, folder, tag, apk, identity_path, identity):
    """release.yml for one v* tag: android-build's check, dmg's release, then android-publish."""
    folder.mkdir(parents=True)
    run_release_script(folder, 'validate', env, 'validate', '--tag', tag, '--version-code', identity['versionCode'],
                       '--source-sha', identity['sourceSha'], '--application-id', identity['applicationId'],
                       '--repository', releases.repository, '--output', folder / 'validate.out')
    assert (folder / 'validate.out').read_text().startswith('skip=false'), 'a new Android build was expected'
    releases.create(tag, apple_files(tag))
    (folder / 'notes.txt').write_text(f'Release {tag}\n\n')
    run_release_script(folder, 'manifest', env, 'manifest', '--test-signature', '--tag', tag, '--repository',
                       releases.repository, '--identity', identity_path, '--apk', apk, '--notes-file', folder / 'notes.txt',
                       '--output', folder / 'out', '--github-output', folder / 'manifest.out')
    assert (folder / 'manifest.out').read_text() == 'skip=false\n'
    pending = (folder / 'out' / 'pending-assets.txt').read_text().split()
    releases.upload(tag, [folder / 'out' / name for name in pending])
    releases.upload(tag, [folder / 'out' / 'android-update.json'])
    run_release_script(folder, 'verify-published', env, 'verify-published', '--repository', releases.repository,
                       '--tag', tag, '--dir', folder / 'out')
    return json.loads((folder / 'out' / 'android-update.json').read_text())


def handmade(releases, tag, version_name, code, apk, identity, draft):
    """A release no app may take: carries an Android manifest naming a valid same-signer APK."""
    apk_name = f'orbit-android-{version_name}.apk'
    manifest = dict(schemaVersion=1, tag=tag, applicationId=identity['applicationId'], versionName=version_name,
                    versionCode=code, minSdk=29, apkName=apk_name,
                    apkUrl=f'{releases.origin}/{releases.repository}/releases/download/{tag}/{apk_name}',
                    apkSize=apk.stat().st_size, sha256=identity['apkSha256'], certSha256=identity['certificateSha256'],
                    sourceSha=identity['sourceSha'], publishedAt=utc(), notes=f'Must never be offered ({tag})')
    files = dict(apple_files(tag)) if tag.startswith('v') else {}
    files.update({apk_name: apk.read_bytes(), f'{apk_name}.sha256': f'{identity["apkSha256"]}  {apk_name}\n'.encode(),
                  'android-update.json': (json.dumps(manifest, indent=2) + '\n').encode()})
    releases.create(tag, files, draft=draft)
    return manifest


def requests_since(state, offset):
    lines = (state / 'requests.jsonl').read_text().splitlines() if (state / 'requests.jsonl').exists() else []
    return [json.loads(line) for line in lines[offset:]]


def wait_for_request(state, offset, predicate, timeout, what):
    deadline = time.time() + timeout
    while time.time() < deadline:
        found = [r for r in requests_since(state, offset) if predicate(r)]
        if found:
            return found[0]
        time.sleep(1)
    raise RuntimeError(f'The app did not request {what}')


def instrument(device, package, phase, identity):
    runner = f'{package}.test/androidx.test.runner.AndroidJUnitRunner'
    device.shell(f'am force-stop {package}')
    text = device.adb('shell', 'am', 'instrument', '-w', '-r', '-e', 'class', 'io.orbitd.android.release.UpgradeDeviceTest',
                      '-e', 'a14_phase', phase, '-e', 'a14_expected_version_name', identity['versionName'],
                      '-e', 'a14_expected_version_code', str(identity['versionCode']), runner, timeout=300)
    device.save(f'instrument-{phase}.txt', text)
    assert 'OK (1 test)' in text and not re.search(r'FAILURES!!!|INSTRUMENTATION_FAILED|Process crashed', text), text
    return dict(re.findall(r'INSTRUMENTATION_STATUS: (a14_\w+)=(.*)', text))


def open_about(device, version_line):
    device.tap(device.find(descriptions=('Open navigation',), timeout=60))
    device.tap(device.visible(('Settings',)))
    device.tap(device.visible(('About',)))
    device.find(texts=(version_line,), timeout=30)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--from-apk', required=True, type=pathlib.Path)
    parser.add_argument('--from-identity', required=True, type=pathlib.Path)
    parser.add_argument('--to-apk', required=True, type=pathlib.Path)
    parser.add_argument('--to-identity', required=True, type=pathlib.Path)
    parser.add_argument('--test-apk', required=True, type=pathlib.Path, help='same-signer UpgradeDeviceTest APK')
    parser.add_argument('--repository', default='jianghailong-xy/orbit')
    parser.add_argument('--serial', default='emulator-5554')
    parser.add_argument('--lock-timeout', type=int, default=7200)
    parser.add_argument('--remove-stale-disposable', action='store_true',
                        help='record and uninstall a leftover *.upgradetest install of an earlier run first')
    parser.add_argument('--output', required=True, type=pathlib.Path)
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True)
    assert not any(output.iterdir()), 'Use a new evidence directory'
    device = Device(args.serial, output)
    result = dict(scope='Test-signed *.upgradetest APKs (not a distribution signature); local stand-in for GitHub '
                        '(fake-github.py through adb reverse); emulator; synthetic sign-in fixture', started=utc(), exit='incomplete')
    fake = None
    reversed_port = None
    installed_package = None
    try:
        old = inspect(args.from_apk, args.from_identity, output / 'from')
        new = inspect(args.to_apk, args.to_identity, output / 'to')
        package = old['applicationId']
        port = int(re.fullmatch(r'http://127\.0\.0\.1:(\d+)', old['updateApi'])[1])
        assert old['updateApi'] == new['updateApi'], 'both builds read the same stand-in'
        assert new['applicationId'] == package and new['certificateSha256'] == old['certificateSha256']
        assert new['versionCode'] > old['versionCode'] and new['versionName'] != old['versionName']
        test_badging = subprocess.run([AAPT, 'dump', 'badging', str(args.test_apk)], capture_output=True, text=True,
                                      check=True).stdout
        test_signing = subprocess.run([APKSIGNER, 'verify', '--print-certs', str(args.test_apk)], capture_output=True,
                                      text=True, check=True).stdout
        assert f"package: name='{package}.test'" in test_badging, 'instrumentation APK of this package'
        assert re.findall(r'certificate SHA-256 digest: ([0-9a-f]+)', test_signing) == [old['certificateSha256']]
        keys = ('applicationId', 'versionName', 'versionCode', 'sourceSha', 'apkSha256', 'certificateSha256',
                'signingPurpose', 'distributionSignature', 'updateApi')
        result['apks'] = dict(
            **{name: {key: identity[key] for key in keys} for name, identity in (('from', old), ('to', new))},
            test=dict(package=f'{package}.test', apkSha256=sha256(args.test_apk), certificateSha256=old['certificateSha256']))
        from_tag, to_tag = f"v{old['versionName']}", f"v{new['versionName']}"
        stem = re.sub(r'\.\d+$', '', old['versionName'])
        apple_tag, draft_tag, legacy_tag = f'v{stem}.90', f'v{stem}.91', f'android-v{stem}.92'

        # The stand-in, with FROM published by the steps release.yml runs.
        state = output / 'github'
        state.mkdir()
        origin = f'http://127.0.0.1:{port}'
        releases = Releases(state, origin, args.repository)
        fake = subprocess.Popen([sys.executable, '-I', str(FAKE_GITHUB), '--state', str(state), '--port', str(port)],
                                stdout=open(output / 'fake-github.txt', 'w'), stderr=subprocess.STDOUT)
        for _ in range(100):
            if (output / 'fake-github.txt').read_text().startswith('fake GitHub'):
                break
            assert fake.poll() is None, (output / 'fake-github.txt').read_text()
            time.sleep(0.2)
        env = dict(PATH=os.environ['PATH'], GITHUB_API_URL=origin, GITHUB_SERVER_URL=origin)
        result['fromManifest'] = publish_android(releases, env, output / 'publish' / from_tag, from_tag, args.from_apk,
                                                 args.from_identity, old)
        # Newer than FROM, and no update: a macOS-only release, a draft and the retired android-v* scheme.
        releases.create(apple_tag, apple_files(apple_tag))
        result['draftManifest'] = handmade(releases, draft_tag, f'{stem}.91', new['versionCode'] + 10, args.to_apk, new, draft=True)
        result['legacyManifest'] = handmade(releases, legacy_tag, f'{stem}.92', new['versionCode'] + 20, args.to_apk, new, draft=False)
        never = [f'/{args.repository}/releases/download/{tag}/' for tag in (draft_tag, legacy_tag)]
        (output / 'releases-stage1.json').write_text((state / 'releases.json').read_text())

        # Start the adb server before locking so a daemon spawned later cannot inherit the lock.
        subprocess.run([ADB, 'start-server'], check=True, capture_output=True, timeout=60)
        lock = open(os.environ.get('ANDROID_DEVICE_LOCK', '/var/lib/orbit/android/ui.lock'), 'w')
        signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(TimeoutError('UI lock is busy')))
        signal.alarm(args.lock_timeout)
        fcntl.flock(lock, fcntl.LOCK_EX)
        signal.alarm(0)
        device.note(f'Holding the UI lock for {args.serial}')
        assert device.adb('get-state').strip() == 'device'
        device.save('device.txt', ''.join(f"{p}={device.shell(f'getprop {p}').strip()}\n" for p in (
            'ro.product.model', 'ro.build.version.release', 'ro.build.version.sdk', 'ro.build.fingerprint', 'ro.kernel.qemu')))
        assert device.shell('getprop ro.kernel.qemu').strip() == '1', 'emulator only'
        before = device.save('packages-before.txt', device.shell(f'pm list packages {package}'))
        if f'package:{package}' in before.split():
            assert args.remove_stale_disposable, f'{package} is already installed'
            device.save('stale-package.txt', device.package(package)[1])
            device.save('stale-uninstall.txt', device.adb('uninstall', package) + device.adb('uninstall', f'{package}.test', check=False))
            device.note(f'Removed a leftover disposable {package} install of an earlier run')
        device.save('reverse-before.txt', device.adb('reverse', '--list'))
        assert f'tcp:{port}' not in (output / 'reverse-before.txt').read_text(), f'port {port} is already reversed'
        device.adb('reverse', f'tcp:{port}', f'tcp:{port}')
        reversed_port = port
        device.save('reverse-during.txt', device.adb('reverse', '--list'))

        installed_package = package
        device.save('install-from.txt', device.adb('install', str(args.from_apk)))
        assert re.search(r'^Success', (output / 'install-from.txt').read_text(), re.M)
        device.save('install-tests.txt', device.adb('install', '-r', str(args.test_apk)))
        assert re.search(r'^Success', (output / 'install-tests.txt').read_text(), re.M)
        result['seed'] = instrument(device, package, 'seed', old)
        installed, text = device.package(package)
        device.save('package-from.txt', text)
        result['installedFrom'] = installed
        device.save('appops-before.txt', device.shell(f'appops get {package} REQUEST_INSTALL_PACKAGES', check=False))

        # Stage 1: FROM is the newest Android build. Launching checks automatically; nothing is offered.
        mark = len(requests_since(state, 0))
        list_target = f'/repos/{args.repository}/releases?per_page=30'
        from_manifest = f"/{args.repository}/releases/download/{from_tag}/android-update.json"
        device.save('launch-1.txt', device.shell(f'am start -W -n {package}/{ACTIVITY}'))
        wait_for_request(state, mark, lambda r: r['target'] == list_target, 90, 'the releases list at launch')
        wait_for_request(state, mark, lambda r: r['target'] == from_manifest, 30, f'the {from_tag} manifest')
        time.sleep(5)
        assert device.find(texts=('Update available',), timeout=10, absent_ok=True) is None, 'no update may be offered'
        device.screenshot('launch-no-update')
        open_about(device, f"Orbit {old['versionName']} ({old['versionCode']})")
        device.screenshot('about-before')
        device.tap(device.find(texts=('Check for updates',)))
        device.find(texts=('Orbit is up to date.',), timeout=90)
        device.screenshot('about-up-to-date-before')
        stage1 = requests_since(state, mark)
        result['stage1Requests'] = stage1
        assert sum(r['target'] == list_target for r in stage1) == 2, 'one automatic and one manual list read'
        device.note('Stage 1: a newer macOS-only release, a draft and an android-v* release offered nothing')

        # Stage 2: TO published the same way; the manual check finds it and the app installs it in place.
        mark = len(requests_since(state, 0))
        result['toManifest'] = publish_android(releases, env, output / 'publish' / to_tag, to_tag, args.to_apk,
                                               args.to_identity, new)
        (output / 'releases-stage2.json').write_text((state / 'releases.json').read_text())
        device.tap(device.find(texts=('Check for updates',)))
        device.find(texts=(f"Orbit {new['versionName']} ({new['versionCode']}) is available.",), timeout=90)
        device.screenshot('about-update-found')
        device.tap(device.find(texts=('Download and install',)))
        node = device.find(texts=('Open settings', 'Waiting for Android to install the update…'), timeout=240)
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
            device.note(f"Allowed installs from the app and returned; pid {result['processAfterPermission']}")
        # Android's installer asks for confirmation. If Android restarted the app meanwhile, it offers the
        # same verified update again first.
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
                if owner == package and text in ('Update', 'Download and install'):
                    device.note('The app offered the verified update again')
                    device.screenshot('offered-again')
                    device.tap(node)
                    time.sleep(2)
                    break
            else:
                time.sleep(1)
        device.note('Confirmed in Android installer')
        deadline = time.time() + 180
        while device.package(package)[0]['versionCode'] != str(new['versionCode']):
            assert time.time() < deadline, 'The update did not install'
            time.sleep(2)
        updated, text = device.package(package)
        device.save('package-to.txt', text)
        result['installedTo'] = updated
        for key in ('appId', 'firstInstallTime', 'dataDir'):
            assert installed[key] == updated[key], f'{key} changed: not an in-place update'
        assert updated['versionName'] == new['versionName']
        device.note(f"Updated in place: {installed['versionCode']} -> {updated['versionCode']}")

        # TO is current: About shows it and finds nothing newer; sign-in and data survived.
        device.save('launch-2.txt', device.shell(f'am start -W -n {package}/{ACTIVITY}'))
        open_about(device, f"Orbit {new['versionName']} ({new['versionCode']})")
        device.tap(device.find(texts=('Check for updates',)))
        device.find(texts=('Orbit is up to date.',), timeout=90)
        device.screenshot('about-up-to-date-after')
        stage2 = requests_since(state, mark)
        result['stage2Requests'] = stage2
        to_apk_target = f"/{args.repository}/releases/download/{to_tag}/{result['toManifest']['apkName']}"
        assert [r['target'] for r in stage2 if r['userAgent'].startswith('Orbit-Android/')].count(to_apk_target) == 1
        result['verify'] = instrument(device, package, 'verify', new)

        everything = requests_since(state, 0)
        app_requests = [r for r in everything if r['userAgent'].startswith('Orbit-Android/')]
        assert not any('/releases/latest' in r['target'] for r in everything), 'releases/latest is never read'
        assert all(r['target'] == list_target or '/releases/download/' in r['target'] for r in app_requests)
        assert not any(r['target'].startswith(prefix) for r in app_requests for prefix in never), \
            'a draft or android-v* release was read'
        assert all(r['status'] == 200 for r in app_requests)
        result['appRequests'] = len(app_requests)
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
        try:
            if installed_package:
                device.save('uninstall.txt', device.adb('uninstall', installed_package, check=False)
                            + device.adb('uninstall', f'{installed_package}.test', check=False))
            if reversed_port:
                device.adb('reverse', '--remove', f'tcp:{reversed_port}', check=False)
            device.save('reverse-after.txt', device.adb('reverse', '--list', check=False))
            device.shell(f'rm -f {REMOTE_DUMP}', check=False)
        finally:
            if fake:
                fake.terminate()
                fake.wait(timeout=30)
            result['finished'] = utc()
            (output / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(f'PASS: {result["apks"]["from"]["versionName"]} -> {result["apks"]["to"]["versionName"]}; evidence {output}')


if __name__ == '__main__':
    sys.exit(main())
