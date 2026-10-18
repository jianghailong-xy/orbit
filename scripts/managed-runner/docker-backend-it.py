#!/usr/bin/env python3
"""Run the Docker backend's integration test on this host's real Docker, and clean up after it.

    python3 scripts/managed-runner/docker-backend-it.py --work /mnt/data/tmp/<task>/it \
        --evidence /mnt/data/tmp/<task>/it/evidence [--build-image [--image-source <checkout>]] \
        [--image orbit-managed-runner:d2]

What it sets up, every piece labelled `orbit.test=<run label>` and removed afterwards:
  - the managed runner image, from deploy/managed-runner/image of this checkout or of --image-source
    (built locally with --build-image, never pushed);
  - a disposable PostgreSQL (tmpfs, loopback port), migrated by this checkout's Prisma;
  - a dedicated internal network with inter-container traffic off: the containers reach the test
    apiserver on its gateway address and nothing else;
  - the restricted channel's configuration, token and state directory (the test starts the channel);
then it compiles the test tree and runs src/apiserver/src/managed-runners/docker-backend.it.ts.

Run it outside the Orbit runner's cgroup with a memory cap (the runner service has OOMPolicy=stop),
e.g. `systemd-run --scope -p MemoryMax=6G -- python3 scripts/managed-runner/docker-backend-it.py ...`.
It touches no container, volume or network without its run label, and changes no Docker daemon
configuration. The file name carries no "test": the managed-runner unit suite does not pick it up.
"""

import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import time

REPO = Path(__file__).resolve().parents[2]
API = REPO / "src/apiserver"
CHANNEL = REPO / "deploy/managed-runner/docker-channel/channel.py"
PG_IMAGE = "postgres:16-alpine"


def log(message):
    print(f"==> {message}", flush=True)


def run(args, capture=False, check=True, **kwargs):
    if not capture:
        print("+ " + " ".join(str(a) for a in args), flush=True)
    result = subprocess.run([str(a) for a in args], check=False, text=True,
                            capture_output=capture, **kwargs)
    if check and result.returncode != 0:
        raise SystemExit(f"{args[0]} exited {result.returncode}: {(result.stderr or '').strip()[:2000]}")
    return result


def docker(*args, capture=True, check=True):
    return run(["docker", *args], capture=capture, check=check)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--work", required=True, type=Path, help="scratch directory for this run")
    parser.add_argument("--evidence", required=True, type=Path, help="where the test writes its records")
    parser.add_argument("--image", default="orbit-managed-runner:d2")
    parser.add_argument("--build-image", action="store_true", help="build the managed runner image first")
    parser.add_argument("--image-source", type=Path, default=REPO, help="the checkout whose deploy/managed-runner/image is built")
    parser.add_argument("--keep", action="store_true", help="leave everything in place for inspection")
    args = parser.parse_args()

    run_id = time.strftime("%m%d%H%M", time.gmtime()) + secrets.token_hex(2)
    label = ("orbit.test", f"d2-it-{run_id}")
    label_filter = f"label={label[0]}={label[1]}"
    instance = f"d2it-{run_id}"
    network = f"orbit-mr-{instance}"
    pg = f"pccspec-{instance}"
    work = args.work.resolve() / run_id
    evidence = args.evidence.resolve() / run_id
    work.mkdir(parents=True, mode=0o700)
    evidence.mkdir(parents=True)
    log(f"run {run_id}: work {work}, evidence {evidence}, label {label[0]}={label[1]}")

    status = 1
    try:
        source = args.image_source.resolve()
        if args.build_image:
            sha = run(["git", "-C", source, "rev-parse", "HEAD"], capture=True).stdout.strip()
            dirty = run(["git", "-C", source, "status", "--porcelain", "--", "deploy/managed-runner/image", "src/runner-go"], capture=True).stdout.strip()
            if dirty:
                raise SystemExit(f"{source} has uncommitted image or runner changes; build from a commit")
            run(["docker", "build", "--file", source / "deploy/managed-runner/image/Dockerfile",
                 "--build-arg", f"ORBIT_SOURCE_SHA={sha}", "--label", "orbit.test=d2-managed-runner",
                 "--tag", args.image, source])
            (evidence / "image-source.txt").write_text(f"built from {source} at {sha}\n")
        image = docker("image", "inspect", "-f", "{{.Id}}", args.image).stdout.strip()
        revision = docker("image", "inspect", "-f", '{{index .Config.Labels "org.opencontainers.image.revision"}}', args.image).stdout.strip()
        log(f"managed runner image {args.image} = {image}, source revision {revision}")
        (evidence / "image.txt").write_text(f"{args.image} {image} org.opencontainers.image.revision={revision}\n")

        # The test tree, compiled from this checkout (as scripts/run-pg-spec.sh does it).
        run(["bash", REPO / "scripts/worktree-overlay.sh"])
        shutil.rmtree(API / "build", ignore_errors=True)
        tsc = API / "node_modules/.bin/tsc"
        tsc = tsc if tsc.exists() else REPO / "node_modules/.bin/tsc"
        run([tsc, "-p", "tsconfig.test.json"], cwd=API)
        (API / "build/node_modules/@orbit").mkdir(parents=True, exist_ok=True)
        link = API / "build/node_modules/@orbit/shared"
        if not link.exists():
            link.symlink_to(REPO / "src/shared")

        # A disposable PostgreSQL on tmpfs, migrated from empty.
        docker("run", "-d", "--name", pg, "--label", f"{label[0]}={label[1]}", "-e", "POSTGRES_USER=pccspec_",
               "-e", "POSTGRES_PASSWORD=pccspec_pw", "-e", "POSTGRES_DB=postgres", "-e", "PGDATA=/pgdata",
               "--tmpfs", "/pgdata:size=2g", "-p", "127.0.0.1::5432", PG_IMAGE)
        port = docker("port", pg, "5432/tcp").stdout.strip().splitlines()[0].rsplit(":", 1)[1]
        psql = ["exec", "-e", "PGPASSWORD=pccspec_pw", pg, "psql", "-h", "127.0.0.1", "-U", "pccspec_", "-tAc"]
        for _ in range(120):
            if docker(*psql, "SELECT 1", "postgres", check=False).returncode == 0:
                break
            time.sleep(1)
        docker(*psql, "CREATE DATABASE pccspec_d2it", "postgres")
        system_id = docker(*psql, "SELECT system_identifier FROM pg_control_system()", "postgres").stdout.strip()
        url = f"postgresql://pccspec_:pccspec_pw@127.0.0.1:{port}/pccspec_d2it"
        prisma = API / "node_modules/.bin/prisma"
        prisma = prisma if prisma.exists() else REPO / "node_modules/.bin/prisma"
        run([prisma, "migrate", "deploy"], cwd=API, env={**os.environ, "DATABASE_URL": url}, capture=True)
        log(f"PostgreSQL {pg} on 127.0.0.1:{port}, migrated")

        # The containers' network: internal, inter-container traffic off; its gateway is the apiserver's address.
        docker("network", "create", "--internal", "--label", f"{label[0]}={label[1]}",
               "-o", "com.docker.network.bridge.enable_icc=false", network)
        gateway = docker("network", "inspect", "-f", "{{range .IPAM.Config}}{{.Gateway}}{{end}}", network).stdout.strip()
        log(f"network {network}, gateway {gateway}")

        # The channel's configuration, token and state.
        token_file = work / "channel-token"
        token_file.write_text(secrets.token_urlsafe(48))
        token_file.chmod(0o600)
        socket = work / "channel.sock"
        channel_config = work / "channel.json"
        channel_config.write_text(json.dumps({
            "schemaVersion": 1,
            "instanceId": instance,
            "listen": {"unixSocket": str(socket)},
            "tokenFile": str(token_file),
            "dockerSocket": "/var/run/docker.sock",
            "stateDir": str(work / "channel-state"),
            "image": image,
            "network": network,
            "limits": {"maxCpuMillis": 2000, "maxMemoryBytes": 2 * 2 ** 30, "maxPids": 2048, "maxTmpBytes": 2 ** 30,
                       "maxVolumeBytes": 10 * 2 ** 30, "maxConcurrent": 4},
            "stopGraceSeconds": 60,
            "diskCheckSeconds": 30,
            "extraLabels": {label[0]: label[1]},
        }, indent=2))
        run([sys.executable, "-I", CHANNEL, "check-config", "--config", channel_config], capture=True)

        it_config = work / "it.json"
        it_config.write_text(json.dumps({
            "runId": run_id, "runDir": str(work), "evidenceDir": str(evidence), "python": sys.executable,
            "channel": {"script": str(CHANNEL), "config": str(channel_config), "socket": str(socket), "tokenFile": str(token_file)},
            "instanceId": instance, "image": image, "network": network, "gateway": gateway,
            "testLabel": {"key": label[0], "value": label[1]},
        }, indent=2))

        log("running build/managed-runners/docker-backend.it.js")
        env = {
            **os.environ,
            "ORBIT_D2_IT": str(it_config),
            "COORDINATOR_PG_URL": url,
            "COORDINATOR_PG_EXPECTED_DATABASE": "pccspec_d2it",
            "COORDINATOR_PG_EXPECTED_USER": "pccspec_",
            "COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER": system_id,
        }
        env.pop("DOCKER_HOST", None)
        with open(evidence / "it.tap", "w") as tap:
            child = subprocess.Popen(["node", "--test", "--test-reporter=tap", "--test-concurrency=1",
                                      "build/managed-runners/docker-backend.it.js"],
                                     cwd=API, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            for line in child.stdout:
                sys.stdout.write(line)
                tap.write(line)
            status = child.wait()
        log(f"integration test exited {status}")
    finally:
        inventory = []
        for what in (["ps", "-a", "--filter", label_filter, "--format", "{{.Names}}\t{{.Status}}\t{{.Labels}}"],
                     ["volume", "ls", "--filter", label_filter, "--format", "{{.Name}}\t{{.Labels}}"],
                     ["network", "ls", "--filter", label_filter, "--format", "{{.Name}}"]):
            inventory.append("$ docker " + " ".join(what) + "\n" + docker(*what, check=False).stdout)
        (evidence / "docker-inventory-before-cleanup.txt").write_text("\n".join(inventory))
        if not args.keep:
            containers = docker("ps", "-aq", "--filter", label_filter, check=False).stdout.split()
            if containers:
                docker("rm", "-f", "-v", *containers, check=False)
            volumes = docker("volume", "ls", "-q", "--filter", label_filter, check=False).stdout.split()
            if volumes:
                docker("volume", "rm", *volumes, check=False)
            docker("network", "rm", network, check=False)
            left = [docker("ps", "-aq", "--filter", label_filter, check=False).stdout.strip(),
                    docker("volume", "ls", "-q", "--filter", label_filter, check=False).stdout.strip(),
                    docker("network", "ls", "-q", "--filter", label_filter, check=False).stdout.strip()]
            (evidence / "cleanup.txt").write_text(
                f"removed {len(containers)} container(s) and {len(volumes)} volume(s) labelled {label[0]}={label[1]}, "
                f"and network {network}\nleft after cleanup: {json.dumps(left)}\n")
            log(f"cleaned up: {len(containers)} container(s), {len(volumes)} volume(s); left {left}")
    return status


if __name__ == "__main__":
    sys.exit(main())
