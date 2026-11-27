# orbit-drive-mount

The Drive mount daemon (docs/drive-technical-design.md §5): the account's drive as a FUSE file
system, at `/run/orbit-drive/drive` on an Orbit Cloud runner, which the runner shows its agents as `~/Drive`
(`/home/orbit/Drive`, a symlink `orbit run` makes). Go on go-fuse's raw protocol, speaking the runner drive door
(`/api/runner/drive/*`, `src/apiserver/src/drive/runner-drive.controller.ts`).

| Package | What it is |
|---|---|
| `door` | The door client: the mount credential and the managed-runner instance on every request, deadlines (9 s metadata, 60 s a chunk), offline after three failures in 10 s, or at once when a request passes its deadline with nothing answered while it waited (not even the probe it sends halfway there: a slow answer is not no answer, and a slow read is sent once more), fencing on a superseded or revoked instance. |
| `drivefs` | The file system: inode table, listings and lookups with the change feed's invalidations (`feed.go`), entry-bound write states with commit-on-close, `CONTINUE`/`OVERWRITE`/`APPEND` and the 64 KiB tail merge (`wfile.go`), the evict-and-refetch spool (`spool.go`), the chunk cache (`cache.go`), refusals and `errors.log`/`status.json`/`unsent/` (`report.go`), attribution (`attrib.go`). |
| `parent` | The privileged parent of one runner's daemon: opens `/dev/fuse`, mounts `fuse.orbit-drive` `nosuid,nodev,noexec,default_permissions,allow_other`, starts the daemon as uid 65532 with the descriptor (`/dev/fd/3`), the credential through a pipe and a socket for attribution; replaces a daemon that dies, and aborts and replaces one that freezes (the watchdog: a forced `statx` of the mount's root every 10 s, answered from memory, 5 s deadline). The CSI plugin (`drive.orbit.dev`) runs this per runner. |
| `csi` | `drive.orbit.dev`, the CSI node plugin (`orbit-drive-mount csi`): checks each publish (managed namespace, `{ runnerId }` only, the door's verdict on the Pod), runs one `parent` per runner as a uid of its own, binds the plain per-runner directory onto the kubelet's target, and adopts every published drive again after a restart. Manifests: `deploy/managed-runner/drive-csi/`. |
| `sandbox` | What the daemon applies to itself once mounted: `no_new_privs`, undumpable, and a seccomp filter refusing mounts, namespaces, tracing, modules, keys and BPF. |

## Running it

As root, the way the CSI plugin does for one runner:

```
orbit-drive-mount mount --root /var/lib/orbit-drive/<runner> --spool /var/lib/orbit-drive-spool/<runner> \
  --server https://<orbit> --token-file <mount credential> --generation <n> --pod-uid <runner Pod UID>
```

`--root` is the plain directory the runner Pod receives as `/run/orbit-drive`; the drive is mounted at `<root>/drive`,
and `errors.log`, `status.json` and `unsent/` are beside it. Before each daemon starts, the parent moves whatever a dead daemon left in the spool into `unsent/` (a
daemon that stops cleanly leaves nothing there). Every other flag is the daemon's (`orbit-drive-mount serve
--help`): `--spool-limit` (4 GiB), `--cache-limit` (1 GiB), `--unsent-limit` (1 GiB), `--idle-commit` (30 s),
`--max-commit-interval` (5 min), `--close-wait` (30 s), `--feed-wait` (15 s).

The daemon exits 3 when the door fences its instance (superseded generation, fenced mapping, revoked credential); the
parent does not mount again then. On a node serving several accounts, give each runner's daemon its own uid
(`--daemon-uid`): the daemons are undumpable, but one uid shared by all can read every spool on the node.

## Tests

```
cd src/drive-mount && go vet ./... && go test -timeout 60m ./...
```

The `drivefs` tests mount for real over an in-memory door; they need root and `/dev/fuse`, and skip without them.

The design's shell-operation list (§5.9) runs as uid 10001 through real mounts against the production apiserver and a
real PostgreSQL:

```
sudo RUN_PG_SPEC_TIMEOUT=7200 bash scripts/run-pg-spec.sh src/apiserver/src/drive/drive-mount.pg.e2e.ts
```

`DRIVE_MOUNT_E2E_SCALE=full` runs the sizes the list names (5 GiB, 5 × 900 MiB, 100,000-file folders) and holds its
timing budgets; `DRIVE_MOUNT_E2E_ROWS=1,2,3` runs some rows; `DRIVE_MOUNT_E2E_REPORT=<file>` writes the row-by-row
table. It is not in CI's pg roster, which takes `*.pg.spec` only.
