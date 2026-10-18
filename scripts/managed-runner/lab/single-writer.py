#!/usr/bin/env python3
"""Single-writer protection of a managed runner in the lab (task T02a): the manager's own Pod behind
the C2b admission guard, its generation-bound runner credential and the fencing gate, on one node.

docs/managed-runner-lab.md, "Single-writer protection (T02a)". Only the lab's context and namespace,
and the lab's test control plane (test-server.sh, on 127.0.0.1) are used; the state directory is
LAB_TEST_SERVER_DIR, as for test-server.sh. Every command prints JSON and never a credential: the
manager's token, the webhook's token, the owner's tokens and the runner credentials stay in files of
mode 0600 under the state directory, in the lab's Secrets and in k3s's configuration inside the VM.

  identity                      the manager's ServiceAccount, its least-privilege RBAC and token, and
                                the manager kubeconfig the profile names
  admission install|remove|status
                                the bearer token k3s's API server presents to the webhook (its
                                AdmissionConfiguration), and the ValidatingWebhookConfiguration rendered
                                from deploy/managed-runner/admission/pod-admission-webhook.template.json
  import TAR                    the lab image into the guest's containerd, under its digest as well
  profile --image REF           the manager profile that `test-server.sh start --managed` reads
  owner                         bootstrap or sign in the test owner; with the switch on, sign-in provisions.
                                LAB_T02A_OWNER=NAME: another account, made through the admin API, and
                                every other command then acts on that owner's mapping
  mapping [--watch S] [--until STATE ...]
                                the mapping row and the cluster's objects; --watch prints each change
  retry                         the owner's retry, at the revision just read
  contenders                    second Pods on the same node and the same claim, as other identities and shapes
  outage front|database         a second Pod while the webhook's address, or Orbit's database, is down
  payload start|quiesce|resume|snapshot RUN_ID
                                ceph-rbd-payload.py inside the runner container, under its home
  storage                       PVC, PV, VolumeAttachments, RBD image, mounts and Ceph health
  credential save|replay        keep this generation's credential; replay every kept one at the runner door
  signal TERM|KILL              stop the runner process inside its container, which the kubelet reports
  force-delete                  remove the Pod object at once: nobody sees the kubelet report its stop
  receipt                       an incomplete fencing receipt, which the manager must not accept
"""

import argparse
import base64
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

LAB = Path(__file__).resolve().parent
REPO = LAB.parents[2]
ENV = dict(re.findall(r'^([A-Z][A-Z0-9_]*)=(\S*)', (LAB / 'lab.env').read_text(), re.M))
LAB_DIR = Path(ENV['LAB_DIR'])
SERVER = Path(os.environ.get('LAB_TEST_SERVER_DIR') or LAB_DIR / 'test-server')
STATE = SERVER / 'state'
NAMESPACE = ENV['LAB_NAMESPACE']
NODE = ENV['LAB_NAME']
API = f"http://127.0.0.1:{ENV['LAB_TEST_API_PORT']}/api"
# The address k3s's API server and the Pods reach the test server's TLS front at (QEMU user network).
WEBHOOK_HOST = f"10.0.2.2:{ENV['LAB_TEST_TLS_PORT']}"
ENVIRONMENT_ID = 'orbit-mr-lab'
MANAGER = 'orbit-mr-manager'
MANAGER_CONTEXT = 'orbit-mr-lab-manager'
MANAGER_KUBECONFIG = SERVER / 'manager-kubeconfig.json'
PROFILE = SERVER / 'managed-runner-profile.json'
WEBHOOK_TOKEN = SERVER / 'secrets' / 'admission-webhook-token'
WEBHOOK_TEMPLATE = REPO / 'deploy/managed-runner/admission/pod-admission-webhook.template.json'
WEBHOOK_NAME = 'orbit-managed-runner-pods'
GUEST_ADMISSION_DIR = '/etc/rancher/k3s/orbit-admission'
GUEST_K3S_DROP_IN = '/etc/rancher/k3s/config.yaml.d/50-orbit-admission.yaml'
PAYLOAD = REPO / 'scripts/managed-runner/ceph-rbd-payload.py'
# The runner runs as UID 10001 and owns only its home on the volume; the volume's root is root's.
PAYLOAD_ROOT = '/var/lib/orbit/home/storage-verification'
PAYLOAD_IN_POD = '/tmp/t02a-payload.py'
IMAGE_NAME = 'docker.io/library/orbit-managed-runner-lab'
PG = 'orbit-mr-lab-pg'
INSTANCE_CAPABILITY = 'managed-runner-instance-v1'
# Which test owner (and so which mapping) a command is about: state/<name>.json. The first is the
# bootstrapped admin; `owner --create` adds another through the admin API.
OWNER = os.environ.get('LAB_T02A_OWNER', 'owner')
UUID_RE = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds')


def out(value):
    print(json.dumps(value, indent=2, sort_keys=True))


def private_write(path, value):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as output:
        output.write(value if isinstance(value, str) else json.dumps(value, indent=2))


def sha256_text(value):
    return hashlib.sha256(value.encode()).hexdigest()


# ---- Kubernetes (the lab context, or the manager's own identity), SSH, the test database ----

def kubectl(*args, input=None, check=True, manager=False):
    env = {k: v for k, v in os.environ.items() if k != 'KUBECONFIG'}
    config, context = (MANAGER_KUBECONFIG, MANAGER_CONTEXT) if manager else (LAB_DIR / 'kubeconfig.json', ENV['LAB_NAME'])
    command = [str(LAB_DIR / 'bin/kubectl'), '--kubeconfig', str(config), '--context', context, '--namespace', NAMESPACE]
    result = subprocess.run([*command, *args], input=input, capture_output=True, text=True, env=env)
    if check and result.returncode:
        raise SystemExit(f'kubectl {" ".join(args[:2])} failed: {result.stderr.strip()}')
    return result


def kget(kind, name):
    result = kubectl('get', kind, name, '-o', 'json', check=False)
    return json.loads(result.stdout) if result.returncode == 0 else None


def ssh(script, input=None, check=True):
    """Run `script` in the guest with sh; anything secret goes through `input`, never argv."""
    result = subprocess.run(['ssh', '-i', str(LAB_DIR / 'ssh/id_ed25519'), '-p', ENV['LAB_SSH_PORT'],
                             '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
                             '-o', f"UserKnownHostsFile={LAB_DIR / 'ssh/known_hosts'}", '-o', 'LogLevel=ERROR',
                             'ubuntu@127.0.0.1', script], input=input, capture_output=True, text=True)
    if check and result.returncode:
        raise SystemExit(f'guest command failed ({result.returncode}): {result.stderr.strip()[-2000:]}')
    return result


def ceph(*commands):
    """Ceph and rbd CLIs of the pinned image, in one cephadm shell; one JSON or text answer each."""
    joined = '; echo @@@; '.join(commands)
    result = ssh(f"sudo cephadm --image {shlex.quote(ENV['CEPH_IMAGE'])} shell -- sh -c {shlex.quote(joined)} 2>/dev/null")
    return [part.strip() for part in result.stdout.split('@@@')]


def sql(query):
    result = subprocess.run(['docker', 'exec', PG, 'psql', '-U', 'orbit', '-d', 'orbit', '-At', '-v', 'ON_ERROR_STOP=1',
                             '-c', query], capture_output=True, text=True)
    if result.returncode:
        raise SystemExit(f'psql failed: {result.stderr.strip()}')
    return [line for line in result.stdout.splitlines() if line]


# ---- the test server ----------------------------------------------------------------------

def state(name):
    path = STATE / f'{name}.json'
    return json.loads(path.read_text()) if path.exists() else {}


def call(method, path, body=None, token=None, headers=None, timeout=60):
    headers = dict(headers or {})
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers['Content-Type'] = 'application/json'
    if token:
        headers['Authorization'] = 'Bearer ' + token
    request = urllib.request.Request(API + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            text = response.read().decode()
            return response.status, json.loads(text) if text else None
    except urllib.error.HTTPError as error:
        text = error.read().decode()
        try:
            return error.code, json.loads(text)
        except ValueError:
            return error.code, text


def owner_token():
    owner = state(OWNER)
    if not owner:
        raise SystemExit(f'run `owner` first (LAB_T02A_OWNER={OWNER})')
    return owner['accessToken']


def cmd_owner(_args):
    owner = state(OWNER)
    if owner:
        status, answer = call('POST', '/auth/login', {'email': owner['email'], 'password': owner['password']})
    elif OWNER == 'owner':
        owner = {'email': 't02a-owner@lab.invalid', 'password': uuid.uuid4().hex}
        status, answer = call('POST', '/auth/bootstrap', {**owner, 'name': 'T02a lab owner'})
    else:  # another account, made by the bootstrapped admin; its first sign-in provisions its own runner
        admin = state('owner')
        if not admin:
            raise SystemExit('bootstrap the first owner (LAB_T02A_OWNER unset) before another')
        owner = {'email': f't02a-{OWNER}@lab.invalid', 'password': uuid.uuid4().hex}
        status, answer = call('POST', '/admin/users', {**owner, 'name': f'T02a lab {OWNER}'}, token=admin['accessToken'])
        if status not in (200, 201):
            raise SystemExit(f'admin/users: {status} {answer}')
        status, answer = call('POST', '/auth/login', {'email': owner['email'], 'password': owner['password']})
    if status not in (200, 201):
        raise SystemExit(f'owner: {status} {answer}')
    owner.update(accessToken=answer['accessToken'], refreshToken=answer['refreshToken'], user=answer['user'])
    private_write(STATE / f'{OWNER}.json', owner)
    out({'signedInAt': now(), 'owner': {key: answer['user'].get(key) for key in ('id', 'email', 'name')}})


def managed_status():
    status, answer = call('GET', '/managed-runner', token=owner_token())
    if status != 200:
        raise SystemExit(f'GET /managed-runner: {status} {answer}')
    return answer


def cmd_retry(_args):
    before = managed_status()
    status, answer = call('POST', '/managed-runner/retry', {'idempotencyKey': str(uuid.uuid4()), 'revision': before.get('revision')},
                          token=owner_token())
    out({'at': now(), 'before': before, 'status': status, 'answer': answer})


# ---- the manager's identity ----------------------------------------------------------------

def manager_objects():
    """The manager's ServiceAccount and exactly the access kubernetes-backend.ts uses, nothing more."""
    meta = {'name': MANAGER, 'namespace': NAMESPACE, 'labels': {'app.kubernetes.io/name': 'orbit-managed-runner-manager'}}
    subject = [{'kind': 'ServiceAccount', 'name': MANAGER, 'namespace': NAMESPACE}]
    storage = f'{MANAGER}-storage'
    return [
        {'apiVersion': 'v1', 'kind': 'ServiceAccount', 'metadata': meta, 'automountServiceAccountToken': False},
        {'apiVersion': 'rbac.authorization.k8s.io/v1', 'kind': 'Role', 'metadata': meta, 'rules': [
            # patch: only to take the manager's stop-report finalizer off a Pod whose stop it recorded.
            {'apiGroups': [''], 'resources': ['pods'], 'verbs': ['get', 'create', 'delete', 'patch']},
            {'apiGroups': [''], 'resources': ['persistentvolumeclaims'], 'verbs': ['get', 'create']},
            {'apiGroups': [''], 'resources': ['secrets'], 'verbs': ['get', 'create', 'delete']},
            # Fencing receipts: read, never written.
            {'apiGroups': [''], 'resources': ['configmaps'], 'verbs': ['get']}]},
        {'apiVersion': 'rbac.authorization.k8s.io/v1', 'kind': 'RoleBinding', 'metadata': meta, 'subjects': subject,
         'roleRef': {'apiGroup': 'rbac.authorization.k8s.io', 'kind': 'Role', 'name': MANAGER}},
        {'apiVersion': 'rbac.authorization.k8s.io/v1', 'kind': 'ClusterRole', 'metadata': {'name': storage, 'labels': meta['labels']},
         'rules': [{'apiGroups': [''], 'resources': ['persistentvolumes'], 'verbs': ['get']},
                   {'apiGroups': ['storage.k8s.io'], 'resources': ['volumeattachments'], 'verbs': ['list']}]},
        {'apiVersion': 'rbac.authorization.k8s.io/v1', 'kind': 'ClusterRoleBinding', 'metadata': {'name': storage, 'labels': meta['labels']},
         'subjects': subject, 'roleRef': {'apiGroup': 'rbac.authorization.k8s.io', 'kind': 'ClusterRole', 'name': storage}},
        {'apiVersion': 'v1', 'kind': 'Secret', 'type': 'kubernetes.io/service-account-token',
         'metadata': {'name': f'{MANAGER}-token', 'namespace': NAMESPACE,
                      'annotations': {'kubernetes.io/service-account.name': MANAGER}}},
    ]


def manager_kubeconfig(admin, token):
    """A JSON kubeconfig with one context, as kube-http-client.ts reads it: the lab's API server and CA."""
    context = next(c['context'] for c in admin['contexts'] if c['name'] == ENV['LAB_NAME'])
    cluster = next(c['cluster'] for c in admin['clusters'] if c['name'] == context['cluster'])
    return {
        'apiVersion': 'v1', 'kind': 'Config',
        'clusters': [{'name': context['cluster'], 'cluster': {'server': cluster['server'],
                                                              'certificate-authority-data': cluster['certificate-authority-data']}}],
        'users': [{'name': MANAGER, 'user': {'token': token}}],
        'contexts': [{'name': MANAGER_CONTEXT, 'context': {'cluster': context['cluster'], 'user': MANAGER, 'namespace': NAMESPACE}}],
    }


def cmd_identity(_args):
    kubectl('apply', '-f', '-', input=json.dumps({'apiVersion': 'v1', 'kind': 'List', 'items': manager_objects()}))
    deadline = time.monotonic() + 60
    while True:
        secret = kget('secret', f'{MANAGER}-token') or {}
        token = (secret.get('data') or {}).get('token')
        if token:
            break
        if time.monotonic() > deadline:
            raise SystemExit('the token controller did not fill the manager token in 60 s')
        time.sleep(2)
    admin = json.loads((LAB_DIR / 'kubeconfig.json').read_text())
    private_write(MANAGER_KUBECONFIG, manager_kubeconfig(admin, base64.b64decode(token).decode()))
    whoami = json.loads(kubectl('auth', 'whoami', '-o', 'json', manager=True).stdout)
    checks = {}
    for verb, resource, subresource, namespace in [
            ('create', 'pods', '', NAMESPACE), ('delete', 'pods', '', NAMESPACE), ('patch', 'pods', '', NAMESPACE),
            ('list', 'pods', '', NAMESPACE), ('update', 'pods', '', NAMESPACE), ('patch', 'pods', 'ephemeralcontainers', NAMESPACE),
            ('patch', 'pods', 'status', NAMESPACE),
            ('create', 'pods', 'exec', NAMESPACE), ('get', 'secrets', '', NAMESPACE), ('create', 'configmaps', '', NAMESPACE),
            ('delete', 'persistentvolumeclaims', '', NAMESPACE), ('create', 'pods', '', 'kube-system'),
            ('get', 'persistentvolumes', '', ''), ('list', 'volumeattachments.storage.k8s.io', '', ''), ('get', 'nodes', '', ''),
            ('create', 'validatingwebhookconfigurations.admissionregistration.k8s.io', '', '')]:
        # `pods/exec` would name a Pod called exec: a subresource is asked for with --subresource.
        args = ['auth', 'can-i', verb, resource, *(['--subresource', subresource] if subresource else []),
                *(['--namespace', namespace] if namespace else [])]
        answer = kubectl(*args, check=False, manager=True)
        label = f"{verb} {resource}{'/' + subresource if subresource else ''}{' in ' + namespace if namespace else ''}"
        checks[label] = answer.stdout.strip() or answer.stderr.strip()
    out({'username': whoami['status']['userInfo']['username'], 'groups': whoami['status']['userInfo'].get('groups'),
         'kubeconfig': str(MANAGER_KUBECONFIG), 'context': MANAGER_CONTEXT, 'canI': checks,
         'rules': [item.get('rules') for item in manager_objects() if item['kind'] in ('Role', 'ClusterRole')]})


# ---- the admission guard ---------------------------------------------------------------------

def webhook_token():
    if not WEBHOOK_TOKEN.exists():
        private_write(WEBHOOK_TOKEN, secrets.token_hex(32))
    return WEBHOOK_TOKEN.read_text().strip()


def webhook_configuration(ca_pem):
    """The repository's ValidatingWebhookConfiguration template, every placeholder filled for the lab."""
    text = WEBHOOK_TEMPLATE.read_text()
    values = {'__TEST_ENVIRONMENT_ID__': ENVIRONMENT_ID, '__AUTHORIZED_TEST_NAMESPACE__': NAMESPACE,
              '__AUTHORIZED_TEST_ORBIT_HOST__': WEBHOOK_HOST,
              '__BASE64_PEM_CA_BUNDLE_OF_THAT_HOST__': base64.b64encode(ca_pem).decode()}
    for placeholder, value in values.items():
        if text.count(placeholder) != 1:
            raise SystemExit(f'expected exactly one {placeholder} in {WEBHOOK_TEMPLATE}')
        text = text.replace(placeholder, value)
    if re.search(r'__[A-Z0-9_]+__', text):
        raise SystemExit(f'a placeholder is left in {WEBHOOK_TEMPLATE}')
    return json.loads(text)


def admission_configuration():
    """k3s's API server: the webhook kubeconfig whose user, named after the webhook's host, holds the token."""
    return {'apiVersion': 'apiserver.config.k8s.io/v1', 'kind': 'AdmissionConfiguration', 'plugins': [
        {'name': 'ValidatingAdmissionWebhook', 'configuration': {
            'apiVersion': 'apiserver.config.k8s.io/v1', 'kind': 'WebhookAdmissionConfiguration',
            'kubeConfigFile': f'{GUEST_ADMISSION_DIR}/webhook-kubeconfig.json'}}]}


def webhook_kubeconfig(token):
    return {'apiVersion': 'v1', 'kind': 'Config', 'users': [{'name': WEBHOOK_HOST, 'user': {'token': token}}]}


K3S_DROP_IN = f'kube-apiserver-arg+:\n  - "admission-control-config-file={GUEST_ADMISSION_DIR}/admission-configuration.json"\n'


def wait_api(seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if kubectl('get', '--raw', '/readyz', check=False).stdout.strip() == 'ok':
            return
        time.sleep(3)
    raise SystemExit(f'the k3s API server was not ready within {seconds} s')


def webhook_view():
    config = kget('validatingwebhookconfiguration', WEBHOOK_NAME)
    if not config:
        return None
    hook = config['webhooks'][0]
    return {'name': config['metadata']['name'], 'uid': config['metadata']['uid'], 'webhook': hook['name'],
            'failurePolicy': hook['failurePolicy'], 'sideEffects': hook['sideEffects'], 'timeoutSeconds': hook['timeoutSeconds'],
            'rules': hook['rules'], 'namespaceSelector': hook['namespaceSelector'], 'objectSelector': hook.get('objectSelector'),
            'url': hook['clientConfig']['url'],
            'caBundleSha256': hashlib.sha256(base64.b64decode(hook['clientConfig']['caBundle'])).hexdigest()}


def probe_pod(name, claim):
    """A Pod the guard must look at: dry-run only (it never runs)."""
    return {'apiVersion': 'v1', 'kind': 'Pod', 'metadata': {'name': name, 'namespace': NAMESPACE},
            'spec': {'restartPolicy': 'Never', 'nodeName': NODE,
                     'containers': [{'name': 'probe', 'image': ENV['PROBE_IMAGE'], 'command': ['true']}],
                     'volumes': [{'name': 'data', 'persistentVolumeClaim': {'claimName': claim}}] if claim else []}}


def dry_run(pod, manager=False):
    result = kubectl('create', '--dry-run=server', '-o', 'name', '-f', '-', input=json.dumps(pod), check=False, manager=manager)
    return {'exit': result.returncode, 'answer': (result.stdout or result.stderr).strip()}


def cmd_admission(args):
    if args.action == 'install':
        token = webhook_token()
        ssh(f'sudo install -d -m 0700 {GUEST_ADMISSION_DIR} && sudo sh -c '
            + shlex.quote(f'umask 077; cat > {GUEST_ADMISSION_DIR}/webhook-kubeconfig.json.new'),
            input=json.dumps(webhook_kubeconfig(token), indent=2) + '\n')
        script = f'''set -eu
D={GUEST_ADMISSION_DIR}
install -d -m 0755 /etc/rancher/k3s/config.yaml.d
cat > "$D/admission-configuration.json.new" <<'EOF'
{json.dumps(admission_configuration(), indent=2)}
EOF
cat > {GUEST_K3S_DROP_IN}.new <<'EOF'
{K3S_DROP_IN.rstrip()}
EOF
chmod 0600 "$D/webhook-kubeconfig.json.new"
chmod 0644 "$D/admission-configuration.json.new" {GUEST_K3S_DROP_IN}.new
changed=0
for f in "$D/webhook-kubeconfig.json" "$D/admission-configuration.json" {GUEST_K3S_DROP_IN}; do
  if cmp -s "$f.new" "$f"; then rm -f "$f.new"; else mv "$f.new" "$f"; changed=1; fi
done
if [ "$changed" = 1 ]; then date -u +%FT%TZ; systemctl restart k3s; echo restarted; else echo unchanged; fi
'''
        k3s = ssh('sudo sh -s', input=script).stdout.split()
        if k3s and k3s[-1] == 'restarted':
            wait_api(240)
        flag = ssh(f"sudo journalctl -u k3s --since '-15 min' --no-pager -o cat | grep -c 'admission-control-config-file={GUEST_ADMISSION_DIR}' || true").stdout.strip()
        kubectl('apply', '-f', '-', input=json.dumps(webhook_configuration((SERVER / 'tls/ca.crt').read_bytes())))
        # Proof the API server reaches the webhook with its token: a Pod using no managed claim is
        # admitted (a refusal of the call itself would refuse it, failurePolicy Fail), and one naming a
        # managed-looking claim nobody owns is refused by the guard's own decision.
        time.sleep(2)
        unmanaged = dry_run(probe_pod('t02a-admission-check', None))
        unowned = dry_run(probe_pod('t02a-admission-check', f'mr-data-{uuid.uuid4()}'))
        out({'at': now(), 'k3s': ' '.join(k3s), 'apiServerFlagLines': flag, 'webhook': webhook_view(),
             'tokenSha256': sha256_text(token), 'dryRunUnmanagedPod': unmanaged, 'dryRunUnownedManagedClaim': unowned})
    elif args.action == 'remove':
        kubectl('delete', 'validatingwebhookconfiguration', WEBHOOK_NAME, '--ignore-not-found')
        out({'at': now(), 'removed': WEBHOOK_NAME, 'webhook': webhook_view(),
             'note': f'the k3s AdmissionConfiguration ({GUEST_ADMISSION_DIR}) stays: it only holds the token for {WEBHOOK_HOST}'})
    else:
        files = ssh(f'sudo ls -l {GUEST_ADMISSION_DIR} {GUEST_K3S_DROP_IN} 2>&1 || true').stdout.splitlines()
        out({'at': now(), 'webhook': webhook_view(), 'guestFiles': files})


# ---- the image and the profile ---------------------------------------------------------------

def cmd_import(args):
    tar = Path(args.tar).resolve()
    digest = hashlib.sha256(tar.read_bytes()).hexdigest()
    remote = f'/var/tmp/orbit-runner-lab-image-{digest[:12]}.tar'
    copy = subprocess.run(['scp', '-q', '-i', str(LAB_DIR / 'ssh/id_ed25519'), '-P', ENV['LAB_SSH_PORT'],
                           '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
                           '-o', f"UserKnownHostsFile={LAB_DIR / 'ssh/known_hosts'}", '-o', 'LogLevel=ERROR',
                           str(tar), f'ubuntu@127.0.0.1:{remote}'], capture_output=True, text=True)
    if copy.returncode:
        raise SystemExit(f'scp failed: {copy.stderr}')
    started = time.monotonic()
    # --base-name keeps only this image and names a digest reference after it, which is what the
    # profile pins and the kubelet looks up (a digest reference with no pull policy: IfNotPresent).
    ssh(f'sudo k3s ctr -n k8s.io images import --digests --base-name {IMAGE_NAME} {remote} && sudo rm -f {remote}')
    seconds = round(time.monotonic() - started, 1)
    names = ssh(f'sudo k3s ctr -n k8s.io images ls -q | grep -F {IMAGE_NAME}').stdout.split()
    digests = [name for name in names if '@sha256:' in name]
    if len(digests) != 1:
        raise SystemExit(f'expected one digest reference of {IMAGE_NAME}, found {names}')
    inspect = json.loads(ssh(f'sudo k3s crictl inspecti -o json {digests[0]}').stdout)
    out({'archiveSha256': digest, 'importSeconds': seconds, 'references': names, 'pinned': digests[0],
         'cri': {key: inspect['status'].get(key) for key in ('id', 'repoTags', 'repoDigests', 'size')}})


def lab_profile(image, webhook_token_sha256):
    """The manager profile for the lab (managed-runner-profile.ts): one node's worth of budget, two runners."""
    return {
        'schemaVersion': 1, 'valueKind': 'actual', 'backend': 'kubernetes',
        'environmentId': ENVIRONMENT_ID, 'clusterKey': ENVIRONMENT_ID, 'resourceProfileId': 'orbit-mr-lab-t02a',
        'kubernetes': {'kubeconfig': str(MANAGER_KUBECONFIG), 'context': MANAGER_CONTEXT,
                       'apiServer': f"https://127.0.0.1:{ENV['LAB_API_PORT']}", 'namespace': NAMESPACE},
        'storage': {'className': ENV['LAB_STORAGE_CLASS'], 'capacity': '2Gi'},
        'runner': {
            'image': image, 'serverUrl': f'https://{WEBHOOK_HOST}', 'maxConcurrent': 2, 'tmpSizeLimit': '1Gi',
            'resources': {'runner': {'requests': {'cpu': '500m', 'memory': '768Mi'}, 'limits': {'cpu': '2', 'memory': '2Gi'}},
                          'init': {'requests': {'cpu': '50m', 'memory': '64Mi'}, 'limits': {'cpu': '200m', 'memory': '128Mi'}}},
        },
        'admission': {'managerUsername': f'system:serviceaccount:{NAMESPACE}:{MANAGER}', 'webhookTokenSha256': webhook_token_sha256},
        'capacity': {'compute': {'cpu': '1', 'memory': '1536Mi', 'ephemeralStorage': '2Gi', 'pods': 2, 'attachments': 2},
                     'storage': {'usable': '12Gi', 'headroom': '2Gi'}, 'maxActiveUsers': 2},
        # No model in this task: the runner stays STARTING with MODEL_UNAVAILABLE, so the startup
        # deadline is long and the attempts many enough for a VM restart's unanswered passes.
        'lifecycle': {'maxAttempts': 20, 'backoffBaseSeconds': 5, 'backoffMaxSeconds': 60, 'startupDeadlineSeconds': 43200,
                      'requestTimeoutSeconds': 20, 'leaseSeconds': 60, 'pollIntervalSeconds': 5, 'heartbeatFreshSeconds': 120,
                      'idleSeconds': 604800, 'capacityRetrySeconds': 30, 'drainSeconds': 300},
    }


def cmd_profile(args):
    if not re.fullmatch(rf'{re.escape(IMAGE_NAME)}@sha256:[0-9a-f]{{64}}', args.image):
        raise SystemExit(f'--image must be {IMAGE_NAME}@sha256:<64 hex>, as `import` prints it')
    profile = lab_profile(args.image, sha256_text(webhook_token()))
    private_write(PROFILE, profile)
    out({'profile': str(PROFILE), 'value': profile})


# ---- the mapping and its objects -------------------------------------------------------------

MAPPING_COLUMNS = ('id, owner_id, runner_id, default_workspace_id, desired_state, management_state, generation, revision, '
                   'backend, cluster_key, namespace, pvc_name, pvc_uid, pv_uid, volume_handle, pod_name, pod_uid, node_name, '
                   'reservation, initial_provider, resource_operation_kind, resource_operation_state, attempt, next_attempt_at, '
                   'startup_deadline_at, last_error, fencing_receipt, state_entered_at, updated_at')


def mapping_row():
    email = state(OWNER).get('email') or 't02a-owner@lab.invalid'
    if not re.fullmatch(r'[a-z0-9.@-]+', email):
        raise SystemExit(f'unexpected owner email {email!r}')
    rows = sql(f'select row_to_json(m) from (select {MAPPING_COLUMNS} from managed_runner where owner_id = '
               f'(select id from "user" where email = \'{email}\')) m')
    if len(rows) != 1:
        raise SystemExit(f'expected one managed runner mapping for {email}, found {len(rows)}')
    return json.loads(rows[0])


def runner_row(runner_id):
    rows = sql("select row_to_json(r) from (select id, name, status, last_heartbeat_at, version, labels from runner "
               f"where id = '{runner_id}') r")
    return json.loads(rows[0]) if rows else None


def pod_view(pod):
    if not pod:
        return None
    statuses = (pod['status'].get('initContainerStatuses') or []) + (pod['status'].get('containerStatuses') or [])
    return {'name': pod['metadata']['name'], 'uid': pod['metadata']['uid'], 'node': pod['spec'].get('nodeName'),
            'phase': pod['status'].get('phase'), 'deletionTimestamp': pod['metadata'].get('deletionTimestamp'),
            'generation': (pod['metadata'].get('annotations') or {}).get('orbit.dev/generation'),
            'images': sorted({c['image'] for c in pod['spec'].get('initContainers', []) + pod['spec']['containers']}),
            'containers': [{'name': s['name'], 'state': s.get('state'), 'restartCount': s.get('restartCount'),
                            'imageID': s.get('imageID')} for s in statuses]}


def objects(mapping):
    runner = mapping['runner_id']
    pvc = kget('pvc', mapping['pvc_name'])
    pv = kget('pv', pvc['spec']['volumeName']) if pvc and pvc['spec'].get('volumeName') else None
    secret = kget('secret', f'mr-boot-{runner}')
    attachments = json.loads(kubectl('get', 'volumeattachments', '-o', 'json').stdout)['items']
    pods = json.loads(kubectl('get', 'pods', '-o', 'json').stdout)['items']
    using = [p['metadata']['name'] for p in pods
             if any((v.get('persistentVolumeClaim') or {}).get('claimName') == mapping['pvc_name'] for v in p['spec'].get('volumes', []))]
    return {
        'pod': pod_view(kget('pod', f'mr-{runner}')),
        'podsUsingTheClaim': using,
        'pvc': pvc and {'name': pvc['metadata']['name'], 'uid': pvc['metadata']['uid'], 'phase': pvc['status'].get('phase'),
                        'volumeName': pvc['spec'].get('volumeName'), 'accessModes': pvc['spec']['accessModes'],
                        'storageClassName': pvc['spec'].get('storageClassName'), 'annotations': pvc['metadata'].get('annotations')},
        'pv': pv and {'name': pv['metadata']['name'], 'uid': pv['metadata']['uid'], 'reclaimPolicy': pv['spec'].get('persistentVolumeReclaimPolicy'),
                      'claimUid': pv['spec'].get('claimRef', {}).get('uid'), 'volumeHandle': pv['spec']['csi']['volumeHandle'],
                      'pool': pv['spec']['csi']['volumeAttributes'].get('pool'),
                      'image': pv['spec']['csi']['volumeAttributes'].get('imageName'),
                      'clusterID': pv['spec']['csi']['volumeAttributes'].get('clusterID'), 'fsType': pv['spec']['csi'].get('fsType')},
        'volumeAttachments': [{'name': va['metadata']['name'], 'node': va['spec']['nodeName'], 'attached': va.get('status', {}).get('attached'),
                               'deletionTimestamp': va['metadata'].get('deletionTimestamp')}
                              for va in attachments if pv and va['spec']['source'].get('persistentVolumeName') == pv['metadata']['name']],
        # Metadata only: the credential itself is never read here.
        'bootstrapSecret': secret and {'name': secret['metadata']['name'], 'uid': secret['metadata']['uid'],
                                       'generation': (secret['metadata'].get('annotations') or {}).get('orbit.dev/generation'),
                                       'createdAt': secret['metadata']['creationTimestamp']},
    }


def compact(mapping, view):
    pod = view['pod'] or {}
    return {'state': mapping['management_state'], 'desired': mapping['desired_state'], 'generation': mapping['generation'],
            'podUid': mapping['pod_uid'], 'reason': (mapping['last_error'] or {}).get('code'), 'attempt': mapping['attempt'],
            'operation': f"{mapping['resource_operation_kind']}:{mapping['resource_operation_state']}",
            'proof': (mapping['fencing_receipt'] or {}).get('kind'), 'proofRetired': bool((mapping['fencing_receipt'] or {}).get('retiredAt')),
            'pod': f"{pod.get('uid')}:{pod.get('phase')}:{'deleting' if pod.get('deletionTimestamp') else ''}" if pod else None,
            'secretGeneration': (view['bootstrapSecret'] or {}).get('generation'), 'attachments': len(view['volumeAttachments'])}


def cmd_mapping(args):
    if not args.watch:
        mapping = mapping_row()
        out({'at': now(), 'mapping': mapping, 'runner': runner_row(mapping['runner_id']), 'objects': objects(mapping),
             'ownerStatus': managed_status() if state(OWNER) else None})
        return
    deadline, last = time.monotonic() + args.watch, None
    unreachable = {'pod': None, 'bootstrapSecret': None, 'volumeAttachments': []}
    while time.monotonic() < deadline:
        mapping = mapping_row()
        try:
            line = compact(mapping, objects(mapping))
        except SystemExit:  # the VM is down or k3s is restarting: the database still says where the manager is
            line = {**compact(mapping, unreachable), 'pod': 'cluster unreachable', 'attachments': None}
        if line != last:
            print(json.dumps({'at': now(), **line}, sort_keys=True), flush=True)
            last = line
        if args.until and line['state'] in args.until and (not args.generation or line['generation'] >= args.generation):
            return
        time.sleep(1)
    if args.until:
        raise SystemExit(f'not {args.until} within {args.watch} s')


# ---- second Pods ---------------------------------------------------------------------------

def contender(name, mapping, pod, labelled=False):
    """A Pod on the managed claim and the lab's only node, built from the authorized Pod or from nothing."""
    base = json.loads(json.dumps(pod)) if pod else None
    if base:
        spec = base['spec']
        # What the API server filled in for the authorized Pod; the Priority plugin refuses a stated priority.
        for key in ('nodeName', 'priority', 'preemptionPolicy'):
            spec.pop(key, None)
        metadata = {'name': name, 'namespace': NAMESPACE, 'annotations': base['metadata'].get('annotations', {})}
        if labelled:
            metadata['labels'] = base['metadata'].get('labels', {})
        spec['nodeName'] = NODE
        return {'apiVersion': 'v1', 'kind': 'Pod', 'metadata': metadata, 'spec': spec}
    return {'apiVersion': 'v1', 'kind': 'Pod', 'metadata': {'name': name, 'namespace': NAMESPACE},
            'spec': {'restartPolicy': 'Never', 'nodeName': NODE,
                     'containers': [{'name': 'second-writer', 'image': ENV['PROBE_IMAGE'],
                                     'command': ['sh', '-c', 'echo second > /var/lib/orbit/second-pod.txt; sleep 3600'],
                                     'volumeMounts': [{'name': 'data', 'mountPath': '/var/lib/orbit'}]}],
                     'volumes': [{'name': 'data', 'persistentVolumeClaim': {'claimName': mapping['pvc_name']}}]}}


def attempt_create(label, pod, manager=False):
    started = now()
    result = kubectl('create', '-o', 'name', '-f', '-', input=json.dumps(pod), check=False, manager=manager)
    created = result.returncode == 0
    if created:  # admitted: it must not stay, but the record says it got in
        kubectl('delete', 'pod', pod['metadata']['name'], '--grace-period=0', '--force', '--wait=false', check=False)
    return {'case': label, 'at': started, 'identity': f'system:serviceaccount:{NAMESPACE}:{MANAGER}' if manager else 'lab cluster-admin',
            'name': pod['metadata']['name'], 'node': pod['spec'].get('nodeName'), 'labels': pod['metadata'].get('labels'),
            'admitted': created, 'answer': (result.stdout if created else result.stderr).strip()}


def first_pod_witness(mapping):
    pod = kget('pod', mapping['pod_name']) if mapping['pod_name'] else None
    runner = runner_row(mapping['runner_id'])
    rows = None
    if pod and pod['status'].get('phase') == 'Running':
        found = kubectl('exec', pod['metadata']['name'], '-c', 'runner', '--', 'sh', '-c',
                        f'for f in {PAYLOAD_ROOT}/*/acknowledged.json; do [ -e "$f" ] && cat "$f" && echo; done', check=False).stdout
        rows = [json.loads(line)['committedRows'] for line in found.splitlines() if line.strip().startswith('{')]
    mounts = ssh("findmnt -rn -o TARGET,SOURCE,FSTYPE | awk '$2 ~ /^\\/dev\\/rbd/'", check=False).stdout.splitlines()
    return {'at': now(), 'pod': pod_view(pod), 'runnerLastHeartbeatAt': runner and runner['last_heartbeat_at'],
            'runnerStatus': runner and runner['status'], 'writerCommittedRows': rows, 'guestRbdMounts': mounts,
            'objects': {key: value for key, value in objects(mapping).items() if key in ('podsUsingTheClaim', 'volumeAttachments')}}


def cmd_contenders(_args):
    mapping = mapping_row()
    pod = kget('pod', mapping['pod_name']) if mapping['pod_name'] else None
    if not pod or pod['status'].get('phase') != 'Running':
        raise SystemExit('the authorized Pod is not running')
    generation = mapping['generation']
    results = {'before': first_pod_witness(mapping), 'attempts': []}
    attempts = results['attempts']
    attempts.append(attempt_create('unlabelled Pod, another name, same node and claim, by the cluster admin',
                                   contender('t02a-second-admin', mapping, None)))
    attempts.append(attempt_create('unlabelled Pod, another name, same node and claim, by the manager identity',
                                   contender('t02a-second-manager', mapping, None), manager=True))
    attempts.append(attempt_create("copy of the authorized Pod (labels, annotations, image, volumes) under another name, by the manager",
                                   contender('t02a-second-copy', mapping, pod, labelled=True), manager=True))
    copy = contender(pod['metadata']['name'], mapping, pod, labelled=True)
    attempts.append(attempt_create('copy of the authorized Pod under its own fixed name, same generation, by the manager', copy, manager=True))
    following = json.loads(json.dumps(copy))
    following['metadata']['annotations']['orbit.dev/generation'] = str(generation + 1)
    attempts.append(attempt_create('the fixed name for the next generation, unreserved, by the manager', following, manager=True))
    # A controller's Pod: the Job controller creates it under its own identity.
    job = {'apiVersion': 'batch/v1', 'kind': 'Job', 'metadata': {'name': 't02a-second-job', 'namespace': NAMESPACE},
           'spec': {'backoffLimit': 0, 'template': contender('unused', mapping, None)}}
    job['spec']['template'].pop('apiVersion')
    job['spec']['template'].pop('kind')
    job['spec']['template']['metadata'] = {'labels': {'t02a': 'second-job'}}
    created = kubectl('create', '-f', '-', input=json.dumps(job), check=False)
    time.sleep(12)
    events = json.loads(kubectl('get', 'events', '--field-selector', 'involvedObject.name=t02a-second-job', '-o', 'json').stdout)['items']
    job_pods = json.loads(kubectl('get', 'pods', '-l', 't02a=second-job', '-o', 'json').stdout)['items']
    attempts.append({'case': "a Job's Pod on the claim, created by the Job controller", 'at': now(),
                     'identity': 'system:serviceaccount:kube-system:job-controller', 'jobCreated': created.returncode == 0,
                     'podsCreated': [p['metadata']['name'] for p in job_pods],
                     'events': sorted({f"{e['reason']}: {e['message']}" for e in events})})
    kubectl('delete', 'job', 't02a-second-job', '--cascade=foreground', '--wait=false', check=False)
    # An ephemeral container would share the authorized Pod's volumes.
    patch = {'spec': {'ephemeralContainers': [{'name': 't02a-debug', 'image': ENV['PROBE_IMAGE'], 'command': ['sleep', '3600'],
                                               'targetContainerName': 'runner',
                                               'volumeMounts': [{'name': 'user-state', 'mountPath': '/var/lib/orbit'}]}]}}
    result = kubectl('patch', 'pod', pod['metadata']['name'], '--subresource', 'ephemeralcontainers', '--type', 'strategic',
                     '-p', json.dumps(patch), check=False)
    attempts.append({'case': 'an ephemeral container mounting the volume, added to the authorized Pod by the cluster admin', 'at': now(),
                     'identity': 'lab cluster-admin', 'admitted': result.returncode == 0, 'answer': (result.stdout or result.stderr).strip()})
    time.sleep(3)
    results['after'] = first_pod_witness(mapping_row())
    results['sameAuthorizedPod'] = (results['before']['pod'] or {}).get('uid') == (results['after']['pod'] or {}).get('uid')
    out(results)


def cmd_outage(args):
    mapping = mapping_row()
    unit = 'orbit-mr-lab-tls' if args.what == 'front' else None
    stopped_at = now()
    if unit:
        subprocess.run(['systemctl', 'stop', unit], check=True)
    else:
        subprocess.run(['docker', 'stop', PG], check=True, capture_output=True)
    time.sleep(2)
    try:
        attempts = [attempt_create('unlabelled Pod on the claim, by the cluster admin, while the guard cannot answer',
                                   contender('t02a-second-outage', mapping, None)),
                    {'case': 'a Pod on no managed claim (dry run), while the guard cannot answer', 'at': now(),
                     **dry_run(probe_pod('t02a-outage-unmanaged', None))}]
    finally:
        restore_at = now()
        if unit:  # the front is a transient unit of test-server.sh, which starts what is missing
            subprocess.run(['bash', str(LAB / 'test-server.sh'), 'start', '--managed'], check=True, capture_output=True,
                           env={**os.environ, 'LAB_TEST_SERVER_DIR': str(SERVER)})
        else:
            subprocess.run(['docker', 'start', PG], check=True, capture_output=True)
    out({'what': {'front': f'TLS front {WEBHOOK_HOST} stopped (Orbit unreachable)', 'database': f'PostgreSQL container {PG} stopped'}[args.what],
         'stoppedAt': stopped_at, 'restoreStartedAt': restore_at, 'restoredAt': now(), 'attempts': attempts,
         'afterRestore': dry_run(probe_pod('t02a-outage-unmanaged', None))})


# ---- data on the volume ----------------------------------------------------------------------

def payload_source():
    text = PAYLOAD.read_text()
    old = 'Path("/var/lib/orbit/storage-verification")'
    if text.count(old) != 1:
        raise SystemExit(f'{PAYLOAD} no longer names its root once')
    return text.replace(old, f'Path({PAYLOAD_ROOT!r})')


IDENTITY = r'''
import json, pathlib
orbit = pathlib.Path('/var/lib/orbit/home/.orbit')
def read(name):
    p = orbit / name
    return json.loads(p.read_text()) if p.exists() else None
config = read('config.json') or {}
print(json.dumps({'config': {k: config.get(k) for k in ('runnerId', 'serverUrl', 'name', 'workDir', 'maxConcurrent')},
                  'managedInstance': read('managed-instance.json'), 'containerIdentity': read('container-identity.json')}))
'''


def pod_exec(pod, *command, input=None):
    return kubectl('exec', *(['-i'] if input is not None else []), pod, '-c', 'runner', '--', *command, input=input)


def cmd_payload(args):
    mapping = mapping_row()
    pod = mapping['pod_name']
    if not pod or not (kget('pod', pod) or {}).get('status', {}).get('phase') == 'Running':
        raise SystemExit('the authorized Pod is not running')
    run = args.run_id
    if not re.fullmatch(r'[a-z0-9-]+', run):
        raise SystemExit('RUN_ID: lowercase letters, digits and hyphens')
    pod_exec(pod, 'sh', '-c', f'cat > {PAYLOAD_IN_POD}', input=payload_source())
    root = f'{PAYLOAD_ROOT}/{run}'
    result = {'at': now(), 'pod': pod, 'podUid': mapping['pod_uid'], 'generation': mapping['generation'], 'runId': run}
    if args.action == 'start':
        existing = pod_exec(pod, 'sh', '-c', f'test -e {root}/ordinary.txt && echo yes || echo no').stdout.strip() == 'yes'
        flags = '--require-existing' if existing else ''
        pod_exec(pod, 'sh', '-c', f'mkdir -p {PAYLOAD_ROOT} && rm -f {root}/stop-writing {root}/quiesced.json; '
                 f'nohup python3 {PAYLOAD_IN_POD} writer --run-id {run} {flags} < /dev/null > /tmp/t02a-writer-{run}.log 2>&1 &')
        deadline = time.monotonic() + 120
        while True:
            found = pod_exec(pod, 'sh', '-c', f'cat {root}/acknowledged.json 2>/dev/null || echo "{{}}"').stdout
            rows = json.loads(found).get('committedRows', 0)
            if rows >= 100:
                break
            if time.monotonic() > deadline:
                raise SystemExit(f'the writer committed {rows} rows in 120 s')
            time.sleep(2)
        if not existing:
            pod_exec(pod, 'python3', '-c', f'''import os
with open({root + "/random.bin"!r}, "wb") as stream:
    stream.write(os.urandom(32 * 1024 * 1024)); stream.flush(); os.fsync(stream.fileno())''')
        result.update(resumedExistingData=existing, committedRows=rows)
    elif args.action == 'resume':
        result['answer'] = json.loads(pod_exec(pod, 'python3', PAYLOAD_IN_POD, 'resume-writer', '--run-id', run).stdout)
    else:
        operation = ['quiesce'] if args.action == 'quiesce' else ['snapshot', '--minimum-rows', str(args.minimum_rows)]
        result['snapshot'] = json.loads(pod_exec(pod, 'python3', PAYLOAD_IN_POD, *operation, '--run-id', run).stdout)
        result['randomSHA256'] = pod_exec(pod, 'sha256sum', f'{root}/random.bin').stdout.split()[0]
    result['runnerVolume'] = json.loads(pod_exec(pod, 'python3', '-c', IDENTITY).stdout)
    out(result)


def cmd_storage(_args):
    mapping = mapping_row()
    view = objects(mapping)
    pv = view['pv'] or {}
    image = f"{pv.get('pool')}/{pv.get('image')}" if pv else None
    guest = ssh('''set -u
echo "== kernel $(uname -r), boot $(cat /proc/sys/kernel/random/boot_id), up $(cut -d' ' -f1 /proc/uptime) s"
echo "== rbd devices"
for d in /sys/bus/rbd/devices/*; do [ -e "$d" ] || continue
  echo "rbd$(basename "$d") $(cat "$d/pool")/$(cat "$d/name") client $(cat "$d/client_id" 2>/dev/null) addr $(cat "$d/client_addr" 2>/dev/null)"; done
echo "== RBD filesystems mounted"
findmnt -rn -o TARGET,SOURCE,FSTYPE,OPTIONS | awk '$2 ~ /^\\/dev\\/rbd/'
''', check=False).stdout.splitlines()
    answers = ceph('ceph -s -f json', 'ceph health detail', f'rbd info --format json {shlex.quote(image)}' if image else 'true',
                   f'rbd status --format json {shlex.quote(image)}' if image else 'true', 'ceph osd blocklist ls 2>&1')

    def parsed(text):
        try:
            return json.loads(text)
        except ValueError:
            return text
    status = parsed(answers[0])
    out({'at': now(), 'mapping': compact(mapping, view), 'objects': view, 'guest': guest,
         'ceph': {'health': status.get('health', {}).get('status') if isinstance(status, dict) else status,
                  'fsid': status.get('fsid') if isinstance(status, dict) else None,
                  'osdmap': status.get('osdmap') if isinstance(status, dict) else None,
                  'pgs': status.get('pgmap', {}).get('pgs_by_state') if isinstance(status, dict) else None,
                  'healthDetail': answers[1], 'rbdInfo': parsed(answers[2]), 'rbdStatus': parsed(answers[3]),
                  'blocklist': answers[4]}})


# ---- the generation-bound credential -----------------------------------------------------------

CREDENTIALS = STATE / 'credentials' / OWNER


def cmd_credential(args):
    mapping = mapping_row()
    if args.action == 'save':
        secret = kget('secret', f"mr-boot-{mapping['runner_id']}")
        if not secret or not mapping['pod_uid']:
            raise SystemExit('no bootstrap Secret, or no Pod recorded for this generation')
        generation = int(secret['metadata']['annotations']['orbit.dev/generation'])
        if generation != mapping['generation']:
            raise SystemExit(f"the Secret is for generation {generation}, the mapping at {mapping['generation']}")
        token = base64.b64decode(secret['data']['token']).decode()
        private_write(CREDENTIALS / f'generation-{generation}.json',
                      {'generation': generation, 'podUid': mapping['pod_uid'], 'secretUid': secret['metadata']['uid'], 'token': token,
                       'savedAt': now()})
        out({'savedAt': now(), 'generation': generation, 'podUid': mapping['pod_uid'], 'secretUid': secret['metadata']['uid'],
             'tokenSha256Prefix': sha256_text(token)[:12], 'file': str(CREDENTIALS / f'generation-{generation}.json')})
        return
    kept = sorted((json.loads(p.read_text()) for p in CREDENTIALS.glob('generation-*.json')), key=lambda c: c['generation'])
    if not kept:
        raise SystemExit('nothing saved: run `credential save` while a generation runs')

    def door(method, path, token, offer, body=None):
        headers = {}
        if offer.get('declare', True):
            headers['X-Orbit-Runner-Capabilities'] = INSTANCE_CAPABILITY
        if offer.get('generation') is not None:
            headers['X-Orbit-Managed-Runner-Generation'] = str(offer['generation'])
        if offer.get('podUid'):
            headers['X-Orbit-Managed-Runner-Pod-Uid'] = offer['podUid']
        status, answer = call(method, path, body, token=token, headers=headers, timeout=30)
        code = answer.get('code') if isinstance(answer, dict) else None
        message = answer.get('message') if isinstance(answer, dict) else answer
        return {'route': f'{method} /api{path}', 'status': status, 'code': code, 'message': message if status != 200 else None,
                'runnerId': answer.get('id') if status == 200 and isinstance(answer, dict) else None}

    current = mapping['generation']
    refused_routes = [('GET', '/runner/me', None), ('POST', '/runner/heartbeat', {}), ('GET', '/runner/sessions/claim', None)]
    rows = []
    for credential in kept:
        offers = [('its own generation and Pod', {'generation': credential['generation'], 'podUid': credential['podUid']})]
        if mapping['pod_uid'] and (credential['generation'], credential['podUid']) != (current, mapping['pod_uid']):
            offers.append(('the current generation and Pod', {'generation': current, 'podUid': mapping['pod_uid']}))
        if credential['generation'] == current:
            offers += [('no instance declaration', {'declare': False}),
                       ('the current generation, another Pod UID', {'generation': current, 'podUid': str(uuid.uuid4())}),
                       ('the next generation', {'generation': current + 1, 'podUid': mapping['pod_uid'] or str(uuid.uuid4())})]
            for older in kept:
                if older['generation'] < current:
                    offers.append((f"generation {older['generation']} and its Pod", {'generation': older['generation'], 'podUid': older['podUid']}))
        for label, offer in offers:
            authorized = (credential['generation'] == current and offer.get('generation') == current
                          and offer.get('podUid') == mapping['pod_uid'] and mapping['management_state'] not in ('FENCING',))
            # Only a read reaches a handler: a heartbeat or a claim from here would act as the runner.
            routes = [('GET', '/runner/me', None)] if authorized else refused_routes
            for method, path, body in routes:
                rows.append({'credential': f"generation {credential['generation']}", 'offer': label, **door(method, path, credential['token'], offer, body)})
    out({'at': now(), 'mapping': {'generation': current, 'podUid': mapping['pod_uid'], 'state': mapping['management_state']},
         'kept': [{'generation': c['generation'], 'podUid': c['podUid'], 'tokenSha256Prefix': sha256_text(c['token'])[:12]} for c in kept],
         'results': rows})


# ---- stopping the instance -------------------------------------------------------------------

def watch_pod_end(name, uid, seconds):
    deadline = time.monotonic() + seconds
    seen = []
    while time.monotonic() < deadline:
        pod = kget('pod', name)
        view = pod_view(pod) if pod and pod['metadata']['uid'] == uid else None
        line = {'at': now(), 'present': view is not None, 'phase': view and view['phase'],
                'deleting': bool(view and view['deletionTimestamp']),
                'containers': view and [{c['name']: list((c['state'] or {}).keys())} for c in view['containers']]}
        if not seen or {k: v for k, v in line.items() if k != 'at'} != {k: v for k, v in seen[-1].items() if k != 'at'}:
            seen.append(line)
        if view is None or view['phase'] in ('Succeeded', 'Failed'):
            return seen, view
        time.sleep(0.5)
    return seen, None


def cmd_signal(args):
    mapping = mapping_row()
    pod = kget('pod', mapping['pod_name'])
    if not pod or pod['status'].get('phase') != 'Running':
        raise SystemExit('the authorized Pod is not running')
    uid = pod['metadata']['uid']
    sent = now()
    if args.signal == 'TERM':
        # What the kubelet sends on a stop: SIGTERM to PID 1 (tini), which forwards it to the runner.
        pod_exec(pod['metadata']['name'], 'kill', '-TERM', '1')
    else:
        pod_exec(pod['metadata']['name'], 'sh', '-c', 'kill -KILL $(pgrep -x orbit)')
    seen, ended = watch_pod_end(pod['metadata']['name'], uid, 300)
    out({'signal': args.signal, 'sentAt': sent, 'pod': {'name': pod['metadata']['name'], 'uid': uid}, 'generation': mapping['generation'],
         'timeline': seen, 'ended': ended})


def cmd_force_delete(_args):
    mapping = mapping_row()
    pod = kget('pod', mapping['pod_name'])
    if not pod:
        raise SystemExit('no Pod to delete')
    uid = pod['metadata']['uid']
    requested = now()
    result = kubectl('delete', 'pod', pod['metadata']['name'], '--grace-period=0', '--force', '--wait=false', check=False)
    gone = kget('pod', pod['metadata']['name'])
    listed = json.loads(ssh('sudo k3s crictl ps -a -o json', check=False).stdout or '{}').get('containers', [])
    left = [{'name': c['metadata']['name'], 'state': c['state'], 'podSandboxId': c['podSandboxId'][:12]}
            for c in listed if (c.get('labels') or {}).get('io.kubernetes.pod.uid') == uid]
    out({'requestedAt': requested, 'pod': {'name': pod['metadata']['name'], 'uid': uid}, 'generation': mapping['generation'],
         'answer': (result.stdout or result.stderr).strip(), 'objectRightAfter': pod_view(gone),
         'containersOfThatPodRightAfter': left})


def cmd_receipt(_args):
    mapping = mapping_row()
    view = objects(mapping)
    pv = view['pv'] or {}
    node = kget('node', NODE) or {'metadata': {}}
    # Bound to the recorded instance in every field but one, and a temporary blocklist: not a fence.
    receipt = {
        'schemaVersion': 1, 'kind': 'orbit.managed-runner.fencing-receipt', 'method': 'STORAGE_FENCE',
        'predecessor': {'runnerId': mapping['runner_id'], 'generation': mapping['generation'], 'podName': mapping['pod_name'],
                        'podUid': str(uuid.uuid4()), 'nodeName': mapping['node_name'] or NODE, 'nodeUid': node['metadata'].get('uid', 'unknown'),
                        'pvcUid': mapping['pvc_uid'], 'volumeHandle': mapping['volume_handle'],
                        'rbdImage': {'pool': pv.get('pool'), 'image': pv.get('image')}},
        'action': {'performedBy': 'T02a lab operator', 'performedAt': now(), 'description': 'no fence was performed: a test of the gate',
                   'reference': 'T02a lab'},
        'verification': {'observedBy': 'T02a lab operator', 'observedAt': now(), 'result': 'CLIENTS_BLOCKLISTED',
                         'evidenceReference': 'none'},
        'storageFence': {'procedureReference': 'none', 'blocklistedClients': [{'address': '10.0.2.15:0', 'nonce': '0'}],
                         'osdMapEpoch': 1, 'propagationVerifiedAt': now(), 'persistent': False,
                         'expiresAt': (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=1)).isoformat()},
    }
    name = f"mr-fence-{mapping['runner_id']}"
    kubectl('delete', 'configmap', name, '--ignore-not-found')
    kubectl('create', 'configmap', name, '--from-file=receipt.json=/dev/stdin', input=json.dumps(receipt, indent=2))
    out({'at': now(), 'configMap': name, 'receipt': receipt})


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    for name in ('identity', 'owner', 'retry', 'contenders', 'storage', 'force-delete', 'receipt'):
        sub.add_parser(name)
    sub.add_parser('admission').add_argument('action', choices=('install', 'remove', 'status'))
    sub.add_parser('import').add_argument('tar')
    sub.add_parser('profile').add_argument('--image', required=True)
    mapping = sub.add_parser('mapping')
    mapping.add_argument('--watch', type=int, default=0)
    mapping.add_argument('--until', action='append', default=[])
    mapping.add_argument('--generation', type=int, default=0, help='with --until: at least this generation')
    sub.add_parser('outage').add_argument('what', choices=('front', 'database'))
    payload = sub.add_parser('payload')
    payload.add_argument('action', choices=('start', 'quiesce', 'resume', 'snapshot'))
    payload.add_argument('run_id')
    payload.add_argument('--minimum-rows', type=int, default=0)
    sub.add_parser('credential').add_argument('action', choices=('save', 'replay'))
    sub.add_parser('signal').add_argument('signal', choices=('TERM', 'KILL'))
    args = parser.parse_args()
    {'identity': cmd_identity, 'admission': cmd_admission, 'import': cmd_import, 'profile': cmd_profile, 'owner': cmd_owner,
     'mapping': cmd_mapping, 'retry': cmd_retry, 'contenders': cmd_contenders, 'outage': cmd_outage, 'payload': cmd_payload,
     'storage': cmd_storage, 'credential': cmd_credential, 'signal': cmd_signal, 'force-delete': cmd_force_delete,
     'receipt': cmd_receipt}[args.command](args)


if __name__ == '__main__':
    sys.exit(main())
