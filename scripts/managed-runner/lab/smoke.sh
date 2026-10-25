#!/usr/bin/env bash
# Storage smoke test of the lab, with the repository's probe payload (ceph-rbd-payload.py):
#   smoke.sh run              PVC from the runner-data StorageClass; a Pod writes an ordinary file,
#                             a Git repository and SQLite (WAL) rows; the Pod is deleted and
#                             recreated and the data compared; a second Pod mounts the same PVC on
#                             the same node; a ReadWriteOncePod claim is tried for comparison.
#   smoke.sh verify RUN_ID    after a VM stop and start: the same data, compared again.
# Results (no credentials) go to $LAB_DIR/state/smoke-RUN_ID.json; exit 1 on any mismatch.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

mode=${1:-}
case "$mode" in
  run) run_id=lab-$(date -u +%Y%m%d%H%M%S) ;;
  verify) run_id=${2:?usage: smoke.sh verify RUN_ID} ;;
  *) die "usage: smoke.sh run | smoke.sh verify RUN_ID" ;;
esac
vm_running || die "the VM is not running: start.sh first"
report=$LAB_DIR/state/smoke-$run_id.json
k() { lab_kubectl -n "$LAB_NAMESPACE" "$@"; }
payload() {  # payload <pod> <operation> [args]: run the probe payload inside a Pod
  local pod=$1
  shift
  k exec "$pod" -- python3 /probe/ceph-rbd-payload.py "$@" --run-id "$run_id"
}
random_sha() {
  k exec "$1" -- sha256sum "/var/lib/orbit/storage-verification/$run_id/random.bin" | cut -d' ' -f1
}
wait_ready() { k wait --for=condition=Ready "pod/$1" --timeout="${2:-600}s" >/dev/null; }
record() {  # record <jq filter> [jq args]: update the report
  local filter=$1
  shift
  jq "$@" "$filter" "$report" > "$report.part" && mv "$report.part" "$report"
}
same() {  # same <label> <a> <b>
  if [ "$2" = "$3" ]; then say "same: $1"; else say "DIFFERENT: $1 ($2 vs $3)"; failures=$((failures + 1)); fi
}
failures=0
snapshot_keys='{ordinarySHA256, gitCommit, gitFsck, sqliteIntegrity, sqliteJournalMode, committedRows, rowSHA256, mountInfo}'

if [ "$mode" = run ]; then
  owner=$(cat /proc/sys/kernel/random/uuid)
  runner=$(cat /proc/sys/kernel/random/uuid)
  pvc=mr-data-$runner
  pod=$run_id-a
  echo '{}' > "$report"
  record '.runId = $r | .pvc = $p | .startedAt = $t' --arg r "$run_id" --arg p "$pvc" --arg t "$(date -u +%FT%TZ)"

  k create configmap ceph-rbd-payload --from-file="ceph-rbd-payload.py=$LAB_SCRIPTS/../ceph-rbd-payload.py" \
    --dry-run=client -o json | k apply -f - >/dev/null
  fsid=$(jq -r .fsid "$LAB_DIR/state/facts.json")
  python3 -B "$LAB_SCRIPTS/render.py" pvc --fsid "$fsid" --name "$pvc" --owner "$owner" --runner "$runner" | k apply -f -
  k wait --for=jsonpath='{.status.phase}'=Bound "pvc/$pvc" --timeout=300s >/dev/null
  pv=$(k get pvc "$pvc" -o jsonpath='{.spec.volumeName}')
  record '.volume = $v' --argjson v "$(lab_kubectl get pv "$pv" -o json | jq '{pv: .metadata.name, pvUID: .metadata.uid,
    accessModes: .spec.accessModes, volumeMode: .spec.volumeMode, reclaimPolicy: .spec.persistentVolumeReclaimPolicy,
    driver: .spec.csi.driver, volumeHandle: .spec.csi.volumeHandle, fsType: .spec.csi.fsType,
    pool: .spec.csi.volumeAttributes.pool, image: .spec.csi.volumeAttributes.imageName,
    clusterID: .spec.csi.volumeAttributes.clusterID, mounter: .spec.csi.volumeAttributes.mounter}')"
  say "PVC $pvc bound to $pv ($(jq -r .volume.image "$report"))"

  # 1. Writer Pod: ordinary file, Git, SQLite rows in WAL mode with synchronous=FULL; plus 32 MiB of random data.
  python3 -B "$LAB_SCRIPTS/render.py" probe-pod --name "$pod" --pvc "$pvc" --run-id "$run_id" | k apply -f -
  wait_ready "$pod"
  deadline=$(( SECONDS + 300 ))
  until [ "$(k exec "$pod" -- cat "/var/lib/orbit/storage-verification/$run_id/acknowledged.json" 2>/dev/null \
            | jq -r '.committedRows // 0')" -ge 100 ] 2>/dev/null; do
    [ "$SECONDS" -lt "$deadline" ] || die "the writer did not commit 100 rows in 300 s"
    sleep 2
  done
  k exec "$pod" -- python3 -c "import os, sys
path = '/var/lib/orbit/storage-verification/$run_id/random.bin'
with open(path, 'wb') as stream:
    stream.write(os.urandom(32 * 1024 * 1024))
    stream.flush()
    os.fsync(stream.fileno())"
  before_random=$(random_sha "$pod")
  before=$(payload "$pod" quiesce)
  record '.beforeDelete = ($s | '"$snapshot_keys"') + {randomSHA256: $r, pod: $p}' \
    --argjson s "$before" --arg r "$before_random" --arg p "$pod"
  say "writer quiesced after $(jq .committedRows <<<"$before") committed rows; integrity $(jq -c .sqliteIntegrity <<<"$before")"

  # 2. Delete the Pod, wait until the node has released the volume, start a new Pod on the same PVC.
  # Other claims may be mapped in the VM; only this one's image must go.
  k delete pod "$pod" --wait=true >/dev/null
  deadline=$(( SECONDS + 300 ))
  while lab_ssh "grep -qx '$(jq -r .volume.image "$report")' /sys/bus/rbd/devices/*/name 2>/dev/null"; do
    [ "$SECONDS" -lt "$deadline" ] || die "the RBD device stayed mapped after the Pod was deleted"
    sleep 2
  done
  record '.unmappedAfterDelete = true'
  pod=$run_id-b
  python3 -B "$LAB_SCRIPTS/render.py" probe-pod --name "$pod" --pvc "$pvc" --run-id "$run_id" --sleep | k apply -f -
  wait_ready "$pod"
  after=$(payload "$pod" snapshot --minimum-rows "$(jq .committedRows <<<"$before")")
  after_random=$(random_sha "$pod")
  record '.afterRecreate = ($s | '"$snapshot_keys"') + {randomSHA256: $r, pod: $p}' \
    --argjson s "$after" --arg r "$after_random" --arg p "$pod"
  for key in ordinarySHA256 gitCommit rowSHA256 committedRows; do
    same "recreate: $key" "$(jq -r ".$key" <<<"$before")" "$(jq -r ".$key" <<<"$after")"
  done
  same "recreate: random.bin sha256" "$before_random" "$after_random"
  same "recreate: SQLite integrity_check" '["ok"]' "$(jq -c .sqliteIntegrity <<<"$after")"

  # 3. A second, differently named, unlabelled Pod on the same node and the same RWO PVC.
  dup=$run_id-dup
  python3 -B "$LAB_SCRIPTS/render.py" probe-pod --name "$dup" --pvc "$pvc" --run-id "$run_id" --sleep | k apply -f -
  if wait_ready "$dup" 120 2>/dev/null; then
    dup_write=$(k exec "$dup" -- sh -c "echo second-pod > /var/lib/orbit/storage-verification/$run_id/second-pod.txt && echo written")
    seen_by_first=$(k exec "$pod" -- cat "/var/lib/orbit/storage-verification/$run_id/second-pod.txt")
    k exec "$dup" -- rm -f "/var/lib/orbit/storage-verification/$run_id/second-pod.txt"
    record '.secondPodSameNode = {admitted: true, phase: "Running", write: $w, seenByFirstPod: $s,
             mountInfo: $m}' --arg w "$dup_write" --arg s "$seen_by_first" \
      --arg m "$(k exec "$dup" -- grep ' /var/lib/orbit ' /proc/self/mountinfo)"
    say "second Pod on the same node: Running, could write a file the first Pod sees"
  else
    record '.secondPodSameNode = {admitted: false, phase: $p, events: $e}' \
      --arg p "$(k get pod "$dup" -o jsonpath='{.status.phase}')" \
      --arg e "$(k get events --field-selector "involvedObject.name=$dup" -o json | jq -r '[.items[].message] | join(" | ")')"
    say "second Pod on the same node: not running ($(jq -r .secondPodSameNode.phase "$report"))"
  fi
  record '.secondPodSameNode.volumeAttachments = $n' \
    --argjson n "$(lab_kubectl get volumeattachments -o json | jq --arg pv "$(jq -r .volume.pv "$report")" '[.items[] | select(.spec.source.persistentVolumeName == $pv)] | length')"
  k delete pod "$dup" --wait=true >/dev/null

  # 4. For comparison only: ReadWriteOncePod (Alpha for RBD in Ceph-CSI v3.18.0; not the baseline).
  rwop=mr-data-$(cat /proc/sys/kernel/random/uuid)
  python3 -B "$LAB_SCRIPTS/render.py" pvc --fsid "$fsid" --name "$rwop" --owner "$owner" --runner rwop-probe \
    --access-mode ReadWriteOncePod | k apply -f - >/dev/null
  k wait --for=jsonpath='{.status.phase}'=Bound "pvc/$rwop" --timeout=300s >/dev/null
  python3 -B "$LAB_SCRIPTS/render.py" probe-pod --name "$run_id-rwop-1" --pvc "$rwop" --run-id "$run_id" --sleep | k apply -f - >/dev/null
  wait_ready "$run_id-rwop-1"
  python3 -B "$LAB_SCRIPTS/render.py" probe-pod --name "$run_id-rwop-2" --pvc "$rwop" --run-id "$run_id" --sleep | k apply -f - >/dev/null
  sleep 20
  record '.readWriteOncePodSecondPod = {phase: $p, events: $e, pvc: $c}' \
    --arg p "$(k get pod "$run_id-rwop-2" -o jsonpath='{.status.phase}')" --arg c "$rwop" \
    --arg e "$(k get events --field-selector "involvedObject.name=$run_id-rwop-2" -o json | jq -r '[.items[].message] | unique | join(" | ")')"
  say "ReadWriteOncePod second Pod: $(jq -r '.readWriteOncePodSecondPod | .phase + ": " + .events' "$report")"
  k delete pod "$run_id-rwop-1" "$run_id-rwop-2" --wait=true >/dev/null
  record '.finishedAt = $t | .failures = $f' --arg t "$(date -u +%FT%TZ)" --argjson f "$failures"
  say "Pod $pod keeps the PVC mounted. After stop.sh and start.sh, run: smoke.sh verify $run_id"
else
  [ -f "$report" ] || die "no report $report"
  pod=$(jq -r .afterRecreate.pod "$report")
  wait_ready "$pod" 900
  rows=$(jq .afterRecreate.committedRows "$report")
  after=$(payload "$pod" snapshot --minimum-rows "$rows")
  after_random=$(random_sha "$pod")
  record '.afterReboot = ($s | '"$snapshot_keys"') + {randomSHA256: $r, verifiedAt: $t, bootId: $b}' \
    --argjson s "$after" --arg r "$after_random" --arg t "$(date -u +%FT%TZ)" \
    --arg b "$(lab_ssh cat /proc/sys/kernel/random/boot_id)"
  for key in ordinarySHA256 gitCommit rowSHA256 committedRows; do
    same "after reboot: $key" "$(jq -r ".afterRecreate.$key" "$report")" "$(jq -r ".$key" <<<"$after")"
  done
  same "after reboot: random.bin sha256" "$(jq -r .afterRecreate.randomSHA256 "$report")" "$after_random"
  same "after reboot: SQLite integrity_check" '["ok"]' "$(jq -c .sqliteIntegrity <<<"$after")"
  record '.afterReboot.failures = $f' --argjson f "$failures"
fi
say "report: $report"
[ "$failures" -eq 0 ]
