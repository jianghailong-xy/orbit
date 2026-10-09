#!/usr/bin/env python3
"""Probe data only. Run inside the one admitted test Pod, never on the host."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import signal
import sqlite3
import subprocess
import time


def durable_write(path, value):
    temporary = path.with_suffix(".tmp")
    with temporary.open("w") as stream:
        stream.write(value)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root / "repository"), *args], text=True).strip()


def initialize(root):
    root.mkdir(parents=True, exist_ok=True)
    if not (root / "ordinary.txt").exists():
        durable_write(root / "ordinary.txt", "Ceph RBD ordinary-file verification\n" + root.name + "\n")
        (root / "repository").mkdir()
        git(root, "init", "--quiet")
        git(root, "config", "user.name", "storage-verification")
        git(root, "config", "user.email", "storage-verification@example.invalid")
        git(root, "config", "core.fsync", "all")
        durable_write(root / "repository" / "tracked.txt", "Persistent Git content\n" + root.name + "\n")
        git(root, "add", "tracked.txt")
        git(root, "commit", "--quiet", "-m", "Initialize storage probe")
    database = sqlite3.connect(root / "state.sqlite")
    if database.execute("PRAGMA journal_mode=WAL").fetchone()[0].lower() != "wal":
        raise RuntimeError("SQLite did not enable WAL")
    database.execute("PRAGMA synchronous=FULL")
    database.execute("CREATE TABLE IF NOT EXISTS probe (sequence INTEGER PRIMARY KEY, payload TEXT NOT NULL)")
    database.commit()
    return database


def row_hash(database, rows):
    digest = hashlib.sha256()
    count = 0
    for sequence, payload in database.execute("SELECT sequence, payload FROM probe WHERE sequence <= ? ORDER BY sequence", (rows,)):
        digest.update(json.dumps([sequence, payload], separators=(",", ":")).encode() + b"\n")
        count += 1
    if count != rows:
        raise RuntimeError("Missing committed SQLite row")
    return digest.hexdigest()


def snapshot(root, minimum_rows=0, recover=False):
    path = root / "state.sqlite"
    if not path.is_file():
        raise RuntimeError("Original SQLite database is missing")
    acknowledged = json.loads((root / "acknowledged.json").read_text())["committedRows"]
    database = sqlite3.connect(str(path) if recover else "file:" + str(path) + "?mode=ro", uri=not recover)
    try:
        database.execute("BEGIN")
        count, maximum = database.execute("SELECT count(*), coalesce(max(sequence), 0) FROM probe").fetchone()
        integrity = [row[0] for row in database.execute("PRAGMA integrity_check")]
        if integrity != ["ok"] or count != maximum or count < max(minimum_rows, acknowledged):
            raise RuntimeError("SQLite integrity or committed-row preservation check failed")
        mounts = []
        for line in Path("/proc/self/mountinfo").read_text().splitlines():
            fields = line.split()
            if fields[4] == "/var/lib/orbit":
                mounts.append(line)
        result = {
            "runID": root.name,
            "ordinarySHA256": hashlib.sha256((root / "ordinary.txt").read_bytes()).hexdigest(),
            "gitCommit": git(root, "rev-parse", "HEAD"),
            "gitFsck": git(root, "fsck", "--full"),
            "gitStatus": git(root, "status", "--porcelain"),
            "sqliteIntegrity": integrity,
            "sqliteJournalMode": database.execute("PRAGMA journal_mode").fetchone()[0],
            "committedRows": count,
            "acknowledgedRows": acknowledged,
            "acknowledgedSHA256": row_hash(database, acknowledged),
            "rowSHA256": row_hash(database, count),
            "prefixRows": minimum_rows,
            "prefixSHA256": row_hash(database, minimum_rows),
            "walExists": (root / "state.sqlite-wal").exists(),
            "walBytes": (root / "state.sqlite-wal").stat().st_size if (root / "state.sqlite-wal").exists() else 0,
            "kernel": platform.release(),
            "mountInfo": mounts,
            "quiesced": (root / "quiesced.json").exists(),
        }
        return result
    finally:
        database.close()


def writer(root, require_existing=False, initially_quiesced=False):
    if require_existing and not all((root / name).exists() for name in ("ordinary.txt", "repository/.git", "state.sqlite", "acknowledged.json")):
        raise RuntimeError("Successor may not initialize missing original data")
    if initially_quiesced:
        durable_write(root / "stop-writing", "successor awaiting integrity verification\n")
    stopping = False

    def stop(_number, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    database = None
    try:
        while not stopping:
            if (root / "stop-writing").exists():
                if database is not None:
                    database.close()
                    database = None
                if not (root / "quiesced.json").exists():
                    durable_write(root / "quiesced.json", json.dumps({"time": time.time(), "writerStopped": True}))
                time.sleep(0.1)
                continue
            if database is None:
                database = initialize(root)
            sequence = database.execute("SELECT coalesce(max(sequence), 0) + 1 FROM probe").fetchone()[0]
            database.execute("INSERT INTO probe VALUES (?, ?)", (sequence, "committed-probe-row-" + str(sequence)))
            database.commit()
            durable_write(root / "acknowledged.json", json.dumps({"committedRows": sequence}))
            if sequence % 10 == 0:
                print(json.dumps({"committedRows": sequence}), flush=True)
            time.sleep(0.1)
    finally:
        if database is not None:
            database.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["writer", "snapshot", "quiesce", "resume-writer"])
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--minimum-rows", type=int, default=0)
    parser.add_argument("--recover", action="store_true")
    parser.add_argument("--require-existing", action="store_true")
    parser.add_argument("--initially-quiesced", action="store_true")
    parser.add_argument("--expected-pod-name")
    parser.add_argument("--expected-pod-uid")
    args = parser.parse_args()
    if args.expected_pod_uid and os.environ.get("POD_UID") != args.expected_pod_uid:
        raise RuntimeError("Exec target Pod UID differs from recorded generation")
    if not args.run_id or any(character not in "abcdefghijklmnopqrstuvwxyz0123456789-" for character in args.run_id):
        parser.error("run-id must contain only lowercase letters, numbers and hyphens")
    root = Path("/var/lib/orbit/storage-verification") / args.run_id
    if args.operation == "writer":
        if args.expected_pod_name and os.environ.get("POD_NAME") != args.expected_pod_name:
            # A duplicate that unexpectedly passes admission must remain inert.
            # The original and contenders use the same approved command/env.
            while True:
                time.sleep(60)
        writer(root, args.require_existing, args.initially_quiesced)
    elif args.operation == "quiesce":
        durable_write(root / "stop-writing", "operator-requested quiesce\n")
        deadline = time.monotonic() + 30
        while not (root / "quiesced.json").exists():
            if time.monotonic() > deadline:
                raise RuntimeError("Writer did not acknowledge quiesce")
            time.sleep(0.1)
        print(json.dumps(snapshot(root, args.minimum_rows)))
    elif args.operation == "resume-writer":
        (root / "quiesced.json").unlink(missing_ok=True)
        (root / "stop-writing").unlink(missing_ok=True)
        print(json.dumps({"resumeRequested": True}))
    else:
        print(json.dumps(snapshot(root, args.minimum_rows, args.recover)))


if __name__ == "__main__":
    main()
