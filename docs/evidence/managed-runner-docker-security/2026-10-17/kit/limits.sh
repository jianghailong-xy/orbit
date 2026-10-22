#!/bin/sh
# D5 (task 34hJ7S9C3isVnzIDDfSHD): measure one of a managed runner container's limits from inside it, as its runner
# user: cpu, pids, tmp, memory or disk.
#   docker exec -i mr-<runner uuid> sh -s cpu < limits.sh
MODE="$1"
CG=/sys/fs/cgroup
echo "limit: $MODE, in $(hostname) as $(id -u):$(id -g) at $(date -u +%FT%TZ)"
case "$MODE" in
cpu)
  echo "cpu.max: $(cat $CG/cpu.max)"
  python3 - <<'PY'
import multiprocessing, time
def usage():
    return dict(line.split() for line in open("/sys/fs/cgroup/cpu.stat"))
def spin(stop):
    while time.time() < stop:
        pass
before, t0 = usage(), time.time()
stop = t0 + 10
workers = [multiprocessing.Process(target=spin, args=(stop,)) for _ in range(4)]
for w in workers: w.start()
for w in workers: w.join()
after, t1 = usage(), time.time()
used = (int(after["usage_usec"]) - int(before["usage_usec"])) / 1e6
print(f"4 busy processes for {t1 - t0:.1f} s used {used:.2f} CPU-seconds: {used / (t1 - t0):.2f} CPUs")
print(f"throttled periods: {int(after['nr_throttled']) - int(before['nr_throttled'])} of {int(after['nr_periods']) - int(before['nr_periods'])}")
PY
  ;;
pids)
  echo "pids.max: $(cat $CG/pids.max), pids.current before: $(cat $CG/pids.current)"
  python3 - <<'PY'
import threading, time
started = []
try:
    while True:
        t = threading.Thread(target=time.sleep, args=(20,), daemon=True)
        t.start()
        started.append(t)
except RuntimeError as error:
    print(f"one process started {len(started)} more threads, then: {error}")
print(f"pids.current at the refusal: {open('/sys/fs/cgroup/pids.current').read().strip()}")
print(f"pids.events: {open('/sys/fs/cgroup/pids.events').read().strip()}")
PY
  ;;
tmp)
  echo "/tmp: $(df -B1 /tmp | tail -1)"
  dd if=/dev/zero of=/tmp/d5-fill bs=1M 2>&1 | tail -n 2
  echo "written: $(stat -c %s /tmp/d5-fill) bytes; memory.current with it: $(cat $CG/memory.current)"
  rm -f /tmp/d5-fill
  ;;
memory)
  echo "memory.max: $(cat $CG/memory.max), memory.swap.max: $(cat $CG/memory.swap.max), memory.current: $(cat $CG/memory.current)"
  echo "memory.events before: $(tr '\n' ' ' < $CG/memory.events)"
  python3 - <<'PY'
import os, signal, subprocess, sys
child = subprocess.Popen([sys.executable, "-c", r'''
import os, sys
held = []
while True:
    block = bytearray(16 << 20)
    for i in range(0, len(block), 4096):
        block[i] = 1
    held.append(block)
    os.write(1, f"{len(held) * 16}\n".encode())
'''], stdout=subprocess.PIPE)
last = None
for line in child.stdout:
    last = line.decode().strip()
code = child.wait()
how = f"killed by {signal.Signals(-code).name}" if code < 0 else f"exited {code}"
print(f"the allocating process held {last} MiB at its last report, then was {how}")
PY
  echo "memory.events after: $(tr '\n' ' ' < $CG/memory.events)"
  echo "memory.peak: $(cat $CG/memory.peak 2>/dev/null || echo n/a)"
  echo "the runner is still there: $(pgrep -c -f 'orbit run') process(es) of orbit run"
  ;;
disk)
  echo "the data volume: $(df -B1 /var/lib/orbit | tail -1)"
  python3 - <<'PY'
import os, time
path = "/var/lib/orbit/d5-fill"
block = os.urandom(8 << 20)
written = 0
with open(path, "wb") as out:
    while True:
        out.write(block)
        out.flush()
        os.fsync(out.fileno())
        written += len(block)
        print(f"{time.strftime('%H:%M:%S', time.gmtime())}Z {written} bytes", flush=True)
        time.sleep(0.5)
PY
  ;;
esac
