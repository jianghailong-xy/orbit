#!/usr/bin/env python3
"""Two-node checks of the lab (task L1), with the repository's probe payload (ceph-rbd-payload.py).

  two-node.py topology            nodes (names, labels, addresses, taints), the Pods on each, Ceph's addresses
  two-node.py migrate             one PVC: written on the first node, moved to the second (compared, written
                                  more), moved back (compared); each step's VolumeAttachments and RBD mappings
  two-node.py hard-stop [--observe SECONDS]
                                  a writer Pod on the second node, then its VM killed (stop.sh --node 2 --hard):
                                  the node, the Pod, the VolumeAttachment and the RBD watchers every few seconds;
                                  then start.sh --nodes 2, the same until the Pod is gone, the data checked, cleanup
  two-node.py verify RUN_ID [--node NODE]
                                  after the VMs stopped and started: a migrate run's data on its PVC, compared
  two-node.py memory LABEL        each VM's memory (cgroup, balloon) and the host's, appended to state/memory.jsonl

Reports (no credentials) go to $LAB_DIR/state/two-node-RUN_ID.json, the hard stop's samples to
two-node-RUN_ID-timeline.jsonl. Run as root on the host, two-node mode up (start.sh --nodes 2). Exit 1 on a
mismatch. Only the lab's own kubeconfig and context are used.
"""

import argparse
import datetime
import importlib.util
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import time
import uuid

LAB = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("lab_render", LAB / "render.py")
render = importlib.util.module_from_spec(spec)
spec.loader.exec_module(render)
ENV = render.ENV
LAB_DIR = Path(ENV["LAB_DIR"])
STATE = LAB_DIR / "state"
NAMESPACE = ENV["LAB_NAMESPACE"]
NODES = {1: ENV["LAB_NAME"], 2: ENV["LAB2_NAME"]}
SSH_PORTS = {1: ENV["LAB_SSH_PORT"], 2: ENV["LAB2_SSH_PORT"]}
UNITS = {1: ENV["LAB_UNIT"], 2: ENV["LAB2_UNIT"]}
QMP = {1: LAB_DIR / "run/qmp.sock", 2: LAB_DIR / "run/node2-qmp.sock"}
DATA = "/var/lib/orbit/storage-verification"
SNAPSHOT_KEYS = ("ordinarySHA256", "gitCommit", "gitFsck", "sqliteIntegrity", "sqliteJournalMode", "committedRows",
                 "rowSHA256", "prefixRows", "prefixSHA256", "acknowledgedRows", "mountInfo")


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def say(message):
    print(f"{now()} {message}", file=sys.stderr, flush=True)


# ---- the lab: its kubeconfig and context only, SSH into either VM, Ceph in the first ----

def kubectl(*args, input=None, check=True, namespace=True):
    env = {k: v for k, v in os.environ.items() if k != "KUBECONFIG"}
    command = [str(LAB_DIR / "bin/kubectl"), "--kubeconfig", str(LAB_DIR / "kubeconfig.json"), "--context", ENV["LAB_NAME"]]
    if namespace:
        command += ["--namespace", NAMESPACE]
    result = subprocess.run([*command, *args], input=input, capture_output=True, text=True, env=env)
    if check and result.returncode:
        raise SystemExit(f"kubectl {' '.join(args[:2])} failed: {result.stderr.strip()}")
    return result


def kjson(*args, namespace=True):
    result = kubectl(*args, "-o", "json", check=False, namespace=namespace)
    return json.loads(result.stdout) if result.returncode == 0 else None


def apply(obj):
    kubectl("apply", "-f", "-", input=json.dumps(obj))


def ssh(node, script, check=True):
    result = subprocess.run(["ssh", "-i", str(LAB_DIR / "ssh/id_ed25519"), "-p", SSH_PORTS[node],
                             "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5",
                             "-o", f"UserKnownHostsFile={LAB_DIR / 'ssh/known_hosts'}", "-o", "LogLevel=ERROR",
                             "ubuntu@127.0.0.1", script], stdin=subprocess.DEVNULL, capture_output=True, text=True)
    if check and result.returncode:
        raise SystemExit(f"VM {node}: guest command failed ({result.returncode}): {result.stderr.strip()[-2000:]}")
    return result


def rbd_status(image):
    """`rbd status` of a pool/image in the first VM: its watchers (the clients that map it)."""
    result = ssh(1, f"sudo cephadm --image {shlex.quote(ENV['CEPH_IMAGE'])} shell -- "
                    f"rbd status --format json {shlex.quote(image)} </dev/null 2>/dev/null", check=False)
    try:
        return json.loads(result.stdout).get("watchers")
    except (json.JSONDecodeError, AttributeError):
        return {"error": (result.stdout + result.stderr).strip()[-300:] or f"exit {result.returncode}"}


def mapped(node):
    """The RBD images this VM's kernel maps (/sys/bus/rbd), or None when the VM does not answer."""
    result = ssh(node, "for d in /sys/bus/rbd/devices/*; do [ -e \"$d\" ] && echo \"rbd${d##*/} $(cat $d/pool)/$(cat $d/name)\"; done; true",
                 check=False)
    return result.stdout.split("\n")[:-1] if result.returncode == 0 else None


def unit_active(node):
    return subprocess.run(["systemctl", "is-active", "--quiet", UNITS[node] + ".service"]).returncode == 0


def script(name, *args):
    """Another lab script, its output into ours."""
    say(f"run {name} {' '.join(args)}")
    result = subprocess.run([str(LAB / name), *args], stdout=sys.stderr, stderr=sys.stderr)
    if result.returncode:
        raise SystemExit(f"{name} {' '.join(args)} exited {result.returncode}")


# ---- the objects of a run ----

class Run:
    def __init__(self, run_id, create=False):
        self.id = run_id
        self.path = STATE / f"two-node-{run_id}.json"
        self.failures = 0
        if create:
            self.report = {"runId": run_id, "startedAt": now()}
            self.save()
        else:
            if not self.path.exists():
                raise SystemExit(f"no report {self.path}")
            self.report = json.loads(self.path.read_text())

    def save(self):
        self.path.write_text(json.dumps(self.report, indent=2) + "\n")

    def record(self, key, value):
        self.report[key] = value
        self.save()

    def same(self, label, a, b):
        if a == b:
            say(f"same: {label}")
        else:
            say(f"DIFFERENT: {label} ({a!r} vs {b!r})")
            self.failures += 1
        self.report.setdefault("comparisons", []).append({"what": label, "same": a == b})
        self.save()

    def payload(self, pod, *args):
        result = kubectl("exec", pod, "--", "python3", "/probe/ceph-rbd-payload.py", *args, "--run-id", self.id)
        return json.loads(result.stdout)

    def random_sha(self, pod):
        return kubectl("exec", pod, "--", "sha256sum", f"{DATA}/{self.id}/random.bin").stdout.split()[0]


def payload_configmap():
    source = (LAB.parent / "ceph-rbd-payload.py").read_text()
    apply({"apiVersion": "v1", "kind": "ConfigMap", "metadata": {"name": "ceph-rbd-payload", "namespace": NAMESPACE},
           "data": {"ceph-rbd-payload.py": source}})


def fsid():
    return json.loads((STATE / "facts.json").read_text())["fsid"]


def new_pvc(run):
    owner, runner = str(uuid.uuid4()), str(uuid.uuid4())
    name = f"mr-data-{runner}"
    pvc = render.ceph_rbd.render(render.storage_environment(fsid(), name, owner, runner, "1Gi"))["pvc.json"]
    apply(pvc)
    kubectl("wait", "--for=jsonpath={.status.phase}=Bound", f"pvc/{name}", "--timeout=300s")
    pv_name = kjson("get", "pvc", name)["spec"]["volumeName"]
    pv = kjson("get", "pv", pv_name, namespace=False)
    volume = {"pvc": name, "pv": pv_name, "accessModes": pv["spec"]["accessModes"], "volumeMode": pv["spec"]["volumeMode"],
              "reclaimPolicy": pv["spec"]["persistentVolumeReclaimPolicy"], "driver": pv["spec"]["csi"]["driver"],
              "volumeHandle": pv["spec"]["csi"]["volumeHandle"], "fsType": pv["spec"]["csi"].get("fsType"),
              "image": f"{pv['spec']['csi']['volumeAttributes']['pool']}/{pv['spec']['csi']['volumeAttributes']['imageName']}",
              "clusterID": pv["spec"]["csi"]["volumeAttributes"]["clusterID"],
              "mounter": pv["spec"]["csi"]["volumeAttributes"].get("mounter")}
    run.record("volume", volume)
    say(f"PVC {name} bound to {pv_name} ({volume['image']})")
    return volume


def start_pod(run, name, node, writer=True):
    pod = render.probe_pod(name, run.report["volume"]["pvc"], run.id, sleep=not writer, node=NODES[node])
    apply(pod)
    started = time.monotonic()
    kubectl("wait", "--for=condition=Ready", f"pod/{name}", "--timeout=600s")
    placed = kjson("get", "pod", name)["spec"]["nodeName"]
    say(f"Pod {name} Ready on {placed} after {time.monotonic() - started:.1f} s")
    if placed != NODES[node]:
        raise SystemExit(f"Pod {name} runs on {placed}, not {NODES[node]}")
    return round(time.monotonic() - started, 1)


def attachments(pv):
    items = kjson("get", "volumeattachments", namespace=False)["items"]
    return [{"name": va["metadata"]["name"], "node": va["spec"]["nodeName"], "attached": va.get("status", {}).get("attached"),
             "deleting": bool(va["metadata"].get("deletionTimestamp")),
             "attachError": (va.get("status", {}).get("attachError") or {}).get("message"),
             "detachError": (va.get("status", {}).get("detachError") or {}).get("message")}
            for va in items if va["spec"]["source"].get("persistentVolumeName") == pv]


def placement(run, label):
    """Where the volume is now: its VolumeAttachments, each VM's RBD mappings, the image's watchers."""
    volume = run.report["volume"]
    state = {"at": now(), "volumeAttachments": attachments(volume["pv"]),
             "mappedOn": {NODES[n]: [m for m in (mapped(n) or []) if m.endswith(volume["image"])] for n in (1, 2) if unit_active(n)},
             "watchers": rbd_status(volume["image"])}
    run.report.setdefault("placements", {})[label] = state
    run.save()
    say(f"{label}: attachments {[(a['node'], a['attached']) for a in state['volumeAttachments']]}, "
        f"mapped {state['mappedOn']}, watchers {[w.get('address') for w in state['watchers'] or [] if isinstance(w, dict)]}")
    return state


def delete_pod(run, name):
    """Delete the Pod and wait until its node has let the volume go: no VolumeAttachment, no mapping."""
    started = time.monotonic()
    kubectl("delete", "pod", name, "--wait=true", "--timeout=300s")
    volume = run.report["volume"]
    deadline = time.monotonic() + 300
    while attachments(volume["pv"]) or any(any(m.endswith(volume["image"]) for m in (mapped(n) or [])) for n in (1, 2) if unit_active(n)):
        if time.monotonic() > deadline:
            raise SystemExit(f"the volume stayed attached or mapped 300 s after {name} was deleted")
        time.sleep(2)
    say(f"{name} deleted; volume detached and unmapped after {time.monotonic() - started:.1f} s")
    return round(time.monotonic() - started, 1)


def wait_rows(run, pod, rows):
    deadline = time.monotonic() + 300
    while True:
        text = kubectl("exec", pod, "--", "cat", f"{DATA}/{run.id}/acknowledged.json", check=False).stdout
        try:
            if json.loads(text)["committedRows"] >= rows:
                return
        except (json.JSONDecodeError, KeyError):
            pass
        if time.monotonic() > deadline:
            raise SystemExit(f"{pod}: fewer than {rows} committed rows after 300 s")
        time.sleep(2)


def snap(snapshot, **extra):
    return {**{key: snapshot.get(key) for key in SNAPSHOT_KEYS}, **extra}


# ---- the commands ----

def topology(_args):
    nodes = kjson("get", "nodes", namespace=False)["items"]
    pods = kjson("get", "pods", "--all-namespaces", namespace=False)["items"]
    facts = json.loads((STATE / "facts.json").read_text())
    result = {
        "at": now(),
        "nodes": [{"name": n["metadata"]["name"], "uid": n["metadata"]["uid"], "labels": n["metadata"]["labels"],
                   "addresses": n["status"]["addresses"], "podCIDR": n["spec"].get("podCIDR"),
                   "flannelPublicIP": n["metadata"].get("annotations", {}).get("flannel.alpha.coreos.com/public-ip"),
                   "taints": n["spec"].get("taints", []), "unschedulable": n["spec"].get("unschedulable", False),
                   "kubelet": n["status"]["nodeInfo"]["kubeletVersion"], "kernel": n["status"]["nodeInfo"]["kernelVersion"],
                   "osImage": n["status"]["nodeInfo"]["osImage"], "capacity": n["status"]["capacity"],
                   "allocatable": n["status"]["allocatable"],
                   "ready": next((c["status"] for c in n["status"]["conditions"] if c["type"] == "Ready"), None)} for n in nodes],
        "podsByNode": {},
        "ceph": {"mons": facts.get("mons"), "osdAddrs": facts.get("osdAddrs"), "publicNetwork": facts.get("publicNetwork")},
        "link": {"subnet": ENV["LAB_LINK_NET"], "hostSocket": f"127.0.0.1:{ENV['LAB_LINK_PORT']}",
                 "first": facts.get("link"),
                 "second": json.loads((STATE / "facts-node2.json").read_text()).get("link") if (STATE / "facts-node2.json").exists() else None},
    }
    for pod in pods:
        node = pod["spec"].get("nodeName") or "(unscheduled)"
        result["podsByNode"].setdefault(node, []).append(
            {"namespace": pod["metadata"]["namespace"], "name": pod["metadata"]["name"], "ip": pod["status"].get("podIP"),
             "phase": pod["status"].get("phase")})
    (STATE / "topology.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"nodes": [{k: n[k] for k in ("name", "addresses", "flannelPublicIP", "ready", "unschedulable")} for n in result["nodes"]],
                      "podsByNode": {node: len(pods) for node, pods in result["podsByNode"].items()}}, indent=2))


def migrate(_args):
    run = Run("l1m-" + datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d%H%M%S"), create=True)
    payload_configmap()
    volume = new_pvc(run)
    timings = {}

    # 1. First node: the writer's ordinary file, Git and SQLite rows (WAL, synchronous=FULL), plus 32 MiB of random bytes.
    a = f"{run.id}-a"
    timings["podOnFirstReady"] = start_pod(run, a, 1)
    placement(run, "1-writing-on-first")
    wait_rows(run, a, 100)
    kubectl("exec", a, "--", "python3", "-c", "import os\n"
            f"path = '{DATA}/{run.id}/random.bin'\n"
            "with open(path, 'wb') as stream:\n    stream.write(os.urandom(32 * 1024 * 1024))\n"
            "    stream.flush()\n    os.fsync(stream.fileno())")
    first = snap(run.payload(a, "quiesce"), randomSHA256=run.random_sha(a), pod=a, node=NODES[1])
    run.record("onFirstNode", first)
    say(f"first node: {first['committedRows']} rows, integrity {first['sqliteIntegrity']}")
    timings["firstReleased"] = delete_pod(run, a)
    placement(run, "2-released-by-first")

    # 2. Second node: the same data, then more rows written there.
    b = f"{run.id}-b"
    timings["podOnSecondReady"] = start_pod(run, b, 2)
    placement(run, "3-on-second")
    arrived = snap(run.payload(b, "snapshot", "--minimum-rows", str(first["committedRows"])), randomSHA256=run.random_sha(b), pod=b,
                   node=NODES[2])
    for key in ("ordinarySHA256", "gitCommit", "rowSHA256", "committedRows", "randomSHA256"):
        run.same(f"second node: {key}", first[key], arrived[key])
    run.same("second node: SQLite integrity_check", ["ok"], arrived["sqliteIntegrity"])
    run.payload(b, "resume-writer")
    wait_rows(run, b, first["committedRows"] + 50)
    second = snap(run.payload(b, "quiesce", "--minimum-rows", str(first["committedRows"])), randomSHA256=run.random_sha(b), pod=b,
                  node=NODES[2])
    run.same("second node: the first node's rows unchanged under the new ones", first["rowSHA256"], second["prefixSHA256"])
    run.same("second node: SQLite integrity_check after writing", ["ok"], second["sqliteIntegrity"])
    run.report.update(onSecondNodeArrived=arrived, onSecondNodeWritten=second)
    say(f"second node: wrote {second['committedRows'] - first['committedRows']} more rows")
    timings["secondReleased"] = delete_pod(run, b)
    placement(run, "4-released-by-second")

    # 3. Back on the first node.
    c = f"{run.id}-c"
    timings["podBackOnFirstReady"] = start_pod(run, c, 1, writer=False)
    placement(run, "5-back-on-first")
    back = snap(run.payload(c, "snapshot", "--minimum-rows", str(second["committedRows"])), randomSHA256=run.random_sha(c), pod=c,
                node=NODES[1])
    for key in ("ordinarySHA256", "gitCommit", "rowSHA256", "committedRows", "randomSHA256"):
        run.same(f"back on the first node: {key}", second[key], back[key])
    run.same("back on the first node: SQLite integrity_check", ["ok"], back["sqliteIntegrity"])
    run.record("backOnFirstNode", back)
    timings["backReleased"] = delete_pod(run, c)
    placement(run, "6-released-at-end")
    run.report.update(timingsSeconds=timings, finishedAt=now(), failures=run.failures)
    run.save()
    say(f"report: {run.path}; verify after a restart with: two-node.py verify {run.id}")
    return run.failures


def node_view(name):
    node = kjson("get", "node", name, namespace=False)
    if not node:
        return None
    ready = next((c for c in node["status"]["conditions"] if c["type"] == "Ready"), {})
    return {"ready": ready.get("status"), "reason": ready.get("reason"), "since": ready.get("lastTransitionTime"),
            "taints": [f"{t['key']}:{t['effect']}" for t in node["spec"].get("taints", [])],
            "unschedulable": node["spec"].get("unschedulable", False)}


def pod_view(name):
    pod = kjson("get", "pod", name)
    if not pod:
        return None
    ready = next((c for c in pod["status"].get("conditions", []) if c["type"] == "Ready"), {})
    container = (pod["status"].get("containerStatuses") or [{}])[0]
    return {"phase": pod["status"].get("phase"), "node": pod["spec"].get("nodeName"), "ready": ready.get("status"),
            "deletionTimestamp": pod["metadata"].get("deletionTimestamp"), "reason": pod["status"].get("reason"),
            "containerState": sorted(container.get("state", {}).keys()), "restarts": container.get("restartCount")}


def observe(run, pod, seconds, timeline, phase, until=None, watch_every=15):
    """Sample the node, the Pod, the VolumeAttachments and (less often) the RBD watchers; print what changes."""
    volume = run.report["volume"]
    started, last, last_watch, watchers, sample = time.monotonic(), None, -watch_every, None, None
    while time.monotonic() - started < seconds:
        elapsed = time.monotonic() - started
        if elapsed - last_watch >= watch_every:
            watchers, last_watch = rbd_status(volume["image"]), elapsed
        sample = {"at": now(), "phase": phase, "second": round(elapsed, 1), "vm2": "running" if unit_active(2) else "off",
                  "node": node_view(NODES[2]), "pod": pod_view(pod), "volumeAttachments": attachments(volume["pv"]),
                  "watchers": [w.get("address") for w in watchers] if isinstance(watchers, list) else watchers}
        with timeline.open("a") as stream:
            stream.write(json.dumps(sample) + "\n")
        view = {k: sample[k] for k in ("vm2", "node", "pod", "volumeAttachments", "watchers")}
        if view != last:
            say(f"[{phase} +{sample['second']:.0f}s] vm2 {sample['vm2']}; node {sample['node']}; pod {sample['pod']}; "
                f"VA {[(a['node'], a['attached'], a['deleting']) for a in sample['volumeAttachments']]}; watchers {sample['watchers']}")
            last = view
        if until and until(sample):
            return sample
        time.sleep(5)
    return sample


def hard_stop(args):
    run = Run("l1h-" + datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d%H%M%S"), create=True)
    timeline = STATE / f"two-node-{run.id}-timeline.jsonl"
    payload_configmap()
    new_pvc(run)
    w = f"{run.id}-w"
    start_pod(run, w, 2)
    wait_rows(run, w, 100)
    before = placement(run, "before-the-stop")
    run.record("writerBeforeStop", {"pod": w, "node": NODES[2],
                                    "acknowledgedRows": json.loads(kubectl("exec", w, "--", "cat", f"{DATA}/{run.id}/acknowledged.json").stdout)})
    run.record("nodeBeforeStop", node_view(NODES[2]))
    observe(run, w, 6, timeline, "before")

    # The power cut: no shutdown in the guest, nothing told to the cluster.
    script("stop.sh", "--node", "2", "--hard")
    run.record("killedAt", now())
    observe(run, w, args.observe, timeline, "down")
    run.record("whileDown", {"node": node_view(NODES[2]), "pod": pod_view(w), "volumeAttachments": attachments(run.report["volume"]["pv"]),
                             "watchers": rbd_status(run.report["volume"]["image"]), "mappedOnFirst": mapped(1),
                             "observedSeconds": args.observe})

    # Recovery: the second VM boots again (start.sh --nodes 2, sampled meanwhile) and its kubelet settles what
    # it finds: an evicted Pod is removed and its volume detached, a Pod not yet evicted starts again.
    say("run start.sh --nodes 2")
    recovery = subprocess.Popen([str(LAB / "start.sh"), "--nodes", "2"], stdout=sys.stderr, stderr=sys.stderr)
    run.record("recoveryStartedAt", now())

    def settled(sample):
        if recovery.poll() is None:
            return False
        pod = sample["pod"]
        if pod is None:
            return not sample["volumeAttachments"]
        return pod["phase"] == "Running" and pod["ready"] == "True" and not pod["deletionTimestamp"]

    end = observe(run, w, 900, timeline, "recovering", until=settled)
    if recovery.wait() != 0:
        raise SystemExit(f"start.sh --nodes 2 exited {recovery.returncode}")
    run.record("recoveredAt", now())
    after_pod = pod_view(w)
    run.record("afterRecovery", {"pod": after_pod, "volumeAttachments": attachments(run.report["volume"]["pv"]),
                                 "node": node_view(NODES[2]), "sample": end})
    if after_pod is not None:
        kubectl("delete", "pod", w, "--wait=true", "--timeout=300s")
    delete_wait = time.monotonic()
    while attachments(run.report["volume"]["pv"]):
        if time.monotonic() - delete_wait > 300:
            raise SystemExit("the VolumeAttachment stayed after recovery")
        time.sleep(2)

    # The data after the power cut, on the first node: every acknowledged row, integrity_check.
    check = f"{run.id}-check"
    start_pod(run, check, 1, writer=False)
    after = snap(run.payload(check, "snapshot", "--recover", "--minimum-rows", str(run.report["writerBeforeStop"]["acknowledgedRows"]["committedRows"])),
                 pod=check, node=NODES[1])
    run.same("after the power cut: SQLite integrity_check", ["ok"], after["sqliteIntegrity"])
    run.record("dataAfterPowerCut", after)
    delete_pod(run, check)
    final = placement(run, "after-cleanup")
    run.same("after cleanup: no VolumeAttachment", [], final["volumeAttachments"])
    run.same("after cleanup: no RBD watcher", [], final["watchers"])
    run.report.update(finishedAt=now(), failures=run.failures, timeline=str(timeline))
    run.save()
    say(f"report: {run.path}; timeline: {timeline}")
    return run.failures


def verify(args):
    run = Run(args.run_id)
    payload_configmap()
    node = int(args.node)
    expected = run.report["backOnFirstNode"]
    pod = f"{run.id}-v{node}-{datetime.datetime.now(datetime.timezone.utc).strftime('%H%M%S')}"
    start_pod(run, pod, node, writer=False)
    placement(run, f"verify-on-node-{node}")
    found = snap(run.payload(pod, "snapshot", "--minimum-rows", str(expected["committedRows"])), randomSHA256=run.random_sha(pod),
                 pod=pod, node=NODES[node], bootIds={NODES[n]: ssh(n, "cat /proc/sys/kernel/random/boot_id").stdout.strip() for n in (1, 2)})
    for key in ("ordinarySHA256", "gitCommit", "rowSHA256", "committedRows", "randomSHA256"):
        run.same(f"after the restart: {key}", expected[key], found[key])
    run.same("after the restart: SQLite integrity_check", ["ok"], found["sqliteIntegrity"])
    run.report.setdefault("verifications", []).append({**found, "verifiedAt": now(), "failures": run.failures})
    run.save()
    delete_pod(run, pod)
    say(f"report: {run.path}")
    return run.failures


def memory(args):
    def cgroup(unit):
        path = subprocess.run(["systemctl", "show", "-P", "ControlGroup", unit + ".service"], capture_output=True, text=True).stdout.strip()
        root = Path("/sys/fs/cgroup" + path)
        if not path or not (root / "memory.current").exists():
            return None
        read = lambda name: int((root / name).read_text()) // 1048576 if (root / name).exists() else None  # noqa: E731
        return {"currentMiB": read("memory.current"), "swapMiB": read("memory.swap.current"), "peakMiB": read("memory.peak")}

    def balloon(node):
        result = subprocess.run([sys.executable, "-I", str(LAB / "qmp.py"), str(QMP[node]), "balloon-stats"], capture_output=True, text=True)
        return json.loads(result.stdout).get("guestMiB") if result.returncode == 0 else None

    meminfo = {line.split(":")[0]: int(line.split()[1]) // 1024 for line in Path("/proc/meminfo").read_text().splitlines()}
    entry = {"at": now(), "label": args.label,
             "host": {key: meminfo[key] for key in ("MemTotal", "MemAvailable", "SwapTotal", "SwapFree")},
             "vms": {NODES[n]: ({"unit": cgroup(UNITS[n]), "guest": balloon(n)} if unit_active(n) else "off") for n in (1, 2)}}
    with (STATE / "memory.jsonl").open("a") as stream:
        stream.write(json.dumps(entry) + "\n")
    print(json.dumps(entry, indent=2))
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("topology")
    sub.add_parser("migrate")
    hard = sub.add_parser("hard-stop")
    hard.add_argument("--observe", type=int, default=420, help="seconds to watch with the second VM off (default 420)")
    check = sub.add_parser("verify")
    check.add_argument("run_id")
    check.add_argument("--node", choices=("1", "2"), default="2")
    mem = sub.add_parser("memory")
    mem.add_argument("label")
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise SystemExit("run as root: the lab's files and units are root's")
    command = {"topology": topology, "migrate": migrate, "hard-stop": hard_stop, "verify": verify, "memory": memory}[args.command]
    failures = command(args)
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
