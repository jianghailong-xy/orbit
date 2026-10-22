#!/usr/bin/env python3
"""A restored volume put back under an account's runner on the lab's real k3s, in one run (task T08b).

docs/managed-runner-lab.md, "A restored volume back under its runner (T08b)", and the runbook's procedure,
docs/managed-runner-kubernetes-operations.md, "Put a restored volume back under its runner". One command runs
every phase in order and stops at the first check that fails; each step's result and wall-clock time are
written to OUT. It is acceptance-lab.py (T08) for one account, whose helpers it uses:

  facts     versions, topology and resource limits of the host, k3s, Ceph, Ceph-CSI and the image
  setup     the gate, the lab CA and webhook token, the administrator signed up with the switch unset
  on        the profile, the apiserver with the switch on, the admission guard
  account   ann signs in: provisioned on her claim, READY on a fake-model key; a first session with an
            attachment and a file the engine commits in its worktree
  backup    data on the volume (random bytes, SQLite rows in WAL mode, a Git commit) while a turn keeps the
            runner up; ann disabled and asleep; her RBD image exported out of the VM and checked there
  loss      the claim, its PV and its RBD image deleted; ann enabled, a message: the wake fails PVC_MISSING
  restore   the runbook's restore into a new claim under the runner's name, read back byte for byte; the
            admission guard keeps a check Pod off it; the manager adopts nothing
  switch    a member refused, another UID and a stale revision refused, then the administrator's switch:
            answered with the new identity, recorded in one audit row
  wake      the waiting message wakes ann on the restored claim: the same runner, the next generation, a Pod
            admitted for the new claim; the data, SQLite integrity_check, uploads, worktree, transcripts and the
            engine's session as backed up
  final     consistency, one Pod per volume over the whole timeline, Ceph; ann asleep, the window closed

  switch-lab.py run --out DIR [--from PHASE] [--to PHASE]
  switch-lab.py record-loop SECONDS        the recorder unit's loop (started by the run)
  switch-lab.py report OUT                 the steps' times and checks

LAB_TEST_SERVER_DIR must name test-server-t08b (or test-server-t08b-dev for trials): earlier tasks' databases stay
untouched. Every record is JSON and never holds a credential: owners' tokens and passwords, runner credentials, the
fake model key and the manager's token stay in files of mode 0600 under the server directory, in the lab's Secrets
and in the test server's provider store. Sessions run on fake-model.py as a DeepSeek-preset key, which is not a model.
"""

import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import time
import traceback
import uuid

LAB = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('lab_acceptance', LAB / 'acceptance-lab.py')
al = importlib.util.module_from_spec(spec)
spec.loader.exec_module(al)
wl, ml, sw = al.wl, al.ml, al.sw

SERVER, NAMESPACE, ENV, LAB_DIR = sw.SERVER, sw.NAMESPACE, sw.ENV, sw.LAB_DIR
OWN_SERVER_DIRS = ('test-server-t08b', 'test-server-t08b-dev')
# acceptance-lab.py's helpers with this task's directory, accounts and probe.
al.OWN_SERVER_DIRS = al.OWN_SERVER_DIRS + OWN_SERVER_DIRS
wl.OWN_SERVER_DIRS = wl.OWN_SERVER_DIRS + OWN_SERVER_DIRS
wl.EMAIL = ml.EMAIL = 't08b-{}@lab.invalid'
wl.NAME_RE = re.compile(r't08b-([a-z0-9]+)@lab\.invalid')
al.CONTEXT = SERVER / 't08b-context.json'
RECORDER_UNIT = 'orbit-mr-lab-t08b-recorder'
OWNER = 'ann'
REASON = 'T08b lab: the volume was lost; restored from the independent backup'
SWITCHED = 'managed_runner.volume_switched'
Failed, Step, capture, k, kget, mapping, until, identity, now = al.Failed, al.Step, al.capture, al.k, al.kget, al.mapping, al.until, al.identity, al.now


def require_own_server_dir():
    if SERVER.name not in OWN_SERVER_DIRS:
        raise SystemExit(f'LAB_TEST_SERVER_DIR must be {LAB_DIR}/test-server-t08b (or test-server-t08b-dev), not {SERVER}')


def restore_claim_manifest(namespace, pvc_name, owner_id, runner_id, storage_class, capacity):
    """The runbook's restored claim: under the runner's own name, with the marks the manager puts on the claims it makes
    (deploy/managed-runner/storage/pvc.template.json) and checks on every pass."""
    return {'apiVersion': 'v1', 'kind': 'PersistentVolumeClaim',
            'metadata': {'name': pvc_name, 'namespace': namespace, 'annotations': {'orbit.dev/owner-id': owner_id, 'orbit.dev/runner-id': runner_id}},
            'spec': {'storageClassName': storage_class, 'accessModes': ['ReadWriteOnce'], 'volumeMode': 'Filesystem',
                     'resources': {'requests': {'storage': capacity}}}}


def switch_path(runner_id):
    return f'/admin/managed-runners/{runner_id}/volume-switch'


def admin_token():
    return al.token('root')


# ---- setup and the switch ---------------------------------------------------------------------------------

def setup_admin(ctx, step):
    started = al.start_server('unset')
    step.check('the switch is unset while the administrator signs up', al.switch_lines() == [], al.switch_lines())
    root = al.account('root')
    step.check('root is the bootstrapped administrator', bool(ml.owner_state('root').get('admin')), root.get('admin'))
    rows = al.managed_rows()
    step.check('no managed runner row: the administrator has no mapping', not rows, len(rows))
    return {'server': started, 'root': root}


def on_start(ctx, step):
    al.stop_api_units()
    lines = al.server('start', '--managed')
    step.check('the switch is on with the lab profile', al.switch_lines() == ['ORBIT_MANAGED_RUNNERS_ENABLED=true', f'ORBIT_MANAGED_RUNNERS_PROFILE={sw.PROFILE}'],
               al.switch_lines())
    recorder = record('start')
    return {'testServer': lines[-7:], 'switch': al.switch_lines(), 'recorder': recorder}


def on_admission(ctx, step):
    install = capture(sw.cmd_admission, action='install')
    step.check('the admission webhook is installed and refuses a Pod on an unowned managed claim',
               install['webhook'] and install['dryRunUnownedManagedClaim']['exit'] != 0 and install['dryRunUnmanagedPod']['exit'] == 0,
               {key: install[key]['answer'][:160] for key in ('dryRunUnmanagedPod', 'dryRunUnownedManagedClaim')})
    return {'install': install}


# ---- the account and its data -------------------------------------------------------------------------------

def account_ready(ctx, step):
    since = now()
    signed = al.account(OWNER)
    starting = until(OWNER, 'STARTING', reason='MODEL_UNAVAILABLE', timeout=300)
    key = capture(wl.cmd_key, name=OWNER)
    ready = until(OWNER, 'READY', timeout=420)
    ctx.setdefault('identity', {})[OWNER] = identity(OWNER)
    ctx['firstSignInAt'] = since
    view = ml.verdict()
    step.check('the database and k3s agree', not view['problems'], view['problems'])
    return {'signIn': signed, 'starting': starting, 'key': key, 'ready': ready, 'identity': ctx['identity'][OWNER], 'times': al.provisioned(OWNER)}


def first_session(ctx, step):
    result = al.first_session(ctx, OWNER)
    ctx.setdefault('sessions', {})[OWNER] = {'s1': result['session'], 's1Uuid': result['sessionUuid'], 'attachment': result['attachment'],
                                            'wrote': result['wrote'], 'secret': result['secret']}
    step.check('the session ran on ann\'s managed runner', result['event']['session']['assigned_runner_id'] == ctx['identity'][OWNER]['runnerId'],
               result['event']['session']['assigned_runner_id'])
    step.check('the engine committed a file in the session\'s Git worktree', bool(result['wrote']['commit']), result['wrote'])
    return result


def backup_export(ctx, step):
    """acceptance-lab.py's export, into this task's backup directory: the RBD image out of the VM, onto the host's /mnt/data."""
    ident = ctx['backup']['identity']
    stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
    image = f"{ident['pool']}/{ident['rbdImage']}"
    destination = al.BACKUPS / f't08b-{stamp}'
    destination.mkdir(mode=0o700, parents=True)
    os.chmod(al.BACKUPS, 0o700)
    info_before = json.loads(al.ceph_shell(f'rbd info --format json {shlex.quote(image)}'))
    status_before = json.loads(al.ceph_shell(f'rbd status --format json {shlex.quote(image)}'))
    step.check('the image has no watcher: nothing maps it', not status_before.get('watchers'), status_before.get('watchers'))
    al.guest(f'sudo install -d -m 0700 {al.GUEST_BACKUP}')
    started = time.monotonic()
    exported = al.ceph_shell(f'set -o pipefail; rbd export --no-progress {shlex.quote(image)} - | tee >(sha256sum > /work/raw.sha256) | gzip -1 > /work/volume.img.gz '
                             f'&& sleep 1 && cat /work/raw.sha256 && sha256sum /work/volume.img.gz && stat -c %s /work/volume.img.gz', mount=al.GUEST_BACKUP)
    export_seconds = round(time.monotonic() - started, 1)
    sums = re.findall(r'^([0-9a-f]{64})\s+(\S+)$', exported, re.M)
    raw_sha = next(s for s, f in sums if f == '-')
    gz_sha = next(s for s, f in sums if f.endswith('volume.img.gz'))
    started = time.monotonic()
    al.guest_to_file(f'sudo cat {al.GUEST_BACKUP}/volume.img.gz', destination / 'volume.img.gz')
    copy_seconds = round(time.monotonic() - started, 1)
    host_gz = al.sha256_file(destination / 'volume.img.gz')
    al.guest(f'sudo rm -f {al.GUEST_BACKUP}/volume.img.gz {al.GUEST_BACKUP}/raw.sha256 && sudo rmdir {al.GUEST_BACKUP}')
    os.chmod(destination / 'volume.img.gz', 0o600)
    manifest = {'schemaVersion': 1, 'kind': 'orbit-managed-runner-rbd-export', 'createdAt': now(), 'source': {
        'owner': ml.owner_state(OWNER)['user']['id'], 'runnerId': ident['runnerId'], 'namespace': NAMESPACE, 'pvc': {'name': ident['pvcName'], 'uid': ident['pvcUid']},
        'pv': {'name': ident['pvName'], 'uid': ident['pvUid']}, 'volumeHandle': ident['volumeHandle'], 'clusterID': ident['clusterID'],
        'pool': ident['pool'], 'image': ident['rbdImage'], 'imageId': info_before.get('id'), 'sizeBytes': info_before.get('size'),
        'features': info_before.get('features'), 'generationAtBackup': ident['generation']},
        'quiescence': {'mappingState': mapping(OWNER)['management_state'], 'accountDisabled': True, 'watchers': status_before.get('watchers')},
        'file': 'volume.img.gz', 'format': 'rbd export (raw image), gzip -1', 'rawSha256': raw_sha, 'gzipSha256': gz_sha,
        'gzipBytes': (destination / 'volume.img.gz').stat().st_size}
    sw.private_write(destination / 'manifest.json', manifest)
    step.check('the archive arrived on the host intact', host_gz == gz_sha, {'guest': gz_sha[:16], 'host': host_gz[:16]})
    step.check('the backup is outside the VM, on the host\'s /mnt/data', str(destination).startswith('/mnt/data/'), str(destination))
    ctx['backup'].update(dir=str(destination), rawSha256=raw_sha, gzipSha256=gz_sha, stamp=stamp, originalImageId=info_before.get('id'),
                         sizeBytes=info_before.get('size'))
    return {'destination': str(destination), 'manifest': manifest, 'exportSeconds': export_seconds, 'copySeconds': copy_seconds,
            'rbdInfo': info_before, 'rbdStatus': status_before}


# ---- the loss ---------------------------------------------------------------------------------------------------

def lose_volume(ctx, step):
    ident = ctx['backup']['identity']
    step.check('ann is asleep: nothing uses the volume', mapping(OWNER)['management_state'] == 'SLEEPING')
    storage = al.storage_view(OWNER)
    step.check('no Pod, attachment or RBD watcher', not storage['objects']['podsUsingTheClaim'] and not storage['objects']['volumeAttachments']
               and al.watchers(storage) == [], {'pods': storage['objects']['podsUsingTheClaim'], 'attachments': storage['objects']['volumeAttachments']})
    started = time.monotonic()
    k('delete', 'pvc', ident['pvcName'], '--wait=true')
    released = kget('pv', ident['pvName'], namespace=None)
    # Retain kept the PV and its image: the loss takes both, so the backup is all that is left of the data.
    k('delete', 'pv', ident['pvName'], '--wait=true', namespace=None)
    removed = al.ceph_shell(f"rbd rm --no-progress {shlex.quote(ident['pool'])}/{shlex.quote(ident['rbdImage'])} && rbd ls {shlex.quote(ident['pool'])}")
    left = removed.split()
    step.check('the claim is gone', kget('pvc', ident['pvcName']) is None)
    step.check('its PV is gone (it was Released, kept by Retain)', kget('pv', ident['pvName'], namespace=None) is None,
               ((released or {}).get('status') or {}).get('phase'))
    step.check('its RBD image is gone', ident['rbdImage'] not in left, ident['rbdImage'])
    ctx['loss'] = {'at': now(), 'pvPhaseBeforeItsDeletion': ((released or {}).get('status') or {}).get('phase')}
    return {'seconds': round(time.monotonic() - started, 1), 'pvBeforeItsDeletion': {'phase': ctx['loss']['pvPhaseBeforeItsDeletion'],
                                                                                     'reclaimPolicy': ((released or {}).get('spec') or {}).get('persistentVolumeReclaimPolicy')},
            'imagesLeftInThePool': len(left)}


def failed_wake(ctx, step):
    enabled = capture(wl.cmd_disable, name=OWNER, action='off')
    signed = al.account(OWNER)
    at = now()
    turn = wl.new_turn(OWNER, ctx['sessions'][OWNER]['s1'], 'T08-ANN-RESTORED a message to a runner whose volume is lost')
    step.check('the message is accepted', turn['status'] in (200, 201), turn['status'])
    failed = until(OWNER, 'FAILED', reason='PVC_MISSING', timeout=300)
    m = mapping(OWNER)
    status = ml.status_of(OWNER)
    step.check('the wake fails PVC_MISSING, not retryable', (m['last_error'] or {}).get('code') == 'PVC_MISSING' and not (m['last_error'] or {}).get('retryable'),
               m['last_error'])
    step.check('no empty claim in its place', kget('pvc', m['pvc_name']) is None)
    step.check('the mapping still records the lost volume', m['pvc_uid'] == ctx['backup']['identity']['pvcUid'], m['pvc_uid'])
    pending = wl.sql_json(f"select status from conversation_turn where session_id = {wl.quote(ctx['sessions'][OWNER]['s1Uuid'])} order by created_at desc limit 1")
    step.check('the message waits for the runner', pending and pending[0]['status'] == 'PENDING', pending)
    ctx['lost'] = {'turnAt': at, 'turn': turn}
    return {'enabled': enabled, 'signIn': signed.get('signIn'), 'turn': turn, 'until': failed, 'reason': m['last_error'],
            'status': {key: status.get(key) for key in ('managementState', 'reason', 'actions')}, 'display': ml.display_of(status)}


# ---- the restore ---------------------------------------------------------------------------------------------

def restore_under_name(ctx, step):
    ident = ctx['backup']['identity']
    m = mapping(OWNER)
    pool = ident['pool']
    destination = Path(ctx['backup']['dir'])
    scratch = f"t08b-restore-scratch-{ctx['backup']['stamp'].lower()}"
    started = time.monotonic()
    manifest = restore_claim_manifest(NAMESPACE, m['pvc_name'], m['owner_id'], m['runner_id'], ENV['LAB_STORAGE_CLASS'],
                                      ctx['profile']['storage']['capacity'])
    k('create', '-f', '-', input=json.dumps(manifest))
    deadline = time.monotonic() + 120
    while (kget('pvc', m['pvc_name']) or {}).get('status', {}).get('phase') != 'Bound':
        if time.monotonic() > deadline:
            raise Failed(f"the restored claim {m['pvc_name']} was not Bound within 120 s")
        time.sleep(2)
    bound = kget('pvc', m['pvc_name'])
    pv = kget('pv', bound['spec']['volumeName'], namespace=None)
    target = pv['spec']['csi']['volumeAttributes']['imageName']
    step.check('a new claim under the runner\'s name, with a new PV and RBD image',
               bound['metadata']['uid'] != ident['pvcUid'] and pv['metadata']['uid'] != ident['pvUid'] and target != ident['rbdImage'],
               {'claim': bound['metadata']['uid'], 'pv': pv['metadata']['name'], 'image': target})
    al.guest(f'sudo install -d -m 0700 {al.GUEST_RESTORE}')
    al.file_to_guest(destination / 'volume.img.gz', f'sudo sh -c "cat > {al.GUEST_RESTORE}/volume.img.gz"')
    written = al.ceph_shell(f'set -o pipefail; sha256sum /work/volume.img.gz && gzip -dc /work/volume.img.gz | tee >(sha256sum > /work/raw.sha256) | '
                            f'rbd import --no-progress --image-feature layering - {pool}/{scratch} && sleep 1 && cat /work/raw.sha256 && '
                            f'rbd export-diff --no-progress {pool}/{scratch} - | rbd import-diff --no-progress - {pool}/{target} && '
                            f'rbd rm --no-progress {pool}/{scratch} && rbd export --no-progress {pool}/{target} - | sha256sum && '
                            f'rbd info --format json {pool}/{target}', mount=al.GUEST_RESTORE)
    write_seconds = round(time.monotonic() - started, 1)
    al.guest(f'sudo rm -f {al.GUEST_RESTORE}/volume.img.gz {al.GUEST_RESTORE}/raw.sha256 && sudo rmdir {al.GUEST_RESTORE}')
    sums = re.findall(r'^([0-9a-f]{64})\s+(\S+)$', written, re.M)
    info = json.loads(written[written.index('{'):])
    step.check('the archive reached the guest intact', sums[0] == (ctx['backup']['gzipSha256'], '/work/volume.img.gz'), sums[:1])
    step.check('the bytes imported are the exported image (SHA-256)', sums[1][0] == ctx['backup']['rawSha256'], sums[1][0][:16])
    step.check('the new image reads back byte for byte as the backup (SHA-256 of all of it)', sums[2][0] == ctx['backup']['rawSha256'], sums[2][0][:16])
    step.check('the scratch image is gone', scratch not in al.ceph_shell(f'rbd ls {pool}').split())
    # The admission guard keeps every Pod off a claim under a managed name but the runner's own reserved one.
    # T08's check Pod (restricted: no Pod Security refusal comes first), now on the claim under the runner's name.
    check_pod = {'apiVersion': 'v1', 'kind': 'Pod', 'metadata': {'name': 't08b-restore-check', 'namespace': NAMESPACE, 'labels': {'orbit.dev/lab': 't08b'}},
                 'spec': {'restartPolicy': 'Never', 'automountServiceAccountToken': False, 'enableServiceLinks': False,
                          'securityContext': {'runAsUser': 10001, 'runAsGroup': 10001, 'runAsNonRoot': True, 'seccompProfile': {'type': 'RuntimeDefault'}},
                          'containers': [{'name': 'check', 'image': al.IMAGE, 'command': ['python3', '-c', 'print(1)'], 'env': [{'name': 'HOME', 'value': '/tmp'}],
                                          'securityContext': {'allowPrivilegeEscalation': False, 'readOnlyRootFilesystem': True, 'capabilities': {'drop': ['ALL']}},
                                          'resources': {'requests': {'cpu': '100m', 'memory': '128Mi'}, 'limits': {'cpu': '1', 'memory': '512Mi'}},
                                          'volumeMounts': [{'name': 'data', 'mountPath': '/var/lib/orbit'}]}],
                          'volumes': [{'name': 'data', 'persistentVolumeClaim': {'claimName': m['pvc_name']}}]}}
    refused = k('create', '-f', '-', input=json.dumps(check_pod), check=False)
    step.check('the admission guard refuses a check Pod on the restored claim', refused.returncode != 0 and 'orbit-managed-runner-admission' in refused.stderr,
               refused.stderr.strip()[-240:])
    step.check('no such Pod exists', kget('pod', 't08b-restore-check') is None)
    # The manager looks at the failed runner on every pass: the claim under its name is not the recorded one, so nothing
    # is adopted; the operator's detail says what it found.
    deadline = time.monotonic() + 120
    while 'not the recorded one' not in ((mapping(OWNER)['last_error'] or {}).get('detail') or ''):
        if time.monotonic() > deadline:
            raise Failed(f"the manager did not look at the restored claim within 120 s: {mapping(OWNER)['last_error']}")
        time.sleep(2)
    after = mapping(OWNER)
    step.check('the manager adopts nothing: still PVC_MISSING, the lost volume recorded',
               (after['last_error'] or {}).get('code') == 'PVC_MISSING' and after['pvc_uid'] == ident['pvcUid'], after['last_error'])
    ctx['restore'] = {'pvcUid': bound['metadata']['uid'], 'pvName': pv['metadata']['name'], 'pvUid': pv['metadata']['uid'],
                      'volumeHandle': pv['spec']['csi']['volumeHandle'], 'image': target}
    return {'manifest': manifest, 'claim': {key: bound['metadata'].get(key) for key in ('name', 'uid', 'creationTimestamp', 'annotations')},
            'pv': {'name': pv['metadata']['name'], 'uid': pv['metadata']['uid'], 'creationTimestamp': pv['metadata']['creationTimestamp'],
                   'volumeHandle': pv['spec']['csi']['volumeHandle'], 'reclaimPolicy': pv['spec'].get('persistentVolumeReclaimPolicy')},
            'image': target, 'scratchImage': scratch, 'writeSeconds': write_seconds, 'rbdInfo': info,
            'sha256': {'archive': sums[0][0], 'imported': sums[1][0], 'readBack': sums[2][0]},
            'checkPodRefusal': refused.stderr.strip()[-400:], 'managerDetail': (after['last_error'] or {}).get('detail'),
            'restoreSeconds': round(time.monotonic() - started, 1)}


# ---- the switch ----------------------------------------------------------------------------------------------

def switch(ctx, step):
    m = mapping(OWNER)
    restored = ctx['restore']
    path = switch_path(m['runner_id'])
    body = lambda **change: {'idempotencyKey': str(uuid.uuid4()), 'revision': m['revision'], 'volumeUid': restored['pvcUid'], 'reason': REASON, **change}
    busy = []

    def ask(request, token):
        # MAPPING_BUSY says a manager pass is on the runner right now (the failed runner is looked at every poll): asked again.
        for _ in range(40):
            status, answer = ml.http('POST', path, request, token=token)
            if not (status == 409 and isinstance(answer, dict) and answer.get('check') == 'MAPPING_BUSY'):
                return status, answer
            busy.append(now())
            time.sleep(0.5)
        return status, answer
    refusals = {}
    status, answer = ml.http('POST', path, body(), token=al.token(OWNER))
    refusals['member'] = {'status': status, 'answer': answer}
    step.check('a member is refused 403', status == 403, status)
    status, answer = ask(body(volumeUid=str(uuid.uuid4())), admin_token())
    refusals['anotherUid'] = {'status': status, 'answer': answer}
    step.check('another UID than the one verified is refused, VOLUME_NOT_VERIFIED', status == 409 and answer.get('check') == 'VOLUME_NOT_VERIFIED', answer)
    status, answer = ask(body(revision=m['revision'] - 1), admin_token())
    refusals['staleRevision'] = {'status': status, 'answer': answer}
    step.check('a stale revision is refused with the current one', status == 409 and answer.get('code') == 'MANAGED_RUNNER_REVISION_CONFLICT'
               and answer.get('revision') == m['revision'], answer)
    unchanged = mapping(OWNER)
    step.check('nothing switched by the refusals', {key: unchanged[key] for key in ('revision', 'pvc_uid', 'pv_uid', 'volume_handle', 'management_state')}
               == {key: m[key] for key in ('revision', 'pvc_uid', 'pv_uid', 'volume_handle', 'management_state')})
    step.check('no audit row yet', not wl.sql_json(f"select id from activity where type = {wl.quote(SWITCHED)}"))
    at = now()
    request = body(revision=mapping(OWNER)['revision'])
    status, answer = ask(request, admin_token())
    step.check('the administrator\'s switch is answered 200', status == 200, {'status': status, 'answer': answer})
    ident = ctx['backup']['identity']
    step.check('answered with the new identity, asleep, the waiting demand kept', answer.get('managementState') == 'SLEEPING'
               and answer.get('desiredState') == 'RUNNING' and (answer.get('to') or {}).get('pvcUid') == restored['pvcUid']
               and (answer.get('to') or {}).get('volumeHandle') == restored['volumeHandle'] and (answer.get('from') or {}).get('pvcUid') == ident['pvcUid'],
               answer)
    audit = wl.sql_json(f"select actor_id, type, credential_kind, created_at, payload from activity where type = {wl.quote(SWITCHED)} order by created_at")
    root_uuid = wl.to_uuid(ml.owner_state('root')['user']['id'])
    step.check('one audit row: the administrator, when, from which volume to which', len(audit) == 1 and audit[0]['actor_id'] == root_uuid
               and audit[0]['payload']['from']['pvcUid'] == ident['pvcUid'] and audit[0]['payload']['to']['pvcUid'] == restored['pvcUid']
               and audit[0]['payload']['mappingId'] == m['id'], audit)
    replay = ml.http('POST', path, request, token=admin_token())  # at once, while the wake it kicked runs: not asked again
    step.check('the same request again is answered as it stands, with no second audit row', replay[0] == 200 and (replay[1] or {}).get('replayed') is True
               and len(wl.sql_json(f"select id from activity where type = {wl.quote(SWITCHED)}")) == 1, replay)
    ctx['switch'] = {'at': at, 'answer': answer}
    return {'refusals': refusals, 'at': at, 'request': {key: request[key] for key in ('revision', 'volumeUid', 'reason')}, 'answer': answer, 'audit': audit,
            'replay': replay[1], 'mappingBusyAnswers': busy}


# ---- the wake on the restored claim ---------------------------------------------------------------------------

def wake_on_restored(ctx, step):
    before = ctx['backup']['identity']
    restored = ctx['restore']
    found = al.answered(al.owner_uuid(OWNER), 'T08-ANN-RESTORED', timeout=420, after=ctx['lost']['turnAt'])
    ready = until(OWNER, 'READY', timeout=180)
    after = identity(OWNER)
    step.check('the same runner and workspace, on the restored claim, PV, volume handle and RBD image',
               after['runnerId'] == before['runnerId'] and after['workspaceId'] == before['workspaceId'] and after['pvcName'] == before['pvcName']
               and after['pvcUid'] == restored['pvcUid'] and after['pvUid'] == restored['pvUid'] and after['volumeHandle'] == restored['volumeHandle']
               and after['rbdImage'] == restored['image'], {'before': before, 'after': after})
    # Asleep, the mapping already names the next generation; the volume names the last one that ran on it.
    ran = (ctx['backup']['snapshot'].get('managedInstance') or {}).get('generation')
    step.check('the generation the switch left reserved, later than the last one that ran on the backed-up volume',
               after['generation'] == ctx['switch']['answer']['generation'] and isinstance(ran, int) and after['generation'] > ran,
               {'ranOnTheBackedUpVolume': ran, 'reserved': ctx['switch']['answer']['generation'], 'woken': after['generation']})
    pod = kget('pod', f"mr-{after['runnerId']}")
    claims = [v['persistentVolumeClaim']['claimName'] for v in pod['spec']['volumes'] if v.get('persistentVolumeClaim')]
    step.check('its Pod is the runner\'s fixed one, admitted for the restored claim\'s UID', pod['metadata']['uid'] == after['podUid']
               and pod['metadata']['annotations'].get('orbit.dev/pvc-uid') == restored['pvcUid'] and claims == [after['pvcName']],
               {'pvcUid': pod['metadata']['annotations'].get('orbit.dev/pvc-uid'), 'claims': claims})
    step.check('the waiting message was answered on the runner\'s instance', found['event']['ingested_by_runner_id'] == after['runnerId'], found['event'])
    al.continuation_check(step, OWNER, found, ctx['sessions'][OWNER]['secret'], 'on the restored volume')
    probe = capture(wl.cmd_probe, name=OWNER, action='check', run=ctx['backup']['probeRun'])
    step.check('the probe written before the backup: the same random bytes, SQLite rows and Git commit, integrity_check ok', probe['allSame'], probe['same'])
    snap = al.pod_snapshot(OWNER, al.transcript_prefix(ctx['backup']['snapshot']))
    al.compare_snapshots(step, OWNER, ctx['backup']['snapshot'], snap, 'on the restored volume', ctx['sessions'][OWNER]['s1Uuid'])
    step.check('the volume is an RBD device, ext4', snap['mount'] and snap['mount'][0]['source'].startswith('/dev/rbd') and snap['mount'][0]['fstype'] == 'ext4',
               snap['mount'])
    step.check('the image\'s entrypoint took the restored volume for this instance', (snap['managedInstance'] or {}).get('generation') == after['generation']
               and (snap['managedInstance'] or {}).get('podUid') == after['podUid'], snap['managedInstance'])
    return {'answered': found, 'answeredAfterSwitchSeconds': al.seconds_between(ctx['switch']['at'], found['event']['ingested_at']),
            'ready': ready, 'identityBefore': before, 'identityAfter': after, 'times': al.provisioned(OWNER), 'probe': probe, 'snapshot': snap}


# ---- final -----------------------------------------------------------------------------------------------------

def final_checks(ctx, step):
    view = ml.verdict()
    step.check('the database and k3s agree', not view['problems'], view['problems'])
    timeline = [json.loads(line) for line in (SERVER / 'timeline.jsonl').read_text().splitlines() if line.startswith('{')]
    claim = ctx['identity'][OWNER]['pvcName']
    most = max((len((line.get('podsByClaim') or {}).get(claim, [])) for line in timeline), default=0)
    step.check('never more than one Pod on the runner\'s volume name in the whole timeline', most <= 1, most)
    ceph = sw.ceph('ceph -s -f json', f"rbd ls {ENV['LAB_POOL']}")
    status = json.loads(ceph[0])
    images = ceph[1].split()
    step.check('Ceph is HEALTH_OK at the end', status['health']['status'] == 'HEALTH_OK', status['health']['status'])
    step.check('the lost image stays gone; the restored one is there', ctx['backup']['identity']['rbdImage'] not in images and ctx['restore']['image'] in images)
    asleep = al.ensure_asleep(OWNER)
    storage = al.storage_view(OWNER)
    step.check('ann asleep at the end, the restored claim kept', mapping(OWNER)['management_state'] == 'SLEEPING'
               and storage['objects']['pvc']['uid'] == ctx['restore']['pvcUid'], storage['objects']['pvc'])
    return {'verdict': view, 'mostPodsOnTheVolume': most, 'timelineLines': len(timeline), 'ceph': {'health': status['health'], 'images': len(images)},
            'asleep': asleep, 'storage': storage, 'gate': al.gate_summary(ctx['firstSignInAt']), 'pool': wl.sql_json('select * from managed_runner_capacity')}


def teardown(ctx, step):
    results = {'recorder': record('stop'), 'admission': capture(sw.cmd_admission, action='remove')}
    results['server'] = al.server('stop')
    results['gate'] = capture(ml.cmd_gate, action='stop', since=None)
    step.check('the webhook is removed', sw.webhook_view() is None)
    return results


# ---- the recorder ---------------------------------------------------------------------------------------------

def record(action):
    log = SERVER / 'timeline.jsonl'
    if action == 'start':
        if ml.active(RECORDER_UNIT) != 'active':
            al.run(['systemd-run', f'--unit={RECORDER_UNIT}', '--collect', '--quiet', '-p', 'MemoryMax=256M',
                    '-p', f'Environment=LAB_TEST_SERVER_DIR={SERVER}', '-p', f'StandardOutput=append:{log}', '-p', f'StandardError=append:{log}',
                    sys.executable, '-I', str(Path(__file__)), 'record-loop', '21600'])
    else:
        ml.systemd('stop', RECORDER_UNIT, check=False)
    return {'at': now(), 'unit': ml.active(RECORDER_UNIT), 'log': str(log), 'lines': len(log.read_text().splitlines()) if log.exists() else 0}


# ---- the run ------------------------------------------------------------------------------------------------------

def phases():
    return [
        ('facts', [('git', al.facts_git), ('host', al.facts_host), ('cluster', al.facts_cluster), ('ceph', al.facts_ceph), ('image', al.facts_image)]),
        ('setup', [('server-dir', al.setup_server_dir), ('admin', setup_admin)]),
        ('on', [('prepare', al.on_prepare), ('start', on_start), ('admission', on_admission)]),
        ('account', [('ready', account_ready), ('first-session', first_session)]),
        ('backup', [('prepare', al.backup_prepare), ('export', backup_export), ('verify-offline', al.backup_verify_offline)]),
        ('loss', [('volume', lose_volume), ('failed-wake', failed_wake)]),
        ('restore', [('under-the-name', restore_under_name)]),
        ('switch', [('switch', switch)]),
        ('wake', [('restored', wake_on_restored)]),
        ('final', [('checks', final_checks), ('teardown', teardown)]),
    ]


def cmd_run(args):
    require_own_server_dir()
    out = Path(args.out)
    (out / 'records').mkdir(parents=True, exist_ok=True)
    plan = phases()
    names = [name for name, _ in plan]
    first = names.index(args.from_phase) if args.from_phase else 0
    last = names.index(args.to_phase) if args.to_phase else len(names) - 1
    ctx = al.load_context()
    number = len(list((out / 'records').glob('*.json')))
    run_started = time.monotonic()
    for phase, steps in plan[first:last + 1]:
        for label, function in steps:
            number += 1
            step = Step()
            started_at, started = now(), time.monotonic()
            error = None
            try:
                if sw.API != al.PRIMARY_API:
                    raise Failed(f'the client points at {sw.API}, not the primary apiserver {al.PRIMARY_API}')
                result = function(ctx, step)
            except (Exception, SystemExit) as failure:  # recorded, then the run stops
                result, error = None, f'{type(failure).__name__}: {failure}'
                traceback.print_exc()
            seconds = round(time.monotonic() - started, 1)
            ok = error is None and all(c['ok'] for c in step.checks)
            (out / 'records' / f'{number:03d}-{phase}-{label}.json').write_text(json.dumps(
                {'phase': phase, 'step': label, 'startedAt': started_at, 'endedAt': now(), 'seconds': seconds, 'ok': ok, 'error': error,
                 'checks': step.checks, 'result': result}, indent=1, sort_keys=True, default=str))
            line = {'n': number, 'phase': phase, 'step': label, 'startedAt': started_at, 'seconds': seconds, 'ok': ok, 'error': error,
                    'checks': len(step.checks), 'failed': [c['check'] for c in step.checks if not c['ok']]}
            with open(out / 'steps.jsonl', 'a') as steps_log:
                steps_log.write(json.dumps(line) + '\n')
            print(json.dumps(line), flush=True)
            al.save_context(ctx)
            if not ok:
                raise SystemExit(f'{phase}/{label} failed: {error or line["failed"]}')
    print(json.dumps({'done': True, 'phases': names[first:last + 1], 'seconds': round(time.monotonic() - run_started, 1)}), flush=True)


def cmd_report(args):
    """The run's steps (time, checks) and the intervals the lab page quotes, from its records only."""
    out = Path(args.out)
    steps = [json.loads(line) for line in (out / 'steps.jsonl').read_text().splitlines()]
    records = {}
    for path in sorted((out / 'records').glob('*.json')):
        record_ = json.loads(path.read_text())
        records[f"{record_['phase']}/{record_['step']}"] = record_
    get = lambda key: (records.get(key) or {}).get('result') or {}
    measures = {}
    for name, function in {
        'disableToAsleep': lambda: get('backup/prepare')['slept']['seconds'],
        'export': lambda: {key: get('backup/export')[key] for key in ('exportSeconds', 'copySeconds')} | {'gzipBytes': get('backup/export')['manifest']['gzipBytes'],
                                                                                                             'imageBytes': get('backup/export')['manifest']['source']['sizeBytes']},
        'verifyOfflineSeconds': lambda: get('backup/verify-offline')['seconds'],
        'wakeToPvcMissing': lambda: get('loss/failed-wake')['until']['seconds'],
        'restore': lambda: {key: get('restore/under-the-name')[key] for key in ('writeSeconds', 'restoreSeconds')},
        'switchToAnswered': lambda: get('wake/restored')['answeredAfterSwitchSeconds'],
        'switchToReady': lambda: al.seconds_between(get('switch/switch')['at'], get('wake/restored')['ready']['at']),
    }.items():
        try:
            measures[name] = function()
        except (KeyError, TypeError, IndexError, ValueError) as error:
            measures[name] = f'unavailable: {type(error).__name__} {error}'
    print(json.dumps({'steps': len(steps), 'checks': sum(line['checks'] for line in steps), 'failedSteps': [f"{l['phase']}/{l['step']}" for l in steps if not l['ok']],
                      'from': steps[0]['startedAt'], 'to': max(r['endedAt'] for r in records.values()) if records else None,
                      'phaseSeconds': {phase: round(sum(l['seconds'] for l in steps if l['phase'] == phase), 1) for phase in dict.fromkeys(l['phase'] for l in steps)},
                      'measures': measures}, indent=1))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    start = sub.add_parser('run')
    start.add_argument('--out', required=True)
    start.add_argument('--from', dest='from_phase')
    start.add_argument('--to', dest='to_phase')
    sub.add_parser('record-loop').add_argument('seconds', type=int)
    sub.add_parser('report').add_argument('out')
    args = parser.parse_args()
    {'run': cmd_run, 'record-loop': al.cmd_record_loop, 'report': cmd_report}[args.command](args)


if __name__ == '__main__':
    main()
