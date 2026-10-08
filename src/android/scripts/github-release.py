#!/usr/bin/env python3
"""Android steps of release.yml: the tag/version/history check before signing, the update manifest and
the checks around attaching the APK to the v* release the macOS job created. Reads only public release
data and build identity files; never signing material.

GITHUB_API_URL and GITHUB_SERVER_URL (both set by GitHub Actions) name the GitHub it talks to; a local
rehearsal points them at a stand-in."""
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

TAG_PREFIX = 'v'
MANIFEST = 'android-update.json'
VERSION = re.compile(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?')
APPLICATION_ID = re.compile(r'[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+')
HEX64 = re.compile(r'[0-9a-f]{64}')
COMMIT = re.compile(r'[0-9a-f]{40}')
API = os.environ.get('GITHUB_API_URL', 'https://api.github.com').rstrip('/')
SERVER = os.environ.get('GITHUB_SERVER_URL', 'https://github.com').rstrip('/')


def fail(message):
    print(f'::error::{message}', file=sys.stderr)
    sys.exit(1)


def output(path, **values):
    """Step outputs for the workflow (GITHUB_OUTPUT); printed as well."""
    lines = ''.join(f'{key}={value}\n' for key, value in values.items())
    print(lines, end='')
    if path:
        with open(path, 'a', encoding='utf-8') as stream:
            stream.write(lines)


def request(url, token=None, accept='application/vnd.github+json', fresh=False):
    """GET with retries for server errors; `fresh` also waits out a 404 for something just published."""
    headers = {'Accept': accept, 'User-Agent': 'orbit-android-release', 'X-GitHub-Api-Version': '2022-11-28'}
    # Only the API gets the token; release downloads redirect to storage hosts that must not see it.
    if token and url.startswith(API + '/'):
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
    url = f'{API}/repos/{repository}/releases?per_page=100'
    while url:
        body, headers = request(url, token)
        yield from json.loads(body)
        url = next((part.split(';')[0].strip(' <>') for part in (headers.get('Link') or '').split(',')
                    if 'rel="next"' in part), None)


def published_manifests(repository, token):
    """(release, manifest) for every published v* release that carries Android; an unreadable one is an error.
    A v* release without the manifest is macOS/iOS only (every release before Android joined)."""
    for release in releases(repository, token):
        if release.get('draft') or not release.get('tag_name', '').startswith(TAG_PREFIX):
            continue
        asset = next((a for a in release.get('assets', []) if a.get('name') == MANIFEST), None)
        if asset is None:
            continue
        try:
            manifest = json.loads(request(asset['browser_download_url'])[0])
            int(manifest['versionCode']), manifest['applicationId'], manifest['sourceSha']
        except Exception as error:  # noqa: BLE001 - any unreadable history blocks a release
            fail(f"Cannot read {MANIFEST} of {release['tag_name']}: {error}")
        yield release, manifest


def check_history(repository, token, tag, application_id, version_code, source_sha):
    """('skip', tag) when this commit's Android build is already published, as when a second v* tag lands
    on one commit; otherwise ('publish', newest) with the newest published (versionCode, tag) of the package,
    which version_code must exceed."""
    newest = None
    for release, manifest in published_manifests(repository, token):
        same_package = manifest['applicationId'] == application_id
        if same_package and manifest['sourceSha'] == source_sha:
            return 'skip', release['tag_name']
        if release['tag_name'] == tag:
            fail(f"{tag} already carries {MANIFEST}, built from {manifest['sourceSha']}")
        if same_package and (newest is None or int(manifest['versionCode']) > newest[0]):
            newest = (int(manifest['versionCode']), release['tag_name'])
    if newest and version_code <= newest[0]:
        fail(f'versionCode {version_code} (the commit count) must be greater than {newest[0]}, '
             f'published with {newest[1]}')
    return 'publish', newest


def validate(args):
    token = os.environ.get('GH_TOKEN')
    tag, code_text, source, application_id = args.tag, args.version_code, args.source_sha, args.application_id
    if not tag.startswith(TAG_PREFIX):
        fail(f'{tag} is not a {TAG_PREFIX}* release tag')
    name = tag[len(TAG_PREFIX):]
    if not (VERSION.fullmatch(name) and len(name) <= 32):
        fail(f'versionName {name!r} (the tag without v) must be X.Y.Z[-suffix], at most 32 characters')
    if not re.fullmatch(r'[1-9][0-9]{0,9}', code_text) or int(code_text) > 2100000000:
        fail(f'versionCode {code_text!r} must be 1..2100000000')
    if not COMMIT.fullmatch(source):
        fail(f'{source!r} is not a full commit SHA')
    if not application_id:
        fail('Set the android-internal environment variable ANDROID_APPLICATION_ID')
    if not APPLICATION_ID.fullmatch(application_id):
        fail(f'Invalid application ID {application_id!r}')
    state, found = check_history(args.repository, token, tag, application_id, int(code_text), source)
    if state == 'skip':
        print(f'::notice::{source} was already published for Android with {found}; '
              f'{tag} skips the Android build and attachment')
        output(args.output, skip='true')
        return
    previous = f'{found[1]} (versionCode {found[0]})' if found else 'none'
    print(f'{tag}: {application_id} {name} versionCode {code_text} from {source}; previous Android release {previous}')
    output(args.output, skip='false', version_name=name, version_code=code_text)


def sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def release_by_tag(repository, tag, token, fresh=False):
    try:
        return json.loads(request(f'{API}/repos/{repository}/releases/tags/{tag}', token, fresh=fresh)[0])
    except urllib.error.HTTPError as error:
        if error.code == 404:
            fail(f'No published release {tag}: the macOS job creates it, and Android never does')
        raise


def asset_sha256(asset):
    digest = asset.get('digest') or ''
    if digest.startswith('sha256:'):
        return digest[len('sha256:'):]
    return hashlib.sha256(request(asset['browser_download_url'])[0]).hexdigest()


def manifest(args):
    token = os.environ.get('GH_TOKEN')
    identity = json.loads(pathlib.Path(args.identity).read_text())
    name, code, source = identity['versionName'], int(identity['versionCode']), identity['sourceSha']
    if args.tag != TAG_PREFIX + name:
        fail(f'Tag {args.tag} does not match the built versionName {name}')
    if identity.get('distributionSignature') is not True and not args.test_signature:
        fail('Only a distribution-signed APK can be published')
    actual = sha256(args.apk)
    if actual != identity['apkSha256'] or not HEX64.fullmatch(identity['certificateSha256']):
        fail('APK does not match its build identity')
    release = release_by_tag(args.repository, args.tag, token)
    if release.get('draft'):
        fail(f'{args.tag} is a draft; Android attaches only to the published release')
    attached = {asset['name']: asset for asset in release.get('assets', [])}
    if MANIFEST in attached:
        fail(f'{args.tag} already has {MANIFEST}; an Android release is never replaced')
    # Again right before attaching: another tag of this commit, or a newer build, may have been published meanwhile.
    state, found = check_history(args.repository, token, args.tag, identity['applicationId'], code, source)
    if state == 'skip':
        print(f'::notice::{source} was published for Android with {found} meanwhile; not attaching it to {args.tag}')
        output(args.github_output, skip='true')
        return
    out = pathlib.Path(args.output)
    out.mkdir(parents=True, exist_ok=False)
    apk_name = f'orbit-android-{name}.apk'
    shutil.copyfile(args.apk, out / apk_name)
    (out / f'{apk_name}.sha256').write_text(f'{actual}  {apk_name}\n')
    # The annotated tag's message (release.sh writes "Release vX"); a lightweight tag has none.
    notes = pathlib.Path(args.notes_file).read_text(encoding='utf-8').strip()[:4000] or f'Orbit {name} for Android.'
    published = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')
    update = {
        'schemaVersion': 1,
        'tag': args.tag,
        'applicationId': identity['applicationId'],
        'versionName': name,
        'versionCode': code,
        'minSdk': int(identity['minSdk']),
        'apkName': apk_name,
        'apkUrl': f'{SERVER}/{args.repository}/releases/download/{args.tag}/{apk_name}',
        'apkSize': (out / apk_name).stat().st_size,
        'sha256': actual,
        'certSha256': identity['certificateSha256'],
        'sourceSha': source,
        'publishedAt': published,
        'notes': notes,
    }
    (out / MANIFEST).write_text(json.dumps(update, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    # A file left by an earlier attempt of this job is reused only when it is byte for byte this one.
    pending = []
    for asset in (apk_name, f'{apk_name}.sha256'):
        if asset not in attached:
            pending.append(asset)
        elif asset_sha256(attached[asset]) != sha256(out / asset):
            fail(f'{args.tag} already has a different {asset}; it is never overwritten')
        else:
            print(f'{asset} is already attached to {args.tag} with the same SHA-256; not uploading it again')
    (out / 'pending-assets.txt').write_text(''.join(f'{asset}\n' for asset in pending))
    print(json.dumps(update, indent=2, ensure_ascii=False))
    output(args.github_output, skip='false')


def verify_published(args):
    token = os.environ.get('GH_TOKEN')
    local = pathlib.Path(args.dir)
    update = json.loads((local / MANIFEST).read_text())
    apk = local / update['apkName']
    expected = {path.name: path for path in (apk, local / f"{update['apkName']}.sha256", local / MANIFEST)}
    if sha256(apk) != update['sha256'] or (local / f"{update['apkName']}.sha256").read_text().split()[0] != update['sha256']:
        fail('APK, .sha256 and android-update.json disagree')
    if not (args.tag == update['tag'] == TAG_PREFIX + update['versionName']) or update['apkSize'] != apk.stat().st_size:
        fail('android-update.json does not describe this tag and APK')
    release = release_by_tag(args.repository, args.tag, token, fresh=True)
    if release.get('draft'):
        fail(f'{args.tag} must be published, not a draft')
    assets = {asset['name']: asset for asset in release.get('assets', [])}
    missing = sorted(set(expected) - set(assets))
    if missing:
        fail(f'{args.tag} is missing {missing}')
    lines = ['| Asset | Bytes | SHA-256 |', '| --- | --- | --- |']
    for name, path in sorted(expected.items()):
        downloaded, _ = request(assets[name]['browser_download_url'], fresh=True)
        digest = hashlib.sha256(downloaded).hexdigest()
        if digest != sha256(path) or assets[name]['size'] != path.stat().st_size:
            fail(f'{name} on GitHub differs from the verified file')
        lines.append(f'| {name} | {len(downloaded)} | `{digest}` |')
    if assets[update['apkName']]['browser_download_url'] != update['apkUrl']:
        fail('apkUrl does not resolve to the published APK asset')
    others = sorted(set(assets) - set(expected))
    summary = '\n'.join([f"### Android {update['versionName']} (versionCode {update['versionCode']}) on {release['html_url']}", '',
                         f"Package `{update['applicationId']}`, signing certificate SHA-256 `{update['certSha256']}`, "
                         f"source `{update['sourceSha']}`. Also on this release: {', '.join(others) or 'nothing else'}.",
                         ''] + lines) + '\n'
    print(summary)
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a', encoding='utf-8') as stream:
            stream.write(summary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    check = commands.add_parser('validate', help='tag, version and release-history checks before signing')
    check.add_argument('--tag', required=True)
    check.add_argument('--version-code', required=True, help='git rev-list --count HEAD')
    check.add_argument('--source-sha', required=True, help='the tagged commit')
    check.add_argument('--application-id', default='')
    check.add_argument('--repository', required=True)
    check.add_argument('--output', help='GITHUB_OUTPUT')
    check.set_defaults(run=validate)
    write = commands.add_parser('manifest', help='write the APK, its .sha256 and android-update.json; list what to upload')
    write.add_argument('--identity', required=True)
    write.add_argument('--apk', required=True)
    write.add_argument('--tag', required=True)
    write.add_argument('--repository', required=True)
    write.add_argument('--notes-file', required=True)
    write.add_argument('--output', required=True)
    write.add_argument('--github-output', help='GITHUB_OUTPUT')
    write.add_argument('--test-signature', action='store_true', help='rehearsal only: accept a test-signed APK')
    write.set_defaults(run=manifest)
    published = commands.add_parser('verify-published', help='compare the release assets with the verified files')
    published.add_argument('--repository', required=True)
    published.add_argument('--tag', required=True)
    published.add_argument('--dir', required=True)
    published.set_defaults(run=verify_published)
    args = parser.parse_args()
    args.run(args)


if __name__ == '__main__':
    main()
