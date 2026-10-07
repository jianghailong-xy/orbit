#!/usr/bin/env python3
"""GitHub release steps of android-release.yml: version/history checks, the update manifest and
published-asset checks. Reads only public release data and identity files; never signing material."""
import argparse
import datetime
import hashlib
import json
import os
import pathlib
import re
import shutil
import sys
import time
import urllib.error
import urllib.request

TAG_PREFIX = 'android-v'
MANIFEST = 'android-update.json'
VERSION = re.compile(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?')
APPLICATION_ID = re.compile(r'[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+')
HEX64 = re.compile(r'[0-9a-f]{64}')


def fail(message):
    print(f'::error::{message}', file=sys.stderr)
    sys.exit(1)


def request(url, token=None, accept='application/vnd.github+json', fresh=False):
    """GET with retries for server errors; `fresh` also waits out a 404 for something just published."""
    headers = {'Accept': accept, 'User-Agent': 'orbit-android-release', 'X-GitHub-Api-Version': '2022-11-28'}
    # Only api.github.com gets the token; release downloads redirect to storage hosts that must not see it.
    if token and url.startswith('https://api.github.com/'):
        headers['Authorization'] = f'Bearer {token}'
    attempts = 7 if fresh else 4
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60) as response:
                return response.read(), response.headers
        except urllib.error.HTTPError as error:
            if error.code not in (500, 502, 503, 504) and not (fresh and error.code == 404) or attempt == attempts - 1:
                raise
        except urllib.error.URLError:
            if attempt == attempts - 1:
                raise
        time.sleep(5 * (attempt + 1))


def releases(repository, token):
    url = f'https://api.github.com/repos/{repository}/releases?per_page=100'
    while url:
        body, headers = request(url, token)
        yield from json.loads(body)
        url = next((part.split(';')[0].strip(' <>') for part in (headers.get('Link') or '').split(',')
                    if 'rel="next"' in part), None)


def published_android_manifests(repository, token):
    """(release, manifest) for every published android-v* release; an unreadable manifest is an error."""
    for release in releases(repository, token):
        if release.get('draft') or not release.get('tag_name', '').startswith(TAG_PREFIX):
            continue
        asset = next((a for a in release.get('assets', []) if a.get('name') == MANIFEST), None)
        if asset is None:
            fail(f"{release['tag_name']} has no {MANIFEST}; cannot prove versionCode increases")
        try:
            manifest = json.loads(request(asset['browser_download_url'])[0])
            int(manifest['versionCode']), manifest['applicationId']
        except Exception as error:  # noqa: BLE001 - any unreadable history blocks a release
            fail(f"Cannot read {MANIFEST} of {release['tag_name']}: {error}")
        yield release, manifest


def check_history(repository, token, tag, application_id, version_code):
    newest = None
    for release, manifest in published_android_manifests(repository, token):
        if release['tag_name'] == tag:
            fail(f'A release for {tag} already exists')
        if manifest['applicationId'] == application_id and (newest is None or int(manifest['versionCode']) > newest[0]):
            newest = (int(manifest['versionCode']), release['tag_name'])
    if newest and version_code <= newest[0]:
        fail(f'versionCode {version_code} must be greater than {newest[0]} published as {newest[1]}')
    return newest


def validate(args):
    token = os.environ.get('GH_TOKEN')
    name, code_text, application_id = args.version_name, args.version_code, args.application_id
    if not application_id:
        fail('Set the android-internal environment variable ANDROID_APPLICATION_ID')
    if not (VERSION.fullmatch(name) and len(name) <= 32):
        fail(f'versionName {name!r} must be X.Y.Z[-suffix], at most 32 characters')
    if not re.fullmatch(r'[1-9][0-9]{0,9}', code_text) or int(code_text) > 2100000000:
        fail(f'versionCode {code_text!r} must be 1..2100000000')
    if args.tag != TAG_PREFIX + name:
        fail(f'Tag {args.tag} does not match versionName {name}: push {TAG_PREFIX}{name} for this commit')
    if not APPLICATION_ID.fullmatch(application_id):
        fail(f'Invalid application ID {application_id!r}')
    newest = check_history(args.repository, token, args.tag, application_id, int(code_text))
    previous = f'{newest[1]} (versionCode {newest[0]})' if newest else 'none'
    print(f'{args.tag}: {application_id} {name} versionCode {code_text}; previous release {previous}')
    if args.output:
        with open(args.output, 'a', encoding='utf-8') as output:
            output.write(f'version_name={name}\nversion_code={code_text}\n')


def sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def manifest(args):
    identity = json.loads(pathlib.Path(args.identity).read_text())
    name, code = identity['versionName'], int(identity['versionCode'])
    if args.tag != TAG_PREFIX + name:
        fail(f'Tag {args.tag} does not match the built versionName {name}')
    if identity.get('distributionSignature') is not True and not args.test_signature:
        fail('Only a distribution-signed APK can be published')
    actual = sha256(args.apk)
    if actual != identity['apkSha256'] or not HEX64.fullmatch(identity['certificateSha256']):
        fail('APK does not match its build identity')
    # Re-read the history right before publishing; tags pushed meanwhile cannot slip in a lower code.
    check_history(args.repository, os.environ.get('GH_TOKEN'), args.tag, identity['applicationId'], code)
    output = pathlib.Path(args.output)
    output.mkdir(parents=True, exist_ok=False)
    apk_name = f'orbit-android-{name}.apk'
    shutil.copyfile(args.apk, output / apk_name)
    (output / f'{apk_name}.sha256').write_text(f'{actual}  {apk_name}\n')
    notes = pathlib.Path(args.notes_file).read_text(encoding='utf-8').strip()[:4000]
    published = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')
    update = {
        'schemaVersion': 1,
        'applicationId': identity['applicationId'],
        'versionName': name,
        'versionCode': code,
        'minSdk': int(identity['minSdk']),
        'apkName': apk_name,
        'apkUrl': f'https://github.com/{args.repository}/releases/download/{args.tag}/{apk_name}',
        'apkSize': (output / apk_name).stat().st_size,
        'sha256': actual,
        'certSha256': identity['certificateSha256'],
        'sourceSha': identity['sourceSha'],
        'publishedAt': published,
        'notes': notes,
    }
    (output / MANIFEST).write_text(json.dumps(update, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    body = [notes, '', '| | |', '| --- | --- |']
    rows = [('Package', update['applicationId']), ('Version', f"{name} (versionCode {code})"),
            ('Android', f"10+ (minSdk {update['minSdk']})"), ('APK SHA-256', f"`{actual}`"),
            ('Signing certificate SHA-256', f"`{update['certSha256']}`"), ('Source', f"`{update['sourceSha']}`"),
            ('Built by', args.run_url)]
    body += [f'| {key} | {value} |' for key, value in rows]
    body += ['', f'Install `{apk_name}` on Android 10 or later and allow your browser or file manager to install '
             'unknown apps when Android asks. Installed builds check these releases for updates themselves.']
    if args.test_signature:
        body.insert(0, '**TEST SIGNATURE — NOT FOR DISTRIBUTION.** Temporary rehearsal release; it will be deleted.\n')
    (output / 'release-notes.md').write_text('\n'.join(body) + '\n', encoding='utf-8')
    print(json.dumps(update, indent=2, ensure_ascii=False))


def verify_published(args):
    token = os.environ.get('GH_TOKEN')
    local = pathlib.Path(args.dir)
    update = json.loads((local / MANIFEST).read_text())
    expected = {path.name: path for path in local.iterdir() if path.name != 'release-notes.md'}
    apk = local / update['apkName']
    if sha256(apk) != update['sha256'] or (local / f"{update['apkName']}.sha256").read_text().split()[0] != update['sha256']:
        fail('APK, .sha256 and android-update.json disagree')
    if args.tag != TAG_PREFIX + update['versionName'] or update['apkSize'] != apk.stat().st_size:
        fail('android-update.json does not describe this tag and APK')
    release = json.loads(request(f'https://api.github.com/repos/{args.repository}/releases/tags/{args.tag}', token, fresh=True)[0])
    if release['draft'] or not release['prerelease']:
        fail(f'{args.tag} must be a published pre-release')
    assets = {asset['name']: asset for asset in release['assets']}
    if set(assets) != set(expected):
        fail(f'Published assets {sorted(assets)} differ from {sorted(expected)}')
    lines = ['| Asset | Bytes | SHA-256 |', '| --- | --- | --- |']
    for name, path in sorted(expected.items()):
        downloaded, _ = request(assets[name]['browser_download_url'], fresh=True)
        digest = hashlib.sha256(downloaded).hexdigest()
        if digest != sha256(path) or assets[name]['size'] != path.stat().st_size:
            fail(f'{name} on GitHub differs from the verified file')
        lines.append(f'| {name} | {len(downloaded)} | `{digest}` |')
    if assets[update['apkName']]['browser_download_url'] != update['apkUrl']:
        fail('apkUrl does not resolve to the published APK asset')
    summary = '\n'.join([f"### {args.tag} — {release['html_url']}", ''] + lines) + '\n'
    print(summary)
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a', encoding='utf-8') as output:
            output.write(summary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    check = commands.add_parser('validate', help='tag, version and release-history checks before signing')
    check.add_argument('--tag', required=True)
    check.add_argument('--version-name', required=True)
    check.add_argument('--version-code', required=True)
    check.add_argument('--application-id', default='')
    check.add_argument('--repository', required=True)
    check.add_argument('--output')
    check.set_defaults(run=validate)
    write = commands.add_parser('manifest', help='write the APK, its .sha256, android-update.json and release notes')
    write.add_argument('--identity', required=True)
    write.add_argument('--apk', required=True)
    write.add_argument('--tag', required=True)
    write.add_argument('--repository', required=True)
    write.add_argument('--notes-file', required=True)
    write.add_argument('--run-url', required=True)
    write.add_argument('--output', required=True)
    write.add_argument('--test-signature', action='store_true', help='rehearsal only: label a test-signed APK')
    write.set_defaults(run=manifest)
    published = commands.add_parser('verify-published', help='compare the GitHub release with the verified files')
    published.add_argument('--repository', required=True)
    published.add_argument('--tag', required=True)
    published.add_argument('--dir', required=True)
    published.set_defaults(run=verify_published)
    args = parser.parse_args()
    args.run(args)


if __name__ == '__main__':
    main()
