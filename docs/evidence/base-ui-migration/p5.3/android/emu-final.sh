#!/usr/bin/env bash
# emu-final.sh: the emulator pass on the formal trees — v1/ref (4384) and v1/del (4383) served with vite preview on the
# host's loopback (each server in its own process group, stopped by group), `adb start-server` outside the lock, then
# emu-pair.sh under /var/lib/orbit/android/ui.lock (flock waits if another session holds it). Output: run/{ref,del}.
set -u
V=/mnt/data/tmp/34Za39Ov1yysHZaYL6wgJ/v1
A=/mnt/data/tmp/34Za39Ov1yysHZaYL6wgJ/android
export PATH=/opt/android-sdk/platform-tools:$PATH
(cd $V/del/src/web && exec setsid npx vite preview --host 127.0.0.1 --port 4383 --strictPort > $A/preview-del.log 2>&1) & del=$!
(cd $V/ref/src/web && exec setsid npx vite preview --host 127.0.0.1 --port 4384 --strictPort > $A/preview-ref.log 2>&1) & ref=$!
for i in $(seq 1 60); do curl -s -o /dev/null http://127.0.0.1:4383/ && curl -s -o /dev/null http://127.0.0.1:4384/ && break; sleep 0.5; done
echo "delivery $(git -C $V/del rev-parse --short=9 HEAD), reference $(git -C $V/ref rev-parse --short=9 HEAD)"
adb start-server
adb -s emulator-5554 shell getprop ro.build.version.sdk
echo "lock wait $(date -u +%T)"
flock -x /var/lib/orbit/android/ui.lock sh -c 'echo "lock held $(date -u +%T)"; exec '"$A"'/emu-pair.sh'
echo "lock released $(date -u +%T)"
kill -- -$del -$ref 2>/dev/null
